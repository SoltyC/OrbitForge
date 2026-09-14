/**
 * Entry point: launch Pathfinder I from Terrin, fly it to orbit, then warp.
 *
 * The physics runs on a fixed timestep decoupled from the render loop while
 * integrating, and in single analytic jumps while on rails — so the trajectory
 * is identical regardless of framerate or warp factor.
 */
import { LUNARA, TERRIN } from './bodies/system.js';
import { Editor } from './editor/editor.js';
import { craftToVessel } from './parts/assembly.js';
import type { Craft } from './parts/craft.js';
import { createPathfinderCraft } from './parts/testVehicle.js';
import { ChaseCamera } from './render/chaseCamera.js';
import { FloatingOrigin } from './render/floatingOrigin.js';
import { MapCamera } from './render/mapCamera.js';
import {
  createOrbitLineView,
  orbitSignature,
  updateMarkerScale,
  updateOrbitGeometry,
  updateVesselMarker,
} from './render/orbitLine.js';
import { SystemView } from './render/systemView.js';
import { attachResizeHandler, createRenderContext } from './render/renderer.js';
import type { PointsMaterial } from 'three/webgpu';
import { SkyPass } from './render/skyPass.js';
import { createStarfield, starVisibility } from './render/starfield.js';
import { createVesselView, updateVesselView } from './render/vesselView.js';
import { createPrelaunchState } from './sim/flightState.js';
import type { FlightState } from './sim/flightState.js';
import { altitudeOf } from './sim/forces.js';
import type { AscentPhase } from './sim/guidance.js';
import { elementsFromState } from './sim/orbit.js';
import { PHYSICS_TIMESTEP, step } from './sim/simulation.js';
import type { SimulationOptions } from './sim/simulation.js';
import {
  clampIndex,
  permittedWarpIndex,
  requiresRails,
  warpFactorAt,
} from './sim/timeWarp.js';
import { Hud } from './ui/hud.js';

/** Target a circular orbit 80 km up — comfortably clear of the atmosphere. */
const TARGET_ALTITUDE = 80_000;

/** Integrated steps per frame are capped so a stall cannot spiral the loop. */
const MAX_STEPS_PER_FRAME = 16;

type ViewMode = 'flight' | 'map';
type AppMode = 'editor' | 'flight';

