import { CORNERS, cornerCenterline } from './corners.js';
import {
  closestOnPolylineRange,
  dedupe,
  fairPolyline,
  distToPolyline,
  dot,
  lerpPt,
  move,
  polylineLength,
  resample,
  smoothPoints,
  sub,
  unit,
} from './geometry.js';
import { CAR, EDGE_MARGIN, prepareLine, simulate, stateAtTime } from './physics.js';
import { solveOptimalLine } from './optimizer.js';
import { clearBest, loadBest, saveBest } from './storage.js';
import {
  buildTrackGeometry,
  drawCar,
  drawPlainLine,
  drawSpeedLine,
  drawStroke,
  drawTrack,
  makeView,
} from './render.js';
import { drawTelemetry } from './telemetry.js';

const GATE_SNAP = 8; // meters of leeway for starting/ending near the gates

const COLORS = {
  user: '#38bdf8',
  ghost: 'rgba(226, 232, 240, 0.55)',
  optimal: '#f5c542',
};

const canvas = document.getElementById('track');
const telemetryCanvas = document.getElementById('telemetry');
const ctx = canvas.getContext('2d');
const telemetryCtx = telemetryCanvas.getContext('2d');

const ui = {
  cornerList: document.getElementById('corner-list'),
  blurb: document.getElementById('corner-blurb'),
  status: document.getElementById('status'),
  yourTime: document.getElementById('your-time'),
  bestTime: document.getElementById('best-time'),
  optimalTime: document.getElementById('optimal-time'),
  delta: document.getElementById('delta'),
  clearBtn: document.getElementById('clear-btn'),
  replayBtn: document.getElementById('replay-btn'),
  optimalBtn: document.getElementById('optimal-btn'),
  resetBtn: document.getElementById('reset-btn'),
};

const state = {
  corner: null,
  track: null, // {center, halfWidth, leftEdge, rightEdge}
  centerFine: null, // finely resampled centerline for distance checks
  centerLength: 0,
  gates: null, // {entryP, entryT, exitP, exitT}
  view: null,
  stroke: null, // in-progress raw stroke (meters)
  strokeOffMask: null,
  strokeType: 'mouse', // pointerType of the active stroke
  drawing: false,
  attempt: null, // {sim} valid attempt
  best: null, // {time, sim}
  optimal: null, // {sim} lazily computed per corner, cached below
  optimalCache: new Map(),
  showOptimal: false,
  replayStart: null,
};

// ---------------------------------------------------------------------------
// Setup

function setupCanvas(cnv, cssWidth, cssHeight) {
  const dpr = window.devicePixelRatio || 1;
  cnv.width = cssWidth * dpr;
  cnv.height = cssHeight * dpr;
  cnv.style.width = `${cssWidth}px`;
  cnv.style.height = `${cssHeight}px`;
  cnv.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
  return { width: cssWidth, height: cssHeight };
}

const stageEl = document.getElementById('stage');
const trackSize = { width: 940, height: 560 };
const telemetrySize = { width: 940, height: 170 };

// Size both canvases to the current layout. On small (phone) screens the
// track canvas goes tall so a 90°-rotated corner fills a portrait display.
function isCompact() {
  return window.matchMedia('(max-width: 700px)').matches;
}

function viewPad() {
  return isCompact() ? 16 : 34;
}

function layoutCanvases() {
  const compact = isCompact();
  const stageWidth = Math.max(280, Math.min(stageEl.clientWidth || 940, 940));
  trackSize.width = stageWidth;
  trackSize.height = compact
    ? Math.round(Math.min(Math.max(window.innerHeight * 0.66, 380), stageWidth * 1.8))
    : 560;
  telemetrySize.width = stageWidth;
  telemetrySize.height = compact ? 130 : 170;
  setupCanvas(canvas, trackSize.width, trackSize.height);
  setupCanvas(telemetryCanvas, telemetrySize.width, telemetrySize.height);
  if (state.track) {
    state.view = makeView(
      trackSize.width,
      trackSize.height,
      [...state.track.leftEdge, ...state.track.rightEdge],
      viewPad()
    );
    updateResults();
  }
}

let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(layoutCanvases, 120);
});

