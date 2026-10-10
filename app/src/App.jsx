/**
 * Top-level view switch, following useLobby's round-phase state machine
 * (Stage D): lobby -> [assigning, still the lobby view] -> playing -> results
 * -> back to lobby. A game doesn't replace the lobby, it sits on top of it
 * and hands control back when the round ends — the "persistent lobby"
 * decision from the handoff doc.
 *
 * `?solo=1` bypasses the lobby entirely and mounts Sky Path directly with
 * `?forks=`/`role=` read from the URL, exactly like the old standalone
 * prototype did. Dev-only convenience for iterating on the game itself
 * without needing Supabase or a second device — not part of the real app's
 * user-facing flow, and not gated behind import.meta.env.DEV because it's
 * harmless in production (an ordinary player has no reason to add it).
 *
 * `?cavern=1` does the same for the stage-2 Lava Cavern spike, with an
 * optional `&spokes=1..4`. Separate from Sky Path on purpose for now — Luke,
 * 2026-09-08: "Make it a separate thing for now and we'll stitch them
 * together once they're ready."
 *
 * Simplified 2026-09-11, Luke: no more roster/identity-store swap (a session
 * code just scopes which lobby channel a device joins, via `sessionCode`
 * below — see useLobby.js's own header comment for why), and the teacher's
 * own Supabase auth session is now tracked only inside TeacherDashboard.jsx,
 * since nothing outside it needs to know about it any more (the plain
 * Lobby screen no longer has a teacher-only branch — group management and
 * starting rounds both live on the teacher's dashboard now).
 */
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { useLobby } from './lobby/useLobby.js';
import Lobby from './lobby/Lobby.jsx';
import PlayerJoin from './lobby/PlayerJoin.jsx';
import RoundOver from './lobby/RoundOver.jsx';
import RunScore from './lobby/RunScore.jsx';

// Each heavy screen is its own download, fetched only when it's shown
// (2026-10-10, after 30 s+ loads on school Wi-Fi): a phone never needs the
// teacher's lobby board, dashboard or projector, and the teacher's PC never
// needs the game test modes. The small screens a phone sees first (join,
// waiting, scores) stay in the main file so they appear at once. A phone
// starts fetching the game itself as soon as it's on the join screen (see
// prefetchGame below), so it's normally ready before the round starts.
const loadGameRoom = () => import('./lobby/GameRoom.jsx');
const GameRoom = lazy(loadGameRoom);
const VictoryStage = lazy(() => import('./victory/VictoryStage.jsx'));
const SkyPath = lazy(() => import('./skypath/SkyPath.jsx'));
const LavaCavern = lazy(() => import('./cavern/LavaCavern.jsx'));
const TeacherDashboard = lazy(() => import('./lobby/TeacherDashboard.jsx'));
const KeyboardTestHarness = lazy(() => import('./keyboard/KeyboardTestHarness.jsx'));
const LobbyBoard = lazy(() => import('./lobby/LobbyBoard.jsx'));
const Projector = lazy(() => import('./lobby/Projector.jsx'));
import { TEACHER_SIGN_IN } from './lobby/sessionConfig.js';

const params = new URLSearchParams(location.search);

function SoloSkyPath() {
  const gameRef = useRef(null);
  return (
    <div style={{ position: 'fixed', inset: 0 }}>
      <SkyPath
        forks={params.get('forks')}
        role={params.get('role') === 'player' ? 'player' : params.get('role') === 'watching' ? 'watching' : 'guide'}
        crowd={Number(params.get('crowd')) || 0}
        // Dev-only convenience, same reasoning as forks=/role= above — lets
        // Watch mode's "resume mid-round instead of restarting at fork 1"
        // fix (see skyPath.js's initialGuideIsland) be tested directly with
        // ?role=watching&guideIsland=N, without needing a real fall over a
        // real network to reach it.
        initialGuideIsland={Number(params.get('guideIsland')) || null}
        // Dev-only, for exercising fixed seating without a real room —
        // e.g. ?solo=1&roster=a,b,c&myToken=b seats "b" one slot right of
        // centre. Omit both (the common case) and every device gets no
        // seat offset, same as before this existed.
        roster={params.get('roster')?.split(',').filter(Boolean) ?? []}
        myToken={params.get('myToken')}
        // Dev-only: force which item sits on island 2 (`jetpack` |
        // `abduction`); omit for the same 50/50 draw a real round gets.
        pickup={params.get('pickup')}
        gameRef={gameRef}
        onRoundEnd={(result) => console.log('[round end]', result)}
      />
    </div>
  );
}

function SoloLavaCavern() {
  return (
    <div style={{ position: 'fixed', inset: 0 }}>
      <LavaCavern spokes={Number(params.get('spokes')) || 4} />
    </div>
  );
}

