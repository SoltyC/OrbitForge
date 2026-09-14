/**
 * Drains the cloud noise bake across frames.
 *
 * Baking is a quarter of a million multi-octave noise evaluations — several
 * seconds of JavaScript. Run to completion on the main thread that is a frozen
 * tab before the game has drawn anything, so it is spent against a budget
 * instead and the sky simply has no clouds until it finishes.
 *
 * (A compute-shader bake would retire this entirely, and is the obvious
 * upgrade once there is a compute pass to hang it on.)
 */
import { bakeCloudTextures } from '../../clouds/textures.js';
import type { CloudTextures } from '../../clouds/textures.js';
import { TOTAL_BAKE_TEXELS } from '../../clouds/textures.js';

/** Milliseconds of bake work per frame. Roughly a quarter of a 60 Hz frame. */
const BUDGET_MS = 4;

export class CloudBakeRunner {
  private readonly generator: Generator<number, CloudTextures>;
  private result: CloudTextures | null = null;
  private completed = 0;

  constructor(seed: number) {
    this.generator = bakeCloudTextures(seed);
  }

  /** Fraction of the bake done, in [0, 1]. */
  get progress(): number {
    return this.result ? 1 : this.completed / TOTAL_BAKE_TEXELS;
  }

  get isDone(): boolean {
    return this.result !== null;
  }

  /**
   * Work for up to the frame budget. Returns the textures on the frame the
   * bake completes, and null every other frame — so a caller can upload them
   * exactly once by checking for a non-null return.
   */
  step(): CloudTextures | null {
    if (this.result) return null;

    const deadline = performance.now() + BUDGET_MS;

    // The generator yields per z-slice, so the budget is checked between
    // slices rather than mid-work; one slice is the granularity available.
    while (performance.now() < deadline) {
      const next = this.generator.next();

      if (next.done) {
        this.result = next.value;
        return this.result;
      }

      this.completed = next.value;
    }

    return null;
  }
}
