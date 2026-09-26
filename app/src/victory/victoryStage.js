/**
 * The team victory screen, rebuilt as a real 3D scene — Luke, 2026-09-25:
 * "this is a significant feature addition, and will require a new scene."
 * Replaces the flat DOM/CSS `VictoryScreen.jsx` outright (his own words:
 * "yes it replaces what you built"). A deliberately separate module from
 * skyPath.js/lavaCavern.js, same reasoning both of those already give for
 * being separate from each other: nothing here shares gameplay state, and
 * keeping it apart means iterating on the stage's own look can't put a
 * working game at risk.
 *
 * Luke's own art, from his own Blender scene, loaded the same "no rescale,
 * trust the export" way `rim.glb` was — `space-hemisphere.glb` (the
 * background — a hemisphere the camera always looks toward the centre of,
 * so its rim is never in frame, same reasoning as the cavern's own sky
 * dome), `victory-base.glb` (one team's flat cardboard platform — "each
 * team gets their own flat cardboard base which is in fact raised as part
 * of a longer piece of cardboard with two folding axes," but that folding
 * rig is explicitly future work: "I haven't told you yet... how the
 * three-part folding will work" — this mounts exactly one, already-flat
 * base), and `victory-pedestal.glb` (one per player, "a cylindrical
 * pedestal that rises from that base" to show their score).
 *
 * The pedestal's own pivot was originally at its TOP, not its base — the
 * same class of bug the rim.glb vertical-scale attempt hit (scaling a node
 * moves its own translation, not just its geometry, so scaling from the
 * wrong pivot moves the wrong end). Luke re-exported it with the pivot at
 * the base instead ("I think I've fixed it"), confirmed directly by reading
 * the glTF: the node now carries no translation at all, and the mesh's own
 * local geometry runs from y=0 up to y≈2.01 — so `scale.y` alone now grows
 * it upward from a fixed floor, no compensating transform math needed.
 *
 * Scoring itself is untouched — `../lobby/scoring.js` is still the one
 * place that turns a round's raw facts into points (per skyPath.js's own
 * "a game mode never accumulates or reads a running total itself" rule),
 * shared by this and useLobby.js alike.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { attachBgTuner } from '../skypath/bgTuner.js';
import { buildNameTagCanvas } from '../skypath/nameTag.js';
import { scoreBreakdown, totalScore, roundToNearestHalf } from '../lobby/scoring.js';

export const VICTORY_CHROME = `
<div id="victorySectionLabel" style="position: absolute; top: 20px; left: 50%; transform: translateX(-50%); z-index: 10; pointer-events: none;"></div>
<div id="victoryHeading" style="display: none;">Round complete!</div>
<div id="victoryWaiting">Waiting for your teacher to start the next round…</div>
<button id="victoryReplay" title="Replay the score reveal">↻ Replay</button>
<button id="victoryBack">Back to lobby</button>
`;

export const VICTORY_CSS = `
.victory-surface {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: #000;
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
.victory-surface canvas { display: block; }
.victory-surface #victoryHeading {
  position: absolute;
  top: calc(env(safe-area-inset-top, 0px) + 16px);
  left: 0;
  right: 0;
  text-align: center;
  font: 700 28px/1.2 system-ui, sans-serif;
  color: #fff;
  text-shadow: 0 2px 8px rgba(0, 0, 0, 0.6);
  pointer-events: none;
}
.victory-surface #victoryWaiting {
  position: absolute;
  bottom: calc(env(safe-area-inset-bottom, 0px) + 64px);
  left: 0;
  right: 0;
  text-align: center;
  font: 600 14px/1.4 system-ui, sans-serif;
  color: #fff;
  text-shadow: 0 1px 4px rgba(0, 0, 0, 0.6);
  pointer-events: none;
}
.victory-surface #victoryBack {
  position: absolute;
  bottom: calc(env(safe-area-inset-bottom, 0px) + 16px);
  left: 50%;
  transform: translateX(-50%);
  padding: 10px 22px;
  border: 0;
  border-radius: 8px;
  font: 600 14px system-ui, sans-serif;
  background: #ffcf8a;
  color: #2a0f06;
  box-shadow: 0 3px 10px rgba(0, 0, 0, 0.4);
}
.victory-surface #victoryReplay {
  position: absolute;
  top: calc(env(safe-area-inset-top, 0px) + 16px);
  left: 16px;
  padding: 8px 16px;
  border: 0;
  border-radius: 8px;
  font: 600 13px system-ui, sans-serif;
  background: rgba(255, 255, 255, 0.9);
  color: #2a0f06;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
}
`;

// Copied from skyPath.js's own ROSTER, not imported — that file doesn't
// export it, and the project's own precedent for this (alienTargetPickerProto.js)
// is a small local copy rather than a shared module for one table.
const ROSTER = [
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
function avatarSrcFor(key) {
  const entry = ROSTER.find((c) => c.key === key);
  return entry ? `textures/${entry.tex}.${entry.ext}` : null;
}
const FIGURE_ASPECT = 0.71; // every ROSTER texture shares this aspect — measured directly during the cavern-sky work

function hexColor(colorHex) {
  return typeof colorHex === 'number' ? `#${colorHex.toString(16).padStart(6, '0')}` : colorHex ?? '#ffe9b8';
}

// Luke: "islands reached, then items collected..., then retaining a
// jetpack, then resisting abduction" — one pedestal per player, rising in
// these four stages in order, 2s between each; "the first section...
// should involve gradually rising over 2s, starting faster and then
// slowing towards the end" (an ease-out curve); "the other sections should
// take 1s to rise." Luke, 2026-09-26: "add a further 3s delay at the start,
// before any scores begin." Driven per-frame from elapsed time, not CSS/React
// timers — there's no DOM transition engine to lean on here.
const STAGES = [
  { key: null, duration: 3000, gapAfter: 0 }, // Initial 3s delay, no score change
  { key: 'islands', duration: 3000, gapAfter: 2000 },
  { key: 'items', duration: 2000, gapAfter: 2000 },
  { key: 'jetpackBonus', duration: 2000, gapAfter: 2000 },
  { key: 'resists', duration: 2000, gapAfter: 0 },
];
function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

/** Find which stage we're in and elapsed time within that stage. */
function getCurrentStageInfo(elapsedMs) {
  let acc = 0;
  for (let i = 0; i < STAGES.length; i++) {
    const s = STAGES[i];
    const nextAcc = acc + s.duration + s.gapAfter;
    if (elapsedMs >= acc && elapsedMs < nextAcc) {
      const elapsedInStage = Math.min(elapsedMs - acc, s.duration);
      return { stageIndex: i, elapsedInStage };
    }
    acc = nextAcc;
  }
  // After all stages, stay at the last stage's final value
  const lastIdx = STAGES.length - 1;
  return { stageIndex: lastIdx, elapsedInStage: STAGES[lastIdx].duration };
}

