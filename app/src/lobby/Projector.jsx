/**
 * The projector: the public view on the big screen (Luke, 2026-10-07: "a
 * general view of what is happening in the game, following players around,
 * and particularly focusing on major events such as falls, aliens, and
 * jetpack rescues"). Runs on the teacher's PC, in its own window sent to the
 * projector or TV: `?projector=CODE`. The plan's six steps are in TODO.md.
 *
 * How it works: the page listens to the game's main channel and every
 * team's channel (movement pings go to the team's own one, see useLobby.js),
 * without appearing in presence, like the teacher's board. When a team's
 * round starts, it mounts a Sky Path world for that team in projector mode
 * (skyPath.js `projector`: no buttons, no words on the bridges, camera
 * pointed from here, drawing paused while off screen) and feeds it that
 * team's players' reports, exactly as a teammate's phone receives them.
 * Once a world has loaded, it asks every phone to report where it is
 * (`report-state`); opened or reloaded mid-round, it asks the teacher's
 * board for the rounds under way (`projector-hello` / `rounds-now`).
 *
 * Who and which team to show is the director's choice (director.js), on by
 * default. Choosing by hand turns it off; A turns it back on.
 *
 * Changing team is a short crossfade (TUNE.fadeS). It was a cloud wipe —
 * the camera rising into a bank of cloud and the new team's coming down out
 * of it — until Luke, 2026-10-10: "They are awful, and look like a glitch."
 * A request made mid-fade waits its turn. At a round's start nothing is put
 * on screen just because its world loaded first: the "get ready" screen
 * stays up until the director's chosen team's world is ready, then it cuts
 * straight there (the first team to load used to be shown, then wiped away
 * from a moment later).
 *
 * Split screen (Luke: "Split screen is good"): when the director has two
 * big events on two teams at once, the second team's world slides in from
 * the right and takes half the screen; when one ends, the other widens back
 * to the whole screen. No crossfade for either.
 *
 * On each world on screen (a "panel"): the team and the followed player,
 * top left; the word pair while they stand deciding, one above the other in
 * a random order per fork, never tied to a bridge or anyone's choice
 * (Luke); a caption for what's happening ("Zara (Team Three) sent the
 * aliens after Milo!"); during an abduction defence, the letters typed so
 * far and the ship's countdown (Luke: show "the typing progress"). Only the
 * letters typed, never the word itself or blanks for the rest (Luke,
 * 2026-10-10: showing the untyped letters "gives anyone watching the correct
 * answer"; blanks would still give its length). No scores:
 * Luke wants them kept secret until the end.
 *
 * Between rounds and before the game: the join QR code (the board's own
 * cardboard card, qrCard.js) and a holding message. At the end of the
 * series: the victory scene (VictoryTown.jsx), as on the teacher's board.
 *
 * Keys: 1-4 team, left/right player, A the director, H hide the controls,
 * D the frames/messages readout and the director's candidates, F full
 * screen, T the director's dials (TEMPORARY — see TunePanel).
 */
import { useEffect, useRef, useState } from 'react';
import { supabase } from '../supabase.js';
import * as THREE from 'three';
import { mountSkyPath } from '../skypath/skyPath.js';
import { createDirector, DIRECTOR_TUNE_DEFAULTS } from './director.js';
import { buildQrCard } from './qrCard.js';
import { joinUrl } from './sessionConfig.js';
import VictoryTown from './VictoryTown.jsx';
import { startMonitor } from './monitor.js';

const MAX_TEAMS = 4;
const PROJECTOR_HERE_MS = 10000; // see teacherSession.js projectorOpen
// TEMPORARY (director.js, CALMER): the director's dials, set live from the T
// panel and remembered in this browser across reloads, until Luke settles
// them and they're baked into DIRECTOR_TUNE_DEFAULTS.
const TUNE_KEY = 'skypath.projector.tune';
const TUNE = { ...DIRECTOR_TUNE_DEFAULTS };
try {
  Object.assign(TUNE, JSON.parse(localStorage.getItem(TUNE_KEY) || '{}'));
} catch {
  /* private window etc.: the defaults */
}
const SPLIT_MS = 600; // the split screen's slide
const TEAM_WORDS = ['One', 'Two', 'Three', 'Four'];
const BACKGROUND = 'textures/mode-skytemple.webp';
const teamName = (g) => `Team ${TEAM_WORDS[g - 1] ?? g}`;

// The same random order every time for a given round and fork, so the two
// words don't swap places each time the screen redraws.
function topFirst(roundId, fork) {
  let h = fork * 7919;
  for (const c of roundId) h = (h * 31 + c.charCodeAt(0)) | 0;
  return (h & 1) === 0;
}

