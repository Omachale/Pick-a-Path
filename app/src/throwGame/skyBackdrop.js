/**
 * Sky Path's backdrop, meaning the land/sea floor far below, the curved sky,
 * the two wind-driven cloud sheets and the distant cloud decks, rebuilt for
 * the island-throwing minigame's own scene.
 *
 * COPIED, not imported: in skyPath.js these are closures inside mountSkyPath()
 * (deck, skyShell, windLayer, punchHoles, updateWindClouds) and depend on its
 * internal state, so they can't be imported without refactoring the game
 * file. Every number here is Sky Path's own value as of 2026-09-29, and
 * skyPath.js remains the source of truth. If this minigame goes into the game
 * proper, extract these into one shared module that both use, rather than
 * keeping two copies. That's flagged in TODO.md.
 *
 * One deliberate difference: the cloud sheets can drift WITH the course's
 * wind (setWind), instead of Sky Path's fixed right-to-left breeze. That gives
 * players a second wind cue alongside the flag.
 */
import * as THREE from 'three';

const FLOOR_Y = -40;
const HORIZON_Z = -360;
const LANDSEA_D = 562;
const LANDSEA_TILES = 4;
const SKY_R = 400;
const SKY_ARC = 160;
const SKY_ASPECT = 8000 / 3 / 2000;
const SKY_H = (SKY_R * THREE.MathUtils.degToRad(SKY_ARC)) / SKY_ASPECT;

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

// Sky Path's time-of-day grading (applyAtmosphere / applySun in skyPath.js).
// Players reach the temple at dusk, sunP = 1.
const TINT = { dawn: 0xecd0bf, noon: 0xffffff, dusk: 0xe7c9bd };
const CLEAR = { dawn: 0x6b4a5a, noon: 0x1d3f66, dusk: 0x5a3a52 };
function lerp3(p, a, b, c) {
  const ca = new THREE.Color(a), cb = new THREE.Color(b), cc = new THREE.Color(c);
  return p < 0.5 ? ca.lerp(cb, p * 2) : cb.lerp(cc, (p - 0.5) * 2);
}

