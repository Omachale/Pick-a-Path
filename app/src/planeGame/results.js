/**
 * Turning a finished throw into words a player can act on.
 *
 * Luke's rule: no numbers and no suggested values. So a result says WHAT
 * happened and WHICH WAY it was off, in short plain English for ESL
 * players, and names the cause when there's a clear one (the wind pushed
 * it, it stalled), alongside a little top-down map (ui.js) that shows the
 * same thing as a picture: where it ended against the rings, and the wind.
 *
 * Everything is measured in the target's own frame: "along" is distance
 * beyond the middle (negative = short), "side" is distance right of the
 * line from the thrower to the middle (negative = left).
 */

import { scoreThrow } from './course.js';
import { sampleAt } from './flight.js';

function frame(target) {
  const b = Math.atan2(target.x, -target.z);
  return { dir: { x: Math.sin(b), z: -Math.cos(b) }, right: { x: Math.cos(b), z: Math.sin(b) } };
}
export function toTargetFrame(target, x, z) {
  const f = frame(target);
  const dx = x - target.x;
  const dz = z - target.z;
  return { along: dx * f.dir.x + dz * f.dir.z, side: dx * f.right.x + dz * f.right.z };
}

/** Where a throw "ended" for the purposes of saying how far off it was. */
function endPoint(target, flight) {
  const e = flight.end;
  if (e.type === 'landed' || e.type === 'crashed') return { x: e.x, z: e.z };
  // Fell: where it passed down through the target's height. If it never
  // got that high (a target above the rim), where it came closest to it.
  let above = false;
  let best = null;
  for (let i = 0; i < flight.count; i++) {
    const s = sampleAt(flight, i);
    if (s.y >= target.y) above = true;
    else if (above) return { x: s.x, z: s.z };
    const d = Math.hypot(s.x - target.x, s.z - target.z);
    if (!best || d < best.d) best = { d, x: s.x, z: s.z };
  }
  return best ? { x: best.x, z: best.z } : { x: e.x, z: e.z };
}

const dirWords = (along, side, r) => {
  const parts = [];
  const big = (v) => Math.abs(v) > r * 1.6;
  if (Math.abs(along) > r * 0.35) parts.push({ key: along < 0 ? 'short' : 'long', big: big(along), v: Math.abs(along) });
  if (Math.abs(side) > r * 0.35) parts.push({ key: side < 0 ? 'left' : 'right', big: big(side), v: Math.abs(side) });
  parts.sort((a, b) => b.v - a.v);
  return parts;
};
/**
 * Small inline icons (emoji render differently, or not at all, across the
 * phones and laptops in a classroom; these always look the same). Arrows
 * point the way the throw went on the result map: up is further away.
 */
const svg = (body) => `<svg class="ico" viewBox="-10 -10 20 20">${body}</svg>`;
const arrow = (deg) => svg(`<path transform="rotate(${deg})" d="M0 -8 L6 0 L2 0 L2 8 L-2 8 L-2 0 L-6 0 Z" fill="currentColor"/>`);
export const ICONS = {
  short: arrow(180),
  long: arrow(0),
  left: arrow(-90),
  right: arrow(90),
  wind: svg('<path d="M-8 -4 H3 a3 3 0 1 0 -3 -3 M-8 1 H6 a3 3 0 1 1 -3 3 M-8 6 H0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'),
  stall: svg('<path d="M-8 6 Q-4 -9 2 -6 Q6 -4 4 8" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><path d="M1 4 L4 9 L7 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'),
  centre: svg('<circle r="7" fill="none" stroke="currentColor" stroke-width="2"/><circle r="2.6" fill="currentColor"/>'),
  tip: svg('<path d="M0 -8 a5.5 5.5 0 0 1 3.5 9.8 V4 h-7 V1.8 A5.5 5.5 0 0 1 0 -8 Z M-3 6 h6 M-2 8 h4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>'),
};
const PHRASE = {
  short: { a: 'A bit short', b: 'Too short' },
  long: { a: 'A bit too far', b: 'Too far' },
  left: { a: 'A bit left', b: 'Too far left' },
  right: { a: 'A bit right', b: 'Too far right' },
};
const line = (icon, text) => `${ICONS[icon]}<span>${text}</span>`;

/**
 * @returns {{title, why, stars, tone, map, end: {along, side}}}
 */
export function describeThrow(target, flight, islands, ghosts = []) {
  const stars = scoreThrow(target, flight, islands);
  const e = flight.end;
  const p = endPoint(target, flight);
  const { along, side } = toTargetFrame(target, p.x, p.z);
  const r = target.r;
  const f = frame(target);

  // How much of the miss the wind accounts for, in the target's frame.
  const wd = flight.windDrift;
  const windAlong = wd.x * f.dir.x + wd.z * f.dir.z;
  const windSide = wd.x * f.right.x + wd.z * f.right.z;

  const lines = [];
  const parts = dirWords(along, side, r);
  let title;
  let tone = 'miss';

  const onTarget = e.type === 'landed' && islands[e.island].id === target.id;
  if (onTarget) {
    if (stars === 3) {
      title = 'Bullseye!';
      tone = 'good';
      lines.push(line('centre', 'Right in the middle!'));
    } else {
      title = stars === 2 ? 'Great throw!' : 'On the island!';
      tone = stars === 2 ? 'good' : 'ok';
      if (parts.length) lines.push(line(parts[0].key, PHRASE[parts[0].key].a));
    }
  } else {
    if (e.type === 'landed') title = 'Wrong island!';
    else if (e.type === 'crashed' && islands[e.island].id === target.id) title = 'It hit the side!';
    else if (e.type === 'crashed') title = 'It hit an island!';
    else if (parts.length) title = PHRASE[parts[0].key][parts[0].big ? 'b' : 'a'] + '!';
    else title = 'So close!';
    if (title === 'It hit the side!') lines.push(line('short', 'A little too low'));
    else {
      const ps = e.type === 'fell' ? parts.slice(1) : parts;
      for (const q of ps.slice(0, 2)) lines.push(line(q.key, PHRASE[q.key][q.big ? 'b' : 'a']));
    }
  }

  // The cause, when there's a clear one.
  const sideMiss = Math.abs(side) > r * 0.5;
  if (sideMiss && Math.sign(windSide) === Math.sign(side) && Math.abs(windSide) > Math.max(1.2, Math.abs(side) * 0.5)) {
    lines.push(line('wind', `The wind blew it ${side < 0 ? 'left' : 'right'}`));
  } else if (along > r * 0.5 && windAlong > Math.max(1.5, along * 0.5)) {
    lines.push(line('wind', 'The wind carried it too far'));
  } else if (along < -r * 0.5 && windAlong < -Math.max(1.5, -along * 0.5)) {
    lines.push(line('wind', 'The wind held it back'));
  }
  if (flight.stalled && along < -r * 0.5) lines.push(line('stall', 'Too steep: it stalled and dropped'));

  // Earlier throws at this target, for the map.
  const map = {
    r,
    end: { along, side },
    ghosts,
    wind: { speed: Math.hypot(target.windVec?.x ?? 0, target.windVec?.z ?? 0), mapAngle: 0 },
  };
  if (target.windVec) {
    const wa = target.windVec.x * f.dir.x + target.windVec.z * f.dir.z;
    const ws = target.windVec.x * f.right.x + target.windVec.z * f.right.z;
    map.wind.mapAngle = Math.atan2(ws, wa);
  }

  return {
    title,
    why: lines.map((l) => `<div>${l}</div>`).join(''),
    stars,
    tone,
    map,
    end: { along, side },
    endWorld: { x: p.x, z: p.z },
  };
}
