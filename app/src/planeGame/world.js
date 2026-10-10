/**
 * The setting: Sky Path's own dusk sky, cloud sheets and Temple Island, with
 * the thrower standing on the island's rim looking out over open sky.
 *
 * What's shared with Sky Path and how:
 *  - Art: the same files (skybig.jpg, landsea.jpg, cloud-dense/-light,
 *    cloud-deck, temple.webp, models/temple-island.glb), loaded from
 *    public/ as Sky Path loads them.
 *  - The Temple Island's size and the temple's placement on it are Sky
 *    Path's own numbers (TEMPLE_* below, derived the same way as in
 *    skyPath.js), so it is the same island at the same scale.
 *  - Code: the cloud sheets (windLayer, the hole punch and running-bond
 *    shader patches) and the deck/shell helpers are COPIED from skyPath.js,
 *    not imported. In Sky Path they live inside mountSkyPath's closure,
 *    tangled up with its camera, its day-cycle tint list and its tuner, so
 *    importing them meant restructuring a 9000-line file that another chat
 *    is working beside. The copies are marked; extracting them into a
 *    shared module is a clean follow-up once that's safe.
 *
 * Differences from Sky Path, on purpose:
 *  - The sky is a full ring, not a 160 degree arc: this game looks both out
 *    over the void and back at the temple. The ring is the dusk third of the
 *    same strip, with its mirror image filling the far side, and the mirrored
 *    sun painted out so there's only ever one sun (behind the temple).
 *  - The cloud sheets blow with THIS game's wind (direction and strength),
 *    so the weather below is one of the ways to read the wind.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

// Sky Path's temple sizing (skyPath.js: TEMPLE_DISTANCE, TEMPLE_H,
// TEMPLE_ASPECT and the island's 1.5x-temple-width scale), worked through
// for its 6 forks: FORK_DISTANCE 17.6, so TEMPLE_DISTANCE 140.8.
const TEMPLE_DISTANCE = 140.8;
const TEMPLE_ASPECT = 1024 / 463;
const TEMPLE_H = 13 * 1.5 * (TEMPLE_DISTANCE / 70);
const TEMPLE_W = TEMPLE_H * TEMPLE_ASPECT;

/**
 * Where the light comes from: the painted sun's own bearing (behind the
 * temple and to the thrower's right as they face out; three's azimuth, 0 =
 * +z, positive toward +x), but higher than the painted sun, which sits on
 * the horizon. Lit from that low, every deck would be in shadow; at this
 * height the decks catch the light and still read as evening.
 */
export const SUN = { azimuth: -0.88, elevation: 0.62 };

/**
 * The ring of sky: the dusk third of Sky Path's strip all the way round,
 * composed on a canvas once at load. See the header for why it's a ring.
 *
 * Cylinder UVs run with azimuth (three's CylinderGeometry: theta 0 at +z,
 * pi/2 at +x), and seen from INSIDE that reads right-to-left, so the half
 * that must look the right way round (the sun half, seen when looking back
 * at the temple) is drawn flipped, and the far half is drawn unflipped:
 * that's what makes the two halves meet seamlessly, edge to matching edge.
 */
