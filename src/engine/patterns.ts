export type PedalMode = 'single' | 'double';
export type Foot = 'R' | 'L';

export interface Pattern {
  id: string;
  name: string;
  description: string;
  modes: PedalMode[];
  /** Grid resolution: steps per quarter-note beat. */
  stepsPerBeat: number;
  /**
   * A looping step sequence that runs independently of bar lines.
   * 'X' = accented note, 'x' = note, '-' = rest.
   */
  steps: string;
  /** Double pedal sticking per note, looping. Defaults to alternating RL. */
  sticking?: string;
}

export const PATTERNS: Pattern[] = [
  // ---- single pedal ----
  { id: 'quarters', name: 'Quarter notes', description: 'Warm-up: one stroke per click. Focus on even volume.', modes: ['single', 'double'], stepsPerBeat: 1, steps: 'x' },
  { id: '8ths', name: '8th notes', description: 'Two even strokes per beat.', modes: ['single', 'double'], stepsPerBeat: 2, steps: 'x' },
  { id: 'triplets', name: '8th-note triplets', description: 'Three strokes per beat. Keep them evenly spaced.', modes: ['single', 'double'], stepsPerBeat: 3, steps: 'x' },
  { id: 'doubles-single', name: 'Doubles (heel-toe / slide)', description: 'Two quick 16ths and an 8th rest: a single-foot double stroke.', modes: ['single'], stepsPerBeat: 4, steps: 'Xx--' },
  { id: 'gallop-single', name: 'Gallop (one foot)', description: '8th + two 16ths. The two 16ths are a single-foot double.', modes: ['single'], stepsPerBeat: 4, steps: 'X-xx' },
  { id: '16ths', name: '16th notes', description: 'Four strokes per beat. Very fast on one foot, the staple on two.', modes: ['single', 'double'], stepsPerBeat: 4, steps: 'x' },

  // ---- double pedal ----
  { id: '16th-triplets', name: '16th-note triplets', description: 'Six strokes per beat, alternating feet.', modes: ['double'], stepsPerBeat: 6, steps: 'x' },
  { id: 'gallop', name: 'Gallop', description: '8th + two 16ths (R-RL), the metal staple.', modes: ['double'], stepsPerBeat: 4, steps: 'X-xx', sticking: 'RRL' },
  { id: 'reverse-gallop', name: 'Reverse gallop', description: 'Two 16ths + 8th (RL-R).', modes: ['double'], stepsPerBeat: 4, steps: 'xxX-', sticking: 'RLR' },
  { id: 'burst', name: '1-beat bursts', description: 'One beat of 16ths landing on the next downbeat, then rest.', modes: ['double'], stepsPerBeat: 4, steps: 'Xxxxx---' },
  { id: '32nd-burst', name: '32nd-note bursts', description: 'One beat of 32nds, one beat rest. Pure speed.', modes: ['double'], stepsPerBeat: 8, steps: 'Xxxxxxxx--------' },
  { id: 'groups-3', name: '16ths in groups of 3', description: 'Continuous 16ths accented every 3 notes, crossing the beat.', modes: ['double'], stepsPerBeat: 4, steps: 'Xxx' },
  { id: 'groups-5', name: '16ths in groups of 5', description: 'Continuous 16ths accented every 5 notes.', modes: ['double'], stepsPerBeat: 4, steps: 'Xxxxx' },
  { id: 'doubles-rrll', name: 'Double strokes RRLL', description: '16ths played RRLL to train each foot doing doubles.', modes: ['double'], stepsPerBeat: 4, steps: 'x', sticking: 'RRLL' },
  { id: 'paradiddle', name: 'Paradiddle', description: '16ths played RLRR LRLL. Builds coordination.', modes: ['double'], stepsPerBeat: 4, steps: 'Xxxx', sticking: 'RLRRLRLL' },
  { id: 'left-lead', name: '16ths, left lead', description: '16ths starting with the weak foot (LRLR).', modes: ['double'], stepsPerBeat: 4, steps: 'x', sticking: 'LR' },
];

export function getPattern(id: string): Pattern {
  return PATTERNS.find((p) => p.id === id) ?? PATTERNS[0];
}

export function patternsFor(mode: PedalMode): Pattern[] {
  return PATTERNS.filter((p) => p.modes.includes(mode));
}

export interface ExpectedNote {
  /** Sequential note number since the session started. */
  index: number;
  /** Audible-domain AudioContext time. */
  time: number;
  accent: boolean;
  /** Undefined in single pedal mode. */
  foot?: Foot;
  bar: number;
  bpm: number;
}

/**
 * Tracks the position in a looping pattern so that bars can be generated one
 * after another, even when the tempo changes between bars.
 */
export class PatternCursor {
  private stepIndex = 0;
  private noteIndex = 0;
  constructor(
    readonly pattern: Pattern,
    readonly mode: PedalMode,
  ) {}

  save(): { stepIndex: number; noteIndex: number } {
    return { stepIndex: this.stepIndex, noteIndex: this.noteIndex };
  }

  restore(state: { stepIndex: number; noteIndex: number }): void {
    this.stepIndex = state.stepIndex;
    this.noteIndex = state.noteIndex;
  }

  /** Notes of one bar starting at `barStart` (seconds), at `bpm`, with `beatsPerBar` beats. */
  nextBar(barStart: number, bpm: number, beatsPerBar: number, bar: number): ExpectedNote[] {
    const p = this.pattern;
    const stepDur = 60 / bpm / p.stepsPerBeat;
    const stepsInBar = p.stepsPerBeat * beatsPerBar;
    const notes: ExpectedNote[] = [];
    for (let s = 0; s < stepsInBar; s++) {
      const ch = p.steps[this.stepIndex % p.steps.length];
      this.stepIndex++;
      if (ch === '-') continue;
      notes.push({
        index: this.noteIndex,
        time: barStart + s * stepDur,
        accent: ch === 'X',
        foot: this.mode === 'double' ? footFor(p, this.noteIndex) : undefined,
        bar,
        bpm,
      });
      this.noteIndex++;
    }
    return notes;
  }
}

function footFor(p: Pattern, noteIndex: number): Foot {
  const st = p.sticking ?? 'RL';
  return st[noteIndex % st.length] as Foot;
}

/** Notes per second at a tempo. Used for the speed readout. */
export function notesPerSecond(p: Pattern, bpm: number): number {
  const notes = [...p.steps].filter((c) => c !== '-').length;
  return (notes / p.steps.length) * p.stepsPerBeat * (bpm / 60);
}
