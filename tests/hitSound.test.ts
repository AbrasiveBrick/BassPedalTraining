import { describe, expect, it } from 'vitest';
import { hitGain, renderHitSound, VoiceMixer } from '../src/audio/hitSound';

describe('hit sound', () => {
  it('renders normalised kicks and nothing when off', () => {
    for (const type of ['kick', 'click'] as const) {
      const s = renderHitSound(type, 48000);
      expect(s.length).toBeGreaterThan(4800);
      const peak = Math.max(...s.map(Math.abs));
      expect(peak).toBeCloseTo(0.9, 2);
      expect(Math.abs(s[s.length - 1])).toBeLessThan(0.01); // faded tail, no pop
    }
    expect(renderHitSound('off', 48000)).toHaveLength(0);
  });

  it('scales gain with stroke velocity', () => {
    expect(hitGain(1, 1)).toBeCloseTo(1);
    expect(hitGain(1, 0.25)).toBeCloseTo(0.6);
    expect(hitGain(0.5, 1)).toBeCloseTo(0.5);
    expect(hitGain(1, 0)).toBeCloseTo(0.2);
  });

  it('mixes voices with a start delay inside the block', () => {
    const m = new VoiceMixer(new Float32Array([1, 0.5, 0.25]));
    m.trigger(1, 2);
    const a = new Float32Array(4);
    m.mix(a);
    expect([...a]).toEqual([0, 0, 1, 0.5]);
    m.trigger(0.5, 0);
    const b = new Float32Array(4);
    m.mix(b);
    expect([...b]).toEqual([0.25 + 0.5, 0.25, 0.125, 0]);
    const c = new Float32Array(4);
    m.mix(c);
    expect([...c]).toEqual([0, 0, 0, 0]);
  });

  it('clips the mix to [-1, 1]', () => {
    const m = new VoiceMixer(new Float32Array([0.9]));
    m.trigger(1);
    m.trigger(1);
    const out = new Float32Array(1);
    m.mix(out);
    expect(out[0]).toBe(1);
  });
});
