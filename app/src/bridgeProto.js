/**
 * THROWAWAY PROTOTYPE — a live tuning page for the rope bridges that replace
 * the path stones between islands. Same role as islandProto.js played for the
 * islands: find the numbers here, bake them into BRIDGE_DEFAULTS in
 * skypath/bridgeGen.js, and don't guess them anywhere else.
 *
 * What makes this worth a page rather than tuning in-game: sag is only
 * judgeable against the two things it sits between — real island spacing and a
 * real character. Both are reproduced here at their true sizes (the constants
 * below are copied from skyPath.js and noted as such), so a number that looks
 * right here is right in the game. The alternative — a sag slider bolted into
 * the live game — was how the name-tag colour grading was done, and it dragged
 * an unrelated tuner back to life as a side effect; a separate page has no
 * such blast radius.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { buildIsland } from './skypath/islandGen.js';
import { buildBridge, disposeBridge, BRIDGE_DEFAULTS, BRIDGE_ANCHORS } from './skypath/bridgeGen.js';
import { createBridgeWind, WIND_DEFAULTS } from './skypath/bridgeWind.js';

// ============================================================================
// OPTIONAL BRIDGE PARAMETERS: DO NOT REINSTATE WITHOUT CLEAR INSTRUCTIONS
// ============================================================================
// The ENTIRE slider interface is parked, not deleted — the bridge geometry
// sliders (Luke, 2026-09-01) and now the wind-sway panel too (Luke, same day,
// after judging all six layers together rather than solo — swing and roll
// both came down hard from their exploratory values). Every number is settled
// and baked: bridge shape into BRIDGE_DEFAULTS / BRIDGE_ANCHORS
// (bridgeGen.js), wind into WIND_DEFAULTS (bridgeWind.js). This page now opens
// as a plain preview of the finished, swaying bridge. Every slider, its
// wiring, and the log/reset buttons for BOTH panels are all still here and
// still work — only visibility is gated, by one flag covering both (the wind
// panel lives inside the same #ui element as the bridge sliders, so hiding
// #ui hides both together; there was never a reason to give it a second flag).
//
//   To bring the sliders back for a deliberate re-tune:
//       http://localhost:5181/bridge-tuner.html?tune=1
//
// Do not un-gate this by default, and do not "helpfully" re-enable it as a
// side effect of touching something nearby — that is exactly how the older
// backdrop tuner got dragged back to life once before (see attachBgTuner in
// skyPath.js, parked behind its own separate ?tuneBg=1 for the same reason).
// If a value here needs changing, open the page with ?tune=1, change it,
// re-bake it into bridgeGen.js or bridgeWind.js, and leave the gate as it was.
// ============================================================================
const SHOW_SLIDERS = new URLSearchParams(location.search).has('tune');

// ---------------------------------------------------------------- world constants
// Copied from skyPath.js. These are NOT tunable here — they are the fixed
// context the bridge has to work inside. If any of them changes in the game,
// change it here too or this page starts lying about scale.
const ISLAND_RADIUS = 4;
const ISLAND_PATH_GAP = 8;
const FORK_DISTANCE = 2 * ISLAND_RADIUS + ISLAND_PATH_GAP; // 16
const FORK_HALF_ANGLE = THREE.MathUtils.degToRad(30);
const EDGE_LATERAL = ISLAND_RADIUS * Math.sin(FORK_HALF_ANGLE); // 2.0
const EDGE_FORWARD = ISLAND_RADIUS * Math.cos(FORK_HALF_ANGLE); // 3.46
const FIGURE_SCALE = 0.72;
const FIGURE_H = 2.2 * 0.8 * FIGURE_SCALE; // 1.267
const FIGURE_ASPECT = 400 / 563;
const CAM_BACK = 7.3;
const CAM_HEIGHT = 2.8;
const CAM_LOOK_Y = 0.9;

// Island A sits at the origin, island B one fork-distance ahead (-Z is
// forward, matching the game's heading convention). Both at heading 0: in
// play the second island's heading is corrected slightly toward the temple,
// which tilts each span by a degree or two — not enough to matter for judging
// sag, and holding it at zero keeps the two bridges symmetrical to read.
const ISLAND_A = { x: 0, z: 0 };
const ISLAND_B = { x: 0, z: -FORK_DISTANCE };

/**
 * The two anchor points for one side's bridge, mirroring genForkCurve() — but
 * with the two numbers that decide where a post lands exposed as sliders,
 * because the defaults inherited from the stone path put the posts in mid air.
 *
 * The route's own edge point is `EDGE_LATERAL` (2.0) to the side and
 * `EDGE_FORWARD` (3.46) forward, which is radius √(2.0² + 3.46²) = **exactly
 * 4.0** from the island centre — precisely on the rim of a deck whose radius
 * is also 4. So the edge point was never "on the deck" to begin with; it was
 * balanced on its very edge, and anything that nudged it outward (as the old
 * anchorInset did) left it over open air.
 *
 *  - `spacing` moves each bridge's centreline sideways — the two bridges
 *    slide toward or away from each other.
 *  - `depth` moves each post *radially inward*, toward its island's centre,
 *    which is what actually plants it on the deck. Because both islands' posts
 *    move away from the midpoint, this also lengthens the bridge.
 *
 * Both are route parameters rather than bridge parameters, which is why they
 * live here and not in bridgeGen's BRIDGE_DEFAULTS: in the game they become
 * adjustments to EDGE_LATERAL / EDGE_FORWARD, shared by every fork.
 */
