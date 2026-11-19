export interface SpeedBuilderConfig {
  startBpm: number;
  targetBpm: number;
  /** BPM added after a passed step. */
  stepBpm: number;
  /** Bars played at one tempo before it is judged. */
  barsPerStep: number;
  /** Accuracy (0..100) needed to pass a step. */
  passAccuracy: number;
  /** Failed steps in a row before the tempo slows down (1 = slow down on every failed step). */
  slowAfterFails: number;
}

/** The speed builder never slows below this tempo. */
export const MIN_BPM = 30;
/** A step this many points below the pass accuracy slows down by two steps instead of one. */
export const BIG_MISS_MARGIN = 25;

export const DEFAULT_SPEED_CONFIG: SpeedBuilderConfig = {
  startBpm: 100,
  targetBpm: 180,
  stepBpm: 4,
  barsPerStep: 4,
  passAccuracy: 90,
  slowAfterFails: 1,
};

export type StepOutcome =
  | { kind: 'pending' }
  | { kind: 'up'; from: number; to: number; accuracy: number }
  | { kind: 'hold'; bpm: number; accuracy: number }
  | { kind: 'down'; from: number; to: number; accuracy: number }
  | { kind: 'target'; bpm: number; accuracy: number };

/**
 * Raises the tempo while the player stays clean and slows down when they fail.
 * A failed step drops the tempo by one step, or by two when the accuracy was far
 * below the pass mark. It can go below the start tempo, down to MIN_BPM.
 * Bars are reported once they are
 * fully scored. A bar played at an older tempo (one still in flight when the
 * tempo changed) is ignored.
 */
export class SpeedBuilder {
  bpm: number;
  maxCleanBpm = 0;
  reachedTarget = false;
  private bars = 0;
  private weighted = 0;
  private denom = 0;
  private fails = 0;

  constructor(readonly config: SpeedBuilderConfig) {
    this.bpm = config.startBpm;
  }

  /** `score` and `total` are the bar's weighted-correct and denominator (see Stats.accuracy). */
  onBarScored(barBpm: number, score: number, total: number): StepOutcome {
    if (barBpm !== this.bpm || this.reachedTarget) return { kind: 'pending' };
    this.bars++;
    this.weighted += score;
    this.denom += total;
    if (this.bars < this.config.barsPerStep) return { kind: 'pending' };

    const accuracy = this.denom > 0 ? (this.weighted / this.denom) * 100 : 0;
    this.bars = 0;
    this.weighted = 0;
    this.denom = 0;
    const c = this.config;

    if (accuracy >= c.passAccuracy) {
      this.fails = 0;
      this.maxCleanBpm = Math.max(this.maxCleanBpm, this.bpm);
      if (this.bpm >= c.targetBpm) {
        this.reachedTarget = true;
        return { kind: 'target', bpm: this.bpm, accuracy };
      }
      const from = this.bpm;
      this.bpm = Math.min(c.targetBpm, this.bpm + c.stepBpm);
      return { kind: 'up', from, to: this.bpm, accuracy };
    }

    this.fails++;
    if (this.fails >= Math.max(1, c.slowAfterFails) && this.bpm > MIN_BPM) {
      this.fails = 0;
      const from = this.bpm;
      const steps = accuracy < c.passAccuracy - BIG_MISS_MARGIN ? 2 : 1;
      this.bpm = Math.max(MIN_BPM, this.bpm - steps * c.stepBpm);
      return { kind: 'down', from, to: this.bpm, accuracy };
    }
    return { kind: 'hold', bpm: this.bpm, accuracy };
  }
}
