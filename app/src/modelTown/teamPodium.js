/**
 * One team's victory platform, for the model-town test page: the real
 * victory-stage pieces (Luke's victory-base-small.glb and
 * victory-pedestal.glb, the avatar cards, real cardboard name tags from
 * nameTag.js, the coloured rings, the score numbers), laid out exactly as
 * victory/victoryStage.js lays them out, in that file's own units. The
 * caller scales the whole group down to sit on its spot on the model's
 * stage. Luke, 2026-10-06: "Now put the victory platforms into the scene."
 *
 * Animated by the caller through pose(): players pop up, then pedestals rise
 * stage by stage (islands, items, jetpack, aliens), with the scores counting
 * up, using victoryStage.js's own stage timings; and dance() for the winning
 * team at the end. Lit materials rather than the game's unlit ones: in this
 * lit room an unlit piece looks pasted on, and it needs to cast shadows
 * like everything else on the table.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { buildNameTagCanvas } from '../skypath/nameTag.js';
import { characterSrc } from '../skypath/characters.js';
import { scoreBreakdown } from '../lobby/scoring.js';

// From victoryStage.js's TUNE (Luke's settled values), so a platform here
// matches the one in the game.
export const PODIUM = {
  seatSpacingX: 0.28,
  seatDepthStagger: 0.34,
  worldUnitsPerPoint: 0.09,
  avatarHeight: 0.22,
  tagHeight: 0.09,
  scoreHeight: 0.25,
  baseWidth: 1.8, // the base's width once turned (its 2 x 0.9 depth axis)
};
const FIGURE_ASPECT = 0.71;
// The layer name tags are drawn on, after the tilt-shift blur (main.js), so
// they're never blurred.
export const SHARP_LAYER = 1;
const css = (hex) => `#${hex.toString(16).padStart(6, '0')}`;

// The score stages, from victoryStage.js (its STAGES, without the 3 s
// opening delay: here the camera's move to the team fills that). Each
// stage's points rise over `ms` with an ease-out, then a pause.
export const STAGES = [
  { key: 'islands', label: 'Islands Reached', ms: 3000, gapMs: 2000 },
  { key: 'items', label: 'Items Collected', ms: 2000, gapMs: 2000 },
  { key: 'jetpackBonus', label: 'Jetpack On', ms: 2000, gapMs: 2000 },
  { key: 'resists', label: 'Aliens Evaded', ms: 2000, gapMs: 0 },
];
export const STAGES_MS = STAGES.reduce((t, s) => t + s.ms + s.gapMs, 0);
const easeOutCubic = (t) => 1 - (1 - t) ** 3;
const easeOutBack = (t) => 1 + 2.4 * (t - 1) ** 3 + 1.4 * (t - 1) ** 2;
const clamp01 = (t) => Math.min(1, Math.max(0, t));

/** Points risen by `ms` into `stages`, and the label of the stage it's in. */
function stagesAt(b, ms, stages) {
  if (!stages.length) return { value: 0, label: null, settled: true };
  let t = 0;
  let value = 0;
  for (const s of stages) {
    const k = clamp01((ms - t) / s.ms);
    value += (b[s.key] ?? 0) * easeOutCubic(k);
    if (ms < t + s.ms + s.gapMs) return { value, label: ms >= t ? s.label : null, settled: k >= 1 };
    t += s.ms + s.gapMs;
  }
  return { value, label: stages[stages.length - 1].label, settled: true };
}

let templates = null;
export function loadPodiumTemplates() {
  if (templates) return templates;
  const loader = new GLTFLoader();
  const load = (src) =>
    new Promise((resolve, reject) =>
      loader.load(
        src,
        (gltf) => {
          gltf.scene.traverse((o) => {
            if (!o.isMesh) return;
            const old = o.material;
            o.material = new THREE.MeshStandardMaterial({ map: old.map, color: old.color, roughness: 0.92 });
            old.dispose();
            o.castShadow = o.receiveShadow = true;
          });
          resolve(gltf.scene);
        },
        undefined,
        reject,
      ),
    );
  templates = Promise.all([load('models/victory-base-small.glb'), load('models/victory-pedestal.glb')]).then(([base, pedestal]) => {
    const node = pedestal.children[0]; // the "Top" mesh, carrying the baked scale
    const box = new THREE.Box3().setFromObject(pedestal);
    return {
      base,
      baseTop: new THREE.Box3().setFromObject(base).max.y,
      pedestalNode: node,
      // World height per unit of the node's scale.y, so a wanted height
      // converts straight to a scale (see victoryStage.js for why the
      // node, not the wrapper).
      heightPerScale: (box.max.y - box.min.y) / (node.scale.y || 1),
      footprint: (box.max.x - box.min.x) / 2,
    };
  });
  return templates;
}

