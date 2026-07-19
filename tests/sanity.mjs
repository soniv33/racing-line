// Physics & solver sanity checks. Run with: node tests/sanity.mjs

import { CORNERS, cornerCenterline } from '../js/corners.js';
import { distToPolyline, offsetPolyline, resample } from '../js/geometry.js';
import { CAR, prepareLine, simulate } from '../js/physics.js';
import { solveOptimalLine } from '../js/optimizer.js';

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.error(`  FAIL ${name} ${detail}`);
  }
}

// --- 1. A straight line is driven at (nearly) top speed -------------------
{
  console.log('straight line');
  const straight = [];
  for (let i = 0; i <= 200; i += 2) straight.push({ x: i, y: 0 });
  const sim = simulate(prepareLine(straight));
  check('time ~ length/topSpeed', Math.abs(sim.totalTime - 200 / CAR.topSpeed) < 0.15, `t=${sim.totalTime.toFixed(2)}`);
  check('min speed near top speed', sim.vMin > CAR.topSpeed - 1, `vMin=${sim.vMin.toFixed(1)}`);
}

// --- 2. Per-corner invariants ---------------------------------------------
for (const corner of CORNERS) {
  console.log(`${corner.name}`);
  const center = cornerCenterline(corner);
  const half = corner.width / 2;
  const centerFine = resample(center, 1);

  const centerSim = simulate(prepareLine(center));
  check('centerline sim valid', centerSim && Number.isFinite(centerSim.totalTime));
  check('times increase', centerSim.times.every((t, i) => i === 0 || t > centerSim.times[i - 1]));
  check(
    'speeds within car limits',
    centerSim.vMin >= CAR.minCornerSpeed - 0.01 && centerSim.vMax <= CAR.topSpeed + 0.01,
    `[${centerSim.vMin.toFixed(1)}, ${centerSim.vMax.toFixed(1)}]`
  );

  const t0 = Date.now();
  const optimal = solveOptimalLine(center, half, 1.0);
  const solverMs = Date.now() - t0;
  check(
    'optimal beats centerline',
    optimal.sim.totalTime <= centerSim.totalTime + 0.01,
    `optimal=${optimal.sim.totalTime.toFixed(2)} center=${centerSim.totalTime.toFixed(2)}`
  );
  const maxDist = Math.max(...optimal.line.map((p) => distToPolyline(p, centerFine)));
  check('optimal stays on track', maxDist <= half - 0.5, `maxDist=${maxDist.toFixed(2)} half=${half}`);
  check('solver is fast', solverMs < 3000, `${solverMs}ms`);

  // Constant-offset lines (hugging one side the whole way) should not beat
  // the solver's line.
  for (const off of [-half + 1.2, half - 1.2]) {
    const sim = simulate(prepareLine(offsetPolyline(centerFine, off)));
    check(
      `optimal beats constant offset ${off.toFixed(1)}`,
      optimal.sim.totalTime <= sim.totalTime + 0.01,
      `optimal=${optimal.sim.totalTime.toFixed(2)} offset=${sim.totalTime.toFixed(2)}`
    );
  }
  console.log(`  info centerline=${centerSim.totalTime.toFixed(2)}s optimal=${optimal.sim.totalTime.toFixed(2)}s (${solverMs}ms)`);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nAll checks passed');