function bridgeAnchors(sideSign, spacing, depth) {
  const fwd = EDGE_FORWARD - depth;
  return {
    from: { x: ISLAND_A.x + sideSign * spacing, z: ISLAND_A.z - fwd },
    to: { x: ISLAND_B.x + sideSign * spacing, z: ISLAND_B.z + fwd },
  };
}

/** How far the anchor sits from its island's centre — under 4.0 means it's on the deck. */
function anchorRadius(spacing, depth) {
  return Math.hypot(spacing, EDGE_FORWARD - depth);
}

// ---------------------------------------------------------------- scene
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9fc4dd);
scene.fog = new THREE.Fog(0x9fc4dd, 40, 110);

const camera = new THREE.PerspectiveCamera(52, innerWidth / innerHeight, 0.1, 500);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

scene.add(new THREE.AmbientLight(0xffffff, 0.6));
const sun = new THREE.DirectionalLight(0xfff2d8, 1.15);
sun.position.set(8, 14, 6);
scene.add(sun);
const fill = new THREE.DirectionalLight(0x88aaff, 0.28);
fill.position.set(-8, 4, -10);
scene.add(fill);

// ---------------------------------------------------------------- islands
// Loaded the same way skyPath.js does, including measuring the deck radius off
// the vertices rather than a bounding box — a Box3 around a flat disc is a
// square and its bounding sphere overstates the radius by sqrt(2), which is
// exactly the bug that once shrank every island to 71% of its intended size.
// Getting this wrong here would make every sag judgement wrong too.
const islandGroups = [new THREE.Group(), new THREE.Group()];
islandGroups[0].position.set(ISLAND_A.x, 0, ISLAND_A.z);
islandGroups[1].position.set(ISLAND_B.x, 0, ISLAND_B.z);
for (const g of islandGroups) scene.add(g);

function fillIslandsWithFallback() {
  for (const g of islandGroups) {
    const built = buildIsland({
      seed: Math.floor(Math.random() * 1e9),
      bump: 0.32, taper: 0.75, depth: 0.43, size: ISLAND_RADIUS * 2, grassCount: 0,
    });
    for (const child of [...built.children]) g.add(child);
  }
}

new GLTFLoader().load(
  'models/island-basic-v2.glb',
  (gltf) => {
    let deckMesh = null;
    let flattest = Infinity;
    gltf.scene.traverse((o) => {
      if (!o.isMesh) return;
      o.geometry.computeBoundingBox();
      const h = o.geometry.boundingBox.max.y - o.geometry.boundingBox.min.y;
      if (h < flattest) { flattest = h; deckMesh = o; }
    });
    gltf.scene.updateWorldMatrix(true, true);
    const pos = deckMesh.geometry.attributes.position;
    const v = new THREE.Vector3();
    let deckRadius = 0;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(deckMesh.matrixWorld);
      deckRadius = Math.max(deckRadius, Math.hypot(v.x, v.z));
    }
    // Texture the deck, as skyPath.js does — an untextured white disc makes
    // the deck/bridge junction much harder to read than it will be in play,
    // which is one of the things this page exists to judge.
    const deckMat = deckMesh.material.clone();
    deckMat.map = new THREE.TextureLoader().load('textures/island-circle.webp', (t) => {
      t.colorSpace = THREE.SRGBColorSpace;
    });
    deckMat.vertexColors = false;
    deckMat.color.set(0xffffff);
    deckMat.needsUpdate = true;
    deckMesh.material = deckMat;

    const scale = ISLAND_RADIUS / deckRadius;
    for (const g of islandGroups) {
      for (const child of gltf.scene.clone().children) g.add(child);
      g.scale.setScalar(scale);
    }
  },
  undefined,
  () => fillIslandsWithFallback() // model missing — the procedural rock is the same size, so scale stays honest
);

