/**
 * Milestone 1 entry point: launch Pathfinder I from Terrin and fly it to orbit.
 *
 * The physics runs on a fixed timestep decoupled from the render loop, so the
 * trajectory is identical regardless of framerate.
 */
import { TERRIN } from './bodies/system.js';
import { createPathfinder } from './parts/testVehicle.js';
import { ChaseCamera } from './render/chaseCamera.js';
import { FloatingOrigin } from './render/floatingOrigin.js';
import { createPlanetView, updatePlanetRotation } from './render/planet.js';
import { attachResizeHandler, createRenderContext } from './render/renderer.js';
import { createStarfield } from './render/starfield.js';
import { createVesselView, updateVesselView } from './render/vesselView.js';
import { createPrelaunchState } from './sim/flightState.js';
import type { FlightState } from './sim/flightState.js';
import { altitudeOf } from './sim/forces.js';
import type { AscentPhase } from './sim/guidance.js';
import { PHYSICS_TIMESTEP, step } from './sim/simulation.js';
import { Vec3 } from './sim/vec3.js';
import type { SimulationOptions } from './sim/simulation.js';
import { Hud } from './ui/hud.js';

/** Target a circular orbit 80 km up — comfortably clear of the atmosphere. */
const TARGET_ALTITUDE = 80_000;

/** Physics steps per frame are capped so a stall cannot spiral the loop. */
const MAX_STEPS_PER_FRAME = 8;

/** Time-warp multipliers cycled with the , and . keys. */
const WARP_LEVELS = [1, 2, 5, 10, 50] as const;

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
  let warpIndex = 0;
  let isPaused = false;

  const origin = new FloatingOrigin(state.position);
  const planet = createPlanetView(TERRIN);
  const vessel = createVesselView(state.vessel);
  const stars = createStarfield(TERRIN.surface.seed);

  context.scene.add(planet.group, vessel.group, stars);

  const chase = new ChaseCamera(context.camera);
  const detachCamera = chase.attach(canvas);
  const hud = new Hud(overlay);

  const detachKeys = attachKeyboard({
    onTogglePause: () => {
      isPaused = !isPaused;
    },
    onWarpDown: () => {
      warpIndex = Math.max(0, warpIndex - 1);
    },
    onWarpUp: () => {
      warpIndex = Math.min(WARP_LEVELS.length - 1, warpIndex + 1);
    },
    onReset: () => {
      state = createPrelaunchState(TERRIN, createPathfinder());
      phase = 'prelaunch';
      warpIndex = 0;
    },
  });

  let lastFrameTime = performance.now();
  let accumulator = 0;

  const frame = (now: number): void => {
    const elapsed = Math.min((now - lastFrameTime) / 1000, 0.25);
    lastFrameTime = now;

    if (!isPaused) {
      accumulator += elapsed * WARP_LEVELS[warpIndex]!;

      let steps = 0;
      while (accumulator >= PHYSICS_TIMESTEP && steps < MAX_STEPS_PER_FRAME) {
        const result = step(state, options);
        state = result.state;
        phase = result.command.phase;
        accumulator -= PHYSICS_TIMESTEP;
        steps += 1;
      }

      // Drop any backlog we could not work through, rather than accruing debt.
      if (accumulator > PHYSICS_TIMESTEP * MAX_STEPS_PER_FRAME) accumulator = 0;
    }

    renderFrame(state);
    requestAnimationFrame(frame);
  };

  const renderFrame = (current: FlightState): void => {
    // Recentre the world on the vessel every frame to keep f32 precision.
    // The vessel then sits at the scene origin and the planet centre lands at
    // minus its simulation position.
    origin.setOrigin(current.position);
    origin.writeTo(Vec3.ZERO, planet.group.position);

    updatePlanetRotation(planet, TERRIN, current.time);
    updateVesselView(vessel, current.orientation, current.throttle);

    // Pull the camera back as the vessel climbs so the planet stays in frame.
    const altitude = Math.max(0, altitudeOf(TERRIN, current.position));
    chase.setDistance(60 + altitude * 0.01);
    chase.update(current.position);

    // Keep the starfield centred on the camera so it never parallaxes.
    stars.position.copy(context.camera.position);

    hud.update(current, phase);
    context.renderer.render(context.scene, context.camera);
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