function selectCorner(corner) {
  state.corner = corner;
  const center = cornerCenterline(corner);
  state.track = buildTrackGeometry(center, corner.width);
  state.centerFine = resample(center, 1);
  state.centerLength = polylineLength(center);
  state.view = makeView(
    trackSize.width,
    trackSize.height,
    [...state.track.leftEdge, ...state.track.rightEdge],
    viewPad()
  );

  const entryT = unit(sub(center[1], center[0]));
  const last = center.length - 1;
  const exitT = unit(sub(center[last], center[last - 1]));
  state.gates = { entryP: center[0], entryT, exitP: center[last], exitT };

  state.stroke = null;
  state.strokeOffMask = null;
  state.drawing = false;
  state.attempt = null;
  state.showOptimal = false;
  state.optimal = state.optimalCache.get(corner.id) ?? null;
  state.replayStart = null;

  const stored = loadBest(corner.id);
  state.best = stored ? { time: stored.time, sim: simulate(prepareLine(stored.line)) } : null;
  if (state.best) state.replayStart = performance.now();

  ui.blurb.textContent = corner.blurb;
  setStatus('Draw your line from the green gate to the chequered flag.');
  updateCornerButtons();
  updateOptimalButton();
  updateResults();
}

function buildCornerButtons() {
  for (const corner of CORNERS) {
    const btn = document.createElement('button');
    btn.textContent = corner.name;
    btn.dataset.cornerId = corner.id;
    btn.addEventListener('click', () => selectCorner(corner));
    ui.cornerList.appendChild(btn);
  }
}

function updateCornerButtons() {
  for (const btn of ui.cornerList.querySelectorAll('button')) {
    btn.classList.toggle('active', btn.dataset.cornerId === state.corner.id);
  }
}

// ---------------------------------------------------------------------------
// Drawing input

function pointerToMeters(e) {
  const rect = canvas.getBoundingClientRect();
  const px = {
    x: ((e.clientX - rect.left) / rect.width) * trackSize.width,
    y: ((e.clientY - rect.top) / rect.height) * trackSize.height,
  };
  return state.view.toM(px);
}

function trackLimit() {
  return state.track.halfWidth - EDGE_MARGIN;
}

// Inside the drivable corridor (used only for the live drawing hint).
function isOnTrack(p) {
  return distToPolyline(p, state.centerFine) <= trackLimit();
}

// Project a stroke onto the drivable corridor. The cursor into the
// centerline only moves forward, so a shortcut gesture wraps around the
// corner along the inside edge instead of jumping straight across the
// infield (which smoothing would turn into a cheat-fast line).
function clampToTrack(pts) {
  const center = state.centerFine; // ~1m spacing, so indices ≈ meters
  const limit = trackLimit();
  const WINDOW = 12; // meters of forward search per stroke point
  let cursor = 0;
  let moved = 0;
  const out = pts.map((p) => {
    const end = Math.min(center.length - 1, cursor + WINDOW);
    const { point, dist, index } = closestOnPolylineRange(p, center, cursor, end);
    cursor = index;
    if (dist <= limit) return p;
    moved++;
    const f = limit / dist;
    return { x: point.x + (p.x - point.x) * f, y: point.y + (p.y - point.y) * f };
  });
  return { pts: out, moved };
}

canvas.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  try {
    canvas.setPointerCapture(e.pointerId);
  } catch {
    // Synthetic or already-released pointers can't be captured; drawing
    // still works, we just might miss moves outside the canvas.
  }
  state.strokeType = e.pointerType;
  state.drawing = true;
  state.attempt = null;
  const p = pointerToMeters(e);
  state.stroke = [p];
  state.strokeOffMask = [!isOnTrack(p)];
  setStatus('Drawing…');
  updateResults();
});

canvas.addEventListener('pointermove', (e) => {
  if (!state.drawing) return;
  const p = pointerToMeters(e);
  const off = !isOnTrack(p);
  if (off && !state.strokeOffMask[state.strokeOffMask.length - 1]) {
    navigator.vibrate?.(30); // tactile nudge where supported
  }
  state.stroke.push(p);
  state.strokeOffMask.push(off);
});

canvas.addEventListener('pointerup', (e) => {
  if (!state.drawing) return;
  state.drawing = false;
  const stroke = state.stroke;
  state.stroke = null;
  state.strokeOffMask = null;
  processStroke(stroke);
});

canvas.addEventListener('pointercancel', () => {
  state.drawing = false;
  state.stroke = null;
  state.strokeOffMask = null;
});

