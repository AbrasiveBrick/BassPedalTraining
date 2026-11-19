import processorUrl from './onset-processor.ts?worker&url';
import type { DetectorSettings } from './onsetDetector';
import type { ProcessorOutMessage, SoundConfig } from './onset-processor';
import { ensureRunning } from './context';

export interface InputDevice {
  deviceId: string;
  label: string;
}

export type PadHitListener = (time: number, velocity: number) => void;
export type MeterListener = (peak: number) => void;

/** Audio interface input: getUserMedia → onset AudioWorklet. */
export class PadInput {
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private node: AudioWorkletNode | null = null;
  private moduleLoaded = false;
  private hitListeners = new Set<PadHitListener>();
  private meterListeners = new Set<MeterListener>();
  channelCount = 0;
  deviceLabel = '';
  private sound: SoundConfig = { type: 'kick', volume: 0.8 };

  get connected(): boolean {
    return this.node !== null;
  }

  onHit(fn: PadHitListener): () => void {
    this.hitListeners.add(fn);
    return () => this.hitListeners.delete(fn);
  }

  onMeter(fn: MeterListener): () => void {
    this.meterListeners.add(fn);
    return () => this.meterListeners.delete(fn);
  }

  static async listDevices(): Promise<InputDevice[]> {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter((d) => d.kind === 'audioinput')
      .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Input ${i + 1}` }));
  }

  async connect(deviceId: string | undefined, settings: DetectorSettings): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('This browser cannot capture audio here. Open the app over https or on localhost.');
    }
    const ctx = await ensureRunning();
    this.disconnect();

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        // Turn off all voice processing: it would destroy the transients.
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: { ideal: 2 },
      },
    });

    if (!this.moduleLoaded) {
      await ctx.audioWorklet.addModule(processorUrl);
      this.moduleLoaded = true;
    }

    const track = this.stream.getAudioTracks()[0];
    this.deviceLabel = track?.label ?? '';
    this.channelCount = track?.getSettings().channelCount ?? 1;

    this.source = ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(ctx, 'onset-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCountMode: 'explicit',
      channelCount: Math.max(1, this.channelCount),
      channelInterpretation: 'discrete',
      processorOptions: { settings, sound: this.sound },
    });
    this.node.port.onmessage = (e: MessageEvent<ProcessorOutMessage>) => {
      const m = e.data;
      if (m.type === 'hit') this.hitListeners.forEach((fn) => fn(m.time, m.velocity));
      else if (m.type === 'meter') this.meterListeners.forEach((fn) => fn(m.peak));
    };
    this.source.connect(this.node);
    // The output carries the stroke sound, mixed in the audio thread for the lowest latency.
    this.node.connect(ctx.destination);
  }

  configure(settings: Partial<DetectorSettings>): void {
    this.node?.port.postMessage({ type: 'config', settings });
  }

  /** Sound played on each pad stroke (rendered inside the AudioWorklet). */
  setSound(sound: SoundConfig): void {
    this.sound = { ...sound };
    this.node?.port.postMessage({ type: 'sound', sound: this.sound });
  }

  disconnect(): void {
    this.node?.disconnect();
    this.source?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.node = null;
    this.source = null;
    this.stream = null;
  }
}
