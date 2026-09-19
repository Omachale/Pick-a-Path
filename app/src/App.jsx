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
import { useRef, useState } from 'react';
import { useLobby } from './lobby/useLobby.js';
import Lobby from './lobby/Lobby.jsx';
import GameRoom from './lobby/GameRoom.jsx';
import RoundResults from './lobby/RoundResults.jsx';
import SkyPath from './skypath/SkyPath.jsx';
import LavaCavern from './cavern/LavaCavern.jsx';
import TeacherDashboard from './lobby/TeacherDashboard.jsx';

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

export default function App() {
  const [sessionCode, setSessionCode] = useState(params.get('join') ?? null);
  const [teacherView, setTeacherView] = useState(false);
  const lobby = useLobby(sessionCode);

  if (params.get('cavern') === '1') return <SoloLavaCavern />;
  if (params.get('solo') === '1') return <SoloSkyPath />;

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
  const failed = lobby.roundPhase === 'results' && lobby.round?.result && !lobby.round.result.success;
  if ((lobby.roundPhase === 'playing' || failed) && lobby.round) {
    return (
      <GameRoom
        round={lobby.round}
        failed={failed}
        displayName={lobby.participant?.displayName}
        myToken={lobby.token}
        sendForkChoice={lobby.sendForkChoice}
        onForkChoiceReceived={lobby.onForkChoiceReceived}
        sendPlayerState={lobby.sendPlayerState}
        onPlayerStateReceived={lobby.onPlayerStateReceived}
        sendGameEvent={lobby.sendGameEvent}
        onGameEventReceived={lobby.onGameEventReceived}
        getAbductionTargets={lobby.getAbductionTargets}
        onRoundEnd={lobby.reportRoundEnd}
        onLeave={lobby.leaveGame}
      />
    );
  }

  if (lobby.roundPhase === 'results' && lobby.round) {
    return (
      <RoundResults
        round={lobby.round}
        participants={lobby.participants}
        myToken={lobby.token}
        onBackToLobby={lobby.leaveGame}
      />
    );
  }

  return <Lobby lobby={lobby} onCodeResolved={setSessionCode} onOpenTeacherView={() => setTeacherView(true)} />;
}
