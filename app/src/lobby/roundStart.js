/**
 * Starting a round: the one place that decides a round's shared facts
 * (guide, words, forks, seating, pickup) and broadcasts them. Moved here from
 * TeacherDashboard.jsx's SessionPanel (2026-10-05) so the old dashboard and
 * the new lobby board start rounds the same way. The reasoning behind each
 * part is in the comments below, carried over unchanged.
 */
import { loadWordPairs, assignForkWords } from '../skypath/wordPairs.js';

// Must match Sky Path's own N_FORKS (see app/src/skypath/skyPath.js) and
// useLobby.js's own copy of the same constant: the modules don't share a
// build-time config yet.
export const SKY_PATH_N_FORKS = 6;

const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I/O: easy to misread on a projector

export function randomJoinCode() {
  let code = '';
  for (let i = 0; i < 5; i++) code += CODE_LETTERS[Math.floor(Math.random() * CODE_LETTERS.length)];
  return code;
}

/**
 * `crypto.randomUUID()` only exists in a secure context (https, or
 * http://localhost specifically), and the teacher's page has been used over
 * plain http:// on a LAN address. Luke, 2026-09-13: pressing "Start game" did
 * nothing at all, for every player, because `crypto.randomUUID is not a
 * function` killed the async click handler silently. identity/token.js's
 * generateToken() has this same fallback for the same reason.
 */
export function randomRoundId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `round_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

/**
 * Creates the per-session memory a teacher keeps between rounds: whose turn
 * at guide is next in each group, and the word pairs (loaded once).
 */
export function createRoundState() {
  return { guideHistory: new Map(), wordPairs: null }; // groupId -> Set<token>
}

/**
 * Starts (or restarts) a round for every group given. `groups` maps
 * groupId -> array of player tokens. Sending this again is also what "next
 * round" is: a device reacts to a fresh `game-started` for its group
 * whatever phase it was in (see useLobby.js).
 *
 * Words are picked HERE, once per group, and broadcast alongside `forks`.
 * Luke, after the first live multiplayer test: "the words the guide sees are
 * different from the words the players in their teams [see]". Every device
 * used to draw its own random pair and left/right layout; one draw per
 * group, sent to everyone in it, fixed that.
 */
export async function startRounds(send, groups, state) {
  if (!state.wordPairs) state.wordPairs = await loadWordPairs();
  const letters = 'LR';
  for (const [groupId, tokens] of groups) {
    if (tokens.length === 0) continue;
    // Guide rotation: everyone in the group guides once before anyone repeats.
    if (!state.guideHistory.has(groupId)) state.guideHistory.set(groupId, new Set());
    const guided = state.guideHistory.get(groupId);
    let candidates = tokens.filter((t) => !guided.has(t));
    if (candidates.length === 0) {
      guided.clear();
      candidates = tokens;
    }
    const guideToken = candidates[Math.floor(Math.random() * candidates.length)];
    guided.add(guideToken);

    // Fixed seating, 2026-09-13. Luke: "each person will be assigned a
    // position, and that won't change through the round." This one array,
    // broadcast once, IS the assignment: every device in the group builds its
    // seat-offset table from the SAME array by index (skyPath.js's
    // `seatOffsets`). The guide isn't in it: it has no seat.
    const roster = tokens.filter((t) => t !== guideToken);

    const forks = Array.from({ length: SKY_PATH_N_FORKS }, () => letters[Math.random() < 0.5 ? 0 : 1]).join('');
    const words = assignForkWords(state.wordPairs, SKY_PATH_N_FORKS);
    const roundId = randomRoundId();
    // The island-2 pickup, 2026-09-15. Luke: "50% chance of being the
    // jetpack, 50% the abduction trigger." Decided here for the same reason
    // as `words`: every device in the group has to show the same item.
    const pickup = Math.random() < 0.5 ? 'jetpack' : 'abduction';
    send('game-started', { groupId, forks, words, guideToken, roundId, roster, pickup });
  }
}
