/**
 * THROWAWAY PROTOTYPE — a live tuning page for the procedural floating rock
 * island, used to find the parameters baked into the real game. See
 * skypath/islandGen.js for the generator itself and the reasoning behind the
 * shape strategy; this file is just the scene, UI, and (for handing a shape
 * off to Blender) a GLB export button.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { buildIsland } from './skypath/islandGen.js';

// ---------------------------------------------------------------- scene
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a1420);
scene.fog = new THREE.Fog(0x0a1420, 15, 45);

const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 200);
camera.position.set(9, 5, 9);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
document.body.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, -1, 0);
controls.enableDamping = true;

scene.add(new THREE.AmbientLight(0xffffff, 0.55));
const sun = new THREE.DirectionalLight(0xfff2d8, 1.1);
sun.position.set(6, 10, 4);
scene.add(sun);
const fill = new THREE.DirectionalLight(0x88aaff, 0.3);
fill.position.set(-6, 3, -6);
scene.add(fill);

const grid = new THREE.GridHelper(40, 40, 0x2a4058, 0x18293a);
grid.position.y = -6;
scene.add(grid);

let group = new THREE.Group();
scene.add(group);

// ---------------------------------------------------------------- UI wiring
const els = {
  bump: document.getElementById('bump'),
  taper: document.getElementById('taper'),
  depth: document.getElementById('depth'),
  size: document.getElementById('size'),
  grass: document.getElementById('grass'),
};
const labels = {
  bump: document.getElementById('bumpV'),
  taper: document.getElementById('taperV'),
  depth: document.getElementById('depthV'),
  size: document.getElementById('sizeV'),
  grass: document.getElementById('grassV'),
};
let seed = Math.floor(Math.random() * 1e9);

function currentParams() {
  return {
    seed,
    bump: parseFloat(els.bump.value),
    taper: parseFloat(els.taper.value),
    depth: parseFloat(els.depth.value),
    size: parseFloat(els.size.value),
    grassCount: parseInt(els.grass.value, 10),
  };
}

function rebuild() {
  scene.remove(group);
  group = buildIsland(currentParams());
  scene.add(group);
  for (const k in labels) labels[k].textContent = els[k].value;
}

for (const k in els) els[k].addEventListener('input', rebuild);
document.getElementById('reroll').addEventListener('click', () => {
  seed = Math.floor(Math.random() * 1e9);
  rebuild();
});
let wire = false;
document.getElementById('wire').addEventListener('click', () => {
  wire = !wire;
  group.traverse((o) => {
    if (o.material) o.material.wireframe = wire;
  });
});

// Hands the current shape to Blender: File > Import > glTF 2.0 on the
// downloaded file. Binary GLB rather than .gltf+.bin so it's one file.
// Vertex colours come along for the ride (glTF's COLOR_0 attribute) — Blender
// reads them into a colour attribute you can wire into a shader if wanted,
// though they'll want redoing as real materials for anything but reference.
document.getElementById('exportBtn').addEventListener('click', () => {
  new GLTFExporter().parse(
    group,
    (result) => {
      const blob = new Blob([result], { type: 'model/gltf-binary' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `island-${seed}.glb`;
      a.click();
      URL.revokeObjectURL(a.href);
    },
    (err) => console.error('GLTFExporter failed', err),
    { binary: true }
  );
});

rebuild();

// ---------------------------------------------------------------- loop
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

function tick() {
  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}
tick();

window.__capture = () => {
  renderer.render(scene, camera);
  return renderer.domElement.toDataURL('image/png');
};