// Clip the stroke so it spans exactly from the entry gate plane to the exit
// gate plane; every attempt is timed over the same sector.
function clipToGates(raw) {
  const { entryP, entryT, exitP, exitT } = state.gates;
  const sEntry = (p) => dot(sub(p, entryP), entryT);
  const sExit = (p) => dot(sub(p, exitP), exitT);

  let pts = raw;
  const i = pts.findIndex((p) => sEntry(p) >= 0);
  if (i === -1) return { err: 'entry' };
  if (i === 0) {
    const d = sEntry(pts[0]);
    if (d > GATE_SNAP) return { err: 'entry' };
    pts = [move(pts[0], entryT, -d), ...pts];
  } else {
    const a = pts[i - 1];
    const b = pts[i];
    const da = sEntry(a);
    const db = sEntry(b);
    pts = [lerpPt(a, b, da / (da - db)), ...pts.slice(i)];
  }

  let j = -1;
  for (let k = pts.length - 1; k >= 0; k--) {
    if (sExit(pts[k]) <= 0) {
      j = k;
      break;
    }
  }
  if (j === -1) return { err: 'exit' };
  if (j === pts.length - 1) {
    const d = sExit(pts[j]);
    if (d < -GATE_SNAP) return { err: 'exit' };
    pts = [...pts, move(pts[j], exitT, -d)];
  } else {
    const a = pts[j];
    const b = pts[j + 1];
    const da = sExit(a);
    const db = sExit(b);
    pts = [...pts.slice(0, j + 1), lerpPt(a, b, da / (da - db))];
  }
  return { pts };
}

function processStroke(rawStroke) {
  if (!rawStroke || rawStroke.length < 8) {
    setStatus('That was just a dab — draw a full line from gate to gate.');
    return;
  }

  const stroke = dedupe(rawStroke, 0.6);
  const clipped = clipToGates(stroke);
  if (clipped.err === 'entry') {
    setStatus('Start your line at the green entry gate.');
    return;
  }
  if (clipped.err === 'exit') {
    setStatus('Finish your line at the chequered flag.');
    return;
  }
  if (polylineLength(clipped.pts) < 0.5 * state.centerLength) {
    setStatus('Line too short — draw all the way from the green gate to the chequered flag.');
    return;
  }

  // Keep the stroke on the track by construction — there is no rejection.
  // Clamp twice with a resample in between so heavily clamped sections
  // converge onto the edge arc instead of cutting chords inside it.
  const first = clampToTrack(resample(clipped.pts, 1.5));
  const tightened = first.moved / first.pts.length > 0.15;
  let pts = clampToTrack(resample(first.pts, 1.5)).pts;

  // Hand jitter is a screen-space phenomenon: a couple of pixels of wobble
  // is meters of noise when the view scale is small (phones), and the sim
  // would punish it as phantom braking zones. Fair the stroke — smooth it
  // hard, but keep every point within a jitter-sized tolerance of what was
  // actually drawn so the intended shape is preserved.
  const jitterPx = state.strokeType === 'touch' ? 5 : 2.5;
  const tol = Math.min(1.8, Math.max(0.6, jitterPx / state.view.scale));
  pts = fairPolyline(smoothPoints(pts, state.strokeType === 'touch' ? 7 : 3), tol);
  pts = clampToTrack(pts).pts; // smoothing may overshoot the edges slightly

  const line = prepareLine(pts);
  const sim = simulate(line);
  state.attempt = { sim };
  state.replayStart = performance.now();

  let message = `Lap ok — ${formatTime(sim.totalTime)}.`;
  if (tightened) message += ' (Line tightened to the track edge.)';
  if (!state.best || sim.totalTime < state.best.time - 1e-4) {
    message += state.best ? ' New personal best!' : ' First time set — now beat it.';
    state.best = { time: sim.totalTime, sim };
    saveBest(state.corner.id, sim.totalTime, line);
  }
  if (state.optimal) {
    const gap = sim.totalTime - state.optimal.sim.totalTime;
    if (gap <= 0.05) message += ' You matched the optimal line!';
    else message += ` ${gap.toFixed(2)}s off the optimal line.`;
  }
  setStatus(message);
  updateResults();
}

// ---------------------------------------------------------------------------
// Buttons

ui.clearBtn.addEventListener('click', () => {
  state.attempt = null;
  state.replayStart = state.best || (state.showOptimal && state.optimal) ? performance.now() : null;
  setStatus('Cleared. Draw a new line.');
  updateResults();
});

ui.replayBtn.addEventListener('click', () => {
  state.replayStart = performance.now();
});

ui.optimalBtn.addEventListener('click', () => {
  if (state.showOptimal) {
    state.showOptimal = false;
    updateOptimalButton();
    updateResults();
    return;
  }
  if (state.optimal) {
    state.showOptimal = true;
    state.replayStart = performance.now();
    updateOptimalButton();
    updateResults();
    return;
  }
  setStatus('Computing optimal line…');
  ui.optimalBtn.disabled = true;
  // Let the status paint before the solver blocks the main thread.
  setTimeout(() => {
    const optimal = solveOptimalLine(state.track.center, state.track.halfWidth, EDGE_MARGIN + 0.1);
    state.optimalCache.set(state.corner.id, optimal);
    state.optimal = optimal;
    state.showOptimal = true;
    state.replayStart = performance.now();
    ui.optimalBtn.disabled = false;
    setStatus(`Optimal line: ${formatTime(optimal.sim.totalTime)}. Can you match it?`);
    updateOptimalButton();
    updateResults();
  }, 30);
});