// ---------------------------------------------------------------- walker (scale reference)
// The whole point of the page: sag is only judgeable against something of
// known height standing on it.
const walker = new THREE.Mesh(
  new THREE.PlaneGeometry(FIGURE_H * FIGURE_ASPECT, FIGURE_H),
  new THREE.MeshBasicMaterial({ transparent: true, alphaTest: 0.45, side: THREE.DoubleSide })
);
new THREE.TextureLoader().load('textures/figure-indy.webp', (t) => {
  t.colorSpace = THREE.SRGBColorSpace;
  walker.material.map = t;
  walker.material.needsUpdate = true;
});
scene.add(walker);

// ---------------------------------------------------------------- wind
// One shared instance for the whole scene: every bridge references the same
// uniforms, which is what makes the wind read as a single wind rather than
// each bridge running its own. Survives rebuilds — only the materials are
// re-patched, the config and clock persist.
const wind = createBridgeWind();

// ---------------------------------------------------------------- bridges
let bridges = [];

function currentParams() {
  const p = {};
  for (const key of Object.keys(BRIDGE_DEFAULTS)) {
    const el = document.getElementById(key);
    if (el) p[key] = parseFloat(el.value);
  }
  return p;
}

/** The two route-level anchor sliders — see bridgeAnchors(). */
function anchorParams() {
  return {
    spacing: parseFloat(document.getElementById('bridgeSpacing').value),
    depth: parseFloat(document.getElementById('anchorDepth').value),
  };
}

function rebuild() {
  for (const b of bridges) { scene.remove(b); disposeBridge(b); }
  bridges = [];
  const p = currentParams();
  const { spacing, depth } = anchorParams();
  for (const sideSign of [1, -1]) {
    const { from, to } = bridgeAnchors(sideSign, spacing, depth);
    const b = buildBridge(from, to, p, wind);
    scene.add(b);
    bridges.push(b);
  }
  for (const key of [...Object.keys(BRIDGE_DEFAULTS), 'bridgeSpacing', 'anchorDepth']) {
    const el = document.getElementById(key);
    const out = document.getElementById(key + 'V');
    const isCount = key === 'missingPlanks' || key === 'plankEdgeSkip';
    if (el && out) out.textContent = isCount ? el.value : (+el.value).toFixed(2);
  }
  placeWalker();
  report();
}

/**
 * Stands the walker on the right-hand bridge at the walk slider's position,
 * including the wind offset — this is the CPU half of the GLSL/JS twin (see
 * bridgeWind.js). Without it the character stands still while the deck swings
 * out from under them, which is the single most obvious way to get sway wrong.
 * Called every frame, not just on slider change, for the same reason.
 */
const walkerWindOffset = new THREE.Vector3();
function placeWalker() {
  const t = parseFloat(document.getElementById('walkT').value);
  document.getElementById('walkTV').textContent = t.toFixed(2);
  const info = bridges[0].userData.bridge;
  const { from, to } = info.anchors;
  const x = from.x + (to.x - from.x) * t;
  const z = from.z + (to.z - from.z) * t;
  const { offset } = wind.evaluate(x, z, t, walkerWindOffset);
  walker.position.set(
    x + offset.x,
    info.heightAt(t) + FIGURE_H / 2 + offset.y,
    z + offset.z
  );
  walker.rotation.y = Math.atan2(to.x - from.x, -(to.z - from.z));
}

