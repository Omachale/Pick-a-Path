/**
 * The lobby's backdrop: a sheet of cardboard in a light oak frame, built as
 * real 3D geometry rather than a single painted image.
 *
 * Luke, 2026-10-04: he'd planned to use `Desktop/Lobby Cardboard.png` (a flat
 * photo of fibreboard in a thin oak frame), then asked for it to be modelled
 * instead — "similar shape and aesthetic, but with a better-looking
 * background and wooden frame, and also better able to be resized." The
 * resizing is the real reason this is geometry: a photo stretched to a
 * different aspect distorts both the frame width and the cardboard grain.
 * Here, the frame is rebuilt at the viewport's own size on every resize (its
 * width stays a fixed fraction of the screen's short side), and both
 * textures are mapped in WORLD units (1 unit = 1 CSS px at the board's
 * surface), so the grain is the same size on any screen; only how much of it
 * shows changes.
 *
 * LIT, ON PURPOSE. The game scenes render unlit with shading painted into
 * the art (see CLAUDE.md), but this board's whole look IS its relief: the
 * frame's rounded edges catching light, its shadow falling onto the
 * cardboard, the cut edges of the dial holes. Painting those in would bring
 * back exactly the fixed-aspect problem above. It's a separate scene with
 * its own renderer, so nothing in the games is affected.
 *
 * THE DIALS: 3D versions of the cardboard-UI dial in `src/dialProto.js`
 * (read that file's header for the original design). The original is three
 * flat images: a housing printed with a black window above a black round
 * hole, and a corrugated-cardboard disc seated in the hole. The pale wavy
 * edge around dial.png's face is the corrugated flute showing where the top
 * liner stops short of the edge. Here, the window and hole are real cut-outs.
 * The proportions come from measuring dial-housing2-holes.png (window 132x59
 * px, hole 158 px, 7 px gap between them), expressed as fractions of the
 * hole's diameter so a housing can be any size.
 *
 * HANDMADE, NOT MACHINED. Luke, 2026-10-04, on a first pass with a clean
 * metal rim: "too clean and neat: the aesthetic is meant to be handmade from
 * cardboard... rough and imperfect." So every cut here is irregular on
 * purpose, and seeded so it doesn't change on resize. The round hole and the
 * dial are polygons of short scissor strokes (slightly faceted, not true
 * circles). The window edges are strokes of slightly different angle, with a
 * small nick where each new cut starts, plus an occasional over-cut slit
 * past a corner. Each cut wall also slopes inward as it goes down. A real
 * scissor cut is near-vertical, but the camera looks almost straight down,
 * so a vertical wall would be invisible; the slope is what lets "the depth
 * (very shallow) of the cardboard" show. The dial is the same idea the other
 * way up: its top is narrower than its base (Luke: "so we can see the depth
 * of the sides"), and that sloped side carries the corrugated-flute texture.
 *
 * The windows are EMPTY: you see the dark cavity behind the board. Luke:
 * "the windows will show images that are set behind them and turned with the
 * dial". Those images go in the cavity layer, behind the board, later.
 *
 * COLUMNS. Luke, 2026-10-04, after comparing: the original flat dial and
 * window art "are indeed better", but the housing PNG's baked-in shadow and
 * its faint surrounding rectangle suited the old cardboard, not this board.
 * So the original housing now keeps only two things from that art: the
 * window, as a clean flat black rectangle with no shadow, and dial.png
 * itself, cropped to its disc. Each dial, original or 3D, is the top face
 * of a column standing off the board toward the camera, and the real light
 * casts its shadow. The column sits directly under the top face, so from
 * the near-top-down camera it's essentially hidden. Luke: "if you look down
 * from the top of a perfect cylinder, you will see only a circle, with the
 * only signs being the edges and any shadow from an angled source." Where a
 * sliver of it does show, it's cardboard. The 3D dials keep their holes and
 * rise out of them. Luke then chose the 3D dials over the original, at the
 * highest lift tried (50 of 10/25/50); the `style: 'original'` path is kept
 * only as a reference until the lobby screens settle.
 *
 * THE MODE WHEEL. The pictures behind a window are cards on a real wheel
 * behind the board, turning in step with the dial (one dial step = one
 * slot). A picture arrives tilted and levels out as it centres, which is
 * the "angularity" Luke asked for. First attempt had one picture on a wheel
 * centred on the dial's own axis; turned partway, its corner stuck up into
 * an otherwise empty window. Luke: "We need gaps between the images...
 * imagine that there are five images on a wheel, each sized so they will
 * fill the full window, and with a small gap between each." Five
 * window-sized cards only fit round a wheel if its axis is far enough below
 * them that each card's inner edge is a 72° chord. Bare rectangles left a
 * dark V between neighbours that widened outward, so each slot is a card
 * segment filling its whole slice, bounded by lines parallel to the slot
 * edges, which gives a constant thin gap, with the picture glued on. So the wheel's axis sits
 * well below the dial, hidden behind the board, as if geared to it. It isn't
 * the dial's axis, and doesn't need to be: you never see the axis, only
 * pictures sweeping past the window, with the next one following a few
 * degrees behind. The wheel is its own group, synced to the dial's rotation,
 * so clicks over the hidden wheel don't count as clicking the dial.
 *
 * LANDSCAPE ALWAYS. The board is a fixed 16:9 sheet fitted inside the
 * viewport (letterboxed on a portrait screen) rather than stretched to the
 * viewport's own shape. Luke: "It should be landscape, not portrait."
 *
 * Turning: one slot per click, clicks stack, ends bump; see turn(). Clicking a dial's
 * right half turns it clockwise, its left half anticlockwise. That's only a test trigger, the
 * same as dialProto's Turn buttons.
 *
 * Three dials, each with a different window size (Luke: "one the same size
 * as the original, one moderately larger, one much larger"). That's a
 * layout experiment, not a final screen.
 */
import * as THREE from 'three';
import { buildQrCard, QR_CARD } from './qrCard.js';
import { buildNameTagCanvas, normalizePlayerName } from '../skypath/nameTag.js';
import { createRoster, addPlayer as rosterAdd, applySettings, randomise, movePlayer, removePlayer, boxCap, isOverfull, UNASSIGNED_CAP } from './lobbyRoster.js';
import { PLAYER_CAP, DEFAULT_PLAYER_COLOUR } from './sessionConfig.js';
import { PALETTE } from '../skypath/characters.js';

// ---------------------------------------------------------------- tuning

// Everything in "design px": sizes are authored for a 1600x900 screen, then
// multiplied by `s` (see build()) so the board's contents scale with the
// screen while the textures keep their real-world grain size.
export const LOBBY_BOARD_DEFAULTS = {
  frameWidth: 34, // the oak frame's face width
  frameDepth: 22, // how far the frame stands proud of the cardboard
  frameBevel: 4, // rounded-over edge radius
  boardThickness: 6, // the cardboard sheet itself (shows on cut edges)
  cavityDepth: 18, // gap behind the board, visible around the dial
  cutTaper: 0.8, // how far a cut wall slopes inward, as a fraction of the board's thickness
  dialHeight: 9, // the 3D dial piece's own thickness (its corrugated side), at the top of its column
  dialLift: 50, // how far every dial's face stands off the board (Luke picked the highest of 10/25/50, 2026-10-04)
  dialTaper: 0.09, // the dial's top radius is this much smaller than its base
  flutePitch: 18, // corrugation spacing on the dial's side, from dial.png (~30 flutes round it)
  // `place` is the WINDOW's centre, in design px from the inside top-left
  // corner of the frame. Everything else in a housing hangs off that: the
  // dial sits `gap` below the window, the label sits above it.
  dials: [
    // The game-mode dial. Luke, 2026-10-04: "a dial on the left, to allow
    // the teacher to choose a game mode... a large window above the dial,
    // and when the player turns the dial, the image will turn into view."
    // Then: "much larger, so that it fills most of one quarter of the
    // panel", and later 15% larger again (520x293 -> 598x337, dial
    // unchanged) and moved so the window sits equidistant (40 px) from the
    // top and left of the frame.
    {
      place: { x: 40 + 598 / 2, y: 40 + 337 / 2 },
      hole: 104,
      window: { w: 598, h: 337 },
      gap: 8,
      // "Imagine that there are five images on a wheel, each sized so they
      // will fill the full window." The wheel is still spaced for five, so
      // the pictures keep their approved size and spacing; the three blank
      // slots just aren't built, and turning stops at the first and last
      // picture so no empty slot comes round.
      wheelSlots: 5,
      slots: [
        // Slot 0 shows at rest, so it's the default. Luke: Sky Temple is
        // "the default/starting option".
        { src: 'textures/mode-skytemple.jpg', mode: 'skypath' },
        { src: 'textures/mode-volcano.jpg', mode: 'cavern' },
      ],
      // Spacing only: sets how far out the pictures sit. Segments are drawn
      // edge to edge with no visible gap; Luke asked for the gap line to go.
      slotGap: 6,
    },
    // Lower-left, under the mode window. Luke: "The left should be labelled
    // Teams and range from 1 to 4, and the right should be labelled Players
    // per Team and range from 2 to 6." Same dial; a small window showing a
    // number on the same kind of wheel, 45° a slot (dialProto's own step).
    {
      label: ['Teams'],
      setting: 'teams',
      // Luke, 2026-10-05: moved left to "the same margin between the Teams
      // Window and the left border as the top display window has" (40), with
      // Players per Team beside it at that same margin, to make room for the
      // QR button to their right.
      place: { x: 40 + 150 / 2, y: 622 },
      hole: 104,
      window: { w: 150, h: 110 },
      gap: 8,
      wheelSlots: 8,
      slots: [1, 2, 3, 4].map((n) => ({ text: String(n), value: n })),
      slotGap: 6,
    },
    {
      label: ['Players', 'per Team'],
      setting: 'players',
      place: { x: 40 + 150 + 40 + 150 / 2, y: 622 },
      hole: 104,
      window: { w: 150, h: 110 },
      gap: 8,
      wheelSlots: 8,
      slots: [2, 3, 4, 5, 6].map((n) => ({ text: String(n), value: n })),
      slotGap: 6,
    },
  ],
  labelCapHeight: 26, // design px: height of a capital in a dial's label
  // Push buttons: a square cardboard block standing `dialLift` off the board
  // in a hand-cut square hole (Luke: "50px high (same height as the
  // dials)"), which sinks to just below the board's surface while pressed
  // ("so that it looks like it is slightly below the surface of the backing
  // cardboard"). `place` is the button's centre, as for dials. What a press
  // DOES is the next step; for now it only moves.
  buttons: [
    // The QR button, right of the number dials at the same 40 px margin.
    // Nudged right by half its own width (Luke, 2026-10-05).
    // Luke, 2026-10-05: moved to sit level with the two number dials (centre
    // y 737, the dials' own), just right of them, and 25% smaller (110 -> 82.5),
    // to free the board's middle for wider team boxes.
    { id: 'qr', place: { x: 380 + 40 + 82.5 / 2, y: 737 }, size: 82.5, label: ['Join'] },
    // Randomise the teams (Luke, 2026-10-05). Unassigned players are dealt in too.
    { id: 'shuffle', place: { x: 380 + 40 + 82.5 + 40 + 82.5 / 2, y: 737 }, size: 82.5, label: ['Shuffle'] },
    // Create a game (a fresh join code), and Start the round (Luke,
    // 2026-10-05). A row above Join/Shuffle, same sizes and spacing. Pressing
    // Start again starts the next round with the next guide: the stand-in
    // for proper rounds, which aren't built yet.
    // (y 590 rather than level with the number windows: lower, the Join and
    // Shuffle labels sat right under these buttons and read as theirs.)
    { id: 'create', place: { x: 380 + 40 + 82.5 / 2, y: 590 }, size: 82.5, label: ['Create'] },
    { id: 'start', place: { x: 380 + 40 + 82.5 + 40 + 82.5 / 2, y: 590 }, size: 82.5, label: ['Start'] },
  ],
  buttonPressedDepth: 2, // design px below the board's face, while held
  // The player lobby: the right half of the board. Team boxes stacked
  // top to bottom and shrinking as teams are added (Luke: "one on top of
  // another, simply shrinking vertically"), then Unassigned at the bottom,
  // the same size as a team box. Each box has room for players + 2 name tags.
  // Sizes always assume the dials' current maximum, so nothing reflows as
  // players arrive.
  roster: {
    // Left edge: 40 px clear of the mode window (which ends at x 638). The
    // buttons below it end at x 625, so every box, Unassigned included, can
    // come this far left.
    area: { x0: 678, y0: 40, x1: 1492, y1: 792 }, // design px from the frame's inside top-left
    boxGap: 10,
    titleCap: 15, // capital height of the "Team One" titles: "very minimal... small lettering"
    settleSeconds: 1.5, // dial changes take effect this long after the last one stops
    // Each box is a shallow tray pressed into the board (Luke, 2026-10-05:
    // "slight indents cut/pushed into the cardboard"). Real geometry, so the
    // board's own light throws a real shadow along each tray's upper-left
    // inside edge. Pressed rather than cut: rounded corners and gently
    // sloping walls, unlike the hand-cut windows.
    tray: { depth: 5, slope: 3, corner: 8 }, // design px; the board is 6 thick
    // Name tags float this far above the tray floor, casting a shadow onto it
    // (Luke, 2026-10-05: "raise the name tags in the tray? Maybe 10-20px").
    tagRaise: 25, // was 15: "I can't actually see it, really"
    tagLift: 25, // extra height while being dragged
  },
  // The QR card (see qrCard.js), brought in by the QR button. Luke,
  // 2026-10-05: "the code to move in front of the top left quadrant of the
  // UI, blocking the large image and the dial below it, as well as portions
  // of the border. It will appear from the left, as if that hand is moving
  // it into place... 1.3s. Pressing it again will take it away, in 0.7s.
  // We might have to fiddle with the exact placement." The card keeps the
  // backing image's own proportions; only its overall scale is set here.
  qrCard: {
    centre: { x: 342, y: 265 }, // the CARD's centre (not the image's), design px from the frame's inside top-left
    cardSize: 620, // design px across the card itself (515 px in the backing image)
    height: 90, // design px off the board: above the dials, so it shadows them too
    inSeconds: 1.3,
    outSeconds: 0.7,
    // Expanding it, for a room with no second screen to put the code on.
    // Luke, 2026-10-06: hovering the card (bar a thin margin) shows it has
    // noticed the cursor; clicking then brings it "down and to the right, at
    // the same time that it expands... as if it is approaching the camera...
    // until it covers almost the entire height of the screen." Then, bigger
    // still: "the edges of the cardboard (but not the QR code) can be
    // slightly out of frame", so it's the CODE that's sized to the screen and
    // centred, and the card runs off past it. Any click shrinks it back. It
    // really does come toward the camera (no scaling), so the perspective
    // does the growing, and more of the hand shows on its own.
    hoverMargin: 18, // backing-image px of card edge that doesn't count as the card
    zoomCodeCover: 0.9, // the code's share of the screen's height when expanded
    // The hover sign. Luke: "a border around the code consisting of lines
    // moving ever outward, disappearing and being replaced, like waves...
    // fairly narrow, maybe just 20px". (A warm light over the card came
    // first; he'd meant a sign of recognition, not lighting.)
    // Then: "a bit thicker and significantly slower, and more rounded,
    // especially at the corners... expand the width of the effect to 30px".
    waves: { band: 30, gap: 4, line: 3.5, corner: 22, count: 3, seconds: 2.8, opacity: 0.75 }, // design px
    zoomInSeconds: 0.8,
    zoomOutSeconds: 0.6,
  },
};

