/**
 * Flight telemetry overlay.
 *
 * Plain DOM rather than a framework: milestone 1 has a fixed set of readouts
 * and no interaction beyond keyboard shortcuts. React arrives with the VAB.
 */
import { pressureRatio } from '../sim/atmosphere.js';
import type { FlightState } from '../sim/flightState.js';
import {
  altitudeOf,
  horizontalSpeed,
  surfaceRelativeVelocity,
  verticalSpeed,
} from '../sim/forces.js';
import type { AscentPhase } from '../sim/guidance.js';
import { elementsFromState } from '../sim/orbit.js';
import { thrustToWeight, totalDeltaV, vesselMass } from '../sim/vessel.js';

const FIELDS = [
  'phase',
  'met',
  'altitude',
  'surfaceSpeed',
  'verticalSpeed',
  'horizontalSpeed',
  'apoapsis',
  'periapsis',
  'eccentricity',
  'stage',
  'propellant',
  'deltaV',
  'twr',
  'mass',
] as const;

type FieldName = (typeof FIELDS)[number];

const LABELS: Record<FieldName, string> = {
  phase: 'Phase',
  met: 'MET',
  altitude: 'Altitude',
  surfaceSpeed: 'Surface speed',
  verticalSpeed: 'Vertical speed',
  horizontalSpeed: 'Horizontal speed',
  apoapsis: 'Apoapsis',
  periapsis: 'Periapsis',
  eccentricity: 'Eccentricity',
  stage: 'Stage',
  propellant: 'Propellant',
  deltaV: 'Delta-v remaining',
  twr: 'TWR',
  mass: 'Mass',
};

export class Hud {
  private readonly values = new Map<FieldName, HTMLElement>();

  constructor(container: HTMLElement) {
    const panel = document.createElement('div');
    panel.className = 'hud-panel';

    for (const field of FIELDS) {
      const row = document.createElement('div');
      row.className = 'hud-row';

      const label = document.createElement('span');
      label.className = 'hud-label';
      label.textContent = LABELS[field];

      const value = document.createElement('span');
      value.className = 'hud-value';
      value.textContent = '—';

      row.append(label, value);
      panel.append(row);
      this.values.set(field, value);
    }

    container.append(panel);
  }

  update(state: FlightState, phase: AscentPhase): void {
    const body = state.body;
    const altitude = altitudeOf(body, state.position);
    const elements = elementsFromState(state.position, state.velocity, body.mu);
    const airspeed = surfaceRelativeVelocity(body, state.position, state.velocity).length;
    const ambient = pressureRatio(body, altitude);
    const gravity = body.mu / (state.position.length * state.position.length);
    const stage = state.vessel.stages[0];

    this.set('phase', formatPhase(phase));
    this.set('met', formatDuration(state.time));
    this.set('altitude', formatDistance(altitude));
    this.set('surfaceSpeed', `${airspeed.toFixed(0)} m/s`);
    this.set('verticalSpeed', `${verticalSpeed(state.position, state.velocity).toFixed(1)} m/s`);
    this.set('horizontalSpeed', `${horizontalSpeed(state.position, state.velocity).toFixed(0)} m/s`);
    this.set('apoapsis', formatApsis(elements.apoapsis, body.radius));
    this.set('periapsis', formatApsis(elements.periapsis, body.radius));
    this.set('eccentricity', elements.eccentricity.toFixed(4));
    this.set('stage', `${state.vessel.stages.length} remaining`);
    this.set('propellant', stage ? `${stage.propellant.toFixed(0)} kg` : '—');
    this.set('deltaV', `${totalDeltaV(state.vessel, ambient).toFixed(0)} m/s`);
    this.set('twr', thrustToWeight(state.vessel, gravity, ambient, state.throttle).toFixed(2));
    this.set('mass', `${(vesselMass(state.vessel) / 1000).toFixed(2)} t`);
  }

  private set(field: FieldName, text: string): void {
    const element = this.values.get(field);
    if (element) element.textContent = text;
  }
}

function formatPhase(phase: AscentPhase): string {
  const names: Record<AscentPhase, string> = {
    prelaunch: 'Pre-launch',
    liftoff: 'Liftoff',
    gravityTurn: 'Gravity turn',
    coastToApoapsis: 'Coasting',
    circularise: 'Circularising',
    complete: 'Orbit achieved',
  };
  return names[phase];
}

function formatDuration(seconds: number): string {
  const total = Math.floor(seconds);
  const minutes = Math.floor(total / 60);
  const remainder = total % 60;
  return `T+${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
}

function formatDistance(metres: number): string {
  if (Math.abs(metres) < 1_000) return `${metres.toFixed(0)} m`;
  return `${(metres / 1_000).toFixed(2)} km`;
}

/** Apsis distances are reported as altitude above sea level, KSP-style. */
function formatApsis(radius: number, bodyRadius: number): string {
  if (!Number.isFinite(radius)) return 'escape';
  return formatDistance(radius - bodyRadius);
}
