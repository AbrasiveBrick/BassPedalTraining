import { describe, expect, it } from 'vitest';
import { computeCalibration, median } from '../src/engine/calibration';
import { getPattern, notesPerSecond, PATTERNS, PatternCursor } from '../src/engine/patterns';
import { gradeFor, Scorer, Stats } from '../src/engine/scoring';
import { SpeedBuilder } from '../src/engine/speedBuilder';

describe('patterns', () => {
  it('every pattern has notes and valid sticking', () => {
    for (const p of PATTERNS) {
      expect(p.steps).toMatch(/^[xX-]+$/);
      expect(p.steps).toMatch(/[xX]/);
      if (p.sticking) expect(p.sticking).toMatch(/^[RL]+$/);
      expect(p.modes.length).toBeGreaterThan(0);
    }
  });

  it('16ths at 120 BPM: 16 notes per bar, 125 ms apart, alternating feet', () => {
    const c = new PatternCursor(getPattern('16ths'), 'double');
    const notes = c.nextBar(10, 120, 4, 0);
    expect(notes).toHaveLength(16);
    expect(notes[1].time - notes[0].time).toBeCloseTo(0.125);
    expect(notes.slice(0, 4).map((n) => n.foot)).toEqual(['R', 'L', 'R', 'L']);
  });

  it('gallop places notes on steps 0, 2, 3 with RRL sticking', () => {
    const c = new PatternCursor(getPattern('gallop'), 'double');
    const notes = c.nextBar(0, 60, 1, 0);
    expect(notes.map((n) => n.time)).toEqual([0, 0.5, 0.75]);
    expect(notes.map((n) => n.foot)).toEqual(['R', 'R', 'L']);
    expect(notes[0].accent).toBe(true);
  });

  it('groups of 3 continue across bar lines', () => {
    const c = new PatternCursor(getPattern('groups-3'), 'double');
    const a = c.nextBar(0, 120, 4, 0);
    const b = c.nextBar(2, 120, 4, 1);
    // 16 steps per bar: accents at 0,3,...,15, so bar 2 starts at global step 16 (16 % 3 = 1, no accent)
    expect(a.filter((n) => n.accent)).toHaveLength(6);
    expect(b[0].accent).toBe(false);
    expect(b[2].accent).toBe(true);
    expect(b[0].index).toBe(16);
  });

  it('keeps continuity through tempo changes', () => {
    const c = new PatternCursor(getPattern('8ths'), 'single');
    const a = c.nextBar(0, 100, 4, 0);
    const b = c.nextBar(2.4, 200, 4, 1);
    expect(a).toHaveLength(8);
    expect(b[1].time - b[0].time).toBeCloseTo(0.15);
    expect(b[0].foot).toBeUndefined();
  });

  it('restores the cursor to regenerate a bar at another tempo', () => {
    const c = new PatternCursor(getPattern('groups-3'), 'double');
    c.nextBar(0, 120, 4, 0);
    const saved = c.save();
    const a = c.nextBar(2, 120, 4, 1);
    c.restore(saved);
    const b = c.nextBar(2, 140, 4, 1);
    expect(b.map((n) => [n.index, n.accent, n.foot])).toEqual(a.map((n) => [n.index, n.accent, n.foot]));
    expect(b[1].time - b[0].time).toBeCloseTo(60 / 140 / 4);
  });

  it('computes notes per second', () => {
    expect(notesPerSecond(getPattern('16ths'), 120)).toBeCloseTo(8);
    expect(notesPerSecond(getPattern('gallop'), 120)).toBeCloseTo(6);
  });
});

