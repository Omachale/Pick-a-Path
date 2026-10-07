/**
 * DEV ONLY: cuts the runs recorded by recordTracks.js (app/recordings/*.json)
 * into the per-fork movement tracks the bots replay (bots.js), and writes
 * them to src/dev/tracks.json. Run from app/:  node src/dev/buildTracks.mjs
 *
 * Tracks, each a list of { t (ms from the track's start), phase, livePos,
 * firing, detached, abducting, defending } exactly as the game sent them:
 *   cross[k]  — fork k, chose right: 'departing', walk, 'resting' on k+1
 *               (fork 6: the walk into the temple)
 *   fall[k]   — fork k, chose wrong, no jetpack: through to 'gone'
 *   rescue[k] — fork k, chose wrong with a jetpack: rescued, 'resting' on k+1
 *   abduct    — taken by the aliens from an island: from the first
 *               'abducting' report to 'gone' (the defence before it is the
 *               bot's own doing), positions relative to the island
 *               (subtract its fork frame), so it plays at any island
 * powerupKind is left out: the bot sets what it holds itself.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const load = (name) => (existsSync(`recordings/${name}.json`) ? JSON.parse(readFileSync(`recordings/${name}.json`, 'utf8')) : null);
const r3 = (v) => Math.round(v * 1000) / 1000;
function clean(s, t0, frame = null) {
  let livePos = null;
  if (s.livePos) {
    livePos = {};
    for (const [k, v] of Object.entries(s.livePos)) livePos[k] = Array.isArray(v) ? v.map((q) => Math.round(q * 10000) / 10000) : r3(v);
    if (frame) {
      livePos.x = r3(livePos.x - frame.x);
      livePos.z = r3(livePos.z - frame.z);
    }
  }
  return { t: Math.round(s.t - t0), phase: s.phase, livePos, firing: s.firing, detached: s.detached, abducting: s.abducting, defending: s.defending };
}
// From the 'departing' report at fork k up to and including the first report
// that `ends` it.
function cut(log, k, ends) {
  const i0 = log.findIndex((s) => s.phase === 'departing' && s.forkIndex === k);
  if (i0 < 0) return null;
  const out = [];
  for (let i = i0; i < log.length; i++) {
    out.push(clean(log[i], log[i0].t));
    if (i > i0 && ends(log[i])) break;
  }
  return out;
}

const tracks = { frames: null, cross: {}, fall: {}, rescue: {}, abduct: null };
const ok = load('run-ok');
if (ok) {
  tracks.frames = ok.frames;
  for (let k = 1; k <= 6; k++) tracks.cross[k] = cut(ok.log, k, (s) => s.phase === 'resting' && s.forkIndex === k + 1);
}
for (let k = 1; k <= 6; k++) {
  const f = load(`fall-${k}`);
  if (f) tracks.fall[k] = cut(f.log, k, (s) => s.phase === 'gone');
  const r = load(`rescue-${k}`);
  if (r) tracks.rescue[k] = cut(r.log, k, (s) => s.phase === 'resting' && s.forkIndex === k + 1);
}
const a = load('abduct');
if (a) {
  const i0 = a.log.findIndex((s) => s.abducting);
  const frame = a.frames[a.log[i0].forkIndex - 1];
  const out = [];
  for (let i = i0; i < a.log.length; i++) {
    out.push(clean(a.log[i], a.log[i0].t, frame));
    if (a.log[i].phase === 'gone') break;
  }
  tracks.abduct = out;
}
writeFileSync('src/dev/tracks.json', JSON.stringify(tracks));
const count = (o) => Object.entries(o).map(([k, v]) => `${k}:${v ? v.length : '-'}`).join(' ');
console.log(`cross ${count(tracks.cross)}\nfall ${count(tracks.fall)}\nrescue ${count(tracks.rescue)}\nabduct ${tracks.abduct?.length ?? '-'}`);