const FOV = 20; // narrow: near-orthographic, but the far walls of each cut-out still show a little
const CARDBOARD_TILE = 700; // world units per repeat of the cardboard texture
const WOOD_TILE = 1024; // world units per repeat of the wood texture along a bar
const FLUTES_PER_TILE = 16; // makeCorrugatedEdgeCanvas() draws this many


// The original dial art (see dialProto.js for how it was measured). With
// `style: 'original'`, a housing gets dial.png cropped to its disc, as the
// top of a column, plus a flat black window. Nothing is cut into the board.
const ORIGINAL = {
  dialSrc: 'textures/dial.png',
  dialSize: { w: 183, h: 184 },
  dialDiameter: 172,
};
// Turn step is per dial now (`step`, degrees). dialProto settled on 45°, but
// on the mode dial a 45° step would park the window halfway between two
// pictures: at this window width each picture spans ~70° of the wheel.
// dialProto settled on 0.25s; Luke slowed the lobby dials to 1s a turn
// (2026-10-04) so the picture sweeping past can be followed, then asked for
// "50% faster" (2026-10-05): 1s / 1.5. See turn().
const TURN_DURATION = 1 / 1.5;
const BUMP_DURATION = 0.3; // the out-and-back at either end of a dial's range

// ---------------------------------------------------------------- procedural textures

function mulberry32(seed) {
  return function rand() {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Value noise on a lattice that wraps at (px, py), so whatever is built from it
// tiles seamlessly. The textures repeat across the board, and a visible seam
// every 700 px would give the whole thing away.
function periodicNoise(rand, px, py) {
  const g = new Float32Array(px * py);
  for (let i = 0; i < g.length; i++) g[i] = rand();
  return (u, v) => {
    const x0 = Math.floor(u);
    const y0 = Math.floor(v);
    const fx = u - x0;
    const fy = v - y0;
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const xa = ((x0 % px) + px) % px;
    const xb = (xa + 1) % px;
    const ya = ((y0 % py) + py) % py;
    const yb = (ya + 1) % py;
    const a = g[ya * px + xa];
    const b = g[ya * px + xb];
    const c = g[yb * px + xa];
    const d = g[yb * px + xb];
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  };
}

function canvasTexture(canvas, { repeat = true } = {}) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  if (repeat) tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return tex;
}

// Draws `fn` at the 9 wrapped offsets so marks that cross an edge come back
// in on the opposite one. That keeps the stroke layers tiling as well.
function drawWrapped(size, fn) {
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) fn(dx * size, dy * size);
}

/**
 * Kraft fibreboard, after the reference photo: a warm mid-brown with soft
 * mottling and lots of short fibres, some darker and some paler than the base.
 */
function makeCardboardCanvas() {
  const S = 1024;
  const rand = mulberry32(1987);
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(S, S);
  const octaves = [
    [4, 0.16],
    [8, 0.14],
    [16, 0.13],
    [32, 0.12],
    [64, 0.11],
    [128, 0.1],
    [256, 0.09],
  ].map(([p, w]) => [periodicNoise(rand, p, p), p, w]);
  const base = [158, 131, 101];
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let f = 0;
      for (const [n, p, w] of octaves) f += (n((x / S) * p, (y / S) * p) - 0.5) * w;
      const k = 1 + f * 0.5;
      const i = (y * S + x) * 4;
      img.data[i] = base[0] * k;
      img.data[i + 1] = base[1] * k;
      img.data[i + 2] = base[2] * (k * 0.98);
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  ctx.lineCap = 'round';
  const fibre = (color, alpha, count, lenMin, lenMax, width) => {
    for (let i = 0; i < count; i++) {
      const x = rand() * S;
      const y = rand() * S;
      const a = rand() * Math.PI * 2;
      const len = lenMin + rand() * (lenMax - lenMin);
      const bend = (rand() - 0.5) * len * 0.8;
      const ex = x + Math.cos(a) * len;
      const ey = y + Math.sin(a) * len;
      const mx = (x + ex) / 2 - Math.sin(a) * bend;
      const my = (y + ey) / 2 + Math.cos(a) * bend;
      ctx.strokeStyle = color;
      ctx.globalAlpha = alpha * (0.4 + rand() * 0.6);
      ctx.lineWidth = width * (0.6 + rand() * 0.8);
      drawWrapped(S, (ox, oy) => {
        ctx.beginPath();
        ctx.moveTo(x + ox, y + oy);
        ctx.quadraticCurveTo(mx + ox, my + oy, ex + ox, ey + oy);
        ctx.stroke();
      });
    }
  };
  fibre('#55402a', 0.34, 9000, 3, 13, 0.8);
  fibre('#d9c4a2', 0.32, 7500, 3, 11, 0.8);
  fibre('#2f2012', 0.4, 700, 1, 4, 1.4); // dark specks
  fibre('#efe0c4', 0.35, 500, 1, 3, 1.2); // pale specks
  ctx.globalAlpha = 1;
  return c;
}

/**
 * Light oak, grain running along x so a bar built along x gets grain along
 * its length. The line count across the height is a whole number, and the
 * warp noise is periodic, so this tiles in both directions.
 */
function makeWoodCanvas() {
  const W = 1024;
  const H = 256;
  const rand = mulberry32(4242);
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(W, H);
  const warpA = periodicNoise(rand, 3, 4);
  const warpB = periodicNoise(rand, 9, 12);
  const jitter = periodicNoise(rand, 24, 64);
  const streak = periodicNoise(rand, 48, 128);
  const tone = periodicNoise(rand, 6, 4);
  const LINES = 30;
  const light = [226, 199, 158];
  const dark = [176, 136, 90];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const u = x / W;
      const v = y / H;
      const warp = (warpA(u * 3, v * 4) - 0.5) * 0.9 + (warpB(u * 9, v * 12) - 0.5) * 0.25;
      const g = (v + warp * 0.08) * LINES + (jitter(u * 24, v * 64) - 0.5) * 0.5;
      const t = g - Math.floor(g);
      // Late-wood: a narrow darker band, sharp on one side and fading on the
      // other, as real growth rings do.
      const late = t > 0.72 ? Math.pow((t - 0.72) / 0.28, 1.6) : t < 0.06 ? 1 - t / 0.06 : 0;
      const st = streak(u * 48, v * 128);
      const m = Math.min(1, late * 0.7 + (st - 0.5) * 0.5 + 0.12);
      const k = 1 + (tone(u * 6, v * 4) - 0.5) * 0.12;
      const i = (y * W + x) * 4;
      for (let ch = 0; ch < 3; ch++) img.data[i + ch] = (light[ch] + (dark[ch] - light[ch]) * Math.max(0, m)) * k;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  // Oak's ray flecks: short pale dashes running with the grain.
  for (let i = 0; i < 260; i++) {
    const x = rand() * W;
    const y = rand() * H;
    const len = 6 + rand() * 22;
    ctx.globalAlpha = 0.18 + rand() * 0.2;
    ctx.fillStyle = '#f1ddba';
    for (const ox of [-W, 0, W]) {
      ctx.beginPath();
      ctx.ellipse(x + ox, y, len / 2, 0.7 + rand() * 0.6, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
  return c;
}

/**
 * A scissor-cut edge through fibreboard, seen side-on. v runs across the
 * board's thickness, with the top of the canvas at the board's face. Fibrous
 * streaks run along the cut, faint blade-drag marks cross it, and the top lip
 * is paler where the blade crushed and frayed the surface.
 */
function makeCutEdgeCanvas() {
  const W = 256;
  const H = 32;
  const rand = mulberry32(555);
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d');
  ctx.fillStyle = 'rgb(172,143,107)';
  ctx.fillRect(0, 0, W, H);
  for (let i = 0; i < 700; i++) {
    const x = rand() * W;
    const y = rand() * H;
    const len = 3 + rand() * 12;
    ctx.globalAlpha = 0.15 + rand() * 0.3;
    ctx.fillStyle = rand() < 0.55 ? '#5c4329' : '#dcc6a2';
    for (const ox of [-W, 0, W]) ctx.fillRect(x + ox, y, len, 0.6 + rand() * 0.6);
  }
  ctx.globalAlpha = 1;
  for (let i = 0; i < 50; i++) {
    ctx.fillStyle = `rgba(80,58,36,${0.08 + rand() * 0.14})`;
    ctx.fillRect(rand() * W, 0, 0.7, H);
  }
  const lip = ctx.createLinearGradient(0, 0, 0, H * 0.35);
  lip.addColorStop(0, 'rgba(228,208,174,0.6)');
  lip.addColorStop(1, 'rgba(228,208,174,0)');
  ctx.fillStyle = lip;
  ctx.fillRect(0, 0, W, H * 0.35);
  return c;
}

/**
 * The side of a corrugated-cardboard disc: a liner along the top and bottom,
 * and between them the flute, a strip of paper folded into arches. Each arch
 * is pale where it catches light and shades off into the hollow beside it.
 * The hollows are dim rather than black, since light gets in from the cut
 * side. Arches vary in width and height, and a few are crushed nearly flat,
 * as scissors do to corrugated card. The canvas holds a whole number of
 * flutes, so it tiles around the dial.
 */
function makeCorrugatedEdgeCanvas() {
  const W = 512;
  const H = 64;
  const P = W / FLUTES_PER_TILE;
  const rand = mulberry32(808);
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d');
  const linerTop = H * 0.2;
  const linerBottom = H * 0.82;
  ctx.fillStyle = 'rgb(112,86,60)';
  ctx.fillRect(0, 0, W, H);
  for (let k = 0; k < FLUTES_PER_TILE; k++) {
    const crushed = rand() < 0.2;
    const x0 = k * P + (rand() - 0.5) * P * 0.15;
    const w = P * (0.9 + rand() * 0.2);
    const peak = linerTop + (crushed ? 0.55 + rand() * 0.2 : 0.05 + rand() * 0.2) * (linerBottom - linerTop);
    for (const ox of [-W, 0, W]) {
      const L = x0 + ox;
      const g = ctx.createLinearGradient(L, 0, L + w, 0);
      g.addColorStop(0, 'rgba(112,86,60,0)');
      g.addColorStop(0.3, 'rgb(196,176,148)');
      g.addColorStop(0.45, 'rgb(226,212,190)');
      g.addColorStop(0.75, 'rgb(150,124,94)');
      g.addColorStop(1, 'rgba(112,86,60,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(L, linerBottom);
      ctx.bezierCurveTo(L + w * 0.1, peak, L + w * 0.9, peak, L + w, linerBottom);
      ctx.closePath();
      ctx.fill();
    }
  }
  // liners, top and bottom, with ragged inner edges
  for (const [y0, y1] of [
    [0, linerTop],
    [linerBottom, H],
  ]) {
    ctx.fillStyle = 'rgb(166,134,98)';
    ctx.fillRect(0, y0, W, y1 - y0);
    for (let x = 0; x < W; x += 2) {
      ctx.fillStyle = `rgba(166,134,98,${0.4 + rand() * 0.6})`;
      const r = rand() * 2.5;
      if (y0 === 0) ctx.fillRect(x, y1, 2, r);
      else ctx.fillRect(x, y0 - r, 2, r);
    }
  }
  // fibre grain over everything
  for (let i = 0; i < 900; i++) {
    ctx.globalAlpha = 0.08 + rand() * 0.16;
    ctx.fillStyle = rand() < 0.5 ? '#3d2b1a' : '#e6d6bc';
    const x = rand() * W;
    const y = rand() * H;
    const len = 2 + rand() * 6;
    for (const ox of [-W, 0, W]) ctx.fillRect(x + ox, y, len, 0.7);
  }
  ctx.globalAlpha = 1;
  return c;
}

// A soft dark-to-clear ramp, used as a contact-shadow strip along the
// frame's inner edge. The directional light's shadow only falls on the side
// facing away from the light; real frames also darken the cardboard right up
// against them on every side.
function makeRampCanvas() {
  const c = document.createElement('canvas');
  c.width = 4;
  c.height = 128;
  const ctx = c.getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, 0, 128);
  grad.addColorStop(0, 'rgba(30,18,8,0.42)');
  grad.addColorStop(0.35, 'rgba(30,18,8,0.14)');
  grad.addColorStop(1, 'rgba(30,18,8,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 4, 128);
  return c;
}

// The QR backing image's own geometry (811x586; the card spans x 274-789,
// y 65-567): enough to scale the image by the CARD's size and place it by
// the card's centre rather than the image's.
const QR_BACKING = { w: 811, h: 586, card: { w: 515, h: 502, x0: 274, y0: 65, cx: 531.5, cy: 316 } };

// ---------------------------------------------------------------- dial labels

// The game's cardboard letter art (see skypath/nameTag.js), stamped onto a
// transparent canvas: the letters with a soft cream halo, no card
// background, since they sit straight on the board's own cardboard. The
// halo is the one board-label readability treatment Luke picked (option D
// of six compared in label-options.png, 2026-10-05): cardboard letters on
// cardboard read poorly at label size, and a light glow, the same idea as
// the name tags', lifts them without changing the letters. Sizes
// follow nameTag.js's agreed constants (capitals 150 px, lowercase 70%,
// descenders dropped 6 px); its per-letter size corrections aren't
// exported, so they're not applied here.
const LABEL = {
  upper: 150,
  lower: 105,
  desc: 6,
  spacing: 10,
  wordGap: 34,
  lineGap: 30,
  pad: 46, // room round the letters for the halo
  halo: { color: '#fff3d6', blur: 30, passes: 3 }, // canvas px, at the 150 px capital size
};
const labelGlyphs = new Map();
function labelGlyph(ch) {
  const src = /[A-Z]/.test(ch) ? `textures/letters/upper-v2/${ch}.png` : `textures/letters/lower/${ch}.png`;
  if (!labelGlyphs.has(src)) {
    labelGlyphs.set(
      src,
      new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = src;
      }),
    );
  }
  return labelGlyphs.get(src);
}
const labelCanvases = new Map();
function labelCanvas(lines) {
  const key = lines.join('\n');
  if (!labelCanvases.has(key)) {
    labelCanvases.set(
      key,
      (async () => {
        const laidLines = await Promise.all(
          lines.map(async (line) => {
            const items = await Promise.all(
              [...line].map(async (ch) => {
                if (ch === ' ') return { space: true, w: LABEL.wordGap };
                const img = await labelGlyph(ch);
                const h = /[A-Z]/.test(ch) ? LABEL.upper : LABEL.lower;
                return { img, ch, h, w: img.width * (h / img.height) };
              }),
            );
            const width = items.reduce((sum, it) => sum + it.w + (it.space ? 0 : LABEL.spacing), 0) - LABEL.spacing;
            return { items, width };
          }),
        );
        const lineH = LABEL.upper + LABEL.desc + 20;
        const c = document.createElement('canvas');
        c.width = Math.ceil(Math.max(...laidLines.map((l) => l.width)) + 2 * LABEL.pad);
        c.height = Math.ceil(laidLines.length * lineH + (laidLines.length - 1) * LABEL.lineGap + 2 * LABEL.pad);
        const ctx = c.getContext('2d');
        laidLines.forEach((l, li) => {
          let x = (c.width - l.width) / 2;
          const baseline = LABEL.pad + li * (lineH + LABEL.lineGap) + LABEL.upper;
          for (const it of l.items) {
            if (it.space) {
              x += it.w;
              continue;
            }
            let y = baseline - it.h;
            if ('gjpqy'.includes(it.ch)) y += LABEL.desc;
            // Drawing with a shadow set draws the letter itself on top of its
            // own glow; repeating re-saturates the blurred edge (as nameTag.js
            // does for the name tags' glow).
            ctx.save();
            ctx.shadowColor = LABEL.halo.color;
            ctx.shadowBlur = LABEL.halo.blur;
            for (let pass = 0; pass < LABEL.halo.passes; pass++) ctx.drawImage(it.img, x, y, it.w, it.h);
            ctx.restore();
            x += it.w + LABEL.spacing;
          }
        });
        return { canvas: c, capPx: LABEL.upper };
      })(),
    );
  }
  return labelCanvases.get(key);
}

// ---------------------------------------------------------------- geometry helpers

// A rectangle with rounded corners, anticlockwise, as points.
function roundedRectPoints(x0, y0, x1, y1, r, seg = 6) {
  const pts = [];
  const corners = [
    [x1 - r, y0 + r, -Math.PI / 2],
    [x1 - r, y1 - r, 0],
    [x0 + r, y1 - r, Math.PI / 2],
    [x0 + r, y0 + r, Math.PI],
  ];
  for (const [cx, cy, a0] of corners) {
    for (let i = 0; i <= seg; i++) {
      const a = a0 + (i / seg) * (Math.PI / 2);
      pts.push(new THREE.Vector2(cx + Math.cos(a) * r, cy + Math.sin(a) * r));
    }
  }
  return pts;
}

/**
 * One mitred frame bar, built lying along x with its outer edge at +y and
 * centred on the origin. The caller rotates it into place. The shape is inset
 * by the bevel size because ExtrudeGeometry's bevel grows the shape outward;
 * without the inset, neighbouring bars would overlap at the mitre instead of
 * meeting in a fine rounded groove.
 */
function frameBarGeometry(length, width, depth, bevel) {
  const b = bevel;
  const r2 = Math.SQRT2;
  const yo = width / 2 - b;
  const yi = -width / 2 + b;
  const xo = length / 2 - b * (1 + r2);
  const xi = length / 2 - width + b - b * r2;
  const shape = new THREE.Shape();
  shape.moveTo(-xo, yo);
  shape.lineTo(xo, yo);
  shape.lineTo(xi, yi);
  shape.lineTo(-xi, yi);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: Math.max(0.1, depth - 2 * b),
    bevelEnabled: true,
    bevelThickness: b,
    bevelSize: b,
    bevelSegments: 5,
  });
  geo.translate(0, 0, b); // back face sits on z=0
  return geo;
}