/** Live read-out of the numbers that decide whether this is sane. */
function report() {
  const info = bridges[0].userData.bridge;
  const p = currentParams();
  const { spacing, depth } = anchorParams();
  // "plank" can now be 1-3 meshes (see bridgeGen.js's plank variants) — found
  // by name rather than a fixed children[1], which only ever held for a
  // single procedural box.
  const drawn = bridges[0].children.filter((c) => c.name === 'plank').reduce((sum, c) => sum + c.count, 0);
  // The number that decides whether the outer posts stand on anything: under
  // the deck radius means planted, over it means hanging in mid air.
  const r = anchorRadius(spacing, depth);
  const onDeck = r < ISLAND_RADIUS - 0.15;
  // How much island is still underneath the rope past the anchor: leaving the
  // anchor at (spacing, -fwd) heading straight down -Z, the deck's rim
  // (radius 4) is reached after √(4² − spacing²) − fwd. A conservative
  // figure — the rock tapers inward below the deck, so the real clearance is
  // slightly more forgiving than this.
  const fwd = EDGE_FORWARD - depth;
  const overhang = Math.max(0, Math.sqrt(ISLAND_RADIUS ** 2 - spacing ** 2) - fwd);
  document.getElementById('report').innerHTML = [
    `span <b>${info.span.toFixed(2)}</b> = ${(info.span / FIGURE_H).toFixed(1)} character-heights`,
    `sag <b>${(100 * p.sag / info.span).toFixed(1)}%</b> of span`,
    `planks <b>${drawn}</b> shown of ${info.plankCount} (${(info.plankCount * 2 * 6).toFixed(0)} per round, 2 draw calls)`,
    `deck <b>${(p.deckWidth / (FIGURE_H * FIGURE_ASPECT)).toFixed(2)}×</b> the character's width`,
    `post at <b>${r.toFixed(2)}</b> of ${ISLAND_RADIUS} island radius — ` +
      (onDeck ? '<b style="color:#8f8">on the deck</b>' : '<b style="color:#f99">off the edge</b>'),
    `gap between bridges <b>${(spacing * 2).toFixed(2)}</b>`,
    // How far the rope runs before it has dropped below the island's deck
    // level, against how much island is still under it at that bearing. If
    // the first number is the smaller one the rope is inside the rock — which
    // is the exact fault deckHeight and plankEdgeSkip exist to fix.
    `rope clears deck level at <b>${info.clearsAt === Infinity ? 'never' : info.clearsAt.toFixed(2)}</b>` +
      ` vs <b>${overhang.toFixed(2)}</b> of island still under it — ` +
      (info.clearsAt > overhang
        ? '<b style="color:#8f8">clear</b>'
        : '<b style="color:#f99">rope in the rock</b>'),
    `bare rope <b>${p.plankEdgeSkip}</b> plank(s) each end`,
  ].join('<br>');
}

// ---------------------------------------------------------------- camera presets
function viewOrbit() {
  camera.position.set(8.5, 3.6, 1.5);
  controls.target.set(0, -0.9, -FORK_DISTANCE / 2);
}
/** Roughly what the player actually sees: the game's own follow-camera geometry. */
function viewWalker() {
  const t = parseFloat(document.getElementById('walkT').value);
  const info = bridges[0].userData.bridge;
  const { from, to } = info.anchors;
  const x = from.x + (to.x - from.x) * t;
  const z = from.z + (to.z - from.z) * t;
  camera.position.set(x, info.heightAt(t) + CAM_HEIGHT, z + CAM_BACK);
  controls.target.set(x, info.heightAt(t) + CAM_LOOK_Y, z - 4);
}
/** Side-on, to read the hanging curve itself rather than the perspective of it. */
function viewSide() {
  // Just clear of the island rim (radius 4) and close to deck height, so the
  // hanging curve is read against the sky rather than looked down on.
  camera.position.set(11, 0.8, -FORK_DISTANCE / 2);
  controls.target.set(0, -0.9, -FORK_DISTANCE / 2);
}

// ---------------------------------------------------------------- UI wiring
//
// Slider positions are pushed from BRIDGE_DEFAULTS / BRIDGE_ANCHORS at load
// rather than read from the `value` attributes in the HTML. Those attributes
// are now only documentation: this way there is exactly one source of truth
// for a baked number, and the page cannot quietly drift out of step with the
// module the way a hand-maintained second copy would.
function syncSlidersToDefaults() {
  for (const [key, val] of Object.entries(BRIDGE_DEFAULTS)) {
    const el = document.getElementById(key);
    if (el) el.value = val;
  }
  document.getElementById('bridgeSpacing').value = BRIDGE_ANCHORS.lateral;
  document.getElementById('anchorDepth').value = EDGE_FORWARD - BRIDGE_ANCHORS.forward;
}
syncSlidersToDefaults();

