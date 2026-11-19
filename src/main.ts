import './style.css';
import { ensureRunning } from './audio/context';
import { PadInput } from './audio/input';
import { ClickPlayer } from './audio/metronome';
import { HitBus } from './input/hits';
import { loadSettings } from './storage/settings';
import { $, $$ } from './ui/dom';
import { initHistory } from './ui/history';
import { initPractice } from './ui/practice';
import { initSetup } from './ui/setup';

const settings = loadSettings();
const pad = new PadInput();
const clicks = new ClickPlayer();
clicks.setVolume(settings.clickVolume);
const bus = new HitBus(pad, () => settings);

// Browsers only start audio after a user gesture, so resume on the first interaction.
const unlock = () => void ensureRunning();
window.addEventListener('pointerdown', unlock, { once: true });
window.addEventListener('keydown', unlock, { once: true });

const status = $('#input-status');
function renderStatus(): void {
  status.textContent = pad.connected ? `Pad: ${pad.deviceLabel || 'audio input'}` : 'Keyboard only (Space / F / J)';
  status.classList.toggle('live', pad.connected);
}
renderStatus();

let view = 'setup';
const history = initHistory();
const setup = initSetup({ settings, pad, bus, clicks, onStatus: renderStatus });
const practice = initPractice({ settings, bus, clicks, onSessionSaved: () => history.render(), isVisible: () => view === 'practice' });

function show(v: string): void {
  if (v !== 'practice') practice.stop();
  view = v;
  for (const b of $$<HTMLButtonElement>('.tabs button')) b.setAttribute('aria-selected', String(b.dataset.view === v));
  for (const s of $$('.view')) s.toggleAttribute('data-active', s.id === `view-${v}`);
  if (v === 'history') history.render();
  if (v === 'setup') setup.refreshOffsets();
  try {
    localStorage.setItem('bpt.view', v);
  } catch {
    /* ignore */
  }
}
$$<HTMLButtonElement>('.tabs button').forEach((b) => b.addEventListener('click', () => show(b.dataset.view!)));
let initial = 'setup';
try {
  initial = localStorage.getItem('bpt.view') ?? 'setup';
} catch {
  /* ignore */
}
show(['setup', 'practice', 'history'].includes(initial) ? initial : 'setup');
