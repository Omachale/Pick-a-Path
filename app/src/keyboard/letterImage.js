/**
 * "First letter capital all other letters lower case" — Luke, 2026-09-20.
 * Only position 0 of the whole typed string, not of each word. Shared
 * between the debug harness (KeyboardTestHarness.jsx) and the real
 * abduction-defence screen (abductDefense.js) — same rule, same assets.
 */
export function letterImageSrc(ch, isFirst) {
  if (!/[a-zA-Z]/.test(ch)) return null; // no cardboard-cutout digits yet — see chat
  const cased = isFirst ? ch.toUpperCase() : ch.toLowerCase();
  return `/textures/letters/${isFirst ? 'upper-v2' : 'lower'}/${cased}.png`;
}
