/**
 * The model-town test page (model-town.html): the victory scene with
 * made-up teams, plus its test buttons (press D) and debug hooks.
 */
import { mountVictoryTown } from './victoryTown.js';
import { CHARACTERS, PALETTE } from '../skypath/characters.js';
import { scoreBreakdown } from '../lobby/scoring.js';

function mulberry32(seed) {
  return function next() {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- demo teams
// Made-up teams for the test page: 3, 4, 5 and 6 people (each including a
// guide), so every team size is on show. Names keep to letters and 10 at
// most, like real ones.
const DEMO_TEAMS = (() => {
  const names = ['Zara', 'Milo', 'Indy', 'Bea', 'Sam', 'Kit', 'Hana', 'Omar', 'Lucia', 'Kenji', 'Amara', 'Felix', 'Priya', 'Tomas', 'Yuki', 'Noor', 'Mateo', 'Ines'];
  let n = 0;
  const pr = mulberry32(3);
  const person = () => {
    const k = n++;
    return {
      name: names[k % names.length],
      characterKey: CHARACTERS[(k * 5) % CHARACTERS.length].key,
      colorHex: PALETTE[k % PALETTE.length].hex,
    };
  };
  return [3, 4, 5, 6].map((size) => ({
    players: Array.from({ length: size - 1 }, () => ({
      ...person(),
      result: {
        correctCount: 2 + Math.floor(pr() * 5),
        itemsCollected: pr() < 0.5 ? 1 : 0,
        jetpackKeptAtFinish: pr() < 0.3,
        resistCount: Math.floor(pr() * 2),
      },
    })),
    guide: person(),
  }));
})();


// As one round's results; the guide scores the average of the runners, per
// category (the same rule the real series uses, see series.js).
const TEAMS = DEMO_TEAMS.map((t) => {
  const runners = t.players.map((p) => ({ name: p.name, characterKey: p.characterKey, colorHex: p.colorHex, breakdown: scoreBreakdown(p.result) }));
  const guide = {};
  for (const k of ['islands', 'items', 'jetpackBonus', 'resists']) guide[k] = runners.reduce((a, r) => a + r.breakdown[k], 0) / runners.length;
  return { seats: [...runners, { ...t.guide, breakdown: guide }] };
});

const host = document.createElement('div');
host.style.cssText = 'position:fixed;inset:0';
document.body.appendChild(host);
mountVictoryTown(host, { teams: TEAMS, demo: true });
