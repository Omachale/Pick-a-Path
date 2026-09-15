/**
 * The minimal-pair word lists shown at each fork instead of the old plain
 * "Left"/"Right" arrows — Luke, 2026-09-06: "rather than left and right
 * arrows, I want the guide and player to see words... that require them to
 * listen carefully to the guide. We'll start with minimal pairs."
 *
 * The list itself lives in public/data/word-pairs.json, NOT here — it's
 * meant to be editable directly by a teacher without touching code (see
 * word-pairs.README.md next to it for the format). This module only loads,
 * validates, and randomly assigns that data; it never hardcodes a single
 * word.
 */

/**
 * Fetches and validates public/data/word-pairs.json. Throws with a specific,
 * actionable message on any malformed entry — pointing at the exact `id` (or
 * index, if even that's missing/wrong) responsible — rather than letting a
 * teacher's typo surface as a vague crash somewhere else in the game much
 * later. Validation happens once, here, so nothing downstream has to
 * re-check that a "pair" really has two distinct, non-empty words.
 */
export async function loadWordPairs(url = 'data/word-pairs.json') {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load ${url}: HTTP ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data?.pairs)) {
    throw new Error(`${url}: expected a top-level { "pairs": [...] } array`);
  }

  const seenIds = new Set();
  return data.pairs.map((entry, i) => {
    const label = entry?.id ? `"${entry.id}"` : `entry #${i + 1}`;
    if (typeof entry?.id !== 'string' || !entry.id) {
      throw new Error(`${url}: ${label} is missing a string "id"`);
    }
    if (seenIds.has(entry.id)) {
      throw new Error(`${url}: duplicate "id" — ${label} reuses an id already seen above it`);
    }
    seenIds.add(entry.id);
    const words = entry.words;
    if (!Array.isArray(words) || words.length !== 2) {
      throw new Error(`${url}: ${label} must have exactly 2 "words", found ${words?.length ?? 'none'}`);
    }
    const [a, b] = words;
    if (typeof a !== 'string' || !a.trim() || typeof b !== 'string' || !b.trim()) {
      throw new Error(`${url}: ${label}'s two words must both be non-empty text`);
    }
    if (a.trim().toLowerCase() === b.trim().toLowerCase()) {
      throw new Error(`${url}: ${label} pairs a word with itself ("${a}")`);
    }
    return { id: entry.id, words: [a.trim(), b.trim()] };
  });
}

/** Fisher-Yates — unbiased, in place. */
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Picks `n` pairs for one round — one per fork. Never repeats a pair within
 * the round as long as `pairs.length >= n` (the expected case, and the
 * reason word-pairs.json is meant to grow well past N_FORKS); if the list is
 * ever shorter than that, wraps around and reuses pairs rather than
 * crashing, once — logging a warning so a thin list gets noticed rather than
 * just quietly repeating forever.
 *
 * Returns an array of `{ a, b }` — plain word strings, not pair objects,
 * NOT yet assigned to a physical side — one entry per fork, in fork order.
 *
 * Left/right placement used to be decided right here (one shared coin flip
 * per fork, sent to the whole group). Luke, 2026-09-13: "the correct
 * side/bridge and the matching word needs to be randomised per player...
 * we need a way to prevent players from seeing which choice their teammates
 * made." Moved to skyPath.js's buildFork() instead, which does its own
 * LOCAL random flip per device — see that function's own comment. What
 * stays shared (broadcast once, here) is only the PAIR itself and which of
 * its two words is correct (skyPath.js's CORRECT_BY_FORK, entirely
 * independent of this draw, same as before) — every device must agree on
 * what word the guide actually said, but not on which side it's standing.
 */
export function assignForkWords(pairs, n) {
  if (pairs.length === 0) {
    throw new Error('assignForkWords: no word pairs available — check word-pairs.json loaded correctly');
  }
  if (pairs.length < n) {
    console.warn(
      `word-pairs.json has only ${pairs.length} pair(s) for ${n} forks — some pairs will repeat this round. Add more pairs to word-pairs.json to avoid this.`
    );
  }
  const shuffled = shuffle(pairs.slice());
  const result = [];
  for (let i = 0; i < n; i++) {
    const [a, b] = shuffled[i % shuffled.length].words;
    result.push({ a, b });
  }
  return result;
}
