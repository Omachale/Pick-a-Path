/**
 * ==========================================================================
 * CARDBOARD UI — the alien device's target picker (content ON the screen)
 * ==========================================================================
 * Read `src/dialProto.js`'s header first (the cardboard UI's own design
 * doc), then `src/alienInterfaceProto.js`'s (the screen this content sits
 * on — its growth isn't replayed here; this page opens straight onto the
 * settled, fully-open screen since THIS prototype's whole subject is what
 * appears on it, not how it got there — see alien-lower.html for the
 * growth). `src/cardboardPanel.js` is the shared backing. TODO.md points
 * at all of these.
 *
 * What this is: Luke, 2026-09-17 — "the player will see players from other
 * teams, cycled through using the two arrows right and left," shown as
 * "the player avatar... along with their name tag above, just as they are
 * in the game, rendered in cardboard lettering." Per his own answers when
 * asked (see TODO.md — three genuine ambiguities, not guessed):
 *   - THIS PASS is arrows + avatar + name tag + working cycling ONLY. No
 *     team-name box, no confirm button — those are explicitly "added soon."
 *   - No shimmer-in/rotate animation yet either — "next step."
 *   - The arrows cycle within ONE team's roster (not a cross-team combined
 *     list) — switching teams will eventually be "clicking on the team
 *     name window," which doesn't exist yet, so for now there's just one
 *     fixed stand-in roster and the arrows cycle through it.
 *
 * THE AVATAR is drawn EXACTLY the art already used in-game
 * (`textures/figure-<key>.<ext>`, the same files skyPath.js's own ROSTER
 * loads) at that image's own natural aspect ratio — never distorted. Its
 * oval coloured backing isn't a separate recolourable layer (checked: the
 * real game only tints the NAME TAG's glow per player colour, never the
 * card) — it's baked into each character's own art already, which is why
 * `indy` already looks exactly like Luke's own mockup without any extra
 * work here.
 *
 * THE NAME TAG reuses `skypath/nameTag.js`'s `buildNameTagCanvas` directly
 * — the actual glyph/cardboard renderer the real game uses, not a
 * lookalike. One real gotcha hit doing this: `buildNameTagCanvas`'s own
 * `glowColor` DEFAULT parameter is a dangling reference to a constant that
 * doesn't exist in that file (`GLOW_COLOR_DEFAULT` — see nameTag.js; the
 * real game's own `attachNameTag` already always passes an explicit colour
 * for exactly this reason) — omitting `glowColor` here throws. Always pass
 * one explicitly.
 *
 * PLACEMENT — baked in 2026-09-17 from the values Luke tuned live against
 * the sliders this page used to have: avatar 224/y343, name tag 49/y189,
 * arrows 114/y350/inset267 (see LAYOUT below). No longer sliders.
 *
 * THE SPIN, added the same day — Luke: "I want the avatar to spin about
 * its vertical axis (not the name)." The real in-game card is a single
 * flat plane with only FRONT art (see skyPath.js's makeCharacterRig — no
 * separate back texture), rendered double-sided, so a real Y-axis spin in
 * 3D would show the mirrored front texture once past 90° — exactly the
 * same "a double-sided plane's back is its own mirrored front" fact the
 * dial's turn already relies on (see dialProto.js). This is plain
 * Canvas2D, not a 3D scene, so that same result is faked the standard 2D
 * way: `ctx.scale(cos(angle), 1)` — squashing to a sliver at 90°/270° and
 * flipping negative past them, which Canvas2D already draws as a mirror
 * for free. Continuous and ambient (SPIN_PERIOD), not tied to cycling.
 *
 * NOT BUILT YET (see TODO.md): the appearance fizzle (six variants being
 * built for Luke to pick from, separately, before any of them land here);
 * the team-name box and switching teams by clicking it; the confirm
 * button; cross-team data (a fixed stand-in roster stands in for
 * `getAbductionTargets()` here); connecting any of this to the real
 * abduction-targeting feature (see the "Paused 2026-09-15" TODO entry).
 */

