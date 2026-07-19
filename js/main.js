import { CORNERS, cornerCenterline } from './corners.js';
import {
  closestOnPolyline,
  dedupe,
  distToPolyline,
  dot,
  lerpPt,
  move,
  polylineLength,
  resample,
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

const GATE_SNAP = 6; // meters of leeway for starting/ending near the gates
const GRACE = 1.2; // meters of "kerb": slight excursions are clamped back, not rejected

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
  drawing: false,
  attempt: null, // {sim} valid attempt
  invalid: null, // {line, offMask} off-track attempt for display
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

const trackSize = setupCanvas(canvas, 940, 560);
const telemetrySize = setupCanvas(telemetryCanvas, 940, 170);

function selectCorner(corner) {
  state.corner = corner;
  const center = cornerCenterline(corner);
  state.track = buildTrackGeometry(center, corner.width);
  state.centerFine = resample(center, 1);
  state.centerLength = polylineLength(center);
  state.view = makeView(
    trackSize.width,
    trackSize.height,
    [...state.track.leftEdge, ...state.track.rightEdge]
  );

  const entryT = unit(sub(center[1], center[0]));
  const last = center.length - 1;
  const exitT = unit(sub(center[last], center[last - 1]));
  state.gates = { entryP: center[0], entryT, exitP: center[last], exitT };

  state.stroke = null;
  state.strokeOffMask = null;
  state.drawing = false;
  state.attempt = null;
  state.invalid = null;
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

// Acceptable for drawing: inside the track, or within the kerb grace band.
function isOnTrack(p) {
  return distToPolyline(p, state.centerFine) <= trackLimit() + GRACE;
}

canvas.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  canvas.setPointerCapture(e.pointerId);
  state.drawing = true;
  state.attempt = null;
  state.invalid = null;
  const p = pointerToMeters(e);
  state.stroke = [p];
  state.strokeOffMask = [!isOnTrack(p)];
  setStatus('Drawing…');
  updateResults();
});

canvas.addEventListener('pointermove', (e) => {
  if (!state.drawing) return;
  const p = pointerToMeters(e);
  state.stroke.push(p);
  state.strokeOffMask.push(!isOnTrack(p));
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
  const line = prepareLine(clipped.pts);
  // Points slightly over the limit ride the kerb: clamp them back to the
  // track edge. Clear excursions invalidate the attempt.
  const limit = trackLimit();
  const offMask = new Array(line.length).fill(false);
  let anyOff = false;
  for (let i = 0; i < line.length; i++) {
    const { point, dist } = closestOnPolyline(line[i], state.centerFine);
    if (dist > limit + GRACE) {
      offMask[i] = true;
      anyOff = true;
    } else if (dist > limit) {
      const f = limit / dist;
      line[i] = {
        x: point.x + (line[i].x - point.x) * f,
        y: point.y + (line[i].y - point.y) * f,
      };
    }
  }
  if (anyOff) {
    state.invalid = { line, offMask };
    setStatus('Off track! Fix the red sections and try again.');
    updateResults();
    return;
  }
  if (polylineLength(line) < 0.55 * state.centerLength) {
    setStatus('Line too short — draw all the way from the green gate to the chequered flag.');
    return;
  }

  const sim = simulate(line);
  state.attempt = { sim };
  state.invalid = null;
  state.replayStart = performance.now();

  let message = `Lap ok — ${formatTime(sim.totalTime)}.`;
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
  state.invalid = null;
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
  if (state.invalid) {
    drawStroke(ctx, state.view, state.invalid.line, state.invalid.offMask);
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

buildCornerButtons();
selectCorner(CORNERS[0]);
requestAnimationFrame(frame);

// Test hook for automated (Playwright) checks.
window.__rl = { state, CAR };
