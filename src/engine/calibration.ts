import { ensureRunning } from '../audio/context';
import type { ClickPlayer } from '../audio/metronome';
import type { Hit, HitBus } from '../input/hits';
import type { HitSource } from '../storage/settings';

export interface CalibrationResult {
  source: HitSource;
  offsetMs: number;
  /** Median absolute deviation of the offsets, ms. */
  spreadMs: number;
  count: number;
}

export const CALIBRATION_BPM = 90;
export const CALIBRATION_COUNT_IN = 4;
export const CALIBRATION_BEATS = 16;
const MATCH_WINDOW = 0.25;

export function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Per source: match each raw hit to its nearest click, then take the median offset.
 * Pure, so it can be tested.
 */
export function computeCalibration(clicks: number[], hits: { raw: number; source: HitSource }[], minHits = 8): CalibrationResult[] {
  const out: CalibrationResult[] = [];
  for (const source of ['pad', 'key'] as HitSource[]) {
    const offs: number[] = [];
    const used = new Set<number>();
    for (const h of hits.filter((x) => x.source === source)) {
      let best = -1;
      let bd = Infinity;
      clicks.forEach((c, i) => {
        const d = Math.abs(h.raw - c);
        if (d < bd && d <= MATCH_WINDOW && !used.has(i)) {
          bd = d;
          best = i;
        }
      });
      if (best >= 0) {
        used.add(best);
        offs.push((h.raw - clicks[best]) * 1000);
      }
    }
    if (offs.length < minHits) continue;
    const med = median(offs);
    out.push({ source, offsetMs: Math.round(med), spreadMs: Math.round(median(offs.map((o) => Math.abs(o - med))) * 10) / 10, count: offs.length });
  }
  return out;
}

/** Plays a count-in plus 16 quarter-note clicks. The player hits with each click. */
export async function runCalibration(
  clicks: ClickPlayer,
  bus: HitBus,
  onBeat: (beat: number, total: number) => void,
): Promise<CalibrationResult[]> {
  const ctx = await ensureRunning();
  const beat = 60 / CALIBRATION_BPM;
  const t0 = ctx.currentTime + 0.3;
  const times: number[] = [];
  const total = CALIBRATION_COUNT_IN + CALIBRATION_BEATS;
  for (let i = 0; i < total; i++) {
    const t = t0 + i * beat;
    clicks.schedule(t, i % 4 === 0 ? 'accent' : 'beat');
    if (i >= CALIBRATION_COUNT_IN) times.push(t);
  }
  const hits: Hit[] = [];
  const off = bus.on((h) => hits.push(h));
  const timers: number[] = [];
  for (let i = 0; i < total; i++) {
    timers.push(window.setTimeout(() => onBeat(i - CALIBRATION_COUNT_IN + 1, CALIBRATION_BEATS), (t0 + i * beat - ctx.currentTime) * 1000));
  }
  await new Promise((r) => window.setTimeout(r, (t0 + total * beat + 0.4 - ctx.currentTime) * 1000));
  off();
  timers.forEach(clearTimeout);
  return computeCalibration(times, hits);
}
