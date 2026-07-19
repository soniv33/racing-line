// Quasi-steady-state lap-time simulation: given a line, compute the fastest
// speed profile a car with a friction circle could drive along it.

import { chaikin, curvatures, dist, movingAverage, resample } from './geometry.js';

export const CAR = {
  topSpeed: 55, // m/s (~198 km/h)
  aLatMax: 10.8, // m/s² (~1.1 g of lateral grip)
  aBrakeMax: 10.8, // m/s²
  aAccelMax: 7.0, // m/s² traction-limited acceleration at low speed
  powerToMass: 230, // W/kg — caps acceleration at high speed (a = P/m/v)
  minCornerSpeed: 4, // m/s floor so pathological kinks don't stall the sim
  length: 4.4, // m, for rendering
  bodyWidth: 1.9, // m, for rendering
};

export const SIM_STEP = 0.5; // meters between simulation samples
export const EDGE_MARGIN = 0.9; // car half-width kept inside the track edge

// Smooth and resample a hand-drawn (or solver) line into simulation input.
// Both the player's line and the optimal line go through this, so they are
// scored by identical rules.
export function prepareLine(pts) {
  return resample(chaikin(pts, 2), SIM_STEP);
}

// pts: polyline in meters, roughly uniformly spaced (use prepareLine first).
// Returns speeds (m/s), cumulative times (s) and distances (m) per point.
export function simulate(pts, car = CAR) {
  const n = pts.length;
  if (n < 3) return null;

  const ds = new Float64Array(n); // ds[i] = distance from point i-1 to i
  for (let i = 1; i < n; i++) ds[i] = dist(pts[i - 1], pts[i]);

  // Curvature, lightly filtered so pixel noise in a hand-drawn line doesn't
  // create phantom braking zones.
  const kappa = movingAverage(curvatures(pts), 7);

  // Pure-cornering speed cap per point.
  const vmax = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const vCorner = kappa[i] > 1e-6 ? Math.sqrt(car.aLatMax / kappa[i]) : Infinity;
    vmax[i] = Math.max(car.minCornerSpeed, Math.min(car.topSpeed, vCorner));
  }

  const v = Float64Array.from(vmax);

  // Fraction of the friction circle left for longitudinal force at speed u
  // and curvature k.
  const gripFrac = (u, k) => {
    const latFrac = (u * u * k) / car.aLatMax;
    return Math.sqrt(Math.max(0, 1 - latFrac * latFrac));
  };

  // Forward pass: acceleration limited by traction, power and the friction circle.
  for (let i = 1; i < n; i++) {
    const u = v[i - 1];
    const engine = car.powerToMass / Math.max(u, 1);
    const aAvail = Math.min(car.aAccelMax, engine) * gripFrac(u, kappa[i - 1]);
    const reachable = Math.sqrt(u * u + 2 * aAvail * ds[i]);
    v[i] = Math.min(v[i], reachable);
  }

  // Backward pass: braking limited by the friction circle.
  for (let i = n - 2; i >= 0; i--) {
    const u = v[i + 1];
    const aAvail = car.aBrakeMax * gripFrac(u, kappa[i + 1]);
    const reachable = Math.sqrt(u * u + 2 * aAvail * ds[i + 1]);
    v[i] = Math.min(v[i], reachable);
  }

  const times = new Float64Array(n);
  const dists = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    const avg = Math.max((v[i - 1] + v[i]) / 2, 0.5);
    times[i] = times[i - 1] + ds[i] / avg;
    dists[i] = dists[i - 1] + ds[i];
  }

  return {
    points: pts,
    speeds: v,
    times,
    dists,
    totalTime: times[n - 1],
    length: dists[n - 1],
    vMin: Math.min(...v),
    vMax: Math.max(...v),
  };
}

// Position and heading along a simulated run at time t (seconds).
export function stateAtTime(sim, t) {
  const { points, times } = sim;
  const n = points.length;
  if (t <= 0) return poseAt(points, 0);
  if (t >= sim.totalTime) return poseAt(points, n - 1);
  // Binary search for the segment containing t.
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) lo = mid;
    else hi = mid;
  }
  const span = times[hi] - times[lo] || 1;
  const frac = (t - times[lo]) / span;
  const a = points[lo];
  const b = points[hi];
  const pose = poseAt(points, lo);
  return {
    x: a.x + (b.x - a.x) * frac,
    y: a.y + (b.y - a.y) * frac,
    heading: pose.heading,
    speed: sim.speeds[lo] + (sim.speeds[hi] - sim.speeds[lo]) * frac,
  };
}

function poseAt(points, i) {
  const a = points[Math.max(0, i - 1)];
  const b = points[Math.min(points.length - 1, i + 1)];
  return {
    x: points[i].x,
    y: points[i].y,
    heading: Math.atan2(b.y - a.y, b.x - a.x),
    speed: 0,
  };
}