import { PANEL_SRC, PANEL_SIZE, loadImage, drawPanel } from './cardboardPanel.js';
import { buildNameTagCanvas } from './skypath/nameTag.js';

// --- duplicated from alienInterfaceProto.js (now a THIRD copy — see that
// file's header on why it isn't imported; worth actually consolidating
// into a shared module soon, this makes three places that must be kept in
// sync by hand) ---
const INTERFACE_SRC = 'textures/alien-interface-trimmed.jpg';
const INTERFACE_ASPECT = 992 / 487;
const FINAL_WIDTH = 860;
const FINAL_CENTRE = { x: 516, y: 312 };
function finalRect() {
  const w = FINAL_WIDTH;
  const h = w / INTERFACE_ASPECT;
  return { x: FINAL_CENTRE.x - w / 2, y: FINAL_CENTRE.y - h / 2, w, h };
}
// --- end duplicated block ---

// Stand-in roster — one fixed team, since team-switching isn't built yet
// (Luke: for now it'll just be "clicking on the team name window," which
// doesn't exist in this pass). Names from the lobby's own Dev-player list;
// characters picked from skyPath.js's real ROSTER art, `indy` first since
// it's what Luke's own mockup happened to show.
const ROSTER = [
  { name: 'William', charKey: 'indy', ext: 'png' },
  { name: 'Serena', charKey: 'woman1', ext: 'webp' },
  { name: 'Louis', charKey: 'robot', ext: 'webp' },
  { name: 'Faraday', charKey: 'monkey', ext: 'webp' },
  { name: 'Theresa', charKey: 'bat', ext: 'webp' },
  { name: 'Wilhelmina', charKey: 'wizard', ext: 'webp' },
];
// A little colour variety on the name tags, same hex values skyPath.js's
// own PALETTE uses (that array isn't exported, so these are copied, not
// imported — small enough not to be worth a shared module on its own).
const TAG_COLORS = [0xd9564a, 0x5a9fe0, 0x5cb86c, 0xe0b93c, 0x9a6fd6, 0xe08a3c];

// Baked in — see this file's header. Not sliders any more.
const LAYOUT = {
  avatarHeight: 224,
  avatarCenterY: 343,
  tagHeight: 49,
  tagCenterY: 189,
  arrowSize: 114,
  arrowCenterY: 350,
  arrowInset: 267, // distance from the interface's own left/right edge to each arrow's centre
};
const SPIN_PERIOD = 3; // seconds per full rotation — ambient, ongoing, no slider yet
const state = { index: 0 };

function arrowRects() {
  const iface = finalRect();
  const half = LAYOUT.arrowSize / 2;
  const leftX = iface.x + LAYOUT.arrowInset;
  const rightX = iface.x + iface.w - LAYOUT.arrowInset;
  return {
    left: { x: leftX - half, y: LAYOUT.arrowCenterY - half, w: LAYOUT.arrowSize, h: LAYOUT.arrowSize, cx: leftX },
    right: { x: rightX - half, y: LAYOUT.arrowCenterY - half, w: LAYOUT.arrowSize, h: LAYOUT.arrowSize, cx: rightX },
  };
}

function pointInRect(x, y, r) {
  return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}

