import { ensureRunning, estimatedRoundTripMs, getContext, hasContext } from '../audio/context';
import { PadInput } from '../audio/input';
import type { ClickPlayer } from '../audio/metronome';
import { runCalibration } from '../engine/calibration';
import type { HitBus } from '../input/hits';
import { saveSettings, type Settings } from '../storage/settings';
import { $ } from './dom';

const GAIN_MIN = 0.1;
const GAIN_MAX = 20;
const sliderToGain = (x: number) => GAIN_MIN * Math.pow(GAIN_MAX / GAIN_MIN, x);
const gainToSlider = (g: number) => Math.log(g / GAIN_MIN) / Math.log(GAIN_MAX / GAIN_MIN);

export interface SetupDeps {
  settings: Settings;
  pad: PadInput;
  bus: HitBus;
  clicks: ClickPlayer;
  onStatus: () => void;
}

export function initSetup(d: SetupDeps): { refreshOffsets: () => void } {
  const { settings, pad, bus, clicks } = d;
  const det = settings.detector;
  const save = () => saveSettings(settings);

  // ---------- device ----------
  const deviceSel = $<HTMLSelectElement>('#device-select');
  const channelSel = $<HTMLSelectElement>('#channel-select');
  const connectBtn = $<HTMLButtonElement>('#connect-btn');
  const disconnectBtn = $<HTMLButtonElement>('#disconnect-btn');
  const connectMsg = $('#connect-msg');
  channelSel.value = String(det.channel);

  async function refreshDevices(): Promise<void> {
    const list = await PadInput.listDevices();
    deviceSel.innerHTML = '<option value="">Default input</option>';
    for (const dev of list) {
      if (dev.deviceId === 'default' || dev.deviceId === '') continue;
      const o = document.createElement('option');
      o.value = dev.deviceId;
      o.textContent = dev.label;
      deviceSel.append(o);
    }
    deviceSel.value = [...deviceSel.options].some((o) => o.value === settings.deviceId) ? settings.deviceId : '';
  }
  void refreshDevices();
  navigator.mediaDevices?.addEventListener?.('devicechange', () => void refreshDevices());

  async function connect(): Promise<void> {
    connectBtn.disabled = true;
    connectMsg.textContent = 'Connecting…';
    try {
      settings.deviceId = deviceSel.value;
      save();
      await pad.connect(settings.deviceId || undefined, det);
      await refreshDevices(); // device labels become visible once permission is granted
      connectMsg.textContent = `Connected: ${pad.deviceLabel || 'audio input'} (${pad.channelCount} ch, ${getContext().sampleRate} Hz). Hit the pad and watch the meter.`;
      disconnectBtn.hidden = false;
    } catch (e) {
      connectMsg.textContent = `Could not open the input: ${(e as Error).message}`;
    } finally {
      connectBtn.disabled = false;
      d.onStatus();
      refreshOffsets();
    }
  }
  connectBtn.addEventListener('click', () => void connect());
  disconnectBtn.addEventListener('click', () => {
    pad.disconnect();
    disconnectBtn.hidden = true;
    connectMsg.textContent = 'Disconnected.';
    d.onStatus();
  });
  deviceSel.addEventListener('change', () => {
    if (pad.connected) void connect();
  });
  channelSel.addEventListener('change', () => {
    det.channel = Number(channelSel.value);
    pad.configure({ channel: det.channel });
    save();
  });

  // ---------- meter & lamp ----------
  const fill = $('#meter-fill');
  const peakEl = $('#meter-peak');
  const thresh = $('#meter-thresh');
  const lamp = $('#hit-lamp');
  const hitCount = $('#hit-count');
  const hitVel = $('#hit-vel');
  // dB scale from -48 dBFS to 0 dBFS: piezo levels span a wide range.
  const toPct = (v: number) => (v <= 0 ? 0 : Math.max(0, Math.min(100, ((20 * Math.log10(v) + 48) / 48) * 100)));
  let peakHold = 0;
  let peakHoldAt = 0;
  let noiseProbe: number[] | null = null;
  pad.onMeter((v) => {
    fill.style.width = `${toPct(v)}%`;
    const now = performance.now();
    if (v > peakHold || now - peakHoldAt > 1200) {
      peakHold = v;
      peakHoldAt = now;
    }
    peakEl.style.left = `${toPct(peakHold)}%`;
    noiseProbe?.push(v);
  });
  let hits = 0;
  let lampTimer = 0;
  bus.on((h) => {
    hits++;
    hitCount.textContent = String(hits);
    hitVel.textContent = h.source === 'pad' ? `${Math.round(h.velocity * 100)}%` : 'key';
    lamp.classList.add('on');
    clearTimeout(lampTimer);
    lampTimer = window.setTimeout(() => lamp.classList.remove('on'), 70);
  });

  // ---------- sliders ----------
  function bindSlider(id: string, get: () => number, set: (v: number) => void, fmt: (v: number) => string): () => void {
    const input = $<HTMLInputElement>(`#${id}`);
    const out = $(`#${id}-out`);
    const sync = () => {
      input.value = String(get());
      out.textContent = fmt(get());
    };
    input.addEventListener('input', () => {
      set(Number(input.value));
      out.textContent = fmt(get());
      save();
    });
    sync();
    return sync;
  }
  bindSlider(
    'gain',
    () => gainToSlider(det.gain),
    (v) => {
      det.gain = sliderToGain(v);
      pad.configure({ gain: det.gain });
    },
    () => `×${det.gain.toFixed(det.gain < 1 ? 2 : 1)}`,
  );
  // The threshold slider works in dBFS. Piezo levels span a wide range.
  const syncThreshold = bindSlider(
    'threshold',
    () => Math.round(20 * Math.log10(det.threshold) * 2) / 2,
    (db) => {
      det.threshold = Math.pow(10, db / 20);
      pad.configure({ threshold: det.threshold });
      thresh.style.left = `${toPct(det.threshold)}%`;
    },
    (db) => `${db.toFixed(1)} dB`,
  );
  thresh.style.left = `${toPct(det.threshold)}%`;
  bindSlider(
    'mask',
    () => det.maskMs,
    (v) => {
      det.maskMs = v;
      pad.configure({ maskMs: v });
    },
    (v) => `${v} ms (max ${Math.round(60000 / v / 4)} BPM 16ths)`,
  );
  bindSlider(
    'retrig',
    () => det.retriggerDecayMs,
    (v) => {
      det.retriggerDecayMs = v;
      pad.configure({ retriggerDecayMs: v });
    },
    (v) => (v === 0 ? 'off' : `${v} ms decay`),
  );
  bindSlider(
    'click-vol',
    () => settings.clickVolume,
    (v) => {
      settings.clickVolume = v;
      clicks.setVolume(v);
    },
    (v) => `${Math.round(v * 100)}%`,
  );

  $('#test-click').addEventListener('click', async () => {
    const ctx = await ensureRunning();
    const t = ctx.currentTime + 0.05;
    clicks.schedule(t, 'accent');
    clicks.schedule(t + 0.4, 'beat');
    clicks.schedule(t + 0.6, 'sub');
    clicks.schedule(t + 0.8, 'beat');
  });

  // ---------- noise check ----------
  const noiseBtn = $<HTMLButtonElement>('#noise-btn');
  const noiseMsg = $('#noise-msg');
  noiseBtn.addEventListener('click', () => {
    if (!pad.connected) {
      noiseMsg.textContent = 'Connect the audio input first.';
      return;
    }
    noiseProbe = [];
    noiseBtn.disabled = true;
    noiseMsg.textContent = 'Rest your foot on the pedal as you normally would. Do not play…';
    window.setTimeout(() => {
      const probe = noiseProbe ?? [];
      noiseProbe = null;
      noiseBtn.disabled = false;
      const peak = probe.length ? Math.max(...probe) : 0;
      // 6 dB above the resting noise, never below the minimum.
      const suggested = Math.min(0.9, Math.max(0.01, peak * 2));
      det.threshold = Math.round(suggested * 1000) / 1000;
      pad.configure({ threshold: det.threshold });
      thresh.style.left = `${toPct(det.threshold)}%`;
      syncThreshold();
      save();
      noiseMsg.textContent = `Resting noise peak: ${peak > 0 ? (20 * Math.log10(peak)).toFixed(1) + ' dB' : 'silence'}. Threshold set to ${(20 * Math.log10(det.threshold)).toFixed(1)} dB. Check that soft strokes still trigger.`;
    }, 3000);
  });

  // ---------- calibration ----------
  const calibBtn = $<HTMLButtonElement>('#calib-btn');
  const calibBeat = $('#calib-beat');
  const calibMsg = $('#calib-msg');
  const offPad = $<HTMLInputElement>('#offset-pad');
  const offKey = $<HTMLInputElement>('#offset-key');
  const offHint = $('#offset-hint');

  function refreshOffsets(): void {
    offPad.value = settings.offsets.pad === null ? '' : String(settings.offsets.pad);
    offKey.value = settings.offsets.key === null ? '' : String(settings.offsets.key);
    offPad.placeholder = hasContext() ? `≈${estimatedRoundTripMs()} (est.)` : 'not set';
    offKey.placeholder = '0';
    const missing = settings.offsets.pad === null;
    offHint.textContent = missing
      ? 'The pad is not calibrated yet, so the app is using the browser latency estimate. Calibrate for accurate timing scores.'
      : 'Positive offset = hits arrive late and get pulled earlier. Re-calibrate when you change the interface or its buffer size.';
  }
  refreshOffsets();
  const parseOff = (v: string) => (v.trim() === '' ? null : Math.round(Number(v)));
  offPad.addEventListener('change', () => {
    settings.offsets.pad = parseOff(offPad.value);
    save();
    refreshOffsets();
  });
  offKey.addEventListener('change', () => {
    settings.offsets.key = parseOff(offKey.value);
    save();
    refreshOffsets();
  });

  calibBtn.addEventListener('click', async () => {
    calibBtn.disabled = true;
    calibMsg.textContent = 'Listen to the 4 count-in clicks, then hit with every click.';
    try {
      const results = await runCalibration(clicks, bus, (beat, total) => {
        calibBeat.textContent = beat <= 0 ? `${beat + 4}…` : `${beat}/${total}`;
      });
      calibBeat.textContent = '';
      if (results.length === 0) {
        calibMsg.textContent = 'Not enough strokes matched the clicks (at least 8 needed). Try again, and check that the meter reacts.';
      } else {
        const parts = results.map((r) => {
          settings.offsets[r.source] = r.offsetMs;
          const label = r.source === 'pad' ? 'Pad' : 'Keyboard';
          const quality = r.spreadMs <= 6 ? 'very consistent' : r.spreadMs <= 15 ? 'consistent' : 'inconsistent: consider repeating';
          return `${label}: ${r.offsetMs} ms (spread ±${r.spreadMs} ms, ${quality}, ${r.count} strokes)`;
        });
        save();
        calibMsg.textContent = parts.join(' · ');
      }
    } finally {
      calibBtn.disabled = false;
      refreshOffsets();
    }
  });

  return { refreshOffsets };
}