describe('scoring', () => {
  const bar = () => new PatternCursor(getPattern('quarters'), 'single').nextBar(1, 60, 4, 0); // notes at 1,2,3,4

  it('grades by absolute offset', () => {
    expect(gradeFor(-9)).toBe('perfect');
    expect(gradeFor(20)).toBe('good');
    expect(gradeFor(-60)).toBe('ok');
  });

  it('matches hits to the nearest note and reports signed offsets', () => {
    const s = new Scorer();
    s.addNotes(bar());
    const r1 = s.addHit(1.005, 1);
    const r2 = s.addHit(1.98, 1);
    expect(r1.kind).toBe('hit');
    expect(r1.kind === 'hit' && r1.note.time).toBe(1);
    expect(r1.kind === 'hit' && r1.offsetMs).toBeCloseTo(5);
    expect(r2.kind === 'hit' && r2.offsetMs).toBeCloseTo(-20);
    expect(r2.kind === 'hit' && r2.grade).toBe('good');
  });

  it('counts a second hit on the same note as extra (double trigger)', () => {
    const s = new Scorer();
    s.addNotes(bar());
    expect(s.addHit(1.0, 1).kind).toBe('hit');
    expect(s.addHit(1.03, 1).kind).toBe('extra');
  });

  it('hits far from any note are extra', () => {
    const s = new Scorer();
    s.addNotes(bar());
    expect(s.addHit(1.5, 1).kind).toBe('extra');
  });

  it('expires unplayed notes as misses only after their window', () => {
    const s = new Scorer();
    s.addNotes(bar());
    expect(s.expire(1.05)).toHaveLength(0);
    expect(s.expire(2.5).map((n) => n.time)).toEqual([1, 2]);
  });

  it('shrinks the window for dense notes (40% of gap)', () => {
    const s = new Scorer();
    s.addNotes(new PatternCursor(getPattern('16ths'), 'double').nextBar(0, 240, 4, 0)); // 62.5 ms apart
    // 30 ms late: outside the 25 ms window of note 0, but also > 25 ms early for note 1, so extra
    expect(s.addHit(0.03, 1).kind).toBe('extra');
    expect(s.addHit(0.0625 + 0.01, 1).kind).toBe('hit');
  });

  it('removeFrom drops future notes so they can be regenerated', () => {
    const s = new Scorer();
    s.addNotes(bar());
    s.removeFrom(3);
    expect(s.addHit(3.0, 1).kind).toBe('extra');
    expect(s.addHit(2.0, 1).kind).toBe('hit');
  });

  it('aggregates stats per foot', () => {
    const s = new Scorer();
    const st = new Stats();
    s.addNotes(new PatternCursor(getPattern('8ths'), 'double').nextBar(0, 60, 2, 0)); // 0, .5, 1, 1.5
    st.addResult(s.addHit(0.01, 0.8)); // R +10
    st.addResult(s.addHit(0.52, 0.4)); // L +20
    st.addResult(s.addHit(0.99, 0.8)); // R -10
    st.addResult(s.addHit(1.25, 0.5)); // extra
    s.expire(3).forEach(() => st.addMiss()); // L miss
    const snap = st.snapshot();
    expect(snap.notes).toBe(4);
    expect(snap.perfect).toBe(2);
    expect(snap.good).toBe(1);
    expect(snap.miss).toBe(1);
    expect(snap.extra).toBe(1);
    expect(snap.accuracy).toBeCloseTo((3 / 5) * 100);
    expect(snap.meanOffsetMs).toBeCloseTo(20 / 3);
    expect(snap.feet.R!.meanOffsetMs).toBeCloseTo(0);
    expect(snap.feet.L!.meanOffsetMs).toBeCloseTo(20);
    expect(snap.feet.L!.meanVelocity).toBeCloseTo(0.4);
  });
});

describe('speed builder', () => {
  const cfg = { startBpm: 100, targetBpm: 108, stepBpm: 4, barsPerStep: 2, passAccuracy: 90, failsBeforeDrop: 2 };

  it('steps up after clean steps and stops at target', () => {
    const sb = new SpeedBuilder(cfg);
    expect(sb.onBarScored(100, 16, 16).kind).toBe('pending');
    expect(sb.onBarScored(100, 15, 16)).toMatchObject({ kind: 'up', from: 100, to: 104 });
    sb.onBarScored(104, 16, 16);
    expect(sb.onBarScored(104, 16, 16)).toMatchObject({ kind: 'up', to: 108 });
    sb.onBarScored(108, 16, 16);
    expect(sb.onBarScored(108, 16, 16)).toMatchObject({ kind: 'target', bpm: 108 });
    expect(sb.maxCleanBpm).toBe(108);
  });

  it('holds on a failed step and drops after two', () => {
    const sb = new SpeedBuilder(cfg);
    sb.onBarScored(100, 16, 16);
    sb.onBarScored(100, 16, 16); // up to 104
    sb.onBarScored(104, 10, 16);
    expect(sb.onBarScored(104, 10, 16)).toMatchObject({ kind: 'hold', bpm: 104 });
    sb.onBarScored(104, 10, 16);
    expect(sb.onBarScored(104, 10, 16)).toMatchObject({ kind: 'down', from: 104, to: 100 });
    expect(sb.maxCleanBpm).toBe(100);
  });

  it('ignores bars played at a stale tempo', () => {
    const sb = new SpeedBuilder(cfg);
    sb.onBarScored(100, 16, 16);
    sb.onBarScored(100, 16, 16); // now 104
    expect(sb.onBarScored(100, 0, 16).kind).toBe('pending');
    expect(sb.bpm).toBe(104);
  });
});

describe('calibration', () => {
  it('median', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
  });

  it('finds the per-source median offset and ignores outliers', () => {
    const clicks = Array.from({ length: 16 }, (_, i) => i * 0.667);
    const hits = clicks.map((c, i) => ({ raw: c + 0.03 + (i % 2 ? 0.002 : -0.002), source: 'pad' as const }));
    hits.push({ raw: 5.0, source: 'pad' }); // stray, not near a click
    const [r] = computeCalibration(clicks, hits);
    expect(r.source).toBe('pad');
    expect(r.offsetMs).toBe(30);
    expect(r.spreadMs).toBeCloseTo(2);
    expect(r.count).toBe(16);
  });

  it('needs at least 8 matched strokes', () => {
    expect(computeCalibration([0, 1, 2], [{ raw: 0.01, source: 'key' }])).toEqual([]);
  });
});
