import type { ExpectedNote, Foot } from './patterns';

export type Grade = 'perfect' | 'good' | 'ok';

export const GRADE_MS = { perfect: 10, good: 25 } as const;
/** Largest matching window either side of a note, in ms. */
export const MAX_WINDOW_MS = 120;
/** A hit must lie within this fraction of the gap to the neighbouring note. */
export const WINDOW_GAP_FRACTION = 0.4;

export type HitResult =
  | { kind: 'hit'; time: number; velocity: number; note: ExpectedNote; offsetMs: number; grade: Grade }
  | { kind: 'extra'; time: number; velocity: number };

export function gradeFor(offsetMs: number): Grade {
  const a = Math.abs(offsetMs) - 1e-6; // tolerate float noise at the boundaries
  if (a <= GRADE_MS.perfect) return 'perfect';
  if (a <= GRADE_MS.good) return 'good';
  return 'ok';
}

interface Slot {
  note: ExpectedNote;
  matched: boolean;
  resolved: boolean;
}

/**
 * Online matcher between expected notes and played hits.
 * Notes must be added in time order, ahead of being played.
 */
export class Scorer {
  private slots: Slot[] = [];
  /** Slots before this index are all resolved, so searches can skip them. */
  private first = 0;

  addNotes(notes: ExpectedNote[]): void {
    for (const n of notes) this.slots.push({ note: n, matched: false, resolved: false });
  }

  /** Matching half-window (seconds) of the slot at index i. */
  windowAt(i: number): number {
    const t = this.slots[i].note.time;
    let gap = Infinity;
    if (i > 0) gap = Math.min(gap, t - this.slots[i - 1].note.time);
    if (i + 1 < this.slots.length) gap = Math.min(gap, this.slots[i + 1].note.time - t);
    return Math.min(MAX_WINDOW_MS / 1000, gap * WINDOW_GAP_FRACTION);
  }

  addHit(time: number, velocity: number): HitResult {
    let best = -1;
    let bestDist = Infinity;
    for (let i = this.first; i < this.slots.length; i++) {
      const s = this.slots[i];
      const d = time - s.note.time;
      if (d < -MAX_WINDOW_MS / 1000) break; // every later note is too far ahead
      if (s.resolved) continue;
      const ad = Math.abs(d);
      if (ad <= this.windowAt(i) && ad < bestDist) {
        best = i;
        bestDist = ad;
      }
    }
    if (best < 0) return { kind: 'extra', time, velocity };
    const s = this.slots[best];
    s.matched = true;
    s.resolved = true;
    this.advanceFirst();
    const offsetMs = (time - s.note.time) * 1000;
    return { kind: 'hit', time, velocity, note: s.note, offsetMs, grade: gradeFor(offsetMs) };
  }

  /** Resolve as missed every unmatched note whose window closed before `now`. */
  expire(now: number): ExpectedNote[] {
    const missed: ExpectedNote[] = [];
    for (let i = this.first; i < this.slots.length; i++) {
      const s = this.slots[i];
      if (s.note.time > now) break;
      if (s.resolved) continue;
      // The window of the last known note can still shrink when the next bar
      // arrives, so the max window is a safe bound for deciding a miss.
      const w = i + 1 < this.slots.length ? this.windowAt(i) : MAX_WINDOW_MS / 1000;
      if (s.note.time + w < now) {
        s.resolved = true;
        missed.push(s.note);
      }
    }
    this.advanceFirst();
    return missed;
  }

  /** Resolve everything that is left (session stop). Notes after `until` are dropped. */
  finish(until: number): ExpectedNote[] {
    const missed: ExpectedNote[] = [];
    for (let i = this.first; i < this.slots.length; i++) {
      const s = this.slots[i];
      if (!s.resolved && s.note.time <= until) missed.push(s.note);
      s.resolved = true;
    }
    this.first = this.slots.length;
    return missed;
  }

  private advanceFirst(): void {
    while (this.first < this.slots.length && this.slots[this.first].resolved) this.first++;
    // Keep memory bounded on long sessions.
    if (this.first > 4096) {
      this.slots.splice(0, this.first);
      this.first = 0;
    }
  }
}

