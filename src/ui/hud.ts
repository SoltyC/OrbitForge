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
import { elementsFromState, timeToApoapsis, timeToPeriapsis } from '../sim/orbit.js';
import { holdLabel } from '../sim/control.js';
import type { HoldMode } from '../sim/control.js';
import { isEmpty, nodeDeltaV } from '../sim/maneuver.js';
import type { ManeuverNode } from '../sim/maneuver.js';
import { formatWarp } from '../sim/timeWarp.js';
import { thrustToWeight, totalDeltaV, vesselMass } from '../sim/vessel.js';

const FIELDS = [
  'control',
  'hold',
  'throttleLevel',
  'phase',
  'body',
  'regime',
  'warp',
  'met',
  'altitude',
  'surfaceSpeed',
  'verticalSpeed',
  'horizontalSpeed',
  'apoapsis',
  'periapsis',
  'eccentricity',
  'period',
  'timeToApoapsis',
  'timeToPeriapsis',
  'stage',
  'propellant',
  'deltaV',
  'twr',
  'mass',
  'skinTemp',
  'heatShield',
  'nodeDeltaV',
  'nodeIn',
] as const;

type FieldName = (typeof FIELDS)[number];

const LABELS: Record<FieldName, string> = {
  control: 'Control',
  hold: 'Holding',
  throttleLevel: 'Throttle',
  phase: 'Phase',
  body: 'Reference body',
  regime: 'Regime',
  warp: 'Time warp',
  met: 'MET',
  altitude: 'Altitude',
  surfaceSpeed: 'Surface speed',
  verticalSpeed: 'Vertical speed',
  horizontalSpeed: 'Horizontal speed',
  apoapsis: 'Apoapsis',
  periapsis: 'Periapsis',
  eccentricity: 'Eccentricity',
  period: 'Period',
  timeToApoapsis: 'To apoapsis',
  timeToPeriapsis: 'To periapsis',
  stage: 'Stage',
  propellant: 'Propellant',
  deltaV: 'Delta-v remaining',
  twr: 'TWR',
  mass: 'Mass',
  skinTemp: 'Skin temp',
  heatShield: 'Heat shield',
  nodeDeltaV: 'Node delta-v',
  nodeIn: 'Node in',
};

/** What the player is doing, as opposed to what the vessel is doing. */
export interface PilotStatus {
  readonly hold: HoldMode;
  readonly throttle: number;
  readonly autopilot: boolean;
  readonly maneuver: ManeuverNode | null;
}

export class Hud {
  private readonly values = new Map<FieldName, HTMLElement>();
  private readonly panel: HTMLElement;

  constructor(container: HTMLElement) {
    const panel = document.createElement('div');
    panel.className = 'hud-panel';
    this.panel = panel;

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

  setVisible(visible: boolean): void {
    this.panel.style.display = visible ? '' : 'none';
  }

  update(
    state: FlightState,
    phase: AscentPhase,
    warpIndex: number,
    pilot: PilotStatus,
  ): void {
    const body = state.body;
    const altitude = altitudeOf(body, state.position);
    const elements = elementsFromState(state.position, state.velocity, body.mu);
    const airspeed = surfaceRelativeVelocity(body, state.position, state.velocity).length;
    const ambient = pressureRatio(body, altitude);
    const gravity = body.mu / (state.position.length * state.position.length);
    const stage = state.vessel.stages[0];

    this.set('control', pilot.autopilot ? 'Autopilot' : 'Manual');
    this.set('hold', holdLabel(pilot.hold));
    this.set('throttleLevel', `${(pilot.throttle * 100).toFixed(0)}%`);

    if (pilot.maneuver && !isEmpty(pilot.maneuver)) {
      this.set('nodeDeltaV', `${nodeDeltaV(pilot.maneuver).toFixed(0)} m/s`);
      this.set('nodeIn', formatDuration(pilot.maneuver.time - state.time, false));
    } else {
      this.set('nodeDeltaV', '—');
      this.set('nodeIn', '—');
    }

    this.set('phase', formatPhase(phase));
    this.set('body', body.name);
    this.set('regime', formatRegime(state.regime));
    this.set('warp', formatWarp(warpIndex));
    this.set('met', formatDuration(state.time));
    this.set('altitude', formatDistance(altitude));
    this.set('surfaceSpeed', `${airspeed.toFixed(0)} m/s`);
    this.set('verticalSpeed', `${verticalSpeed(state.position, state.velocity).toFixed(1)} m/s`);
    this.set('horizontalSpeed', `${horizontalSpeed(state.position, state.velocity).toFixed(0)} m/s`);
    this.set('apoapsis', formatApsis(elements.apoapsis, body.radius));
    this.set('periapsis', formatApsis(elements.periapsis, body.radius));
    this.set('eccentricity', elements.eccentricity.toFixed(4));
    this.set('period', formatDuration(elements.period, false));
    this.set('timeToApoapsis', formatDuration(timeToApoapsis(elements, body.mu), false));
    this.set('timeToPeriapsis', formatDuration(timeToPeriapsis(elements, body.mu), false));
    this.set('stage', `${state.vessel.stages.length} remaining`);
    this.set('propellant', stage ? `${stage.propellant.toFixed(0)} kg` : '—');
    this.set('deltaV', `${totalDeltaV(state.vessel, ambient).toFixed(0)} m/s`);
    this.set('twr', thrustToWeight(state.vessel, gravity, ambient, state.throttle).toFixed(2));
    this.set('mass', `${(vesselMass(state.vessel) / 1000).toFixed(2)} t`);
    this.set('skinTemp', `${state.thermal.temperature.toFixed(0)} K`);
    this.set('heatShield', `${(state.thermal.shield * 100).toFixed(0)}%`);
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
    insertion: 'Orbit insertion',
    transferWait: 'Awaiting window',
    transferBurn: 'Transfer burn',
    cruise: 'Cruising',
    arrived: 'Arrived',
    descent: 'Powered descent',
    touchdown: 'Touchdown',
    manual: 'Manual',
    complete: 'Orbit achieved',
  };
  return names[phase];
}

function formatRegime(regime: FlightState['regime']): string {
  const names: Record<FlightState['regime'], string> = {
    prelaunch: 'Pre-launch',
    powered: 'Powered (RK4)',
    coasting: 'Coasting (RK4)',
    onRails: 'On rails (Kepler)',
    landed: 'Landed',
  };
  return names[regime];
}

function formatDuration(seconds: number, isElapsed = true): string {
  if (!Number.isFinite(seconds)) return '—';

  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;

  const pad = (n: number): string => String(n).padStart(2, '0');
  const clock =
    hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${pad(minutes)}:${pad(secs)}`;

  return isElapsed ? `T+${clock}` : clock;
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