function composeSkyRing(img) {
  const W = 4096;
  const H = 1024;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');
  // The dusk third of the 8000x2000 strip.
  const sx = 5333;
  const sw = 2667;
  const half = W / 2;
  // Sun half: centred on u = 0 (straight back, +z), flipped, wrapping.
  for (const x0 of [-half / 2, W - half / 2]) {
    g.save();
    g.translate(x0 + half, 0);
    g.scale(-1, 1);
    g.drawImage(img, sx, 0, sw, 2000, 0, 0, half, H);
    g.restore();
  }
  // Far half: centred on u = 0.5 (straight out, -z), unflipped.
  g.drawImage(img, sx, 0, sw, 2000, half / 2, 0, half, H);
  // Paint its sun out: the same rows from further left (pure cloud), laid
  // over the sun with soft edges, fading to nothing before the seam so the
  // two halves still meet exactly.
  const patch = document.createElement('canvas');
  patch.width = half;
  patch.height = H;
  const p = patch.getContext('2d');
  p.drawImage(img, sx - sw * 0.36, 0, sw, 2000, 0, 0, half, H);
  p.globalCompositeOperation = 'destination-in';
  const gx = p.createLinearGradient(0, 0, half, 0);
  gx.addColorStop(0.5, 'rgba(0,0,0,0)');
  gx.addColorStop(0.6, 'rgba(0,0,0,1)');
  gx.addColorStop(0.9, 'rgba(0,0,0,1)');
  gx.addColorStop(0.985, 'rgba(0,0,0,0)');
  p.fillStyle = gx;
  p.fillRect(0, 0, half, H);
  p.globalCompositeOperation = 'destination-in';
  const gy = p.createLinearGradient(0, 0, 0, H);
  gy.addColorStop(0.35, 'rgba(0,0,0,0)');
  gy.addColorStop(0.55, 'rgba(0,0,0,1)');
  p.fillStyle = gy;
  p.fillRect(0, 0, half, H);
  g.drawImage(patch, half / 2, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
}

// ------------------------------------------------- copied from skyPath.js
// deck(), the wind cloud sheets and their shader patches. See the header for
// why these are copies. Comments trimmed to what matters here; the full
// reasoning is beside the originals in skyPath.js.

function deck(map, { w, d, y, z = 0, repeat, order, opacity, mirror = false, parent }) {
  const m = map.clone();
  m.needsUpdate = true;
  m.wrapS = m.wrapT = mirror ? THREE.MirroredRepeatWrapping : THREE.RepeatWrapping;
  m.repeat.set(repeat[0], repeat[1]);
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(w, d),
    new THREE.MeshBasicMaterial({ map: m, transparent: true, depthWrite: false, opacity, fog: false })
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(0, y, z);
  mesh.renderOrder = order;
  parent.add(mesh);
  return mesh;
}

const WIND_TILE_W = 60;
const WIND_TILE_D = WIND_TILE_W / (2400 / 1309);
const WIND_EXTENT = 1400;
const WIND_PASSES = [
  { scale: 1, mirror: false, phase: [0, 0], dy: 0, alpha: 0.78, swap: false },
  { scale: 1.47, mirror: true, phase: [0.37, 0.61], dy: -0.9, alpha: 0.62, swap: false },
  { scale: 4.3, mirror: false, phase: [0.13, 0.29], dy: -2.2, alpha: 0.5, swap: true },
];
const HOLE_GLSL_HEAD = `
  varying vec2 vCloudXZ;
  uniform vec2 uCellSize;
  uniform vec2 uCellPan;
  uniform float uHoleCut;
  uniform float uStagger;
  float cloudHash(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }
`;
const HOLE_GLSL_BODY = `
  if (uHoleCut > 0.0) {
    vec2 q = (vCloudXZ + uCellPan) / uCellSize;
    q.x += uStagger * mod(floor(q.y), 2.0);
    vec2 cell = vec2(floor(q.x), floor(q.y));
    if (cloudHash(cell) < uHoleCut) {
      vec2 centre = vec2(cloudHash(cell + 11.3), cloudHash(cell + 27.7)) * 0.5 + 0.25;
      float radius = 0.30 + 0.18 * cloudHash(cell + 5.1);
      float d = length(fract(q) - centre);
      diffuseColor.a *= smoothstep(radius * 0.55, radius, d);
    }
  }
`;
const STAGGER_GLSL = `
  #ifdef USE_MAP
    vec2 stagUv = vMapUv;
    stagUv.x += uStagger * mod(floor(stagUv.y), 2.0);
    #if __VERSION__ >= 300
      diffuseColor *= textureGrad( map, stagUv, dFdx( vMapUv ), dFdy( vMapUv ) );
    #else
      diffuseColor *= texture2D( map, stagUv );
    #endif
  #endif
`;

function punchHoles(mesh) {
  const mat = mesh.material;
  const held = {
    uCellSize: { value: new THREE.Vector2(WIND_TILE_W, WIND_TILE_D) },
    uCellPan: { value: new THREE.Vector2() },
    uHoleCut: { value: 0 },
    uStagger: { value: 0.5 },
  };
  mat.customProgramCacheKey = () => 'windCloudHoles';
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, held);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vCloudXZ;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvCloudXZ = (modelMatrix * vec4(transformed, 1.0)).xz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>' + HOLE_GLSL_HEAD)
      .replace('#include <map_fragment>', STAGGER_GLSL)
      .replace('#include <alphatest_fragment>', HOLE_GLSL_BODY + '#include <alphatest_fragment>');
  };
  return held;
}

function windLayer(map, other, { y, order, opacity, parent }) {
  const passes = WIND_PASSES.map((cfg, i) => {
    const tileW = WIND_TILE_W * cfg.scale;
    const tileD = WIND_TILE_D * cfg.scale;
    const rx = (cfg.mirror ? -1 : 1) * (WIND_EXTENT / tileW);
    const ry = WIND_EXTENT / tileD;
    const mesh = deck(cfg.swap ? other : map, {
      w: WIND_EXTENT,
      d: WIND_EXTENT,
      y: y + cfg.dy,
      repeat: [rx, ry],
      order: order + i * 0.05,
      opacity: opacity * cfg.alpha,
      parent,
    });
    return { rx, ry, phase: cfg.phase, mesh, holes: punchHoles(mesh) };
  });
  return {
    passes,
    set gaps(n) {
      for (const p of passes) p.holes.uHoleCut.value = n > 0 ? 1 / n : 0;
    },
    set chaos(v) {
      passes[passes.length - 1].mesh.material.opacity = v;
    },
  };
}
// ------------------------------------------------- end of copied code