/** Each seat's breakdown; the guide gets the team's average, per category (victoryStage.js's rule). */
function seatBreakdowns(team) {
  const players = team.players.map((p) => scoreBreakdown(p.result));
  const guide = {};
  for (const s of STAGES) guide[s.key] = players.length ? players.reduce((a, b) => a + (b[s.key] ?? 0), 0) / players.length : 0;
  return [...players, guide];
}
const totalOf = (b) => STAGES.reduce((t, s) => t + (b[s.key] ?? 0), 0);

function scoreCanvas(score, colorHex) {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d');
  g.font = "bold 280px 'Sue Ellen Francisco', cursive, sans-serif";
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.strokeStyle = 'rgba(0,0,0,0.3)';
  g.lineWidth = 8;
  g.strokeText(String(score), 256, 256);
  g.fillStyle = css(colorHex);
  g.fillText(String(score), 256, 256);
  return c;
}

async function tagMesh(text, glow, height) {
  const { canvas, aspect } = await buildNameTagCanvas(text, { glowColor: glow });
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(height / aspect, height),
    // No depth test: drawn in their own pass after the blur, over the
    // finished picture (see SHARP_LAYER).
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide, toneMapped: false, depthWrite: false, depthTest: false }),
  );
  m.layers.set(SHARP_LAYER);
  return m;
}

/**
 * team: { players: [{name, characterKey, colorHex, result}], guide: {name, characterKey, colorHex} }
 * Resolves to the team's podium: `group` in victory-stage units (front
 * facing +z, base at y 0), `teamScore` (the average of every seat's total,
 * guide included), `stagesMs` (how long its score stages take: only the
 * categories somebody scored in), and pose()/dance() to animate it.
 */
