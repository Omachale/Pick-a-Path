/**
 * The teacher's side of one game's realtime channel (`lobby-CODE`), for the
 * lobby board. Same approach as TeacherDashboard.jsx's SessionPanel: the
 * teacher OBSERVES the channel (presence + broadcasts) without ever tracking
 * itself into it, so it never appears as a participant of its own game.
 */
import { supabase } from '../supabase.js';

export function openTeacherSession(code, { onPlayers, onRoundEnded, rounds = {}, onRoundsChanged, roundIsOver, seriesIsOver, victory }) {
  const ch = supabase.channel(`lobby-${code}`);
  // The latest round started for each team (its whole game-started
  // payload), for the projector (Projector.jsx): opened or reloaded
  // mid-round, it asks (`projector-hello`), and gets them back as
  // `rounds-now`, which only it acts on. Re-sending `game-started` itself
  // would restart every phone's round. Kept by the page across reloads
  // (`rounds` in, `onRoundsChanged` out); `roundIsOver(roundId)` marks the
  // ones already finished, and `seriesIsOver()` says whether the whole series
  // is; `victory()` gives the victory scene's teams once it is.
  const latest = new Map(Object.entries(rounds).map(([g, r]) => [Number(g), r]));
  const sendRoundsNow = () => {
    const list = [...latest.values()].map((r) => ({ ...r, over: !!roundIsOver?.(r.roundId) }));
    ch.send({ type: 'broadcast', event: 'rounds-now', payload: { rounds: list, seriesEnded: !!seriesIsOver?.(), victory: victory?.() ?? null } });
  };
  ch.on('broadcast', { event: 'projector-hello' }, () => {
    projectorSeenAt = Date.now();
    sendRoundsNow();
  });
  // Whether a projector is open: it says so on opening and every
  // PROJECTOR_HERE_MS after (Projector.jsx). The board shows the victory
  // scene itself only when none is — Luke, 2026-10-10: "If the projector is
  // on its own screen and showing the victory, we don't need it to be shown
  // on any other screens" (two copies on one PC halved both frame rates).
  let projectorSeenAt = 0;
  ch.on('broadcast', { event: 'projector-here' }, () => (projectorSeenAt = Date.now()));
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
  // Each runner's result as their round ends (useLobby.js's reportRoundEnd),
  // for the lobby board's series of rounds (series.js).
  ch.on('broadcast', { event: 'round-ended' }, ({ payload }) => onRoundEnded?.(payload));
  // Sent on connecting too: a projector opened while this page was
  // reloading asked before anyone was listening.
  ch.subscribe((st) => st === 'SUBSCRIBED' && sendRoundsNow());
  return {
    send(event, payload) {
      if (event === 'game-started') {
        latest.set(payload.groupId, payload);
        onRoundsChanged?.(Object.fromEntries(latest));
      }
      ch.send({ type: 'broadcast', event, payload });
    },
    close() {
      supabase.removeChannel(ch);
    },
    /** True while a projector has been heard from lately (see projectorSeenAt). */
    projectorOpen() {
      return Date.now() - projectorSeenAt < 25000;
    },
  };
}
