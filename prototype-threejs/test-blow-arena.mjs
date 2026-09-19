// Headless smoke test for blow-arena.js — run with `node test-blow-arena.mjs`
// from prototype-threejs/. Exercises the real Rapier physics (no DOM/canvas
// involved; createArena()/addPlayer() both skip their `if (scene)`/`if (document)`
// branches when there's no document, so this runs the exact same physics code
// path the browser page does). Written because this environment's real-time
// browser testing is unreliable for anything that needs to watch a multi-second
// physics settle (see TODO.md's other "Testing" notes on this project for the
// same problem elsewhere) — a plain Node script sidesteps that entirely, same
// as the standalone Node reproductions used earlier in TODO.md for the fork-
// curve math.
globalThis.__BLOW_ARENA_DEBUG__ = true;
import { createArena, addPlayer, blow, step } from './src/blow-arena.js';

const offEdges = [];
createArena({ radius: 12, onWentOffEdge: (id) => offEdges.push(id) });

// Case 1: gentle blow on a player standing close to centre — should NOT go off edge, should land upright.
const p1 = addPlayer({ startDistance: 2, startAngle: 0 });
// Case 2: strong blow, directly radially outward, on a player already near the edge — should go off edge.
// p2 starts at angle pi/2 -> position (9, 0, ~0); radially outward from centre is +x, so push direction is {1, 0}.
const p2 = addPlayer({ startDistance: 9, startAngle: Math.PI / 2 });
// Case 3: moderate blow, aimed to push it toward negative Z — should tumble and either recover or settle.
const p3 = addPlayer({ startDistance: 5, startAngle: Math.PI });

const outcome1 = blow(p1, { direction: 0, strength: 0.15 });
const outcome2 = blow(p2, { direction: { x: 1, z: 0 }, strength: 1.0 });
const outcome3 = blow(p3, { direction: Math.PI, strength: 0.5 });

let steps = 0;
const MAX_STEPS = 60 * 15; // 15 sim-seconds ceiling
const iv = setInterval(() => {
  step(1 / 60);
  steps++;
  if (steps >= MAX_STEPS) clearInterval(iv);
}, 0);

setTimeout(async () => {
  clearInterval(iv);
  const [r1, r2, r3] = await Promise.all([
    Promise.race([outcome1, Promise.resolve('PENDING')]),
    Promise.race([outcome2, Promise.resolve('PENDING')]),
    Promise.race([outcome3, Promise.resolve('PENDING')]),
  ]);
  console.log('steps run:', steps);
  console.log('p1 (gentle, near centre):', r1);
  console.log('p2 (strong, near edge, outward):', r2);
  console.log('p3 (moderate):', r3);
  console.log('offEdge callback fired for:', offEdges);
  process.exit(0);
}, 8000);