export async function buildTeamPodium(team) {
  const T = await loadPodiumTemplates();
  // The score font must be loaded before the numbers are drawn to canvas.
  await document.fonts?.load("bold 280px 'Sue Ellen Francisco'");
  const group = new THREE.Group();
  const base = T.base.clone();
  base.rotation.y = Math.PI / 2; // as victoryStage.js: long axis left-to-right
  group.add(base);

  const people = [...team.players, team.guide];
  const breakdowns = seatBreakdowns(team);
  const n = people.length;
  const H = PODIUM.avatarHeight;
  const ringGeo = new THREE.RingGeometry(T.footprint - 0.006, T.footprint + 0.006, 48);
  const scoreGeo = new THREE.PlaneGeometry(PODIUM.scoreHeight, PODIUM.scoreHeight);
  const seats = await Promise.all(
    people.map(async (person, i) => {
      const root = new THREE.Group();
      root.position.set((i - (n - 1) / 2) * PODIUM.seatSpacingX, T.baseTop, i % 2 === 0 ? PODIUM.seatDepthStagger / 2 : -PODIUM.seatDepthStagger / 2);
      group.add(root);
      const ped = T.pedestalNode.clone();
      root.add(ped);
      const ring = (color) => {
        const r = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, toneMapped: false }));
        r.rotation.x = -Math.PI / 2;
        root.add(r);
        return r;
      };
      const ringBottom = ring(person.colorHex);
      ringBottom.position.y = 0.001;
      const ringTop = ring(person.colorHex);
      // The avatar card, lit, casting a shadow cut to its outline.
      const tex = await new THREE.TextureLoader().loadAsync(characterSrc(person.characterKey));
      tex.colorSpace = THREE.SRGBColorSpace;
      const avatar = new THREE.Mesh(
        new THREE.PlaneGeometry(H * FIGURE_ASPECT, H),
        // Partly self-lit: the window light comes from behind them, which
        // would leave their faces (toward the camera) in shade.
        new THREE.MeshStandardMaterial({ map: tex, alphaTest: 0.45, side: THREE.DoubleSide, roughness: 0.9, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.45 }),
      );
      avatar.geometry.translate(0, H / 2, 0); // pivot at the feet, so it pops and wobbles from where it stands
      avatar.castShadow = true;
      root.add(avatar);
      // Name tag above, glowing in the player's colour; unlit, so the glow
      // stays its true colour.
      const tag = await tagMesh(person.name, css(person.colorHex), PODIUM.tagHeight);
      root.add(tag);
      const score = new THREE.Mesh(scoreGeo, new THREE.MeshBasicMaterial({ transparent: true, toneMapped: false, depthWrite: false }));
      score.position.z = 0.15;
      score.visible = false;
      root.add(score);
      return { root, ped, ringBottom, ringTop, avatar, tag, score, shown: null, colorHex: person.colorHex, breakdown: breakdowns[i], total: totalOf(breakdowns[i]) };
    }),
  );
  const teamScore = seats.reduce((t, s) => t + s.total, 0) / seats.length;
  // Only the categories somebody on this team scored in (Luke: "any empty
  // categories (i.e. no one on the team got any points) can be skipped").
  const stages = STAGES.filter((st) => breakdowns.some((b) => (b[st.key] ?? 0) > 0));
  const stagesMs = stages.reduce((t, st) => t + st.ms + st.gapMs, 0);

  // The stage's name, above the team while its points rise (victoryStage.js
  // shows it above the back row, 50% larger than a name tag, then 30% smaller).
  const labels = new Map();
  for (const s of STAGES) {
    const m = await tagMesh(s.label, '#cccccc', PODIUM.tagHeight * 1.5 * 1.5 * 0.7);
    m.visible = false;
    const top = Math.max(...seats.map((x) => x.total)) * PODIUM.worldUnitsPerPoint + H + PODIUM.tagHeight + 0.2;
    m.position.set(0, T.baseTop + top, 0.35);
    group.add(m);
    labels.set(s.label, m);
  }

  function setScore(seat, shown) {
    if (seat.shown === shown) return;
    seat.shown = shown;
    seat.score.material.map?.dispose();
    seat.score.visible = shown > 0;
    if (shown <= 0) return;
    const t = new THREE.CanvasTexture(scoreCanvas(shown, seat.colorHex));
    t.colorSpace = THREE.SRGBColorSpace;
    seat.score.material.map = t;
    seat.score.material.needsUpdate = true;
  }

  /**
   * popS: seconds since the players began popping up (below 0: not yet,
   * hidden); stageMs: milliseconds into the score stages (0: nothing risen;
   * Infinity: final). showLabel: whether this team's stage label shows.
   */
  // The team's total as shown on its placard: the average of every seat's
  // points from the categories that have finished rising.
  const api = { teamShown: 0 };
  function pose(popS, stageMs, showLabel = false) {
    let label = null;
    let done = 0;
    let t = 0;
    for (const st of stages) {
      if (stageMs < t + st.ms) break;
      for (const seat of seats) done += seat.breakdown[st.key] ?? 0;
      t += st.ms + st.gapMs;
    }
    api.teamShown = done / seats.length;
    seats.forEach((seat, i) => {
      // One after another, left to right, each with a little overshoot.
      const k = clamp01((popS - i * 0.15) / 0.45);
      const s = popS < 0 ? 0 : easeOutBack(k);
      const at = stagesAt(seat.breakdown, stageMs, stages);
      label = at.label;
      const h = Math.max(0.002, at.value * PODIUM.worldUnitsPerPoint);
      seat.ped.scale.y = h / T.heightPerScale;
      seat.ringTop.position.y = h + 0.001;
      // Base ring: the player's colour until the pedestal rises, then black
      // (victoryStage.js's rule).
      seat.ringBottom.material.color.set(h > 0.002 ? 0x000000 : seat.colorHex);
      seat.avatar.position.set(0, h, 0);
      seat.avatar.rotation.set(0, 0, 0); // dance() adds its sway on top, frame by frame
      seat.avatar.scale.setScalar(Math.max(0.0001, s));
      seat.avatar.visible = s > 0.001;
      seat.tag.position.y = h + H * s + PODIUM.tagHeight / 2 + 0.02;
      seat.tag.scale.setScalar(Math.max(0.0001, s));
      seat.tag.visible = s > 0.001;
      // The number counts in whole points as it rises, settling on the exact
      // (to the half point) figure once each stage is done.
      const shown = at.settled ? Math.round(at.value * 2) / 2 : Math.round(at.value);
      setScore(seat, shown);
      const pct = shown >= 4 ? 0.75 : 0.5 + Math.max(0, shown - 1) * (0.25 / 3);
      seat.score.position.y = h * pct;
    });
    for (const [text, m] of labels) m.visible = showLabel && text === label && stageMs < stagesMs + 800;
  }

  // The winners' dance: each avatar rocks side to side and hops, crudely,
  // each a little out of step with the others.
  function dance(time, amount) {
    seats.forEach((seat, i) => {
      const p = time * 6.5 + i * 1.7;
      seat.avatar.rotation.z = Math.sin(p) * 0.32 * amount;
      seat.avatar.rotation.y = Math.sin(p * 0.5 + i) * 0.35 * amount;
      seat.avatar.position.x = Math.sin(p) * 0.02 * amount;
      seat.avatar.position.y += Math.abs(Math.sin(p)) * 0.05 * amount;
    });
  }

  return Object.assign(api, { group, teamScore, stagesMs, pose, dance });
}