/** Score value for a specific stage. Animates the value added in that stage, from previous total to new total. */
function scoreValueInStage(breakdown, stageIndex, elapsedInStage) {
  // Sum all values from previous stages (1 through stageIndex-1)
  let accumulatedValue = 0;
  for (let i = 1; i < stageIndex; i++) {
    const stage = STAGES[i];
    if (stage.key && breakdown[stage.key] !== undefined) {
      accumulatedValue += breakdown[stage.key];
    }
  }

  // Animate this stage's value
  const currentStage = STAGES[stageIndex];
  if (!currentStage.key || breakdown[currentStage.key] === undefined) {
    return accumulatedValue; // No animation for delay stage
  }

  const t = Math.min(1, elapsedInStage / currentStage.duration);
  const stageValue = breakdown[currentStage.key] * easeOutCubic(t);
  return accumulatedValue + stageValue;
}

/** Get the final accumulated value up to and including a stage. */
function accumulatedValueThroughStage(breakdown, stageIndex) {
  let total = 0;
  for (let i = 1; i <= stageIndex; i++) {
    const stage = STAGES[i];
    if (stage.key && breakdown[stage.key] !== undefined) {
      total += breakdown[stage.key];
    }
  }
  return total;
}

/** How much of `breakdown` has "risen" at `elapsedMs` into the reveal — a single continuous function of time, so every pedestal reads the exact same instant regardless of frame timing. */
function valueAt(breakdown, elapsedMs) {
  const { stageIndex, elapsedInStage } = getCurrentStageInfo(elapsedMs);
  return scoreValueInStage(breakdown, stageIndex, elapsedInStage);
}