/**
 * One edge of a scissor cut, as perpendicular offsets from the ideal straight
 * line at distances 0..L. Scissors cut in strokes: each stroke runs at its own
 * slight angle (drifting back toward the line so the edge never wanders far),
 * and where the next stroke starts there's a small nick.
 */
function scissorOffsets(L, s, rand) {
  const out = [];
  let d = 0;
  let o = (rand() - 0.5) * 1.0 * s;
  while (d < L - 0.01) {
    const stroke = Math.min(L - d, (24 + rand() * 40) * s);
    const slope = (rand() - 0.5) * 0.03 - (o / stroke) * 0.5;
    // A slight bow within each stroke, as the blades flex.
    const bow = (rand() - 0.5) * 0.9 * s;
    const n = Math.max(1, Math.ceil(stroke / (4 * s)));
    for (let i = 0; i < n; i++) {
      const t = (i / n) * stroke;
      out.push([d + t, o + slope * t + bow * Math.sin((Math.PI * t) / stroke) + (rand() - 0.5) * 0.25 * s]);
    }
    o += slope * stroke + (rand() - 0.5) * 0.9 * s;
    d += stroke;
  }
  return out;
}

/**
 * A hand-cut rectangular window: four scissor-cut edges, a slight overall
 * skew, and an over-cut slit or two where the blade ran past a corner.
 * Returns the outline (anticlockwise) plus the slits as small triangles.
 */
function handCutRect(cx, cy, w, h, s, rand) {
  const rot = (rand() - 0.5) * 0.025;
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  const place = (x, y) => new THREE.Vector2(cx + x * cos - y * sin, cy + x * sin + y * cos);
  const corners = [
    [-w / 2, -h / 2],
    [w / 2, -h / 2],
    [w / 2, h / 2],
    [-w / 2, h / 2],
  ];
  const points = [];
  for (let k = 0; k < 4; k++) {
    const [ax, ay] = corners[k];
    const [bx, by] = corners[(k + 1) % 4];
    const L = Math.hypot(bx - ax, by - ay);
    const dx = (bx - ax) / L;
    const dy = (by - ay) / L;
    for (const [d, o] of scissorOffsets(L, s, rand)) points.push(place(ax + dx * d - dy * o, ay + dy * d + dx * o));
  }
  const overcuts = [];
  for (let k = 0; k < 4; k++) {
    if (rand() > 0.45) continue;
    const [px, py] = corners[(k + 3) % 4];
    const [qx, qy] = corners[k];
    const L = Math.hypot(qx - px, qy - py);
    const dx = (qx - px) / L;
    const dy = (qy - py) / L;
    const len = (3 + rand() * 6) * s;
    const half = (0.4 + rand() * 0.3) * s;
    overcuts.push([
      place(qx - dy * half, qy + dx * half),
      place(qx + dy * half, qy - dx * half),
      place(qx + dx * len, qy + dy * len),
    ]);
  }
  return { points, overcuts };
}

/**
 * A hand-cut circle: a ring of short scissor strokes. The stroke ends sit on
 * the circle, give or take, and each stroke bows only part of the way out
 * toward the true arc, so it reads as faceted, the way a circle cut with
 * scissors does. Anticlockwise.
 */
function handCutCircle(cx, cy, r, s, rand) {
  const K = Math.max(12, Math.round((2 * Math.PI * r) / (24 * s)));
  const ends = [];
  for (let i = 0; i < K; i++) {
    ends.push({
      a: ((i + (rand() - 0.5) * 0.35) / K) * Math.PI * 2,
      r: r * (1 + (rand() - 0.5) * 0.028),
    });
  }
  const points = [];
  const SUB = 4;
  for (let i = 0; i < K; i++) {
    const p = ends[i];
    const q = ends[(i + 1) % K];
    const qa = i === K - 1 ? q.a + Math.PI * 2 : q.a;
    const P0 = new THREE.Vector2(Math.cos(p.a) * p.r, Math.sin(p.a) * p.r);
    const Q0 = new THREE.Vector2(Math.cos(qa) * q.r, Math.sin(qa) * q.r);
    for (let j = 0; j < SUB; j++) {
      const t = j / SUB;
      const chord = P0.clone().lerp(Q0, t);
      const a = p.a + (qa - p.a) * t;
      const rr = p.r + (q.r - p.r) * t;
      const arc = new THREE.Vector2(Math.cos(a) * rr, Math.sin(a) * rr);
      points.push(chord.lerp(arc, 0.55).add(new THREE.Vector2(cx, cy)));
    }
  }
  return points;
}

// Moves every point of an anticlockwise outline toward its inside by
// `amount`, varying a little along the edge (an uneven blade angle).
function insetOutline(points, amount, rand) {
  const n = points.length;
  const phase = rand() * 10;
  return points.map((p, i) => {
    const a = points[(i - 1 + n) % n];
    const b = points[(i + 1) % n];
    const e1 = p.clone().sub(a).normalize();
    const e2 = b.clone().sub(p).normalize();
    const n1 = new THREE.Vector2(-e1.y, e1.x);
    const m = n1.clone().add(new THREE.Vector2(-e2.y, e2.x)).normalize();
    const miter = 1 / Math.max(0.5, m.dot(n1));
    const vary = 0.75 + 0.5 * (0.5 + 0.5 * Math.sin(i * 0.37 + phase));
    return p.clone().addScaledVector(m, amount * miter * vary);
  });
}

/**
 * A band of quads joining outline A (at height zA) to outline B (at zB), both
 * with the same number of points: a cut wall, or the dial's side. Flat-shaded,
 * so each scissor stroke catches the light on its own. u runs along the edge
 * in world units / uTile; v is 1 at A and 0 at B, which puts the top of an
 * edge canvas at A. Use with a DoubleSide material, since which way round the
 * faces wind depends on whether it's a hole or a solid.
 */
function ringWallGeometry(A, zA, B, zB, uTile) {
  const n = A.length;
  const pos = [];
  const uv = [];
  let u = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const len = A[i].distanceTo(A[j]);
    const u0 = u / uTile;
    const u1 = (u + len) / uTile;
    u += len;
    const ai = [A[i].x, A[i].y, zA];
    const aj = [A[j].x, A[j].y, zA];
    const bi = [B[i].x, B[i].y, zB];
    const bj = [B[j].x, B[j].y, zB];
    pos.push(...ai, ...bi, ...aj, ...aj, ...bi, ...bj);
    uv.push(u0, 1, u0, 0, u1, 1, u1, 1, u0, 0, u1, 0);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.computeVertexNormals();
  return geo;
}

// ---------------------------------------------------------------- the board

/**
 * `hooks` are how the board reports what only the page around it can act on
 * (LobbyBoard.jsx holds the realtime connection): onCreate() / onStart() when
 * those buttons are pressed, onJoin() when Join shows or hides the QR card,
 * onJoinWithoutGame() when Join is pressed before a game exists, and onRosterChange(state) after any change to the teams,
 * for saving (see exportState).
 */
