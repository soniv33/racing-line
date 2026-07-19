// Personal bests, persisted per corner in localStorage.

// v2: corner geometry changed (shorter approaches, wider tracks) — bests
// stored against the old layouts are not comparable and are left behind.
const key = (cornerId) => `racing-line/best/v2/${cornerId}`;

export function loadBest(cornerId) {
  try {
    const raw = localStorage.getItem(key(cornerId));
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.line) || typeof data.time !== 'number') return null;
    return {
      time: data.time,
      line: data.line.map(([x, y]) => ({ x, y })),
    };
  } catch {
    return null;
  }
}

export function saveBest(cornerId, time, line) {
  try {
    localStorage.setItem(
      key(cornerId),
      JSON.stringify({ time, line: line.map((p) => [round2(p.x), round2(p.y)]) })
    );
  } catch {
    // Storage unavailable (private mode, quota) — best simply won't persist.
  }
}

export function clearBest(cornerId) {
  try {
    localStorage.removeItem(key(cornerId));
  } catch {
    // ignore
  }
}

const round2 = (v) => Math.round(v * 100) / 100;
