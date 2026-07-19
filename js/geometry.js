// Planar polyline utilities. Coordinates are {x, y} objects in meters.

export function dist(a, b) {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function sub(a, b) {
  return { x: a.x - b.x, y: a.y - b.y };
}

export function dot(a, b) {
  return a.x * b.x + a.y * b.y;
}

export function lerpPt(a, b, t) {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

export function move(p, dir, amount) {
  return { x: p.x + dir.x * amount, y: p.y + dir.y * amount };
}

export function unit(v) {
  const len = Math.hypot(v.x, v.y) || 1;
  return { x: v.x / len, y: v.y / len };
}

export function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

export function polylineLength(pts) {
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += dist(pts[i - 1], pts[i]);
  return len;
}

// Uniform arc-length resampling; keeps both endpoints.
export function resample(pts, step) {
  const out = [{ ...pts[0] }];
  let prev = pts[0];
  let need = step;
  for (let i = 1; i < pts.length; i++) {
    const cur = pts[i];
    let segLen = dist(prev, cur);
    while (segLen >= need) {
      const t = need / segLen;
      const p = lerpPt(prev, cur, t);
      out.push(p);
      prev = p;
      segLen -= need;
      need = step;
    }
    need -= segLen;
    prev = cur;
  }
  const last = pts[pts.length - 1];
  if (dist(out[out.length - 1], last) > step * 0.25) out.push({ ...last });
  else out[out.length - 1] = { ...last };
  return out;
}

// Drop points closer than minSpacing to their predecessor; keeps endpoints.
export function dedupe(pts, minSpacing) {
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    if (dist(out[out.length - 1], pts[i]) >= minSpacing) out.push(pts[i]);
  }
  if (pts.length > 1) out.push(pts[pts.length - 1]);
  return out;
}

// Chaikin corner-cutting smoothing; endpoints are preserved.
export function chaikin(pts, iterations = 1) {
  let p = pts;
  for (let k = 0; k < iterations; k++) {
    const out = [p[0]];
    for (let i = 0; i < p.length - 1; i++) {
      const a = p[i];
      const b = p[i + 1];
      out.push({ x: 0.75 * a.x + 0.25 * b.x, y: 0.75 * a.y + 0.25 * b.y });
      out.push({ x: 0.25 * a.x + 0.75 * b.x, y: 0.25 * a.y + 0.75 * b.y });
    }
    out.push(p[p.length - 1]);
    p = out;
  }
  return p;
}

// Moving-average low-pass over polyline points. The window shrinks near the
// ends so endpoints stay exactly in place.
export function smoothPoints(pts, window) {
  const half = Math.floor(window / 2);
  return pts.map((p, i) => {
    const h = Math.min(half, i, pts.length - 1 - i);
    let sx = 0;
    let sy = 0;
    let c = 0;
    for (let j = i - h; j <= i + h; j++) {
      sx += pts[j].x;
      sy += pts[j].y;
      c++;
    }
    return { x: sx / c, y: sy / c };
  });
}

// Smooth a polyline (Laplacian relaxation) while keeping every point within
// `tol` meters of where it started; endpoints stay fixed. Used to remove
// hand jitter from drawn strokes without changing the intended shape.
export function fairPolyline(pts, tol, iterations = 150) {
  const orig = pts;
  const out = pts.map((p) => ({ ...p }));
  for (let it = 0; it < iterations; it++) {
    for (let i = 1; i < out.length - 1; i++) {
      const mx = (out[i - 1].x + out[i + 1].x) / 2;
      const my = (out[i - 1].y + out[i + 1].y) / 2;
      let nx = out[i].x + 0.5 * (mx - out[i].x);
      let ny = out[i].y + 0.5 * (my - out[i].y);
      const dx = nx - orig[i].x;
      const dy = ny - orig[i].y;
      const d = Math.hypot(dx, dy);
      if (d > tol) {
        nx = orig[i].x + (dx / d) * tol;
        ny = orig[i].y + (dy / d) * tol;
      }
      out[i].x = nx;
      out[i].y = ny;
    }
  }
  return out;
}

// Menger curvature of the circle through three points (1/radius, in 1/m).
export function menger(a, b, c) {
  const area2 = Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
  const d = dist(a, b) * dist(b, c) * dist(c, a);
  return d < 1e-9 ? 0 : (2 * area2) / d;
}

export function curvatures(pts) {
  const n = pts.length;
  const k = new Float64Array(n);
  for (let i = 1; i < n - 1; i++) k[i] = menger(pts[i - 1], pts[i], pts[i + 1]);
  if (n > 2) {
    k[0] = k[1];
    k[n - 1] = k[n - 2];
  }
  return k;
}

export function movingAverage(arr, window) {
  const half = Math.floor(window / 2);
  const out = new Float64Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    let sum = 0;
    let count = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(arr.length - 1, i + half); j++) {
      sum += arr[j];
      count++;
    }
    out[i] = sum / count;
  }
  return out;
}

// Unit left normals per point (perpendicular to the local tangent).
export function normals(pts) {
  const n = pts.length;
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(n - 1, i + 1)];
    const t = unit(sub(b, a));
    out.push({ x: -t.y, y: t.x });
  }
  return out;
}

export function offsetPolyline(pts, offset) {
  const ns = normals(pts);
  return pts.map((p, i) => move(p, ns[i], offset));
}

export function distToSegment(p, a, b) {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const len2 = abx * abx + aby * aby;
  if (len2 < 1e-12) return dist(p, a);
  const t = clamp(((p.x - a.x) * abx + (p.y - a.y) * aby) / len2, 0, 1);
  return Math.hypot(p.x - (a.x + abx * t), p.y - (a.y + aby * t));
}

export function distToPolyline(p, pts) {
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const d = distToSegment(p, pts[i - 1], pts[i]);
    if (d < best) best = d;
  }
  return best;
}

// Closest point on a polyline, with its distance.
export function closestOnPolyline(p, pts) {
  let bestDist = Infinity;
  let bestPt = pts[0];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const len2 = abx * abx + aby * aby;
    const t = len2 < 1e-12 ? 0 : clamp(((p.x - a.x) * abx + (p.y - a.y) * aby) / len2, 0, 1);
    const q = { x: a.x + abx * t, y: a.y + aby * t };
    const d = Math.hypot(p.x - q.x, p.y - q.y);
    if (d < bestDist) {
      bestDist = d;
      bestPt = q;
    }
  }
  return { point: bestPt, dist: bestDist };
}
