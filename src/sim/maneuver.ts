/**
 * Manoeuvre nodes.
 *
 * A node is a burn planned at a point in the future: so much prograde, so much
 * normal, so much radial, at a given time. Planning one and seeing the orbit it
 * produces — before spending any propellant — is the difference between flying
 * a spacecraft and guessing at it.
 *
 * The burn is expressed in the orbital frame rather than as a world vector,
 * because that is how the decisions are actually made: prograde raises the far
 * side of the orbit, normal tilts its plane, radial shifts where its apsides
 * sit. Converting to a world direction is the node's job, not the player's.
 */
import { referenceFrame } from './control.js';
import { elementsFromState, propagate, stateFromElements } from './orbit.js';
import type { OrbitSummary } from './orbit.js';
import { Vec3 } from './vec3.js';

export interface ManeuverNode {
  /** Mission time the burn is centred on (s). */
  readonly time: number;
  /** Delta-v along the orbital velocity (m/s); positive raises the orbit. */
  readonly prograde: number;
  /** Delta-v perpendicular to the orbital plane (m/s); changes inclination. */
  readonly normal: number;
  /** Delta-v straight up from the body (m/s); shifts the apsides around. */
  readonly radial: number;
}

export function emptyNode(time: number): ManeuverNode {
  return { time, prograde: 0, normal: 0, radial: 0 };
}

/** Total delta-v the node asks for (m/s). */
export function nodeDeltaV(node: ManeuverNode): number {
  return Math.hypot(node.prograde, node.normal, node.radial);
}

/** Whether a node asks for anything at all. */
export function isEmpty(node: ManeuverNode): boolean {
  return nodeDeltaV(node) < 1e-6;
}

export interface NodeState {
  /** Where the vessel will be when the burn starts. */
  readonly position: Vec3;
  readonly velocity: Vec3;
  /** The world-space direction the burn points. */
  readonly burn: Vec3;
  /** The orbit the burn produces. */
  readonly resulting: OrbitSummary;
}

/**
 * Where the vessel will be at the node, and what the burn does to its orbit.
 *
 * Propagated analytically along the current orbit, so this is exact for a
 * coasting vessel and a good estimate for one still under thrust.
 */
export function evaluateNode(
  node: ManeuverNode,
  position: Vec3,
  velocity: Vec3,
  mu: number,
  now: number,
): NodeState | null {
  const current = elementsFromState(position, velocity, mu);
  if (!current.isClosed) return null;

  // Coast to the node.
  const wait = Math.max(0, node.time - now);
  const atNode = stateFromElements(propagate(current, mu, wait), mu);

  const frame = referenceFrame(atNode.position, atNode.velocity);

  const burn = frame.prograde
    .scale(node.prograde)
    .add(frame.normal.scale(node.normal))
    .add(frame.radialOut.scale(node.radial));

  return {
    position: atNode.position,
    velocity: atNode.velocity,
    burn,
    resulting: elementsFromState(atNode.position, atNode.velocity.add(burn), mu),
  };
}

/**
 * How long the burn takes, given the vessel's thrust and mass (s).
 *
 * Used to start it early enough that it straddles the node rather than
 * beginning there — a burn applied entirely after its planned time lands the
 * vessel somewhere else.
 */
export function burnDuration(
  deltaV: number,
  thrust: number,
  mass: number,
  exhaustVelocity: number,
): number {
  if (deltaV <= 0 || thrust <= 0 || mass <= 0) return 0;

  // From the rocket equation: the mass that has to be expelled, over the rate.
  const finalMass = mass / Math.exp(deltaV / Math.max(1, exhaustVelocity));
  const flowRate = thrust / Math.max(1, exhaustVelocity);

  return (mass - finalMass) / flowRate;
}

/**
 * Seconds until the burn should begin, so that it straddles the node.
 *
 * Negative once it should already be under way.
 */
export function timeToBurn(node: ManeuverNode, now: number, duration: number): number {
  return node.time - duration / 2 - now;
}

/** Whether the node has been flown past and is no longer worth holding. */
export function isExpired(node: ManeuverNode, now: number, duration: number): boolean {
  return now > node.time + duration / 2 + 1;
}

/**
 * Delta-v still to go on a burn in progress (m/s).
 *
 * Measured against how far the velocity has actually changed rather than by
 * counting down a timer, so a burn that runs out of propellant or gets
 * interrupted reports honestly.
 */
export function remainingDeltaV(node: ManeuverNode, spent: number): number {
  return Math.max(0, nodeDeltaV(node) - spent);
}

/**
 * Adjust one axis of a node.
 *
 * Returned rather than mutated, like everything else the simulation touches.
 */
export function adjustNode(
  node: ManeuverNode,
  axis: 'prograde' | 'normal' | 'radial',
  delta: number,
): ManeuverNode {
  return { ...node, [axis]: node[axis] + delta };
}

/** Move a node earlier or later along the orbit. */
export function shiftNode(node: ManeuverNode, seconds: number, now: number): ManeuverNode {
  return { ...node, time: Math.max(now, node.time + seconds) };
}

/**
 * A node that circularises at the current orbit's apoapsis.
 *
 * The single most common manoeuvre in the game, and a reasonable thing to
 * offer as a starting point rather than making the player find it by hand.
 */
export function circulariseAtApoapsis(
  position: Vec3,
  velocity: Vec3,
  mu: number,
  now: number,
): ManeuverNode | null {
  const orbit = elementsFromState(position, velocity, mu);
  if (!orbit.isClosed) return null;

  const apoapsis = orbit.apoapsis;

  // Vis-viva: what the vessel will have at apoapsis, against what a circular
  // orbit there needs.
  const atApoapsis = Math.sqrt(mu * (2 / apoapsis - 1 / orbit.semiMajorAxis));
  const circular = Math.sqrt(mu / apoapsis);

  return {
    time: now + timeToApoapsisOf(orbit, mu),
    prograde: circular - atApoapsis,
    normal: 0,
    radial: 0,
  };
}

/** Seconds from now until apoapsis, on a closed orbit. */
function timeToApoapsisOf(orbit: OrbitSummary, mu: number): number {
  const { semiMajorAxis: a, eccentricity: e } = orbit;
  const meanMotion = Math.sqrt(mu / (a * a * a));

  const eccentric = Math.atan2(
    Math.sqrt(1 - e * e) * Math.sin(orbit.trueAnomaly),
    e + Math.cos(orbit.trueAnomaly),
  );
  const mean = eccentric - e * Math.sin(eccentric);

  const toGo = Math.PI - mean;
  const wrapped = ((toGo % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);

  return wrapped / meanMotion;
}
