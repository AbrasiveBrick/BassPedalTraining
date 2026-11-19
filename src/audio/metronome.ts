import { getContext } from './context';

export type ClickKind = 'accent' | 'beat' | 'sub';

/**
 * Sample-accurate click player. Each click is a pre-rendered AudioBuffer
 * started at an exact AudioContext time, so no JS timer jitter reaches the audio.
 */
export class ClickPlayer {
  private buffers: Partial<Record<ClickKind, AudioBuffer>> = {};
  private gain: GainNode | null = null;
  private volume = 0.8;
  private active = new Set<AudioBufferSourceNode>();

  setVolume(v: number): void {
    this.volume = v;
    if (this.gain) this.gain.gain.value = v;
  }

  private ensure(): { ctx: AudioContext; gain: GainNode } {
    const ctx = getContext();
    if (!this.gain) {
      this.gain = ctx.createGain();
      this.gain.gain.value = this.volume;
      this.gain.connect(ctx.destination);
      this.buffers.accent = renderClick(ctx, 1760, 0.9, 0.035);
      this.buffers.beat = renderClick(ctx, 1320, 0.6, 0.03);
      this.buffers.sub = renderClick(ctx, 990, 0.22, 0.02);
    }
    return { ctx, gain: this.gain };
  }

  schedule(time: number, kind: ClickKind): void {
    const { ctx, gain } = this.ensure();
    const src = ctx.createBufferSource();
    src.buffer = this.buffers[kind]!;
    src.connect(gain);
    src.start(Math.max(time, ctx.currentTime));
    this.active.add(src);
    src.onended = () => this.active.delete(src);
  }

  /** Stop every click that is already scheduled. */
  stopAll(): void {
    for (const s of this.active) {
      try {
        s.stop();
      } catch {
        /* already stopped */
      }
    }
    this.active.clear();
  }
}

function renderClick(ctx: BaseAudioContext, freq: number, amp: number, dur: number): AudioBuffer {
  const sr = ctx.sampleRate;
  const n = Math.ceil(dur * sr);
  const buf = ctx.createBuffer(1, n, sr);
  const d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const env = Math.exp(-t / (dur / 5));
    // Sine plus a little 2nd harmonic: a woodblock-ish tick that cuts through.
    d[i] = amp * env * (Math.sin(2 * Math.PI * freq * t) * 0.8 + Math.sin(4 * Math.PI * freq * t) * 0.2);
  }
  return buf;
}

/**
 * Lookahead scheduler: a 25 ms JS timer that calls `fill(horizon)` with the
 * latest time worth scheduling now. The callee schedules audio events up to
 * that point on the AudioContext clock.
 */
export class LookaheadTimer {
  private id: number | null = null;
  constructor(
    private fill: (horizon: number) => void,
    private lookahead = 0.15,
    private intervalMs = 25,
  ) {}

  start(): void {
    this.stop();
    const tick = () => this.fill(getContext().currentTime + this.lookahead);
    tick();
    this.id = window.setInterval(tick, this.intervalMs);
  }

  stop(): void {
    if (this.id !== null) window.clearInterval(this.id);
    this.id = null;
  }

  get running(): boolean {
    return this.id !== null;
  }
}