/** Stage label names, in order of STAGES (after the initial delay). */
const STAGE_LABELS = ['Islands Reached', 'Items Collected', 'Jetpack On', 'Aliens Evaded'];

/** Return the current stage name being animated, or '' before the first stage or after the last. Labels persist through gaps until replaced by the next label. */
function stageNameAt(elapsedMs) {
  let acc = 0;
  for (let i = 0; i < STAGES.length; i++) {
    const s = STAGES[i];
    const nextAcc = acc + s.duration + s.gapAfter;
    if (elapsedMs >= acc && elapsedMs < nextAcc) {
      // We're in this stage or its gap following it — show label for real stages
      return i > 0 ? STAGE_LABELS[i - 1] : '';
    }
    acc = nextAcc;
  }
  // After all stages complete, the last label persists (always STAGE_LABELS[3])
  return STAGE_LABELS[STAGE_LABELS.length - 1];
}

/** Build a canvas for a score number, using the chosen font and color. */
function buildScoreCanvas(score, fontChoice, colorHex) {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d');
  // Use Orbitron as the primary font; Sue Ellen Francisco as fallback serif
  const fontFamily = fontChoice === 0 ? "'Orbitron', sans-serif" : "'Sue Ellen Francisco', cursive, sans-serif";
  const fontSize = 280;
  ctx.font = `bold ${fontSize}px ${fontFamily}`;
  ctx.fillStyle = hexColor(colorHex); // Luke, 2026-09-26: color matches player's chosen color
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // Draw a thin stroke first for better visibility
  ctx.strokeStyle = 'rgba(0,0,0,0.3)';
  ctx.lineWidth = 8;
  ctx.strokeText(String(score), 256, 256);
  ctx.fillText(String(score), 256, 256);
  return canvas;
}

/** Build a canvas for a section label. */
function buildSectionLabelCanvas(label) {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  ctx.font = "bold 48px 'Orbitron'";
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, 256, 64);
  return canvas;
}

