/**
 * Session/lobby layer, ported from lobby-prototype/lobby.js into a React
 * hook. Originally one hardcoded `'lobby-room'` channel for the whole app,
 * with per-group `room-<groupId>` channels for the actual round lifecycle —
 * that split existed because starting a round was something any grouped
 * *student* could trigger from their own device, so each device needed to
 * be "in" its own group's channel to hear it.
 *
 * Luke, 2026-09-11, simplifying the classroom flow: the teacher signs in,
 * starts a session (gets a join code), and players just type a name against
 * that code — no pre-built roster, no per-day score persistence for now
 * (that's a later feature; see the identity/ store swap this used to have
 * and no longer does, below). Crucially, **the teacher now starts every
 * round**, not a student — so the old per-group channel split no longer
 * earns its complexity: there is exactly one initiator per session (the
 * teacher's own dashboard, in TeacherDashboard.jsx), so everything —
 * presence, group assignment, and now also the round lifecycle — lives on
 * ONE channel per session, keyed by that session's join code
 * (`lobby-<code>`). A device merely ignores a `game-started` broadcast
 * addressed to a group it isn't in, rather than needing a separate channel
 * to not-hear it on.
 *
 * The identity-store seam (a pluggable store behind `getParticipant`/
 * `setDisplayName`/etc., swappable for a Supabase-roster-backed one) is
 * gone too: with no pre-built roster to claim a name against, there's
 * nothing left for a second implementation to do differently, so this talks
 * to the plain localStorage-backed store directly. If cross-day score
 * persistence comes back, it comes back as a real design question (how do
 * you tie an ephemeral typed name to a returning roster row?), not as
 * quietly re-plugging the old store back in.
 *
 * Channel handlers are registered before `.subscribe()`, not after — adding
 * `.on()` post-subscribe is not something supabase-js documents as
 * supported, so `fork-choice`, `game-started` and `round-ended` are all
 * bound once, inside `join()`, when the channel is created.
 *
 * Stage D's explicit round lifecycle — `lobby → assigning → playing →
 * results → lobby` — is unchanged:
 *
 * - `game-started` (carrying a `roundId`, the `groupId` it's for, `forks` —
 *   which side is correct at each fork — and now also `words`, the actual
 *   word pair shown at each fork, decided once by whoever started the round
 *   so every device in the group renders the same words in the same
 *   left/right layout rather than each drawing its own) moves a device from
 *   `assigning`/`lobby` to `playing`, but only if the broadcast is
 *   addressed to whichever group THIS device is currently in — everyone
 *   else on the shared channel just ignores it.
 * - `round-ended` is what a fall or an arrival actually reports upward —
 *   `reportRoundEnd()` broadcasts it (carrying the reporting player's own
 *   `token`, same reasoning as `game-started`'s `groupId` — a shared
 *   `roundId` alone can't distinguish "my own round ended" from "someone in
 *   my group's did"), and the handler applies a "first message for THIS
 *   device's own round wins" rule: a no-op unless the device is still
 *   `playing` *this* `roundId` **and** the broadcast is about its own
 *   token, so a late/duplicate broadcast (or one for a round this device
 *   already left, or a teammate's outcome) can't reopen results or bounce
 *   it back a phase.
 *
 * Guide rotation (round-robin, every group member gets a turn before anyone
 * repeats) used to be derived in a decentralized way here — replaying every
 * `game-started` broadcast this device had ever seen, since any of several
 * student devices might be the one to click "Start." That's gone: the
 * teacher is now the sole initiator, so TeacherDashboard.jsx just keeps
 * plain per-group state for it instead.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../supabase.js';
import { identityStore, token, clearToken } from './identity.js';

// Must match Sky Path's own N_FORKS (see app/src/skypath/skyPath.js). The two
// modules don't share a build-time constant yet — acceptable for now, worth
// a shared config once Stage B introduces per-class game settings.
const SKY_PATH_N_FORKS = 6;

// Lets solo multi-tab testing on one machine (several browser tabs, no real
// teacher session) still land everyone in the same shared room, same as
// before a join code existed at all. Luke, 2026-09-13, after a real
// classroom test: some players ended up unable to see each other or the
// teacher, joined "successfully" with no error, and turned out to have
// landed here — probably via a link that lost its `?join=` somewhere along
// the way (a bare bookmark, a redirect, a stray share) rather than the
// teacher's real one. Because this fallback used to be silent — nothing on
// screen distinguished it from a real session — it read exactly like "two
// separate games running at once," not like the missing-code case it
// actually was. Still kept (still useful for exactly the multi-tab-no-
// teacher testing it was built for), but no longer silent — see
// `hasRealSession` below, surfaced as a visible warning in Lobby.jsx, so
// landing here again is obvious immediately instead of looking like success.
const NO_SESSION_CODE = 'no-session';

/**
 * Reads who's currently present in a session's lobby channel WITHOUT this
 * device joining it — for Lobby.jsx's "Dev player" button, which needs to
 * pick a name that's actually free before it resets this device's own
 * identity and reloads. `lobby.participants` (the hook's own state) can't
 * answer that: it's only ever populated once THIS device has called `join()`
 * at least once on THIS channel, since that's the only place a channel gets
 * created at all (see the module header) — a device that's never joined
 * this session has no presence data to read yet, which is exactly the gap
 * Luke hit: six brand-new tabs, each with an empty local view of the room,
 * each independently picking the same "first" name.
 *
 * Subscribes a short-lived, throwaway channel under its own random presence
 * key (so it never announces itself as a participant — no `.track()` call
 * here, and presence in Supabase Realtime is opt-in per-client, not implied
 * by merely subscribing), reads the first presence sync, then tears itself
 * down. Resolves to `[]` if the room is empty, unreachable, or the sync
 * doesn't arrive within the timeout — a caller should treat that as "assume
 * no one's there" (the same reasonable default an empty room actually has),
 * not as an error to surface.
 */
