import { estimatedRoundTripMs, eventToAudibleTime, hasContext } from '../audio/context';
import type { PadInput } from '../audio/input';
import type { HitSource, Settings } from '../storage/settings';

export interface Hit {
  /** Latency-corrected time in the audible-time domain (directly comparable to click times). */
  time: number;
  /** Uncorrected time as reported by the source. */
  raw: number;
  velocity: number;
  source: HitSource;
}

export type HitListener = (hit: Hit) => void;

const KEY_CODES = new Set(['Space', 'KeyF', 'KeyJ']);

/**
 * Merges pad (audio) hits and keyboard hits into one stream and applies
 * each source's latency offset. The keyboard (Space, F, J) works as a stand-in
 * pad for trying the app without hardware.
 */
export class HitBus {
  private listeners = new Set<HitListener>();

  constructor(
    pad: PadInput,
    private settings: () => Settings,
  ) {
    pad.onHit((time, velocity) => this.emit('pad', time, velocity));
    window.addEventListener('keydown', (e) => {
      if (!KEY_CODES.has(e.code) || e.repeat || !hasContext()) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
      e.preventDefault();
      this.emit('key', eventToAudibleTime(e.timeStamp), 0.7);
    });
  }

  on(fn: HitListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Offset in ms used for a source (calibrated value or a default). */
  offsetMs(source: HitSource): number {
    const o = this.settings().offsets[source];
    if (o !== null) return o;
    // Uncalibrated: keyboard times are already in the audible domain. Pad times carry the
    // audio round-trip latency, so start from the browser's estimate.
    return source === 'pad' ? estimatedRoundTripMs() : 0;
  }

  private emit(source: HitSource, raw: number, velocity: number): void {
    const hit: Hit = { time: raw - this.offsetMs(source) / 1000, raw, velocity, source };
    this.listeners.forEach((fn) => fn(hit));
  }
}
