import type { ClickPlayer } from '../audio/metronome';
import { getPattern, notesPerSecond, patternsFor, type PedalMode } from '../engine/patterns';
import type { HitResult, StatsSnapshot } from '../engine/scoring';
import { Session, type SessionSummary } from '../engine/session';
import type { StepOutcome } from '../engine/speedBuilder';
import type { HitBus } from '../input/hits';
import { addSession } from '../storage/history';
import { saveSettings, type PracticeMode, type Settings } from '../storage/settings';
import { $, $$, fmtMs, fmtTime } from './dom';
import { Lane, OffsetChart } from './lane';

export interface PracticeDeps {
  settings: Settings;
  bus: HitBus;
  clicks: ClickPlayer;
  onSessionSaved: () => void;
  isVisible: () => boolean;
}

export function initPractice(d: PracticeDeps): { stop: () => void } {
  const { settings, bus, clicks } = d;
  const pr = settings.practice;
  const save = () => saveSettings(settings);

  const lane = new Lane($<HTMLCanvasElement>('#lane'));
  const offsetChart = new OffsetChart($<HTMLCanvasElement>('#offset-chart'));
  lane.mode = pr.pedalMode;

  const patternSel = $<HTMLSelectElement>('#pattern-select');
  const patternDesc = $('#pattern-desc');
  const modeSel = $<HTMLSelectElement>('#mode-select');
  const bpmIn = $<HTMLInputElement>('#bpm');
  const startBtn = $<HTMLButtonElement>('#start-btn');
  const banner = $('#banner');

  // ---------- controls ----------
  function renderPatterns(): void {
    const list = patternsFor(pr.pedalMode);
    if (!list.some((p) => p.id === pr.patternId)) pr.patternId = list[0].id;
    patternSel.innerHTML = '';
    for (const p of list) {
      const o = document.createElement('option');
      o.value = p.id;
      o.textContent = p.name;
      patternSel.append(o);
    }
    patternSel.value = pr.patternId;
    describe();
  }
  function describe(): void {
    const p = getPattern(pr.patternId);
    const bpm = pr.mode === 'speed' ? pr.speed.startBpm : pr.bpm;
    const sticking = pr.pedalMode === 'double' ? ` · Sticking: ${p.sticking ?? 'RL'}` : '';
    patternDesc.textContent = `${p.description}${sticking} · ${notesPerSecond(p, bpm).toFixed(1)} notes/s at ${bpm} BPM.`;
  }
  function renderPedal(): void {
    for (const b of $$<HTMLButtonElement>('#pedal-mode button')) b.setAttribute('aria-pressed', String(b.dataset.value === pr.pedalMode));
  }
  function renderModeFields(): void {
    for (const el of $$('[data-for]')) el.hidden = !el.dataset.for!.split(' ').includes(pr.mode);
  }

  $$<HTMLButtonElement>('#pedal-mode button').forEach((b) =>
    b.addEventListener('click', () => {
      if (session?.running) return;
      pr.pedalMode = b.dataset.value as PedalMode;
      lane.reset(pr.pedalMode);
      renderPedal();
      renderPatterns();
      save();
    }),
  );
  patternSel.addEventListener('change', () => {
    pr.patternId = patternSel.value;
    describe();
    save();
  });
  modeSel.value = pr.mode;
  modeSel.addEventListener('change', () => {
    pr.mode = modeSel.value as PracticeMode;
    renderModeFields();
    describe();
    save();
  });

  const clampBpm = (v: number) => Math.max(30, Math.min(320, Math.round(v) || 120));
  bpmIn.value = String(pr.bpm);
  bpmIn.addEventListener('change', () => {
    pr.bpm = clampBpm(Number(bpmIn.value));
    bpmIn.value = String(pr.bpm);
    describe();
    save();
  });
  $$<HTMLButtonElement>('.stepper button').forEach((b) =>
    b.addEventListener('click', () => {
      pr.bpm = clampBpm(pr.bpm + Number(b.dataset.step));
      bpmIn.value = String(pr.bpm);
      describe();
      save();
    }),
  );

  function bindNum(id: string, get: () => number, set: (v: number) => void, min: number, max: number): void {
    const el = $<HTMLInputElement>(`#${id}`);
    el.value = String(get());
    el.addEventListener('change', () => {
      const v = Math.max(min, Math.min(max, Math.round(Number(el.value)) || min));
      set(v);
      el.value = String(v);
      describe();
      save();
    });
  }
  bindNum('duration', () => pr.durationSec, (v) => (pr.durationSec = v), 10, 1800);
  bindNum('sb-start', () => pr.speed.startBpm, (v) => (pr.speed.startBpm = v), 30, 320);
  bindNum('sb-target', () => pr.speed.targetBpm, (v) => (pr.speed.targetBpm = v), 30, 320);
  bindNum('sb-step', () => pr.speed.stepBpm, (v) => (pr.speed.stepBpm = v), 1, 20);
  bindNum('sb-bars', () => pr.speed.barsPerStep, (v) => (pr.speed.barsPerStep = v), 1, 16);
  bindNum('sb-pass', () => pr.speed.passAccuracy, (v) => (pr.speed.passAccuracy = v), 50, 100);

  const subdiv = $<HTMLInputElement>('#subdiv');
  const countIn = $<HTMLInputElement>('#countin');
  subdiv.checked = pr.subdivisionClicks;
  countIn.checked = pr.countIn;
  subdiv.addEventListener('change', () => {
    pr.subdivisionClicks = subdiv.checked;
    save();
  });
  countIn.addEventListener('change', () => {
    pr.countIn = countIn.checked;
    save();
  });

  renderPedal();
  renderPatterns();
  renderModeFields();

  // ---------- live stats ----------
  const el = {
    bpm: $('#st-bpm'),
    nps: $('#st-nps'),
    acc: $('#st-acc'),
    clean: $('#st-clean'),
    mean: $('#st-mean'),
    sd: $('#st-sd'),
    time: $('#st-time'),
    step: $('#st-step'),
    feet: $('#feet'),
    c: {
      perfect: $('#c-perfect'),
      good: $('#c-good'),
      ok: $('#c-ok'),
      miss: $('#c-miss'),
      extra: $('#c-extra'),
    },
  };

  function renderStats(s: StatsSnapshot): void {
    el.acc.textContent = s.notes + s.extra > 0 ? `${s.accuracy.toFixed(1)}%` : '–';
    const matched = s.perfect + s.good + s.ok;
    el.mean.textContent = matched ? fmtMs(s.meanOffsetMs) : '–';
    el.sd.textContent = matched
      ? `${Math.abs(s.meanOffsetMs) < 3 ? 'centred' : s.meanOffsetMs > 0 ? 'dragging (late)' : 'rushing (early)'} · spread ±${s.stdDevMs.toFixed(1)} ms`
      : '';
    el.c.perfect.textContent = String(s.perfect);
    el.c.good.textContent = String(s.good);
    el.c.ok.textContent = String(s.ok);
    el.c.miss.textContent = String(s.miss);
    el.c.extra.textContent = String(s.extra);

    const r = s.feet.R;
    const l = s.feet.L;
    if (pr.pedalMode === 'double' && r && l) {
      el.feet.innerHTML =
        `<span class="h">Foot</span><span class="h">Strokes</span><span class="h">Avg offset</span><span class="h">Avg level</span>` +
        `<span>Right</span><span>${r.count}</span><span>${fmtMs(r.meanOffsetMs)}</span><span>${Math.round(r.meanVelocity * 100)}%</span>` +
        `<span>Left</span><span>${l.count}</span><span>${fmtMs(l.meanOffsetMs)}</span><span>${Math.round(l.meanVelocity * 100)}%</span>`;
    } else {
      el.feet.innerHTML = '';
    }
  }
  function resetStats(): void {
    renderStats({ notes: 0, perfect: 0, good: 0, ok: 0, miss: 0, extra: 0, accuracy: 0, meanOffsetMs: 0, stdDevMs: 0, velocityCv: 0, feet: {} });
    el.step.textContent = '';
    el.clean.textContent = '';
    el.time.textContent = '0:00';
  }

  let bannerTimer = 0;
  function flash(msg: string, ms = 2500): void {
    banner.textContent = msg;
    banner.hidden = false;
    clearTimeout(bannerTimer);
    if (ms > 0) bannerTimer = window.setTimeout(() => (banner.hidden = true), ms);
  }

  function describeStep(o: StepOutcome): string {
    switch (o.kind) {
      case 'up':
        return `✓ ${o.accuracy.toFixed(0)}%: up to ${o.to} BPM`;
      case 'hold':
        return `✗ ${o.accuracy.toFixed(0)}%: staying at ${o.bpm} BPM`;
      case 'down':
        return `✗ ${o.accuracy.toFixed(0)}% twice: back to ${o.to} BPM`;
      case 'target':
        return `★ Target ${o.bpm} BPM reached at ${o.accuracy.toFixed(0)}%!`;
      default:
        return '';
    }
  }

  // ---------- session ----------
  let session: Session | null = null;
  let uiTimer = 0;
  let renderPending = false;

  function scheduleRender(): void {
    if (renderPending || !session) return;
    renderPending = true;
    requestAnimationFrame(() => {
      renderPending = false;
      if (session) renderStats(session.total.snapshot());
    });
  }

  async function start(): Promise<void> {
    if (session?.running) return;
    const pattern = getPattern(pr.patternId);
    lane.reset(pr.pedalMode);
    offsetChart.reset();
    resetStats();
    clicks.setVolume(settings.clickVolume);
    session = new Session(
      { pattern, pedalMode: pr.pedalMode, mode: pr.mode, bpm: pr.bpm, durationSec: pr.durationSec, beatsPerBar: pr.beatsPerBar, subdivisionClicks: pr.subdivisionClicks, countIn: pr.countIn, speed: { ...pr.speed } },
      clicks,
      bus,
      {
        onNotes: (notes, bar) => lane.addBar(notes, bar.start, bar.bpm, bar.beats),
        onResult: (r: HitResult) => {
          lane.addResult(r);
          if (r.kind === 'hit') offsetChart.push(r.offsetMs, r.grade);
          scheduleRender();
        },
        onMiss: (n) => {
          lane.addMiss(n);
          offsetChart.push(null, 'miss');
          scheduleRender();
        },
        onStep: (o) => {
          const msg = describeStep(o);
          el.step.textContent = msg;
          flash(msg);
        },
        onEnd: (s) => finish(s),
      },
    );
    startBtn.textContent = 'Stop';
    flash(pr.countIn ? 'Count-in…' : 'Go!', 1500);
    await session.start();
    uiTimer = window.setInterval(() => {
      if (!session) return;
      const bpm = session.currentBpm;
      el.bpm.textContent = String(bpm);
      el.nps.textContent = `${notesPerSecond(pattern, bpm).toFixed(1)} notes/s`;
      const left = session.timeLeft;
      el.time.textContent = left !== null ? `${fmtTime(left)} left` : fmtTime(session.elapsed);
      if (session.speed) el.clean.textContent = session.speed.maxCleanBpm ? `clean up to ${session.speed.maxCleanBpm} BPM` : '';
    }, 100);
  }

  function finish(s: SessionSummary): void {
    clearInterval(uiTimer);
    startBtn.textContent = 'Start';
    renderStats(s.stats);
    const saved = s.stats.notes >= 8;
    if (saved) {
      addSession(s);
      d.onSessionSaved();
    }
    const clean = s.maxCleanBpm ? ` · clean at ${s.maxCleanBpm} BPM` : '';
    flash(saved ? `Done: ${s.stats.accuracy.toFixed(1)}% over ${s.stats.notes} notes${clean} (saved)` : 'Stopped: too short to save', 6000);
    session = null;
  }

  function stop(): void {
    session?.stop();
  }

  startBtn.addEventListener('click', () => (session?.running ? stop() : void start()));
  window.addEventListener('keydown', (e) => {
    if (!d.isVisible()) return;
    const t = e.target as HTMLElement;
    if (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA') return;
    if (e.key === 'Escape' && session?.running) {
      e.preventDefault();
      stop();
    } else if (e.key === 'Enter' && !session?.running) {
      e.preventDefault();
      void start();
    }
  });

  resetStats();
  return { stop };
}