export interface FootStats {
  count: number;
  meanOffsetMs: number;
  meanVelocity: number;
}

export interface StatsSnapshot {
  notes: number;
  perfect: number;
  good: number;
  ok: number;
  miss: number;
  extra: number;
  /** 0..100 */
  accuracy: number;
  /** Positive = dragging (late), negative = rushing (early). */
  meanOffsetMs: number;
  /** Timing spread (lower = more even). */
  stdDevMs: number;
  /** Velocity coefficient of variation in % (lower = more even dynamics). */
  velocityCv: number;
  feet: Partial<Record<Foot, FootStats>>;
}

/**
 * Aggregates results. Accuracy weights each note (perfect 1, good 1, ok 0.5,
 * miss 0). Extra hits add to the denominator, so flams and double triggers cost points.
 */
export class Stats {
  perfect = 0;
  good = 0;
  ok = 0;
  miss = 0;
  extra = 0;
  private sum = 0;
  private sumSq = 0;
  private vSum = 0;
  private vSumSq = 0;
  private matched = 0;
  private feet: Partial<Record<Foot, { n: number; off: number; vel: number }>> = {};

  addResult(r: HitResult): void {
    if (r.kind === 'extra') {
      this.extra++;
      return;
    }
    this[r.grade]++;
    this.matched++;
    this.sum += r.offsetMs;
    this.sumSq += r.offsetMs * r.offsetMs;
    this.vSum += r.velocity;
    this.vSumSq += r.velocity * r.velocity;
    if (r.note.foot) {
      const f = (this.feet[r.note.foot] ??= { n: 0, off: 0, vel: 0 });
      f.n++;
      f.off += r.offsetMs;
      f.vel += r.velocity;
    }
  }

  addMiss(): void {
    this.miss++;
  }

  merge(o: Stats): void {
    this.perfect += o.perfect;
    this.good += o.good;
    this.ok += o.ok;
    this.miss += o.miss;
    this.extra += o.extra;
    this.sum += o.sum;
    this.sumSq += o.sumSq;
    this.vSum += o.vSum;
    this.vSumSq += o.vSumSq;
    this.matched += o.matched;
    for (const k of Object.keys(o.feet) as Foot[]) {
      const a = (this.feet[k] ??= { n: 0, off: 0, vel: 0 });
      const b = o.feet[k]!;
      a.n += b.n;
      a.off += b.off;
      a.vel += b.vel;
    }
  }

  get notes(): number {
    return this.perfect + this.good + this.ok + this.miss;
  }

  get weightedCorrect(): number {
    return this.perfect + this.good + 0.5 * this.ok;
  }

  get denominator(): number {
    return this.notes + this.extra;
  }

  get accuracy(): number {
    const denom = this.denominator;
    return denom === 0 ? 0 : (this.weightedCorrect / denom) * 100;
  }

  snapshot(): StatsSnapshot {
    const n = this.matched;
    const mean = n ? this.sum / n : 0;
    const variance = n > 1 ? Math.max(0, this.sumSq / n - mean * mean) : 0;
    const vMean = n ? this.vSum / n : 0;
    const vVar = n > 1 ? Math.max(0, this.vSumSq / n - vMean * vMean) : 0;
    const feet: StatsSnapshot['feet'] = {};
    for (const k of Object.keys(this.feet) as Foot[]) {
      const f = this.feet[k]!;
      feet[k] = { count: f.n, meanOffsetMs: f.off / f.n, meanVelocity: f.vel / f.n };
    }
    return {
      notes: this.notes,
      perfect: this.perfect,
      good: this.good,
      ok: this.ok,
      miss: this.miss,
      extra: this.extra,
      accuracy: this.accuracy,
      meanOffsetMs: mean,
      stdDevMs: Math.sqrt(variance),
      velocityCv: vMean > 0 ? (Math.sqrt(vVar) / vMean) * 100 : 0,
      feet,
    };
  }
}
