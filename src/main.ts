/**
 * Entry point: launch Pathfinder I from Terrin, fly it to orbit, then warp.
 *
 * The physics runs on a fixed timestep decoupled from the render loop while
 * integrating, and in single analytic jumps while on rails — so the trajectory
 * is identical regardless of framerate or warp factor.
 */
import { TERRIN } from './bodies/system.js';
import { createPathfinder } from './parts/testVehicle.js';
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
import { createPlanetView, updatePlanetRotation } from './render/planet.js';
import { attachResizeHandler, createRenderContext } from './render/renderer.js';
import { createStarfield } from './render/starfield.js';
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
import { Vec3 } from './sim/vec3.js';
import { Hud } from './ui/hud.js';

/** Target a circular orbit 80 km up — comfortably clear of the atmosphere. */
const TARGET_ALTITUDE = 80_000;

/** Integrated steps per frame are capped so a stall cannot spiral the loop. */
const MAX_STEPS_PER_FRAME = 16;

type ViewMode = 'flight' | 'map';

async function main(): Promise<void> {
  const canvas = document.querySelector<HTMLCanvasElement>('#viewport');
  const overlay = document.querySelector<HTMLElement>('#overlay');
  if (!canvas || !overlay) {
    throw new Error('Missing #viewport canvas or #overlay container');
  }

  const context = await createRenderContext(canvas);
  const detachResize = attachResizeHandler(context);

  const options: SimulationOptions = {
    target: { orbitRadius: TERRIN.radius + TARGET_ALTITUDE },
    autopilotEnabled: true,
  };

  let state = createPrelaunchState(TERRIN, createPathfinder());
  let phase: AscentPhase = 'prelaunch';
  let requestedWarp = 0;
  let activeWarp = 0;
  let isPaused = false;
  let viewMode: ViewMode = 'flight';
  let lastOrbitSignature = '';

  const origin = new FloatingOrigin(state.position);
  const planet = createPlanetView(TERRIN);
  const vessel = createVesselView(state.vessel);
  const stars = createStarfield(TERRIN.surface.seed);
  const orbit = createOrbitLineView();

  context.scene.add(planet.group, vessel.group, stars, orbit.group);

  const chase = new ChaseCamera(context.camera);
  const map = new MapCamera(context.camera);
  let detachCamera = chase.attach(canvas);

  const hud = new Hud(overlay);

  const setViewMode = (mode: ViewMode): void => {
    if (mode === viewMode) return;
    viewMode = mode;
    detachCamera();
    detachCamera = mode === 'flight' ? chase.attach(canvas) : map.attach(canvas);
    // The vessel mesh is sub-metre against a 600 km planet; in map view the
    // marker stands in for it.
    vessel.group.visible = mode === 'flight';
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
      state = createPrelaunchState(TERRIN, createPathfinder());
      phase = 'prelaunch';
      requestedWarp = 0;
      lastOrbitSignature = '';
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
    origin.setOrigin(current.position);
    origin.writeTo(Vec3.ZERO, planet.group.position);
    orbit.group.position.copy(planet.group.position);

    updatePlanetRotation(planet, TERRIN, current.time);
    updateVesselView(vessel, current.orientation, current.throttle);

    const elements = elementsFromState(current.position, current.velocity, TERRIN.mu);

    // Rebuilding 256 ellipse vertices is only worth doing when the orbit
    // actually changed, which it does not while coasting.
    const signature = orbitSignature(elements);
    if (signature !== lastOrbitSignature) {
      updateOrbitGeometry(orbit, elements, TERRIN.mu);
      lastOrbitSignature = signature;
    }
    updateVesselMarker(orbit, elements, TERRIN.mu);

    if (viewMode === 'flight') {
      const altitude = Math.max(0, altitudeOf(TERRIN, current.position));
      chase.setDistance(60 + altitude * 0.01);
      chase.update(current.position);
      updateMarkerScale(orbit, chase.getDistance());
    } else {
      const frameRadius = Number.isFinite(elements.apoapsis)
        ? Math.max(elements.apoapsis, TERRIN.radius)
        : current.position.length;
      map.update(planet.group.position, frameRadius);
      updateMarkerScale(orbit, map.getDistance());
    }

    // Keep the starfield centred on the camera so it never parallaxes.
    stars.position.copy(context.camera.position);

    hud.update(current, phase, activeWarp);
    context.renderer.render(context.scene, context.camera);
  };

  const frame = (now: number): void => {
    const elapsed = Math.min((now - lastFrameTime) / 1000, 0.25);
    lastFrameTime = now;

    if (!isPaused) advanceSimulation(elapsed);

    renderFrame(state);
    requestAnimationFrame(frame);
  };

  requestAnimationFrame(frame);

  window.addEventListener('beforeunload', () => {
    detachResize();
    detachCamera();
    detachKeys();
  });
}

interface KeyboardHandlers {
  readonly onTogglePause: () => void;
  readonly onWarpDown: () => void;
  readonly onWarpUp: () => void;
  readonly onToggleMap: () => void;
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
