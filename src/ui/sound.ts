import { ensureRunning, getContext, hasContext } from '../audio/context';
import { HIT_SOUNDS, hitGain, renderHitSound, type HitSoundType } from '../audio/hitSound';
import type { PadInput } from '../audio/input';
import type { HitBus } from '../input/hits';
import { saveSettings, type Settings } from '../storage/settings';
import { $ } from './dom';

/** Plays the stroke sound for keyboard hits. Pad hits play inside the AudioWorklet. */
class KeySoundPlayer {
  private buffers = new Map<HitSoundType, AudioBuffer>();

  play(type: HitSoundType, gain: number): void {
    if (type === 'off' || !hasContext()) return;
    const ctx = getContext();
    let buf = this.buffers.get(type);
    if (!buf) {
      const data = renderHitSound(type, ctx.sampleRate);
      buf = ctx.createBuffer(1, data.length, ctx.sampleRate);
      buf.getChannelData(0).set(data);
      this.buffers.set(type, buf);
    }
    const src = ctx.createBufferSource();
    const g = ctx.createGain();
    g.gain.value = gain;
    src.buffer = buf;
    src.connect(g).connect(ctx.destination);
    src.start();
  }
}

export function initSound(d: { settings: Settings; pad: PadInput; bus: HitBus }): void {
  const { settings, pad, bus } = d;
  const player = new KeySoundPlayer();
  const typeSel = $<HTMLSelectElement>('#hit-sound');
  const vol = $<HTMLInputElement>('#hit-vol');
  const volOut = $('#hit-vol-out');
  const toggles = [$<HTMLInputElement>('#hit-sound-on'), $<HTMLInputElement>('#hit-sound-on-practice')];

  for (const s of HIT_SOUNDS.filter((x) => x.id !== 'off')) {
    const o = document.createElement('option');
    o.value = s.id;
    o.textContent = s.name;
    typeSel.append(o);
  }

  const effective = (): HitSoundType => (settings.hitSoundOn ? settings.hitSound : 'off');

  function apply(): void {
    typeSel.value = settings.hitSound;
    vol.value = String(settings.hitVolume);
    volOut.textContent = `${Math.round(settings.hitVolume * 100)}%`;
    toggles.forEach((t) => (t.checked = settings.hitSoundOn));
    pad.setSound({ type: effective(), volume: settings.hitVolume });
    saveSettings(settings);
  }

  typeSel.addEventListener('change', () => {
    settings.hitSound = typeSel.value as Settings['hitSound'];
    apply();
  });
  vol.addEventListener('input', () => {
    settings.hitVolume = Number(vol.value);
    apply();
  });
  toggles.forEach((t) =>
    t.addEventListener('change', () => {
      settings.hitSoundOn = t.checked;
      apply();
    }),
  );
  $('#test-hit-sound').addEventListener('click', async () => {
    await ensureRunning();
    player.play(settings.hitSound, hitGain(settings.hitVolume, 1));
  });

  bus.on((h) => {
    if (h.source === 'key') player.play(effective(), hitGain(settings.hitVolume, h.velocity));
  });

  apply();
}