// See the OPTIONAL BRIDGE PARAMETERS banner at the top of this file. The panel
// is hidden unless ?tune=1; everything inside it stays wired either way, so
// the page still renders the bridge exactly as the baked numbers describe it.
if (!SHOW_SLIDERS) document.getElementById('ui').style.display = 'none';

// ---------------------------------------------------------------- wind panel
//
// Built from the config rather than hand-written markup, so a layer can never
// be present in bridgeWind.js but missing a control here. Each of the six
// layers gets its own checkbox that fully zeroes its contribution (the flags
// are uniforms, so toggling is instant — no shader recompile, which is what
// makes A/B-ing two layers against each other actually possible).
// The six split into two kinds, and it matters when isolating them:
//
//   CARRIERS (swing, roll, bob) each produce movement on their own.
//   MODIFIERS (travel, octaves, gust) only shape a carrier's movement — they
//   contribute no displacement themselves. Switch every carrier off and a
//   modifier alone does exactly nothing, which is correct behaviour and not a
//   fault. Verified 2026-09-01: each modifier demonstrably changes the result
//   when added on top of swing, and produces a frozen scene without one.
//
// The panel is grouped and labelled accordingly so "travel alone looks broken"
// never has to be diagnosed twice.
const WIND_LAYERS = [
  { key: 'swing', kind: 'carrier', label: 'swing', fields: [{ k: 'amplitude', min: 0, max: 0.8, step: 0.005 }] },
  { key: 'roll', kind: 'carrier', label: 'roll', fields: [{ k: 'amount', min: 0, max: 1.2, step: 0.01 }] },
  {
    key: 'bob',
    kind: 'carrier',
    label: 'bob',
    fields: [
      { k: 'amplitude', min: 0, max: 0.4, step: 0.005 },
      { k: 'frequency', min: 0.2, max: 5, step: 0.05 },
    ],
  },
  {
    key: 'travel',
    kind: 'modifier',
    label: 'travel (phase lag)',
    fields: [{ k: 'wavelength', min: 2, max: 120, step: 0.5 }],
  },
  {
    key: 'octaves',
    kind: 'modifier',
    label: 'octaves',
    fields: [
      { k: 'amplitude', min: 0, max: 1.2, step: 0.01 },
      { k: 'ratio', min: 1.1, max: 5, step: 0.05 },
    ],
  },
  {
    key: 'gust',
    kind: 'modifier',
    label: 'gust',
    fields: [
      { k: 'amplitude', min: 0, max: 1.5, step: 0.01 },
      { k: 'period', min: 2, max: 40, step: 0.5 },
    ],
  },
];

