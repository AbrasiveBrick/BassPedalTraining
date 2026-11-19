import { audibleTime, hasContext } from '../audio/context';
import { PatternCursor, type ExpectedNote, type Pattern, type PedalMode } from '../engine/patterns';
import type { Grade, HitResult } from '../engine/scoring';

type NoteState = Grade | 'miss' | undefined;

interface BarMark {
  start: number;
  bpm: number;
  beats: number;
}

interface HitMark {
  time: number;
  grade: Grade | 'extra';
  row: number;
}

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';
}

function readPalette() {
  return {
    bg: cssVar('--lane-bg'),
    grid: cssVar('--grid'),
    border: cssVar('--border'),
    text: cssVar('--text-2'),
    note: cssVar('--note'),
    noteL: cssVar('--note-l'),
    accent: cssVar('--accent'),
    perfect: cssVar('--g-perfect'),
    good: cssVar('--g-good'),
    ok: cssVar('--g-ok'),
    miss: cssVar('--g-miss'),
    extra: cssVar('--g-extra'),
  };
}
type Palette = ReturnType<typeof readPalette>;

function fitCanvas(c: HTMLCanvasElement): { w: number; h: number; g: CanvasRenderingContext2D } {
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth;
  const h = c.clientHeight;
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
  }
  const g = c.getContext('2d')!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { w, h, g };
}

function gradeColor(p: Palette, g: Grade | 'miss' | 'extra'): string {
  return p[g];
}

/**
 * Scrolling note lane. Notes move right to left onto the hit line. In double
 * pedal mode the lane has two rows (L above R).
 */
export class Lane {
  private notes: ExpectedNote[] = [];
  private states = new Map<number, NoteState>();
  private hits: HitMark[] = [];
  private bars: BarMark[] = [];
  private pal: Palette = readPalette();
  private raf = 0;
  mode: PedalMode = 'double';
  pastSec = 0.6;
  futureSec = 2.4;
  /** Static preview of the selected exercise (not playing). */
  private previewing = false;
  /** Lane time stays at this value after a run, so its results stay visible. */
  private frozenAt: number | null = null;
  /** Smoothed offset between the audio clock and performance.now(), in seconds. */
  private clockOffset: number | null = null;

  constructor(private canvas: HTMLCanvasElement) {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', () => (this.pal = readPalette()));
    this.loop();
  }

  reset(mode: PedalMode): void {
    this.mode = mode;
    this.notes = [];
    this.states.clear();
    this.hits = [];
    this.bars = [];
    this.previewing = false;
    this.frozenAt = null;
  }

  /** Show the exercise laid out on the lane straight away, before Start. */
  showPreview(pattern: Pattern, mode: PedalMode, bpm: number, beatsPerBar: number): void {
    this.reset(mode);
    this.previewing = true;
    const cursor = new PatternCursor(pattern, mode);
    const barDur = beatsPerBar * (60 / bpm);
    for (let bar = 0, t = 0; t < this.futureSec + 0.5; bar++, t += barDur) {
      this.addBar(cursor.nextBar(t, bpm, beatsPerBar, bar), t, bpm, beatsPerBar);
    }
  }

  /** Stop scrolling and keep the last run on screen. */
  freeze(): void {
    this.frozenAt = this.clockNow();
  }

  /** Remove notes and bars starting at or after `time` (they are being regenerated). */
  removeFrom(time: number): void {
    const keep = this.notes.filter((n) => n.time < time);
    for (const n of this.notes) if (n.time >= time) this.states.delete(n.index);
    this.notes = keep;
    this.bars = this.bars.filter((b) => b.start < time);
  }

  /**
   * Audible time, smoothed. The audio clock advances in buffer-sized steps, so it is
   * tied to performance.now() through a slowly filtered offset. That keeps the
   * scrolling smooth at the display frame rate.
   */
  private clockNow(): number {
    if (!hasContext()) return 0;
    const perf = performance.now() / 1000;
    const off = audibleTime() - perf;
    if (this.clockOffset === null || Math.abs(off - this.clockOffset) > 0.03) this.clockOffset = off;
    else this.clockOffset += (off - this.clockOffset) * 0.05;
    return perf + this.clockOffset;
  }

