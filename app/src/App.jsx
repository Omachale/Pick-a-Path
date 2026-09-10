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
 */
import { useRef, useState, useEffect } from 'react';
import { useLobby } from './lobby/useLobby.js';
import Lobby from './lobby/Lobby.jsx';
import GameRoom from './lobby/GameRoom.jsx';
import RoundResults from './lobby/RoundResults.jsx';
import SkyPath from './skypath/SkyPath.jsx';
import LavaCavern from './cavern/LavaCavern.jsx';
import TeacherDashboard from './lobby/TeacherDashboard.jsx';
import { supabase } from './supabase.js';
import { createSupabaseIdentityStore } from './identity/supabaseIdentityStore.js';

const params = new URLSearchParams(location.search);

function SoloSkyPath() {
  const gameRef = useRef(null);
  return (
    <div style={{ position: 'fixed', inset: 0 }}>
      <SkyPath
        forks={params.get('forks')}
        role={params.get('role') === 'player' ? 'player' : 'guide'}
        crowd={Number(params.get('crowd')) || 0}
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
  const [identityStore, setIdentityStore] = useState(undefined); // undefined -> useLobby's local-store default
  const [teacherView, setTeacherView] = useState(false);
  const [teacherSession, setTeacherSession] = useState(undefined); // undefined = loading, null = signed out
  const lobby = useLobby(identityStore);

  useEffect(() => {
    const classId = localStorage.getItem('skypath.rosterClassId');
    if (classId) {
      setIdentityStore(createSupabaseIdentityStore({ classId, supabase }));
    }
  }, []);

  // Tracked at the App level, not just inside TeacherDashboard, because a
  // signed-in teacher needs to be recognised in the Lobby too (to see group
  // management) after switching back from the dashboard — the auth session
  // outlives which screen is currently showing.
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setTeacherSession(data.session ?? null));
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => setTeacherSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  if (params.get('cavern') === '1') return <SoloLavaCavern />;
  if (params.get('solo') === '1') return <SoloSkyPath />;

  if (teacherView) return <TeacherDashboard onExit={() => setTeacherView(false)} />;

  if (lobby.roundPhase === 'playing' && lobby.round) {
    return (
      <GameRoom
        round={lobby.round}
        sendForkChoice={lobby.sendForkChoice}
        onForkChoiceReceived={lobby.onForkChoiceReceived}
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
        onPlayAgain={lobby.startSkyPath}
        onBackToLobby={lobby.leaveGame}
      />
    );
  }

  return (
    <Lobby
      lobby={lobby}
      isTeacher={!!teacherSession}
      onRosterStoreReady={setIdentityStore}
      onOpenTeacherView={() => setTeacherView(true)}
    />
  );
}
