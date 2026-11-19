/**
 * Synthesised kick sounds played on every stroke. Pure, so both the AudioWorklet
 * (pad hits, lowest latency) and the main thread (keyboard hits) can render them.
 */

export type HitSoundType = 'kick' | 'click' | 'off';

export const HIT_SOUNDS: { id: HitSoundType; name: string }[] = [
  { id: 'kick', name: 'Kick (deep)' },
  { id: 'click', name: 'Kick (metal click)' },
  { id: 'off', name: 'Off' },
];

/** Gain for a stroke: volume scaled by the stroke's level, so dynamics are audible. */
export function hitGain(volume: number, velocity: number): number {
  return volume * (0.2 + 0.8 * Math.sqrt(Math.max(0, Math.min(1, velocity))));
}

export function renderHitSound(type: HitSoundType, sampleRate: number): Float32Array {
  if (type === 'off') return new Float32Array(0);
  const p =
    type === 'kick'
      ? { dur: 0.4, fEnd: 45, fSweep: 110, sweepTau: 0.035, decay: 0.13, click: 0.25, clickTau: 0.0025, tick: 0 }
      : { dur: 0.25, fEnd: 58, fSweep: 190, sweepTau: 0.016, decay: 0.075, click: 0.55, clickTau: 0.0015, tick: 0.35 };
  const n = Math.ceil(p.dur * sampleRate);
  const out = new Float32Array(n);
  let phase = 0;
  let seed = 12345;
  const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const f = p.fEnd + p.fSweep * Math.exp(-t / p.sweepTau);
    phase += (2 * Math.PI * f) / sampleRate;
    const attack = Math.min(1, t / 0.001);
    const body = Math.sin(phase) * Math.exp(-t / p.decay) * attack;
    const click = p.click * noise() * Math.exp(-t / p.clickTau);
    const tick = p.tick * Math.sin(2 * Math.PI * 3200 * t) * Math.exp(-t / 0.004);
    // Fade out the last 5 ms to avoid a pop.
    const tail = Math.min(1, (n - i) / (0.005 * sampleRate));
    const v = (body + click + tick) * tail;
    out[i] = v;
    if (Math.abs(v) > peak) peak = Math.abs(v);
  }
  const norm = peak > 0 ? 0.9 / peak : 1;
  for (let i = 0; i < n; i++) out[i] *= norm;
  return out;
}

/** Mixes overlapping one-shot voices of a sample into an output buffer. */
export class VoiceMixer {
  private voices: { pos: number; gain: number }[] = [];
  constructor(
    private sample: Float32Array,
    private maxVoices = 8,
  ) {}

  setSample(sample: Float32Array): void {
    this.sample = sample;
    this.voices = [];
  }

  /** Start a voice `delay` frames into the next mix call. */
  trigger(gain: number, delay = 0): void {
    if (this.sample.length === 0 || gain <= 0) return;
    if (this.voices.length >= this.maxVoices) this.voices.shift();
    this.voices.push({ pos: -Math.max(0, Math.floor(delay)), gain });
  }

  /** Add the active voices into `out` and advance them by out.length frames. */
  mix(out: Float32Array): void {
    const s = this.sample;
    for (const v of this.voices) {
      for (let i = 0; i < out.length; i++) {
        const k = v.pos + i;
        if (k >= 0 && k < s.length) out[i] += s[k] * v.gain;
      }
      v.pos += out.length;
    }
    if (this.voices.length) this.voices = this.voices.filter((v) => v.pos < s.length);
    for (let i = 0; i < out.length; i++) {
      if (out[i] > 1) out[i] = 1;
      else if (out[i] < -1) out[i] = -1;
    }
  }
}
