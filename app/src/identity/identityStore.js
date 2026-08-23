/**
 * Identity store: the seam between "a stable token" and "what that token
 * means" (display name, group, score, equipment).
 *
 * The point of this file is that the lobby and game-mode layers only ever
 * talk to this interface, never to localStorage or Supabase directly. Step 1
 * (this file) ships LocalIdentityStore, backed by localStorage, so the lobby
 * can be built and tested before any backend exists. Step 5 (persistent
 * classes, see supabaseIdentityStore.js) adds a store implementing this
 * same interface against a roster row instead of a local record, with two
 * differences forced by that being a network-backed store rather than a
 * local one: every method is async, and a token has to be *claimed* against
 * a roster row by name (claimByName) before getParticipant means anything —
 * see that file's own doc comment for why. Everywhere else, the interface
 * is identical, which is the point: the lobby/game-mode code doesn't change
 * based on which store is constructed at startup.
 *
 * Interface every store must implement (documented here since JS has no
 * enforced interfaces):
 *
 *   getParticipant(token) -> Participant
 *     Reads (and lazily creates, for a brand new token) the participant
 *     record for this token. Never throws for an unknown token — an unknown
 *     token just means "new participant."
 *
 *   setDisplayName(token, name) -> Participant
 *     Sets/renames. For LocalIdentityStore this is free-text; once backed by
 *     a roster (step 5) this becomes "pick your name from this list" instead
 *     — same method, different validation, callers don't need to know.
 *
 *   setGroup(token, groupId | null) -> Participant
 *     Lobby-layer concern (see handoff's "two decoupled layers"); stored
 *     here anyway because it's still per-participant state, not room state.
 *
 *   addScore(token, delta) -> Participant
 *     Adds to (never sets) the running total, because "a room reports
 *     points earned this round" is the only thing a game mode should ever
 *     do — see handoff's "Score and inventory live on the participant's
 *     identity, not on the room."
 *
 *   addEquipment(token, item) -> Participant
 *     Appends one item to the participant's equipment list. `item` is an
 *     opaque string ID for now (e.g. "golden-quill") — what an ID unlocks is
 *     a game-mode/UI concern, this store just remembers which IDs a
 *     participant holds.
 *
 * A Participant is always the shape:
 *   { token, displayName, groupId, score, equipment: string[] }
 *
 * @typedef {{ token: string, displayName: string | null, groupId: string | null, score: number, equipment: string[] }} Participant
 */

const STORAGE_PREFIX = 'skypath.participant.';

function defaultParticipant(token) {
  return { token, displayName: null, groupId: null, score: 0, equipment: [] };
}

/**
 * localStorage-backed identity store — step 1's implementation. Every
 * participant record lives under its own key so multiple tokens (e.g.
 * testing two "devices" in one browser) don't collide.
 */
export function createLocalIdentityStore(storage = globalThis.localStorage) {
  function key(token) {
    return STORAGE_PREFIX + token;
  }

  function read(token) {
    const raw = storage.getItem(key(token));
    return raw ? JSON.parse(raw) : defaultParticipant(token);
  }

  function write(participant) {
    storage.setItem(key(participant.token), JSON.stringify(participant));
    return participant;
  }

  return {
    getParticipant(token) {
      return read(token);
    },

    setDisplayName(token, name) {
      const p = read(token);
      p.displayName = name;
      return write(p);
    },

    setGroup(token, groupId) {
      const p = read(token);
      p.groupId = groupId;
      return write(p);
    },

    addScore(token, delta) {
      const p = read(token);
      p.score += delta;
      return write(p);
    },

    addEquipment(token, item) {
      const p = read(token);
      if (!p.equipment.includes(item)) p.equipment.push(item);
      return write(p);
    },
  };
}
