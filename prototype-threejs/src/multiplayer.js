/**
 * Optional networked layer for Sky Path. Disabled (and this whole module a
 * no-op) unless the URL carries `?room=<groupId>&role=guide|player` — set
 * by lobby-prototype's "Start Sky Path" button, which also stamps the
 * shared `forks=LLLRRR` sequence every device in the room needs so they all
 * generate the identical maze (see main.js's genCorrectSequence). Without
 * those params this behaves exactly like the solo prototype always has.
 *
 * When enabled, this device joins the *same* `room-<groupId>` Supabase
 * Realtime channel proven in the lobby prototype's step-3 pipe test — not a
 * new channel, the literal continuation of it — and:
 *   - the guide's client calls `broadcastChoice()` when it acts on a fork;
 *   - every other device in the room calls the `onRemoteChoice` handler
 *     it registered, and is expected to replay that same choice locally so
 *     its walk stays in lockstep with the guide's.
 *
 * Deliberately simple network model for this first wiring: only the guide's
 * client can act on a fork at all (main.js hides the left/right buttons for
 * a networked player) — every other device just watches and replays. The
 * real game may later let any player click once they've heard the guide's
 * spoken cue, matching the handoff's pedagogy more closely, but that needs
 * conflict handling (two players clicking at once) this prototype doesn't
 * attempt — see TODO.md.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './multiplayer-config.js';

export function initMultiplayer() {
  const params = new URLSearchParams(location.search);
  const room = params.get('room');
  const role = params.get('role');

  if (!room || (role !== 'guide' && role !== 'player')) {
    return {
      enabled: false,
      role: null,
      broadcastChoice() {},
      onRemoteChoice() {},
    };
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const channel = supabase.channel(`room-${room}`);
  let remoteHandler = () => {};

  channel.on('broadcast', { event: 'fork-choice' }, ({ payload }) => {
    remoteHandler(payload.side, payload.forkIndex);
  });
  channel.subscribe();

  return {
    enabled: true,
    role,
    broadcastChoice(forkIndex, side) {
      channel.send({ type: 'broadcast', event: 'fork-choice', payload: { forkIndex, side } });
    },
    onRemoteChoice(handler) {
      remoteHandler = handler;
    },
  };
}
