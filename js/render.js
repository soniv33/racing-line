// Canvas rendering: track, gates, lines, cars.

import { move, offsetPolyline, sub, unit } from './geometry.js';
import { CAR } from './physics.js';

// Fit a set of points (meters) into a canvas (CSS pixels) with padding.
// Tries the corner as-is and rotated 90°, and keeps whichever orientation
// fills the canvas better — so wide corners fill a portrait phone screen.
export function makeView(width, height, pts, pad = 34) {
  const upright = fitView(width, height, pts, pad, 0);
  const rotated = fitView(width, height, pts, pad, -Math.PI / 2);
  return rotated.scale > upright.scale ? rotated : upright;
}

function fitView(width, height, pts, pad, rot) {
  // rot is either 0 or -90°; the 90° case maps (x, y) -> (y, -x).
  const fwd = rot === 0 ? (p) => p : (p) => ({ x: p.y, y: -p.x });
  const inv = rot === 0 ? (p) => p : (p) => ({ x: -p.y, y: p.x });
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const raw of pts) {
    const p = fwd(raw);
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  const bw = Math.max(1, maxX - minX);
  const bh = Math.max(1, maxY - minY);
  const scale = Math.min((width - 2 * pad) / bw, (height - 2 * pad) / bh);
  const ox = (width - bw * scale) / 2 - minX * scale;
  const oy = (height - bh * scale) / 2 - minY * scale;
  return {
    scale,
    rot,
    toPx: (p) => {
      const q = fwd(p);
      return { x: ox + q.x * scale, y: oy + q.y * scale };
    },
    toM: (px) => inv({ x: (px.x - ox) / scale, y: (px.y - oy) / scale }),
  };
}

export function colorForSpeed(v, topSpeed = CAR.topSpeed) {
  const t = Math.min(1, Math.max(0, v / topSpeed));
  const hue = 220 * (1 - t); // blue (slow) -> red (fast)
  return `hsl(${hue}, 85%, 58%)`;
}

function tracePolyline(ctx, view, pts) {
  ctx.beginPath();
  const p0 = view.toPx(pts[0]);
  ctx.moveTo(p0.x, p0.y);
  for (let i = 1; i < pts.length; i++) {
    const p = view.toPx(pts[i]);
    ctx.lineTo(p.x, p.y);
  }
}

export function drawTrack(ctx, view, track) {
  const { center, leftEdge, rightEdge, halfWidth } = track;

  // Asphalt ribbon.
  ctx.beginPath();
  const first = view.toPx(leftEdge[0]);
  ctx.moveTo(first.x, first.y);
  for (let i = 1; i < leftEdge.length; i++) {
    const p = view.toPx(leftEdge[i]);
    ctx.lineTo(p.x, p.y);
  }
  for (let i = rightEdge.length - 1; i >= 0; i--) {
    const p = view.toPx(rightEdge[i]);
    ctx.lineTo(p.x, p.y);
  }
  ctx.closePath();
  ctx.fillStyle = '#31363d';
  ctx.fill();

  // Edge lines.
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(235, 235, 235, 0.75)';
  tracePolyline(ctx, view, leftEdge);
  ctx.stroke();
  tracePolyline(ctx, view, rightEdge);
  ctx.stroke();

  // Faint centerline.
  ctx.save();
  ctx.setLineDash([6, 10]);
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.10)';
  tracePolyline(ctx, view, center);
  ctx.stroke();
  ctx.restore();

  drawGates(ctx, view, track);
}

function gateEnds(center, index, refIndex, halfWidth) {
  const t = unit(sub(center[refIndex], center[index]));
  const nrm = { x: -t.y, y: t.x };
  return [move(center[index], nrm, -halfWidth), move(center[index], nrm, halfWidth)];
}