async function main(): Promise<void> {
  const canvas = document.querySelector<HTMLCanvasElement>('#viewport');
  const overlay = document.querySelector<HTMLElement>('#overlay');
  if (!canvas || !overlay) {
    throw new Error('Missing #viewport canvas or #overlay container');
  }

  // Bound to non-nullable locals so the hoisted mode switcher below can close
  // over them without losing the narrowing.
  const viewport: HTMLCanvasElement = canvas;

  const context = await createRenderContext(canvas);
  const detachResize = attachResizeHandler(context);

  const options: SimulationOptions = {
    target: { orbitRadius: TERRIN.radius + TARGET_ALTITUDE },
    autopilotEnabled: true,
    transferTo: LUNARA,
  };

  let craft: Craft = createPathfinderCraft();
  let state = createPrelaunchState(TERRIN, craftToVessel(craft));
  let phase: AscentPhase = 'prelaunch';
  let appMode: AppMode = 'editor';
  let requestedWarp = 0;
  let activeWarp = 0;
  let isPaused = false;
  let viewMode: ViewMode = 'flight';
  let lastOrbitSignature = '';

  const origin = new FloatingOrigin(state.position);
  const system = new SystemView();
  let vessel = createVesselView(state.vessel);
  const stars = createStarfield(TERRIN.surface.seed);
  const orbit = createOrbitLineView();

  context.scene.add(system.group, vessel.group, stars, orbit.group);

  const chase = new ChaseCamera(context.camera);
  const map = new MapCamera(context.camera);
  let detachCamera = (): void => {};

  const hud = new Hud(overlay);

  const skyPass = new SkyPass(context.renderer, window.innerWidth, window.innerHeight);
  const starMaterial = stars.material as PointsMaterial;

  /** Rebuild flight state from a craft and swap in its mesh. */
  const loadCraft = (next: Craft): void => {
    craft = next;
    state = createPrelaunchState(TERRIN, craftToVessel(craft));
    phase = 'prelaunch';
    requestedWarp = 0;
    activeWarp = 0;
    lastOrbitSignature = '';

    context.scene.remove(vessel.group);
    vessel = createVesselView(state.vessel);
    vessel.group.visible = viewMode === 'flight';
    context.scene.add(vessel.group);
  };

  const editor = new Editor(overlay, TERRIN, {
    onLaunch: (built) => {
      loadCraft(built);
      setAppMode('flight');
    },
  });
  let detachEditor = editor.attach(canvas);
  editor.setVisible(true);
  hud.setVisible(false);

  function setAppMode(mode: AppMode): void {
    if (mode === appMode) return;
    appMode = mode;

    hud.setVisible(mode === 'flight');
    editor.setVisible(mode === 'editor');

    // Only one mode may own the pointer at a time.
    if (mode === 'editor') {
      detachCamera();
      detachEditor = editor.attach(viewport);
    } else {
      detachEditor();
      detachCamera = viewMode === 'flight' ? chase.attach(viewport) : map.attach(viewport);
    }
  }

  const setViewMode = (mode: ViewMode): void => {
    if (mode === viewMode) return;
    viewMode = mode;
    detachCamera();
    detachCamera = mode === 'flight' ? chase.attach(canvas) : map.attach(canvas);
    // The vessel mesh is sub-metre against a 600 km planet; in map view the
    // marker stands in for it.
    vessel.group.visible = mode === 'flight';
    system.setOrbitLinesVisible(mode === 'map');
  };

  const detachKeys = attachKeyboard({
    onTogglePause: () => {
      isPaused = !isPaused;
    },
    onWarpDown: () => {
      requestedWarp = clampIndex(requestedWarp - 1);
    },
    onWarpUp: () => {
      requestedWarp = clampIndex(requestedWarp + 1);
    },
    onToggleMap: () => {
      setViewMode(viewMode === 'flight' ? 'map' : 'flight');
    },
    onReset: () => {
      loadCraft(craft);
    },
    onToggleEditor: () => {
      setAppMode(appMode === 'editor' ? 'flight' : 'editor');
    },
  });

  let lastFrameTime = performance.now();
  let accumulator = 0;

  const advanceSimulation = (elapsed: number): void => {
    activeWarp = permittedWarpIndex(state, requestedWarp);
    const factor = warpFactorAt(activeWarp);

    // On rails a whole frame's worth of warped time is one analytic solve.
    if (requiresRails(activeWarp) && state.regime === 'onRails') {
      const result = step(state, options, elapsed * factor);
      state = result.state;
      phase = result.command.phase;
      accumulator = 0;
      return;
    }

    accumulator += elapsed * factor;

    let steps = 0;
    while (accumulator >= PHYSICS_TIMESTEP && steps < MAX_STEPS_PER_FRAME) {
      const result = step(state, options, PHYSICS_TIMESTEP);
      state = result.state;
      phase = result.command.phase;
      accumulator -= result.advanced;
      steps += 1;
    }

    // Drop any backlog we could not work through, rather than accruing debt.
    if (accumulator > PHYSICS_TIMESTEP * MAX_STEPS_PER_FRAME) accumulator = 0;
  };

  const renderFrame = (current: FlightState): void => {
    // Recentre the world on the vessel every frame to keep f32 precision. The
    // vessel then sits at the scene origin and the body centre lands at minus
    // its simulation position.
    // Clouds need several seconds of noise baked before they can be drawn;
    // this spends it a few milliseconds at a time rather than up front.
    system.stepCloudBakes();
    system.updateTerrain(current.body, current.position, current.time);

    origin.setOrigin(current.position);

    // Bodies are placed through the shared root frame, so this stays correct
    // when the vessel is handed from a planet to a moon mid-flight.
    system.update(current.body, current.position, current.time);

    // The vessel's own orbit is drawn around whichever body currently owns it.
    const hostCentre = system.positionOf(current.body.id);
    if (hostCentre) orbit.group.position.copy(hostCentre);

    updateVesselView(vessel, current.orientation, current.throttle, current.thermal);

    const elements = elementsFromState(
      current.position,
      current.velocity,
      current.body.mu,
    );

    // Rebuilding 256 ellipse vertices is only worth doing when the orbit
    // actually changed, which it does not while coasting.
    const signature = `${current.body.id}|${orbitSignature(elements)}`;
    if (signature !== lastOrbitSignature) {
      updateOrbitGeometry(orbit, elements, current.body.mu);
      lastOrbitSignature = signature;
    }
    updateVesselMarker(orbit, elements, current.body.mu);

    if (viewMode === 'flight') {
      const altitude = Math.max(0, altitudeOf(current.body, current.position));
      chase.setDistance(60 + altitude * 0.01);
      chase.update(current.position);
      updateMarkerScale(orbit, chase.getDistance());
    } else {
      const frameRadius = Number.isFinite(elements.apoapsis)
        ? Math.max(elements.apoapsis, current.body.radius)
        : current.position.length;
      map.update(hostCentre ?? context.camera.position, frameRadius);
      updateMarkerScale(orbit, map.getDistance());
    }

    // Keep the starfield centred on the camera so it never parallaxes.
    stars.position.copy(context.camera.position);

    // Daylight drowns starlight rather than blocking it, so fade them by how
    // bright the sky overhead actually is.
    const altitude = current.position.length - current.body.radius;
    starMaterial.opacity = starVisibility(
      system.skyBrightnessAt(current.body, altitude),
    );

    hud.update(current, phase, activeWarp);

    // Sky and clouds at reduced resolution, everything with edges at full.
    skyPass.render(context.scene, context.camera, {
      background: [stars, ...system.skyMeshes],
      foreground: [vessel.group, orbit.group, ...system.surfaceMeshes],
    });
  };

  const frame = (now: number): void => {
    const elapsed = Math.min((now - lastFrameTime) / 1000, 0.25);
    lastFrameTime = now;

    if (appMode === 'editor') {
      editor.update();
      context.renderer.render(editor.scene, editor.camera);
      requestAnimationFrame(frame);
      return;
    }

    if (!isPaused) advanceSimulation(elapsed);

    renderFrame(state);
    requestAnimationFrame(frame);
  };

  requestAnimationFrame(frame);

  window.addEventListener('resize', () => {
    skyPass.setSize(window.innerWidth, window.innerHeight);
  });

  window.addEventListener('beforeunload', () => {
    detachResize();
    detachCamera();
    detachEditor();
    detachKeys();
  });
}

interface KeyboardHandlers {
  readonly onTogglePause: () => void;
  readonly onWarpDown: () => void;
  readonly onWarpUp: () => void;
  readonly onToggleMap: () => void;
  readonly onToggleEditor: () => void;
  readonly onReset: () => void;
}

function attachKeyboard(handlers: KeyboardHandlers): () => void {
  const onKeyDown = (event: KeyboardEvent): void => {
    switch (event.key) {
      case ' ':
        event.preventDefault();
        handlers.onTogglePause();
        break;
      case ',':
        handlers.onWarpDown();
        break;
      case '.':
        handlers.onWarpUp();
        break;
      case 'm':
      case 'M':
        handlers.onToggleMap();
        break;
      case 'b':
      case 'B':
        handlers.onToggleEditor();
        break;
      case 'r':
      case 'R':
        handlers.onReset();
        break;
      default:
        break;
    }
  };

  window.addEventListener('keydown', onKeyDown);
  return () => window.removeEventListener('keydown', onKeyDown);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const overlay = document.querySelector<HTMLElement>('#overlay');
  if (overlay) {
    overlay.innerHTML = `<div class="fatal">Failed to start OrbitForge: ${message}</div>`;
  }
});
