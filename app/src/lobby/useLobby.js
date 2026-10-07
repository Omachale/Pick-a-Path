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

/** This device's name and look for a game, for rejoining it after a reload (PlayerJoin.jsx). */
export const joinedKey = (code) => `skypath.joined.${code.toUpperCase()}`;

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
  // Every PLAYER token's own `round-ended` result for the CURRENT round,
  // keyed by token — see the `round-ended` handler below. Unlike `round`'s
  // own `.result` (only ever this device's own outcome, per that handler's
  // header comment), this is aggregated the same passive way islandsRef/
  // charByTokenRef already are: every device sees every `round-ended`
  // broadcast regardless of whose it is, so this fills in identically on
  // every device in the group — including the guide's, which has no
  // `round-ended` of its own to trigger the old per-device transition at
  // all. Reset to {} on this device's own `game-started` (a fresh round
  // means fresh results), so a stale entry can never satisfy "the whole
  // team is done" for a round that hasn't started yet.
  const [roundResultsByToken, setRoundResultsByToken] = useState({});

  const channelRef = useRef(null);
  const forkChoiceHandlerRef = useRef(null);
  // Registered by GameRoom.jsx (see onPlayerStateReceived below) to turn a
  // relayed `player-state` broadcast into a call on the live Sky Path
  // instance's updateTeammate() — same one-handler-in-a-ref pattern as
  // forkChoiceHandlerRef, for the same reason (the channel is created once,
  // inside join(), before GameRoom.jsx even exists to register anything).
  const playerStateHandlerRef = useRef(null);
  // Same pattern again for the generic `game-event` relay (pickup claims,
  // abduction targeting) — see the handler in join().
  const gameEventHandlerRef = useRef(null);
  // And for the projector's `report-state` request (GameRoom.jsx registers
  // the live game's reportState).
  const reportStateHandlerRef = useRef(null);
  // Abduction targeting, 2026-09-15 — the target menu lists players on
  // OTHER teams with "which island the player is currently on, updating
  // only once they have fully reached the island" (Luke). The channel is
  // session-wide, so every team's player-state reports already reach this
  // device; the player-state handler below records the island from every
  // 'resting' report (a player mid-bridge keeps showing the island they
  // left, which is exactly the rule) and marks a player out on 'gone' or a
  // round-ended report. Guides have no position and must be excluded, so
  // each team's guideToken is recorded from ITS game-started broadcast too
  // (the handler otherwise ignores other teams' round starts). Both are
  // refs, not state: read on demand when the menu opens, never rendered.
  const islandsRef = useRef(new Map()); // token -> { forkIndex, out }
  const guideByGroupRef = useRef(new Map()); // groupId -> guideToken
  // Session-wide character/colour table, same reasoning and same source as
  // islandsRef right above: every player-state ping already carries
  // characterKey/colorHex (see skyPath.js's notifyPlayerState), it's just
  // that the handler below used to throw that away for anyone outside this
  // device's own group. Recording it here — unconditionally, same as
  // islandsRef — is what lets getAbductionTargets() hand back a target's
  // REAL character/colour instead of the 'ghost'/gold placeholder abductUI
  // used to be stuck with. A token with no entry yet (this device hasn't
  // received a ping from them since the round started) means "not known
  // yet" — the caller's own fallback, not a value to guess here.
  const charByTokenRef = useRef(new Map()); // token -> { characterKey, colorHex }
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

  // Per-team channel for movement pings (2026-10-07). Supabase Realtime
  // counts a message once sent and once per device it's delivered to, with
  // a per-second cap per plan (Free 100, Pro 500). On the one session-wide
  // channel, every phone received every team's ~7-a-second walking pings:
  // one walking player in a class of 25 was ~170 messages a second. So
  // 'moving' pings go to `lobby-CODE-team-N` (the team, plus the projector),
  // and only the rare discrete reports ('resting', 'departing', 'gone') stay
  // on the main channel, where other teams still need them (abduction
  // targeting's island table). Each report carries `seq`, rising per
  // sender (seeded from the clock, so it keeps rising across a reload): two
  // channels can deliver out of order, and a late 'moving' ping landing
  // after a 'resting' would pull the rig back off its seat.
  const teamChannelRef = useRef(null); // { ch, groupId, ready }
  const playerStateListenerRef = useRef(null); // the shared handler, set in join()
  const lastSeqRef = useRef(new Map()); // sender token -> highest seq seen
  const seqRef = useRef(Date.now());
  const ensureTeamChannel = useCallback(
    (groupId) => {
      if (teamChannelRef.current?.groupId === groupId) return;
      if (teamChannelRef.current) supabase.removeChannel(teamChannelRef.current.ch);
      teamChannelRef.current = null;
      if (groupId == null || !hasRealSession) return;
      const ch = supabase.channel(`lobby-${code}-team-${groupId}`);
      const entry = { ch, groupId, ready: false };
      ch.on('broadcast', { event: 'player-state' }, ({ payload }) => playerStateListenerRef.current?.(payload));
      ch.subscribe((st) => {
        if (st === 'SUBSCRIBED') entry.ready = true;
      });
      teamChannelRef.current = entry;
    },
    [code, hasRealSession],
  );

  const transition = useCallback((phase, nextRound) => {
    roundStateRef.current = { phase, round: nextRound };
    setRoundPhase(phase);
    setRound(nextRound);
  }, []);

  // The character and colour chosen on the join screen (PlayerJoin.jsx),
  // 2026-10-05. Sent in this device's presence, so the teacher's lobby board
  // shows the name in the player's own colour, and handed to the game so it
  // skips its own character select. Null when joining another way (the dev
  // lobby), in which case the game still asks.
  const [look, setLook] = useState(null);
  const lookRef = useRef(null);
  const trackPayload = useCallback(
    (p) => ({
      token,
      displayName: p.displayName,
      score: p.score,
      equipment: p.equipment,
      groupId: p.groupId,
      characterKey: lookRef.current?.characterKey ?? null,
      colorHex: lookRef.current?.colorHex ?? null,
      // The round this device is in, if any, so the teacher's lobby board
      // can tell a player who is back but no longer in their round (a
      // reloaded phone) from one still playing (LobbyBoard.jsx's outSet).
      roundId: roundStateRef.current.round?.roundId ?? null,
    }),
    [],
  );

  useEffect(() => {
    const p = identityStore.getParticipant(token);
    setParticipant(p ?? null);
  }, []);

  // Set when the teacher's game turns this device away (more than
  // sessionConfig.js's PLAYER_CAP players); see the `lobby-full` handler.
  const [full, setFull] = useState(false);
  // Set when the teacher's series of rounds is over (every team member has
  // guided): the victory scene is on the teacher's screen, and this device
  // says so (App.jsx's RoundOver). Cleared by the next round start.
  const [seriesEnded, setSeriesEnded] = useState(false);
  // The teacher's board says this round is over (`round-over`): sent when a
  // team's round ends because a runner dropped out, so teammates stop
  // waiting for them (see teamComplete below), or when a dropped guide's
  // round can't be restarted.
  const [overRoundId, setOverRoundId] = useState(null);
  // Set when this device's team has started a round without it (it was
  // away when the round was planned, or is a newcomer not yet in a team's
  // series): PlayerJoin.jsx says it'll play from the next round.
  const [sittingOut, setSittingOut] = useState(false);
  // Set when the teacher removes this player from the game (LobbyBoard.jsx's
  // Remove): it leaves, forgets how to rejoin, and says so.
  const [removed, setRemoved] = useState(false);

  const applyGroupAssignment = useCallback(
    (assignments) => {
      if (!(token in assignments)) return; // this device wasn't part of the assignment
      // Known at once, not only after the presence round-trip below: the
      // lobby board sends the teams and the round start close together, and
      // the game-started handler reads this ref.
      myGroupIdRef.current = assignments[token];
      ensureTeamChannel(assignments[token]);
      const p = identityStore.setGroup(token, assignments[token]);
      setParticipant(p);
      channelRef.current?.track(trackPayload(p));
    },
    [trackPayload, ensureTeamChannel],
  );

  useEffect(() => {
    const mine = participants.find((p) => p.token === token);
    myGroupIdRef.current = mine?.groupId ?? null;
    if (mine?.groupId != null) ensureTeamChannel(mine.groupId);
    participantsRef.current = participants;
  }, [participants]);

  const join = useCallback(
    (name, chosenLook = null) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      if (channelRef.current) return; // already joined this session
      lookRef.current = chosenLook;
      setLook(chosenLook);

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
      // The teacher's game is full (sessionConfig.js's PLAYER_CAP): leave it,
      // and say so on screen.
      ch.on('broadcast', { event: 'lobby-full' }, ({ payload }) => {
        if (!(payload.tokens ?? []).includes(token)) return;
        setFull(true);
        setStatus('this game is full');
        ch.untrack();
      });
      ch.on('broadcast', { event: 'series-ended' }, () => {
        setSeriesEnded(true);
        setSittingOut(false);
      });
      ch.on('broadcast', { event: 'removed' }, ({ payload }) => {
        if (!(payload.tokens ?? []).includes(token)) return;
        setRemoved(true);
        setStatus('removed from this game');
        try {
          localStorage.removeItem(joinedKey(code));
        } catch {
          // Nothing saved to forget.
        }
        ch.untrack();
      });
      // The projector opened or reloaded mid-round and needs everyone's
      // position: phones only report on a change (skyPath.js reportState).
      ch.on('broadcast', { event: 'report-state' }, () => reportStateHandlerRef.current?.());
      ch.on('broadcast', { event: 'round-over' }, ({ payload }) => setOverRoundId(payload.roundId));
      ch.on('broadcast', { event: 'groups-updated' }, ({ payload }) => {
        applyGroupAssignment(payload.assignments);
      });
      ch.on('broadcast', { event: 'game-started' }, ({ payload }) => {
        // Every team's round start is worth two facts for abduction
        // targeting (see islandsRef/guideByGroupRef): who its guide is, and
        // that its players are all back on island 1 with no one out.
        guideByGroupRef.current.set(payload.groupId, payload.guideToken);
        for (const tok of payload.roster ?? []) islandsRef.current.set(tok, { forkIndex: 1, out: false });
        // Addressed to this device if it's named in the round (its guide, or
        // in its roster), or failing that if it's for this device's group.
        // By name first: the lobby board sends teams and the round start
        // close together, and the group alone could still be out of date.
        const named = payload.guideToken === token || (payload.roster ?? []).includes(token);
        if (!named) {
          // A round start always names its runners now (roundStart.js), so
          // one for this device's own team that leaves it out means it sits
          // this round out; only a start with no roster goes by group alone.
          const mine = payload.groupId === myGroupIdRef.current;
          if (mine && payload.roster && roundStateRef.current.phase !== 'playing') setSittingOut(true);
          if (payload.roster || !mine) return;
        }
        myGroupIdRef.current = payload.groupId;
        ensureTeamChannel(payload.groupId);
        setSeriesEnded(false);
        setSittingOut(false);
        setRoundResultsByToken({}); // fresh round, fresh scoreboard — see this state's own comment above
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
          // Which item sits on island 2 this round ('jetpack' | 'abduction')
          // — see TeacherDashboard's startGame() and skyPath.js's pickup
          // section.
          pickup: payload.pickup ?? null,
          result: null,
        });
      });
      // One generic relay for the smaller in-round events (see
      // `sendGameEvent` below) rather than a new event name + handler ref
      // per feature. Routing is per `kind`: group-scoped kinds are only
      // delivered from a sender in THIS device's group (same reasoning as
      // player-state's own check above — the channel is session-wide);
      // addressed kinds are delivered only to the device they name.
      ch.on('broadcast', { event: 'game-event' }, ({ payload }) => {
        const sender = participantsRef.current.find((p) => p.token === payload.token);
        if (!sender) return;
        const sameGroup = myGroupIdRef.current !== null && sender.groupId === myGroupIdRef.current;
        switch (payload.kind) {
          case 'pickup-claim':
          // The abduction-defence handshake between a targeted player and
          // their own team's guide (see skyPath.js's "defence queue"
          // section) — team-internal, and every teammate needs start/end
          // too, for the "[Guide] is helping [Defender]" message.
          case 'defence-request':
          case 'defence-start':
          case 'defence-end':
            if (!sameGroup) return;
            break;
          case 'abduct-target': // an attacker (any team) naming THIS device as their target
            if (payload.targetToken !== token) return;
            break;
          case 'abduct-result': // the target's device reporting back to THIS device, the attacker
            if (payload.toToken !== token) return;
            break;
          // The guide's own chosen avatar, for the victory stage only — see
          // skyPath.js's `finishCharacterSelect` for why this is a
          // dedicated event rather than an ordinary player-state ping
          // (that path is what used to leak a phantom guide rig into a
          // live player's own game). Stored straight into the SAME
          // session-wide table `getCharacter`/`getAbductionTargets` already
          // read for everyone else — nothing in the live game needs to
          // react to this, so it never reaches gameEventHandlerRef below.
          case 'guide-character':
            if (!sameGroup) return;
            charByTokenRef.current.set(payload.token, { characterKey: payload.characterKey, colorHex: payload.colorHex });
            return;
          default:
            return; // unknown kind — ignore rather than hand the game something it doesn't understand
        }
        gameEventHandlerRef.current?.(payload.kind, payload);
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
      // One handler for player-state from either channel (see teamChannelRef).
      const onPlayerState = (payload) => {
        if (payload.seq != null) {
          const last = lastSeqRef.current.get(payload.token);
          if (last != null && payload.seq <= last) return; // overtaken by a later report
          lastSeqRef.current.set(payload.token, payload.seq);
        }
        // Session-wide island table for abduction targeting — see islandsRef.
        // Only a 'resting' report moves someone; 'departing'/'moving' leave
        // them on the island they left.
        if (payload.phase === 'resting' && payload.forkIndex != null) {
          islandsRef.current.set(payload.token, { forkIndex: payload.forkIndex, out: false });
        } else if (payload.phase === 'gone') {
          const cur = islandsRef.current.get(payload.token);
          islandsRef.current.set(payload.token, { forkIndex: cur?.forkIndex ?? 1, out: true });
        }
        // See charByTokenRef above — unconditional, same as islandsRef, so a
        // cross-team abduction target's real character/colour is on hand
        // when getAbductionTargets() is asked, not just a same-team one's.
        if (payload.characterKey) {
          charByTokenRef.current.set(payload.token, { characterKey: payload.characterKey, colorHex: payload.colorHex });
        }
        if (payload.token === token) return; // that's me — Sky Path already knows its own position
        // Only relevant if the sender is actually a teammate right now — the
        // lobby channel is shared by every group in the session (see this
        // file's own header comment), so without this check a player in a
        // DIFFERENT group would show up standing on this group's islands.
        const sender = participantsRef.current.find((p) => p.token === payload.token);
        if (!sender || sender.groupId !== myGroupIdRef.current || myGroupIdRef.current === null) return;
        playerStateHandlerRef.current?.(payload.token, payload);
      };
      playerStateListenerRef.current = onPlayerState;
      ch.on('broadcast', { event: 'player-state' }, ({ payload }) => onPlayerState(payload));
      ch.on('broadcast', { event: 'round-ended' }, ({ payload }) => {
        // Anyone whose own round has ended (reached the temple, or fell
        // without a 'gone' having arrived) is no longer an abduction target
        // — see islandsRef.
        const cur = islandsRef.current.get(payload.token);
        islandsRef.current.set(payload.token, { forkIndex: cur?.forkIndex ?? 1, out: true });
        // The team scoreboard (see roundResultsByToken's own comment above)
        // — filled in for EVERY reporting token, unconditionally, unlike the
        // per-device phase transition below which only ever reacts to this
        // device's own. Guarded on roundId so a late report from a round
        // this device has already moved on from can't pollute a fresh one.
        if (roundStateRef.current.round?.roundId === payload.roundId) {
          setRoundResultsByToken((prev) => ({ ...prev, [payload.token]: payload.result }));
        }
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
    [code, applyGroupAssignment, trackPayload, transition, ensureTeamChannel],
  );

  // Presence carries the current round (see trackPayload), so re-announce it
  // whenever this device moves into or out of a round.
  const roundIdNow = round?.roundId ?? null;
  useEffect(() => {
    if (!joined) return;
    channelRef.current?.track(trackPayload(identityStore.getParticipant(token)));
  }, [roundIdNow, joined, trackPayload]);

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
    const payload = { token, seq: ++seqRef.current, ...state };
    // Movement pings to the team's own channel once it's up (see
    // teamChannelRef); everything else, and pings before then, to the main one.
    const team = teamChannelRef.current;
    const ch = state.phase === 'moving' && team?.ready ? team.ch : channelRef.current;
    ch?.send({ type: 'broadcast', event: 'player-state', payload });
  }, []);

  /** Registers the handler that re-sends this device's state when the projector asks (see `report-state`). */
  const onReportStateRequested = useCallback((handler) => {
    reportStateHandlerRef.current = handler;
  }, []);

  /** Registers the handler for relayed in-round game events (see the `game-event` handler in join() for the kinds and their routing). */
  const onGameEventReceived = useCallback((handler) => {
    gameEventHandlerRef.current = handler;
  }, []);

  /**
   * Sends a small in-round event (e.g. `pickup-claim`) for the relay to
   * hand back to everyone it concerns — this device included, via
   * broadcast self:true, so the game only ever acts on the relayed copy.
   * That relay ordering is what settles a race (two players claiming the
   * same pickup at once): everyone sees the same first claim.
   */
  const sendGameEvent = useCallback((kind, data = {}) => {
    channelRef.current?.send({ type: 'broadcast', event: 'game-event', payload: { token, kind, ...data } });
  }, []);

  /**
   * Who this device may aim an abduction at, right now — Luke, 2026-09-15:
   * players on OTHER teams (this device's own team only when the session
   * has just the one team, so it stays testable), guides excluded, anyone
   * already out (fallen/abducted/finished) excluded. Each entry carries the
   * island the target was last seen RESTING on (see islandsRef), and their
   * real characterKey/colorHex (see charByTokenRef) — null for either if no
   * player-state ping has arrived from them yet this round. Whether an
   * island is the last one (the "fizzle" rule) is Sky Path's call, since it
   * owns N_FORKS.
   */
  const getAbductionTargets = useCallback(() => {
    const everyone = participantsRef.current;
    const myGroup = myGroupIdRef.current;
    const groupCount = new Set(everyone.map((p) => p.groupId).filter((g) => g !== null && g !== undefined)).size;
    const allowOwnTeam = groupCount <= 1;
    return everyone
      .filter((p) => p.token !== token)
      .filter((p) => p.groupId !== null && p.groupId !== undefined)
      .filter((p) => allowOwnTeam || p.groupId !== myGroup)
      .filter((p) => guideByGroupRef.current.get(p.groupId) !== p.token)
      .filter((p) => !islandsRef.current.get(p.token)?.out)
      .map((p) => {
        const char = charByTokenRef.current.get(p.token);
        return {
          token: p.token,
          displayName: p.displayName,
          groupId: p.groupId,
          island: islandsRef.current.get(p.token)?.forkIndex ?? 1, // never reported = still on island 1
          // null = no player-state ping received from them yet this round —
          // the caller's own placeholder, not something to guess here.
          characterKey: char?.characterKey ?? null,
          colorHex: char?.colorHex ?? null,
        };
      });
  }, []);

  /** A participant's lobby display name, or null — read live, so a late join/rename is picked up. */
  const getDisplayName = useCallback((tok) => participantsRef.current.find((p) => p.token === tok)?.displayName ?? null, []);

  /** A player's real character/colour, from the same session-wide table getAbductionTargets already reads — see charByTokenRef's own comment. Null for either field if no player-state ping has arrived from them yet (e.g. the victory screen's guide slot, who never sends one). */
  const getCharacter = useCallback((tok) => {
    const char = charByTokenRef.current.get(tok);
    return { characterKey: char?.characterKey ?? null, colorHex: char?.colorHex ?? null };
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

  // True once every PLAYER in this round's roster (guide excluded — they
  // have no `round-ended` of their own) has a result in the scoreboard
  // above. Checked here, not inside the channel handler, so it stays
  // reactive to `round` changing too (e.g. this device's own `round.roster`
  // only exists once its `game-started` has actually landed).
  const teamComplete = !!round?.roster?.length && (round.roster.every((tok) => tok in roundResultsByToken) || overRoundId === round.roundId);

  return {
    token,
    hasRealSession,
    participant,
    joined,
    status,
    participants,
    myGroupId,
    full,
    seriesEnded,
    sittingOut,
    removed,
    look,
    roundPhase,
    round,
    roundResultsByToken,
    teamComplete,
    join,
    addPoint,
    sendForkChoice,
    onForkChoiceReceived,
    sendPlayerState,
    onPlayerStateReceived,
    sendGameEvent,
    onGameEventReceived,
    onReportStateRequested,
    getAbductionTargets,
    getDisplayName,
    getCharacter,
    reportRoundEnd,
    leaveGame,
    resetDevice,
  };
}
