/**
 * DEV ONLY: bot players, for testing the teacher's lobby, rounds and the
 * projector without a class of phones. Not imported by the app. From any
 * page on the dev server, in the browser console:
 *
 *   const { startBots } = await import('/src/dev/bots.js');
 *   const bots = await startBots('ABCDE', 6);   // game code, how many
 *   bots.leave('Zara'); bots.rejoin('Zara');      // drop out / come back
 *   bots.reload('Zara');                          // back at once, but out of its round
 *   bots.hold('Zara');                            // as a runner, stops where it is
 *   await startBots('ABCDE', 1, { offset: 6 });   // a late arrival
 *   bots.stop();
 *
 * Each bot is its own Supabase client (one connection can't hold several
 * presences on the same channel), joins the game's channel with a name and
 * a look, and plays its rounds the way a phone reports them (useLobby.js,
 * skyPath.js), so the teacher's board, real phones in the same team and the
 * projector all see it play:
 * - Moves with real recorded movement (tracks.json, from recordTracks.js
 *   and buildTracks.mjs): a walk across, a fall, a jetpack rescue, an
 *   abduction. Movement pings go to the team's channel and the rest to the
 *   main one, with a rising `seq`, as phones send them.
 * - Waits at each island until every teammate still in has arrived (the
 *   guide reads the next word only then), thinks, then chooses: right with
 *   probability `pCorrect`. Sends `choice-outcome` (for the projector).
 * - Claims the island-2 item on arrival if nobody has; with a jetpack, a
 *   wrong choice is a rescue. With the alien device, it sends the aliens at
 *   a player on another team a few islands later.
 * - Targeted, it stops on its next island under the green light, asks its
 *   guide, waits for the guide's go, then types RESIST (or fails to) with
 *   `defence-progress` updates, and is abducted or not.
 * - As a guide, it answers its team's defence requests in turn.
 * - Answers the projector's `report-state`, and reports `round-ended`.
 */
import { createClient } from '@supabase/supabase-js';
import { CHARACTERS, PALETTE } from '../skypath/characters.js';
import TRACKS from './tracks.json';

const NAMES = ['Zara', 'Milo', 'Indy', 'Bea', 'Sam', 'Kit', 'Hana', 'Omar', 'Lucia', 'Kenji', 'Amara', 'Felix', 'Priya', 'Tomas', 'Yuki', 'Noor', 'Mateo', 'Ines', 'Jun', 'Leila', 'Arjun', 'Sofia', 'Kofi', 'Elif'];
const N_FORKS = 6;
const PICKUP_FORK = 2;
const DEFENCE_WORD = 'RESIST';
// The phone's defence timings (skyPath.js MESSAGE_DISPLAY_MS + PAPER_SLIDE_MS
// + STAGE_GAP_MS before the panel drops; abductDefense.js's countdown).
const DEFENCE_PANEL_AFTER_MS = 3600;
const DEFENCE_COUNTDOWN_MS = 20000;
const rand = (a, b) => a + Math.random() * (b - a);
let sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Timers that a covered or background window doesn't slow down: a window
// the browser considers hidden gets a few timer callbacks a second, which
// turned 7-a-second movement pings into a stutter. Message-channel
// callbacks aren't slowed, so this checks due timers on every one. It keeps
// a CPU core busy while any bot is waiting, so it's only on when asked for
// (startBots's `unthrottled`), e.g. in Claude's preview pane.
function unthrottledSleep() {
  const due = [];
  const mc = new MessageChannel();
  let pumping = false;
  mc.port1.onmessage = () => {
    const now = performance.now();
    for (let i = due.length - 1; i >= 0; i--) {
      if (due[i].at <= now) due.splice(i, 1)[0].resolve();
    }
    if (due.length) mc.port2.postMessage(0);
    else pumping = false;
  };
  return (ms) =>
    new Promise((resolve) => {
      due.push({ at: performance.now() + ms, resolve });
      if (!pumping) {
        pumping = true;
        mc.port2.postMessage(0);
      }
    });
}