/**
 * Dev-only, `?victory=1[&players=N]` — mounts the victory stage directly
 * against made-up scores, no lobby/Supabase/real round needed. Same
 * reasoning as `?solo=1`/`?cavern=1`: this scene's own look/layout/timing
 * is what's being iterated on, not the round lifecycle that would normally
 * feed it.
 */
function SoloVictoryStage() {
  const n = Math.max(1, Math.min(6, Number(params.get('players')) || 4));
  const roster = Array.from({ length: n }, (_, i) => `p${i + 1}`);
  const guideToken = 'guide';
  const names = { p1: 'Zara', p2: 'Milo', p3: 'Indy', p4: 'Bea', p5: 'Sam', p6: 'Kit', guide: 'Ms Frost' };
  const characters = {
    p1: { characterKey: 'alien', colorHex: 0xff8844 },
    p2: { characterKey: 'robot', colorHex: 0x66ccff },
    p3: { characterKey: 'indy', colorHex: 0xffe066 },
    p4: { characterKey: 'wizard', colorHex: 0x9b6bff },
    p5: { characterKey: 'ghost', colorHex: 0x88ffcc },
    p6: { characterKey: 'monkey', colorHex: 0xff6699 },
    // The guide picks a character too (character-select runs for every
    // role) — it's just never shown as a live in-world card during their
    // own round. Included here so this dev harness actually exercises that
    // path instead of silently having no data for it.
    guide: { characterKey: 'woman1', colorHex: 0xffd166 },
  };
  const results = {
    p1: { correctCount: 6, totalForks: 6, itemsCollected: 1, resistCount: 1, jetpackKeptAtFinish: true },
    p2: { correctCount: 3, totalForks: 6, itemsCollected: 0, resistCount: 0, jetpackKeptAtFinish: false },
    p3: { correctCount: 6, totalForks: 6, itemsCollected: 1, resistCount: 0, jetpackKeptAtFinish: false },
    p4: { correctCount: 5, totalForks: 6, itemsCollected: 0, resistCount: 2, jetpackKeptAtFinish: false },
    p5: { correctCount: 2, totalForks: 6, itemsCollected: 0, resistCount: 0, jetpackKeptAtFinish: false },
    p6: { correctCount: 6, totalForks: 6, itemsCollected: 1, resistCount: 1, jetpackKeptAtFinish: true },
  };
  return (
    <VictoryStage
      round={{ roundId: 'solo-victory', roster, guideToken }}
      roundResultsByToken={results}
      getDisplayName={(tok) => names[tok] ?? tok}
      getCharacter={(tok) => characters[tok] ?? { characterKey: null, colorHex: null }}
      onBackToLobby={() => console.log('[victory] back to lobby')}
    />
  );
}

// Shown for the moment a screen's code is still arriving.
function Loading() {
  return (
    <div style={{ position: 'fixed', inset: 0, display: 'grid', placeItems: 'center', background: '#05070a', color: '#cfd6df', font: '16px system-ui, sans-serif' }}>
      Loading…
    </div>
  );
}

export default function App() {
  return (
    <Suspense fallback={<Loading />}>
      <AppRoutes />
    </Suspense>
  );
}

