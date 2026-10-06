/**
 * TEST ONLY (temple-3d.html, 2026-10-06): puts the procedural 3D temple
 * (templeBuilder.js) into a copy of Sky Path in place of the flat temple, and
 * shows what it costs.
 *
 * Kept in its own file so the Sky Path copy (skyPathTemple3d.js) only needs a
 * handful of one-line hooks — every one of them is marked "TEMPLE 3D TEST".
 *
 * Sizing: first matched to the flat temple's width (Luke, 2026-10-06), then
 * "a bit smaller": SIZE below, 80% of that width. Placement can't reuse the flat
 * temple's plane: a real building has depth, and its stairs reach well out
 * in front of its doors. So the FOOT OF THE STAIRS stays just beyond where
 * the walk stops, at every size, and the rest of the temple falls in behind.
 *
 * Lighting: baked only (Luke, 2026-10-06: "remove the active lighting and go
 * with the baked-in option"). Sky Path is unlit by design, with shading
 * painted into the art (CLAUDE.md), and the lit version, under Sky Path's dim
 * dusk sun, came out nearly black and cost ~3.5 ms a frame up close. Each
 * mesh gets its lighting computed once, from a fixed late-afternoon sun, into
 * vertex colours, and is drawn unlit like everything else. The builder's bump
 * maps only ever mattered under real lights, so they're never made: the slow
 * textures load as colour-only files (templeBuilder.js FILE_TEXTURES).
 */

import * as THREE from 'three';
import { buildTemple, TEMPLE_LAYOUT, FILE_TEXTURES } from './templeBuilder.js';

// The baked sun: from the right and a little in front, low, warm — roughly
// where Sky Path's own key light sits by the last fork (applySun near p=1).
const BAKE_SUN_DIR = new THREE.Vector3(0.75, 0.55, 0.45).normalize();
const BAKE_SUN = new THREE.Color(0xffd2a8).multiplyScalar(0.85);
const BAKE_SKY = new THREE.Color(0xd8c4c8).multiplyScalar(0.55);
const BAKE_GROUND = new THREE.Color(0x6b5a50).multiplyScalar(0.45);
// Instanced pieces (brackets, tile caps, grass) can't carry per-vertex light
// cheaply here (one geometry, many orientations), so they get one flat shade.
const INSTANCED_SHADE = 0.75;

const _n = new THREE.Vector3();
const _c = new THREE.Color();
const _s = new THREE.Color();
const _nm = new THREE.Matrix3();