ui.resetBtn.addEventListener('click', () => {
  clearBest(state.corner.id);
  state.best = null;
  setStatus('Personal best cleared.');
  updateResults();
});

function updateOptimalButton() {
  ui.optimalBtn.textContent = state.showOptimal ? 'Hide optimal' : 'Show optimal';
}

// ---------------------------------------------------------------------------
// Results & status

function formatTime(t) {
  return `${t.toFixed(2)}s`;
}

function setStatus(msg) {
  ui.status.textContent = msg;
}

function updateResults() {
  ui.yourTime.textContent = state.attempt ? formatTime(state.attempt.sim.totalTime) : '–';
  ui.bestTime.textContent = state.best ? formatTime(state.best.time) : '–';
  ui.optimalTime.textContent =
    state.showOptimal && state.optimal ? formatTime(state.optimal.sim.totalTime) : '–';

  if (state.attempt && state.showOptimal && state.optimal) {
    const gap = state.attempt.sim.totalTime - state.optimal.sim.totalTime;
    ui.delta.textContent = `${gap >= 0 ? '+' : ''}${gap.toFixed(2)}s`;
    ui.delta.className = gap <= 0.05 ? 'delta good' : gap <= 0.5 ? 'delta close' : 'delta bad';
  } else {
    ui.delta.textContent = '–';
    ui.delta.className = 'delta';
  }

  const series = [];
  if (state.showOptimal && state.optimal) {
    series.push({ sim: state.optimal.sim, color: COLORS.optimal, label: 'optimal' });
  }
  if (state.best && (!state.attempt || state.best.sim !== state.attempt.sim)) {
    series.push({ sim: state.best.sim, color: 'rgba(226,232,240,0.6)', label: 'best' });
  }
  if (state.attempt) {
    series.push({ sim: state.attempt.sim, color: COLORS.user, label: 'you' });
  }
  drawTelemetry(telemetryCtx, telemetrySize.width, telemetrySize.height, series);
}

// ---------------------------------------------------------------------------
// Render loop

function replayCars() {
  if (state.replayStart === null) return [];
  const cars = [];
  if (state.attempt) cars.push({ sim: state.attempt.sim, color: COLORS.user, alpha: 1 });
  if (state.best && (!state.attempt || state.best.sim !== state.attempt.sim)) {
    cars.push({ sim: state.best.sim, color: '#e2e8f0', alpha: 0.45 });
  }
  if (state.showOptimal && state.optimal) {
    cars.push({ sim: state.optimal.sim, color: COLORS.optimal, alpha: 0.9 });
  }
  if (cars.length === 0) return [];

  const cycle = Math.max(...cars.map((c) => c.sim.totalTime)) + 1.2;
  const t = (((performance.now() - state.replayStart) / 1000) % cycle + cycle) % cycle;
  return cars.map((c) => ({ ...c, pose: stateAtTime(c.sim, Math.min(t, c.sim.totalTime)) }));
}

function frame() {
  ctx.clearRect(0, 0, trackSize.width, trackSize.height);
  ctx.fillStyle = '#10151a';
  ctx.fillRect(0, 0, trackSize.width, trackSize.height);

  drawTrack(ctx, state.view, state.track);

  if (state.best && (!state.attempt || state.best.sim !== state.attempt.sim)) {
    drawPlainLine(ctx, state.view, state.best.sim.points, {
      color: COLORS.ghost,
      width: 2,
      dash: [8, 6],
    });
  }
  if (state.showOptimal && state.optimal) {
    drawPlainLine(ctx, state.view, state.optimal.sim.points, {
      color: COLORS.optimal,
      width: 2.5,
    });
  }
  if (state.attempt) {
    drawSpeedLine(ctx, state.view, state.attempt.sim);
  }
  if (state.drawing && state.stroke && state.stroke.length > 1) {
    drawStroke(ctx, state.view, state.stroke, state.strokeOffMask);
  }

  for (const car of replayCars()) {
    drawCar(ctx, state.view, car.pose, { color: car.color, alpha: car.alpha });
  }

  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------------------

layoutCanvases();
buildCornerButtons();
selectCorner(CORNERS[0]);
requestAnimationFrame(frame);

// Test hook for automated (Playwright) checks.
window.__rl = { state, CAR, trackSize };