export async function fetchCurrentDisplayNames(sessionCode) {
  const code = (sessionCode || NO_SESSION_CODE).toUpperCase();
  return new Promise((resolve) => {
    let settled = false;
    const probe = supabase.channel(`lobby-${code}`, {
      config: { presence: { key: `probe_${Math.random().toString(36).slice(2)}` } },
    });
    const finish = (names) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      supabase.removeChannel(probe);
      resolve(names);
    };
    probe.on('presence', { event: 'sync' }, () => {
      const state = probe.presenceState();
      finish(
        Object.values(state)
          .flatMap((metas) => metas.map((m) => m.displayName))
          .filter(Boolean)
      );
    });
    probe.subscribe((status) => {
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') finish([]);
    });
    const timer = setTimeout(() => finish([]), 1500); // empty room, or a connection problem — either way, don't hang the button
  });
}

export function useLobby(sessionCode) {
  const hasRealSession = !!sessionCode;
  const code = (sessionCode || NO_SESSION_CODE).toUpperCase();

  const [participant, setParticipant] = useState(null);
  const [joined, setJoined] = useState(false);
  const [status, setStatus] = useState('not connected');
  const [participants, setParticipants] = useState([]); // flat presence entries, refreshed on every sync
  const [roundPhase, setRoundPhase] = useState('lobby'); // 'lobby' | 'assigning' | 'playing' | 'results'
  const [round, setRound] = useState(null); // { roundId, forks, role, guideToken, result }

  const channelRef = useRef(null);
  const forkChoiceHandlerRef = useRef(null);
  // Registered by GameRoom.jsx (see onPlayerStateReceived below) to turn a
  // relayed `player-state` broadcast into a call on the live Sky Path
  // instance's updateTeammate() — same one-handler-in-a-ref pattern as
  // forkChoiceHandlerRef, for the same reason (the channel is created once,
  // inside join(), before GameRoom.jsx even exists to register anything).
  const playerStateHandlerRef = useRef(null);
  // Mirrors `participants` synchronously so the player-state handler (bound
  // once, at join() time) can look up a sender's CURRENT group without a
  // stale closure over whatever `participants` was when the channel was
  // created.
  const participantsRef = useRef([]);
  // Mirrors {phase, round} synchronously so the round-ended handler can
  // validate a broadcast (still playing? same roundId?) without racing
  // React's async state batching.
  const roundStateRef = useRef({ phase: 'lobby', round: null });
  // Mirrors this device's own groupId synchronously, for the same reason —
  // the game-started handler is registered once at join() time and needs
  // to read whatever group this device is CURRENTLY in, not whichever group
  // it was in when the handler was first registered.
  const myGroupIdRef = useRef(null);

  const transition = useCallback((phase, nextRound) => {
    roundStateRef.current = { phase, round: nextRound };
    setRoundPhase(phase);
    setRound(nextRound);
  }, []);

  const trackPayload = useCallback(
    (p) => ({ token, displayName: p.displayName, score: p.score, equipment: p.equipment, groupId: p.groupId }),
    [],
  );

  useEffect(() => {
    const p = identityStore.getParticipant(token);
    setParticipant(p ?? null);
  }, []);

  const applyGroupAssignment = useCallback(
    (assignments) => {
      if (!(token in assignments)) return; // this device wasn't part of the assignment
      const p = identityStore.setGroup(token, assignments[token]);
      setParticipant(p);
      channelRef.current?.track(trackPayload(p));
    },
    [trackPayload],
  );

  useEffect(() => {
    const mine = participants.find((p) => p.token === token);
    myGroupIdRef.current = mine?.groupId ?? null;
    participantsRef.current = participants;
  }, [participants]);

  const join = useCallback(
    (name) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      if (channelRef.current) return; // already joined this session

      const p = identityStore.setDisplayName(token, trimmed);
      setParticipant(p);

      // broadcast: { self: true } is what makes fork-choice arbitration work
      // (see the header comment on `sendForkChoice`/`reportRoundEnd` in the
      // original design, TODO.md's "let the relay be the arbiter"): no
      // client ever acts on its own tap directly, only on the copy the
      // relay sends back, so a consistent delivery order across every
      // subscriber is what actually resolves a simultaneous double-tap.
      const ch = supabase.channel(`lobby-${code}`, {
        config: { presence: { key: token }, broadcast: { self: true } },
      });
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
        // this project's public anon key is shared by every deployment of
        // this app, so a stale session from a different origin/port could in
        // principle carry a presence key that doesn't match its own tracked
        // token — vanishingly unlikely now that the channel is scoped to a
        // specific session code rather than one global room, but cheap to
        // keep guarding against.
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
      ch.on('broadcast', { event: 'game-started' }, ({ payload }) => {
        if (payload.groupId !== myGroupIdRef.current) return; // addressed to a different group
        transition('playing', {
          roundId: payload.roundId,
          forks: payload.forks,
          words: payload.words,
          role: payload.guideToken === token ? 'guide' : 'player',
          guideToken: payload.guideToken,
          // Fixed seating — the group's player tokens in one shared, fixed
          // order; see TeacherDashboard's startGame() for why this needs no
          // further agreement between devices, and skyPath.js's own
          // `seatOffsets` for what it's used for.
          roster: payload.roster,
          result: null,
        });
      });
      ch.on('broadcast', { event: 'fork-choice' }, ({ payload }) => {
        // Luke, 2026-09-12: "when one player chooses a direction, that
        // choice applies to all the players" — real bug, not a future item.
        // This dates from the ORIGINAL design, where a whole team mirrored
        // one shared walker and any relayed choice was correctly meant for
        // everyone. Now that each player has their own independent walker
        // (see the "teammates" work in skyPath.js), a fork-choice broadcast
        // must only ever be applied to the walker it actually belongs to —
        // everyone else already learns where the chooser ended up via the
        // player-state broadcasts above, not by copying their choice.
        if (payload.token !== token) return;
        forkChoiceHandlerRef.current?.(payload.forkIndex, payload.side);
      });
      ch.on('broadcast', { event: 'player-state' }, ({ payload }) => {
        if (payload.token === token) return; // that's me — Sky Path already knows its own position
        // Only relevant if the sender is actually a teammate right now — the
        // lobby channel is shared by every group in the session (see this
        // file's own header comment), so without this check a player in a
        // DIFFERENT group would show up standing on this group's islands.
        const sender = participantsRef.current.find((p) => p.token === payload.token);
        if (!sender || sender.groupId !== myGroupIdRef.current || myGroupIdRef.current === null) return;
        playerStateHandlerRef.current?.(payload.token, payload);
      });
      ch.on('broadcast', { event: 'round-ended' }, ({ payload }) => {
        // Luke, 2026-09-12: "when one player fell, all players got the same
        // ... screen." Same root cause as the fork-choice bug — `roundId`
        // is shared by the whole group (everyone in it started together),
        // so it alone can't tell "my own round ended" from "SOMEONE's did".
        // Each player's own outcome is personal now, same as their walker.
        // The guide has no round of their own to end this way at all — its
        // results/next-round handling is a separate, group-wide concern
        // (see the guide-camera work this same session moves on to next),
        // not something round-ended is meant to drive.
        if (payload.token !== token) return;
        const current = roundStateRef.current;
        if (current.phase !== 'playing' || current.round?.roundId !== payload.roundId) return;
        transition('results', { ...current.round, result: payload.result });
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
    [code, applyGroupAssignment, trackPayload, transition],
  );

  const addPoint = useCallback(() => {
    const p = identityStore.addScore(token, 1);
    setParticipant(p);
    channelRef.current?.track(trackPayload(p));
  }, [trackPayload]);

  /** Registers the handler that turns a relayed fork-choice into a call on the live Sky Path instance. */
  const onForkChoiceReceived = useCallback((handler) => {
    forkChoiceHandlerRef.current = handler;
  }, []);

  const sendForkChoice = useCallback((forkIndex, side) => {
    channelRef.current?.send({ type: 'broadcast', event: 'fork-choice', payload: { token, forkIndex, side } });
  }, []);

  /** Registers the handler that turns a relayed player-state update into a call on the live Sky Path instance's updateTeammate(). */
  const onPlayerStateReceived = useCallback((handler) => {
    playerStateHandlerRef.current = handler;
  }, []);

  /** Reports THIS device's own resting position (see skyPath.js's notifyPlayerState) so teammates can show a real avatar for it. */
  const sendPlayerState = useCallback((state) => {
    channelRef.current?.send({ type: 'broadcast', event: 'player-state', payload: { token, ...state } });
  }, []);

  /**
   * Reports a finished round (fall or arrival) up from Sky Path. This only
   * broadcasts; the actual `playing` -> `results` transition happens in the
   * `round-ended` handler above, once for whichever broadcast (this
   * device's own, via self:true) arrives first for the current roundId.
   */
  const reportRoundEnd = useCallback((result) => {
    const rc = channelRef.current;
    const current = roundStateRef.current;
    if (!rc || current.phase !== 'playing' || !current.round) return;
    rc.send({ type: 'broadcast', event: 'round-ended', payload: { token, roundId: current.round.roundId, result } });
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
    hasRealSession,
    participant,
    joined,
    status,
    participants,
    myGroupId,
    roundPhase,
    round,
    join,
    addPoint,
    sendForkChoice,
    onForkChoiceReceived,
    sendPlayerState,
    onPlayerStateReceived,
    reportRoundEnd,
    leaveGame,
    resetDevice,
  };
}
