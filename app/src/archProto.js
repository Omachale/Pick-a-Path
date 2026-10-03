/**
 * Viewer for the shrine arch (skypath/archGen.js), asked for as a quick
 * preview and Blender hand-off rather than a tuning page. 'game' mode is the
 * unlit, baked-shade look the arch will have in skyPath; 'clay' keeps the
 * same meshes and UVs with plain materials, the starting point if the arch
 * gets hand-painted textures instead.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { buildArch, varyArch, buildSignFrame, ARCH_PALETTES, SIGN_FRAMES, ARCH_LIT_FILL } from './skypath/archGen.js';

// The game adds a fill to lit arches because its own lights are weak; this
// page's lights are already bright, so its 'lit' view is the unfilled look.
ARCH_LIT_FILL.value = 0;
import { buildNameTagCanvas } from './skypath/nameTag.js';
import { buildArchTextures } from './skypath/archTextures.js';

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9fb8c8);
scene.fog = new THREE.Fog(0x9fb8c8, 8, 22);

const camera = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, 0.02, 100);
camera.position.set(1.9, 1.35, 3.1);

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
document.body.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0.8, 0);
controls.enableDamping = true;

// Only the 'lit' mode uses these; game and clay modes are unlit.
scene.add(new THREE.HemisphereLight(0xdfeeff, 0x5a5040, 1.1));
const sun = new THREE.DirectionalLight(0xfff0d8, 2.2);
sun.position.set(3, 5, 3);
scene.add(sun);

const ground = new THREE.Mesh(
  new THREE.CircleGeometry(6, 64).rotateX(-Math.PI / 2),
  new THREE.MeshBasicMaterial({ color: 0x6f7a5a }),
);
ground.position.y = -0.001;
scene.add(ground);

const figure = new THREE.Mesh(
  new THREE.CapsuleGeometry(0.2, 1.3, 6, 16).translate(0, 0.85, 0),
  new THREE.MeshBasicMaterial({ color: 0x334455, transparent: true, opacity: 0.45 }),
);
figure.position.set(0, 0, 0.6);
figure.visible = false;
scene.add(figure);

// seed: wear and glyphs (repaints textures, slow). shape: 0 = the base
// design, else a varyArch seed (fast). palette: index into ARCH_PALETTES.
let seed = 7, shape = 0, palette = 0, mode = 'unlit', wire = false, arch = null, tex = null;
const stats = document.getElementById('stats');

// ---------------------------------------------------------------- word signs
//
// Shows the arch as Sky Path builds it, with real cardboard words hanging
// from the rope, to choose a sign frame (Luke, 2026-10-04). These numbers
// MIRROR skyPath.js's ARCH (world units) and its WORD_SIGN_HEIGHT /
// WORD_SIGN_MARGIN — copy any change made there.
const GAME = {
  scale: 3.6, span: 6.6, clearHeight: 4.4, pillarRadius: 0.26,
  ropeHeight: 3.75, ropeSag: 0.25, ropeThickness: 0.55,
  signGap: 0.3, signDrop: 0.18, signHeight: 1.08, signMargin: 0.1,
};
function gameParams() {
  const s = GAME.scale, span = GAME.span / s, beamLength = span * 1.73;
  return {
    seed, span, beamLength, capLength: beamLength + 0.18,
    clearHeight: GAME.clearHeight / s,
    pillarRadius: GAME.pillarRadius / s, pillarTopRadius: (GAME.pillarRadius * 0.89) / s,
    ropeHeight: GAME.ropeHeight / s, ropeSag: GAME.ropeSag / s,
    ropeThickness: GAME.ropeThickness, ropeCharms: false,
  };
}
const WORD_PAIRS = [['Sheep', 'Ship'], ['Hit', 'Heat'], ['World', 'Word'], ['While', 'Will']];
let showSigns = false, frame = 'none', pairIdx = 0, signToken = 0;
const signsGroup = new THREE.Group();
scene.add(signsGroup);
const signDisposers = [];
const wordTextures = new Map();
const wordTexture = (word) => {
  if (!wordTextures.has(word))
    wordTextures.set(word, buildNameTagCanvas(word, { glowColor: '#ffe9b8' }).then(({ canvas, aspect }) => {
      const t = new THREE.CanvasTexture(canvas);
      t.colorSpace = THREE.SRGBColorSpace;
      return { texture: t, aspect };
    }));
  return wordTextures.get(word);
};
const cordMat = new THREE.MeshBasicMaterial({ color: 0x6b5233 });

function clearSigns() {
  signDisposers.splice(0).forEach((f) => f());
  signsGroup.clear();
}

/** Same layout as skyPath.js's updateWordSigns/layoutWordSign, in arch units. */
async function layoutSigns() {
  const token = ++signToken;
  clearSigns();
  if (!showSigns) return;
  const s = GAME.scale, r = arch.rope;
  const ropeY = (x) => r.y(THREE.MathUtils.clamp(x, -r.half, r.half));
  const gap = GAME.signGap / s, slot = r.half - gap / 2;
  const centre = gap / 2 + slot / 2, maxW = slot - (2 * GAME.signMargin) / s;
  const words = WORD_PAIRS[pairIdx];
  const loaded = await Promise.all(words.map(wordTexture));
  if (token !== signToken) return;
  loaded.forEach(({ texture, aspect }, i) => {
    const lateral = i ? centre : -centre;
    let h = GAME.signHeight / s, w = h / aspect;
    if (w > maxW) {
      w = maxW;
      h = w * aspect;
    }
    const g = new THREE.Group();
    const planeGeo = new THREE.PlaneGeometry(w, h);
    const planeMat = new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false });
    const plane = new THREE.Mesh(planeGeo, planeMat);
    plane.renderOrder = 10;
    g.add(plane);
    signDisposers.push(() => { planeGeo.dispose(); planeMat.dispose(); });
    let above = 0, cordX = [-0.34 * w, 0.34 * w];
    if (frame !== 'none') {
      const f = buildSignFrame(frame, w, h, tex);
      g.add(f.group);
      signDisposers.push(f.dispose);
      above = f.above;
      cordX = f.cordX;
    }
    // The cord length is the game's tuned signDrop, measured to wherever the
    // cords attach — the frame's rings/top bar, or the card itself.
    const attachY = ropeY(lateral) - GAME.signDrop / s;
    g.position.set(lateral, attachY - above - h / 2, 0.06 / s);
    for (const cx of cordX) {
      const len = Math.max(0.002, ropeY(lateral + cx) - attachY);
      const cg = new THREE.CylinderGeometry(0.014 / s, 0.014 / s, len, 5);
      cg.translate(cx, h / 2 + above + len / 2, 0);
      g.add(new THREE.Mesh(cg, cordMat));
      signDisposers.push(() => cg.dispose());
    }
    signsGroup.add(g);
  });
}