  addBar(notes: ExpectedNote[], start: number, bpm: number, beats: number): void {
    this.notes.push(...notes);
    this.bars.push({ start, bpm, beats });
  }

  addResult(r: HitResult): void {
    if (r.kind === 'hit') {
      this.states.set(r.note.index, r.grade);
      this.hits.push({ time: r.time, grade: r.grade, row: this.rowOf(r.note) });
    } else {
      this.hits.push({ time: r.time, grade: 'extra', row: -1 });
    }
  }

  addMiss(n: ExpectedNote): void {
    this.states.set(n.index, 'miss');
  }

  private rowOf(n: ExpectedNote): number {
    if (this.mode === 'single') return 0;
    return n.foot === 'L' ? 0 : 1;
  }

  private loop = (): void => {
    this.raf = requestAnimationFrame(this.loop);
    this.draw();
  };

  destroy(): void {
    cancelAnimationFrame(this.raf);
  }

  private draw(): void {
    const { w, h, g } = fitCanvas(this.canvas);
    const p = this.pal;
    // Preview: the first note sits just right of the hit line.
    const now = this.previewing ? -0.3 : this.frozenAt ?? this.clockNow();
    const hitX = Math.max(60, w * 0.16);
    const pps = (w - hitX) / this.futureSec;
    const xOf = (t: number) => hitX + (t - now) * pps;
    const tMin = now - hitX / pps;
    const tMax = now + this.futureSec;

    g.fillStyle = p.bg;
    g.fillRect(0, 0, w, h);

    const rows = this.mode === 'single' ? 1 : 2;
    const top = 40;
    const bottom = h - 18;
    const rowH = (bottom - top) / rows;
    const rowY = (r: number) => top + rowH * (r + 0.5);

    // Beat and bar lines
    for (const b of this.bars) {
      const beat = 60 / b.bpm;
      for (let i = 0; i < b.beats; i++) {
        const t = b.start + i * beat;
        if (t < tMin || t > tMax) continue;
        const x = xOf(t);
        g.strokeStyle = i === 0 ? p.border : p.grid;
        g.lineWidth = i === 0 ? 2 : 1;
        g.beginPath();
        g.moveTo(x, top - 8);
        g.lineTo(x, bottom);
        g.stroke();
        if (i === 0) {
          g.fillStyle = p.text;
          g.font = '11px system-ui, sans-serif';
          g.fillText(`${b.bpm}`, x + 4, top - 12);
        }
      }
    }

    // Row guides
    for (let r = 0; r < rows; r++) {
      const y = rowY(r);
      g.strokeStyle = p.grid;
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(0, y);
      g.lineTo(w, y);
      g.stroke();
    }

    // Hit line
    g.strokeStyle = p.accent;
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(hitX, top - 16);
    g.lineTo(hitX, bottom + 6);
    g.stroke();

    // Notes
    for (const n of this.notes) {
      if (n.time < tMin - 0.1 || n.time > tMax + 0.1) continue;
      const x = xOf(n.time);
      const y = rowY(this.rowOf(n));
      const r = n.accent ? 9 : 7;
      const st = this.states.get(n.index);
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      if (st === 'miss') {
        g.strokeStyle = p.miss;
        g.lineWidth = 2;
        g.stroke();
      } else if (st) {
        g.fillStyle = gradeColor(p, st);
        g.fill();
      } else {
        g.fillStyle = n.foot === 'L' ? p.noteL : p.note;
        g.fill();
      }
    }

    // Played strokes
    for (const hm of this.hits) {
      if (hm.time < tMin || hm.time > tMax) continue;
      const x = xOf(hm.time);
      g.strokeStyle = gradeColor(p, hm.grade);
      g.lineWidth = 2;
      g.beginPath();
      if (hm.row < 0) {
        g.moveTo(x, top - 6);
        g.lineTo(x, bottom);
      } else {
        const y = rowY(hm.row);
        g.moveTo(x, y - rowH * 0.42);
        g.lineTo(x, y + rowH * 0.42);
      }
      g.stroke();
    }

    // Foot labels on top, with a backing so passing notes don't hide them
    if (rows === 2) {
      g.font = '600 12px system-ui, sans-serif';
      for (let r = 0; r < rows; r++) {
        const y = rowY(r);
        g.fillStyle = p.bg;
        g.fillRect(0, y - 10, 22, 20);
        g.fillStyle = p.text;
        g.fillText(r === 0 ? 'L' : 'R', 7, y + 4);
      }
    }

    if (this.previewing) {
      g.fillStyle = p.text;
      g.font = '12px system-ui, sans-serif';
      g.fillText('Preview: press Start (or Enter) to play', hitX + 10, h - 4);
      return;
    }

    // Prune what has scrolled off
    const cut = tMin - 1;
    if (this.notes.length > 0 && this.notes[0].time < cut) {
      const keep = this.notes.findIndex((n) => n.time >= cut);
      const removed = keep < 0 ? this.notes.splice(0) : this.notes.splice(0, keep);
      for (const n of removed) this.states.delete(n.index);
    }
    if (this.hits.length > 0 && this.hits[0].time < cut) this.hits = this.hits.filter((x) => x.time >= cut);
    if (this.bars.length > 8) this.bars = this.bars.filter((b) => b.start + (60 / b.bpm) * b.beats >= cut);
  }
}

