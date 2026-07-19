// Speed-vs-distance telemetry graph on its own canvas.

import { CAR } from './physics.js';

const PAD = { left: 44, right: 12, top: 16, bottom: 22 };

// series: [{ sim, color, label }]
export function drawTelemetry(ctx, width, height, series) {
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#14171c';
  ctx.fillRect(0, 0, width, height);

  const plotW = width - PAD.left - PAD.right;
  const plotH = height - PAD.top - PAD.bottom;
  const maxDist = Math.max(50, ...series.map((s) => s.sim.length));
  const maxKmh = Math.ceil((CAR.topSpeed * 3.6) / 50) * 50;

  const x = (d) => PAD.left + (d / maxDist) * plotW;
  const y = (kmh) => PAD.top + plotH - (kmh / maxKmh) * plotH;

  ctx.font = '10px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.45)';
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 1;

  // Horizontal grid: every 50 km/h.
  for (let kmh = 0; kmh <= maxKmh; kmh += 50) {
    ctx.beginPath();
    ctx.moveTo(PAD.left, y(kmh));
    ctx.lineTo(width - PAD.right, y(kmh));
    ctx.stroke();
    ctx.textAlign = 'right';
    ctx.fillText(String(kmh), PAD.left - 6, y(kmh) + 3);
  }
  // Vertical grid: every 50 m.
  for (let d = 0; d <= maxDist; d += 50) {
    ctx.beginPath();
    ctx.moveTo(x(d), PAD.top);
    ctx.lineTo(x(d), PAD.top + plotH);
    ctx.stroke();
    ctx.textAlign = 'center';
    ctx.fillText(`${d}m`, x(d), height - 8);
  }
  ctx.textAlign = 'left';
  ctx.fillText('km/h', PAD.left + 6, PAD.top + 10);

  for (const s of series) {
    const { sim } = s;
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    for (let i = 0; i < sim.points.length; i++) {
      const px = x(sim.dists[i]);
      const py = y(sim.speeds[i] * 3.6);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
  }

  // Legend, top-right.
  let lx = width - PAD.right - 8;
  ctx.textAlign = 'right';
  for (let i = series.length - 1; i >= 0; i--) {
    const s = series[i];
    ctx.fillStyle = s.color;
    ctx.fillText(s.label, lx, PAD.top + 8);
    lx -= ctx.measureText(s.label).width + 16;
  }
}