function buildWindPanel() {
  const host = document.getElementById('windPanel');
  const row = (html) => {
    const d = document.createElement('div');
    d.innerHTML = html;
    host.appendChild(d);
    return d;
  };

  const master = row(
    `<label class="chk"><input type="checkbox" id="windOn" ${wind.config.on ? 'checked' : ''}> <b>wind on</b></label>`
  );
  master.querySelector('#windOn').addEventListener('change', (e) => {
    wind.config.on = e.target.checked;
    wind.apply();
  });

  for (const [key, spec] of [['direction', { min: 0, max: 6.28, step: 0.02 }], ['frequency', { min: 0.05, max: 3, step: 0.01 }]]) {
    const d = row(
      `<label class="row"><span>${key}</span><span class="readout" id="w_${key}V">${wind.config[key]}</span></label>
       <input type="range" id="w_${key}" min="${spec.min}" max="${spec.max}" step="${spec.step}" value="${wind.config[key]}">`
    );
    d.querySelector(`#w_${key}`).addEventListener('input', (e) => {
      wind.config[key] = parseFloat(e.target.value);
      d.querySelector(`#w_${key}V`).textContent = (+e.target.value).toFixed(2);
      wind.apply();
    });
  }

  let lastKind = null;
  for (const layer of WIND_LAYERS) {
    if (layer.kind !== lastKind) {
      lastKind = layer.kind;
      row(
        layer.kind === 'carrier'
          ? `<div class="kind">carriers <i>— each moves on its own</i></div>`
          : `<div class="kind">modifiers <i>— shape a carrier; inert alone</i></div>`
      );
    }
    const c = wind.config[layer.key];
    const d = row(
      `<label class="chk"><input type="checkbox" id="on_${layer.key}" ${c.on ? 'checked' : ''}> ${layer.label}</label>` +
        layer.fields
          .map(
            (f) =>
              `<label class="row sub"><span>${f.k}</span><span class="readout" id="v_${layer.key}_${f.k}">${c[f.k]}</span></label>
               <input type="range" id="f_${layer.key}_${f.k}" min="${f.min}" max="${f.max}" step="${f.step}" value="${c[f.k]}">`
          )
          .join('')
    );
    d.querySelector(`#on_${layer.key}`).addEventListener('change', (e) => {
      c.on = e.target.checked;
      wind.apply();
    });
    for (const f of layer.fields) {
      d.querySelector(`#f_${layer.key}_${f.k}`).addEventListener('input', (e) => {
        c[f.k] = parseFloat(e.target.value);
        d.querySelector(`#v_${layer.key}_${f.k}`).textContent = (+e.target.value).toFixed(2);
        wind.apply();
      });
    }
  }

  // Fast way to isolate a layer: kill them all, then tick the one being judged.
  const btns = row(
    `<div class="btnRow"><button id="windNone">all off</button><button id="windAll">all on</button><button id="windLog">log wind</button></div>`
  );
  const setAll = (v) => {
    for (const layer of WIND_LAYERS) {
      wind.config[layer.key].on = v;
      document.getElementById(`on_${layer.key}`).checked = v;
    }
    wind.apply();
  };
  btns.querySelector('#windNone').addEventListener('click', () => setAll(false));
  btns.querySelector('#windAll').addEventListener('click', () => setAll(true));
  btns.querySelector('#windLog').addEventListener('click', () => {
    const c = wind.config;
    const text = [
      '// WIND_DEFAULTS (bridgeWind.js)',
      `  on: ${c.on},`,
      `  direction: ${c.direction},`,
      `  frequency: ${c.frequency},`,
      ...WIND_LAYERS.map((l) => {
        const v = c[l.key];
        const fields = l.fields.map((f) => `${f.k}: ${v[f.k]}`).join(', ');
        return `  ${l.key}: { on: ${v.on}, ${fields} },`;
      }),
    ].join('\n');
    document.getElementById('log').textContent = text;
    navigator.clipboard?.writeText(text).catch(() => {});
  });
}
buildWindPanel();

for (const key of [...Object.keys(BRIDGE_DEFAULTS), 'bridgeSpacing', 'anchorDepth']) {
  document.getElementById(key)?.addEventListener('input', rebuild);
}
document.getElementById('walkT').addEventListener('input', placeWalker);
document.getElementById('viewOrbit').addEventListener('click', viewOrbit);
document.getElementById('viewWalker').addEventListener('click', viewWalker);
document.getElementById('viewSide').addEventListener('click', viewSide);
document.getElementById('resetBtn').addEventListener('click', () => {
  syncSlidersToDefaults();
  rebuild();
});
document.getElementById('logBtn').addEventListener('click', () => {
  const p = currentParams();
  const { spacing, depth } = anchorParams();
  const text = [
    '// BRIDGE_DEFAULTS (bridgeGen.js)',
    ...Object.keys(BRIDGE_DEFAULTS)
      .filter((k) => k !== 'missingPlanks' && k !== 'gapCenterT') // route-specific runtime state, not tuned constants
      .map((k) => `  ${k}: ${p[k]},`),
    '// route anchors (skyPath.js EDGE_LATERAL / EDGE_FORWARD)',
    `  EDGE_LATERAL: ${spacing}`,
    `  EDGE_FORWARD: ${(EDGE_FORWARD - depth).toFixed(3)}   // = ${EDGE_FORWARD.toFixed(3)} - ${depth} depth`,
  ].join('\n');
  document.getElementById('log').textContent = text;
  navigator.clipboard?.writeText(text).catch(() => {});
});