async function main() {
  const [panelImg, interfaceImg, arrowLeftImg, arrowRightImg] = await Promise.all([
    loadImage(PANEL_SRC),
    loadImage(INTERFACE_SRC),
    loadImage('textures/alien-arrow-left.png'),
    loadImage('textures/alien-arrow-right.png'),
  ]);

  // Every roster member's avatar + name tag built ONCE up front — cycling
  // is then just picking an index, no async gap while an arrow is held.
  const players = await Promise.all(
    ROSTER.map(async (p, i) => {
      const avatarImg = await loadImage(`textures/figure-${p.charKey}.${p.ext}`);
      const glowColor = `#${TAG_COLORS[i % TAG_COLORS.length].toString(16).padStart(6, '0')}`;
      const { canvas: tagCanvas, aspect: tagAspect } = await buildNameTagCanvas(p.name, { glowColor });
      return { name: p.name, avatarImg, tagCanvas, tagAspect };
    })
  );

  const canvas = document.getElementById('c');
  canvas.width = PANEL_SIZE.w;
  canvas.height = PANEL_SIZE.h;
  const ctx = canvas.getContext('2d');

  function draw(t) {
    drawPanel(ctx, panelImg);
    const iface = finalRect();
    ctx.drawImage(interfaceImg, iface.x, iface.y, iface.w, iface.h);

    const p = players[state.index];

    // Avatar — the art's own natural aspect, never stretched (same rule
    // the growth screen itself follows for its final size) — spun about
    // its own vertical axis; see this file's header for why `scale(cos,1)`
    // is the right 2D stand-in for a real 3D Y-rotation here.
    const avatarAspect = p.avatarImg.naturalWidth / p.avatarImg.naturalHeight;
    const aw = LAYOUT.avatarHeight * avatarAspect;
    const spinAngle = ((t / SPIN_PERIOD) % 1) * Math.PI * 2;
    ctx.save();
    ctx.translate(FINAL_CENTRE.x, LAYOUT.avatarCenterY);
    ctx.scale(Math.cos(spinAngle), 1);
    ctx.drawImage(p.avatarImg, -aw / 2, -LAYOUT.avatarHeight / 2, aw, LAYOUT.avatarHeight);
    ctx.restore();

    // Name tag — real cardboard lettering (see this file's header), sized
    // the same way the in-game version is: a fixed HEIGHT, width derived
    // from the canvas's own aspect so a short vs. long name never distorts.
    // Never spins — Luke: "not the name."
    const tagW = LAYOUT.tagHeight / p.tagAspect;
    ctx.drawImage(p.tagCanvas, FINAL_CENTRE.x - tagW / 2, LAYOUT.tagCenterY - LAYOUT.tagHeight / 2, tagW, LAYOUT.tagHeight);

    // Arrows.
    const { left, right } = arrowRects();
    ctx.drawImage(arrowLeftImg, left.x, left.y, left.w, left.h);
    ctx.drawImage(arrowRightImg, right.x, right.y, right.w, right.h);

    document.getElementById('nameReadout').textContent = `${state.index + 1} / ${players.length} — ${p.name}`;
  }

  function step(dir) {
    state.index = (state.index + dir + players.length) % players.length;
  }

  canvas.addEventListener('click', (e) => {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const x = (e.clientX - rect.left) * scaleX;
    const y = (e.clientY - rect.top) * scaleY;
    const { left, right } = arrowRects();
    if (pointInRect(x, y, left)) step(-1);
    else if (pointInRect(x, y, right)) step(1);
  });
  canvas.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const x = (e.clientX - rect.left) * scaleX;
    const y = (e.clientY - rect.top) * scaleY;
    const { left, right } = arrowRects();
    canvas.style.cursor = pointInRect(x, y, left) || pointInRect(x, y, right) ? 'pointer' : 'default';
  });

  document.getElementById('prevBtn').addEventListener('click', () => step(-1));
  document.getElementById('nextBtn').addEventListener('click', () => step(1));

  // Continuous loop now — the spin is ambient, not tied to any user action.
  const startedAt = performance.now();
  function loop(now) {
    draw((now - startedAt) / 1000);
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  window.__alienPickerState = () => ({ ...state, playerName: players[state.index].name, arrows: arrowRects() });
}

main().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML(
    'beforeend',
    `<pre style="color:#f88;position:absolute;top:10px;left:10px;z-index:999">${err.message}</pre>`
  );
});