export function createSkyBackdrop(scene, renderer, loadTex) {
  const rig = new THREE.Group();
  scene.add(rig);
  const tinted = [];

  function deck(map, { w, d, y, z, repeat, order, opacity, tint = true, mirror = false, parent = rig }) {
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
    if (tint) tinted.push(mesh.material);
    return mesh;
  }

  const tex = {
    sky: loadTex('skybig', { ext: 'webp' }),
    landSea: loadTex('landsea', { ext: 'webp' }),
    cloudDense: loadTex('cloud-dense', { ext: 'webp', tile: true }),
    cloudLight: loadTex('cloud-light', { tile: true }),
    cloudDeck: loadTex('cloud-deck', { repeatWrap: true }),
  };

  deck(tex.landSea, {
    w: LANDSEA_D * LANDSEA_TILES, d: LANDSEA_D, y: FLOOR_Y, z: HORIZON_Z + LANDSEA_D / 2,
    repeat: [LANDSEA_TILES, 1], mirror: true, order: 0.5, opacity: 1,
  });

  tex.sky.wrapS = THREE.ClampToEdgeWrapping;
  tex.sky.repeat.set(1 / 3, 1);
  const arc = THREE.MathUtils.degToRad(SKY_ARC);
  const sky = new THREE.Mesh(
    new THREE.CylinderGeometry(1, 1, 1, 96, 1, true, Math.PI - arc / 2, arc),
    new THREE.MeshBasicMaterial({ map: tex.sky, transparent: true, depthWrite: false, fog: false, side: THREE.BackSide })
  );
  sky.scale.set(SKY_R, SKY_H, SKY_R);
  sky.position.set(0, FLOOR_Y - 10 + SKY_H / 2, 0);
  sky.renderOrder = 0.6;
  rig.add(sky);

  // distant decks, fixed in the world like Sky Path's
  deck(tex.cloudDeck, { w: 1800, d: 1200, y: -95, z: -800, repeat: [18, 12], order: 3, opacity: 0.55, parent: scene });
  deck(tex.cloudDeck, { w: 900, d: 620, y: -40, z: -390, repeat: [11, 8], order: 4, opacity: 0.75, parent: scene });

  function punchHoles(mesh) {
    const held = {
      uCellSize: { value: new THREE.Vector2(WIND_TILE_W, WIND_TILE_D) },
      uCellPan: { value: new THREE.Vector2() },
      uHoleCut: { value: 0 },
      uStagger: { value: 0.5 },
    };
    const mat = mesh.material;
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

  function windLayer(map, other, { y, order, opacity, gaps, chaos }) {
    const passes = WIND_PASSES.map((cfg, i) => {
      const tileW = WIND_TILE_W * cfg.scale;
      const tileD = WIND_TILE_D * cfg.scale;
      const rx = (cfg.mirror ? -1 : 1) * (WIND_EXTENT / tileW);
      const ry = WIND_EXTENT / tileD;
      const mesh = deck(cfg.swap ? other : map, {
        w: WIND_EXTENT, d: WIND_EXTENT, y: y + cfg.dy, z: 0, repeat: [rx, ry],
        order: order + i * 0.05, opacity: opacity * cfg.alpha, tint: false,
      });
      const holes = punchHoles(mesh);
      holes.uHoleCut.value = gaps > 0 ? 1 / gaps : 0;
      return { rx, ry, phase: cfg.phase, mesh, holes };
    });
    passes[passes.length - 1].mesh.material.opacity = chaos;
    return passes;
  }

  // Sky Path's baked values (skyPath.js, 2026-08-26 tuning)
  const layers = [
    { passes: windLayer(tex.cloudDense, tex.cloudLight, { y: -16.9, order: 5, opacity: 1, gaps: 4, chaos: 0.5 }), speed: 1.6, blown: new THREE.Vector2() },
    { passes: windLayer(tex.cloudLight, tex.cloudDense, { y: -20.6, order: 5.2, opacity: 0.9, gaps: 2, chaos: 0.5 }), speed: 5.0, blown: new THREE.Vector2() },
  ];

  // Unit wind direction on the XZ plane. Sky Path's own breeze runs right to
  // left across a -z-facing player, i.e. toward -x.
  const windDir = new THREE.Vector2(-1, 0);
  let windSpeedScale = 1;

  return {
    rig,
    /** Makes the cloud sheets drift with the course's wind. Pass null to go back to Sky Path's default breeze. */
    setWind(windVec, strengthScale = 0.35) {
      if (!windVec || windVec.lengthSq() < 1e-6) {
        windDir.set(-1, 0);
        windSpeedScale = windVec ? 0.15 : 1; // calm course: a barely-moving drift
        return;
      }
      windDir.set(windVec.x, windVec.z).normalize();
      // Sky Path's sheets move at 1.6 / 5.0 u/s. Scale them by the wind strength
      // so a gale visibly races and a breeze barely drifts.
      windSpeedScale = windVec.length() * strengthScale;
    },
    /** Sky Path's time of day: 0 dawn, 0.5 noon, 1 dusk. */
    setTimeOfDay(p) {
      tex.sky.offset.x = THREE.MathUtils.lerp(0, 2 / 3, p);
      const tint = lerp3(p, TINT.dawn, TINT.noon, TINT.dusk);
      for (const m of tinted) m.color.copy(tint);
      renderer.setClearColor(lerp3(p, CLEAR.dawn, CLEAR.noon, CLEAR.dusk));
    },
    update(dt, camera) {
      rig.position.set(camera.position.x, 0, camera.position.z);
      const { x: cx, z: cz } = camera.position;
      for (const layer of layers) {
        // Blown distance accumulates along the wind direction, in world units,
        // then feeds the same world-locked offset maths Sky Path uses.
        layer.blown.addScaledVector(windDir, layer.speed * windSpeedScale * dt);
        for (const p of layer.passes) {
          const o = p.mesh.material.map.offset;
          // Sky Path's sign convention (see skyPath.js updateWindClouds):
          // raising offset.x drags the image toward -x, and raising offset.y
          // drags it toward +z (deck() maps texture +v to world -z). So wind
          // travelling +x needs offset.x to FALL, and wind travelling +z needs
          // offset.y to RISE. Hence the opposite signs on blown below.
          o.x = (p.rx / WIND_EXTENT) * (cx - layer.blown.x) + p.phase[0];
          o.y = (-p.ry / WIND_EXTENT) * (cz - layer.blown.y) + p.phase[1];
          p.holes.uCellPan.value.set(-layer.blown.x, -layer.blown.y);
        }
      }
    },
  };
}
