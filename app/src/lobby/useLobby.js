/**
 * Session/lobby layer, ported from lobby-prototype/lobby.js into a React
 * hook. The data model and the Supabase wiring are unchanged from the
 * standalone prototype — presence keyed by identity token, grouping as a
 * broadcast `{token: groupId}` map applied locally by each device, one
 * `room-<groupId>` channel per group — because that model was already
 * proven working with real concurrent devices; only the DOM manipulation
 * became React state.
 *
 * One behavioural change from the prototype, made here because this is the
 * first time fork-choice wiring is built against the real app rather than a
 * throwaway link into a new tab: the room channel is created with
 * `broadcast: { self: true }`, and `sendForkChoice`/`onForkChoiceReceived`
 * exist so that *no* client ever applies its own tap directly — every
 * client, sender included, only acts on the copy Supabase's relay sends
 * back. That is the "let the relay be the arbiter" mechanism TODO.md
 * describes for "a player taps, the guide cannot": since a single relayed
 * channel delivers broadcasts in one consistent order to every subscriber,
 * and Sky Path's `applyChoice` ignores anything that isn't the fork
 * currently awaiting a decision, the first message back for a given fork
 * wins everywhere and every later one is a no-op — no host, no election.
 * **Not yet verified against genuine simultaneous taps from two real
 * devices** — see TODO.md's own caveat on this before leaning on it harder.
 *
 * Channel handlers are registered before `.subscribe()`, not after — adding
 * `.on()` post-subscribe is not something supabase-js documents as
 * supported, so `fork-choice` and `game-started` are both bound once, in
 * `ensureRoomChannel`, and dispatched to whichever local handler is
 * currently registered via a ref rather than re-subscribing per game.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../supabase.js';
import { identityStore, token, clearToken } from './identity.js';

// Must match Sky Path's own N_FORKS (see app/src/skypath/skyPath.js). The two
// modules don't share a build-time constant yet — acceptable for now, worth
// a shared config once Stage B introduces per-class game settings.
const SKY_PATH_N_FORKS = 6;

export function useLobby() {
  const [participant, setParticipant] = useState(() => identityStore.getParticipant(token));
  const [joined, setJoined] = useState(false);
  const [status, setStatus] = useState('not connected');
  const [participants, setParticipants] = useState([]); // flat presence entries, refreshed on every sync
  const [roomStatus, setRoomStatus] = useState('not in a room (unassigned)');
  const [gameSession, setGameSession] = useState(null); // { forks, role } once a game-started broadcast lands

  const channelRef = useRef(null);
  const roomChannelRef = useRef(null);
  const roomGroupIdRef = useRef(null);
  const forkChoiceHandlerRef = useRef(null);

  const trackPayload = useCallback(
    (p) => ({ token, displayName: p.displayName, score: p.score, equipment: p.equipment, groupId: p.groupId }),
    [],
  );

  const applyGroupAssignment = useCallback(
    (assignments) => {
      if (!(token in assignments)) return; // this device wasn't part of the assignment
      const p = identityStore.setGroup(token, assignments[token]);
      setParticipant(p);
      channelRef.current?.track(trackPayload(p));
    },
    [trackPayload],
  );

  /**
   * Joins (or re-joins, on a group change) this device's own group room.
   * `groupId` of null/undefined means "not grouped yet" — no room to join.
   * Switching groups tears down the old room channel first so a device
   * never keeps hearing a room it's no longer part of.
   */
  const ensureRoomChannel = useCallback((groupId) => {
    const normalized = groupId ?? null;
    if (normalized === roomGroupIdRef.current) return;

    if (roomChannelRef.current) {
      supabase.removeChannel(roomChannelRef.current);
      roomChannelRef.current = null;
    }
    roomGroupIdRef.current = normalized;
    setGameSession(null); // a room change ends whatever round belonged to the old room

    if (normalized === null) {
      setRoomStatus('not in a room (unassigned)');
      return;
    }

    setRoomStatus(`joining room-${normalized}…`);
    const rc = supabase.channel(`room-${normalized}`, {
      config: { broadcast: { self: true } },
    });
    rc.on('broadcast', { event: 'fork-choice' }, ({ payload }) => {
      forkChoiceHandlerRef.current?.(payload.forkIndex, payload.side);
    });
    rc.on('broadcast', { event: 'game-started' }, ({ payload }) => {
      const role = payload.guideToken === token ? 'guide' : 'player';
      setGameSession({ forks: payload.forks, role });
    });
    rc.subscribe((subStatus) => {
      if (subStatus === 'SUBSCRIBED') setRoomStatus(`in room-${normalized}`);
      else if (subStatus === 'CHANNEL_ERROR' || subStatus === 'TIMED_OUT') {
        setRoomStatus(`room connection problem: ${subStatus}`);
      }
    });
    roomChannelRef.current = rc;
  }, []);

  // Whenever the presence list changes, re-derive this device's own group
  // and (re)join the matching room — the same trigger lobby.js's
  // renderParticipants used.
  useEffect(() => {
    const mine = participants.find((p) => p.token === token);
    ensureRoomChannel(mine?.groupId ?? null);
  }, [participants, ensureRoomChannel]);

  const join = useCallback(
    (name) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      const p = identityStore.setDisplayName(token, trimmed);
      setParticipant(p);

      if (channelRef.current) return; // already joined this session

      const ch = supabase.channel('lobby-room', { config: { presence: { key: token } } });
      ch.on('presence', { event: 'sync' }, () => {
        // presenceState() maps key -> array of metas, and that array can
        // transiently hold more than one entry per key during a reconnect —
        // a dropped socket's old presence hasn't timed out yet when a new
        // one for the same token joins. On real classroom wifi this is the
        // common case, not the exception, so take the newest meta per key
        // rather than flattening blindly.
        const state = ch.presenceState();
        const latestByKey = Object.values(state).map((metas) => metas[metas.length - 1]);
        // De-dup by the payload's own token too, not just the presence key:
        // 'lobby-room' is a public channel on a real shared Supabase project
        // (see TODO.md — anyone with the publishable key can join it), so a
        // stale session from a different origin/port can in principle carry
        // a presence key that doesn't match its own tracked token.
        const seen = new Set();
        const deduped = [];
        for (const p of latestByKey) {
          if (seen.has(p.token)) continue;
          seen.add(p.token);
          deduped.push(p);
        }
        setParticipants(deduped);
      });
      ch.on('broadcast', { event: 'groups-updated' }, ({ payload }) => {
        applyGroupAssignment(payload.assignments);
      });
      ch.subscribe(async (subStatus) => {
        if (subStatus === 'SUBSCRIBED') {
          setStatus('connected — you are in the lobby');
          await ch.track(trackPayload(p));
          setJoined(true);
        } else if (subStatus === 'CHANNEL_ERROR' || subStatus === 'TIMED_OUT') {
          setStatus(`connection problem: ${subStatus}`);
        }
      });
      channelRef.current = ch;
    },
    [applyGroupAssignment, trackPayload],
  );

  const addPoint = useCallback(() => {
    const p = identityStore.addScore(token, 1);
    setParticipant(p);
    channelRef.current?.track(trackPayload(p));
  }, [trackPayload]);

  /** Broadcasts a group assignment and applies it locally — broadcasts don't echo to their own sender. */
  const applyGroups = useCallback(
    (assignments) => {
      channelRef.current?.send({ type: 'broadcast', event: 'groups-updated', payload: { assignments } });
      applyGroupAssignment(assignments);
    },
    [applyGroupAssignment],
  );

  const startSkyPath = useCallback(() => {
    const rc = roomChannelRef.current;
    const groupId = roomGroupIdRef.current;
    if (!rc || groupId === null) return;
    const myGroupMembers = participants.filter((p) => p.groupId === groupId);
    if (myGroupMembers.length === 0) return;

    const letters = 'LR';
    const forks = Array.from({ length: SKY_PATH_N_FORKS }, () => letters[Math.random() < 0.5 ? 0 : 1]).join('');
    const guideToken = myGroupMembers[Math.floor(Math.random() * myGroupMembers.length)].token;

    // No local apply needed: `broadcast: { self: true }` means this device's
    // own 'game-started' handler fires from the relay just like every other
    // device's, so there is exactly one code path for entering a round.
    rc.send({ type: 'broadcast', event: 'game-started', payload: { forks, guideToken } });
  }, [participants]);

  /** Registers the handler that turns a relayed fork-choice into a call on the live Sky Path instance. */
  const onForkChoiceReceived = useCallback((handler) => {
    forkChoiceHandlerRef.current = handler;
  }, []);

  const sendForkChoice = useCallback((forkIndex, side) => {
    roomChannelRef.current?.send({ type: 'broadcast', event: 'fork-choice', payload: { forkIndex, side } });
  }, []);

  /** Ends the current round's view without leaving the room — the room persists per the handoff's "persistent lobby" decision. */
  const leaveGame = useCallback(() => {
    setGameSession(null);
  }, []);

  const resetDevice = useCallback(() => {
    clearToken();
    location.reload();
  }, []);

  const myGroupId = participants.find((p) => p.token === token)?.groupId ?? null;

  return {
    token,
    participant,
    joined,
    status,
    participants,
    myGroupId,
    roomStatus,
    gameSession,
    join,
    addPoint,
    applyGroups,
    startSkyPath,
    sendForkChoice,
    onForkChoiceReceived,
    leaveGame,
    resetDevice,
  };
}
