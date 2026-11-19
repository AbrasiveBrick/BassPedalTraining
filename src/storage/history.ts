import type { SessionSummary } from '../engine/session';

const KEY = 'bpt.history.v1';

export function loadHistory(): SessionSummary[] {
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as SessionSummary[]) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function persist(list: SessionSummary[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* storage full or unavailable */
  }
}

export function addSession(s: SessionSummary): void {
  const list = loadHistory();
  list.push(s);
  persist(list);
}

export function deleteSession(id: string): void {
  persist(loadHistory().filter((s) => s.id !== id));
}

export function clearHistory(): void {
  persist([]);
}

export function exportHistory(): string {
  return JSON.stringify({ app: 'bass-pedal-training', version: 1, sessions: loadHistory() }, null, 2);
}

/** Merge imported sessions by id. Returns how many were added. */
export function importHistory(json: string): number {
  const data = JSON.parse(json) as { sessions?: SessionSummary[] } | SessionSummary[];
  const incoming = Array.isArray(data) ? data : data.sessions ?? [];
  const list = loadHistory();
  const ids = new Set(list.map((s) => s.id));
  let added = 0;
  for (const s of incoming) {
    if (s && typeof s.id === 'string' && typeof s.date === 'string' && s.stats && !ids.has(s.id)) {
      list.push(s);
      ids.add(s.id);
      added++;
    }
  }
  list.sort((a, b) => a.date.localeCompare(b.date));
  persist(list);
  return added;
}