export function createLobbyBoard(container, initialParams = LOBBY_BOARD_DEFAULTS, hooks = {}) {
  let params = initialParams;
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.localClippingEnabled = true; // per-wheel window clipping, see build()
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.domElement.style.display = 'block';
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x2a1e14);
  const camera = new THREE.PerspectiveCamera(FOV, 1, 1, 20000);

  // Hemisphere light "up" is +z here (the board faces the camera along +z).
  // Shadow strength is the ratio of these two: in shadow only the hemisphere
  // light remains, about 60% of full brightness here. That's Luke's "medium
  // strength, not too dark".
  const hemi = new THREE.HemisphereLight(0xfffaf2, 0x6b5e50, 1.75);
  hemi.position.set(0, 0, 1);
  scene.add(hemi);
  // The one key light, from the display's top-left corner (Luke: "a light
  // source at the top left of the whole display"), placed in build() so it
  // tracks that corner at any aspect.
  const sun = new THREE.DirectionalLight(0xfff6ea, 1.7);
  sun.castShadow = true;
  // A modest map with a wide filter radius: soft-edged shadows, as under a
  // classroom's diffuse light, rather than crisp spotlight ones.
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.radius = 6;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.6;
  scene.add(sun, sun.target);

  const cardTex = canvasTexture(makeCardboardCanvas());
  cardTex.repeat.set(1 / CARDBOARD_TILE, 1 / CARDBOARD_TILE);
  const woodCanvas = makeWoodCanvas();
  const cutEdgeTex = canvasTexture(makeCutEdgeCanvas());
  cutEdgeTex.wrapT = THREE.ClampToEdgeWrapping;
  const fluteTex = canvasTexture(makeCorrugatedEdgeCanvas());
  fluteTex.wrapT = THREE.ClampToEdgeWrapping;
  const rampTex = canvasTexture(makeRampCanvas(), { repeat: false });
  // The dial face: the same card, a shade paler, so the disc reads as a
  // separate piece sitting in the hole (dial.png's face is lighter than the
  // housing around it) rather than a circle drawn on the board.
  const faceCanvas = document.createElement('canvas');
  faceCanvas.width = faceCanvas.height = cardTex.image.width;
  {
    const fctx = faceCanvas.getContext('2d');
    fctx.drawImage(cardTex.image, 0, 0);
    fctx.fillStyle = 'rgba(232, 208, 170, 0.22)';
    fctx.fillRect(0, 0, faceCanvas.width, faceCanvas.height);
  }

  const cardMat = new THREE.MeshStandardMaterial({
    map: cardTex,
    bumpMap: cardTex,
    bumpScale: 1.2,
    roughness: 0.95,
  });
  const cutEdgeMat = new THREE.MeshStandardMaterial({ color: 0x7d5e3e, roughness: 1 });
  const cavityMat = new THREE.MeshStandardMaterial({ color: 0x1b130c, roughness: 1 });
  const cutWallMat = new THREE.MeshStandardMaterial({ map: cutEdgeTex, roughness: 1, side: THREE.DoubleSide });
  const fluteMat = new THREE.MeshStandardMaterial({
    map: fluteTex,
    bumpMap: fluteTex,
    bumpScale: 1.5,
    roughness: 0.95,
    side: THREE.DoubleSide,
  });
  const overcutMat = new THREE.MeshBasicMaterial({ color: 0x1e140b, transparent: true, opacity: 0.8, depthWrite: false });
  // The original dial's face is unlit, like the rest of the game's painted
  // art: its shading is already in the image.
  const dialArt = new THREE.TextureLoader().load(ORIGINAL.dialSrc, (t) => {
    t.colorSpace = THREE.SRGBColorSpace;
    t.needsUpdate = true;
    requestRender();
  });
  // Crop to the disc: a CircleGeometry's UVs span its bounding square, so
  // map that square onto the disc's own square inside the 183x184 crop.
  {
    const { w, h } = ORIGINAL.dialSize;
    const d = ORIGINAL.dialDiameter;
    dialArt.repeat.set(d / w, d / h);
    dialArt.offset.set((w - d) / 2 / w, (h - d) / 2 / h);
  }
  const origDialMat = new THREE.MeshBasicMaterial({ map: dialArt, transparent: true });
  const origWindowMat = new THREE.MeshBasicMaterial({ color: 0x050403 });
  // The columns' sides: barely seen, but cardboard where they are.
  const columnTex = canvasTexture(cardTex.image);
  columnTex.repeat.set(0.8, 0.06);
  const columnMat = new THREE.MeshStandardMaterial({ map: columnTex, roughness: 0.95 });
  // Each frame bar gets its own wood texture, with an offset, so the four
  // sides don't show the identical grain.
  const woodMats = [0, 1, 2, 3].map((i) => {
    const t = canvasTexture(woodCanvas);
    t.repeat.set(1 / WOOD_TILE, 1 / 256);
    t.offset.set(i * 0.37, i * 0.29);
    return new THREE.MeshStandardMaterial({ map: t, bumpMap: t, bumpScale: 0.6, roughness: 0.62 });
  });
  const rampMat = new THREE.MeshBasicMaterial({ map: rampTex, transparent: true, depthWrite: false });

  // The dial face gets its own copy of the cardboard texture, because a
  // cylinder cap's UVs span 0..1 across its diameter rather than world units.
  // Its repeat is set per dial in build() so the grain matches the board's.
  const dials = []; // { group, wheel, step, faceMat, turning }
  const buttons = []; // { id, group, pressedZ, pressed }
  const wheelMats = []; // per-build wheel backs, disposed with the content
  // ---------------------------------------------------------------- the board sheet
  let sheetState = null;
  function sheetGeometry(holes, extraHoles) {
    const { W, H, boardT } = sheetState ?? pendingSheet;
    const shape = new THREE.Shape();
    shape.moveTo(-W / 2, -H / 2);
    shape.lineTo(W / 2, -H / 2);
    shape.lineTo(W / 2, H / 2);
    shape.lineTo(-W / 2, H / 2);
    shape.closePath();
    shape.holes = [...holes, ...extraHoles];
    const geo = new THREE.ExtrudeGeometry(shape, { depth: boardT, bevelEnabled: false });
    geo.translate(0, 0, -boardT); // top face at z=0
    return geo;
  }
  let pendingSheet = null; // the size being built, before sheetState exists

  // ---------------------------------------------------------------- the player lobby
  // See lobbyRoster.js for the rules. `settings` is what the boxes are
  // currently laid out for. It follows the dials only after they've been
  // still for `settleSeconds` (Luke: "a delay of perhaps 1.5s... reset every
  // time a dial is turned"), so a teacher clicking through values doesn't
  // see the names jump about at every click.
  let settings = { teams: 1, players: 2 }; // the dials' starting values
  const roster = createRoster(settings);
  let settleTimer = null;
  let nextPlayerId = 1;
  const rosterGroup = new THREE.Group(); // lives outside `content`, so tags survive a resize rebuild
  scene.add(rosterGroup);
  const boxesGroup = new THREE.Group();
  rosterGroup.add(boxesGroup);
  const tags = new Map(); // id -> { mesh, aspect (height / width) }
  const tagGeo = new THREE.PlaneGeometry(1, 1);
  let layout = null; // { boxes: [{ key, x0, y0, x1, y1 }], s }
  // A tray's floor is the same card, a shade darker where it was pressed;
  // its walls are plain card-brown, shaded by the light.
  const trayFloorMat = new THREE.MeshStandardMaterial({ map: cardTex, bumpMap: cardTex, bumpScale: 1.2, roughness: 0.95, color: 0xe6dac8 });
  const trayWallMat = new THREE.MeshStandardMaterial({ color: 0xa2805a, roughness: 1, side: THREE.DoubleSide });
  const overfullMat = new THREE.MeshBasicMaterial({ color: 0xc0392b, transparent: true, opacity: 0.22, depthWrite: false });
  const titleMats = new Map(); // text -> Promise<{ mat, aspect }>
  // The players' colour palette (shared with the game and the join screen).
  // A dev player gets one at random; real players bring the colour they
  // picked on the join screen.
  const PLAYER_COLOURS = PALETTE.map((p) => p.hex);
  const playerColours = new Map(); // id -> hex
  const NUMBER_WORDS = ['One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight'];
  // The cardboard letters have no digits, so titles are spelled: "Team One".
  const teamTitle = (i) => `Team ${NUMBER_WORDS[i] ?? i + 1}`;
  function titleMaterial(text) {
    if (!titleMats.has(text)) {
      titleMats.set(
        text,
        labelCanvas([text]).then(({ canvas, capPx }) => {
          const tex = new THREE.CanvasTexture(canvas);
          tex.colorSpace = THREE.SRGBColorSpace;
          const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false });
          return { mat, aspect: canvas.height / canvas.width, capFrac: capPx / canvas.height };
        }),
      );
    }
    return titleMats.get(text);
  }

  function tagFor(id) {
    if (!tags.has(id)) {
      // shadowSide: by default three.js casts a single-sided plane's shadow
      // from its BACK face, which faces away from the light, so a raised tag
      // cast no shadow at all until this was set.
      const mat = new THREE.MeshBasicMaterial({ transparent: true, shadowSide: THREE.DoubleSide });
      mat.visible = false;
      const mesh = new THREE.Mesh(tagGeo, mat);
      mesh.userData.playerId = id;
      rosterGroup.add(mesh);
      const t = { mesh, aspect: 0.3 };
      tags.set(id, t);
      // The game's own name tag: cardboard letters on a card tag, the letters
      // glowing in the PLAYER'S colour, exactly as the game draws them
      // (skyPath.js attachNameTag passes the player's colorHex as glowColor).
      // Luke, 2026-10-05: "It's important that when this is connected to real
      // players, the colours used in their names in-game are also used here."
      // So a real arrival must pass its own colorHex to addPlayer (the dev
      // button's colour is random). The colour is always passed explicitly:
      // nameTag.js's own default (GLOW_COLOR_DEFAULT) is referenced but never
      // defined, which the game never trips over because it always passes one.
      const colourCss = `#${playerColours.get(id).toString(16).padStart(6, '0')}`;
      buildNameTagCanvas(roster.names.get(id), { glowColor: colourCss }).then(({ canvas: tagCanvas }) => {
        // Trimmed: the game's tag has 40 px of card round the letters (nameTag.js's
        // PAD_X/PAD_Y), sized for a tag floating over a character, so the
        // letters fill only ~60% of its height. In a crowded lobby box that
        // made names look small, so 22 px comes off each side here.
        const TRIM = 22;
        const canvas = document.createElement('canvas');
        canvas.width = tagCanvas.width - 2 * TRIM;
        canvas.height = tagCanvas.height - 2 * TRIM;
        // (A coloured border in the player's colour was tried, 2026-10-05, and
        // dropped: it hid the raised tags' shadows. The colour shows in the
        // letters' glow instead.)
        canvas.getContext('2d').drawImage(tagCanvas, -TRIM, -TRIM);
        const tex = new THREE.CanvasTexture(canvas);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = 8;
        mat.map = tex;
        mat.visible = true;
        mat.needsUpdate = true;
        t.aspect = canvas.height / canvas.width;
        renderRoster();
      });
    }
    return tags.get(id);
  }

  // The best grid for n tag slots in a w x h area: the column count that
  // gives the tallest tag while a TYPICAL name's tag still fits its cell.
  // History: sized first for a worst-case 10-letter name everywhere (tags
  // "a bit small"), then for the widest name present (one "Maximilian"
  // shrank every tag in the lobby). Luke chose (2026-10-05) to size for a
  // typical name and let only names too long for their cell shrink, which
  // they do in placement below. Sizes now never change as names come and go.
  // TYPICAL_TAG_RATIO is a 6-letter name's tag, measured: Hannah 3.47,
  // Sophia 3.19, Tomas 3.22, Mateo 3.00 (for scale: Kit 1.48, Maximilian 4.94).
  const TYPICAL_TAG_RATIO = 3.4;
  function slotGrid(n, w, h, ratio = TYPICAL_TAG_RATIO) {
    let best = null;
    for (let c = 1; c <= n; c++) {
      const rows = Math.ceil(n / c);
      const cw = w / c;
      const ch = h / rows;
      const tagH = Math.min(ch * 0.86, (cw * 0.92) / ratio);
      if (!best || tagH > best.tagH) best = { c, rows, cw, ch, tagH };
    }
    return best;
  }

  const TAG_SCALE = 1.15;
  let tagRestZ = 0.6; // on the tray floor; set by renderRoster
  const TAG_GLIDE = 0.35; // seconds

  // Names glide to a new place rather than jumping (Luke, 2026-10-05): after
  // a drop, when others shift up to close a gap, on a dial change, and on
  // Shuffle. Even 32 tags gliding at once is trivial work. `instant` is for
  // a resize rebuild, a tag's first appearance, and anything not visible yet.
  let gliding = false;
  function placeTag(t, x, y, sx, sy, instant) {
    const m = t.mesh;
    if (instant || !t.placed || !m.material.visible) {
      m.position.set(x, y, tagRestZ);
      m.scale.set(sx, sy, 1);
      m.castShadow = true;
      t.glide = null;
      t.placed = true;
      return;
    }
    const p = m.position;
    if (Math.abs(p.x - x) + Math.abs(p.y - y) + Math.abs(p.z - tagRestZ) + Math.abs(m.scale.x - sx) < 0.01) return;
    t.glide = {
      from: { x: p.x, y: p.y, z: p.z, sx: m.scale.x, sy: m.scale.y },
      to: { x, y, z: tagRestZ, sx, sy },
      start: performance.now(),
    };
    if (!gliding) {
      gliding = true;
      requestAnimationFrame(glideFrame);
    }
  }
  function glideFrame(now) {
    let any = false;
    for (const t of tags.values()) {
      const g = t.glide;
      if (!g || t === drag?.tag) continue;
      const k = Math.min(1, (now - g.start) / (TAG_GLIDE * 1000));
      const e = 1 - (1 - k) ** 3;
      const m = t.mesh;
      m.position.set(g.from.x + (g.to.x - g.from.x) * e, g.from.y + (g.to.y - g.from.y) * e, g.from.z + (g.to.z - g.from.z) * e);
      m.scale.set(g.from.sx + (g.to.sx - g.from.sx) * e, g.from.sy + (g.to.sy - g.from.sy) * e, 1);
      if (k < 1) any = true;
      else {
        t.glide = null;
        m.castShadow = true;
      }
    }
    renderer.render(scene, camera);
    if (any) requestAnimationFrame(glideFrame);
    else gliding = false;
  }

  function renderRoster(instant = false) {
    if (!size.w) return;
    const W = boardSize.w;
    const H = boardSize.h;
    const s = Math.min(W / 1600, H / 900);
    const F = params.frameWidth * s;
    const R = params.roster;
    const wx = (x) => -W / 2 + F + x * s;
    const wy = (y) => H / 2 - F - y * s;
    for (const c of [...boxesGroup.children]) {
      boxesGroup.remove(c);
      if (c.geometry !== tagGeo) c.geometry.dispose();
    }
    const n = settings.teams + 1;
    const boxH = (R.area.y1 - R.area.y0 - R.boxGap * (n - 1)) / n;
    const titleBand = Math.min(R.titleCap * 1.35, boxH * 0.2);
    const boxes = [];
    const T = R.tray;
    const floorZ = -T.depth * s;
    tagRestZ = floorZ + R.tagRaise * s;
    const trayHoles = [];
    for (let i = 0; i < n; i++) {
      const unassigned = i === settings.teams;
      const ids = unassigned ? roster.unassigned : roster.teams[i];
      const y0 = R.area.y0 + i * (boxH + R.boxGap);
      const box = { key: unassigned ? 'unassigned' : i, x0: R.area.x0, y0, x1: R.area.x1, y1: y0 + boxH };
      boxes.push(box);
      // The tray: an opening in the sheet, a sloping wall down to a floor.
      const rim = roundedRectPoints(wx(box.x0), wy(box.y1), wx(box.x1), wy(box.y0), T.corner * s);
      const floorEdge = roundedRectPoints(
        wx(box.x0) + T.slope * s,
        wy(box.y1) + T.slope * s,
        wx(box.x1) - T.slope * s,
        wy(box.y0) - T.slope * s,
        Math.max(1, (T.corner - T.slope) * s),
      );
      trayHoles.push(new THREE.Path(rim));
      const wall = new THREE.Mesh(ringWallGeometry(rim, 0, floorEdge, floorZ, 40 * s), trayWallMat);
      wall.castShadow = true;
      wall.receiveShadow = true;
      boxesGroup.add(wall);
      const floor = new THREE.Mesh(new THREE.ShapeGeometry(new THREE.Shape(floorEdge)), trayFloorMat);
      floor.position.z = floorZ;
      floor.receiveShadow = true;
      boxesGroup.add(floor);
      const over = unassigned ? ids.length > UNASSIGNED_CAP : isOverfull(ids, settings);
      if (over) {
        const tint = new THREE.Mesh(new THREE.ShapeGeometry(new THREE.Shape(floorEdge)), overfullMat);
        tint.position.z = floorZ + 0.15;
        boxesGroup.add(tint);
      }
      // Title, top left inside the box.
      const title = unassigned ? 'Unassigned' : teamTitle(i);
      const capWorld = Math.min(R.titleCap, titleBand * 0.55) * s;
      const tx = wx(box.x0 + 10);
      const ty = wy(y0 + titleBand / 2);
      titleMaterial(title).then(({ mat, aspect, capFrac }) => {
        if (layout?.boxes !== boxes) return; // laid out again meanwhile
        const h = capWorld / capFrac;
        const plane = new THREE.Mesh(new THREE.PlaneGeometry(h / aspect, h), mat);
        plane.position.set(tx + h / aspect / 2, ty, floorZ + 0.25);
        boxesGroup.add(plane);
        requestRender();
      });
      // Name tags, in a grid sized for this box's capacity.
      const slots = unassigned ? UNASSIGNED_CAP : boxCap(settings);
      const g = slotGrid(slots, box.x1 - box.x0 - 16, boxH - titleBand - 8);
      box.grid = g;
      ids.forEach((id, k) => {
        const t = tagFor(id);
        if (t === drag?.tag) return; // the one being dragged follows the pointer instead
        const col = k % g.c;
        const row = Math.floor(k / g.c);
        // 15% over the grid's own fit (Luke, 2026-10-05: "Expand them by
        // 15%. It's OK if they're nearly touching, as long as they don't
        // actually touch"), then held to 97% of the cell's width and 95% of
        // its height. A name too long for its cell at that size is shrunk
        // to fit it, on its own; every other tag keeps the full size.
        let th = g.tagH * TAG_SCALE;
        let tw = th / t.aspect;
        if (tw > g.cw * 0.97) {
          tw = g.cw * 0.97;
          th = tw * t.aspect;
        }
        if (th > g.ch * 0.95) {
          th = g.ch * 0.95;
          tw = th / t.aspect;
        }
        placeTag(t, wx(box.x0 + 8 + (col + 0.5) * g.cw), wy(y0 + titleBand + (row + 0.5) * g.ch), tw * s, th * s, instant);
      });
    }
    layout = { boxes };
    setTrays(boxes, trayHoles);
    renderExtras();
    requestRender();
  }

  // Board lettering that isn't part of a dial or button: the current game's
  // join code (so a student whose camera won't scan can type it), and
  // "Coming soon" over the mode window while a mode that isn't playable yet
  // is selected (Luke, 2026-10-05: Volcano is blocked until the Cavern is
  // wired into the lobby).
  let gameCode = null;
  const extrasGroup = new THREE.Group();
  rosterGroup.add(extrasGroup);
  function currentMode() {
    const d = dials.find((x) => x.modes?.some(Boolean));
    if (!d) return null;
    const stepRad = (d.step * Math.PI) / 180;
    const idx = d.target ?? Math.round(-d.group.rotation.z / stepRad);
    return d.modes[Math.max(0, Math.min(d.modes.length - 1, idx))] ?? null;
  }
  const PLAYABLE_MODES = new Set(['skypath']);
  let extrasGen = 0; // bumped each render, so a label still loading from an older render is dropped
  function renderExtras() {
    if (!boardSize.w) return;
    const s = Math.min(boardSize.w / 1600, boardSize.h / 900);
    const F = params.frameWidth * s;
    const wx = (x) => -boardSize.w / 2 + F + x * s;
    const wy = (y) => boardSize.h / 2 - F - y * s;
    for (const c of [...extrasGroup.children]) {
      extrasGroup.remove(c);
      c.geometry.dispose();
    }
    const gen = ++extrasGen;
    const add = (text, x, y, cap, z) =>
      titleMaterial(text).then(({ mat, aspect, capFrac }) => {
        if (gen !== extrasGen) return;
        const h = (cap * s) / capFrac;
        const plane = new THREE.Mesh(new THREE.PlaneGeometry(h / aspect, h), mat);
        plane.position.set(wx(x), wy(y), z);
        extrasGroup.add(plane);
        requestRender();
      });
    // The code: right of the mode dial, in the same lettering as the labels.
    if (gameCode) add(`Code ${gameCode}`, 520, 437, 22, 0.2);
    // Coming soon: across the bottom of the mode window, in front of it.
    const mode = currentMode();
    if (mode && !PLAYABLE_MODES.has(mode)) add('Coming soon', 40 + 598 / 2, 40 + 337 - 40, 34, 1);
  }

  // Re-makes the board sheet with the trays' openings, only when the boxes
  // actually changed (not on every drag or arrival).
  function setTrays(boxes, holes) {
    if (!sheetState) return;
    const key = boxes.map((b) => `${b.x0},${b.y0},${b.x1},${b.y1}`).join('|') + `@${boardSize.w}`;
    if (key === sheetState.traysKey) return;
    sheetState.traysKey = key;
    const old = sheetState.mesh.geometry;
    sheetState.mesh.geometry = sheetGeometry(sheetState.baseHoles, holes);
    old.dispose();
  }

  // ---- real players (fed from the game's realtime presence by LobbyBoard.jsx)
  // A player whose connection drops is greyed out, not removed (Luke,
  // 2026-10-05): phones sleep and classroom wifi blips, and a name that
  // vanished and reappeared would lose its place. Back within AWAY_SECONDS:
  // un-greyed, same place. Not back: removed.
  const AWAY_SECONDS = 60;
  const awayTimers = new Map(); // id -> timeout
  const AWAY_OPACITY = 0.35;
  // Where each player was last placed, by token, restored from a save after a
  // teacher reload (see importState) so returning players land back in place.
  let savedPlacement = new Map();
  const isDevPlayer = (id) => id.startsWith('dev_');

  function setAway(id, away) {
    const t = tags.get(id);
    if (away) {
      if (awayTimers.has(id)) return;
      awayTimers.set(id, setTimeout(() => dropPlayer(id), AWAY_SECONDS * 1000));
      if (t) t.mesh.material.opacity = AWAY_OPACITY;
    } else {
      clearTimeout(awayTimers.get(id));
      awayTimers.delete(id);
      if (t) t.mesh.material.opacity = 1;
    }
    requestRender();
  }
  function dropPlayer(id) {
    clearTimeout(awayTimers.get(id));
    awayTimers.delete(id);
    removePlayer(roster, id);
    playerColours.delete(id);
    const t = tags.get(id);
    if (t) {
      rosterGroup.remove(t.mesh);
      t.mesh.material.map?.dispose();
      t.mesh.material.dispose();
      tags.delete(id);
    }
    rosterChanged();
  }
  // Adds a player under a given id, respecting the cap. Returns false if full.
  function admit(id, name, colourHex) {
    if (roster.names.size >= PLAYER_CAP) return false;
    playerColours.set(id, colourHex);
    rosterAdd(roster, settings, id, normalizePlayerName(name) || 'Player');
    const saved = savedPlacement.get(id);
    if (saved !== undefined) movePlayer(roster, settings, id, saved === 'u' ? 'unassigned' : Number(saved));
    return true;
  }
  function exportState() {
    const placement = {};
    roster.teams.forEach((t, i) => t.forEach((id) => (placement[id] = i)));
    roster.unassigned.forEach((id) => (placement[id] = 'u'));
    return { settings: { ...settings }, placement };
  }
  function rosterChanged() {
    renderRoster();
    hooks.onRosterChange?.(exportState());
  }

  function rosterBoxAt(worldX, worldY) {
    if (!layout) return null;
    const W = boardSize.w;
    const H = boardSize.h;
    const s = Math.min(W / 1600, H / 900);
    const F = params.frameWidth * s;
    const x = (worldX + W / 2 - F) / s;
    const y = (H / 2 - F - worldY) / s;
    return layout.boxes.find((b) => x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1) ?? null;
  }

  function dialSettings() {
    const out = { ...settings };
    for (const d of dials) {
      if (!d.setting) continue;
      const stepRad = (d.step * Math.PI) / 180;
      const idx = d.target ?? Math.round(-d.group.rotation.z / stepRad);
      out[d.setting] = d.values[Math.max(0, Math.min(d.values.length - 1, idx))];
    }
    return out;
  }
  // Called whenever a settings dial is clicked (cancel) and when it comes to
  // rest (restart the countdown).
  function settingsDialMoved(resting) {
    clearTimeout(settleTimer);
    if (!resting || dials.some((d) => d.setting && d.turning)) return;
    settleTimer = setTimeout(() => {
      settings = dialSettings();
      applySettings(roster, settings);
      rosterChanged();
    }, params.roster.settleSeconds * 1000);
  }

  // Dragging a tag: it lifts off the board (with a shadow) and follows the
  // pointer; dropped on a box with room, it moves there; anywhere else, or
  // onto a full box, it goes back.
  let drag = null; // { tag, id, off: Vector2 }
  const dragPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
  function pointerOnBoard(ev) {
    const r = renderer.domElement.getBoundingClientRect();
    ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    return raycaster.ray.intersectPlane(dragPlane, new THREE.Vector3());
  }
  function tagAt(ev) {
    const r = renderer.domElement.getBoundingClientRect();
    ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const hit = raycaster.intersectObjects([...tags.values()].map((t) => t.mesh).filter((m) => m.material.visible))[0];
    return hit ? tags.get(hit.object.userData.playerId) : null;
  }

  // The QR card: progress p runs 0 (hidden) to 1 (in place); see poseQr().
  // zoom runs 0 (on the board) to 1 (expanded); see zoomQr().
  // hovered/waveAmp: the hover waves, wanted and how far faded in (0-1).
  const qr = { p: 0, target: 0, mesh: null, shownPos: null, hiddenPos: null, zoom: 0, zoomTarget: 0, zoomPos: null, hovered: false, waveAmp: 0, waves: [] };
  qr.mat = new THREE.MeshBasicMaterial({ transparent: true, alphaTest: 0.5, side: THREE.DoubleSide });
  qr.mat.visible = false; // until its texture exists
  // One material per wave, each fading on its own; in the code's own ink,
  // so the waves look drawn onto the card like the code is.
  qr.waveMats = Array.from(
    { length: params.qrCard.waves.count },
    () => new THREE.MeshBasicMaterial({ color: QR_CARD.ink, transparent: true, opacity: 0, depthWrite: false }),
  );
  // The card is drawn once a game exists: its QR carries that game's join
  // link (see setGame).
  let joinLink = null;
  function loadQrCard(url) {
    buildQrCard(url).then((canvas) => {
      if (url !== joinLink) return; // a newer game replaced this one meanwhile
      const old = qr.mat.map;
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 8;
      qr.mat.map = tex;
      qr.mat.visible = true;
      qr.mat.needsUpdate = true;
      old?.dispose();
      requestRender();
    });
  }
  // In: decelerates into place with the slightest overshoot, as a hand
  // placing something does. Out: accelerates away. The tilt unwinds as it
  // arrives, which sells the "carried in by the hand" swing.
  function poseQr(p) {
    if (!qr.mesh) return;
    qr.mesh.visible = p > 0.001;
    qr.mesh.position.lerpVectors(qr.hiddenPos, qr.shownPos, p);
    qr.mesh.rotation.z = (1 - Math.min(1, p)) * 0.18;
    if (qr.zoom > 0) qr.mesh.position.lerp(qr.zoomPos, qr.zoom);
  }
  // Smoothstep both ways: it's lifted up to the camera and set back down,
  // not thrown, so it starts and ends at rest. A reversal mid-way restarts
  // the curve from where the card is, so it doesn't jump.
  function zoomQr(up) {
    qr.zoomTarget = up ? 1 : 0;
    const from = qr.zoom;
    const to = qr.zoomTarget;
    const q = params.qrCard;
    const dur = (up ? q.zoomInSeconds : q.zoomOutSeconds) * Math.abs(to - from);
    const start = performance.now();
    const id = (qr.zoomId = (qr.zoomId ?? 0) + 1);
    const frame = (now) => {
      if (qr.zoomId !== id) return;
      const t = dur > 0 ? Math.min(1, (now - start) / (dur * 1000)) : 1;
      qr.zoom = from + (to - from) * t * t * (3 - 2 * t);
      poseQr(qr.p);
      renderer.render(scene, camera);
      if (t < 1) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }
  // Square outlines leave the code's edge and travel outward across the
  // band, fading as they go, evenly staggered so one is always setting off as
  // another dies. Each grows from the code's centre, so its edge moves out
  // while its line thickens by only band/code-size, too little to see.
  function poseWaves(now) {
    const w = params.qrCard.waves;
    qr.waves.forEach((ring, i) => {
      const phase = (now / 1000 / w.seconds + i / w.count) % 1;
      ring.scale.setScalar(1 + phase * ring.userData.grow);
      // Fades in over the first tenth so a new line doesn't pop in.
      qr.waveMats[i].opacity = w.opacity * qr.waveAmp * Math.min(1, phase * 10) * (1 - phase);
    });
  }
  // Runs only while the waves are showing or fading out (a quick 0.15 s
  // either way), so the board isn't re-rendering every frame for nothing.
  function hoverQr(on) {
    if (qr.hovered === on) return;
    qr.hovered = on;
    if (qr.waveLoop) return;
    qr.waveLoop = true;
    let last = performance.now();
    const frame = (now) => {
      qr.waveAmp = Math.max(0, Math.min(1, qr.waveAmp + ((qr.hovered ? 1 : -1) * (now - last)) / 150));
      last = now;
      poseWaves(now);
      renderer.render(scene, camera);
      if (qr.hovered || qr.waveAmp > 0) requestAnimationFrame(frame);
      else qr.waveLoop = false;
    };
    requestAnimationFrame(frame);
  }
  // True when the pointer is on the card itself, short of its edge margin
  // (not on the hand, nor the card's rim), with the card resting in place.
  function overQrCard(ev) {
    if (!qr.mesh?.visible || qr.target !== 1 || qr.p !== 1 || qr.zoomTarget !== 0 || qr.zoom !== 0) return false;
    const r = renderer.domElement.getBoundingClientRect();
    ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const hit = raycaster.intersectObject(qr.mesh, false)[0];
    if (!hit?.uv) return false;
    const x = hit.uv.x * QR_BACKING.w;
    const y = (1 - hit.uv.y) * QR_BACKING.h;
    const c = QR_BACKING.card;
    const m = params.qrCard.hoverMargin;
    return x > c.x0 + m && x < c.x0 + c.w - m && y > c.y0 + m && y < c.y0 + c.h - m;
  }
  function moveQr(show) {
    qr.target = show ? 1 : 0;
    const from = qr.p;
    const to = qr.target;
    // A reversal mid-way only takes the time for the distance left.
    const dur = (show ? params.qrCard.inSeconds : params.qrCard.outSeconds) * Math.abs(to - from);
    const start = performance.now();
    const id = (qr.animId = (qr.animId ?? 0) + 1);
    const frame = (now) => {
      if (qr.animId !== id) return;
      const t = dur > 0 ? Math.min(1, (now - start) / (dur * 1000)) : 1;
      const c = 1.2; // easeOutBack, gentle
      const e = show ? 1 + (c + 1) * (t - 1) ** 3 + c * (t - 1) ** 2 : t * t * t;
      qr.p = from + (to - from) * e;
      poseQr(qr.p);
      renderer.render(scene, camera);
      if (t < 1) requestAnimationFrame(frame);
      else qr.p = to;
    };
    requestAnimationFrame(frame);
  }
  // Slot pictures, cached by src so a resize rebuild doesn't reload them.
  const slotMats = new Map();
  function slotMaterial(src) {
    if (!slotMats.has(src)) {
      // Plain card until the painting arrives. The texture is only created
      // once the image has loaded: a CanvasTexture first uploaded at one size
      // and then redrawn at another keeps its original (blank) GPU storage,
      // so creating it early showed an empty window depending on load timing.
      const mat = new THREE.MeshStandardMaterial({ color: 0x9a7a55, roughness: 0.9 });
      const img = new Image();
      img.onload = () => {
        // The paintings have a paper margin; it's cut off (2% each side) here
        // rather than by UV offset, so that the mirrored wrap reflects at the
        // painting's edge, not at the paper's.
        const canvas = document.createElement('canvas');
        const mx = img.width * 0.02;
        const my = img.height * 0.02;
        canvas.width = img.width - 2 * mx;
        canvas.height = img.height - 2 * my;
        canvas.getContext('2d').drawImage(img, mx, my, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
        const tex = new THREE.CanvasTexture(canvas);
        tex.colorSpace = THREE.SRGBColorSpace;
        // Mirrored, so where a segment reaches past the painting (only ever
        // seen mid-turn) it carries on as its own reflection, with no seam.
        tex.wrapS = tex.wrapT = THREE.MirroredRepeatWrapping;
        mat.map = tex;
        mat.color.set(0xffffff);
        mat.needsUpdate = true;
        requestRender();
      };
      img.src = src;
      slotMats.set(src, mat);
    }
    return slotMats.get(src);
  }
  /**
   * A number card for a dial wheel: the card texture, at the board's own
   * grain scale, covering a segment's bounding box (wWorld x hWorld, origin
   * at the wheel axis), with the numeral drawn where the window sits when
   * that slot is centred. There's no cardboard digit art (the letter set is
   * A-Z only), so numerals are drawn with a handwriting font in dark ink.
   */
  function numberTexture(text, wWorld, hWorld, reach, winH) {
    const PX = 2; // canvas px per world unit at s=1-ish; plenty for a small window
    const c = document.createElement('canvas');
    c.width = Math.ceil(wWorld * PX);
    c.height = Math.ceil(hWorld * PX);
    const ctx = c.getContext('2d');
    const pat = ctx.createPattern(faceCanvas, 'repeat');
    pat.setTransform(new DOMMatrix().scale((CARDBOARD_TILE * PX) / faceCanvas.width));
    ctx.fillStyle = pat;
    ctx.fillRect(0, 0, c.width, c.height);
    const cy = c.height - reach * PX; // canvas y runs down; world y=reach is the window centre
    ctx.save();
    ctx.translate(c.width / 2, cy);
    ctx.rotate(-0.04);
    ctx.fillStyle = '#3a2716';
    ctx.font = `bold ${Math.round(winH * PX * 0.78)}px 'Segoe Print', 'Bradley Hand', 'Comic Sans MS', cursive`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 0, winH * PX * 0.04);
    ctx.restore();
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  let prevAngles = []; // dial angles survive a resize rebuild
  let content = null;
  let size = { w: 0, h: 0 };
  let boardSize = { w: 0, h: 0 }; // the 16:9 board inside the viewport

  function disposeContent() {
    if (!content) return;
    content.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
    });
    for (const m of wheelMats) {
      m.map.dispose();
      m.dispose();
    }
    wheelMats.length = 0;
    for (const d of dials) {
      if (!d.faceMat) continue; // the original-art dial shares origDialMat
      d.faceMat.map.dispose();
      d.faceMat.dispose();
    }
    dials.length = 0;
    scene.remove(content);
    content = null;
  }

  function build(W, H) {
    disposeContent();
    content = new THREE.Group();
    scene.add(content);
    const s = Math.min(W / 1600, H / 900);
    const P = params;
    const F = P.frameWidth * s;
    const boardT = P.boardThickness * s;
    const cavity = P.cavityDepth * s;
    const rand = mulberry32(31);

    // --- cardboard sheet, with the housings' window + hole cut right through
    sheetState = null;
    pendingSheet = { W, H, boardT };
    const sheet = new THREE.Shape();
    sheet.moveTo(-W / 2, -H / 2);
    sheet.lineTo(W / 2, -H / 2);
    sheet.lineTo(W / 2, H / 2);
    sheet.lineTo(-W / 2, H / 2);
    sheet.closePath();

    const housings = P.dials.map((d) => {
      const R = (d.hole * s) / 2;
      const ww = d.window.w * s;
      const wh = d.window.h * s;
      const gap = d.gap * s;
      const cx = -W / 2 + F + d.place.x * s;
      const winY = H / 2 - F - d.place.y * s;
      const holeY = winY - wh / 2 - gap - R;
      return { d, R, cx, holeY, winY, ww, wh, original: d.style === 'original' };
    });

    for (const h of housings) {
      if (h.original) continue;
      h.win = handCutRect(h.cx, h.winY, h.ww, h.wh, s, rand);
      h.hole = handCutCircle(h.cx, h.holeY, h.R, s, rand);
      sheet.holes.push(new THREE.Path(h.win.points), new THREE.Path(h.hole));
    }
    const buttonSpots = (P.buttons ?? []).map((b) => {
      const size = b.size * s;
      const cx = -W / 2 + F + b.place.x * s;
      const cy = H / 2 - F - b.place.y * s;
      const hole = handCutRect(cx, cy, size, size, s, rand);
      sheet.holes.push(new THREE.Path(hole.points));
      return { b, size, cx, cy, hole };
    });

    const sheetMesh = new THREE.Mesh(sheetGeometry(sheet.holes, []), [cardMat, cutEdgeMat]);
    sheetMesh.receiveShadow = true;
    sheetMesh.castShadow = true;
    content.add(sheetMesh);
    // The team-box trays are cut into this sheet too, but they change with the
    // dials, so renderRoster() re-makes the sheet's geometry with them (see
    // setTrays). Kept here: the holes that never change.
    sheetState = { mesh: sheetMesh, baseHoles: sheet.holes.slice(), W, H, boardT, traysKey: null };

    // --- the dark cavity behind the board, seen around each dial
    const back = new THREE.Mesh(new THREE.PlaneGeometry(W, H), cavityMat);
    back.position.z = -boardT - cavity;
    back.receiveShadow = true;
    content.add(back);

    // --- per housing: the cut walls, the over-cut slits, and the dial
    const taper = P.cutTaper * boardT;
    for (const h of housings) {
      const R = h.R;
      const lift = P.dialLift * s;
      if (h.original) {
        // Flat on the board, no shadow (Luke's choice): only the dial is raised.
        const win = new THREE.Mesh(new THREE.PlaneGeometry(h.ww, h.wh), origWindowMat);
        win.position.set(h.cx, h.winY, 0.1);
        content.add(win);
        const group = new THREE.Group();
        group.position.set(h.cx, h.holeY, 0);
        // A hair narrower than the face, so no column edge peeks out past it.
        const column = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.97, R * 0.97, lift, 96, 1, true), columnMat);
        column.rotation.x = Math.PI / 2;
        column.position.z = lift / 2;
        const face = new THREE.Mesh(new THREE.CircleGeometry(R, 96), origDialMat);
        face.position.z = lift + 0.05;
        for (const m of [column, face]) {
          m.castShadow = true;
          m.receiveShadow = true;
          group.add(m);
        }
        group.rotation.z = dials.length < prevAngles.length ? prevAngles[dials.length] : 0;
        content.add(group);
        dials.push({ group, wheel: null, step: 45, faceMat: null, turning: false });
        continue;
      }
      for (const outline of [h.win.points, h.hole]) {
        const wall = new THREE.Mesh(ringWallGeometry(outline, 0, insetOutline(outline, taper, rand), -boardT, 40 * s), cutWallMat);
        wall.castShadow = true;
        wall.receiveShadow = true;
        content.add(wall);
      }
      for (const tri of h.win.overcuts) {
        const slit = new THREE.Mesh(new THREE.ShapeGeometry(new THREE.Shape(tri)), overcutMat);
        slit.position.z = 0.08;
        content.add(slit);
      }

      const rb = R * 0.9; // base radius: clear of the hole's inward-sloping wall, leaving a dark ring like the original's
      const rt = rb * (1 - P.dialTaper);
      // The dial piece's face is at `lift`, like the original's; below the
      // piece, a column runs down through the hole to the cavity floor.
      const pieceH = Math.min(P.dialHeight * s, lift);
      const colTop = lift - pieceH;
      const dialTop = lift;
      const dialBottom = -boardT - cavity;
      const base = handCutCircle(0, 0, rb, s, rand);
      const phase = rand() * 10;
      const top = base.map((p, i) => p.clone().multiplyScalar((rt / rb) * (1 + Math.sin(i * 0.29 + phase) * 0.007)));
      const group = new THREE.Group();
      group.position.set(h.cx, h.holeY, 0);

      const below = new THREE.Mesh(ringWallGeometry(base, colTop, base, dialBottom, 40 * s), cutWallMat);
      const side = new THREE.Mesh(ringWallGeometry(top, dialTop, base, colTop, FLUTES_PER_TILE * P.flutePitch * s), fluteMat);
      const faceTex = canvasTexture(faceCanvas);
      faceTex.repeat.set(1 / CARDBOARD_TILE, 1 / CARDBOARD_TILE);
      faceTex.offset.set(rand(), rand());
      const faceMat = new THREE.MeshStandardMaterial({ map: faceTex, bumpMap: faceTex, bumpScale: 1.2, roughness: 0.95 });
      const face = new THREE.Mesh(new THREE.ShapeGeometry(new THREE.Shape(top)), faceMat);
      face.position.z = dialTop;
      for (const m of [below, side, face]) {
        m.castShadow = true;
        m.receiveShadow = true;
        group.add(m);
      }

      group.rotation.z = dials.length < prevAngles.length ? prevAngles[dials.length] : 0;
      content.add(group);

      // --- the picture wheel behind the window (see header)
      let wheel = null;
      if (h.d.slots) {
        const n = h.d.wheelSlots ?? h.d.slots.length;
        const half = Math.PI / n; // half of one slot's angle
        const pw = h.ww + 24 * s; // a picture overlaps the window a little all round
        const ph = h.wh + 24 * s;
        const g = (h.d.slotGap ?? 6) * s;
        const pad = 3 * s; // card showing beside the picture's inner corners
        // Inner edge distance from the axis: far enough that the picture
        // (plus a little card) fits inside its segment at its narrowest.
        const rIn = (pw / 2 + pad + g / 2 / Math.cos(half)) / Math.tan(half);
        const reach = rIn + ph / 2; // axis to picture centre
        // One segment, in slot-local coords (axis at origin, slot centred on
        // +y): bounded by the slot's two edge rays, each pushed g/2 inward.
        // Segments run right down to the axis, so neighbours tile the whole
        // wheel. Any inner edge left a triangle of hub showing between two
        // pictures mid-turn.
        const segBottom = 0;
        const segTop = rIn + ph + 60 * s; // past the window's top at any angle it's seen at
        // Drawn with no gap, plus a hair of overlap so no cavity shows along
        // the seam between neighbours.
        const edgeX = (y) => y * Math.tan(half) + 0.3 * s;
        const segShape = new THREE.Shape([
          new THREE.Vector2(-edgeX(segBottom), segBottom),
          new THREE.Vector2(edgeX(segBottom), segBottom),
          new THREE.Vector2(edgeX(segTop), segTop),
          new THREE.Vector2(-edgeX(segTop), segTop),
        ]);
        wheel = new THREE.Group();
        wheel.position.set(h.cx, h.winY - reach, 0);
        // Each wheel only draws around its own window. The wheels are far
        // bigger than their windows and overlap each other behind the board,
        // so without this one could show through another's window.
        const m = 30 * s;
        const clip = [
          new THREE.Plane(new THREE.Vector3(1, 0, 0), -(h.cx - h.ww / 2 - m)),
          new THREE.Plane(new THREE.Vector3(-1, 0, 0), h.cx + h.ww / 2 + m),
          new THREE.Plane(new THREE.Vector3(0, 1, 0), -(h.winY - h.wh / 2 - m)),
          new THREE.Plane(new THREE.Vector3(0, -1, 0), h.winY + h.wh / 2 + m),
        ];
        const segTex = canvasTexture(faceCanvas);
        segTex.repeat.set(1 / CARDBOARD_TILE, 1 / CARDBOARD_TILE);
        const segMat = new THREE.MeshStandardMaterial({ map: segTex, roughness: 0.95, clippingPlanes: clip });
        wheelMats.push(segMat);
        h.d.slots.forEach((slot, i) => {
          const a = (i * 2 * Math.PI) / n;
          const slotGroup = new THREE.Group();
          slotGroup.rotation.z = a;
          slotGroup.position.z = -boardT - 2 * s;
          // A picture is printed across its WHOLE segment rather than glued on
          // as a smaller rectangle: Luke didn't want the strip of bare card and
          // the gap line that showed beside it mid-turn. UVs are planar, so
          // the window, at rest, shows exactly the painting's own
          // pw x ph area as before (paper margin already trimmed off).
          const geo = new THREE.ShapeGeometry(segShape);
          let mat = segMat;
          if (slot?.text) {
            // A number: drawn onto a card canvas covering the segment's whole
            // bounding box, so no part of the segment ever samples off the
            // edge of the texture (a mirrored or smeared numeral mid-turn
            // would look wrong in a way a mirrored painting doesn't).
            const bx = edgeX(segTop);
            const uv = geo.attributes.uv;
            const pos = geo.attributes.position;
            for (let k = 0; k < pos.count; k++) uv.setXY(k, (pos.getX(k) + bx) / (2 * bx), pos.getY(k) / segTop);
            const tex = numberTexture(slot.text, 2 * bx, segTop, reach, h.wh);
            mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95, clippingPlanes: clip });
            wheelMats.push(mat);
          } else if (slot) {
            const uv = geo.attributes.uv;
            const pos = geo.attributes.position;
            for (let k = 0; k < pos.count; k++) {
              const u = (pos.getX(k) + pw / 2) / pw;
              const v = (pos.getY(k) - (reach - ph / 2)) / ph;
              uv.setXY(k, u, v);
            }
          }
          if (slot?.src) {
            mat = slotMaterial(slot.src);
            mat.clippingPlanes = clip;
          }
          const seg = new THREE.Mesh(geo, mat);
          seg.position.z = i * 0.05 * s; // neighbours overlap a hair; keep them off each other's depth
          seg.receiveShadow = true;
          slotGroup.add(seg);
          wheel.add(slotGroup);
        });
        wheel.rotation.z = group.rotation.z;
        content.add(wheel);
      }
      const step = h.d.wheelSlots ? 360 / h.d.wheelSlots : 45;
      dials.push({
        group,
        wheel,
        step,
        slotCount: h.d.slots?.length ?? 0,
        setting: h.d.setting,
        values: h.d.slots?.map((sl) => sl.value),
        modes: h.d.slots?.map((sl) => sl.mode),
        faceMat,
        turning: false,
      });

      // --- the label above the window, in the game's cardboard lettering
      if (h.d.label) {
        const forContent = content;
        labelCanvas(h.d.label).then(({ canvas, capPx }) => {
          if (content !== forContent) return; // a resize rebuilt the board meanwhile
          const k = (P.labelCapHeight * s) / capPx; // world units per canvas px
          const tex = new THREE.CanvasTexture(canvas);
          tex.colorSpace = THREE.SRGBColorSpace;
          const mat = new THREE.MeshStandardMaterial({ map: tex, transparent: true, roughness: 0.95, depthWrite: false });
          wheelMats.push(mat);
          const plane = new THREE.Mesh(new THREE.PlaneGeometry(canvas.width * k, canvas.height * k), mat);
          plane.position.set(h.cx, h.winY + h.wh / 2 + 6 * s + (canvas.height * k) / 2, 0.12);
          plane.receiveShadow = true;
          content.add(plane);
          requestRender();
        });
      }
    }

    // --- push buttons (see LOBBY_BOARD_DEFAULTS.buttons)
    buttons.length = 0;
    for (const bs of buttonSpots) {
      const lift = P.dialLift * s;
      for (const outline of [bs.hole.points]) {
        const wall = new THREE.Mesh(ringWallGeometry(outline, 0, insetOutline(outline, taper, rand), -boardT, 40 * s), cutWallMat);
        wall.castShadow = true;
        wall.receiveShadow = true;
        content.add(wall);
      }
      for (const tri of bs.hole.overcuts) {
        const slit = new THREE.Mesh(new THREE.ShapeGeometry(new THREE.Shape(tri)), overcutMat);
        slit.position.z = 0.08;
        content.add(slit);
      }
      // The block: a hand-cut square a little inside the hole (clear of its
      // sloping walls), its top narrower than its base like the dials', with
      // the same corrugated side.
      const base = handCutRect(0, 0, bs.size * 0.88, bs.size * 0.88, s, rand).points;
      const top = base.map((p) => p.clone().multiplyScalar(1 - P.dialTaper));
      const pieceH = Math.min(P.dialHeight * s, lift);
      const colTop = lift - pieceH;
      const bottom = -boardT - cavity;
      const group = new THREE.Group();
      group.position.set(bs.cx, bs.cy, 0);
      const below = new THREE.Mesh(ringWallGeometry(base, colTop, base, bottom, 40 * s), cutWallMat);
      const side = new THREE.Mesh(ringWallGeometry(top, lift, base, colTop, FLUTES_PER_TILE * P.flutePitch * s), fluteMat);
      const faceTex = canvasTexture(faceCanvas);
      faceTex.repeat.set(1 / CARDBOARD_TILE, 1 / CARDBOARD_TILE);
      faceTex.offset.set(rand(), rand());
      const faceMat = new THREE.MeshStandardMaterial({ map: faceTex, bumpMap: faceTex, bumpScale: 1.2, roughness: 0.95 });
      wheelMats.push(faceMat);
      const face = new THREE.Mesh(new THREE.ShapeGeometry(new THREE.Shape(top)), faceMat);
      face.position.z = lift;
      for (const m of [below, side, face]) {
        m.castShadow = true;
        m.receiveShadow = true;
        group.add(m);
      }
      content.add(group);
      // Pressed, the whole block drops until its face is just below the board.
      buttons.push({ id: bs.b.id, group, pressedZ: -(lift + P.buttonPressedDepth * s), pressed: false });
      // Buttons are labelled above, like the dials, so two blank squares
      // can be told apart.
      if (bs.b.label) {
        const forContent = content;
        labelCanvas(bs.b.label).then(({ canvas, capPx }) => {
          if (content !== forContent) return;
          const k = (P.labelCapHeight * s) / capPx;
          const tex = new THREE.CanvasTexture(canvas);
          tex.colorSpace = THREE.SRGBColorSpace;
          const mat = new THREE.MeshStandardMaterial({ map: tex, transparent: true, roughness: 0.95, depthWrite: false });
          wheelMats.push(mat);
          const plane = new THREE.Mesh(new THREE.PlaneGeometry(canvas.width * k, canvas.height * k), mat);
          plane.position.set(bs.cx, bs.cy + bs.size / 2 + 6 * s + (canvas.height * k) / 2, 0.12);
          content.add(plane);
          requestRender();
        });
      }
    }

    // --- the QR card: built at this size, posed from its current progress
    {
      const q = P.qrCard;
      const k = (q.cardSize * s) / QR_BACKING.card.w; // world units per backing px
      const geo = new THREE.PlaneGeometry(QR_BACKING.w * k, QR_BACKING.h * k);
      qr.mesh = new THREE.Mesh(geo, qr.mat);
      qr.mesh.castShadow = true;
      qr.mesh.renderOrder = 5;
      // Card centre on screen when shown; the image's own centre is offset
      // from it, since the card is right of centre in the backing (the hand
      // takes up the left).
      const cardX = -W / 2 + F + q.centre.x * s;
      const cardY = H / 2 - F - q.centre.y * s;
      const offX = (QR_BACKING.w / 2 - QR_BACKING.card.cx) * k;
      const offY = (QR_BACKING.card.cy - QR_BACKING.h / 2) * k; // backing y runs down
      qr.shownPos = new THREE.Vector3(cardX + offX, cardY + offY, q.height * s);
      // Hidden: the whole image just off the board's left edge, tipped back
      // a little, as if still on its way in from the side.
      qr.hiddenPos = new THREE.Vector3(-W / 2 - (QR_BACKING.w * k) / 2 - 20 * s, cardY + offY - 30 * s, q.height * s);
      // Expanded: the CODE centred on the camera's axis, at the distance where
      // its height fills zoomCodeCover of the view. The view is H tall at the
      // board, so that distance is the camera's times codeH / (cover * H).
      const code = QR_CARD.code;
      const codeH = code.size * k;
      const codeX = (code.x0 + code.size / 2 - QR_BACKING.w / 2) * k; // code centre, in the mesh
      const codeY = (QR_BACKING.h / 2 - (code.y0 + code.size / 2)) * k;
      const camZ = H / 2 / Math.tan(THREE.MathUtils.degToRad(FOV / 2));
      qr.zoomPos = new THREE.Vector3(-codeX, -codeY, camZ - (camZ * codeH) / (q.zoomCodeCover * H));
      // The hover waves: square outlines around the code, starting just off
      // its edge. They sit inside the card's margin round the code.
      const wv = q.waves;
      const inner = codeH / 2 + wv.gap * s;
      // A rounded square, its outer edge's corners rounded a line-width more
      // than the inner's, so the line keeps an even thickness round the bend.
      const roundedSquare = (path, half, r, clockwise) => {
        const pts = [
          [half, half, 0],
          [-half, half, 1],
          [-half, -half, 2],
          [half, -half, 3],
        ];
        if (clockwise) pts.reverse();
        for (const [x, y, q] of pts) {
          const a0 = (q * Math.PI) / 2;
          const cx = x - Math.sign(x) * r;
          const cy = y - Math.sign(y) * r;
          if (clockwise) path.absarc(cx, cy, r, a0 + Math.PI / 2, a0, true);
          else path.absarc(cx, cy, r, a0, a0 + Math.PI / 2, false);
        }
        path.closePath();
        return path;
      };
      const r = wv.corner * s;
      const outline = roundedSquare(new THREE.Shape(), inner + wv.line * s, r + wv.line * s, false);
      outline.holes.push(roundedSquare(new THREE.Path(), inner, r, true));
      const ringGeo = new THREE.ShapeGeometry(outline, 12);
      qr.waves = qr.waveMats.map((mat) => {
        const ring = new THREE.Mesh(ringGeo, mat);
        ring.position.set(codeX, codeY, 0.5 * s);
        ring.renderOrder = 6;
        ring.userData.grow = ((wv.band - wv.gap) * s) / inner; // the scale that carries the edge across the band
        qr.mesh.add(ring);
        return ring;
      });
      poseWaves(performance.now());
      content.add(qr.mesh);
      poseQr(qr.p);
    }

    // --- the oak frame: four mitred bars
    const bars = [
      { len: W, rot: 0, x: 0, y: H / 2 - F / 2 },
      { len: W, rot: Math.PI, x: 0, y: -H / 2 + F / 2 },
      { len: H, rot: -Math.PI / 2, x: W / 2 - F / 2, y: 0 },
      { len: H, rot: Math.PI / 2, x: -W / 2 + F / 2, y: 0 },
    ];
    bars.forEach((b, i) => {
      const bar = new THREE.Mesh(frameBarGeometry(b.len, F, P.frameDepth * s, P.frameBevel * s), [woodMats[i], woodMats[i]]);
      bar.rotation.z = b.rot;
      bar.position.set(b.x, b.y, 0);
      bar.castShadow = true;
      bar.receiveShadow = true;
      content.add(bar);

      // contact shadow along this bar's inner edge
      const A = 26 * s;
      const strip = new THREE.Mesh(new THREE.PlaneGeometry(b.len - 2 * F, A), rampMat);
      // The ramp is opaque at the top of its canvas, i.e. v=1, i.e. the
      // strip's local +y, which is the frame side once rotated with the bar.
      strip.rotation.z = b.rot;
      const inward = new THREE.Vector2(0, -1).rotateAround(new THREE.Vector2(), b.rot);
      strip.position.set(b.x + inward.x * (F / 2 + A / 2), b.y + inward.y * (F / 2 + A / 2), 0.15);
      strip.renderOrder = 1;
      content.add(strip);
    });

    // --- light + camera fitted to this size
    const L = Math.max(W, H) * 2;
    // Horizontally toward the top-left corner, 45° up, so a column's shadow
    // reaches about its own height away from it.
    const toCorner = new THREE.Vector2(-W, H).normalize();
    sun.position.set(toCorner.x * L, toCorner.y * L, L);
    sun.target.position.set(0, 0, 0);
    const sc = sun.shadow.camera;
    const half = Math.hypot(W, H) / 2 + 50;
    sc.left = -half;
    sc.right = half;
    sc.top = half;
    sc.bottom = -half;
    sc.near = 1;
    sc.far = L * 3;
    sc.updateProjectionMatrix();

    camera.aspect = W / H;
    camera.position.set(0, 0, H / 2 / Math.tan(THREE.MathUtils.degToRad(FOV / 2)));
    // Near enough for the expanded QR card, which comes most of the way to
    // the camera (qrCard.zoomCodeCover).
    camera.near = camera.position.z * 0.15;
    camera.far = camera.position.z * 2;
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
  }

  let frameRequested = false;
  function requestRender() {
    if (frameRequested) return;
    frameRequested = true;
    requestAnimationFrame(() => {
      frameRequested = false;
      renderer.render(scene, camera);
    });
  }

  function resize() {
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (!w || !h || (w === size.w && h === size.h)) return;
    size = { w, h };
    prevAngles = dials.map((d) => d.group.rotation.z);
    // The board is always 16:9, fitted inside the viewport (see header). The
    // canvas itself is the board's size, centred, so nothing behind the board
    // (the mode wheel reaches well past its edge) can show in the margins.
    const bw = Math.min(w, (h * 16) / 9);
    const bh = (bw * 9) / 16;
    renderer.setSize(bw, bh);
    boardSize = { w: bw, h: bh };
    renderer.domElement.style.margin = `${(h - bh) / 2}px auto 0`;
    build(bw, bh);
    renderRoster(true);
    requestRender();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(container);
  resize();

  // --- turning (test trigger only, see the header)
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  function dialAt(ev) {
    const r = renderer.domElement.getBoundingClientRect();
    ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    return dials.find((d) => raycaster.intersectObject(d.group, true).length > 0);
  }
  /**
   * Turning, 2026-10-05 (Luke): "50% faster", clicks that stack ("three
   * clicks on 2 moves to 5, but much faster than waiting for each rotation
   * to finish"), and "a stunted motion when the end is reached: ... a quick
   * quarter-turn and then back".
   *
   * Each dial keeps a target slot. A click moves the target one step and
   * restarts the tween from wherever the dial is right now to the new
   * target, over TURN_DURATION whatever the distance, so quick clicks cover
   * more ground in the same time. A tween that starts while the dial is
   * already moving eases OUT only: smoothstep would start from rest and
   * visibly stall mid-spin.
   *
   * A click past either end doesn't move the target. The dial nudges a
   * quarter of a step that way and springs back (BUMP_DURATION), so it
   * reads as hitting a stop. The window's wheel turns with it, being
   * synced to the dial.
   */
  function turn(dial, direction) {
    const stepRad = (dial.step * Math.PI) / 180;
    if (dial.target == null) dial.target = Math.round(-dial.group.rotation.z / stepRad);
    const next = dial.target - direction; // rotation.z is anticlockwise-positive; clockwise = next slot
    if (dial.slotCount && (next < 0 || next >= dial.slotCount)) {
      if (!dial.turning) bump(dial, direction * stepRad * 0.25);
      return;
    }
    dial.target = next;
    if (dial.setting) settingsDialMoved(false);
    const from = dial.group.rotation.z;
    const to = -next * stepRad;
    const moving = dial.turning;
    const start = performance.now();
    const id = (dial.animId = (dial.animId ?? 0) + 1);
    dial.turning = true;
    const frame = (now) => {
      if (dial.animId !== id) return; // superseded by a newer click
      const t = Math.min(1, (now - start) / (TURN_DURATION * 1000));
      const e = moving ? 1 - (1 - t) ** 3 : t * t * (3 - 2 * t);
      setAngle(dial, from + (to - from) * e);
      if (t < 1) requestAnimationFrame(frame);
      else {
        dial.turning = false;
        if (dial.setting) settingsDialMoved(true);
        if (dial.modes?.some(Boolean)) renderExtras();
      }
    };
    requestAnimationFrame(frame);
  }
  function bump(dial, amount) {
    const base = dial.group.rotation.z;
    const start = performance.now();
    const id = (dial.animId = (dial.animId ?? 0) + 1);
    dial.turning = true;
    const frame = (now) => {
      if (dial.animId !== id) return;
      const t = Math.min(1, (now - start) / (BUMP_DURATION * 1000));
      setAngle(dial, base + amount * Math.sin(Math.PI * t)); // out and back
      if (t < 1) requestAnimationFrame(frame);
      else dial.turning = false;
    };
    requestAnimationFrame(frame);
  }
  function setAngle(dial, a) {
    dial.group.rotation.z = a;
    if (dial.wheel) dial.wheel.rotation.z = a;
    renderer.render(scene, camera);
  }
  function buttonAt(ev) {
    const r = renderer.domElement.getBoundingClientRect();
    ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    return buttons.find((b) => raycaster.intersectObject(b.group, true).length > 0);
  }
  // Down while held, up on release (anywhere, so dragging off it still lets
  // it come back up). A quick drop and a slightly slower spring back.
  function pressButton(b, down) {
    if (b.pressed === down) return;
    b.pressed = down;
    const from = b.group.position.z;
    const to = down ? b.pressedZ : 0;
    const dur = down ? 0.08 : 0.16;
    const start = performance.now();
    const id = (b.animId = (b.animId ?? 0) + 1);
    const frame = (now) => {
      if (b.animId !== id) return;
      const t = Math.min(1, (now - start) / (dur * 1000));
      b.group.position.z = from + (to - from) * (1 - (1 - t) ** 2);
      renderer.render(scene, camera);
      if (t < 1) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }
  const onPointerUp = (ev) => {
    for (const b of buttons) pressButton(b, false);
    if (drag) {
      const p = pointerOnBoard(ev);
      const box = p && rosterBoxAt(p.x, p.y);
      if (box) movePlayer(roster, settings, drag.id, box.key);
      drag = null;
      rosterChanged();
    }
  };
  const onPointerDown = (ev) => {
    // Expanded, the card is all there is: a click anywhere puts it back, and
    // does nothing else.
    if (qr.zoomTarget === 1) {
      zoomQr(false);
      renderer.domElement.style.cursor = '';
      return;
    }
    if (overQrCard(ev)) {
      hoverQr(false);
      zoomQr(true);
      renderer.domElement.style.cursor = 'zoom-out';
      return;
    }
    const button = buttonAt(ev);
    if (button) {
      pressButton(button, true);
      if (button.id === 'qr') {
        if (joinLink) {
          moveQr(qr.target === 0);
          hooks.onJoin?.();
        } else hooks.onJoinWithoutGame?.();
      }
      if (button.id === 'shuffle') {
        randomise(roster, settings);
        rosterChanged();
      }
      if (button.id === 'create') hooks.onCreate?.();
      if (button.id === 'start') hooks.onStart?.();
      return;
    }
    // While the card is up, it covers what's under it.
    if (qr.mesh?.visible) {
      const r = renderer.domElement.getBoundingClientRect();
      ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
      if (raycaster.intersectObject(qr.mesh).length) return;
    }
    const tag = tagAt(ev);
    if (tag) {
      const p = pointerOnBoard(ev);
      tag.glide = null;
      drag = { tag, id: tag.mesh.userData.playerId, off: new THREE.Vector2(tag.mesh.position.x - p.x, tag.mesh.position.y - p.y) };
      tag.mesh.position.z = tagRestZ + params.roster.tagLift * Math.min(boardSize.w / 1600, boardSize.h / 900);
      tag.mesh.castShadow = true;
      requestRender();
      return;
    }
    const dial = dialAt(ev);
    if (!dial) return;
    // Luke, 2026-10-04: "clicking on the right should do the standard action,
    // and the left should turn them the other way." The standard action
    // (what a plain click always did) is clockwise. Which half was clicked
    // is judged against the dial's own centre projected to the screen.
    const r = renderer.domElement.getBoundingClientRect();
    const c = dial.group.getWorldPosition(new THREE.Vector3()).project(camera);
    const centreX = r.left + ((c.x + 1) / 2) * r.width;
    turn(dial, ev.clientX >= centreX ? -1 : 1); // rotation.z is anticlockwise-positive
  };
  const onContextMenu = (ev) => {
    if (dialAt(ev)) ev.preventDefault();
  };
  const onPointerMove = (ev) => {
    if (drag) {
      const p = pointerOnBoard(ev);
      if (p) drag.tag.mesh.position.set(p.x + drag.off.x, p.y + drag.off.y, drag.tag.mesh.position.z);
      renderer.domElement.style.cursor = 'grabbing';
      requestRender();
      return;
    }
    if (qr.zoomTarget === 1) {
      renderer.domElement.style.cursor = 'zoom-out';
      return;
    }
    const onCard = overQrCard(ev);
    hoverQr(onCard);
    renderer.domElement.style.cursor = onCard ? 'zoom-in' : tagAt(ev) ? 'grab' : dialAt(ev) || buttonAt(ev) ? 'pointer' : '';
  };
  renderer.domElement.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointerup', onPointerUp);
  // Debug only: hold a button down (true) or let it up (false).
  window.__lobbyButton = (id, down) => pressButton(buttons.find((b) => b.id === id), down);
  // Debug only: the expanded pose (z 0 on the board, 1 expanded) and the
  // hover waves (at time t ms), without animating.
  window.__lobbyQrZoom = (z, waves = false, t = 0) => {
    qr.zoom = qr.zoomTarget = z;
    qr.waveAmp = waves ? 1 : 0;
    poseWaves(t);
    poseQr(qr.p);
  };
  // Debug only: pose the QR card at progress p (0 hidden, 1 in place), and
  // render a frame to a data URL, for checking it without a visible pane
  // (POST the result to the dev server's /__shot to save it).
  window.__lobbyQr = (p) => {
    qr.p = qr.target = p;
    poseQr(p);
  };
  // Debug only: the lobby as it stands.
  window.__lobbyRoster = () => ({
    settings,
    grid: layout?.boxes[0]?.grid,
    teams: roster.teams.map((t) => t.map((id) => roster.names.get(id))),
    unassigned: roster.unassigned.map((id) => roster.names.get(id)),
    away: [...awayTimers.keys()].map((id) => roster.names.get(id)),
  });
  window.__lobbyCapture = () => {
    renderer.render(scene, camera);
    return renderer.domElement.toDataURL('image/png');
  };
  // Debug only, like dialProto's window.__dialState: the dial face has no
  // marking, so a turn is hard to confirm by eye.
  window.__lobbyDials = () => dials.map((d) => ({ deg: (d.group.rotation.z * 180) / Math.PI, turning: d.turning }));
  // Debug only: park dial i at an angle, e.g. mid-turn, to inspect the wheel.
  window.__lobbyDialSet = (i, deg) => {
    const d = dials[i];
    d.target = null; // re-derived from the angle on the next click
    d.group.rotation.z = (deg * Math.PI) / 180;
    if (d.wheel) d.wheel.rotation.z = d.group.rotation.z;
    renderExtras();
    requestRender();
  };
  renderer.domElement.addEventListener('contextmenu', onContextMenu);
  renderer.domElement.addEventListener('pointermove', onPointerMove);

  const api = {
    /**
     * Adds a player to the lobby (dev button for now; real arrivals later).
     * A real arrival MUST pass the colour the player picked (the same
     * colorHex the game uses for their name tag), so their name looks the
     * same here as in the game. Only the dev button relies on the random default.
     */
    /**
     * DEV: adds a made-up player (not a real device), with a random colour.
     * Returns its id, or null if the game is full. Dev players are never
     * greyed out by presence, since they have none.
     */
    addPlayer(rawName, colourHex = PLAYER_COLOURS[Math.floor(Math.random() * PLAYER_COLOURS.length)]) {
      const id = `dev_${nextPlayerId++}`;
      if (!admit(id, rawName, colourHex)) return null;
      rosterChanged();
      return id;
    },
    /**
     * The players actually connected right now ({ token, displayName }, from
     * presence). Newcomers are added; anyone missing is greyed out (and
     * removed if they don't come back); anyone back is un-greyed. Returns the
     * tokens turned away because the game is full, for the page to tell them.
     * Every newcomer shows in the default colour until they pick one.
     */
    syncPlayers(players) {
      const present = new Set();
      const turnedAway = [];
      let changed = false;
      for (const p of players) {
        present.add(p.token);
        if (roster.names.has(p.token)) {
          if (awayTimers.has(p.token)) setAway(p.token, false);
          continue;
        }
        if (admit(p.token, p.displayName, p.colorHex ?? DEFAULT_PLAYER_COLOUR)) changed = true;
        else turnedAway.push(p.token);
      }
      for (const id of roster.names.keys()) if (!present.has(id) && !isDevPlayer(id)) setAway(id, true);
      if (changed) rosterChanged();
      return turnedAway;
    },
    /** A new game: forget every player and the saved placements. */
    setGame(code, link) {
      for (const id of [...roster.names.keys()]) dropPlayer(id);
      savedPlacement = new Map();
      gameCode = code;
      joinLink = link;
      if (link) loadQrCard(link);
      else {
        qr.mat.visible = false;
        moveQr(false);
      }
      renderExtras();
      requestRender();
    },
    /** Teams as they stand, for Start: settings, teams (arrays of ids), unassigned, names. */
    getTeams() {
      return {
        settings: { ...settings },
        teams: roster.teams.map((t) => [...t]),
        unassigned: [...roster.unassigned],
        names: new Map(roster.names),
        mode: currentMode(),
        playable: PLAYABLE_MODES.has(currentMode()),
      };
    },
    /** Restores dials and placements saved by onRosterChange, after a reload. */
    importState(state) {
      if (!state?.settings) return;
      settings = { ...settings, ...state.settings };
      applySettings(roster, settings);
      savedPlacement = new Map(Object.entries(state.placement ?? {}));
      for (const d of dials) {
        if (!d.setting) continue;
        const idx = d.values.indexOf(settings[d.setting]);
        if (idx < 0) continue;
        d.target = idx;
        setAngle(d, (-idx * d.step * Math.PI) / 180);
      }
      renderRoster(true);
    },
    dispose() {
      clearTimeout(settleTimer);
      for (const t of awayTimers.values()) clearTimeout(t);
      ro.disconnect();
      delete window.__lobbyDials;
      delete window.__lobbyDialSet;
      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointerup', onPointerUp);
      delete window.__lobbyButton;
      delete window.__lobbyQr;
      delete window.__lobbyQrZoom;
      delete window.__lobbyCapture;
      delete window.__lobbyRoster;
      delete window.__lobbyAdd;
      delete window.__lobbySettings;
      renderer.domElement.removeEventListener('contextmenu', onContextMenu);
      renderer.domElement.removeEventListener('pointermove', onPointerMove);
      disposeContent();
      qr.mat.map?.dispose();
      qr.mat.dispose();
      for (const m of qr.waveMats) m.dispose();
      for (const m of slotMats.values()) {
        m.map?.dispose();
        m.dispose();
      }
      for (const m of [cardMat, cutEdgeMat, cavityMat, cutWallMat, fluteMat, overcutMat, origDialMat, origWindowMat, columnMat, rampMat, ...woodMats]) {
        if (m.map && m.map !== cardTex) m.map.dispose();
        m.dispose();
      }
      cardTex.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
  // Debug only: add a player with a given name (the dev button picks at random).
  window.__lobbyAdd = (name) => api.addPlayer(name);
  // Debug only: apply dial settings at once and lay out without gliding, for
  // checking layouts when the page can't animate (a hidden preview pane).
  window.__lobbySettings = (st) => {
    settings = { ...settings, ...st };
    applySettings(roster, settings);
    renderRoster(true);
    hooks.onRosterChange?.(exportState());
  };
  return api;
}
