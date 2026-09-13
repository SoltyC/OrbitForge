/**
 * Patched conics: sphere-of-influence determination and frame re-parenting.
 *
 * A vessel only ever feels one body's gravity — whichever sphere of influence
 * it currently sits in. When it crosses a boundary, its state is rewritten
 * into the new body's frame. That rewrite must be exactly continuous: the same
 * physical trajectory, described relative to a different origin. Any error
 * here appears as a free velocity change at the boundary, which would corrupt
 * every trajectory that crosses one.
 *
 * This is the backbone of the whole space simulation.
 */
import { relativePosition, transformFrame } from '../bodies/ephemeris.js';
import { childrenOf, parentOf } from '../bodies/system.js';
import type { Body } from '../bodies/types.js';
import type { Vec3 } from './vec3.js';

export interface FrameState {
  readonly body: Body;
  readonly position: Vec3;
  readonly velocity: Vec3;
}

/**
 * Which body's sphere of influence a position belongs to.
 *
 * Children are checked first: a vessel deep inside a moon's SOI is also inside
 * the planet's, and the innermost one wins.
 */
export function dominantBody(body: Body, position: Vec3, time: number): Body {
  for (const child of childrenOf(body.id)) {
    const toChild = position.sub(relativePosition(body, child, time));
    if (toChild.length < child.soiRadius) return child;
  }

  if (position.length > body.soiRadius) {
    const parent = parentOf(body);
    if (parent) return parent;
  }

  return body;
}

/**
 * Rewrite a state into another body's frame.
 *
 * Position and velocity are both offset by the relative state of the two
 * bodies, so the described trajectory is physically unchanged.
 */
export function reframe(state: FrameState, target: Body, time: number): FrameState {
  if (state.body.id === target.id) return state;

  const moved = transformFrame(
    state.position,
    state.velocity,
    state.body,
    target,
    time,
  );

  return { body: target, position: moved.position, velocity: moved.velocity };
}

/**
 * Re-parent a state if it has crossed a boundary, otherwise return it
 * unchanged. Iterates because a single step can cross more than one boundary —
 * leaving a moon's SOI and immediately entering a sibling's, for instance.
 */
export function resolveSoi(state: FrameState, time: number): FrameState {
  let current = state;

  // Bounded to keep a pathological configuration from spinning forever.
  for (let i = 0; i < 8; i++) {
    const target = dominantBody(current.body, current.position, time);
    if (target.id === current.body.id) return current;
    current = reframe(current, target, time);
  }

  return current;
}

/**
 * Distance to the nearest sphere-of-influence boundary (m).
 *
 * Used to bound how far time-warp may leap: warping past a boundary would
 * leave the transition unsimulated, and the vessel would appear on a
 * trajectory it never actually flew.
 */
export function distanceToNearestBoundary(state: FrameState, time: number): number {
  let nearest = Number.isFinite(state.body.soiRadius)
    ? Math.abs(state.body.soiRadius - state.position.length)
    : Infinity;

  for (const child of childrenOf(state.body.id)) {
    const toChild = state.position.sub(relativePosition(state.body, child, time));
    nearest = Math.min(nearest, Math.abs(toChild.length - child.soiRadius));
  }

  return nearest;
}

