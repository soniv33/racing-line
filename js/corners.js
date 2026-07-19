// Corner library. Centerlines are built from straight/arc segments in meters.

const DEG = Math.PI / 180;

// Build a centerline polyline from a start point, initial heading (degrees)
// and a list of segments: {straight: length} or {arc: signedAngleDeg, r: radius}.
// Positive arc angles turn counter-clockwise in the coordinate system.
function buildCenterline(start, headingDeg, segments, step = 2) {
  const pts = [{ ...start }];
  let x = start.x;
  let y = start.y;
  let h = headingDeg * DEG;
  for (const seg of segments) {
    if (seg.straight !== undefined) {
      const n = Math.max(1, Math.ceil(seg.straight / step));
      const x0 = x;
      const y0 = y;
      for (let i = 1; i <= n; i++) {
        pts.push({
          x: x0 + Math.cos(h) * (seg.straight * i) / n,
          y: y0 + Math.sin(h) * (seg.straight * i) / n,
        });
      }
      x = x0 + Math.cos(h) * seg.straight;
      y = y0 + Math.sin(h) * seg.straight;
    } else {
      const ang = seg.arc * DEG;
      const r = seg.r;
      const side = Math.sign(ang) || 1;
      // The turn center sits at distance r perpendicular to the heading,
      // on the inside of the turn.
      const centerX = x - side * r * Math.sin(h);
      const centerY = y + side * r * Math.cos(h);
      const n = Math.max(2, Math.ceil((Math.abs(ang) * r) / step));
      for (let i = 1; i <= n; i++) {
        const t = (ang * i) / n;
        const ux = side * Math.sin(h + t);
        const uy = -side * Math.cos(h + t);
        pts.push({ x: centerX + r * ux, y: centerY + r * uy });
      }
      x = pts[pts.length - 1].x;
      y = pts[pts.length - 1].y;
      h += ang;
    }
  }
  return pts;
}

export const CORNERS = [
  {
    id: 'hairpin',
    name: 'Hairpin',
    width: 12,
    heading: 0,
    segments: [{ straight: 85 }, { arc: 180, r: 15 }, { straight: 85 }],
    blurb:
      'The slowest corner in racing. Brake deep, stay wide on entry, clip a late apex and get on the power early — the exit feeds a long straight.',
  },
  {
    id: 'ninety',
    name: '90° Corner',
    width: 11,
    heading: 20,
    segments: [{ straight: 80 }, { arc: -90, r: 22 }, { straight: 80 }],
    blurb:
      'The classic street-circuit right-angle. Out wide, apex late, use every centimetre of exit kerb.',
  },
  {
    id: 'chicane',
    name: 'Chicane',
    width: 11,
    heading: 10,
    segments: [
      { straight: 70 },
      { arc: -50, r: 20 },
      { straight: 8 },
      { arc: 50, r: 20 },
      { straight: 70 },
    ],
    blurb:
      'A right-left flick. The fastest way through is to straighten it as much as the track edges allow.',
  },
  {
    id: 'double-apex',
    name: 'Double Apex',
    width: 11.5,
    heading: 0,
    segments: [
      { straight: 60 },
      { arc: 55, r: 30 },
      { straight: 18 },
      { arc: 55, r: 28 },
      { straight: 60 },
    ],
    blurb:
      'Two linked left-handers. Do you clip both apexes, or sweep one smooth arc through the middle?',
  },
  {
    id: 'sweeper',
    name: 'Fast Sweeper',
    width: 12,
    heading: -30,
    segments: [{ straight: 45 }, { arc: 130, r: 55 }, { straight: 45 }],
    blurb:
      'A long, fast corner. Smoothness is everything — every extra degree of steering costs you speed.',
  },
];

export function cornerCenterline(corner) {
  return buildCenterline({ x: 0, y: 0 }, corner.heading, corner.segments);
}
