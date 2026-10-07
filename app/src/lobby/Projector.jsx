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
 * Changing team is a cloud wipe: the old team's camera rises and tilts up
 * (skyPath.js setLift) as a bank of cloud sweeps down over the screen;
 * under full cover the view cuts to the new team, whose camera starts high
 * and settles back down as the clouds clear upward (clouds moving down as
 * the camera rises, and up as it descends, as flying through them would
 * look). A request made mid-wipe waits its turn.
 *
 * Split screen (Luke: "Split screen is good"): when the director has two
 * big events on two teams at once, the second team's world slides in from
 * the right and takes half the screen; when one ends, the other widens back
 * to the whole screen. No wipe for either.
 *
 * On each world on screen (a "panel"): the team and the followed player,
 * top left; the word pair while they stand deciding, one above the other in
 * a random order per fork, never tied to a bridge or anyone's choice
 * (Luke); a caption for what's happening ("Zara (Team Three) sent the
 * aliens after Milo!"); during an abduction defence, the word being typed
 * and the ship's countdown (Luke: show "the typing progress"). No scores:
 * Luke wants them kept secret until the end.
 *
 * Between rounds and before the game: the join QR code (the board's own
 * cardboard card, qrCard.js) and a holding message. At the end of the
 * series: the victory scene (VictoryTown.jsx), as on the teacher's board.
 *
 * Keys: 1-4 team, left/right player, A the director, H hide the controls,
 * D the frames/messages readout and the director's candidates, F full
 * screen.
 */
import { useEffect, useRef, useState } from 'react';
import { supabase } from '../supabase.js';
import * as THREE from 'three';
import { mountSkyPath } from '../skypath/skyPath.js';
import { createDirector } from './director.js';
import { buildQrCard } from './qrCard.js';
import { joinUrl } from './sessionConfig.js';
import VictoryTown from './VictoryTown.jsx';

