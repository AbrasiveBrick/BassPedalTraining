import { audibleTime, ensureRunning } from '../audio/context';
import { ClickPlayer, LookaheadTimer } from '../audio/metronome';
import type { Hit, HitBus } from '../input/hits';
import type { PracticeMode } from '../storage/settings';
import { PatternCursor, type ExpectedNote, type Pattern, type PedalMode } from './patterns';

/**
 * Bars are generated (scored notes + lane display) this far ahead of the audible
 * time, so the lane can show notes coming. Their clicks are only scheduled
 * within the short audio lookahead. Until then a bar can still be regenerated
 * when the tempo changes.
 */
export const VISUAL_AHEAD_SEC = 2.6;
import { MAX_WINDOW_MS, Scorer, Stats, type HitResult, type StatsSnapshot } from './scoring';
import { SpeedBuilder, type SpeedBuilderConfig, type StepOutcome } from './speedBuilder';

export interface SessionConfig {
  pattern: Pattern;
  pedalMode: PedalMode;
  mode: PracticeMode;
  bpm: number;
  durationSec: number;
  beatsPerBar: number;
  subdivisionClicks: boolean;
  countIn: boolean;
  speed: SpeedBuilderConfig;
}

export interface SessionSummary {
  id: string;
  date: string;
  patternId: string;
  patternName: string;
  pedalMode: PedalMode;
  mode: PracticeMode;
  startBpm: number;
  endBpm: number;
  maxBpm: number;
  /** Highest tempo passed at the pass-accuracy setting (0 = none). */
  maxCleanBpm: number;
  durationSec: number;
  stats: StatsSnapshot;
}

export interface SessionEvents {
  onNotes?(notes: ExpectedNote[], bar: { start: number; bpm: number; beats: number }): void;
  /** Bars starting at or after `time` were dropped and will be regenerated. */
  onTruncate?(time: number): void;
  onResult?(r: HitResult): void;
  onMiss?(n: ExpectedNote): void;
  onBar?(bar: number, bpm: number, stats: StatsSnapshot): void;
  onStep?(o: StepOutcome): void;
  onEnd?(s: SessionSummary): void;
}

interface Bar {
  index: number;
  start: number;
  end: number;
  bpm: number;
  notes: ExpectedNote[];
  /** Pattern position before this bar, so the bar can be regenerated. */
  cursor: { stepIndex: number; noteIndex: number };
  clicked: boolean;
  stats: Stats;
  done: boolean;
}

export class Session {
  readonly total = new Stats();
  readonly speed: SpeedBuilder | null;
  private scorer = new Scorer();
  private cursor: PatternCursor;
  private timer: LookaheadTimer;
  private bars: Bar[] = [];
  private nextBarStart = 0;
  private barCount = 0;
  private firstNoteTime = 0;
  private endTime = Infinity;
  private startedAt = new Date();
  private unsubscribe: (() => void) | null = null;
  private maxBpm = 0;
  private ended = false;
  running = false;

  constructor(
    readonly config: SessionConfig,
    private clicks: ClickPlayer,
    private hits: HitBus,
    private events: SessionEvents = {},
  ) {
    this.cursor = new PatternCursor(config.pattern, config.pedalMode);
    this.speed = config.mode === 'speed' ? new SpeedBuilder(config.speed) : null;
    this.timer = new LookaheadTimer((h) => this.tick(h));
  }

  get currentBpm(): number {
    return this.speed ? this.speed.bpm : this.config.bpm;
  }

  /** Change the tempo of a fixed or timed run. It applies from the next bar that isn't scheduled yet. */
  setBpm(bpm: number): void {
    if (this.speed || bpm === this.config.bpm) return;
    this.config.bpm = bpm;
    this.truncateFuture();
    if (this.running) this.generateBars();
  }

  /** Seconds of actual playing so far (after the count-in). */
  get elapsed(): number {
    return Math.max(0, audibleTime() - this.firstNoteTime);
  }

  get timeLeft(): number | null {
    return this.config.mode === 'timed' ? Math.max(0, this.endTime - audibleTime()) : null;
  }

  async start(): Promise<void> {
    const ctx = await ensureRunning();
    const t0 = ctx.currentTime + 0.25;
    const bpm = this.currentBpm;
    const beat = 60 / bpm;
    if (this.config.countIn) {
      for (let b = 0; b < this.config.beatsPerBar; b++) this.clicks.schedule(t0 + b * beat, b === 0 ? 'accent' : 'beat');
      this.nextBarStart = t0 + this.config.beatsPerBar * beat;
    } else {
      this.nextBarStart = t0;
    }
    this.firstNoteTime = this.nextBarStart;
    if (this.config.mode === 'timed') this.endTime = this.firstNoteTime + this.config.durationSec;
    this.startedAt = new Date();
    this.unsubscribe = this.hits.on((h) => this.onHit(h));
    this.running = true;
    this.timer.start();
  }

  stop(): SessionSummary {
    if (!this.ended) {
      this.ended = true;
      this.running = false;
      this.timer.stop();
      this.clicks.stopAll();
      this.unsubscribe?.();
      const now = audibleTime();
      // Notes not played yet when Stop was pressed don't count as misses.
      for (const n of this.scorer.finish(now - MAX_WINDOW_MS / 1000)) {
        this.total.addMiss();
        this.barFor(n.time)?.stats.addMiss();
      }
      this.lastSummary = this.summary();
      this.events.onEnd?.(this.lastSummary);
    }
    return this.lastSummary!;
  }

