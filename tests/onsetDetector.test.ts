import { describe, expect, it } from 'vitest';
import { OnsetDetector, type DetectedHit } from '../src/audio/onsetDetector';

const SR = 48000;

/** Decaying 180 Hz "piezo" burst starting at each onset (seconds). */
function signal(durSec: number, onsets: { t: number; amp: number }[], noise = 0, seed = 1): Float32Array {
  const n = Math.round(durSec * SR);
  const buf = new Float32Array(n);
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let i = 0; i < n; i++) buf[i] = noise * rnd();
  for (const { t, amp } of onsets) {
    const start = Math.round(t * SR);
    for (let i = 0; i < SR * 0.15 && start + i < n; i++) {
      const tt = i / SR;
      // fast attack (0.3 ms), ringing decay
      const env = Math.min(1, tt / 0.0003) * Math.exp(-tt / 0.02);
      buf[start + i] += amp * env * Math.sin(2 * Math.PI * 180 * tt + Math.PI / 2);
    }
  }
  return buf;
}

function run(det: OnsetDetector, buf: Float32Array, block = 128): DetectedHit[] {
  const out: DetectedHit[] = [];
  for (let i = 0; i < buf.length; i += block) det.process(buf.subarray(i, i + block), i, out);
  return out;
}

describe('OnsetDetector', () => {
  it('detects each stroke exactly once despite ringing', () => {
    const onsets = [0.1, 0.4, 0.7, 1.0].map((t) => ({ t, amp: 0.8 }));
    const hits = run(new OnsetDetector(SR), signal(1.3, onsets));
    expect(hits).toHaveLength(4);
    hits.forEach((h, i) => {
      // timestamp within 1 ms of the true onset
      expect(Math.abs(h.frame / SR - onsets[i].t)).toBeLessThan(0.001);
      expect(h.velocity).toBeGreaterThan(0.5);
    });
  });

  it('separates fast doubles (16ths at 240 BPM, 62.5 ms apart)', () => {
    const onsets = Array.from({ length: 8 }, (_, i) => ({ t: 0.05 + i * 0.0625, amp: 0.6 }));
    const hits = run(new OnsetDetector(SR, { maskMs: 30 }), signal(0.7, onsets));
    expect(hits).toHaveLength(8);
  });

  it('catches a soft stroke right after a loud one when suppression is moderate', () => {
    const onsets = [
      { t: 0.1, amp: 0.9 },
      { t: 0.17, amp: 0.4 },
    ];
    const hits = run(new OnsetDetector(SR), signal(0.4, onsets));
    expect(hits).toHaveLength(2);
  });

  it('ignores low-level noise below the threshold (resting foot)', () => {
    const hits = run(new OnsetDetector(SR, { threshold: 0.05 }), signal(1, [], 0.02));
    expect(hits).toHaveLength(0);
  });

  it('applies gain before thresholding', () => {
    const quiet = signal(0.3, [{ t: 0.1, amp: 0.03 }]);
    expect(run(new OnsetDetector(SR, { threshold: 0.08, gain: 1 }), quiet)).toHaveLength(0);
    expect(run(new OnsetDetector(SR, { threshold: 0.08, gain: 5 }), quiet)).toHaveLength(1);
  });

  it('is independent of block size', () => {
    const buf = signal(1, [0.1, 0.35, 0.6].map((t) => ({ t, amp: 0.7 })));
    const a = run(new OnsetDetector(SR), buf, 128).map((h) => h.frame);
    const b = run(new OnsetDetector(SR), buf, 37).map((h) => h.frame);
    expect(b).toEqual(a);
  });

  it('picks the loudest channel in auto mode', () => {
    const a = new Float32Array([0.1, -0.5, 0.2]);
    const b = new Float32Array([-0.3, 0.2, 0.25]);
    const m = OnsetDetector.pickChannel([a, b], -1, new Float32Array(3));
    expect([...m]).toEqual([expect.closeTo(-0.3), expect.closeTo(-0.5), expect.closeTo(0.25)]);
    expect(OnsetDetector.pickChannel([a, b], 1, new Float32Array(3))).toBe(b);
  });
});
