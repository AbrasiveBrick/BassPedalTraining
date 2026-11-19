/**
 * Shared AudioContext plus a timing helper.
 *
 * Time domains used across the app (all in AudioContext seconds):
 *  - Scheduled time: when a click is scheduled with `source.start(t)`.
 *  - Audible time: what the speakers play "now". It equals the scheduled time
 *    of whatever is being heard, so it lags `currentTime` by the output latency.
 *  - Pad hit time: the frame time of the input sample. It is late by input plus
 *    output latency relative to the click the player heard, and latency
 *    calibration removes that.
 */

let ctx: AudioContext | null = null;

export function getContext(): AudioContext {
  if (!ctx) {
    ctx = new AudioContext({ latencyHint: 'interactive' });
  }
  return ctx;
}

export function hasContext(): boolean {
  return ctx !== null;
}

/** Must run inside a user gesture the first time (browser autoplay policy). */
export async function ensureRunning(): Promise<AudioContext> {
  const c = getContext();
  if (c.state !== 'running') await c.resume();
  return c;
}

/** The AudioContext time currently audible at the speakers. */
export function audibleTime(): number {
  const c = getContext();
  if (typeof c.getOutputTimestamp === 'function') {
    const ts = c.getOutputTimestamp();
    if (ts.contextTime !== undefined && ts.performanceTime !== undefined && ts.performanceTime > 0) {
      return ts.contextTime + (performance.now() - ts.performanceTime) / 1000;
    }
  }
  return c.currentTime - (c.outputLatency || 0);
}

/** Convert a DOM event timestamp (performance.now domain) into audible context time. */
export function eventToAudibleTime(eventTimeStamp: number): number {
  const c = getContext();
  if (typeof c.getOutputTimestamp === 'function') {
    const ts = c.getOutputTimestamp();
    if (ts.contextTime !== undefined && ts.performanceTime !== undefined && ts.performanceTime > 0) {
      return ts.contextTime + (eventTimeStamp - ts.performanceTime) / 1000;
    }
  }
  return audibleTime() - (performance.now() - eventTimeStamp) / 1000;
}

/** Rough round-trip latency estimate in ms, used as the default pad offset before calibration. */
export function estimatedRoundTripMs(): number {
  const c = getContext();
  const out = (c.outputLatency || 0) + (c.baseLatency || 0);
  // Input latency is not exposed. Assume it roughly equals the base latency plus one buffer.
  return Math.round((out + (c.baseLatency || 0.005) + 128 / c.sampleRate) * 1000);
}