const MAX_TEAMS = 4;
// The cloud wipe, ms: covering (camera rising), held fully covered (the cut
// happens here), uncovering (camera settling).
const WIPE = { cover: 800, hold: 150, uncover: 950 };
const SPLIT_MS = 600; // the split screen's slide
const CLOUD = 'textures/cloud-dense.webp';
const CLOUD_FILL = '#e9ecf1'; // cloud-deck.png's own colour, behind the bank so it covers fully
const TEAM_WORDS = ['One', 'Two', 'Three', 'Four'];
const BACKGROUND = 'textures/mode-skytemple.jpg';
const DEFENCE_WORD = 'RESIST'; // abductDefense.js's TARGET_WORD
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
  const [layout, setLayout] = useState({ primary: null, secondary: null });
  const [view, setView] = useState(null); // what the overlays show, refreshed a few times a second
  const [showControls, setShowControls] = useState(true);
  const [showStats, setShowStats] = useState(true);
  const [seriesEnded, setSeriesEnded] = useState(false);
  const [victory, setVictory] = useState(null); // the victory scene's teams, once the series ends
  const [qrSrc, setQrSrc] = useState(null);
  const statsRef = useRef({ msgs: 0, frames: 0, mps: 0, fps: 0 });
  const wipeRef = useRef(null); // the cloud bank
  const wipeFrontRef = useRef(null); // a nearer layer of cloud, moving faster
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

  // Coverage 0 (clear) to 1 (screen covered): the bank's place, and the
  // nearer layer's, which travels further for a little depth.
  const placeClouds = (c) => {
    if (wipeRef.current) wipeRef.current.style.transform = `translateY(${-220 + c * 160}vh)`;
    if (wipeFrontRef.current) wipeFrontRef.current.style.transform = `translateY(${-70 + c * 140}vh)`;
  };
  // Switch the whole screen to team g's world, by cloud wipe (see the header).
  const goTo = (g) => {
    const tr = transRef.current;
    if (!worldsRef.current.has(g)) return;
    if (tr.busy) {
      tr.pending = g;
      return;
    }
    const from = layoutRef.current.primary;
    if (g === from) return;
    if (from == null || !worldsRef.current.has(from)) {
      applyLayout({ primary: g, secondary: null });
      return;
    }
    if (layoutRef.current.secondary != null) applyLayout({ primary: from, secondary: null });
    tr.busy = true;
    const t0 = performance.now();
    let cut = false;
    const easeIn = (x) => x * x;
    const easeOut = (x) => 1 - (1 - x) * (1 - x);
    for (const el of [wipeRef.current, wipeFrontRef.current]) if (el) el.style.display = 'block';
    const step = () => {
      const t = performance.now() - t0;
      const fromW = worldsRef.current.get(from);
      const toW = worldsRef.current.get(g);
      if (t < WIPE.cover) {
        const x = t / WIPE.cover;
        placeClouds(easeIn(x));
        fromW?.handle.setLift(x);
      } else if (t < WIPE.cover + WIPE.hold) {
        placeClouds(1);
        if (!cut) {
          cut = true;
          fromW?.handle.setLift(0);
          toW?.handle.setLift(1);
          applyLayout({ primary: g, secondary: null });
        }
      } else if (t < WIPE.cover + WIPE.hold + WIPE.uncover) {
        const x = (t - WIPE.cover - WIPE.hold) / WIPE.uncover;
        placeClouds(1 - easeOut(x));
        toW?.handle.setLift(1 - x);
      } else {
        placeClouds(0);
        toW?.handle.setLift(0);
        for (const el of [wipeRef.current, wipeFrontRef.current]) if (el) el.style.display = 'none';
        tr.busy = false;
        const next = tr.pending;
        tr.pending = null;
        if (next != null && next !== g) goTo(next);
        return;
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  };
  const goToRef = useRef(goTo);
  goToRef.current = goTo;
  const applyLayoutRef = useRef(applyLayout);
  applyLayoutRef.current = applyLayout;
  // DEV: hold the wipe at coverage c (0-1) with the team on screen lifted
  // by `lift`, for looking at a moment of it; __wipeAt(null) puts it away.
  if (import.meta.env.DEV) {
    window.__wipeAt = (c, lift = c) => {
      for (const el of [wipeRef.current, wipeFrontRef.current]) if (el) el.style.display = c == null ? 'none' : 'block';
      placeClouds(c ?? 0);
      worldsRef.current.get(layoutRef.current.primary)?.handle.setLift(c == null ? 0 : lift);
    };
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
    const director = createDirector();
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
      if (payload.seq != null) {
        const last = lastSeq.get(payload.token);
        if (last != null && payload.seq <= last) return;
        lastSeq.set(payload.token, payload.seq);
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
        send('report-state', {});
      }, 300);
      timers.push(poll);
      setSeriesEnded(false);
      setVictory(null);
      // The first team to start is shown; after that, whoever's choosing.
      const L = layoutRef.current;
      if (L.primary == null || !worlds.has(L.primary)) applyLayoutRef.current({ primary: round.groupId, secondary: null });
      else applyLayoutRef.current(L);
    };

    // Rounds already under way when this page opened (or reloaded): the
    // teacher's board answers `projector-hello` with them (teacherSession.js).
    const onRoundsNow = ({ rounds, seriesEnded: ended, victory: teams }) => {
      for (const r of rounds ?? []) {
        const w = worlds.get(r.groupId);
        if (w?.round.roundId === r.roundId) continue; // already showing it
        startWorld(r);
        if (r.over) worlds.get(r.groupId).over = true;
      }
      if (ended) setSeriesEnded(true); // (after startWorld, which clears it for a live round start)
      if (teams?.length) setVictory(teams);
    };

    main.on('presence', { event: 'sync' }, () => {
      for (const metas of Object.values(main.presenceState())) {
        const m = metas[metas.length - 1];
        if (m?.token) names.set(m.token, m.displayName);
      }
    });
    main.on('broadcast', { event: '*' }, ({ event, payload }) => {
      stats.msgs++;
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
        setSeriesEnded(true);
        if (payload.teams?.length) setVictory(payload.teams);
      }
    });
    main.subscribe((st) => st === 'SUBSCRIBED' && send('projector-hello', {}));
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
    // screen, or a cloud wipe to another team. A world is pointed at its
    // player before it comes on screen, so the camera is on them already.
    const direct = setInterval(() => {
      if (!autoRef.current) return;
      const d = director.decide();
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

  // Keys: 1-4 team, arrows player, A director, H controls, D readout.
  useEffect(() => {
    const onKey = (e) => {
      const n = Number(e.key);
      if (n >= 1 && n <= MAX_TEAMS && worldsRef.current.has(n)) {
        setAutoBoth(false); // by hand from here on, until A
        goToRef.current(n);
      } else if (e.key === 'h' || e.key === 'H') setShowControls((v) => !v);
      else if (e.key === 'd' || e.key === 'D') setShowStats((v) => !v);
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
  const waiting = !view || !view.anyRunning || seriesEnded;
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

      {/* The cloud wipe between teams: a bank of cloud on a solid core, so it
          covers the screen completely at its middle, and a nearer, faster
          layer in front. Parked out of sight above the screen. */}
      <div ref={wipeRef} style={{ position: 'absolute', left: '-10vw', width: '120vw', top: 0, height: '220vh', display: 'none', pointerEvents: 'none', transform: 'translateY(-220vh)' }}>
        {/* The core reaches well under both edges (the cloud art has a clear
            margin round it), fading in so its own edge never shows. */}
        <div style={{ position: 'absolute', left: 0, right: 0, top: '30vh', height: '160vh', background: `linear-gradient(transparent, ${CLOUD_FILL} 22vh, ${CLOUD_FILL} calc(100% - 22vh), transparent)` }} />
        <div style={{ position: 'absolute', left: 0, right: 0, top: 0, height: '55vh', background: `url(${CLOUD}) center bottom / 100% auto no-repeat` }} />
        <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: '55vh', background: `url(${CLOUD}) center bottom / 100% auto no-repeat`, transform: 'scaleY(-1)' }} />
      </div>
      <div ref={wipeFrontRef} style={{ position: 'absolute', left: '-30vw', width: '160vw', top: 0, height: '70vh', display: 'none', pointerEvents: 'none', transform: 'translateY(-70vh)', background: `url(${CLOUD}) center / 100% 100% no-repeat`, opacity: 0.9 }} />

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
          <span style={{ marginLeft: 'auto', opacity: 0.7 }}>1-4 team · arrows player · A director · H hide · D stats · F full screen</span>
        </div>
      )}
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

      {/* The abduction defence: the word being typed, and the ship's countdown. */}
      {p.defence && (
        <div style={{ ...PLAQUE, bottom: controls ? '22vh' : '18vh', top: 'auto', padding: `${1.4 * s}vh ${2 * s}vw` }}>
          <div style={{ display: 'flex', gap: `${0.6 * s}vw`, justifyContent: 'center' }}>
            {[...DEFENCE_WORD].map((ch, i) => {
              const done = i < p.defence.typed.length;
              return (
                <span key={i} style={{ width: `${4.2 * s}vh`, textAlign: 'center', borderBottom: '3px solid rgba(242,205,115,0.7)', font: `700 ${5 * s}vh/1.2 ${SERIF}`, color: done ? '#f2cd73' : 'rgba(244,236,216,0.18)' }}>
                  {done ? p.defence.typed[i] : ch}
                </span>
              );
            })}
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