/** Dot strip of the latest strokes' timing offsets. */
export class OffsetChart {
  private points: { offset: number; grade: Grade | 'miss' }[] = [];
  private pal: Palette = readPalette();
  readonly size = 40;
  readonly rangeMs = 50;

  constructor(private canvas: HTMLCanvasElement) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      this.pal = readPalette();
      this.draw();
    });
    new ResizeObserver(() => this.draw()).observe(canvas);
  }

  reset(): void {
    this.points = [];
    this.draw();
  }

  push(offsetMs: number | null, grade: Grade | 'miss'): void {
    this.points.push({ offset: offsetMs ?? NaN, grade });
    if (this.points.length > this.size) this.points.shift();
    this.draw();
  }

  draw(): void {
    const { w, h, g } = fitCanvas(this.canvas);
    const p = this.pal;
    g.clearRect(0, 0, w, h);
    const padL = 34;
    const plotW = w - padL - 6;
    const yOf = (ms: number) => h / 2 - (Math.max(-this.rangeMs, Math.min(this.rangeMs, ms)) / this.rangeMs) * (h / 2 - 8);

    // ±10 ms (perfect) and ±25 ms (good) bands
    g.fillStyle = p.grid;
    g.globalAlpha = 0.6;
    g.fillRect(padL, yOf(25), plotW, yOf(-25) - yOf(25));
    g.globalAlpha = 1;
    g.fillRect(padL, yOf(10), plotW, yOf(-10) - yOf(10));

    g.fillStyle = p.text;
    g.font = '10px system-ui, sans-serif';
    g.textAlign = 'right';
    for (const ms of [-50, -25, 0, 25, 50]) g.fillText(`${ms > 0 ? '+' : ''}${ms}`, padL - 6, yOf(ms) + 3);
    g.textAlign = 'left';
    g.strokeStyle = p.border;
    g.beginPath();
    g.moveTo(padL, yOf(0));
    g.lineTo(padL + plotW, yOf(0));
    g.stroke();

    const step = plotW / this.size;
    this.points.forEach((pt, i) => {
      const x = padL + step * (i + 0.5) + (this.size - this.points.length) * step;
      if (pt.grade === 'miss') {
        g.strokeStyle = p.miss;
        g.lineWidth = 2;
        g.beginPath();
        g.moveTo(x - 4, h - 12);
        g.lineTo(x + 4, h - 4);
        g.moveTo(x + 4, h - 12);
        g.lineTo(x - 4, h - 4);
        g.stroke();
        return;
      }
      g.fillStyle = gradeColor(p, pt.grade);
      g.beginPath();
      g.arc(x, yOf(pt.offset), 4, 0, Math.PI * 2);
      g.fill();
    });
  }
}