export async function startBots(
  code,
  count = 6,
  {
    offset = 0,
    pCorrect = 0.75, // chance of choosing the right word at a fork
    thinkMs = [1500, 5000], // after the team is all on the island, before choosing
    loadMs = [2500, 6000], // round start to standing on island 1 (a phone loading)
    pResist = 0.6, // chance of typing RESIST in time
    letterMs = [600, 1400], // per letter typed
    finishMs = null, // old fast mode: skip the movement, just report a result after [min, max] ms
    unthrottled = false, // see unthrottledSleep
  } = {},
) {
  if (unthrottled) sleep = unthrottledSleep();
  const url = import.meta.env.VITE_SUPABASE_URL;
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY;
  const CODE = code.toUpperCase();
  const log = [];
  const bots = [];

  for (let i = offset; i < offset + count; i++) {
    const name = NAMES[i % NAMES.length];
    const token = `bot_${name.toLowerCase()}_${i}`;
    const client = createClient(url, key, { realtime: { worker: true } }); // keep-alive that survives a hidden window (see supabase.js)
    const ch = client.channel(`lobby-${CODE}`, { config: { presence: { key: token } } });
    const meta = {
      token,
      roundId: null,
      displayName: name,
      groupId: null,
      characterKey: CHARACTERS[(i * 5) % CHARACTERS.length].key,
      colorHex: PALETTE[i % PALETTE.length].hex,
    };
    const bot = { name, token, client, ch, meta, gone: false, holding: false, team: null, round: null, seq: Date.now() };
    bots.push(bot);

    // ---- sending, as useLobby.js does
    const ensureTeam = (groupId) => {
      if (bot.team?.groupId === groupId) return;
      if (bot.team) client.removeChannel(bot.team.ch);
      const tch = client.channel(`lobby-${CODE}-team-${groupId}`);
      bot.team = { groupId, ch: tch, ready: false };
      const team = bot.team;
      tch.subscribe((st) => st === 'SUBSCRIBED' && (team.ready = true));
    };
    const sendState = (state) => {
      if (bot.gone) return;
      const payload = { token, seq: ++bot.seq, characterKey: meta.characterKey, displayName: name, colorHex: meta.colorHex, ...state };
      const target = state.phase === 'moving' && bot.team?.ready ? bot.team.ch : ch;
      target.send({ type: 'broadcast', event: 'player-state', payload });
    };
    const sendEvent = (kind, data = {}) => !bot.gone && ch.send({ type: 'broadcast', event: 'game-event', payload: { token, kind, ...data } });
    const send = (event, payload) => !bot.gone && ch.send({ type: 'broadcast', event, payload });

    // ---- what the bot hears
    const islands = new Map(); // token -> { forkIndex, out } (every team: the main channel's discrete reports)
    const groupOf = new Map(); // token -> groupId (presence + groups-updated)
    const guideOf = new Map(); // groupId -> guide token
    ch.on('presence', { event: 'sync' }, () => {
      for (const metas of Object.values(ch.presenceState())) {
        const m = metas[metas.length - 1];
        if (m?.token && m.groupId != null) groupOf.set(m.token, m.groupId);
      }
    });
    ch.on('broadcast', { event: 'groups-updated' }, ({ payload }) => {
      for (const [tok, g] of Object.entries(payload.assignments ?? {})) groupOf.set(tok, g);
      if (token in (payload.assignments ?? {})) {
        meta.groupId = payload.assignments[token];
        ensureTeam(meta.groupId);
        if (!bot.gone) ch.track(meta);
      }
    });
    ch.on('broadcast', { event: 'player-state' }, ({ payload }) => {
      if (payload.phase === 'resting') islands.set(payload.token, { forkIndex: payload.forkIndex, out: false });
      if (payload.phase === 'gone') islands.set(payload.token, { forkIndex: islands.get(payload.token)?.forkIndex ?? 1, out: true });
    });
    ch.on('broadcast', { event: 'round-ended' }, ({ payload }) => {
      islands.set(payload.token, { forkIndex: islands.get(payload.token)?.forkIndex ?? N_FORKS, out: true });
      if (bot.round) bot.round.done.add(payload.token);
    });
    ch.on('broadcast', { event: 'game-started' }, ({ payload }) => {
      guideOf.set(payload.groupId, payload.guideToken);
      for (const tok of payload.roster ?? []) islands.set(tok, { forkIndex: 1, out: false });
      const runner = (payload.roster ?? []).includes(token);
      const guide = payload.guideToken === token;
      if (bot.gone || (!runner && !guide)) return;
      if (bot.round) bot.round.cancelled = true;
      meta.roundId = payload.roundId;
      meta.groupId = payload.groupId;
      groupOf.set(token, payload.groupId);
      ensureTeam(payload.groupId);
      ch.track(meta);
      bot.round = {
        id: payload.roundId,
        groupId: payload.groupId,
        roster: payload.roster ?? [],
        pickup: payload.pickup ?? 'jetpack',
        claimedBy: null,
        holding: null, // 'jetpack' | 'abduction' | null
        island: 1,
        out: false,
        pendingAbduction: null, // { byToken }
        defenceStarted: false,
        guideQueue: [],
        guideBusy: null,
        done: new Set(),
        cancelled: false,
      };
      if (guide) log.push(`${name} guides team ${payload.groupId}`);
      if (runner) play(bot.round).catch((err) => log.push(`${name}: ${err.message}`));
    });
    ch.on('broadcast', { event: 'game-event' }, ({ payload }) => {
      const r = bot.round;
      if (!r || payload.token === token) return;
      const sameTeam = groupOf.get(payload.token) === r.groupId;
      if (payload.kind === 'pickup-claim' && sameTeam && !r.claimedBy) r.claimedBy = payload.token;
      if (payload.kind === 'abduct-target' && payload.targetToken === token) {
        if (r.out || r.island >= N_FORKS || r.pendingAbduction) sendEvent('abduct-result', { toToken: payload.token, outcome: 'fizzled', targetName: name });
        else r.pendingAbduction = { byToken: payload.token };
      }
      if (payload.kind === 'defence-start' && payload.targetToken === token) r.defenceStarted = true;
      // As the guide: answer the team's defence requests, one at a time.
      if (guideOf.get(r.groupId) === token && sameTeam) {
        if (payload.kind === 'defence-request') {
          r.guideQueue.push({ token: payload.token, name: payload.targetName });
          nextDefence(r);
        }
        if (payload.kind === 'defence-end' && r.guideBusy === payload.token) {
          r.guideBusy = null;
          nextDefence(r);
        }
      }
    });
    ch.on('broadcast', { event: 'report-state' }, () => {
      const r = bot.round;
      if (!r || r.roster.length === 0 || !r.roster.includes(token)) return;
      if (r.out) sendState({ phase: 'gone', forkIndex: r.island });
      else if (!r.moving) sendState({ phase: 'resting', forkIndex: r.island, powerupKind: r.holding });
    });
    ch.on('broadcast', { event: 'series-ended' }, () => log.push(`${name}: series ended`));

    const nextDefence = (r) => {
      if (r.guideBusy || !r.guideQueue.length) return;
      const next = r.guideQueue.shift();
      r.guideBusy = next.token;
      sendEvent('defence-start', { targetToken: next.token, targetName: next.name, guideName: name });
    };

    // ---- playing a round as a runner
    // One recorded track, sent as it was recorded. forkIndex: the fork it
    // left from until it comes to rest on the next.
    const playTrack = async (r, track, k, frame = null) => {
      r.moving = true;
      let t0 = performance.now();
      for (const s of track) {
        const due = t0 + s.t - performance.now();
        if (due > 0) await sleep(due);
        const heldAt = performance.now();
        while (bot.holding && !r.cancelled) await sleep(200);
        t0 += performance.now() - heldAt; // carry on from where it stopped
        if (r.cancelled || bot.gone) return false;
        let livePos = s.livePos;
        if (frame && livePos) livePos = { ...livePos, x: livePos.x + frame.x, z: livePos.z + frame.z };
        const forkIndex = s.phase === 'resting' ? k + 1 : k;
        sendState({ phase: s.phase, forkIndex: frame ? k : forkIndex, livePos, powerupKind: s.firing || s.detached ? 'jetpack' : r.holding, firing: s.firing, detached: s.detached, abducting: s.abducting, defending: s.defending });
      }
      r.moving = false;
      return true;
    };
    const finish = (r, success, extra) => {
      r.out = true;
      const result = { success, forkIndex: r.island, correctCount: r.correct, totalForks: N_FORKS, itemsCollected: r.claimedBy === token ? 1 : 0, resistCount: r.resists, jetpackKeptAtFinish: success && r.holding === 'jetpack', ...extra };
      send('round-ended', { token, roundId: r.id, result });
      log.push(`${name} ${success ? 'reached the temple' : `is out at island ${r.island}`} (${r.correct} right)`);
    };
    const teamAllAt = (r, k) =>
      r.roster.every((tok) => tok === token || r.done.has(tok) || islands.get(tok)?.out || (islands.get(tok)?.forkIndex ?? 1) >= k);
    const fireAliens = (r) => {
      const targets = [...islands.entries()].filter(
        ([tok, s]) => tok !== token && !s.out && s.forkIndex < N_FORKS && groupOf.get(tok) != null && groupOf.get(tok) !== r.groupId && guideOf.get(groupOf.get(tok)) !== tok,
      );
      if (!targets.length) return false;
      const [target] = targets[Math.floor(Math.random() * targets.length)];
      r.holding = null;
      sendState({ phase: 'resting', forkIndex: r.island, powerupKind: null });
      sendEvent('abduct-target', { targetToken: target, byName: name });
      log.push(`${name} sends the aliens after ${target}`);
      return true;
    };
    // Targeted: under the light, ask the guide, wait for the go, type or fail.
    const defend = async (r) => {
      const { byToken } = r.pendingAbduction;
      r.pendingAbduction = null;
      sendState({ phase: 'resting', forkIndex: r.island, powerupKind: r.holding, defending: true });
      sendEvent('defence-request', { targetName: name, characterKey: meta.characterKey });
      const t0 = performance.now();
      while (!r.defenceStarted && performance.now() - t0 < 15000 && !r.cancelled) await sleep(200);
      r.defenceStarted = false;
      await sleep(DEFENCE_PANEL_AFTER_MS);
      sendEvent('defence-progress', { countdownMs: DEFENCE_COUNTDOWN_MS, typed: '' });
      const resists = Math.random() < pResist;
      const letters = resists ? DEFENCE_WORD.length : Math.floor(rand(0, DEFENCE_WORD.length - 1));
      const started = performance.now();
      let typed = '';
      for (let i = 0; i < letters; i++) {
        await sleep(rand(...letterMs));
        typed += DEFENCE_WORD[i];
        sendEvent('defence-progress', { typed });
      }
      const outcome = resists && performance.now() - started < DEFENCE_COUNTDOWN_MS ? 'resisted' : 'abducted';
      if (outcome === 'abducted') await sleep(Math.max(0, DEFENCE_COUNTDOWN_MS - (performance.now() - started)));
      sendEvent('defence-end', { targetToken: token, targetName: name, outcome });
      sendEvent('abduct-result', { toToken: byToken, outcome, targetName: name });
      if (outcome === 'resisted') {
        r.resists++;
        sendState({ phase: 'resting', forkIndex: r.island, powerupKind: r.holding, defending: false });
        log.push(`${name} resisted the aliens`);
        await sleep(3000);
        return true;
      }
      log.push(`${name} was abducted at island ${r.island}`);
      if (TRACKS.abduct) await playTrack(r, TRACKS.abduct, r.island, TRACKS.frames[r.island - 1]);
      finish(r, false);
      return false;
    };
    async function play(r) {
      r.correct = 0;
      r.resists = 0;
      if (finishMs) {
        // The old fast mode: no movement, just a result.
        await sleep(rand(...finishMs));
        if (r.cancelled || bot.gone) return;
        r.correct = 2 + Math.floor(Math.random() * 5);
        return finish(r, Math.random() < 0.5);
      }
      await sleep(rand(...loadMs));
      if (r.cancelled) return;
      sendState({ phase: 'resting', forkIndex: 1, powerupKind: null });
      let fireAt = null; // with the alien device: the island to use it on
      for (let k = 1; k <= N_FORKS; k++) {
        r.island = k;
        if (r.pendingAbduction && !(await defend(r))) return;
        if (r.holding === 'abduction' && fireAt != null && k >= fireAt && fireAliens(r)) fireAt = null;
        // The guide reads the next word once everyone still in is here.
        while (!teamAllAt(r, k) && !r.cancelled) await sleep(300);
        await sleep(rand(...thinkMs));
        while (bot.holding && !r.cancelled) await sleep(200);
        if (r.cancelled || bot.gone) return;
        const correct = Math.random() < pCorrect;
        sendState({ phase: 'departing', forkIndex: k, powerupKind: r.holding });
        sendEvent('choice-outcome', { forkIndex: k, correct, powerupKind: r.holding });
        if (correct) {
          r.correct++;
          if (!(await playTrack(r, TRACKS.cross[k], k))) return;
          if (k === N_FORKS) return finish(r, true);
        } else if (r.holding === 'jetpack' && TRACKS.rescue[k]) {
          if (!(await playTrack(r, TRACKS.rescue[k], k))) return;
          r.holding = null; // one rescue uses it up
          sendState({ phase: 'resting', forkIndex: k + 1, powerupKind: null });
          log.push(`${name} was rescued by the jetpack at fork ${k}`);
          if (k === N_FORKS) return finish(r, true);
        } else {
          if (!(await playTrack(r, TRACKS.fall[k], k))) return;
          return finish(r, false);
        }
        // On the next island: the item, first come first served.
        if (k + 1 === PICKUP_FORK && !r.claimedBy) {
          r.claimedBy = token;
          r.holding = r.pickup;
          sendEvent('pickup-claim', {});
          sendState({ phase: 'resting', forkIndex: k + 1, powerupKind: r.holding });
          if (r.holding === 'abduction') fireAt = k + 1 + Math.floor(rand(0, 3));
          log.push(`${name} picked up the ${r.pickup}`);
        }
      }
    }

    await new Promise((resolve) => {
      ch.subscribe(async (status) => {
        if (status !== 'SUBSCRIBED') return;
        await ch.track(meta);
        resolve();
      });
    });
  }

  const find = (name) => bots.find((b) => b.name === name);
  return {
    log,
    bots,
    // A bot that has left neither shows in presence nor plays.
    async leave(name) {
      const b = find(name);
      b.gone = true;
      if (b.round) b.round.cancelled = true;
      await b.ch.untrack();
    },
    async rejoin(name) {
      const b = find(name);
      b.gone = false;
      b.meta.roundId = null; // a phone coming back has lost its round
      await b.ch.track(b.meta);
    },
    // A phone reloading mid-round: still connected, but out of its round.
    async reload(name) {
      const b = find(name);
      if (b.round) b.round.cancelled = true;
      b.meta.roundId = null;
      await b.ch.track(b.meta);
    },
    // A runner that stops where it is (a slow player), until released.
    hold(name, on = true) {
      find(name).holding = on;
    },
    stop() {
      for (const b of bots) {
        if (b.round) b.round.cancelled = true;
        if (b.team) b.client.removeChannel(b.team.ch);
        b.client.removeChannel(b.ch);
      }
    },
  };
}