function AppRoutes() {
  const [sessionCode, setSessionCode] = useState(params.get('join') ?? null);
  const [teacherView, setTeacherView] = useState(false);
  const lobby = useLobby(sessionCode);
  // Phones: start fetching the game (GameRoom -> Sky Path) while the player
  // is still on the join and waiting screens, so it's ready by round start.
  // Same condition as `playerRoute` below (read from the URL, so it never
  // changes); here because hooks can't follow the early returns.
  useEffect(() => {
    if (params.has('join') || params.has('devJoin') || params.get('player') === '1') loadGameRoom().catch(() => {});
  }, []);

  if (params.get('cavern') === '1') return <SoloLavaCavern />;
  if (params.get('victory') === '1') return <SoloVictoryStage />;
  if (params.get('solo') === '1') return <SoloSkyPath />;
  if (params.get('debugKeyboard') === '1') return <KeyboardTestHarness />;
  // The projector: the public view on the big screen, in its own window on
  // the teacher's PC (lobby/Projector.jsx).
  if (params.has('projector')) return <Projector code={params.get('projector')} />;
  // The teacher's lobby board is the default landing page (Luke, 2026-10-05:
  // "this Lobby... will become the default landing"). Players arrive on the
  // QR card's `?join=CODE` link and get the player screens below. `?player=1`
  // keeps the old player lobby reachable with no code at all (the shared
  // no-session room, for multi-tab testing), and `?devJoin=` is the Dev
  // player button's own reload. `?lobbyBoard=1` still works for old links.
  const playerRoute = params.has('join') || params.has('devJoin') || params.get('player') === '1';
  if (!playerRoute) return <LobbyBoard />;

  if (teacherView) return <TeacherDashboard onExit={() => setTeacherView(false)} />;

  // Luke, 2026-09-12: "players who have fallen will have the 'Again' button
  // replaced by 'Watch'; they will then share the guide's view, except they
  // will not see the correct word."
  //
  // 2026-09-13, reworked: this used to render a SECOND, separate `<GameRoom
  // role="watching">` once `roundPhase` reached 'results' with a failure —
  // Luke, after seeing a loading-screen flash on every fall: "a loading
  // screen after the player falls suggests a restart of some sort. In no
  // way should the game be restarting." He was right: forcing a fresh
  // element's `role` prop is exactly what SkyPath.jsx's mount effect reads
  // as "a genuinely different game," tearing down and rebuilding the whole
  // THREE.js scene (a real loading screen, not a UI illusion). Now the
  // 'playing' and 'failed' cases render the SAME `<GameRoom>` — same
  // `round`, whose own `role` never changes — and `failed` just tells that
  // already-running instance to turn itself into a spectator in place (see
  // GameRoom.jsx's own effect, and skyPath.js's `becomeSpectator`). A
  // successful round still gets the plain static results screen below; no
  // separate lifecycle needed for the watching case either way — when the
  // teacher starts the next round, this device gets the same
  // `game-started` broadcast as everyone else and returns to a fresh
  // 'playing' round normally, which DOES need (and gets) a real remount,
  // since the fork sequence and words actually are different.
  // Points system + victory screen, 2026-09-25: once every player in the
  // round has reported their own round-ended (see useLobby's
  // `teamComplete`/`roundResultsByToken`), EVERY device in the group —
  // including the guide's, which has no `round-ended` of its own and would
  // otherwise just sit on the live `GameRoom` canvas forever — swaps to the
  // team-wide victory screen. Checked before the 'playing'/'failed' branch
  // below so it pre-empts both that live canvas (the guide's case) and an
  // individual player's own already-shown `RunScore` (the case where
  // this device finished before its teammates and was waiting).
  //
  // 2026-10-06: the victory scene moved to the teacher's screen, once, at the
  // end of the whole series of rounds (see lobby/series.js); a phone now
  // shows RoundOver here instead: waiting for the next round, or, after the
  // last one, "look at the big screen". (VictoryStage stays for `?victory=1`.)
  // Removed by the teacher (LobbyBoard.jsx's Remove): out of any round at
  // once, onto the join screen's "you've been removed".
  if (lobby.removed) return <PlayerJoin lobby={lobby} />;

  if ((lobby.teamComplete && lobby.round) || lobby.seriesEnded) {
    return <RoundOver seriesEnded={lobby.seriesEnded} result={lobby.round?.result ?? null} />;
  }

  const failed = lobby.roundPhase === 'results' && lobby.round?.result && !lobby.round.result.success;
  if ((lobby.roundPhase === 'playing' || failed) && lobby.round) {
    return (
      <GameRoom
        round={lobby.round}
        failed={failed}
        displayName={lobby.participant?.displayName}
        look={lobby.look}
        myToken={lobby.token}
        sendForkChoice={lobby.sendForkChoice}
        onForkChoiceReceived={lobby.onForkChoiceReceived}
        sendPlayerState={lobby.sendPlayerState}
        onPlayerStateReceived={lobby.onPlayerStateReceived}
        sendGameEvent={lobby.sendGameEvent}
        onGameEventReceived={lobby.onGameEventReceived}
        onReportStateRequested={lobby.onReportStateRequested}
        getAbductionTargets={lobby.getAbductionTargets}
        getDisplayName={lobby.getDisplayName}
        onRoundEnd={lobby.reportRoundEnd}
      />
    );
  }

  // Reached the temple, teammates still running: this player's score and
  // who they're waiting for (RunScore.jsx; Luke, 2026-10-06). Replaced the
  // old RoundResults screen, whose "Back to lobby" button no longer fits a
  // series of rounds the teacher runs. (A player who fell is still watching,
  // above; they see their score once the team is done, in RoundOver.)
  if (lobby.roundPhase === 'results' && lobby.round) {
    const stillRunning = (lobby.round.roster ?? []).filter((tok) => !(tok in lobby.roundResultsByToken)).map((tok) => lobby.getDisplayName(tok) ?? 'a teammate');
    return <RunScore result={lobby.round.result} stillRunning={stillRunning} />;
  }

  // A player arriving from the teacher's QR code: the join screen, where they
  // choose a character, colour and name, then wait (PlayerJoin.jsx). The
  // older plain lobby below stays for `?player=1` and the Dev player button's
  // `?devJoin=` reloads (multi-tab testing), where the game still asks for a
  // character at round start.
  if (params.has('join') && !params.has('devJoin')) return <PlayerJoin lobby={lobby} />;

  // With teacher sign-in off, "Teacher?" goes to the lobby board (the
  // default page); the old sign-in dashboard is kept for when it comes back.
  const openTeacher = TEACHER_SIGN_IN ? () => setTeacherView(true) : () => (location.href = location.pathname);
  return <Lobby lobby={lobby} onCodeResolved={setSessionCode} onOpenTeacherView={openTeacher} />;
}