function bakeVertexLight(mesh) {
  const g = mesh.geometry;
  const nrm = g.attributes.normal;
  if (!nrm) return false;
  _nm.getNormalMatrix(mesh.matrixWorld);
  const col = new Float32Array(nrm.count * 3);
  for (let i = 0; i < nrm.count; i++) {
    _n.fromBufferAttribute(nrm, i).applyMatrix3(_nm).normalize();
    const sun = Math.max(0, _n.dot(BAKE_SUN_DIR));
    const up = _n.y * 0.5 + 0.5;
    _c.copy(BAKE_GROUND).lerp(BAKE_SKY, up).add(_s.copy(BAKE_SUN).multiplyScalar(sun));
    col[i * 3] = Math.min(1, _c.r);
    col[i * 3 + 1] = Math.min(1, _c.g);
    col[i * 3 + 2] = Math.min(1, _c.b);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return true;
}

function bakedMaterial(src, perVertex) {
  // Already unlit (the glowing embers, the dark corridor, the doorway glow
  // card): keep as is.
  if (src.isMeshBasicMaterial) return src;
  const m = new THREE.MeshBasicMaterial({
    map: src.map ?? null,
    color: src.color ? src.color.clone() : new THREE.Color(1, 1, 1),
    vertexColors: perVertex,
    side: src.side,
    alphaTest: src.alphaTest,
    transparent: src.transparent,
    fog: false,
  });
  if (!perVertex) m.color.multiplyScalar(INSTANCED_SHADE);
  return m;
}

// Fraction of the flat temple's width. Luke, 2026-10-06: 80% (picked with a
// temporary slider, since removed).
const SIZE = 0.8;

let prebuilt = null;
/**
 * Builds the temple (shapes, small textures, baked lighting) without placing
 * it anywhere, and keeps it for placeTemple3d(). Safe to call more than once.
 *
 * Exists so the build can happen EARLY, not at round start. Nothing about
 * the temple depends on the round (teams, words, route): every round's temple
 * is identical. Luke, 2026-10-06: start it once a player has chosen their
 * avatar, while they wait to be put into a game. It freezes the page for its
 * duration (under a second on a decent device), so it belongs at a quiet
 * moment like that, never mid-animation.
 *
 * Texture files load through their own loader, not Sky Path's
 * LoadingManager: when this runs before Sky Path exists there is no manager,
 * and when it runs after Sky Path's loading has finished, adding to that
 * manager would fire its onLoad again (which builds the journey). The files
 * are 79 KB, so they arrive a moment later and simply appear.
 */
export function prebuildTemple() {
  if (prebuilt) return prebuilt;
  const t0 = performance.now();
  // The slow noise textures come from files (pre-generated, ~80 KB of WebP
  // in public/textures/temple3d/ — see exportTextures.js) rather than being
  // drawn here, which was ~88% of the build.
  const temple = buildTemple({
    quality: 'mobile',
    lights: false,
    shadows: false,
    textureFiles: { base: 'textures/temple3d/' },
  });
  const buildMs = performance.now() - t0;

  // Bake. Done before placing: only a normal's direction matters, and the
  // uniform scale applied later doesn't change that.
  const t1 = performance.now();
  temple.root.updateMatrixWorld(true);
  temple.root.traverse((o) => {
    if (!o.isMesh || o.isSprite) return;
    const src = o.material;
    const perVertex = !o.isInstancedMesh && bakeVertexLight(o);
    o.material = bakedMaterial(src, perVertex);
    if (o.material !== src) src.dispose();
  });
  const bakeMs = performance.now() - t1;
  prebuilt = { temple, buildMs, bakeMs };
  return prebuilt;
}

/**
 * Places the (pre)built temple in Sky Path's scene and adds the test panel.
 * @param {THREE.Scene} scene
 * @param {object} o
 * @param {number} o.width    the flat temple's world width (SIZE is relative to it)
 * @param {number} o.stairsZ  world z the foot of the stairs should sit at
 * @param {HTMLElement} o.container  where the test panel goes
 * @param {THREE.WebGLRenderer} o.renderer  for the frame-cost measurement
 * @param {THREE.Camera} o.camera            ditto
 */
export function placeTemple3d(scene, { width, stairsZ, container, renderer, camera }) {
  const { temple, buildMs, bakeMs } = prebuildTemple();

  const root = temple.root;
  const holder = new THREE.Group();
  holder.name = 'Temple3dTest';
  holder.add(root);
  scene.add(holder);

  // Width measured off the built geometry (static meshes only — the smoke
  // sprites sit at the origin until their first update). The foot of the
  // stairs stays just past the walk's stop point whatever the size.
  const box = new THREE.Box3().setFromObject(root.getObjectByName('TempleStatic'));
  const S = (width * SIZE) / (box.max.x - box.min.x);
  holder.scale.setScalar(S);
  holder.position.set(0, 0, stairsZ - TEMPLE_LAYOUT.stairsBottomZ * S);

  const stats = temple.stats();
  const doors = temple.doors;
  const tm = temple.timings;

  // ------------------------------------------------------------ test panel
  const panel = document.createElement('div');
  panel.style.cssText =
    'position:absolute;top:8px;left:8px;z-index:50;background:rgba(20,14,18,0.82);color:#fff;' +
    'font:12px/1.45 system-ui,sans-serif;padding:8px 10px;border-radius:8px;max-width:240px;pointer-events:auto';
  const stop = (el) => ['pointerdown', 'pointermove', 'pointerup', 'click'].forEach((ev) => el.addEventListener(ev, (e) => e.stopPropagation()));
  stop(panel);
  const btn = (label, fn) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = 'margin:4px 4px 0 0;padding:4px 8px;font:12px system-ui;border-radius:6px;border:0;cursor:pointer';
    b.addEventListener('click', () => fn(b));
    return b;
  };
  const info = document.createElement('div');
  info.innerHTML =
    `<b>3D temple test</b><br>` +
    `Build (on Start): <b>${Math.round(buildMs + bakeMs)} ms</b><br>` +
    `&nbsp; shapes ${Math.round(tm.geometry)} ms · small textures ${Math.round(tm.textures)} ms · ` +
    `lighting bake ${Math.round(bakeMs)} ms<br>` +
    `&nbsp; texture files: <span class="t3dFiles">loading…</span><br>` +
    `Triangles: <b>${Math.round(stats.triangles / 1000)}k</b> · draw calls: <b>${stats.drawCalls}</b> · ` +
    `size ${Math.round(SIZE * 100)}%`;
  const result = document.createElement('div');
  panel.append(
    info,
    btn('Temple: on', (b) => {
      holder.visible = !holder.visible;
      b.textContent = holder.visible ? 'Temple: on' : 'Temple: off';
    }),
    btn('Measure frame cost', () => startMeasure()),
    result,
  );
  container.appendChild(panel);

  // Size of the texture files. Read from the files themselves (the browser
  // cache answers these from memory): the browser's own download record
  // shows ~0 bytes for anything it re-used from cache, which misreports it.
  const filesOut = panel.querySelector('.t3dFiles');
  Promise.all(FILE_TEXTURES.map((n) => fetch(`textures/temple3d/${n}.webp`).then((r) => r.blob())))
    .then((blobs) => {
      const kb = blobs.reduce((a, b) => a + b.size, 0) / 1024;
      filesOut.textContent = `${blobs.length} WebP, ${Math.round(kb)} KB`;
    })
    .catch(() => (filesOut.textContent = 'size unknown'));

  // ------------------------------------------------------------ frame cost
  // Renders the current view on the spot, 60 frames with the temple and 60
  // without, each forced to finish on the GPU (a 1-pixel read) so the number
  // is the real drawing cost, not just how long the work took to queue. The
  // game freezes for a few seconds while it runs; that's expected. Done
  // outside the game loop so it measures exactly one frozen view (mid-walk,
  // mid-ending, anywhere), whatever the loop is doing.
  const MEASURE_FRAMES = 60;
  const px = new Uint8Array(4);
  function timeFrames(visible) {
    holder.visible = visible;
    const gl = renderer.getContext();
    renderer.render(scene, camera); // warm-up, not counted
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const t = performance.now();
    for (let i = 0; i < MEASURE_FRAMES; i++) {
      renderer.render(scene, camera);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    }
    return (performance.now() - t) / MEASURE_FRAMES;
  }
  function startMeasure() {
    const wasVisible = holder.visible;
    const on = timeFrames(true);
    const off = timeFrames(false);
    holder.visible = wasVisible;
    result.innerHTML =
      `Render, this view:<br>` +
      `with temple <b>${on.toFixed(1)} ms</b>, without <b>${off.toFixed(1)} ms</b><br>` +
      `temple costs <b>${(on - off).toFixed(1)} ms</b> per frame`;
    return { on, off };
  }
  if (import.meta.env.DEV) window.__temple3dMeasure = startMeasure;

  return {
    holder,
    /** Walkable height at a world (x, z): the stairs and platform. */
    floorAt(x, z) {
      const lx = x / S;
      const lz = (z - holder.position.z) / S;
      return temple.floorHeightAt(lx, lz) * S;
    },
    openDoors(duration) {
      doors.duration = duration;
      temple.openDoors();
    },
    resetDoors() {
      temple.setDoorsOpen(false);
    },
    update(dt) {
      temple.update(dt);
    },
  };
}
