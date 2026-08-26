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
 * supported, so `fork-choice`, `game-started` and `round-ended` are all
 * bound once, in `ensureRoomChannel`, and dispatched to whichever local
 * handler is currently registered via a ref rather than re-subscribing per
 * game.
 *
 * Stage D adds an explicit round lifecycle — `lobby → assigning → playing →
 * results → lobby` — on top of the single `game-started` broadcast Stage A3
 * had. Two things drive it, both broadcasts on the room channel so every
 * device transitions together rather than each guessing from its own Sky
 * Path instance's local timing:
 *
 * - `game-started` (now carrying a `roundId`, not just forks+guide) moves
 *   every device from `assigning`/`lobby` to `playing`.
 * - `round-ended` (new) is what a fall or an arrival actually reports
 *   upward — `reportRoundEnd()` broadcasts it, and the handler below applies
 *   the same "first message for this round wins" rule the fork-choice
 *   arbiter uses: it's a no-op unless the device is still `playing` *this*
 *   `roundId`, so a late/duplicate broadcast (or one for a round this device
 *   already left) can't reopen results or bounce it back a phase. In
 *   principle every device's own Sky Path instance computes the identical
 *   result from the identical relayed fork choices, so this isn't resolving
 *   disagreement the way fork-choice arbitration does — it's making the
 *   *phase transition* a shared network event instead of each device acting
 *   on its own local callback, so results land for the whole room at
 *   (roughly) the same moment rather than whenever each device's own
 *   simulation happens to finish.
 *
 * Guide rotation (round-robin, every group member gets a turn before anyone
 * repeats) is derived the same decentralized way fork-choice arbitration
 * is: `guideHistoryRef` is a plain Set built up purely by *replaying the
 * `game-started` broadcasts this device has already received* — never
 * written to directly by whoever clicks "Start"/"Play again". Since every
 * device in a room receives the identical sequence of `game-started`
 * broadcasts (self included, `broadcast: { self: true }`), every device
 * computes the identical history and therefore the identical "who hasn't
 * guided yet" candidate set, without any device needing to be authoritative
 * or the guide list needing to be sent anywhere explicitly. Whoever happens
 * to click the button just reads that already-shared state.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../supabase.js';
import { identityStore as localIdentityStore, token, clearToken } from './identity.js';

// Must match Sky Path's own N_FORKS (see app/src/skypath/skyPath.js). The two
// modules don't share a build-time constant yet — acceptable for now, worth
// a shared config once Stage B introduces per-class game settings.
const SKY_PATH_N_FORKS = 6;

/**
 * `identityStore` defaults to the local, ephemeral store so every existing
 * caller (and the `?solo=1` dev path) keeps working unchanged. Stage B's
 * join-by-code flow passes a `createSupabaseIdentityStore(...)` instance
 * instead, *before* calling `join()` — see JoinByCode.jsx. Every call below
 * is awaited even though the local store's methods are synchronous:
 * `await` on an already-resolved value just resolves it next microtask
 * (per supabaseIdentityStore.js's own doc comment), so one code path works
 * for both stores without the hook needing to know which one it has.
 */
