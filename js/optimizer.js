// Near-optimal racing line, found by optimising lap time directly.
//
// The candidate line is a lateral-offset profile from the centerline: offsets
// are defined at coarse control stations, smoothly interpolated (Catmull-Rom)
// along a finely sampled centerline, and clamped to the track edges. A pattern
// search (coordinate descent with a shrinking step) adjusts the control
// offsets to minimise the simulated sector time. The objective is the exact
// same scoring pipeline used for the player's line, and the search starts on
// the centerline accepting only improvements — so the result is scored fairly
// and is never slower than the centerline.

import { clamp, dist, move, normals, resample } from './geometry.js';
import { prepareLine, simulate } from './physics.js';

const CONTROL_STEP = 8; // meters between offset control stations
const FINE_STEP = 2; // meters between geometry samples
const MIN_STEP = 0.04; // meters; stop refining below this offset step
const MAX_SWEEPS = 800;

function arcLengths(pts) {
  const s = new Float64Array(pts.length);
  for (let i = 1; i < pts.length; i++) s[i] = s[i - 1] + dist(pts[i - 1], pts[i]);
  return s;
}

function catmullRom(p0, p1, p2, p3, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    0.5 *
    (2 * p1 +
      (-p0 + p2) * t +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
      (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
  );
}

export function solveOptimalLine(centerline, halfWidth, margin = 1.0) {
  const ctrl = resample(centerline, CONTROL_STEP);
  const nc = ctrl.length;
  const sCtrl = arcLengths(ctrl);
  const fine = resample(centerline, FINE_STEP);
  const fns = normals(fine);
  const sFine = arcLengths(fine);
  const lim = Math.max(0.5, halfWidth - margin);

  const e = new Float64Array(nc); // control offsets, start on the centerline

  const buildPoints = () => {
    const pts = new Array(fine.length);
    let k = 0;
    for (let j = 0; j < fine.length; j++) {
      const s = sFine[j];
      while (k < nc - 2 && sCtrl[k + 1] <= s) k++;
      const span = sCtrl[k + 1] - sCtrl[k] || 1;
      const t = clamp((s - sCtrl[k]) / span, 0, 1);
      const off = catmullRom(
        e[Math.max(0, k - 1)],
        e[k],
        e[Math.min(nc - 1, k + 1)],
        e[Math.min(nc - 1, k + 2)],
        t
      );
      pts[j] = move(fine[j], fns[j], clamp(off, -lim, lim));
    }
    return pts;
  };

  const evalTime = () => simulate(prepareLine(buildPoints())).totalTime;

  let best = evalTime();

  // Try adding delta * weights to the controls around i; keep on improvement.
  const tryMove = (i, delta, weights) => {
    const touched = [];
    for (let w = 0; w < weights.length; w++) {
      const j = i + w - (weights.length >> 1);
      if (j < 0 || j >= nc) continue;
      touched.push([j, e[j]]);
      e[j] = clamp(e[j] + delta * weights[w], -lim, lim);
    }
    if (touched.length === 0) return false;
    const t = evalTime();
    if (t < best - 1e-6) {
      best = t;
      return true;
    }
    for (const [j, old] of touched) e[j] = old;
    return false;
  };

  // Single-point moves refine detail; wider "bump" moves shift whole sections
  // of the line at once, which single moves can't reach without passing
  // through slower intermediate states.
  const MOVES = [[1], [0.5, 1, 0.5], [0.35, 0.8, 1, 0.8, 0.35]];

  let sweeps = 0;
  for (let round = 0; round < 3 && sweeps < MAX_SWEEPS; round++) {
    let step = lim * 0.6;
    while (step > MIN_STEP && sweeps < MAX_SWEEPS) {
      let improved = false;
      for (let i = 0; i < nc; i++) {
        for (const weights of MOVES) {
          if (tryMove(i, step, weights) || tryMove(i, -step, weights)) {
            improved = true;
            break;
          }
        }
      }
      sweeps++;
      if (!improved) step *= 0.5;
    }
  }

  const line = prepareLine(buildPoints());
  const sim = simulate(line);
  return { line, sim };
}
