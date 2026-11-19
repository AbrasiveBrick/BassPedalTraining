/**
 * Pure onset (hit) detector for a piezo trigger signal.
 *
 * Shared by the AudioWorklet (real time) and the unit tests (synthetic buffers).
 *
 * Algorithm per sample:
 *  1. x = |sample| * gain
 *  2. env = the peak level of the last stroke (tracked during its mask), decaying
 *     exponentially with `retriggerDecayMs`.
 *  3. A hit starts when x >= threshold AND x >= retriggerRise * env, outside the
 *     retrigger mask. The mesh head's ringing decays faster than env, so it
 *     cannot retrigger. A real new stroke can, even soon after a loud one,
 *     which keeps fast doubles.
 *  4. The hit time is the crossing sample. The peak over the next `scanMs`
 *     milliseconds becomes the hit velocity.
 */

export interface DetectorSettings {
  /** Linear software gain applied before detection. */
  gain: number;
  /** Absolute threshold on the gained signal, 0..1. */
  threshold: number;
  /** Minimum time between two hits, in ms. */
  maskMs: number;
  /** A new stroke must be this many times louder than the decaying envelope. */
  retriggerRise: number;
  /** Time constant of the envelope decay, in ms (0 = ringing suppression off). */
  retriggerDecayMs: number;
  /** Peak-scan window after the threshold crossing, in ms. */
  scanMs: number;
  /** -1 = use the loudest channel, otherwise the channel index. */
  channel: number;
}

export const DEFAULT_DETECTOR_SETTINGS: DetectorSettings = {
  gain: 1,
  threshold: 0.08,
  maskMs: 30,
  retriggerRise: 1,
  retriggerDecayMs: 40,
  scanMs: 2,
  channel: -1,
};

export interface DetectedHit {
  /** Absolute frame index of the threshold crossing. */
  frame: number;
  /** Peak level of the stroke, 0..1 (clamped). */
  velocity: number;
}

export class OnsetDetector {
  private s: DetectorSettings;
  private sampleRate: number;

  private maskFrames = 0;
  private scanFrames = 0;
  private decayPerFrame = 1;

  /** Frames left in the retrigger mask. */
  private maskLeft = 0;
  /** Frames left in the peak scan, 0 = not scanning. */
  private scanLeft = 0;
  private scanPeak = 0;
  private scanStartFrame = 0;
  /** Decaying peak level of the last stroke. */
  private env = 0;

  constructor(sampleRate: number, settings: Partial<DetectorSettings> = {}) {
    this.sampleRate = sampleRate;
    this.s = { ...DEFAULT_DETECTOR_SETTINGS, ...settings };
    this.recompute();
  }

  get settings(): DetectorSettings {
    return { ...this.s };
  }

  update(settings: Partial<DetectorSettings>): void {
    this.s = { ...this.s, ...settings };
    this.recompute();
  }

  private recompute(): void {
    const fpms = this.sampleRate / 1000;
    this.scanFrames = Math.max(1, Math.round(this.s.scanMs * fpms));
    this.maskFrames = Math.max(this.scanFrames, Math.round(this.s.maskMs * fpms));
    this.decayPerFrame = this.s.retriggerDecayMs > 0 ? Math.exp(-1 / (this.s.retriggerDecayMs * fpms)) : 0;
  }

  /**
   * Process one block of mono samples. `startFrame` is the absolute frame index of
   * samples[0]. Detected hits go to `out`. Returns the block's peak gained level,
   * for metering.
   */
  process(samples: Float32Array, startFrame: number, out: DetectedHit[]): number {
    const { gain, threshold, retriggerRise } = this.s;
    const decay = this.decayPerFrame;
    let blockPeak = 0;
    for (let i = 0; i < samples.length; i++) {
      const x = Math.abs(samples[i]) * gain;
      if (x > blockPeak) blockPeak = x;

      this.env *= decay;

      if (this.maskLeft > 0) {
        this.maskLeft--;
        if (x > this.env) this.env = x;
        if (this.scanLeft > 0) {
          if (x > this.scanPeak) this.scanPeak = x;
          if (--this.scanLeft === 0) this.emit(out);
        }
        continue;
      }

      if (x >= threshold && x >= retriggerRise * this.env) {
        this.scanStartFrame = startFrame + i;
        this.scanPeak = x;
        if (x > this.env) this.env = x;
        this.maskLeft = this.maskFrames - 1;
        this.scanLeft = this.scanFrames - 1;
        if (this.scanLeft === 0) this.emit(out);
      }
    }
    return blockPeak;
  }

  private emit(out: DetectedHit[]): void {
    out.push({ frame: this.scanStartFrame, velocity: Math.min(1, this.scanPeak) });
  }

  /** Select or mix the configured channel into a mono buffer. */
  static pickChannel(channels: Float32Array[], channel: number, scratch: Float32Array): Float32Array {
    if (channels.length === 0) return scratch.subarray(0, 0);
    if (channel >= 0) return channels[Math.min(channel, channels.length - 1)];
    if (channels.length === 1) return channels[0];
    const n = channels[0].length;
    const outBuf = scratch.length >= n ? scratch.subarray(0, n) : new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let m = 0;
      for (let c = 0; c < channels.length; c++) {
        const v = channels[c][i];
        if (Math.abs(v) > Math.abs(m)) m = v;
      }
      outBuf[i] = m;
    }
    return outBuf;
  }
}
