/**
 * Keyboard flying.
 *
 * Bindings follow Kerbal Space Program's, because that is the muscle memory
 * anyone arriving at this game already has: WASDQE to steer, shift and control
 * for throttle, space to stage, and the number row for the hold modes.
 *
 * Throttle is a level that persists rather than a key that is held. Holding a
 * key for a nine-minute ascent is not a control scheme.
 */
import { NEUTRAL_CONTROL } from '../sim/control.js';
import type { ControlInput, HoldMode } from '../sim/control.js';

/** Throttle change per second while a throttle key is held. */
const THROTTLE_RATE = 0.9;

/** Hold modes on the number row, in the order they sit on the keyboard. */
const HOLD_KEYS: Record<string, HoldMode> = {
  Digit1: 'free',
  Digit2: 'prograde',
  Digit3: 'retrograde',
  Digit4: 'normal',
  Digit5: 'antiNormal',
  Digit6: 'radialOut',
  Digit7: 'radialIn',
  Digit8: 'maneuver',
};

export interface PilotEvents {
  /** The player asked to plan, adjust or execute a manoeuvre. */
  readonly onManeuver: (action: ManeuverAction) => void;
  readonly onToggleAutopilot: () => void;
}

export type ManeuverAction =
  | { kind: 'plan' }
  | { kind: 'clear' }
  | { kind: 'adjust'; axis: 'prograde' | 'normal' | 'radial'; delta: number }
  | { kind: 'shift'; seconds: number }
  | { kind: 'warpTo' };

/**
 * Tracks which keys are down and turns that into a control input each frame.
 *
 * Held keys are sampled rather than acted on as events, because steering is
 * continuous — an event-driven scheme gives a nose that jumps once per
 * keypress instead of swinging while the key is down.
 */
export class PilotInput {
  private readonly down = new Set<string>();
  private throttle = 0;
  private hold: HoldMode = 'free';
  private stageRequested = false;

  constructor(private readonly events: PilotEvents) {}

  attach(): () => void {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.repeat) {
        this.down.add(event.code);
        return;
      }

      this.down.add(event.code);
      this.handlePress(event);
    };

    const onKeyUp = (event: KeyboardEvent): void => {
      this.down.delete(event.code);
    };

    // Losing focus mid-burn would otherwise leave keys stuck down.
    const onBlur = (): void => this.down.clear();

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);

    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }

  /** Sample the current input. Call once per frame. */
  sample(dt: number): ControlInput {
    // Throttle is a level, nudged while a key is held.
    if (this.down.has('ShiftLeft') || this.down.has('ShiftRight')) {
      this.throttle = Math.min(1, this.throttle + THROTTLE_RATE * dt);
    }
    if (this.down.has('ControlLeft') || this.down.has('ControlRight')) {
      this.throttle = Math.max(0, this.throttle - THROTTLE_RATE * dt);
    }

    const input: ControlInput = {
      ...NEUTRAL_CONTROL,
      throttle: this.throttle,
      pitch: axis(this.down, 'KeyS', 'KeyW'),
      yaw: axis(this.down, 'KeyD', 'KeyA'),
      roll: axis(this.down, 'KeyE', 'KeyQ'),
      hold: this.hold,
      stageRequested: this.stageRequested,
    };

    // Staging is a single event, not a state.
    this.stageRequested = false;

    return input;
  }

  get holdMode(): HoldMode {
    return this.hold;
  }

  get throttleLevel(): number {
    return this.throttle;
  }

  setThrottle(value: number): void {
    this.throttle = Math.min(1, Math.max(0, value));
  }

  setHold(hold: HoldMode): void {
    this.hold = hold;
  }

  private handlePress(event: KeyboardEvent): void {
    const held = HOLD_KEYS[event.code];
    if (held) {
      // Pressing the mode you are already in returns you to free flight, so
      // one key both engages and releases a hold.
      this.hold = this.hold === held ? 'free' : held;
      event.preventDefault();
      return;
    }

    switch (event.code) {
      case 'Space':
        this.stageRequested = true;
        event.preventDefault();
        break;

      // Throttle extremes, as KSP has them.
      case 'KeyZ':
        this.throttle = 1;
        break;
      case 'KeyX':
        this.throttle = 0;
        break;

      case 'KeyT':
        this.events.onToggleAutopilot();
        break;

      // Manoeuvre planning.
      case 'KeyN':
        this.events.onManeuver({ kind: 'plan' });
        break;
      case 'KeyC':
        this.events.onManeuver({ kind: 'clear' });
        break;
      case 'BracketRight':
        this.events.onManeuver({ kind: 'shift', seconds: 30 });
        break;
      case 'BracketLeft':
        this.events.onManeuver({ kind: 'shift', seconds: -30 });
        break;
      case 'Equal':
        this.events.onManeuver({ kind: 'adjust', axis: 'prograde', delta: 10 });
        break;
      case 'Minus':
        this.events.onManeuver({ kind: 'adjust', axis: 'prograde', delta: -10 });
        break;
      case 'Period':
        this.events.onManeuver({ kind: 'adjust', axis: 'normal', delta: 10 });
        break;
      case 'Comma':
        this.events.onManeuver({ kind: 'adjust', axis: 'normal', delta: -10 });
        break;
      case 'Semicolon':
        this.events.onManeuver({ kind: 'adjust', axis: 'radial', delta: 10 });
        break;
      case 'Quote':
        this.events.onManeuver({ kind: 'adjust', axis: 'radial', delta: -10 });
        break;
      case 'KeyG':
        this.events.onManeuver({ kind: 'warpTo' });
        break;
      default:
        break;
    }
  }
}

/** A -1..1 axis from a pair of opposed keys. */
function axis(down: ReadonlySet<string>, negative: string, positive: string): number {
  return (down.has(positive) ? 1 : 0) - (down.has(negative) ? 1 : 0);
}