// ---------------------------------------------------------------- export for Blender
//
// Hands over the two placeholder shapes (BoxGeometry) at their real baked
// sizes (Luke, 2026-09-02, ahead of the plank-breaking work — a broken plank
// needs its own mesh, and that's a good moment to stop using a plain box for
// both). NOT gated behind SHOW_SLIDERS: exporting isn't a tuning control with
// a re-drift risk, it's a one-shot handoff, and Luke wants it available in
// the page's normal (parked) state.
//
// Geometry is cloned straight off the live bridge the page already built —
// not reconstructed from BRIDGE_DEFAULTS by hand — so there is no way for the
// exported size to drift from what actually ships. Deliberately geometry
// only: GLTFExporter would also happily export bridgeGen.js's placeholder
// MeshLambertMaterial (flat colour, no texture), which is not what Luke wants
// arriving in Blender.
//
// Axis convention a replacement mesh MUST follow, matching exactly how
// buildBridge() orients every instance (see the `m.makeBasis(...)` calls in
// bridgeGen.js) — get this wrong and the reshaped mesh will still be the
// right size but render sideways or upside down:
//   PLANK: origin at its centre. +X runs across the deck (the way you'd step
//   sideways off it), +Y is up, +Z is the direction of travel.
//   POST: origin at its centre too, but *not* vertically centred on the
//   deck — buildBridge positions it at `postHeight/2 - postEmbed/2`, i.e.
//   already embedded, so the post's own local Y=0 is NOT ground level. +Y is
//   still up, +X/+Z are the deck's side/tangent directions (a post is
//   symmetric under yaw, so these only matter if the replacement isn't).
// Reshaping/adding detail is fine as long as the piece stays centred on that
// same origin and roughly fills the same bounding box — buildBridge scales
// nothing, it only positions and orients whatever geometry it's given.
function exportGLB(mesh, filename) {
  new GLTFExporter().parse(
    mesh,
    (result) => {
      const blob = new Blob([result], { type: 'model/gltf-binary' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      a.click();
      URL.revokeObjectURL(a.href);
    },
    (err) => console.error('GLTFExporter failed', err),
    { binary: true }
  );
}
function plankExportMesh() {
  // Found by name, not a fixed children[1] — see bridgeGen.js's plank
  // variants, which can mean more than one "plank"-named child now. The
  // first is representative for an export whose whole point is "here is
  // roughly the right box to reshape," not a specific variant's nuance.
  const geo = bridges[0].children.find((c) => c.name === 'plank').geometry.clone();
  // aSpanT is the wind shader's per-instance attribute (see bridgeWind.js) —
  // meaningless outside that shader and not something GLTFExporter knows
  // what to do with; strip it so only real geometry (position/normal/uv) goes
  // out.
  geo.deleteAttribute('aSpanT');
  return new THREE.Mesh(geo, new THREE.MeshStandardMaterial());
}
function postExportMesh() {
  const geo = bridges[0].children.find((c) => c.name === 'post').geometry.clone();
  return new THREE.Mesh(geo, new THREE.MeshStandardMaterial());
}
document.getElementById('exportPlank').addEventListener('click', () => exportGLB(plankExportMesh(), 'plank-placeholder.glb'));
document.getElementById('exportPost').addEventListener('click', () => exportGLB(postExportMesh(), 'post-placeholder.glb'));
window.__testExport = () =>
  new Promise((resolve) => {
    const out = {};
    let pending = 2;
    const done = (key, ok, extra) => {
      out[key] = { ok, ...extra };
      if (--pending === 0) resolve(out);
    };
    new GLTFExporter().parse(
      plankExportMesh(),
      (r) => done('plank', true, { byteLength: r.byteLength }),
      (e) => done('plank', false, { error: String(e) }),
      { binary: true }
    );
    new GLTFExporter().parse(
      postExportMesh(),
      (r) => done('post', true, { byteLength: r.byteLength }),
      (e) => done('post', false, { error: String(e) }),
      { binary: true }
    );
  });

rebuild();
viewOrbit();

// ---------------------------------------------------------------- loop
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

const clock = new THREE.Clock();
function tick() {
  wind.update(clock.getElapsedTime()); // one call moves every bridge in the scene
  placeWalker();                       // the walker rides the deck — see placeWalker()
  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}
tick();

window.__capture = () => {
  renderer.render(scene, camera);
  return renderer.domElement.toDataURL('image/png');
};
window.__bridgeInfo = () => bridges[0].userData.bridge;
window.__camera = camera;
window.__scene = scene;
window.__THREE = THREE;
window.__wind = wind;
window.__walker = walker;
window.__cam = () => ({
  pos: camera.position.toArray().map((v) => +v.toFixed(2)),
  target: controls.target.toArray().map((v) => +v.toFixed(2)),
  fov: camera.fov,
  aspect: +camera.aspect.toFixed(3),
});