export default function Projector({ code }) {
  const CODE = code.toUpperCase();
  const stageRef = useRef(null);
  const worldsRef = useRef(new Map()); // groupId -> { round, el, handle, ready, over }
  const [activeGroup, setActiveGroup] = useState(null); // the main panel's team
  const activeRef = useRef(null);
  const layoutRef = useRef({ primary: null, secondary: null });
  const monRef = useRef(null); // TEMPORARY test monitor (monitor.js)
  const mlog = (kind, data) => monRef.current?.log(kind, data);
  const [layout, setLayout] = useState({ primary: null, secondary: null });
  const [view, setView] = useState(null); // what the overlays show, refreshed a few times a second
  const [showControls, setShowControls] = useState(true);
  const [showStats, setShowStats] = useState(true);
  const [showTune, setShowTune] = useState(false); // the T panel (TEMPORARY)
  const [seriesEnded, setSeriesEnded] = useState(false);
  const [victory, setVictory] = useState(null); // the victory scene's teams, once the series ends
  const [qrSrc, setQrSrc] = useState(null);
  const statsRef = useRef({ msgs: 0, frames: 0, mps: 0, fps: 0 });
  const transRef = useRef({ busy: false, pending: null });
  const [auto, setAuto] = useState(true); // the director chooses (see the header)
  const autoRef = useRef(true);
  const setAutoBoth = (on) => {
    autoRef.current = on;
    setAuto(on);
    if (!on) applyLayout({ primary: layoutRef.current.primary, secondary: null }); // by hand: one team at a time
  };

  // Which worlds are on screen, and where: the main panel full width (or the
  // left half when split), the second panel the right half, sliding in from
  // and out to the right. Only the worlds on screen draw.
  function applyLayout(next) {
    const prev = layoutRef.current;
    layoutRef.current = next;
    if (prev.primary !== next.primary || prev.secondary !== next.secondary) mlog('layout', { from: prev, to: next });
    activeRef.current = next.primary;
    setLayout(next);
    setActiveGroup(next.primary);
    for (const [g, w] of worldsRef.current) {
      const el = w.el;
      if (g === next.primary) {
        el.style.visibility = 'visible';
        el.style.left = '0';
        el.style.width = next.secondary != null ? '50%' : '100%';
        w.handle.setActive(true);
      } else if (g === next.secondary) {
        if (prev.secondary !== g && prev.primary !== g) {
          // Slide in from off the right edge.
          el.style.transition = 'none';
          el.style.left = '100%';
          el.style.width = '50%';
          el.style.visibility = 'visible';
          void el.offsetWidth;
          el.style.transition = '';
        }
        el.style.left = '50%';
        el.style.width = '50%';
        el.style.visibility = 'visible';
        w.handle.setActive(true);
      } else if (g === prev.secondary) {
        // Slide out, then stop drawing.
        el.style.left = '100%';
        setTimeout(() => {
          const L = layoutRef.current;
          if (L.primary === g || L.secondary === g) return;
          el.style.visibility = 'hidden';
          w.handle.setActive(false);
        }, SPLIT_MS);
      } else {
        el.style.visibility = 'hidden';
        el.style.left = '0';
        el.style.width = '100%';
        w.handle.setActive(false);
      }
    }
  }

  // Switch the whole screen to team g's world, by a short crossfade (see the
  // header): the new world fades in over the old, then takes the screen.
  // Finished by a timer, not by animation frames, so a slow or stalled
  // frame can never leave it half done (the cloud wipe's cut was once
  // skipped that way, leaving the old team on screen).
  const goTo = (g) => {
    const tr = transRef.current;
    const toW = worldsRef.current.get(g);
    if (!toW) return;
    if (tr.busy) {
      if (tr.pending !== g) mlog('fade-queued', { to: g });
      tr.pending = g;
      return;
    }
    const from = layoutRef.current.primary;
    if (g === from) return;
    if (from == null || !worldsRef.current.has(from)) {
      mlog('cut', { to: g });
      applyLayout({ primary: g, secondary: null });
      return;
    }
    if (layoutRef.current.secondary != null) applyLayout({ primary: from, secondary: null });
    tr.busy = true;
    const ms = Math.round(TUNE.fadeS * 1000);
    mlog('fade-start', { from, to: g, ms });
    const el = toW.el;
    const base = el.style.transition; // the split's slide (see startWorld)
    el.style.transition = 'none';
    el.style.left = '0';
    el.style.width = '100%';
    el.style.opacity = '0';
    el.style.zIndex = '1';
    el.style.visibility = 'visible';
    toW.handle.setActive(true);
    void el.offsetWidth;
    el.style.transition = `${base}, opacity ${ms}ms ease`;
    el.style.opacity = '1';
    setTimeout(() => {
      el.style.transition = base;
      el.style.opacity = '';
      el.style.zIndex = '';
      if (worldsRef.current.get(g) === toW) applyLayout({ primary: g, secondary: null });
      tr.busy = false;
      mlog('fade-end', { to: g });
      const next = tr.pending;
      tr.pending = null;
      if (next != null && next !== g) goToRef.current(next);
    }, ms);
  };
  const goToRef = useRef(goTo);
  goToRef.current = goTo;
  const applyLayoutRef = useRef(applyLayout);
  applyLayoutRef.current = applyLayout;
  if (import.meta.env.DEV) {
    window.__split = (g) => applyLayoutRef.current({ primary: layoutRef.current.primary, secondary: g ?? null });
  }

  // The join QR code, for the screens between rounds.
  useEffect(() => {
    let alive = true;
    buildQrCard(joinUrl(CODE))
      .then((canvas) => alive && setQrSrc(canvas.toDataURL('image/png')))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [CODE]);

  useEffect(() => {
    const worlds = worldsRef.current;
    const director = createDirector({ tune: TUNE });
    // TEMPORARY test monitor (monitor.js): the one-second sample is the
    // layout, the director's shot, and every world's camera, frames and GPU
    // memory; events below log what arrives and what the projector does.
    const mon = (monRef.current = startMonitor('projector', {
      code: CODE,
      sample: () => {
        const dbg = director.debug();
        return {
          layout: layoutRef.current,
          auto: autoRef.current,
          fadeBusy: transRef.current.busy,
          fadePending: transRef.current.pending,
          shot: dbg.shot ? `${dbg.shot.type} T${dbg.shot.groupId} ${dbg.shot.token} ${dbg.shot.since.toFixed(1)}s` : null,
          second: dbg.second ? `${dbg.second.type} T${dbg.second.groupId} ${dbg.second.token}` : null,
          msgsPerS: stats.mps,
          worlds: [...worlds].map(([g, w]) => ({ g, ready: w.ready, over: w.over, round: w.round.roundId?.slice(0, 8), visible: w.el.style.visibility, ...(w.ready ? w.handle.monitorInfo() : {}) })),
        };
      },
    }));
    mon.log('tune', { ...TUNE });
    const names = new Map(); // token -> displayName (presence)
    const groupOf = new Map(); // token -> groupId (from round starts)
    const lastSeq = new Map(); // token -> highest seq seen (see useLobby.js)
    // For the captions: who sent the aliens at whom, each defence's typing
    // and countdown, how each defence ended, and who reached the temple.
    const attackers = new Map(); // target token -> { name, groupId }
    const defence = new Map(); // token -> { typed, countdownMs, at }
    const outcomes = new Map(); // token -> 'resisted' | 'abducted'
    const templeDone = new Set(); // tokens
    const stats = statsRef.current;
    const timers = [];
    // One renderer (one WebGL context) per team slot for the life of the
    // page, handed to each round's world (skyPath.js `renderer`): a world
    // making and destroying its own every round got WebGL blocked for the
    // page after a few rounds.
    const renderers = new Map(); // groupId -> THREE.WebGLRenderer
    const rendererFor = (g) => {
      if (!renderers.has(g)) renderers.set(g, new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' }));
      return renderers.get(g);
    };

    const main = supabase.channel(`lobby-${CODE}`);
    const teamChannels = [];
    const send = (event, payload) => main.send({ type: 'broadcast', event, payload });

    const onPlayerState = (payload) => {
      // Only a stale 'moving' ping is dropped; a discrete report never is
      // (see useLobby.js's lastSeqRef for why).
      if (payload.seq != null) {
        const last = lastSeq.get(payload.token);
        if (payload.phase === 'moving' && last != null && payload.seq <= last) return;
        if (last == null || payload.seq > last) lastSeq.set(payload.token, payload.seq);
      }
      director.playerState(payload.token, payload);
      const w = worlds.get(groupOf.get(payload.token));
      if (w?.ready) w.handle.updateTeammate(payload.token, payload);
    };

    const startWorld = (round) => {
      const old = worlds.get(round.groupId);
      if (old) {
        old.handle.dispose();
        old.el.remove();
      }
      for (const tok of [...round.roster, round.guideToken]) {
        groupOf.set(tok, round.groupId);
        attackers.delete(tok);
        defence.delete(tok);
        outcomes.delete(tok);
        templeDone.delete(tok);
      }
      director.roundStarted(round);
      const el = document.createElement('div');
      el.style.cssText = `position:absolute;top:0;bottom:0;left:0;width:100%;visibility:hidden;transition:left ${SPLIT_MS}ms ease, width ${SPLIT_MS}ms ease`;
      stageRef.current.appendChild(el);
      const handle = mountSkyPath(el, {
        forks: round.forks,
        words: round.words,
        role: 'watching',
        canAct: false,
        projector: true,
        roster: round.roster,
        myToken: null,
        pickup: round.pickup,
        guideToken: round.guideToken,
        getDisplayName: (tok) => names.get(tok) ?? null,
        renderer: rendererFor(round.groupId),
      });
      const w = { round, el, handle, ready: false, over: false };
      worlds.set(round.groupId, w);
      // Ready once the scene is built; then ask everyone where they are.
      const poll = setInterval(() => {
        if (worlds.get(round.groupId) !== w) return clearInterval(poll);
        if (!el.querySelector('#loader.done')) return;
        clearInterval(poll);
        w.ready = true;
        mon.log('world-ready', { g: round.groupId, round: round.roundId?.slice(0, 8) });
        send('report-state', {});
      }, 300);
      timers.push(poll);
      setSeriesEnded(false);
      setVictory(null);
      // Nothing goes on screen for loading first (see the header): if this
      // replaced a world on screen, the screen is cleared, and the director
      // cuts to its choice once that world is ready (goTo, from nothing).
      const L = layoutRef.current;
      if (L.primary === round.groupId || L.secondary === round.groupId) applyLayoutRef.current({ primary: null, secondary: null });
    };

    // Rounds already under way when this page opened (or reloaded): the
    // teacher's board answers `projector-hello` with them (teacherSession.js).
    // The series is over: the team worlds are finished with for good, so they
    // go — disposed, not just hidden. Left drawing under the victory scene,
    // one cost a full world's rendering every frame, and all four kept
    // updating (seen in the monitor log, 2026-10-10: the victory at 9-10 fps).
    // A new series' rounds make new ones. The renderers stay (see
    // rendererFor): making WebGL contexts afresh is what Chrome blocks.
    const discardWorlds = () => {
      for (const w of worlds.values()) {
        w.handle.dispose();
        w.el.remove();
      }
      worlds.clear();
      applyLayoutRef.current({ primary: null, secondary: null });
      mon.log('worlds-discarded');
    };

    const onRoundsNow = ({ rounds, seriesEnded: ended, victory: teams }) => {
      if (ended) {
        discardWorlds();
        setSeriesEnded(true);
        if (teams?.length) setVictory(teams);
        return;
      }
      for (const r of rounds ?? []) {
        const w = worlds.get(r.groupId);
        if (w?.round.roundId === r.roundId) continue; // already showing it
        startWorld(r);
        if (r.over) worlds.get(r.groupId).over = true;
      }
    };

    main.on('presence', { event: 'sync' }, () => {
      for (const metas of Object.values(main.presenceState())) {
        const m = metas[metas.length - 1];
        if (m?.token) names.set(m.token, m.displayName);
      }
    });
    main.on('broadcast', { event: '*' }, ({ event, payload }) => {
      stats.msgs++;
      if (event !== 'player-state' && !(event === 'game-event' && payload?.kind === 'defence-progress' && !payload.countdownMs)) {
        const brief = event === 'rounds-now' ? { rounds: (payload.rounds ?? []).map((r) => ({ g: r.groupId, round: r.roundId?.slice(0, 8), over: !!r.over })), seriesEnded: payload.seriesEnded } : event === 'game-started' ? { g: payload.groupId, round: payload.roundId?.slice(0, 8), roster: payload.roster, guide: payload.guideToken, pickup: payload.pickup } : payload;
        mon.log(`in:${event}${event === 'game-event' ? ':' + payload?.kind : ''}`, brief);
      } else if (event === 'player-state' && payload?.phase !== 'moving') mon.log('in:player-state', { token: payload.token, phase: payload.phase, fork: payload.forkIndex, abducting: payload.abducting || undefined, defending: payload.defending || undefined });
      if (event === 'player-state') onPlayerState(payload);
      else if (event === 'game-started') startWorld(payload);
      else if (event === 'rounds-now') onRoundsNow(payload);
      else if (event === 'game-event') {
        const k = payload.kind;
        if (k === 'pickup-claim') {
          const w = worlds.get(groupOf.get(payload.token));
          if (w?.ready) w.handle.applyGameEvent('pickup-claim', payload);
        } else if (k === 'choice-outcome') director.choice(payload.token, payload);
        else if (k === 'abduct-target') {
          director.abductTarget(payload.targetToken);
          attackers.set(payload.targetToken, { name: payload.byName ?? names.get(payload.token) ?? 'Someone', groupId: groupOf.get(payload.token) });
          outcomes.delete(payload.targetToken);
          defence.delete(payload.targetToken);
        } else if (k === 'defence-progress') {
          const d = defence.get(payload.token) ?? { typed: '', countdownMs: null, at: null };
          if (payload.countdownMs) Object.assign(d, { countdownMs: payload.countdownMs, at: performance.now() });
          d.typed = payload.typed ?? d.typed;
          defence.set(payload.token, d);
        } else if (k === 'defence-end') {
          director.defenceEnd(payload.targetToken, payload.outcome);
          outcomes.set(payload.targetToken, payload.outcome);
        }
      } else if (event === 'round-ended') {
        director.roundEnded(payload.token);
        if (payload.result?.success) templeDone.add(payload.token);
      } else if (event === 'round-over') {
        for (const w of worlds.values()) if (w.round.roundId === payload.roundId) w.over = true;
      } else if (event === 'series-ended') {
        discardWorlds();
        setSeriesEnded(true);
        if (payload.teams?.length) setVictory(payload.teams);
      }
    });
    main.subscribe((st) => {
      mon.log('channel', { status: st });
      if (st === 'SUBSCRIBED') send('projector-hello', {});
    });
    // Telling the board a projector is open (teacherSession.js projectorOpen).
    timers.push(setInterval(() => send('projector-here', {}), PROJECTOR_HERE_MS));
    for (let g = 1; g <= MAX_TEAMS; g++) {
      const ch = supabase.channel(`lobby-${CODE}-team-${g}`);
      ch.on('broadcast', { event: 'player-state' }, ({ payload }) => {
        stats.msgs++;
        onPlayerState(payload);
      });
      ch.subscribe();
      teamChannels.push(ch);
    }

    // Frames and messages per second.
    let raf = 0;
    const frame = () => {
      stats.frames++;
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    // DEV: the main world as a PNG, and the worlds themselves (for checking
    // from the console when this window isn't visible to look at).
    if (import.meta.env.DEV) {
      window.__projectorCapture = () => worlds.get(layoutRef.current.primary)?.handle.capture();
      window.__projectorWorlds = worlds;
    }
    const perSecond = setInterval(() => {
      stats.fps = stats.frames;
      stats.mps = stats.msgs;
      stats.frames = 0;
      stats.msgs = 0;
    }, 1000);

    // The director, when it's in charge: the player(s) it wants, then the
    // layout — the other half of a split, a half taking over the whole
    // screen, or a crossfade to another team. A world is pointed at its
    // player before it comes on screen, so the camera is on them already.
    let lastDecision = '';
    let lastCam = '';
    const direct = setInterval(() => {
      const pw = worlds.get(layoutRef.current.primary);
      if (pw?.ready) {
        const m = pw.handle.monitorInfo();
        const key = `${m.cam} ${m.pitchDeg}`;
        if (key !== lastCam) mon.log('cam', { g: layoutRef.current.primary, cam: m.cam, pitchDeg: m.pitchDeg, watching: m.watching, watched: m.watched });
        lastCam = key;
      }
      if (!autoRef.current) return;
      const d = director.decide();
      const key = d ? `${d.story.type} T${d.groupId} ${d.token}${d.second ? ` + ${d.second.story.type} T${d.second.groupId} ${d.second.token}` : ''}` : '-';
      if (key !== lastDecision) {
        mon.log('director', { decision: key, candidates: director.debug().candidates.slice(0, 5).map((c) => `${c.score} ${c.type} T${c.groupId} ${c.token} ${c.stage}`) });
        lastDecision = key;
      }
      if (!d) return;
      const w = worlds.get(d.groupId);
      if (!w?.ready) return;
      if (w.handle.snapshot().watching !== d.token) w.handle.watch(d.token);
      const w2 = d.second && worlds.get(d.second.groupId);
      if (w2?.ready && w2.handle.snapshot().watching !== d.second.token) w2.handle.watch(d.second.token);
      if (transRef.current.busy) return;
      const L = layoutRef.current;
      if (d.groupId === L.primary) {
        const sec = w2?.ready ? d.second.groupId : null;
        if (sec !== L.secondary) applyLayoutRef.current({ primary: L.primary, secondary: sec });
      } else if (d.groupId === L.secondary) {
        applyLayoutRef.current({ primary: d.groupId, secondary: null }); // the other half takes the screen
      } else goToRef.current(d.groupId);
    }, 250);
    timers.push(direct);

    // What each panel's overlays show.
    const name = (tok) => names.get(tok) ?? 'Someone';
    const captionFor = (story, p) => {
      if (!story || !p) return null;
      const n = name(story.token);
      if (story.type === 'abduction') {
        const out = outcomes.get(story.token);
        if (out === 'resisted') return `${n} fought off the aliens!`;
        if (out === 'abducted') return `${n} was abducted by the aliens!`;
        if (story.payoffAt) return `${n} is fighting off the aliens!`;
        const a = attackers.get(story.token);
        return a ? `${a.name}${a.groupId ? ` (${teamName(a.groupId)})` : ''} sent the aliens after ${n}!` : `The aliens are coming for ${n}!`;
      }
      if (story.type === 'rescue') {
        if (p.firing || (story.payoffAt && p.phase === 'resting')) return `Saved by the jetpack!`;
        if (p.airborne) return `${n} fell...`;
        return null;
      }
      if (story.type === 'fall') return p.airborne || p.phase === 'gone' ? `${n} fell!` : null;
      if (story.type === 'temple') return templeDone.has(story.token) ? `${n} reached the temple!` : null;
      return null;
    };
    const panelView = (g, storyHint) => {
      const w = worlds.get(g);
      if (!w?.ready) return null;
      const snap = w.handle.snapshot();
      const watched = snap.players.find((p) => p.token === snap.watching) ?? null;
      let words = null;
      if (watched && watched.phase === 'resting' && watched.forkIndex >= 1 && watched.forkIndex <= w.round.words.length) {
        const pair = w.round.words[watched.forkIndex - 1];
        words = topFirst(w.round.roundId, watched.forkIndex) ? [pair.a, pair.b] : [pair.b, pair.a];
      }
      const story = storyHint?.token === watched?.token ? storyHint : watched ? director.latestStory(watched.token) : null;
      const recent = story && (!story.ended || performance.now() / 1000 - story.ended < 4);
      const caption = recent ? captionFor(story, watched) : null;
      let def = null;
      if (story?.type === 'abduction' && !outcomes.get(story.token) && watched?.phase !== 'gone') {
        const d = defence.get(story.token);
        if (d?.at) def = { typed: d.typed, left: Math.max(0, 1 - (performance.now() - d.at) / d.countdownMs) };
      }
      // A defence is on: the word to type is RESIST, not this fork's pair.
      if (def) words = null;
      return { groupId: g, round: w.round, over: w.over, snap, watched, words, caption, defence: def };
    };
    const refresh = setInterval(() => {
      const L = layoutRef.current;
      const dbg = director.debug();
      setView({
        teams: [...worlds.entries()].sort((a, b) => a[0] - b[0]).map(([g, x]) => ({ groupId: g, ready: x.ready, over: x.over })),
        panels: [L.primary, L.secondary].filter((g) => g != null).map((g) => panelView(g, dbg.shot?.groupId === g ? dbg.shot : dbg.second?.groupId === g ? dbg.second : null)),
        anyRunning: [...worlds.values()].some((x) => !x.over),
        stats: { fps: stats.fps, mps: stats.mps },
        director: dbg,
        names: Object.fromEntries(names),
      });
    }, 250);
    timers.push(perSecond, refresh);

    return () => {
      mon.stop();
      monRef.current = null;
      cancelAnimationFrame(raf);
      for (const t of timers) clearInterval(t);
      for (const w of worlds.values()) {
        w.handle.dispose();
        w.el.remove();
      }
      worlds.clear();
      for (const r of renderers.values()) {
        r.dispose();
        r.forceContextLoss();
      }
      supabase.removeChannel(main);
      for (const ch of teamChannels) supabase.removeChannel(ch);
    };
  }, [CODE]);

  // Keys: 1-4 team, arrows player, A director, H controls, D readout, T dials.
  useEffect(() => {
    const onKey = (e) => {
      mlog('key', { key: e.key });
      const n = Number(e.key);
      if (n >= 1 && n <= MAX_TEAMS && worldsRef.current.has(n)) {
        setAutoBoth(false); // by hand from here on, until A
        goToRef.current(n);
      } else if (e.key === 'h' || e.key === 'H') setShowControls((v) => !v);
      else if (e.key === 'd' || e.key === 'D') setShowStats((v) => !v);
      else if (e.key === 't' || e.key === 'T') setShowTune((v) => !v);
      else if (e.key === 'a' || e.key === 'A') setAutoBoth(!autoRef.current);
      else if (e.key === 'f' || e.key === 'F') {
        if (document.fullscreenElement) document.exitFullscreen?.();
        else document.documentElement.requestFullscreen?.().catch(() => {});
      }
      else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        const w = worldsRef.current.get(layoutRef.current.primary);
        if (!w?.ready) return;
        const snap = w.handle.snapshot();
        const players = snap.players.filter((p) => p.visible && p.phase !== 'gone');
        if (!players.length) return;
        const i = players.findIndex((p) => p.token === snap.watching);
        const next = players[(i + (e.key === 'ArrowRight' ? 1 : players.length - 1)) % players.length];
        setAutoBoth(false);
        w.handle.watch(next.token);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const follow = (token) => {
    setAutoBoth(false);
    worldsRef.current.get(layoutRef.current.primary)?.handle.watch(token);
  };
  const mainPanel = view?.panels?.[0] ?? null;
  const split = layout.secondary != null;
  // (`!mainPanel`: the chosen world isn't on screen and ready yet — see the header.)
  const waiting = !view || !view.anyRunning || seriesEnded || !mainPanel;
  const beforeGame = !view?.teams.length;

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#000', overflow: 'hidden', fontFamily: 'system-ui, sans-serif' }}>
      <style>{PROJECTOR_CSS}</style>
      <div ref={stageRef} style={{ position: 'absolute', inset: 0 }} />

      {/* Each world on screen, with its overlays. */}
      {!waiting &&
        view.panels.map(
          (p, i) =>
            p && (
              <Panel key={p.groupId} p={p} left={i === 0 ? '0' : '50%'} width={split ? '50%' : '100%'} split={split} controls={showControls} />
            ),
        )}
      {!waiting && split && <div style={{ position: 'absolute', top: 0, bottom: 0, left: 'calc(50% - 2px)', width: 4, background: 'linear-gradient(#f2cd73, #c8953a)', boxShadow: '0 0 12px rgba(0,0,0,0.6)' }} />}

      {/* Before the game and between rounds: the join code, and a holding
          message (between rounds is a placeholder: Luke hasn't decided what
          goes there). */}
      {waiting && !victory && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '5vw', background: `#12212f url(${BACKGROUND}) center / cover no-repeat` }}>
          {qrSrc && <img src={qrSrc} alt="" style={{ height: beforeGame ? '82vh' : '52vh', filter: 'drop-shadow(0 12px 30px rgba(0,0,0,0.5))' }} />}
          <div style={{ ...PLAQUE, position: 'static', transform: 'none', padding: '3vh 3vw', maxWidth: '40vw' }}>
            <div style={{ ...GOLD_TEXT, font: `700 6vh/1.15 ${SERIF}` }}>{seriesEnded ? 'That was the last round!' : beforeGame ? 'Scan to join' : 'Get ready for the next round'}</div>
            <div style={{ font: `400 3vh/1.4 ${SERIF}`, color: '#f4ecd8', marginTop: '1.6vh' }}>
              Game code <b style={{ letterSpacing: '0.08em' }}>{CODE}</b>
            </div>
          </div>
        </div>
      )}

      {/* The end of the series: the victory scene, as on the board. */}
      {victory && <VictoryTown teams={victory} />}

      {/* Choosing by hand. */}
      {showControls && !victory && view?.teams.length > 0 && (
        <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, padding: '10px 14px', background: 'rgba(0,0,0,0.55)', color: '#fff', display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', font: '600 14px system-ui, sans-serif', zIndex: 30 }}>
          {view.teams.map((t) => (
            <button
              key={t.groupId}
              onClick={() => {
                setAutoBoth(false);
                goTo(t.groupId);
              }}
              style={chip(t.groupId === activeGroup)}
            >
              {t.groupId}. {teamName(t.groupId)}
              {!t.ready ? ' (loading)' : t.over ? ' (done)' : ''}
            </button>
          ))}
          <span style={{ width: 16 }} />
          <button onClick={() => setAutoBoth(!auto)} style={chip(auto)}>
            Director {auto ? 'on' : 'off'}
          </button>
          {mainPanel?.snap.players.map((p) => (
            <button key={p.token} onClick={() => follow(p.token)} style={{ ...chip(p.token === mainPanel.snap.watching), opacity: p.phase === 'gone' ? 0.45 : 1 }}>
              {p.displayName ?? '?'} · {p.phase === 'gone' ? 'out' : p.abducted ? 'abducted!' : p.airborne ? 'falling!' : `island ${p.forkIndex}`}
            </button>
          ))}
          <span style={{ marginLeft: 'auto', opacity: 0.7 }}>1-4 team · arrows player · A director · H hide · D stats · F full screen · T dials</span>
        </div>
      )}
      {showTune && <TunePanel onClose={() => setShowTune(false)} />}

      {showStats && (
        <div style={{ position: 'absolute', right: 10, top: 8, zIndex: 31, color: '#9f9', font: '12px ui-monospace, monospace', background: 'rgba(0,0,0,0.5)', padding: '3px 6px', borderRadius: 4 }}>
          {view?.stats.fps ?? 0} fps · {view?.stats.mps ?? 0} msg/s
          {view?.director && (
            <div style={{ marginTop: 4, color: '#dfe' }}>
              <div>
                shot: {view.director.shot ? `${view.director.shot.type} T${view.director.shot.groupId} ${nameOf(view, view.director.shot.token)} ${view.director.shot.since.toFixed(1)}s` : '—'}
                {view.director.second && ` + split ${view.director.second.type} T${view.director.second.groupId} ${nameOf(view, view.director.second.token)}`}
              </div>
              {view.director.candidates.map((c) => (
                <div key={c.id} style={{ opacity: c.id === view.director.shot?.id ? 1 : 0.75 }}>
                  {String(c.score).padStart(3)} {c.type} T{c.groupId} {nameOf(view, c.token)} ({c.stage})
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** One world's overlays: team and player, the words, the event caption, the defence. */
// TEMPORARY: the director's dials (director.js, CALMER), so Luke can set them
// by eye on the big screen. Each change applies at once and is remembered in
// this browser; "Copy" puts the values on the clipboard to send to Claude,
// who bakes them into DIRECTOR_TUNE_DEFAULTS — then this panel goes.
const TUNE_DIALS = [
  { key: 'minShotS', label: 'Shortest shot', min: 2, max: 20, step: 0.5, unit: 's', note: 'before the camera may cut to something else' },
  { key: 'minTeamS', label: 'Shortest stay on a team', min: 5, max: 60, step: 1, unit: 's', note: 'before changing to another team (a rescue or abduction may still call it away)' },
  { key: 'holdS', label: 'Hold after an event', min: 0, max: 6, step: 0.5, unit: 's', note: 'extra time on a finished event before moving on' },
  { key: 'playerStick', label: 'Stay with the same player', min: 1, max: 3, step: 0.1, unit: '×', note: 'preference for their next moment, when free to choose' },
  { key: 'splitMinS', label: 'Shortest split screen', min: 0, max: 15, step: 0.5, unit: 's', note: 'once it opens' },
  { key: 'splitGapS', label: 'Time between split screens', min: 0, max: 180, step: 5, unit: 's', note: 'at least this long from one opening to the next' },
  { key: 'fadeS', label: 'Crossfade length', min: 0.1, max: 2, step: 0.1, unit: 's', note: 'between teams' },
  { key: 'fallsChangeTeam', label: 'A fall may call the camera to another team', bool: true },
  { key: 'fallsSplit', label: 'A fall may open a split screen', bool: true },
];
function TunePanel({ onClose }) {
  const [, redraw] = useState(0);
  const set = (k, v) => {
    TUNE[k] = v;
    try {
      localStorage.setItem(TUNE_KEY, JSON.stringify(TUNE));
    } catch {
      /* not remembered, still applied */
    }
    redraw((n) => n + 1);
  };
  const values = JSON.stringify(TUNE);
  return (
    <div style={{ position: 'absolute', top: 12, right: 12, zIndex: 40, width: 360, maxHeight: 'calc(100vh - 24px)', overflowY: 'auto', padding: '12px 14px', borderRadius: 10, background: 'rgba(10,14,20,0.88)', color: '#f4ecd8', font: '13px/1.35 system-ui, sans-serif' }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8 }}>
        <b style={{ fontSize: 14 }}>Director dials</b>
        <span style={{ marginLeft: 8, opacity: 0.6 }}>temporary · T to hide</span>
        <button onClick={onClose} style={{ ...chip(false), marginLeft: 'auto' }}>×</button>
      </div>
      {TUNE_DIALS.map((d) =>
        d.bool ? (
          <label key={d.key} style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '8px 0' }}>
            <input type="checkbox" checked={!!TUNE[d.key]} onChange={(e) => set(d.key, e.target.checked)} />
            {d.label}
          </label>
        ) : (
          <div key={d.key} style={{ margin: '8px 0' }}>
            <div style={{ display: 'flex' }}>
              <span>{d.label}</span>
              <b style={{ marginLeft: 'auto' }}>
                {TUNE[d.key]}
                {d.unit}
              </b>
            </div>
            <input type="range" min={d.min} max={d.max} step={d.step} value={TUNE[d.key]} onChange={(e) => set(d.key, Number(e.target.value))} style={{ width: '100%' }} />
            <div style={{ opacity: 0.55, fontSize: 11 }}>{d.note}</div>
          </div>
        ),
      )}
      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <button onClick={() => navigator.clipboard?.writeText(values)} style={chip(false)}>
          Copy values
        </button>
        <button onClick={() => Object.entries(DIRECTOR_TUNE_DEFAULTS).forEach(([k, v]) => set(k, v))} style={chip(false)}>
          Reset
        </button>
      </div>
      <div style={{ marginTop: 8, opacity: 0.6, fontSize: 11, wordBreak: 'break-all' }}>{values}</div>
    </div>
  );
}

function Panel({ p, left, width, split, controls }) {
  const s = split ? 0.72 : 1; // everything a little smaller in a half
  return (
    <div style={{ position: 'absolute', top: 0, bottom: 0, left, width, pointerEvents: 'none', transition: `left ${SPLIT_MS}ms ease, width ${SPLIT_MS}ms ease` }}>
      {/* Team and followed player. */}
      <div style={{ ...PLAQUE, left: '1.6vw', top: '2vh', transform: 'none', padding: `${1 * s}vh ${1.4 * s}vw ${1.2 * s}vh`, textAlign: 'left' }}>
        <div style={{ font: `700 ${2.4 * s}vh/1.1 ${SERIF}`, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'rgba(242,205,115,0.9)' }}>{teamName(p.groupId)}</div>
        {p.watched && <div style={{ ...GOLD_TEXT, font: `700 ${4.4 * s}vh/1.15 ${SERIF}` }}>{p.watched.displayName}</div>}
        {p.over && <div style={{ font: `italic 400 ${2.2 * s}vh/1.3 ${SERIF}`, color: '#f4ecd8' }}>finished the round</div>}
      </div>

      {/* The word pair, one above the other, with "or" between. Luke: "slightly
          larger and look a bit nicer... slightly more stylish" (not cardboard):
          gold lettering in a temple-ish serif on a dark plaque with a fine
          double gold border. Palatino and friends ship with Windows and macOS,
          so no font file is needed for the projector PC. */}
      {p.words && (
        <div style={{ ...PLAQUE, top: '3vh', minWidth: `${26 * s}vw`, padding: `${1.6 * s}vh ${3.2 * s}vw ${1.8 * s}vh` }}>
          <div style={{ ...GOLD_TEXT, font: `700 ${8.5 * s}vh/1.1 ${SERIF}` }}>{p.words[0]}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '1.2vw', margin: '0.4vh 0' }}>
            <span style={RULE} />
            <span style={{ font: `italic 400 ${2.8 * s}vh/1 ${SERIF}`, color: 'rgba(240,222,176,0.8)' }}>or</span>
            <span style={RULE} />
          </div>
          <div style={{ ...GOLD_TEXT, font: `700 ${8.5 * s}vh/1.1 ${SERIF}` }}>{p.words[1]}</div>
        </div>
      )}

      {/* The abduction defence: the letters typed so far (only those — see the
          header), a blinking caret, and the ship's countdown. */}
      {p.defence && (
        <div style={{ ...PLAQUE, bottom: controls ? '22vh' : '18vh', top: 'auto', padding: `${1.4 * s}vh ${2 * s}vw` }}>
          <div style={{ display: 'flex', gap: `${0.6 * s}vw`, justifyContent: 'center', alignItems: 'center', minWidth: `${24 * s}vh`, height: `${6 * s}vh` }}>
            {[...p.defence.typed].map((ch, i) => (
              <span key={i} style={{ width: `${4.2 * s}vh`, textAlign: 'center', font: `700 ${5 * s}vh/1.2 ${SERIF}`, color: '#f2cd73' }}>
                {ch}
              </span>
            ))}
            <span style={{ width: 3, height: `${4.6 * s}vh`, background: '#f2cd73', animation: 'projCaret 1s steps(1) infinite' }} />
          </div>
          <div style={{ marginTop: '1.2vh', height: `${0.9 * s}vh`, borderRadius: 4, background: 'rgba(255,255,255,0.12)', overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${p.defence.left * 100}%`, background: 'linear-gradient(90deg, #7ef0a0, #3fc46a)', transition: 'width 250ms linear' }} />
          </div>
        </div>
      )}

      {/* What's happening. Keyed by its text, so each new caption rises in. */}
      {p.caption && (
        <div key={p.caption} style={{ ...PLAQUE, top: 'auto', bottom: controls ? '9vh' : '5vh', padding: `${1.3 * s}vh ${2.4 * s}vw`, animation: 'projCaptionIn 450ms ease-out' }}>
          <div style={{ ...GOLD_TEXT, font: `700 ${4.6 * s}vh/1.15 ${SERIF}`, whiteSpace: 'nowrap' }}>{p.caption}</div>
        </div>
      )}
    </div>
  );
}

// A player's name for the debug readout (the director's tokens).
const nameOf = (view, token) => view.names?.[token] ?? token.replace(/^bot_|_\d+$/g, '');

const SERIF = "'Palatino Linotype', Palatino, 'Book Antiqua', Constantia, Georgia, serif";
// The plaque everything sits on: dark, with a fine double gold border.
const PLAQUE = {
  position: 'absolute',
  left: '50%',
  transform: 'translateX(-50%)',
  textAlign: 'center',
  borderRadius: 14,
  background: 'linear-gradient(180deg, rgba(16,24,38,0.86), rgba(10,15,26,0.78))',
  border: '2px solid rgba(231,196,120,0.8)',
  // A second, finer gold line just inside the first.
  boxShadow: '0 10px 32px rgba(0,0,0,0.45), inset 0 0 0 5px rgba(10,15,26,0.7), inset 0 0 0 6px rgba(231,196,120,0.4)',
};
// Gold lettering, lighter at the top, as if lit from above.
const GOLD_TEXT = {
  letterSpacing: '0.03em',
  background: 'linear-gradient(180deg, #fff6dc 10%, #f2cd73 55%, #c8953a 95%)',
  WebkitBackgroundClip: 'text',
  backgroundClip: 'text',
  color: 'transparent',
  filter: 'drop-shadow(0 2px 2px rgba(0,0,0,0.55))',
};
const RULE = { flex: 1, height: 1, background: 'linear-gradient(90deg, transparent, rgba(231,196,120,0.7), transparent)' };
const PROJECTOR_CSS = `
@keyframes projCaptionIn {
  from { opacity: 0; transform: translate(-50%, 3vh); }
  to { opacity: 1; transform: translate(-50%, 0); }
}
@keyframes projCaret {
  50% { opacity: 0; }
}`;

const chip = (on) => ({
  padding: '6px 10px',
  borderRadius: 8,
  border: 0,
  cursor: 'pointer',
  font: 'inherit',
  background: on ? '#ffe9b8' : 'rgba(255,255,255,0.15)',
  color: on ? '#12212f' : '#fff',
});
