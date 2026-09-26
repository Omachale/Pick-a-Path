/**
 * Turns a Sky Path round's raw per-player facts into actual points — kept
 * OUT of skyPath.js on purpose, per that file's own `emitRoundEnd` comment:
 * "a game mode never accumulates or reads a running total itself; it only
 * ever emits what happened this round" (handoff doc). This is the
 * session-layer piece that decides what those facts are worth, so both
 * useLobby.js (aggregating results) and VictoryScreen.jsx (displaying them)
 * read the same numbers from one place.
 *
 * Luke, 2026-09-25, exactly as specified:
 *   - 1 point per island reached via a CORRECT answer. A rescue via jetpack
 *     never earns one, since the fork it came from was answered wrong —
 *     `correctCount` already only increments on a correct choice (see
 *     skyPath.js's `applyChoice`), so this needs no special-casing at all.
 *   - 1 bonus point for reaching the final island with a jetpack still on.
 *   - 1 point for obtaining either item (jetpack or the alien device).
 *   - 1 point per successful abduction resist.
 */
export function scoreBreakdown(result) {
  if (!result) return { islands: 0, items: 0, jetpackBonus: 0, resists: 0 };
  return {
    islands: result.correctCount ?? 0,
    items: (result.itemsCollected ?? 0) * 1,
    jetpackBonus: result.jetpackKeptAtFinish ? 1 : 0,
    resists: (result.resistCount ?? 0) * 1,
  };
}

export function totalScore(result) {
  const b = scoreBreakdown(result);
  return b.islands + b.items + b.jetpackBonus + b.resists;
}

/** Guides score the average of their team's scores, rounded to the nearest 0.5 — Luke, 2026-09-25. */
export function roundToNearestHalf(n) {
  return Math.round(n * 2) / 2;
}