function rebuild() {
  arch?.dispose(); // textures are passed in, so they survive
  if (arch) scene.remove(arch.group);
  const t0 = performance.now();
  tex ??= buildArchTextures(seed);
  const base = showSigns ? gameParams() : { seed };
  const params = shape ? varyArch(base, shape) : base;
  arch = buildArch(params, { mode, textures: tex, palette: ARCH_PALETTES[palette] });
  scene.add(arch.group);
  applyWire();
  let tris = 0;
  arch.group.traverse((o) => o.isMesh && (tris += o.geometry.index ? o.geometry.index.count / 3 : o.geometry.attributes.position.count / 3));
  stats.textContent =
    `${ARCH_PALETTES[palette].name} · shape ${shape || 'base'} · seed ${seed} · ` +
    `${Math.round(tris).toLocaleString()} tris · ${arch.group.children.length} draw calls · ${Math.round(performance.now() - t0)} ms`;
  layoutSigns();
}

document.getElementById('signs').onclick = (e) => {
  showSigns = !showSigns;
  e.target.classList.toggle('on', showSigns);
  // A game-like eye line: standing back from the arch, looking up at the words.
  if (showSigns) {
    camera.position.set(0, 0.62, 2.3);
    controls.target.set(0, 0.85, 0);
  }
  rebuild();
};
const frameNote = document.getElementById('frameNote');
document.querySelectorAll('[data-frame]').forEach((b) =>
  b.addEventListener('click', () => {
    frame = b.dataset.frame;
    document.querySelectorAll('[data-frame]').forEach((x) => x.classList.toggle('on', x === b));
    frameNote.textContent = SIGN_FRAMES[frame] ?? '';
    layoutSigns();
  }),
);
document.getElementById('words').onclick = () => { pairIdx = (pairIdx + 1) % WORD_PAIRS.length; layoutSigns(); };

function applyWire() {
  arch.group.traverse((o) => o.isMesh && (o.material.wireframe = wire));
}

document.querySelectorAll('[data-mode]').forEach((b) =>
  b.addEventListener('click', () => {
    mode = b.dataset.mode;
    document.querySelectorAll('[data-mode]').forEach((x) => x.classList.toggle('on', x === b));
    arch.setMode(mode);
    applyWire();
  }),
);
document.getElementById('wire').onclick = () => { wire = !wire; applyWire(); };
document.getElementById('figure').onclick = () => { figure.visible = !figure.visible; };
document.getElementById('reseed').onclick = () => {
  seed = (seed * 7919 + 13) % 100000;
  Object.entries(tex).forEach(([, t]) => t.dispose());
  tex = null;
  rebuild();
};
document.getElementById('palette').onclick = () => { palette = (palette + 1) % ARCH_PALETTES.length; rebuild(); };
document.getElementById('shape').onclick = () => { shape = 1 + Math.floor(Math.random() * 99999); rebuild(); };
document.getElementById('baseShape').onclick = () => { shape = 0; rebuild(); };

// The lacquer tint is a custom shader, which glTF can't carry — so the
// export rebuilds the arch on textures with the colour scheme painted in.
document.getElementById('exportBtn').onclick = () => {
  const bakedTex = mode === 'clay' ? tex : buildArchTextures(seed, ARCH_PALETTES[palette]);
  const params = shape ? varyArch({ seed }, shape) : { seed };
  const out = buildArch(params, { mode, textures: bakedTex, palette: ARCH_PALETTES[palette] });
  const done = () => {
    out.dispose();
    if (bakedTex !== tex) Object.values(bakedTex).forEach((t) => t.dispose());
  };
  new GLTFExporter().parse(
    out.group,
    (result) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([result], { type: 'model/gltf-binary' }));
      const name = ARCH_PALETTES[palette].name.replace(/ /g, '-');
      a.download = `shrine-arch-${mode === 'clay' ? 'clay' : name}-${shape || 'base'}-${seed}.glb`;
      a.click();
      URL.revokeObjectURL(a.href);
      done();
    },
    (err) => {
      console.error('GLTFExporter failed', err);
      done();
    },
    { binary: true },
  );
};

rebuild();

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

(function tick() {
  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
})();

window.__arch = { camera, controls, rebuild, get arch() { return arch; } };
window.__capture = () => {
  controls.update();
  renderer.render(scene, camera);
  return renderer.domElement.toDataURL('image/png');
};