function drawGates(ctx, view, track) {
  const { center, halfWidth } = track;

  // Entry: green line.
  const [a, b] = gateEnds(center, 0, 1, halfWidth);
  const pa = view.toPx(a);
  const pb = view.toPx(b);
  ctx.lineWidth = 4;
  ctx.strokeStyle = '#4ade80';
  ctx.beginPath();
  ctx.moveTo(pa.x, pa.y);
  ctx.lineTo(pb.x, pb.y);
  ctx.stroke();

  // Exit: chequered band.
  const last = center.length - 1;
  const [c, d] = gateEnds(center, last, last - 1, halfWidth);
  const pc = view.toPx(c);
  const pd = view.toPx(d);
  const blocks = 10;
  const bandW = 7;
  const dx = (pd.x - pc.x) / blocks;
  const dy = (pd.y - pc.y) / blocks;
  const nx = -dy;
  const ny = dx;
  const nLen = Math.hypot(nx, ny) || 1;
  const ox = (nx / nLen) * (bandW / 2);
  const oy = (ny / nLen) * (bandW / 2);
  for (let row = 0; row < 2; row++) {
    for (let i = 0; i < blocks; i++) {
      ctx.fillStyle = (i + row) % 2 === 0 ? '#e8e8e8' : '#16181c';
      const sx = pc.x + dx * i - (row === 0 ? ox : 0);
      const sy = pc.y + dy * i - (row === 0 ? oy : 0);
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(sx + dx, sy + dy);
      ctx.lineTo(sx + dx + ox, sy + dy + oy);
      ctx.lineTo(sx + ox, sy + oy);
      ctx.closePath();
      ctx.fill();
    }
  }
}

// A line colored by speed, segment by segment.
export function drawSpeedLine(ctx, view, sim, { width = 3.5, alpha = 1 } = {}) {
  const { points, speeds } = sim;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  // Stride segments so we don't stroke 400+ tiny paths.
  const stride = 2;
  for (let i = stride; i < points.length; i += stride) {
    const a = view.toPx(points[i - stride]);
    const b = view.toPx(points[i]);
    ctx.strokeStyle = colorForSpeed((speeds[i - stride] + speeds[i]) / 2);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
  ctx.restore();
}

export function drawPlainLine(ctx, view, pts, { color, width = 2.5, dash = null, alpha = 1 } = {}) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (dash) ctx.setLineDash(dash);
  ctx.strokeStyle = color;
  tracePolyline(ctx, view, pts);
  ctx.stroke();
  ctx.restore();
}

// A hand stroke while drawing. Samples outside the corridor render dimmed —
// a hint that they will be pulled back onto the track, never a rejection.
export function drawStroke(ctx, view, pts, offMask) {
  ctx.save();
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  for (let i = 1; i < pts.length; i++) {
    const a = view.toPx(pts[i - 1]);
    const b = view.toPx(pts[i]);
    const off = offMask && (offMask[i - 1] || offMask[i]);
    ctx.strokeStyle = off ? 'rgba(148, 163, 184, 0.45)' : 'rgba(245, 245, 245, 0.9)';
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
  ctx.restore();
}

export function drawCar(ctx, view, pose, { color, alpha = 1 } = {}) {
  const p = view.toPx(pose);
  const len = CAR.length * view.scale;
  const wid = CAR.bodyWidth * view.scale;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(p.x, p.y);
  ctx.rotate(pose.heading + view.rot);
  ctx.fillStyle = color;
  ctx.strokeStyle = 'rgba(0,0,0,0.5)';
  ctx.lineWidth = 1;
  roundRect(ctx, -len / 2, -wid / 2, len, wid, Math.min(3, wid / 3));
  ctx.fill();
  ctx.stroke();
  // Windshield hint so the direction of travel reads at a glance.
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  roundRect(ctx, len * 0.05, -wid * 0.3, len * 0.25, wid * 0.6, 1.5);
  ctx.fill();
  ctx.restore();
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Build derived track geometry from a centerline.
export function buildTrackGeometry(center, width) {
  const halfWidth = width / 2;
  return {
    center,
    halfWidth,
    leftEdge: offsetPolyline(center, halfWidth),
    rightEdge: offsetPolyline(center, -halfWidth),
  };
}
