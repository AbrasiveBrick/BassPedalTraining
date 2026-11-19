/// <reference path="./worklet.d.ts" />
import { OnsetDetector, type DetectedHit, type DetectorSettings } from './onsetDetector';

/** Messages from the main thread. */
export type ProcessorInMessage = { type: 'config'; settings: Partial<DetectorSettings> };

/** Messages to the main thread. Times are in AudioContext seconds (input sample time). */
export type ProcessorOutMessage =
  | { type: 'hit'; time: number; velocity: number }
  | { type: 'meter'; peak: number };

class OnsetProcessor extends AudioWorkletProcessor {
  private detector: OnsetDetector;
  private hits: DetectedHit[] = [];
  private scratch = new Float32Array(128);
  private meterPeak = 0;
  private meterFrames = 0;
  private readonly meterInterval = Math.round(sampleRate / 30);

  constructor(options?: { processorOptions?: { settings?: Partial<DetectorSettings> } }) {
    super();
    this.detector = new OnsetDetector(sampleRate, options?.processorOptions?.settings);
    this.port.onmessage = (e: MessageEvent<ProcessorInMessage>) => {
      if (e.data.type === 'config') this.detector.update(e.data.settings);
    };
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const input = inputs[0];
    // Outputs are left silent. The node is connected to the destination only so
    // that the browser keeps pulling audio through it.
    void outputs;
    if (!input || input.length === 0) return true;

    const mono = OnsetDetector.pickChannel(input, this.detector.settings.channel, this.scratch);
    this.hits.length = 0;
    const peak = this.detector.process(mono, currentFrame, this.hits);
    for (const h of this.hits) {
      const msg: ProcessorOutMessage = { type: 'hit', time: h.frame / sampleRate, velocity: h.velocity };
      this.port.postMessage(msg);
    }

    if (peak > this.meterPeak) this.meterPeak = peak;
    this.meterFrames += mono.length;
    if (this.meterFrames >= this.meterInterval) {
      const msg: ProcessorOutMessage = { type: 'meter', peak: this.meterPeak };
      this.port.postMessage(msg);
      this.meterPeak = 0;
      this.meterFrames = 0;
    }
    return true;
  }
}

registerProcessor('onset-processor', OnsetProcessor);
