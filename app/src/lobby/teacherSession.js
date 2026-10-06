/**
 * The teacher's side of one game's realtime channel (`lobby-CODE`), for the
 * lobby board. Same approach as TeacherDashboard.jsx's SessionPanel: the
 * teacher OBSERVES the channel (presence + broadcasts) without ever tracking
 * itself into it, so it never appears as a participant of its own game.
 */
import { supabase } from '../supabase.js';

export function openTeacherSession(code, { onPlayers }) {
  const ch = supabase.channel(`lobby-${code}`);
  ch.on('presence', { event: 'sync' }, () => {
    // Newest meta per key, then de-dup by token: a reconnecting player can
    // transiently double up in presence state before the old entry times
    // out (same reasoning as useLobby.js's join()).
    const latest = Object.values(ch.presenceState()).map((metas) => metas[metas.length - 1]);
    const seen = new Set();
    const players = [];
    for (const p of latest) {
      if (!p?.token || seen.has(p.token)) continue;
      seen.add(p.token);
      players.push(p);
    }
    onPlayers(players);
  });
  ch.subscribe();
  return {
    send(event, payload) {
      ch.send({ type: 'broadcast', event, payload });
    },
    close() {
      supabase.removeChannel(ch);
    },
  };
}
