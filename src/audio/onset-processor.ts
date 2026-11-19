/// <reference path="./worklet.d.ts" />
import { hitGain, renderHitSound, VoiceMixer, type HitSoundType } from './hitSound';
import { OnsetDetector, type DetectedHit, type DetectorSettings } from './onsetDetector';

export interface SoundConfig {
  type: HitSoundType;
  volume: number;
}

/** Messages from the main thread. */
export type ProcessorInMessage =
  | { type: 'config'; settings: Partial<DetectorSettings> }
  | { type: 'sound'; sound: SoundConfig };

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
  private sound: SoundConfig = { type: 'kick', volume: 0.8 };
  private mixer = new VoiceMixer(new Float32Array(0));

  constructor(options?: { processorOptions?: { settings?: Partial<DetectorSettings>; sound?: SoundConfig } }) {
    super();
    this.detector = new OnsetDetector(sampleRate, options?.processorOptions?.settings);
    this.setSound(options?.processorOptions?.sound ?? this.sound);
    this.port.onmessage = (e: MessageEvent<ProcessorInMessage>) => {
      if (e.data.type === 'config') this.detector.update(e.data.settings);
      else if (e.data.type === 'sound') this.setSound(e.data.sound);
    };
  }

  private renderedType: HitSoundType | null = null;

  private setSound(sound: SoundConfig): void {
    this.sound = { ...sound };
    if (sound.type !== this.renderedType) {
      this.mixer.setSample(renderHitSound(sound.type, sampleRate));
      this.renderedType = sound.type;
    }
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const input = inputs[0];
    const out = outputs[0]?.[0];

    if (input && input.length > 0) {
      const mono = OnsetDetector.pickChannel(input, this.detector.settings.channel, this.scratch);
      this.hits.length = 0;
      const peak = this.detector.process(mono, currentFrame, this.hits);
      const scanFrames = Math.round((this.detector.settings.scanMs * sampleRate) / 1000);
      for (const h of this.hits) {
        const msg: ProcessorOutMessage = { type: 'hit', time: h.frame / sampleRate, velocity: h.velocity };
        this.port.postMessage(msg);
        // Play the stroke sound straight from the audio thread: no main-thread delay.
        this.mixer.trigger(hitGain(this.sound.volume, h.velocity), h.frame + scanFrames - currentFrame);
      }

      if (peak > this.meterPeak) this.meterPeak = peak;
      this.meterFrames += mono.length;
      if (this.meterFrames >= this.meterInterval) {
        const msg: ProcessorOutMessage = { type: 'meter', peak: this.meterPeak };
        this.port.postMessage(msg);
        this.meterPeak = 0;
        this.meterFrames = 0;
      }
    }

    if (out) this.mixer.mix(out);
    return true;
  }
}

registerProcessor('onset-processor', OnsetProcessor);
