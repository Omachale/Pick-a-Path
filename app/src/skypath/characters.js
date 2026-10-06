/**
 * The characters and colours a player can choose from. One list, shared by
 * the game itself (skyPath.js), the player's join screen
 * (lobby/PlayerJoin.jsx) and the teacher's lobby board, so a choice made on
 * the join screen means the same thing everywhere. Moved out of skyPath.js
 * 2026-10-05, when choosing moved from round start to joining.
 */

// `tex`/`ext` name the card art in public/textures/.
export const CHARACTERS = [
  { key: 'woman2', tex: 'figure-woman2', ext: 'webp' },
  { key: 'indy', tex: 'figure-indy', ext: 'png' },
  { key: 'woman1', tex: 'figure-woman1', ext: 'webp' },
  { key: 'alien', tex: 'figure-alien', ext: 'webp' },
  { key: 'bat', tex: 'figure-bat', ext: 'webp' },
  { key: 'dolphin', tex: 'figure-dolphin', ext: 'webp' },
  { key: 'ghost', tex: 'figure-ghost', ext: 'webp' },
  { key: 'man1', tex: 'figure-man1', ext: 'webp' },
  { key: 'man2', tex: 'figure-man2', ext: 'webp' },
  { key: 'meerkat', tex: 'figure-meerkat', ext: 'webp' },
  { key: 'monkey', tex: 'figure-monkey', ext: 'webp' },
  { key: 'robot', tex: 'figure-robot', ext: 'webp' },
  { key: 'wizard', tex: 'figure-wizard', ext: 'webp' },
];

// A small fixed palette rather than a free colour picker: every option here
// has been checked against the backing art, which a free picker couldn't
// guarantee (very low saturation, for instance, would wash out the fold
// shading the split preserves).
export const PALETTE = [
  { key: 'blue', label: 'Blue', hex: 0x5a9fe0 },
  { key: 'red', label: 'Red', hex: 0xd9564a },
  { key: 'green', label: 'Green', hex: 0x5cb86c },
  { key: 'yellow', label: 'Yellow', hex: 0xe0b93c },
  { key: 'purple', label: 'Purple', hex: 0x9a6fd6 },
  { key: 'orange', label: 'Orange', hex: 0xe08a3c },
  { key: 'teal', label: 'Teal', hex: 0x3fb8b0 },
  { key: 'pink', label: 'Pink', hex: 0xe07fb0 },
];

export const characterSrc = (key) => {
  const c = CHARACTERS.find((x) => x.key === key) ?? CHARACTERS[0];
  return `textures/${c.tex}.${c.ext}`;
};