/**
 * Builds the world into `scene`. Returns update(dt, camera, wind) for the
 * frame loop, and a promise that resolves once the Temple Island is in.
 */
export function buildWorld({ scene, renderer, manager }) {
  const loader = new THREE.TextureLoader(manager);
  const tex = (path, { tile = false, repeatWrap = false } = {}) => {
    const t = loader.load(path);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
    if (repeatWrap) t.wrapS = THREE.RepeatWrapping;
    if (tile) t.wrapS = t.wrapT = THREE.RepeatWrapping;
    return t;
  };

  // Everything far away rides a rig that follows the camera in x/z, as in
  // Sky Path, so the horizon holds still while the camera moves around.
  const rig = new THREE.Group();
  scene.add(rig);

  // --- sky ring
  const SKY_R = 420;
  const SKY_H = (SKY_R * Math.PI) / (4 / 3); // each half is one 4:3 third, undistorted
  const FLOOR_Y = -40;
  const skyMat = new THREE.MeshBasicMaterial({ side: THREE.BackSide, fog: false, depthWrite: false });
  const sky = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 128, 1, true), skyMat);
  sky.scale.set(SKY_R, SKY_H, SKY_R);
  sky.position.y = FLOOR_Y - 10 + SKY_H / 2;
  sky.renderOrder = 0.6;
  rig.add(sky);
  const skyImg = new Image();
  manager.itemStart('sky-ring');
  skyImg.onload = () => {
    skyMat.map = composeSkyRing(skyImg);
    skyMat.needsUpdate = true;
    manager.itemEnd('sky-ring');
  };
  skyImg.onerror = () => manager.itemError('sky-ring');
  skyImg.src = 'textures/skybig.webp';

  // --- the land and sea far below (Sky Path's land/sea deck, tiled all round)
  const LANDSEA_D = 562;
  deck(tex('textures/landsea.webp'), {
    w: LANDSEA_D * 5,
    d: LANDSEA_D * 5,
    y: FLOOR_Y,
    z: -LANDSEA_D * 0.5,
    repeat: [5, 5],
    mirror: true,
    order: 0.5,
    opacity: 1,
    parent: rig,
  });

  // --- distant cloud decks (Sky Path's deckDeep / deckHigh)
  const cloudDeckTex = tex('textures/cloud-deck.webp', { repeatWrap: true });
  deck(cloudDeckTex, { w: 1800, d: 1200, y: -95, z: -800, repeat: [18, 12], order: 3, opacity: 0.55, parent: rig });
  deck(cloudDeckTex, { w: 900, d: 620, y: -40, z: -390, repeat: [11, 8], order: 4, opacity: 0.75, parent: rig });

  // --- the two wind sheets just below, Sky Path's tuned values
  const cloudDenseTex = tex('textures/cloud-dense.webp', { tile: true });
  const cloudLightTex = tex('textures/cloud-light.webp', { tile: true });
  const cloudDense = windLayer(cloudDenseTex, cloudLightTex, { y: -16.9, order: 5, opacity: 1, parent: rig });
  const cloudLight = windLayer(cloudLightTex, cloudDenseTex, { y: -20.6, order: 5.2, opacity: 0.9, parent: rig });
  cloudDense.gaps = 4;
  cloudLight.gaps = 2;
  cloudDense.chaos = 0.5;
  cloudLight.chaos = 0.5;
  const blown = { dense: { x: 0, z: 0 }, light: { x: 0, z: 0 } };

  // --- the temple and its island
  //
  // Built in Sky Path's own frame (temple at the origin facing +z, island
  // centred 3 behind it, Sky Path's scale), inside a group that is then
  // turned to face out (-z) and slid so the island's front rim sits just in
  // front of the thrower's feet at the world origin.
  const templeGroup = new THREE.Group();
  templeGroup.rotation.y = Math.PI;
  scene.add(templeGroup);
  const templeTex = tex('textures/temple.webp');
  const temple = new THREE.Mesh(
    new THREE.PlaneGeometry(TEMPLE_W, TEMPLE_H),
    new THREE.MeshBasicMaterial({ map: templeTex, transparent: true, alphaTest: 0.45, side: THREE.DoubleSide, fog: false })
  );
  temple.position.set(0, TEMPLE_H / 2, 0);
  temple.renderOrder = 4.5;
  templeGroup.add(temple);

  const rim = { ready: false, deckY: 0 };
  const templeReady = new Promise((resolve) => {
    new GLTFLoader(manager).load('models/temple-island.glb', (gltf) => {
      const island = gltf.scene;
      // Unlit, exactly as Sky Path converts it (its textures carry their own
      // shading; lit, it renders dark).
      island.traverse((o) => {
        if (!o.isMesh) return;
        const src = o.material;
        o.material = new THREE.MeshBasicMaterial({
          map: src.map ?? null,
          color: src.color ? src.color.clone() : undefined,
          vertexColors: src.vertexColors,
          side: src.side,
        });
      });
      const box = new THREE.Box3().setFromObject(island);
      const width = Math.max(box.max.x - box.min.x, box.max.z - box.min.z);
      const s = (TEMPLE_W * 1.5) / width;
      island.position.set(0, 0, -3);
      island.scale.set(s * 1.05, s * 0.55, s * 0.5);
      templeGroup.add(island);
      templeGroup.updateMatrixWorld(true);

      // Find the island's front rim along the line straight out from the
      // temple: step outward, casting down, until there's no deck below.
      const ray = new THREE.Raycaster();
      const down = new THREE.Vector3(0, -1, 0);
      const local = new THREE.Vector3();
      let lastHit = null;
      for (let d = 0; d < 120; d += 0.25) {
        local.set(0, 30, d);
        const worldPos = templeGroup.localToWorld(local.clone());
        ray.set(worldPos, down);
        const hit = ray.intersectObject(island, true)[0];
        if (!hit) break;
        lastHit = { d, y: hit.point.y };
      }
      // Stand 1.2 inside the rim, at the deck's height there; shift the
      // whole temple group so that spot is the world origin.
      const standD = (lastHit?.d ?? 30) - 1.2;
      local.set(0, 0, standD);
      const standWorld = templeGroup.localToWorld(local.clone());
      ray.set(standWorld.clone().setY(40), down);
      const hit = ray.intersectObject(island, true)[0];
      const deckY = hit ? hit.point.y : 0;
      templeGroup.position.x -= standWorld.x;
      templeGroup.position.z -= standWorld.z;
      templeGroup.position.y -= deckY;
      templeGroup.updateMatrixWorld(true);
      rim.ready = true;
      rim.edgeAhead = 1.2;
      rim.island = island;
      if (import.meta.env.DEV) window.__templeIsland = island;
      resolve(rim);
    });
  });

  // --- light: one warm sun from behind the temple, and a sky/ground fill.
  // Only the planes, the target islands and the thrower's props are lit;
  // the sky, clouds and Temple Island stay unlit as in Sky Path.
  const sun = new THREE.DirectionalLight(0xffd9b0, 2.4);
  const sunDir = new THREE.Vector3(
    Math.sin(SUN.azimuth) * Math.cos(SUN.elevation),
    Math.sin(SUN.elevation),
    Math.cos(SUN.azimuth) * Math.cos(SUN.elevation)
  );
  sun.position.copy(sunDir).multiplyScalar(100);
  scene.add(sun);
  scene.add(sun.target);
  const hemi = new THREE.HemisphereLight(0xc6d2ff, 0x7a5466, 1.1);
  scene.add(hemi);

  // A soft dusk haze for depth: far islands sink a little into the sky.
  scene.fog = new THREE.Fog(0xcf9a8a, 70, 260);
  renderer.setClearColor(0x5a3a52, 1);

  function update(dt, camera, wind) {
    rig.position.set(camera.position.x, 0, camera.position.z);
    // Clouds blow with the game's wind, faster than it so the movement reads
    // from up here; the lower sheet slower, as in Sky Path.
    const k = { dense: 1.6, light: 3.2 };
    for (const [layer, key] of [
      [cloudDense, 'dense'],
      [cloudLight, 'light'],
    ]) {
      const b = blown[key];
      b.x += wind.x * k[key] * dt;
      b.z += wind.z * k[key] * dt;
      const cx = camera.position.x;
      const cz = camera.position.z;
      for (const p of layer.passes) {
        const o = p.mesh.material.map.offset;
        o.x = (p.rx / WIND_EXTENT) * (cx - b.x) + p.phase[0];
        o.y = (-p.ry / WIND_EXTENT) * (cz - b.z) + p.phase[1];
        p.holes.uCellPan.value.set(-b.x, -b.z);
      }
    }
  }

  return { update, templeReady, rim, sun, sunDir, hemi, temple, templeGroup };
}
