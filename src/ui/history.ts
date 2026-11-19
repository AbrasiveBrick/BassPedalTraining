import { PATTERNS } from '../engine/patterns';
import type { SessionSummary } from '../engine/session';
import { clearHistory, deleteSession, exportHistory, importHistory, loadHistory } from '../storage/history';
import { $, esc, fmtMs, fmtTime } from './dom';

const MODE_LABEL = { fixed: 'Fixed', timed: 'Endurance', speed: 'Speed builder' } as const;

interface Point {
  y: number;
  s: SessionSummary;
}

const fmtDate = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
const fmtDay = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

function niceTicks(min: number, max: number, count = 4): number[] {
  const span = max - min || 1;
  const raw = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) out.push(Math.round(v * 100) / 100);
  return out;
}

/** Single-series line chart with crosshair tooltip (SVG). */
function lineChart(host: HTMLElement, pts: Point[], opts: { min?: number; max?: number; unit: string; tip: (p: Point) => string }): void {
  host.innerHTML = '';
  if (pts.length === 0) {
    host.innerHTML = '<div class="empty">No data yet</div>';
    return;
  }
  const W = host.clientWidth || 400;
  const H = host.clientHeight || 200;
  const m = { l: 40, r: 12, t: 10, b: 24 };
  const ys = pts.map((p) => p.y);
  let lo = opts.min ?? Math.min(...ys);
  let hi = opts.max ?? Math.max(...ys);
  if (opts.min === undefined) lo = Math.floor((lo - 5) / 5) * 5;
  if (opts.max === undefined) hi = Math.ceil((hi + 5) / 5) * 5;
  const xOf = (i: number) => m.l + (pts.length === 1 ? (W - m.l - m.r) / 2 : (i / (pts.length - 1)) * (W - m.l - m.r));
  const yOf = (v: number) => m.t + (1 - (v - lo) / (hi - lo || 1)) * (H - m.t - m.b);

  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('role', 'img');
  let body = '';
  for (const t of niceTicks(lo, hi)) {
    body += `<line x1="${m.l}" x2="${W - m.r}" y1="${yOf(t)}" y2="${yOf(t)}" stroke="var(--grid)" stroke-width="1"/>`;
    body += `<text x="${m.l - 6}" y="${yOf(t) + 3.5}" text-anchor="end" font-size="10" fill="var(--text-2)">${t}</text>`;
  }
  // A few date labels on the x axis
  const labelEvery = Math.max(1, Math.ceil(pts.length / 5));
  pts.forEach((p, i) => {
    if (i % labelEvery === 0 || i === pts.length - 1)
      body += `<text x="${xOf(i)}" y="${H - 6}" text-anchor="middle" font-size="10" fill="var(--text-2)">${esc(fmtDay(p.s.date))}</text>`;
  });
  const path = pts.map((p, i) => `${i ? 'L' : 'M'}${xOf(i).toFixed(1)},${yOf(p.y).toFixed(1)}`).join('');
  body += `<path d="${path}" fill="none" stroke="var(--series-1)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
  if (pts.length <= 60) {
    pts.forEach((p, i) => (body += `<circle cx="${xOf(i)}" cy="${yOf(p.y)}" r="4" fill="var(--series-1)" stroke="var(--surface)" stroke-width="2"/>`));
  }
  body += `<line class="xh" y1="${m.t}" y2="${H - m.b}" stroke="var(--text-2)" stroke-width="1" stroke-dasharray="3 3" visibility="hidden"/>`;
  body += `<circle class="xh-dot" r="5" fill="var(--series-1)" stroke="var(--surface)" stroke-width="2" visibility="hidden"/>`;
  body += `<rect x="${m.l}" y="0" width="${W - m.l - m.r}" height="${H}" fill="transparent" class="hit"/>`;
  svg.innerHTML = body;
  host.append(svg);

  const tip = document.createElement('div');
  tip.className = 'tooltip';
  tip.hidden = true;
  host.append(tip);
  const xh = svg.querySelector<SVGLineElement>('.xh')!;
  const dot = svg.querySelector<SVGCircleElement>('.xh-dot')!;
  const hit = svg.querySelector<SVGRectElement>('.hit')!;
  hit.addEventListener('pointermove', (e) => {
    const rect = svg.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * W;
    let best = 0;
    pts.forEach((_, i) => {
      if (Math.abs(xOf(i) - x) < Math.abs(xOf(best) - x)) best = i;
    });
    const p = pts[best];
    const cx = xOf(best);
    const cy = yOf(p.y);
    xh.setAttribute('x1', String(cx));
    xh.setAttribute('x2', String(cx));
    xh.setAttribute('visibility', 'visible');
    dot.setAttribute('cx', String(cx));
    dot.setAttribute('cy', String(cy));
    dot.setAttribute('visibility', 'visible');
    tip.innerHTML = opts.tip(p);
    tip.hidden = false;
    const px = (cx / W) * rect.width;
    tip.style.left = `${Math.max(70, Math.min(rect.width - 70, px))}px`;
    tip.style.top = `${(cy / H) * rect.height}px`;
  });
  hit.addEventListener('pointerleave', () => {
    tip.hidden = true;
    xh.setAttribute('visibility', 'hidden');
    dot.setAttribute('visibility', 'hidden');
  });
}

export function initHistory(): { render: () => void } {
  const filter = $<HTMLSelectElement>('#hist-filter');
  const tbody = $('#hist-table tbody');
  const empty = $('#hist-empty');
  const chartBpm = $('#chart-bpm');
  const chartAcc = $('#chart-acc');

  for (const p of PATTERNS) {
    const o = document.createElement('option');
    o.value = p.id;
    o.textContent = p.name;
    filter.append(o);
  }
  filter.addEventListener('change', render);

  function render(): void {
    const all = loadHistory();
    const list = filter.value ? all.filter((s) => s.patternId === filter.value) : all;

    const tip = (p: Point, label: string) =>
      `<div>${esc(fmtDate(p.s.date))}</div><div>${esc(p.s.patternName)} · ${p.s.pedalMode}</div><div>${label}: <b>${label === 'Accuracy' ? p.y.toFixed(1) + '%' : p.y + ' BPM'}</b></div>`;
    lineChart(
      chartBpm,
      list.filter((s) => s.maxCleanBpm > 0).map((s) => ({ y: s.maxCleanBpm, s })),
      { unit: 'BPM', tip: (p) => tip(p, 'Max clean BPM') },
    );
    lineChart(
      chartAcc,
      list.map((s) => ({ y: Math.round(s.stats.accuracy * 10) / 10, s })),
      { min: 0, max: 100, unit: '%', tip: (p) => tip(p, 'Accuracy') },
    );

    empty.hidden = list.length > 0;
    tbody.innerHTML = list
      .slice()
      .reverse()
      .map((s) => {
        const bpm = s.startBpm === s.endBpm ? `${s.endBpm}` : `${s.startBpm}→${s.endBpm}`;
        return `<tr>
          <td>${esc(fmtDate(s.date))}</td>
          <td>${esc(s.patternName)}</td>
          <td>${s.pedalMode === 'double' ? 'Double' : 'Single'}</td>
          <td>${MODE_LABEL[s.mode] ?? s.mode}</td>
          <td>${bpm}</td>
          <td>${s.maxCleanBpm || '–'}</td>
          <td>${s.stats.accuracy.toFixed(1)}%</td>
          <td>${fmtMs(s.stats.meanOffsetMs)} ±${s.stats.stdDevMs.toFixed(1)}</td>
          <td>${fmtTime(s.durationSec)}</td>
          <td><button data-del="${esc(s.id)}" title="Delete this session" aria-label="Delete session">✕</button></td>
        </tr>`;
      })
      .join('');
  }

  tbody.addEventListener('click', (e) => {
    const id = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-del]')?.dataset.del;
    if (id && confirm('Delete this session?')) {
      deleteSession(id);
      render();
    }
  });

  $('#export-btn').addEventListener('click', () => {
    const blob = new Blob([exportHistory()], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `bass-pedal-history-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  $<HTMLInputElement>('#import-file').addEventListener('change', async (e) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    try {
      const n = importHistory(await file.text());
      alert(`Imported ${n} session(s).`);
      render();
    } catch (err) {
      alert(`Import failed: ${(err as Error).message}`);
    }
    input.value = '';
  });
  $('#clear-btn').addEventListener('click', () => {
    if (confirm('Delete all saved sessions? This cannot be undone (export first if you want a backup).')) {
      clearHistory();
      render();
    }
  });

  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(render, 150);
  });

  return { render };
}