export function mountVictoryStage(container, options = {}) {
  const {
    round,
    roundResultsByToken = {},
    getDisplayName = () => null,
    getCharacter = () => ({ characterKey: null, colorHex: null }),
    onBackToLobby = () => {},
  } = options;
  const { roster, guideToken } = round;

  // Maximum 6 total players (5 regular + 1 guide)
  if (roster.length > 5) {
    console.warn(`Victory stage: roster has ${roster.length} players, exceeds maximum of 5 (plus guide). Capping at 5.`);
    roster.length = 5;
  }

  // Ensure both score fonts are loaded before rendering
  document.fonts?.load("bold 120px 'Orbitron'");
  document.fonts?.load("bold 120px 'Sue Ellen Francisco'");

  container.classList.add('victory-surface');
  container.innerHTML = VICTORY_CHROME;
  if (!document.getElementById('victory-css')) {
    const style = document.createElement('style');
    style.id = 'victory-css';
    style.textContent = VICTORY_CSS;
    document.head.appendChild(style);
  }
  container.querySelector('#victoryBack')?.addEventListener('click', onBackToLobby);

  let disposed = false;
  let rafId = null;
  const surfaceWidth = () => container.clientWidth || window.innerWidth;
  const surfaceHeight = () => container.clientHeight || window.innerHeight;

  // ---------------------------------------------------------------- tuning
  //
  // Exact spacing/scale is a "look at it and adjust" question, not something
  // derivable from the models alone — per CLAUDE.md, tuned live in the game
  // rather than guessed at and hardcoded. Bake into these defaults once
  // Luke settles on values.
  const TUNE = {
    // Luke, 2026-09-25, after seeing the first pass: "increase the depth
    // offset significantly, and move the pedestals closer together
    // laterally" — the base itself was also turned 90° (see baseGroup's own
    // rotation below), so these two now track its new long (depth) / short
    // (lateral) axes instead of the old wide/shallow orientation.
    seatSpacingX: 0.28, // metres between adjacent seats' centres, left-to-right
    // Luke, 2026-09-25, on seeing the back row: "you've now moved the back
    // row much too far back... reduce the distance between their depth and
    // the front row's depth to 40% of what it is now" — 0.85 Γ— 0.4.
    seatDepthStagger: 0.34, // Luke: "if more than two, alternate front and back" — half this either side of centre
    worldUnitsPerPoint: 0.09, // pedestal world-height per point of score
    hemisphereScale: 1, // multiplies the hemisphere's own baked scale
    // The export's own baked rotation faces its dome along a horizontal axis
    // that doesn't match this scene's camera (which has to look along -Z, so
    // the seat row reads left-to-right) — confirmed live: half the view
    // showed the dome, the other half showed nothing (the hemisphere's open
    // flat side). This yaws the whole hemisphere on top of its own baked
    // rotation until the dome actually faces the camera; a slider rather
    // than a hunted-down constant, since the "right" value depends on this
    // exact export and would need re-deriving if it's ever swapped.
    hemisphereYaw: Math.PI / 2,
    // Luke, 2026-09-25: values he read off the live tuner himself and asked
    // to be made the defaults ("don't remove the cam values from the slider
    // yet, as we may need to adjust them once other things change").
    camDistance: 1.9,
    camHeight: 1.3,
    camLookHeight: 0.35,
    scoreFont: 1, // Sue Ellen Francisco (cursive handwriting)
    sectionLabelY: 1.1, // Vertical position of section label (above baseTopY)
    scoreFinishOffset: 1.1, // Seconds before pedestal finishes rising that score finishes animating (per-section)
  };

  // ---------------------------------------------------------------- renderer / scene
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(surfaceWidth(), surfaceHeight());
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, surfaceWidth() / surfaceHeight(), 0.05, 500);

  const onResize = () => {
    camera.aspect = surfaceWidth() / surfaceHeight();
    camera.updateProjectionMatrix();
    renderer.setSize(surfaceWidth(), surfaceHeight());
  };
  window.addEventListener('resize', onResize);

  const gltfLoader = new GLTFLoader();

  // ---------------------------------------------------------------- hemisphere
  //
  // Same reasoning as the Lava Cavern's own sky dome: a big unlit sphere the
  // camera always looks toward the centre of, so no matter where the camera
  // sits, its rim never enters frame. Already double-sided in Luke's own
  // export (`doubleSided` on its material), so — unlike the cavern dome,
  // which needed an explicit BackSide override — this needs no side change,
  // just the usual unlit conversion (CLAUDE.md: "everything renders unlit").
  gltfLoader.load('models/space-hemisphere.glb', (gltf) => {
    gltf.scene.traverse((o) => {
      if (!o.isMesh) return;
      const old = o.material;
      o.material = new THREE.MeshBasicMaterial({ map: old.map, side: THREE.DoubleSide, fog: false });
      old.dispose();
    });
    hemisphereGroup.add(gltf.scene);
  });
  const hemisphereGroup = new THREE.Group();
  scene.add(hemisphereGroup);

  // ---------------------------------------------------------------- base
  let baseTopY = 0; // measured once loaded — where a pedestal's own bottom should sit
  const baseGroup = new THREE.Group();
  // Luke, 2026-09-26: swapped to victory-base-small.glb, which has its long
  // axis in Z (depth) and short axis in X (lateral) straight from export.
  // Need to rotate 90° to swap: Z→X (long axis becomes lateral width) and
  // X→Z (short axis becomes the reduced depth). This reduces the front-to-back
  // area while keeping lateral width full, and rotates the grain to run
  // left-to-right instead of front-to-back.
  baseGroup.rotation.y = Math.PI / 2;
  scene.add(baseGroup);
  gltfLoader.load('models/victory-base-small.glb', (gltf) => {
    gltf.scene.traverse((o) => {
      if (!o.isMesh) return;
      const old = o.material;
      o.material = new THREE.MeshBasicMaterial({ map: old.map, color: old.color, fog: false });
      old.dispose();
    });
    baseGroup.add(gltf.scene);
    const box = new THREE.Box3().setFromObject(gltf.scene);
    baseTopY = box.max.y; // read every frame by updateSeatLayout() below — no separate fix-up needed once this resolves
  });

  // ---------------------------------------------------------------- section label
  //
  // Luke, 2026-09-26: "Make it act as a 3D object in line with the names of
  // the back player(s) but above them. Make it 50% larger than a player's name."
  let lastSectionLabel = '';
  let sectionLabelMesh = null;

  // ---------------------------------------------------------------- pedestals + players
  //
  // Positions: "positions should be even and uniform. Clean" (Luke, after
  // being shown island seating's own "five fixed slots" precedent and
  // saying not to read exact coordinates off his rough sketch) — every seat
  // (players AND the guide, appended last so it always lands rightmost, per
  // "guide position scales with team size") evenly spaced and centred, with
  // alternating front/back depth exactly like island seating alternates
  // name-tag side, just on the Z axis instead of Y.
  const seatTokens = [...roster, guideToken];
  const seats = seatTokens.map((token, i) => ({
    token,
    isGuide: token === guideToken,
    breakdown: token === guideToken ? null : scoreBreakdown(roundResultsByToken[token]), // guide's is computed below, once every player's is known
    pedestalRoot: new THREE.Group(), // sits at the base's own top surface; pedestal mesh + avatar + name tag all hang off this
    pedestal: null, // the cloned "Top" node itself — set once the template loads
    pedestalHeightPerUnitScale: 1,
    avatar: null,
    nameTagMesh: null,
    ringBottom: null,
    ringTop: null,
    colorHex: null,
    scoreMesh: null, // score number display, updated each frame
    lastScoreInt: -1, // cache to avoid rebuilding canvas every frame
  }));
  for (const seat of seats) scene.add(seat.pedestalRoot); // positioned every frame in updateSeatLayout() below — see its own comment for why

  // Guide "receives the average of their team's scores" — calculated per-category
  // and divided by player count (excluding guide). Updates per-section like other players.
  // Running total is exact (unrounded); only display is rounded.
  let guideBreakdown = { islands: 0, items: 0, jetpackBonus: 0, resists: 0 };
  if (roster.length > 0) {
    const breakdowns = roster.map((tok) => scoreBreakdown(roundResultsByToken[tok]));
    guideBreakdown.islands = breakdowns.reduce((sum, bd) => sum + (bd.islands ?? 0), 0) / roster.length;
    guideBreakdown.items = breakdowns.reduce((sum, bd) => sum + (bd.items ?? 0), 0) / roster.length;
    guideBreakdown.jetpackBonus = breakdowns.reduce((sum, bd) => sum + (bd.jetpackBonus ?? 0), 0) / roster.length;
    guideBreakdown.resists = breakdowns.reduce((sum, bd) => sum + (bd.resists ?? 0), 0) / roster.length;
  }
  for (const seat of seats) {
    if (seat.isGuide) seat.breakdown = guideBreakdown;
  }

  gltfLoader.load('models/victory-pedestal.glb', (gltf) => {
    gltf.scene.traverse((o) => {
      if (!o.isMesh) return;
      const old = o.material;
      o.material = new THREE.MeshBasicMaterial({ map: old.map, color: old.color, fog: false });
      old.dispose();
    });
    // The export's own baked scale lives on `templateNode` (the "Top" mesh
    // node), not on `gltf.scene` itself (a plain wrapper with no scale of
    // its own) — cloning and scaling the WRAPPER, as a first pass here did,
    // would have compounded on top of that baked scale rather than
    // replacing it. Cloning `templateNode` directly and driving its own
    // scale.y avoids the wrapper entirely; X/Z stay at their baked value,
    // untouched, for the whole life of the pedestal.
    const templateNode = gltf.scene.children[0];
    const bakedScaleY = templateNode.scale.y || 1;
    const box = new THREE.Box3().setFromObject(gltf.scene); // world-space height AT the baked scale
    const worldHeightAtBakedScale = box.max.y - box.min.y || 1;
    // "World height per unit of scale.y" — a fixed conversion factor, so
    // updateSeats() can go straight from a desired world height to the
    // scale.y that produces it, independent of whatever the export's own
    // baked scale happens to be.
    const heightPerUnitScale = worldHeightAtBakedScale / bakedScaleY;
    // A thin flat ring at the pedestal's own circular footprint radius —
    // shared geometry, one instance per seat per end (bottom + top), see
    // updateSeats() for how the top one tracks the rising height and how
    // the colour toggle is applied.
    const footprintRadius = (box.max.x - box.min.x) / 2 || 0.1;
    const ringGeom = new THREE.RingGeometry(footprintRadius - 0.006, footprintRadius + 0.006, 48);

    for (const seat of seats) {
      const node = templateNode.clone();
      node.scale.y = 0.001; // starts essentially flat — the reveal grows it from here
      seat.pedestal = node;
      seat.pedestalHeightPerUnitScale = heightPerUnitScale;
      seat.pedestalRoot.add(node);

      const ringMat = () => new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, fog: false });
      seat.ringBottom = new THREE.Mesh(ringGeom, ringMat());
      seat.ringBottom.rotation.x = -Math.PI / 2;
      seat.ringBottom.position.y = 0.001; // a hair above the base surface — avoids z-fighting with it
      seat.pedestalRoot.add(seat.ringBottom);
      seat.ringTop = new THREE.Mesh(ringGeom, ringMat());
      seat.ringTop.rotation.x = -Math.PI / 2;
      seat.pedestalRoot.add(seat.ringTop);
    }
  });

  // Avatar plus a real cardboard name tag (buildNameTagCanvas, nameTag.js —
  // the same renderer the in-game tags use, not a lookalike) above whichever
  // of the two sits higher. The guide gets one too now — Luke, 2026-09-25:
  // "the guide chooses an avatar... It should be displayed on this screen."
  // That choice is real (character-select runs for every role), just never
  // broadcast as an ordinary player-state ping — see skyPath.js's own
  // `finishCharacterSelect` comment for why THAT would have reintroduced a
  // real, already-fixed bug (a phantom guide rig on a live player's own
  // screen). Its `characterKey`/`colorHex` instead ride a dedicated
  // 'guide-character' event straight into the same session-wide table
  // `getCharacter` already reads for everyone else.
  for (const seat of seats) {
    const char = getCharacter(seat.token);
    const name = getDisplayName(seat.token) ?? (seat.isGuide ? 'Guide' : 'Player');
    seat.colorHex = char.colorHex;

    if (char.characterKey) {
      const src = avatarSrcFor(char.characterKey);
      if (src) {
        const height = 0.22;
        const tex = new THREE.TextureLoader().load(src, (t) => {
          t.colorSpace = THREE.SRGBColorSpace;
        });
        const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, alphaTest: 0.45, side: THREE.DoubleSide, fog: false });
        const avatar = new THREE.Mesh(new THREE.PlaneGeometry(height * FIGURE_ASPECT, height), mat);
        seat.avatar = avatar;
        seat.pedestalRoot.add(avatar);
      }
    }

    buildNameTagCanvas(name, { glowColor: hexColor(char.colorHex) }).then(({ canvas, aspect }) => {
      if (disposed) return;
      const tagHeight = 0.09;
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide, fog: false });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(tagHeight / aspect, tagHeight), mat);
      seat.nameTagMesh = mesh;
      seat.pedestalRoot.add(mesh);
    });
  }

  /**
   * Every seat's X/Z, recomputed every frame from TUNE — Luke, 2026-09-25,
   * after `seatSpacingX`/`seatDepthStagger` visibly did nothing: "I can't
   * see any change at all when I change their values." Real bug: this used
   * to run ONCE, synchronously, right after `seats` was built — the sliders
   * wrote into `TUNE` just fine, nothing ever read it again afterward. Every
   * other tunable (camera, hemisphere) already gets re-read like this each
   * frame; this just brings seat layout in line with that same pattern.
   */
  function updateSeatLayout() {
    const n = seats.length;
    seats.forEach((seat, i) => {
      const x = (i - (n - 1) / 2) * TUNE.seatSpacingX;
      const z = i % 2 === 0 ? TUNE.seatDepthStagger / 2 : -TUNE.seatDepthStagger / 2;
      seat.pedestalRoot.position.set(x, baseTopY, z);
    });
  }

  // ---------------------------------------------------------------- animation
  //
  const clock = new THREE.Clock();
  let startTime = clock.getElapsedTime();
  container.querySelector('#victoryReplay')?.addEventListener('click', () => {
    startTime = clock.getElapsedTime(); // just moves the zero point — updateSeats() re-reads it every frame, so the reveal replays from scratch with no extra state
  });

  const ringColorScratch = new THREE.Color(); // reused every frame/seat — avoid allocating a THREE.Color per ring per frame

  function updateSeats() {
    const elapsedMs = (clock.getElapsedTime() - startTime) * 1000;
    for (const seat of seats) {
      const value = valueAt(seat.breakdown, elapsedMs);
      const worldHeight = Math.max(0.002, value * TUNE.worldUnitsPerPoint);
      if (seat.pedestal) seat.pedestal.scale.y = worldHeight / (seat.pedestalHeightPerUnitScale || 1);
      if (seat.avatar) seat.avatar.position.y = worldHeight + (seat.avatar.geometry.parameters.height / 2);
      if (seat.nameTagMesh) {
        const avatarTop = seat.avatar ? worldHeight + seat.avatar.geometry.parameters.height : worldHeight;
        seat.nameTagMesh.position.y = avatarTop + seat.nameTagMesh.geometry.parameters.height / 2 + 0.02;
      }
      // Two rings per pedestal, base and top — Luke, 2026-09-25: "add a
      // border line around both the base of each pedestal and the top...
      // a toggle: 0 = player colour both rings; 1 = player colour top, black base
      // (only when pedestal rises)." The bottom ring never moves; the top one
      // tracks the rising height exactly like the avatar/name tag above.
      if (seat.ringTop) seat.ringTop.position.y = worldHeight + 0.001;
      if (seat.ringBottom && seat.ringTop) {
        // Top ring always uses player color
        ringColorScratch.set(hexColor(seat.colorHex));
        seat.ringTop.material.color.copy(ringColorScratch);
        // Bottom ring: player color by default, black when pedestal rises
        if (worldHeight > 0.002) {
          ringColorScratch.set(0x000000); // Black when pedestal rises
        } else {
          ringColorScratch.set(hexColor(seat.colorHex)); // Player color
        }
        seat.ringBottom.material.color.copy(ringColorScratch);
      }
      // Score numbers: animated per-section. Within each section, the number finishes
      // updating (scoreFinishOffset) seconds before the pedestal finishes rising.
      const { stageIndex, elapsedInStage } = getCurrentStageInfo(elapsedMs);
      let displayValue = value;
      const stageFinishMs = (STAGES[stageIndex]?.duration ?? 0) - (TUNE.scoreFinishOffset * 1000);
      if (elapsedInStage >= stageFinishMs && seat.breakdown && stageIndex > 0) {
        // Lock to the accumulated value up to and including this stage
        displayValue = accumulatedValueThroughStage(seat.breakdown, stageIndex);
      }
      const scoreInt = Math.round(displayValue);
      if (scoreInt > 0 && scoreInt !== seat.lastScoreInt) {
        seat.lastScoreInt = scoreInt;
        if (seat.scoreMesh) seat.pedestalRoot.remove(seat.scoreMesh);
        const canvas = buildScoreCanvas(scoreInt, TUNE.scoreFont, seat.colorHex);
        const tex = new THREE.CanvasTexture(canvas);
        tex.colorSpace = THREE.SRGBColorSpace;
        const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide, fog: false });
        const scoreHeight = 0.25;
        const geo = new THREE.PlaneGeometry(scoreHeight * (canvas.width / canvas.height), scoreHeight);
        seat.scoreMesh = new THREE.Mesh(geo, mat);
        seat.pedestalRoot.add(seat.scoreMesh);
      }
      // Position score mesh proportionally: 50% at score 1, 75% at score 4+
      if (seat.scoreMesh) {
        let heightPercent = 0.50; // Start at 50% for score 1
        if (scoreInt > 1 && scoreInt < 4) {
          // Linear interpolation from 50% to 75% between scores 1 and 4
          heightPercent = 0.50 + (scoreInt - 1) * (0.75 - 0.50) / (4 - 1);
        } else if (scoreInt >= 4) {
          heightPercent = 0.75;
        }
        seat.scoreMesh.position.y = worldHeight * heightPercent;
        seat.scoreMesh.position.z = 0.15; // Forward, away from the pedestal
      }
    }
  }

  function updateCamera() {
    camera.position.set(0, baseTopY + TUNE.camHeight, TUNE.camDistance);
    camera.lookAt(0, baseTopY + TUNE.camLookHeight, 0);
    hemisphereGroup.scale.setScalar(TUNE.hemisphereScale);
    hemisphereGroup.rotation.y = TUNE.hemisphereYaw;
  }

  function updateSectionLabel() {
    const elapsedMs = (clock.getElapsedTime() - startTime) * 1000;
    const label = stageNameAt(elapsedMs);
    if (label !== lastSectionLabel) {
      lastSectionLabel = label;
      if (sectionLabelMesh) {
        scene.remove(sectionLabelMesh);
        sectionLabelMesh = null;
      }
      if (!label) {
        return;
      }
      // Luke, 2026-09-26: 3D mesh at top of screen, fixed position, 50% larger than name tags; Luke, 2026-09-26: reduced 30% per request
      buildNameTagCanvas(label, { glowColor: '#ccc' }).then(({ canvas, aspect }) => {
        if (disposed || stageNameAt((clock.getElapsedTime() - startTime) * 1000) !== label) return;
        const tagHeight = 0.09 * 1.5 * 1.5 * 0.7; // 50% larger than name tags, then 30% smaller
        const tex = new THREE.CanvasTexture(canvas);
        tex.colorSpace = THREE.SRGBColorSpace;
        const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide, fog: false });
        const mesh = new THREE.Mesh(new THREE.PlaneGeometry(tagHeight / aspect, tagHeight), mat);

        // Fixed position at top of screen, centered, in front of all players
        const labelY = baseTopY + TUNE.sectionLabelY;
        const labelZ = 0.35; // In front of front players (at ~0.17) with small margin for no flicker
        mesh.position.set(0, labelY, labelZ); // X=0 for perfect center
        sectionLabelMesh = mesh;
        scene.add(mesh);
      });
    }
  }

  function tick() {
    if (disposed) return;
    rafId = requestAnimationFrame(tick);
    updateSeatLayout();
    updateSeats();
    updateSectionLabel();
    updateCamera();
    renderer.render(scene, camera);
  }
  tick();

  // ---------------------------------------------------------------- tuner
  //
  // Temporary, per CLAUDE.md — delete once Luke gives final numbers to bake
  // in as this module's own defaults, same as every other tuner in this
  // codebase.
  const slider = (key, min, max, step) => ({
    value: TUNE[key],
    min,
    max,
    step,
    set: (v) => {
      TUNE[key] = v;
    },
  });
  const tuner = attachBgTuner({
    container,
    id: 'victoryTuner',
    title: 'victory stage',
    position: 'right',
    panels: {},
    extrasTitle: 'LAYOUT',
    extras: {
      'seat spacing x': slider('seatSpacingX', 0.1, 1.5, 0.01),
      'seat depth stagger': slider('seatDepthStagger', 0, 1.5, 0.01),
      'world units / point': slider('worldUnitsPerPoint', 0.02, 0.3, 0.005),
      'hemisphere scale': slider('hemisphereScale', 0.3, 3, 0.05),
      'hemisphere yaw': slider('hemisphereYaw', -Math.PI, Math.PI, 0.05),
      'cam distance': slider('camDistance', 0.5, 8, 0.1),
      'cam height': slider('camHeight', 0.1, 4, 0.05),
      'cam look height': slider('camLookHeight', -1, 2, 0.05),
      'section label Y': slider('sectionLabelY', 0, 2, 0.05),
      'score finish offset': slider('scoreFinishOffset', 0.5, 2.5, 0.1),
    },
  });
  container.querySelector('#victoryTuner > button')?.click(); // starts collapsed, same convention as the cavern's own tuner

  return {
    dispose() {
      disposed = true;
      if (rafId) cancelAnimationFrame(rafId);
      window.removeEventListener('resize', onResize);
      tuner?.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      container.classList.remove('victory-surface');
      container.innerHTML = '';
    },
  };
}