export function useLobby(identityStore = localIdentityStore) {
  const [participant, setParticipant] = useState(null);
  const [joined, setJoined] = useState(false);
  const [status, setStatus] = useState('not connected');
  const [participants, setParticipants] = useState([]); // flat presence entries, refreshed on every sync
  const [roomStatus, setRoomStatus] = useState('not in a room (unassigned)');
  const [roundPhase, setRoundPhase] = useState('lobby'); // 'lobby' | 'assigning' | 'playing' | 'results'
  const [round, setRound] = useState(null); // { roundId, forks, role, guideToken, result }

  const channelRef = useRef(null);
  const roomChannelRef = useRef(null);
  const roomGroupIdRef = useRef(null);
  const forkChoiceHandlerRef = useRef(null);
  // Mirrors {phase, round} synchronously so the round-ended handler can
  // validate a broadcast (still playing? same roundId?) without racing
  // React's async state batching — see the doc comment above.
  const roundStateRef = useRef({ phase: 'lobby', round: null });
  // Tokens that have already guided in the current room's current rotation
  // cycle, rebuilt purely from received `game-started` broadcasts.
  const guideHistoryRef = useRef(new Set());

  const transition = useCallback((phase, nextRound) => {
    roundStateRef.current = { phase, round: nextRound };
    setRoundPhase(phase);
    setRound(nextRound);
  }, []);

  const trackPayload = useCallback(
    (p) => ({ token, displayName: p.displayName, score: p.score, equipment: p.equipment, groupId: p.groupId }),
    [],
  );

  // Loads this device's participant record from whichever store was passed
  // in. For the roster store this is `null` until a name is claimed via
  // join() — that's correct, not a loading glitch, since a roster-backed
  // token means nothing until claimed.
  useEffect(() => {
    let cancelled = false;
    Promise.resolve(identityStore.getParticipant(token)).then((p) => {
      if (!cancelled) setParticipant(p ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [identityStore]);

  const applyGroupAssignment = useCallback(
    async (assignments) => {
      if (!(token in assignments)) return; // this device wasn't part of the assignment
      const p = await identityStore.setGroup(token, assignments[token]);
      setParticipant(p);
      channelRef.current?.track(trackPayload(p));
    },
    [identityStore, trackPayload],
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
    // A room change ends whatever round belonged to the old room, and starts
    // a fresh guide-rotation cycle — the history is meaningless outside the
    // room it was built from.
    transition('lobby', null);
    guideHistoryRef.current = new Set();

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
      guideHistoryRef.current.add(payload.guideToken);
      const role = payload.guideToken === token ? 'guide' : 'player';
      transition('playing', {
        roundId: payload.roundId,
        forks: payload.forks,
        role,
        guideToken: payload.guideToken,
        result: null,
      });
    });
    rc.on('broadcast', { event: 'round-ended' }, ({ payload }) => {
      const current = roundStateRef.current;
      if (current.phase !== 'playing' || current.round?.roundId !== payload.roundId) return;
      transition('results', { ...current.round, result: payload.result });
    });
    rc.subscribe((subStatus) => {
      if (subStatus === 'SUBSCRIBED') setRoomStatus(`in room-${normalized}`);
      else if (subStatus === 'CHANNEL_ERROR' || subStatus === 'TIMED_OUT') {
        setRoomStatus(`room connection problem: ${subStatus}`);
      }
    });
    roomChannelRef.current = rc;
  }, [transition]);

  // Whenever the presence list changes, re-derive this device's own group
  // and (re)join the matching room — the same trigger lobby.js's
  // renderParticipants used.
  useEffect(() => {
    const mine = participants.find((p) => p.token === token);
    ensureRoomChannel(mine?.groupId ?? null);
  }, [participants, ensureRoomChannel]);

  const join = useCallback(
    async (name) => {
      const trimmed = name.trim();
      if (!trimmed) return;

      let p;
      try {
        p = await identityStore.setDisplayName(token, trimmed);
      } catch (err) {
        // Only the roster store can reject here (an unclaimed/unknown
        // name) — the local store's setDisplayName never throws.
        setStatus(`couldn't join as "${trimmed}": ${err.message ?? err}`);
        return;
      }
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
    [identityStore, applyGroupAssignment, trackPayload],
  );

  const addPoint = useCallback(async () => {
    const p = await identityStore.addScore(token, 1);
    setParticipant(p);
    channelRef.current?.track(trackPayload(p));
  }, [identityStore, trackPayload]);

  /** Broadcasts a group assignment and applies it locally — broadcasts don't echo to their own sender. */
  const applyGroups = useCallback(
    (assignments) => {
      channelRef.current?.send({ type: 'broadcast', event: 'groups-updated', payload: { assignments } });
      applyGroupAssignment(assignments);
    },
    [applyGroupAssignment],
  );

  /**
   * Starts a round — the initial "Start Sky Path" click and a "Play again"
   * from the results screen are the same action, since guide rotation makes
   * every call here produce a different guide (until a cycle completes and
   * repeats) with no separate "next round" logic needed.
   */
  const startSkyPath = useCallback(() => {
    const rc = roomChannelRef.current;
    const groupId = roomGroupIdRef.current;
    if (!rc || groupId === null) return;
    const myGroupMembers = participants.filter((p) => p.groupId === groupId);
    if (myGroupMembers.length === 0) return;

    // Round-robin guide rotation: pick from whoever in the group hasn't
    // guided yet this cycle; once everyone has had a turn, start a new
    // cycle. `guideHistoryRef` is rebuilt purely from `game-started`
    // broadcasts already received (see the doc comment at the top of this
    // file) — every device computes the same candidate set independent of
    // who happens to click this button.
    const guided = guideHistoryRef.current;
    let candidates = myGroupMembers.filter((p) => !guided.has(p.token));
    if (candidates.length === 0) {
      guided.clear();
      candidates = myGroupMembers;
    }
    const guideToken = candidates[Math.floor(Math.random() * candidates.length)].token;

    const letters = 'LR';
    const forks = Array.from({ length: SKY_PATH_N_FORKS }, () => letters[Math.random() < 0.5 ? 0 : 1]).join('');
    const roundId = crypto.randomUUID();

    // 'assigning' is a local-only, momentary phase — it exists so the
    // initiating device's own UI reflects "starting…" for the one round
    // trip until its own 'game-started' broadcast comes back (self:true
    // means it always does), rather than looking unresponsive. Every device
    // (including this one) actually enters 'playing' from the broadcast
    // handler above, not from here — there is exactly one code path into a
    // round, same as the fork-choice design.
    transition('assigning', null);
    rc.send({ type: 'broadcast', event: 'game-started', payload: { forks, guideToken, roundId } });
  }, [participants, transition]);

  /** Registers the handler that turns a relayed fork-choice into a call on the live Sky Path instance. */
  const onForkChoiceReceived = useCallback((handler) => {
    forkChoiceHandlerRef.current = handler;
  }, []);

  const sendForkChoice = useCallback((forkIndex, side) => {
    roomChannelRef.current?.send({ type: 'broadcast', event: 'fork-choice', payload: { forkIndex, side } });
  }, []);

  /**
   * Reports a finished round (fall or arrival) up from Sky Path — the
   * points/items payload the handoff doc's two-layer architecture calls
   * for, though crediting it to the roster (Stage E) isn't wired yet. This
   * only broadcasts; the actual `playing` -> `results` transition happens
   * in the `round-ended` handler above, once for whichever broadcast (this
   * device's own, via self:true) arrives first for the current roundId.
   */
  const reportRoundEnd = useCallback((result) => {
    const rc = roomChannelRef.current;
    const current = roundStateRef.current;
    if (!rc || current.phase !== 'playing' || !current.round) return;
    rc.send({ type: 'broadcast', event: 'round-ended', payload: { roundId: current.round.roundId, result } });
  }, []);

  /** Returns to the lobby from 'playing' or 'results' without leaving the room — the room persists per the handoff's "persistent lobby" decision. */
  const leaveGame = useCallback(() => {
    transition('lobby', null);
  }, [transition]);

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
    roundPhase,
    round,
    join,
    addPoint,
    applyGroups,
    startSkyPath,
    sendForkChoice,
    onForkChoiceReceived,
    reportRoundEnd,
    leaveGame,
    resetDevice,
  };
}
