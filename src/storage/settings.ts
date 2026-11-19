import { DEFAULT_DETECTOR_SETTINGS, type DetectorSettings } from '../audio/onsetDetector';
import type { HitSoundType } from '../audio/hitSound';
import type { PedalMode } from '../engine/patterns';
import { DEFAULT_SPEED_CONFIG, type SpeedBuilderConfig } from '../engine/speedBuilder';

export type PracticeMode = 'fixed' | 'timed' | 'speed';
export type HitSource = 'pad' | 'key';

export interface Settings {
  detector: DetectorSettings;
  deviceId: string;
  /** Latency compensation in ms per source, subtracted from hit times. null = not calibrated. */
  offsets: Record<HitSource, number | null>;
  clickVolume: number;
  /** Sound played on each stroke. */
  hitSound: Exclude<HitSoundType, 'off'>;
  hitSoundOn: boolean;
  hitVolume: number;
  practice: {
    pedalMode: PedalMode;
    patternId: string;
    mode: PracticeMode;
    bpm: number;
    durationSec: number;
    beatsPerBar: number;
    subdivisionClicks: boolean;
    countIn: boolean;
    speed: SpeedBuilderConfig;
  };
}

const KEY = 'bpt.settings.v1';

export function defaultSettings(): Settings {
  return {
    detector: { ...DEFAULT_DETECTOR_SETTINGS },
    deviceId: '',
    offsets: { pad: null, key: null },
    clickVolume: 0.8,
    hitSound: 'kick',
    hitSoundOn: true,
    hitVolume: 0.8,
    practice: {
      pedalMode: 'double',
      patternId: '16ths',
      mode: 'fixed',
      bpm: 120,
      durationSec: 60,
      beatsPerBar: 4,
      subdivisionClicks: false,
      countIn: true,
      speed: { ...DEFAULT_SPEED_CONFIG },
    },
  };
}

export function loadSettings(): Settings {
  const d = defaultSettings();
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return d;
    const s = JSON.parse(raw) as Partial<Settings>;
    return {
      ...d,
      ...s,
      detector: { ...d.detector, ...s.detector },
      offsets: { ...d.offsets, ...s.offsets },
      practice: { ...d.practice, ...s.practice, speed: { ...d.practice.speed, ...s.practice?.speed } },
    };
  } catch {
    return d;
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable (private mode): settings last for this visit only */
  }
}