  private lastSummary: SessionSummary | null = null;

  private summary(): SessionSummary {
    const stats = this.total.snapshot();
    const playedBars = this.bars.filter((b) => b.clicked && b.stats.notes > 0);
    const startBpm = playedBars[0]?.bpm ?? this.currentBpm;
    const endBpm = playedBars[playedBars.length - 1]?.bpm ?? this.currentBpm;
    const pass = this.config.speed.passAccuracy;
    const maxCleanBpm = this.speed ? this.speed.maxCleanBpm : stats.notes >= 8 && stats.accuracy >= pass ? this.config.bpm : 0;
    return {
      id: `${this.startedAt.getTime()}-${Math.random().toString(36).slice(2, 7)}`,
      date: this.startedAt.toISOString(),
      patternId: this.config.pattern.id,
      patternName: this.config.pattern.name,
      pedalMode: this.config.pedalMode,
      mode: this.config.mode,
      startBpm,
      endBpm,
      maxBpm: this.maxBpm || this.currentBpm,
      maxCleanBpm,
      durationSec: Math.round(this.endTime === Infinity ? this.elapsed : Math.min(this.elapsed, this.endTime - this.firstNoteTime)),
      stats,
    };
  }

  private tick(horizon: number): void {
    const now = audibleTime();
    const settle = MAX_WINDOW_MS / 1000;

    // 1. Resolve misses and finished bars (this may change the tempo).
    for (const n of this.scorer.expire(now)) {
      this.total.addMiss();
      this.barFor(n.time)?.stats.addMiss();
      this.events.onMiss?.(n);
    }
    for (const b of this.bars) {
      if (b.done || !b.clicked || b.end + settle > now) continue;
      b.done = true;
      this.events.onBar?.(b.index, b.bpm, b.stats.snapshot());
      if (this.speed) {
        const outcome = this.speed.onBarScored(b.bpm, b.stats.weightedCorrect, b.stats.denominator);
        if (outcome.kind === 'pending') continue;
        this.events.onStep?.(outcome);
        if (outcome.kind === 'up' || outcome.kind === 'down') this.truncateFuture();
        if (outcome.kind === 'target') {
          this.truncateFuture();
          this.endTime = Math.min(this.endTime, this.nextBarStart);
        }
      }
    }

    // 2. Generate bars for the lane, then schedule the clicks that fall inside the audio lookahead.
    this.generateBars();
    for (const b of this.bars) if (!b.clicked && b.start < horizon) this.scheduleClicks(b);

    // Drop old finished bars, keeping the latest ones for attribution of late hits.
    const doneCount = this.bars.findIndex((b) => !b.done);
    if (doneCount > 48) this.bars.splice(0, doneCount - 48);

    // 3. Timed or completed session end.
    if (this.endTime !== Infinity && now > this.endTime + settle) this.stop();
  }

  private generateBars(): void {
    const limit = audibleTime() + VISUAL_AHEAD_SEC;
    while (this.nextBarStart < limit && this.nextBarStart < this.endTime - 1e-6) this.generateBar();
  }

  private generateBar(): void {
    const bpm = this.currentBpm;
    const { beatsPerBar } = this.config;
    const start = this.nextBarStart;
    const end = start + beatsPerBar * (60 / bpm);
    const cursor = this.cursor.save();
    const notes = this.cursor.nextBar(start, bpm, beatsPerBar, this.barCount);
    this.scorer.addNotes(notes);
    this.bars.push({ index: this.barCount, start, end, bpm, notes, cursor, clicked: false, stats: new Stats(), done: false });
    this.barCount++;
    this.nextBarStart = end;
    this.events.onNotes?.(notes, { start, bpm, beats: beatsPerBar });
  }

  private scheduleClicks(b: Bar): void {
    const beat = 60 / b.bpm;
    for (let i = 0; i < this.config.beatsPerBar; i++) this.clicks.schedule(b.start + i * beat, i === 0 ? 'accent' : 'beat');
    if (this.config.subdivisionClicks) {
      for (const n of b.notes) {
        const pos = (n.time - b.start) / beat;
        if (Math.abs(pos - Math.round(pos)) > 1e-6) this.clicks.schedule(n.time, 'sub');
      }
    }
    b.clicked = true;
    this.maxBpm = Math.max(this.maxBpm, b.bpm);
  }

  /** Drop every bar whose clicks are not scheduled yet. They are regenerated at the current tempo. */
  private truncateFuture(): void {
    const i = this.bars.findIndex((b) => !b.clicked);
    if (i < 0) return;
    const first = this.bars[i];
    this.cursor.restore(first.cursor);
    this.nextBarStart = first.start;
    this.barCount = first.index;
    this.bars.splice(i);
    this.scorer.removeFrom(first.start - 1e-9);
    this.events.onTruncate?.(first.start);
  }

  private barFor(time: number): Bar | undefined {
    for (let i = this.bars.length - 1; i >= 0; i--) if (this.bars[i].start <= time + 1e-9) return this.bars[i];
    return this.bars[0];
  }

  private onHit(h: Hit): void {
    if (!this.running) return;
    // Ignore hits during the count-in.
    if (h.time < this.firstNoteTime - MAX_WINDOW_MS / 1000) return;
    const r = this.scorer.addHit(h.time, h.velocity);
    this.total.addResult(r);
    const bar = r.kind === 'hit' ? this.bars.find((b) => b.index === r.note.bar) : this.barFor(h.time);
    if (bar && !bar.done) bar.stats.addResult(r);
    this.events.onResult?.(r);
  }
}
