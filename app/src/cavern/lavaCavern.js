/**
 * The Lava Cavern — stage 2, and for now a PERFORMANCE SPIKE, not a game.
 *
 * Luke, 2026-09-08: "the first thing we can build will be the cavern with the
 * max number of islands in it, and the player moving forward on their island
 * chain, as in Skypath? That will let us test it on my phone and get some
 * idea of performance issues, and maybe check out other visual issues."
 *
 * The one number this exists to answer: Sky Path's fog curtains mean only
 * about one or two islands and two bridges are ever on screen at once. A
 * four-spoke cavern puts roughly 25 islands and 48 bridges in view
 * simultaneously, inside a 200-unit dome. That is ten to twenty times the
 * visible content, and no amount of reasoning settles whether a mid-range
 * phone can draw it — so this draws it, at full detail, and reports fps and
 * draw calls on screen. **Deliberately no LOD yet**: measure the naive worst
 * case first, then decide whether lower-detail distant assets are needed at
 * all.
 *
 * Deliberately a SEPARATE module rather than a mode flag threaded through
 * skyPath.js — Luke, on whether the two stages should share code today:
 * "Make it a separate thing for now and we'll stitch them together once
 * they're ready." skyPath.js is ~5,500 lines and deeply entangled with sky,
 * sun, temple and curtains; adding a second world to it would put a working,
 * just-polished game at risk to answer a question that doesn't need it. What
 * IS shared is what actually costs frames: the same island model, the same
 * `buildBridge` from bridgeGen.js, the same plank meshes. Those are imported,
 * so the thing being measured here is the real thing.
 *
 * What this is NOT, all on purpose: no networking, no other players, no
 * questions or word signs, no falling, no jetpack, no objective at the
 * centre. Those are the next decisions, and none of them change the fill
 * cost this is measuring.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { buildBridge, disposeBridge, BRIDGE_DEFAULTS, BRIDGE_ANCHORS } from '../skypath/bridgeGen.js';
import { createBridgeWind } from '../skypath/bridgeWind.js';
import { attachBgTuner } from '../skypath/bgTuner.js';

export const CAVERN_CHROME = `
<div id="cavLoader">Loading cavern…</div>
<div id="cavStats">—</div>
<button id="cavAdvance" title="Hold to walk">▲</button>
`;

export const CAVERN_CSS = `
.cavern-surface {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: #180703;
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  -webkit-user-select: none;
  user-select: none;
  -webkit-tap-highlight-color: transparent;
  overscroll-behavior: none;
}
.cavern-surface canvas { display: block; touch-action: none; }
.cavern-surface #cavStats {
  position: absolute;
  top: calc(env(safe-area-inset-top, 0px) + 8px);
  left: 8px;
  z-index: 10;
  font: 500 11px/1.6 ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  color: #ffe9b8;
  background: rgba(20, 6, 2, 0.6);
  padding: 7px 10px;
  border-radius: 8px;
  pointer-events: none;
  white-space: pre;
}
.cavern-surface #cavAdvance {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  bottom: calc(env(safe-area-inset-bottom, 0px) + 16px);
  z-index: 10;
  width: 78px;
  height: 78px;
  border: 0;
  border-radius: 50%;
  font-size: 30px;
  color: #2a0f06;
  background: #ffcf8a;
  box-shadow: 0 3px 14px rgba(0, 0, 0, 0.5);
}
.cavern-surface #cavAdvance:active { transform: translateX(-50%) translateY(2px); }
.cavern-surface #cavLoader {
  position: absolute;
  inset: 0;
  z-index: 50;
  display: grid;
  place-content: center;
  background: #180703;
  color: #ffe9b8;
  font: 500 13px/1.4 system-ui, sans-serif;
  transition: opacity 0.4s ease;
}
.cavern-surface #cavLoader.done { opacity: 0; pointer-events: none; }
`;

export function mountLavaCavern(container, options = {}) {
  const { spokes: initialSpokes = 4 } = options;

  container.classList.add('cavern-surface');
  container.innerHTML = CAVERN_CHROME;
  if (!document.getElementById('cavern-css')) {
    const style = document.createElement('style');
    style.id = 'cavern-css';
    style.textContent = CAVERN_CSS;
    document.head.appendChild(style);
  }
  const $ = (id) => container.querySelector('#' + id);

  let disposed = false;
  let rafId = null;

  // ---------------------------------------------------------------- shape
  //
  // The dome is a unit hemisphere with its size baked into the node's own
  // scale, flat side down at y=0, apex cut at 0.98 for the vent hole, and
  // already double-sided so it renders from the inside. Its dimensions are
  // MEASURED after load rather than written down here: V3 was 200 across, V4
  // is 600, and Luke is still iterating on it. Everything below derives from
  // whatever turns up, so the next dome needs no code change at all.
  let domeRadius = 300; // overwritten from the loaded model's own bounding box
  let domeHeight = 299;

  // Locked in by Luke, 2026-09-10, after judging the spike on his own phone —
  // these are no longer first guesses. Kept as live sliders regardless (see
  // the tuner below), since the next dome/asset pass will likely want to
  // re-check them, but a fresh page load now starts here rather than at the
  // earlier work-in-progress numbers.
  const TUNE = {
    // Luke: the walk plane sits "perhaps 20 or 30% above the bottom of the
    // dome, where the lava will be". Held as a FRACTION so it tracks the dome
    // rather than needing re-tuning every time the dome grows.
    ringHeightFrac: 0.5,
    // Gap between adjacent island centres — i.e. how long a bridge is. This
    // is the primary size dial now, not the ring radius: Luke, 2026-09-09,
    // "make the bridge between the islands somewhat longer, but allow some
    // empty space between the starting point and the wall." The spoke's outer
    // end is then spacing × islandsPerSpoke, which in a 600-wide dome leaves
    // a wide lava moat between the rim island and the wall — the empty space
    // he's after, and most of where the sense of vastness comes from.
    spacing: 40,
    islandsPerSpoke: 6, // gaps to the centre; islands = this many per spoke, plus the shared centre one
    // Actors per spoke — a team's worth of independent players. The local
    // player is one of spoke 0's. Everyone else is a locally-simulated bot
    // standing in for a networked player; see the actor section below.
    playersPerSpoke: 4,
    // Time to cross one gap, NOT a speed — Luke: "make players move faster to
    // keep the time between island constant." Walk speed is derived from this
    // and `spacing` (see walkSpeed() below), so lengthening the bridges can
    // never quietly make the walk feel slower.
    secondsPerIsland: 5.2,
    // Pulled back from Sky Path's own 7.3 / 2.8 — Luke: "pull the camera back
    // a bit. Player's and islands should appear smaller."
    camBack: 9.5,
    camHeight: 3.8,
    // How strongly the LavaDark layer shows through the Lava1 base — Luke's
    // own "at least one with reduced alpha" idea. See the lava shader's own
    // header comment for the rest of the turbulence approach.
    lavaDarkAlpha: 0.4,
    lavaSpeed: 1, // multiplies both layers' drift speed together
    lavaScale: 1, // multiplies both layers' tile frequency together, same ratio preserved
  };
  let spokeCount = Math.max(1, Math.min(4, initialSpokes));

  const ringY = () => TUNE.ringHeightFrac * domeHeight;
  /** The dome's inner wall radius at the walk plane — the hard limit a spoke must stay inside. */
  const wallRadiusAtRing = () => Math.sqrt(Math.max(0, domeRadius * domeRadius - ringY() ** 2));
  const ringRadius = () => TUNE.spacing * TUNE.islandsPerSpoke;
  const walkSpeed = () => TUNE.spacing / TUNE.secondsPerIsland;

  const CAM_LOOK_Y = 0.9;
  const FIGURE_H = 2.2 * 0.8 * 0.72; // = Sky Path's FIGURE_H, so the avatar reads at the same size
  const FIGURE_ASPECT = 400 / 563;

  /** heading 0 = -Z, same convention as Sky Path's own `forward`. */
  const forward = (heading, d) => ({ x: Math.sin(heading) * d, z: -Math.cos(heading) * d });
  /**
   * Wraps an angle into (-π, π]. The textbook one-liner for this,
   * `((a + π) % 2π) - π`, silently fails for any `a` in (-2π, -π): it assumes
   * a FLOORED modulo (Python's `%`), but JS's `%` is a truncating remainder
   * that keeps the sign of its left operand — for a negative `a+π`, JS's `%`
   * just returns it unchanged, so the "wrap" does nothing and the result
   * stays near -2π instead of near 0. That was the cause of Luke's
   * 2026-09-10 report — "just as they reach the bridge, the camera quite
   * rapidly spins 360 degrees around the player" — only on the first
   * crossing: `facing` starts exactly at rest (freshly set by resetActor,
   * no easing yet), so the very first heading correction is the one most
   * likely to land in the broken range; every later correction is already
   * small because facing has been tracking closely. A plain conditional does
   * the same job without relying on modulo semantics at all.
   */
  function wrapAngle(a) {
    a = a % (Math.PI * 2);
    if (a > Math.PI) a -= Math.PI * 2;
    else if (a < -Math.PI) a += Math.PI * 2;
    return a;
  }
  /** Offset from a cursor by lateral (right) and forward amounts in its local frame. */
  function localToWorld(cursor, right, fwd) {
    const f = forward(cursor.heading, fwd);
    const r = forward(cursor.heading + Math.PI / 2, right);
    return { x: cursor.x + f.x + r.x, z: cursor.z + f.z + r.z };
  }

  // ---------------------------------------------------------------- renderer
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  const surfaceWidth = () => container.clientWidth || window.innerWidth;
  const surfaceHeight = () => container.clientHeight || window.innerHeight;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(surfaceWidth(), surfaceHeight());
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor(0x180703, 1);
  // Shadows stay OFF here, unlike Sky Path. Its shadow camera is sized to a
  // ~20-unit box around one walker; stretching that over a 200-unit cavern is
  // its own design problem, and switching it on now would fold an unrelated
  // cost into the measurement this file exists to take.
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  // No scene.fog — tried at first (matching Sky Path's own atmospheric fog),
  // but removed 2026-09-10. Luke: "let's also lose 'fog near' and 'fog far';
  // they're not doing anything useful at the moment." The reason: Sky Path's
  // fog colour (a light sky-blue) reads clearly against its darker
  // foreground; this cavern's chosen colour was close to the scene's own
  // ambient dark-orange/brown palette, so at any near/far setting it blended
  // in rather than reading as depth. If atmospheric fog is wanted again here,
  // it needs a colour that actually contrasts with the lava/rock tones, not
  // just a re-tuned range.

  const camera = new THREE.PerspectiveCamera(52, surfaceWidth() / surfaceHeight(), 0.5, 5000);

  // Warm key from below (the lava) plus a dim fill, since the island models are
  // lit meshes. The dome itself is converted to unlit below — see loadDome.
  const lavaKey = new THREE.DirectionalLight(0xff7a2a, 2.2);
  lavaKey.position.set(0, -1, 0);
  scene.add(lavaKey);
  scene.add(new THREE.HemisphereLight(0xffb066, 0x40120a, 1.1));

  const onResize = () => {
    camera.aspect = surfaceWidth() / surfaceHeight();
    camera.updateProjectionMatrix();
    renderer.setSize(surfaceWidth(), surfaceHeight());
  };
  window.addEventListener('resize', onResize);

  // ---------------------------------------------------------------- assets
  const manager = new THREE.LoadingManager();
  const gltfLoader = new GLTFLoader(manager);
  const texLoader = new THREE.TextureLoader(manager);

  const bridgeWind = createBridgeWind();
  const plankVariants = [];
  let islandTemplate = null;

  // Same three plank meshes the real bridges use, prepared the same way — the
  // Blender object-mode scale has to be baked into the geometry before it can
  // go into an InstancedMesh (see the longer note at skyPath.js's own plank
  // loader, which this mirrors deliberately rather than diverging from).
  for (const src of ['models/plank1.glb', 'models/plank2.glb', 'models/plank3.glb']) {
    gltfLoader.load(src, (gltf) => {
      gltf.scene.updateWorldMatrix(true, true);
      let mesh = null;
      gltf.scene.traverse((o) => {
        if (o.isMesh && !mesh) mesh = o;
      });
      mesh.geometry.applyMatrix4(mesh.matrixWorld);
      mesh.geometry.computeBoundingBox();
      const halfThickness = (mesh.geometry.boundingBox.max.y - mesh.geometry.boundingBox.min.y) / 2;
      bridgeWind.patch(mesh.material, 'instanced');
      plankVariants.push({ geometry: mesh.geometry, material: mesh.material, halfThickness });
    });
  }

  // Prepared exactly the way skyPath.js prepares the same file, because the
  // raw export is neither the right size nor textured on its deck:
  //
  //   - the flattest mesh in the file is the deck (node names have changed
  //     between exports; the shape hasn't), and it needs the paving texture
  //     applied to a *clone* of its material — stray geometry has shared that
  //     material in past exports, so editing it in place can texture things
  //     it shouldn't;
  //   - the model's own scale depends on where a tuning slider happened to sit
  //     at export time, so the deck's real radius is measured off its vertices
  //     and the whole model rescaled to ISLAND_RADIUS. Measured from vertices
  //     rather than a bounding box on purpose: Box3 around a flat disc is a
  //     square, and its bounding sphere overstates radius r as r*sqrt(2),
  //     which silently shrinks every island to 71% of its intended size.
  //
  // Skipping the rescale is exactly what the first run of this file did, and
  // it filled the screen with one enormous island.
  const ISLAND_RADIUS = 4; // Sky Path's own value, which the bridge anchors are tuned against
  gltfLoader.load('models/island-basic-v2.glb', (gltf) => {
    let deckMesh = null;
    let flattestHeight = Infinity;
    gltf.scene.traverse((o) => {
      if (!o.isMesh) return;
      o.geometry.computeBoundingBox();
      const box = o.geometry.boundingBox;
      const height = box.max.y - box.min.y;
      if (height < flattestHeight) {
        flattestHeight = height;
        deckMesh = o;
      }
    });

    const deckMat = deckMesh.material.clone();
    deckMat.map = texLoader.load('textures/island-circle.png', (t) => {
      t.colorSpace = THREE.SRGBColorSpace;
    });
    deckMat.vertexColors = false;
    deckMat.color.set(0xffffff);
    deckMat.needsUpdate = true;
    deckMesh.material = deckMat;

    gltf.scene.updateWorldMatrix(true, true);
    const dPos = deckMesh.geometry.attributes.position;
    const dVert = new THREE.Vector3();
    let deckRadius = 0;
    for (let i = 0; i < dPos.count; i++) {
      dVert.fromBufferAttribute(dPos, i).applyMatrix4(deckMesh.matrixWorld);
      deckRadius = Math.max(deckRadius, Math.hypot(dVert.x, dVert.z));
    }
    islandTemplate = { scene: gltf.scene, scale: ISLAND_RADIUS / deckRadius };
  });

  const domeGroup = new THREE.Group();
  scene.add(domeGroup);
  gltfLoader.load('models/lava-dome-v4.glb', (gltf) => {
    // Converted to unlit, per CLAUDE.md: "Almost everything renders unlit
    // (MeshBasicMaterial), with shading painted into the art. Adding a lit
    // material to this scene will look wrong." A sphere lit from inside is
    // also exactly the case where normals fight you, so this sidesteps that
    // as well as matching the house style — the wall's own baked texture is
    // what should be doing the work.
    gltf.scene.traverse((o) => {
      if (!o.isMesh) return;
      const old = o.material;
      o.material = new THREE.MeshBasicMaterial({ map: old.map, side: THREE.BackSide, fog: true });
      old.dispose();
    });
    domeGroup.add(gltf.scene);

    // Read the dome's real size rather than trusting a number written here —
    // its scale lives on the node inside the .glb (V3 was 100, V4 is 300 with
    // a slightly taller Y), and every layout figure below is derived from
    // these two, so swapping in the next dome needs no code change.
    const box = new THREE.Box3().setFromObject(gltf.scene);
    domeRadius = Math.max(box.max.x, box.max.z);
    domeHeight = box.max.y;
  });

  // Loaded once and shared by every actor's card — one texture, N materials
  // (each actor tints its own). Held as a promise because actors are created
  // and destroyed whenever the cast changes, long after this has resolved.
  const figureTexture = new Promise((resolve) => {
    texLoader.load('textures/figure-woman2.webp', (t) => {
      t.colorSpace = THREE.SRGBColorSpace;
      resolve(t);
    });
  });

  // Fallen-state icon — drawn on a canvas rather than shipped as an art file,
  // since this is standing in for whatever the real "you fell" treatment ends
  // up being once a real fall mechanic exists (Sky Path's own is a full
  // scripted tumble; nothing that elaborate is warranted for a marker seen
  // from across the cavern). A plain warning glyph is enough to answer "why
  // has that beacon stopped".
  const fallIconTexture = (() => {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#e8342a';
    ctx.beginPath();
    ctx.arc(32, 32, 30, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#fff6e0';
    ctx.font = 'bold 40px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('!', 32, 35);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  })();

  // ---------------------------------------------------------------- lava
  //
  // Luke, 2026-09-10: "how we might achieve a roiling/bubbling lava effect...
  // multiple shifting images, at least one with reduced alpha." Two source
  // photos (Assets, via Desktop) — Lava1 as the base, LavaDark layered over
  // it at reduced strength for mottling — sampled the same way the fog
  // curtain's shader already samples its own noise texture multiple times at
  // different scales and drift directions (see FOG_FRAG in skyPath.js): that
  // pattern is reused here on purpose, not reinvented.
  //
  // Neither source photo actually tiles seamlessly — confirmed by rolling
  // each by half its size and finding a visible grid line at the join, and a
  // quick "force it seamless" mirror-tile attempt made it worse (an obvious
  // kaleidoscope). What actually disguises the seam, confirmed by testing a
  // static approximation of this exact composite: giving the two layers
  // DIFFERENT tile frequencies (not just different offsets) so their grids
  // never align, plus a fixed rotation between them, plus a cheap analytic
  // sine-based "domain warp" (no extra texture fetch) bending both away from
  // straight lines. The real version below adds independent scroll speeds on
  // top, which a static test image can't demonstrate but only helps further.
  //
  // Both textures were cropped to a smaller, non-repeating region and
  // downscaled before shipping — the source photos were 3.1MB/7776Β² and
  // 2.3MB/8000Β² respectively, vastly more resolution than a texture sampled
  // by a shader on a distant, constantly-moving surface can ever show.
  const LAVA_VERT = /* glsl */ `
    varying vec2 vWorldXZ;
    void main() {
      vWorldXZ = (modelMatrix * vec4(position, 1.0)).xz;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `;
  const LAVA_FRAG = /* glsl */ `
    uniform sampler2D uLava1;
    uniform sampler2D uLavaDark;
    uniform float uTime;
    uniform float uDarkAlpha;
    uniform float uScale1;
    uniform float uScale2;
    uniform vec2 uSpeed1;
    uniform vec2 uSpeed2;
    varying vec2 vWorldXZ;

    // Bends sampling position along slow sine waves — cheap turbulence with
    // no extra texture read — just enough to turn each layer's otherwise-dead-
    // straight tile seam into a curve, so two layers' seams (already at
    // different scales/rotation) have even less chance of visibly lining up.
    vec2 warp(vec2 p, float t) {
      float a = sin(p.x * 0.045 + t * 0.35) * 5.0 + sin(p.y * 0.03 - t * 0.22) * 5.0;
      float b = cos(p.y * 0.05 - t * 0.28) * 5.0 + cos(p.x * 0.035 + t * 0.18) * 5.0;
      return p + vec2(a, b);
    }

    void main() {
      vec2 p1 = warp(vWorldXZ, uTime) * uScale1 + uSpeed1 * uTime;
      vec3 base = texture2D(uLava1, p1).rgb;

      // Fixed ~24° rotation on top of its own different scale/speed — the
      // whole point is that this layer's tile grid shares nothing with the
      // base layer's, so wherever one has a seam the other doesn't.
      mat2 rot = mat2(0.914, -0.407, 0.407, 0.914);
      vec2 p2 = rot * warp(vWorldXZ, uTime * 1.3) * uScale2 + uSpeed2 * uTime;
      vec3 dark = texture2D(uLavaDark, p2).rgb;

      vec3 color = mix(base, dark, uDarkAlpha);
      gl_FragColor = vec4(color, 1.0);
      #include <colorspace_fragment>
    }
  `;

  // Tuned so the two layers' periods share no simple ratio (50 vs ~33 world
  // units) and drift in different directions — see the long comment above.
  const LAVA_SCALE_1 = 1 / 50;
  const LAVA_SCALE_2 = 1 / 33;
  const LAVA_SPEED_1 = new THREE.Vector2(0.6, 0.35);
  const LAVA_SPEED_2 = new THREE.Vector2(-0.4, 0.5);

  const lavaMat = new THREE.ShaderMaterial({
    uniforms: {
      uLava1: { value: null },
      uLavaDark: { value: null },
      uTime: { value: 0 },
      uDarkAlpha: { value: TUNE.lavaDarkAlpha },
      uScale1: { value: LAVA_SCALE_1 },
      uScale2: { value: LAVA_SCALE_2 },
      uSpeed1: { value: LAVA_SPEED_1.clone() },
      uSpeed2: { value: LAVA_SPEED_2.clone() },
    },
    vertexShader: LAVA_VERT,
    fragmentShader: LAVA_FRAG,
  });
  texLoader.load('textures/lava-1.webp', (t) => {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.SRGBColorSpace;
    lavaMat.uniforms.uLava1.value = t;
  });
  texLoader.load('textures/lava-dark.webp', (t) => {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.SRGBColorSpace;
    lavaMat.uniforms.uLavaDark.value = t;
  });

  // A flat disc at the dome's own base — built at unit radius and scaled to
  // the measured dome in buildWorld, so it fits whichever dome was actually
  // loaded, same as before this had real art.
  const lavaDisc = new THREE.Mesh(new THREE.CircleGeometry(1, 64), lavaMat);
  lavaDisc.rotation.x = -Math.PI / 2;
  lavaDisc.position.y = 0.5;
  scene.add(lavaDisc);

  // ---------------------------------------------------------------- the world
  //
  // Everything walkable lives in one group lifted to the ring height, so all
  // the layout maths below can stay in Sky Path's own "ground is y=0" terms
  // and the walk plane's height stays a single number to drag on a slider.
  const world = new THREE.Group();
  scene.add(world);

  const islands = [];
  const bridges = [];
  /** Per spoke: the chain of island cursors from the rim inward, centre last. */
  let spokeCursors = [];

  function spawnIsland(cursor) {
    const group = new THREE.Group();
    if (islandTemplate) {
      for (const child of islandTemplate.scene.clone().children) group.add(child);
      group.scale.setScalar(islandTemplate.scale);
    }
    group.position.set(cursor.x, 0, cursor.z);
    world.add(group);
    islands.push(group);
    return group;
  }

  /**
   * The two parallel routes across one gap, built exactly the way Sky Path's
   * genBridgeRoute builds a fork's pair: both anchored a fixed lateral offset
   * either side of the spoke's centreline, both landing on the same next
   * island. Sky Path's two branches also diverge in heading (a fork you choose
   * between); here they stay parallel, because the spike only needs the
   * geometry cost and the look, not the choice.
   */
  function buildGap(cursor, target) {
    const routes = {};
    for (const side of ['left', 'right']) {
      const sideSign = side === 'right' ? 1 : -1;
      const departEdge = localToWorld(cursor, sideSign * BRIDGE_ANCHORS.lateral, BRIDGE_ANCHORS.forward);
      const arriveEdge = localToWorld(target, sideSign * BRIDGE_ANCHORS.lateral, -BRIDGE_ANCHORS.forward);
      const group = buildBridge(departEdge, arriveEdge, { sag: BRIDGE_DEFAULTS.sag }, bridgeWind, plankVariants);
      world.add(group);
      bridges.push(group);
      const info = group.userData.bridge;
      departEdge.bridge = info;
      departEdge.bridgeT = 0;
      arriveEdge.bridge = info;
      arriveEdge.bridgeT = 1;
      routes[side] = [departEdge, arriveEdge, { x: target.x, z: target.z }];
    }
    return routes;
  }

  function clearWorld() {
    for (const b of bridges) {
      world.remove(b);
      disposeBridge(b);
    }
    bridges.length = 0;
    for (const g of islands) world.remove(g);
    islands.length = 0;
    spokeCursors = [];
  }

  /**
   * Lays out `spokeCount` spokes at evenly spaced angles, each a chain of
   * islands running from the rim to the shared centre island.
   *
   * Luke revised the spacing rule himself: two teams sit at 90 degrees, not
   * 180 — "at two teams there would be only two spokes, but they'd be 90
   * degrees apart", because directly opposite means they can never see each
   * other. Three at 120, four at 90. So the angle step is 90 degrees except
   * for three spokes, rather than a plain 360/n.
   */
  function buildWorld() {
    clearWorld();
    const n = TUNE.islandsPerSpoke;
    const step = spokeCount === 3 ? (Math.PI * 2) / 3 : Math.PI / 2;

    lavaDisc.scale.setScalar(domeRadius * 0.995);

    // The centre island is shared by every spoke, so it is spawned once here
    // rather than by whichever spoke happens to be built last.
    const centre = { x: 0, z: 0, heading: 0 };
    spawnIsland(centre);

    for (let s = 0; s < spokeCount; s++) {
      const angle = s * step;
      // Islands sit one `spacing` apart all the way in, so the outermost lands
      // at spacing × n and the innermost lands exactly on the centre. Whatever
      // is left between that outer island and the wall is open lava — the
      // "empty space between the starting point and the wall" Luke asked for,
      // and in a 600-wide dome that gap is wider than the whole path.
      const cursors = [];
      for (let k = 0; k <= n; k++) {
        const p = forward(angle, TUNE.spacing * (n - k));
        cursors.push({ x: p.x, z: p.z, heading: angle + Math.PI }); // +PI: walking inward, toward the centre
      }
      for (let k = 0; k < n; k++) spawnIsland(cursors[k]); // k === n is the shared centre, already spawned
      for (let k = 0; k < n; k++) buildGap(cursors[k], cursors[k + 1]);
      spokeCursors.push(cursors);
    }
    resetWalker();
  }

  // ---------------------------------------------------------------- actors
  //
  // THE ACTOR MODEL, built here rather than in skyPath.js on purpose.
  //
  // Stage 2 needs many independent walkers: Luke, 2026-09-08, "the team's
  // position is actually not one position, it's each player", with no guide
  // and each player answering their own question. skyPath.js cannot express that
  // — it doesn't have a player, it *is* one: `walker`, `facing`, `leg`,
  // `forkIndex`, `walkPhase` and the fall/rescue/temple singletons are all
  // module-scope, about 530 reference sites between them. Refactoring that
  // 5,500-line file is the wrong place to *discover* the right shape, because
  // every mistake risks a working game.
  //
  // So the shape is worked out here, where the module is new and small and
  // nothing depends on it yet, and skyPath.js adopts it later once it has
  // been proven. That is exactly the job crowdHarness.js was written to do
  // ("the actor model doesn't exist yet — that refactor is the thing this
  // harness is meant to inform"), just carried out somewhere it can be seen
  // running rather than mocked up beside the game.
  //
  // Everything a walker owns lives on the actor. Nothing about a walker is
  // module-scope any more — including the local player, who is simply
  // `actors[0]` and gets no special state of its own, only a different source
  // of input. That is the property that makes this portable back to Sky Path.
  const actors = [];
  let holdingForward = false;

  // How long a departing actor stays visible after stepping off an island —
  // Luke's own simplification, and the thing that makes remote players cheap:
  // "we don't necessarily have to see each player's full movement. Perhaps
  // players just see each other on the islands, and then when they leave, we
  // see them walk for a second and then disappear. They will only be seen
  // again when on the next island." Applies to everyone EXCEPT the local
  // player, who obviously always sees themselves.
  const DEPART_VISIBLE_SECONDS = 1.0;

  // Bots only, and a placeholder: there is no question/correctness system yet
  // (see TODO.md's stage-2 entry, "still open" — how a question reaches a
  // player isn't decided). This exists so the fall MARKER can be built and
  // judged now, same reasoning as the beacon itself: the rendering is worth
  // proving before the real mechanic that will eventually trigger it exists.
  const FALL_CHANCE = 0.25; // per crossing
  const FALL_RECOVER_SECONDS = 2.5; // stopped, showing the icon, before trying again

  function makeActor({ id, spoke, local = false, tint = 0xffffff }) {
    const card = new THREE.Mesh(
      new THREE.PlaneGeometry(FIGURE_H * FIGURE_ASPECT, FIGURE_H),
      new THREE.MeshBasicMaterial({ transparent: true, alphaTest: 0.45, side: THREE.DoubleSide, color: tint })
    );
    figureTexture.then((t) => {
      card.material.map = t;
      card.material.needsUpdate = true;
    });
    scene.add(card);

    // A beacon floating above each remote actor. Without it they are simply
    // not findable: a spoke away is 150-200 units, where a 1.27-unit card is
    // a handful of pixels through haze. This is the marker half of the
    // "in-world markers" option, and the part actually doing the
    // communicating — see the stage-2 entry in TODO.md.
    const beacon = new THREE.Mesh(
      new THREE.ConeGeometry(0.55, 1.1, 4),
      new THREE.MeshBasicMaterial({ color: tint, fog: false })
    );
    beacon.rotation.x = Math.PI; // point down, at the actor
    beacon.visible = false;
    scene.add(beacon);

    // A second, smaller marker above the beacon, shown only while fallen —
    // Luke, 2026-09-10: "put some simple icon above the arrow to show this."
    // Kept as a wholly separate mesh rather than swapping the beacon's own
    // material, so the beacon's colour (which team) and the fall icon (which
    // state) are legible independently — you can tell WHO fell without losing
    // the colour that tells you which team they're on.
    const fallIcon = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ map: fallIconTexture, transparent: true, fog: false })
    );
    fallIcon.visible = false;
    scene.add(fallIcon);

    const actor = {
      id,
      local,
      spoke,
      card,
      beacon,
      fallIcon,
      walker: { x: 0, z: 0 },
      facing: 0,
      queue: [],
      gapIndex: 0,
      // 'island' = standing on one; 'walking' = crossing a gap; 'fallen' = a
      // failed crossing, stopped partway and waiting to recover. `sinceDepart`
      // drives the visibility tail after a successful departure.
      phase: 'island',
      sinceDepart: 0,
      dwell: 0, // bots only: seconds left standing (or fallen) before acting again
    };
    actors.push(actor);
    resetActor(actor);
    return actor;
  }

  function resetActor(a) {
    const cursors = spokeCursors[a.spoke % Math.max(1, spokeCursors.length)];
    if (!cursors) return;
    a.walker.x = cursors[0].x;
    a.walker.z = cursors[0].z;
    a.facing = cursors[0].heading;
    a.gapIndex = 0;
    a.queue = [];
    a.phase = 'island';
    a.willFall = false;
    a.sinceDepart = 0;
    a.dwell = a.local ? 0 : 0.5 + Math.random() * 3;
  }

  /**
   * Refills an actor's queue with the next gap's route. Sides alternate
   * rather than being chosen: with no questions in this build there is
   * nothing to choose *with*, and alternating at least walks both bridges of
   * the pair over the course of a run.
   *
   * Recomputed rather than cached from buildWorld: the bridges are already in
   * the scene, and these are just three waypoints along one of them — cheap,
   * and always in step with whatever the sliders last did to the layout.
   */
  function nextLeg(a) {
    const cursors = spokeCursors[a.spoke % Math.max(1, spokeCursors.length)];
    if (!cursors || a.gapIndex >= TUNE.islandsPerSpoke) return false;
    const cursor = cursors[a.gapIndex];
    const target = cursors[a.gapIndex + 1];
    const sideSign = a.gapIndex % 2 === 0 ? -1 : 1;
    const departEdge = localToWorld(cursor, sideSign * BRIDGE_ANCHORS.lateral, BRIDGE_ANCHORS.forward);
    const arriveEdge = localToWorld(target, sideSign * BRIDGE_ANCHORS.lateral, -BRIDGE_ANCHORS.forward);

    // Bots only: a placeholder failure chance standing in for a real wrong
    // answer (see FALL_CHANCE's own comment). Stops partway across the
    // bridge — echoing Sky Path's own wrong-branch treatment
    // (BRIDGE_WRONG_GAP_T) — rather than at the far edge.
    a.willFall = !a.local && Math.random() < FALL_CHANCE;
    if (a.willFall) {
      const t = 0.5;
      a.queue = [
        departEdge,
        { x: THREE.MathUtils.lerp(departEdge.x, arriveEdge.x, t), z: THREE.MathUtils.lerp(departEdge.z, arriveEdge.z, t) },
      ];
    } else {
      a.queue = [departEdge, arriveEdge, { x: target.x, z: target.z }];
    }
    a.gapIndex += 1;
    a.phase = 'walking';
    a.sinceDepart = 0;
    return true;
  }

  /** Advances one actor along its queue. `wants` is its input: the held button for the local player, the bot timer for everyone else. */
  function stepActor(a, dt, wants) {
    if (a.phase === 'island') {
      if (!wants) return;
      if (!nextLeg(a)) return;
    }
    a.sinceDepart += dt;

    let move = walkSpeed() * dt;
    while (move > 0 && a.queue.length) {
      const head = a.queue[0];
      const dx = head.x - a.walker.x;
      const dz = head.z - a.walker.z;
      const dist = Math.hypot(dx, dz);
      if (dist < 1e-4) {
        a.queue.shift();
        continue;
      }
      const take = Math.min(move, dist);
      a.walker.x += (dx / dist) * take;
      a.walker.z += (dz / dist) * take;
      move -= take;
      if (take >= dist - 1e-4) a.queue.shift();
      // Ease toward the direction of travel rather than snapping, so the
      // camera doesn't jerk at each waypoint.
      const targetHeading = Math.atan2(dx, -dz);
      const delta = wrapAngle(targetHeading - a.facing);
      a.facing += delta * Math.min(1, dt * 2.5);
    }

    if (!a.queue.length) {
      if (a.willFall) {
        // Stopped mid-bridge. stepActors() owns recovery timing for bots —
        // this function never advances a 'fallen' actor itself.
        a.phase = 'fallen';
        a.willFall = false;
        a.dwell = FALL_RECOVER_SECONDS;
      } else {
        // Arrived. Standing on an island is what makes a remote actor visible
        // again under the own-spoke rule, so this is the moment the marker
        // reappears there — foreign-spoke actors are visible regardless (see
        // renderActors).
        a.phase = 'island';
        a.dwell = a.local ? 0 : 1 + Math.random() * 4;
      }
    }
  }

  function stepActors(dt) {
    for (const a of actors) {
      if (a.local) {
        stepActor(a, dt, holdingForward);
        continue;
      }
      if (a.phase === 'fallen') {
        a.dwell -= dt;
        if (a.dwell <= 0) {
          // Recover onto the island they departed from, same as a rescued
          // Sky Path player returning to normal play — ready to try the same
          // gap again rather than stuck.
          a.gapIndex -= 1;
          a.phase = 'island';
          a.dwell = 1 + Math.random() * 2;
        }
        continue;
      }
      // Bots stand around for a while, then cross the next gap — a local
      // stand-in for "another player answered their question and set off".
      // Deliberately not networked: this exists to judge how the *rendering*
      // and the visibility rule read, which is the open question. The relay
      // that eventually drives these is a separate, later piece, and it only
      // has to set the same fields this sets.
      if (a.phase === 'island') {
        a.dwell -= dt;
        if (a.dwell <= 0 && a.gapIndex >= TUNE.islandsPerSpoke) resetActor(a); // reached the centre; send them round again
        stepActor(a, dt, a.dwell <= 0);
      } else {
        stepActor(a, dt, true);
      }
    }
  }

  /**
   * Places each actor's card, beacon and fall icon, and decides who's drawn.
   *
   * The island-only/departure-tail rule now applies ONLY to actors on the
   * local player's own spoke — Luke, 2026-09-10, after seeing it in motion:
   * "given how little is actually visible of the other players even when
   * they are at maximum visibility, would it create problems if we were to
   * remove that mechanism for other island spokes... and have the players
   * from other teams visible at all times?" Foreign spokes are far enough
   * away that the pop in/out read as stilted for no real gain, so they're
   * simply always drawn; teammates on your own chain keep the original rule,
   * since that's the up-close case the rule was actually built for. A fallen
   * actor is always visible regardless of spoke — the point of the icon is
   * to be seen.
   */
  function renderActors() {
    const y = ringY();
    const mySpoke = actors[0]?.spoke ?? 0;
    for (const a of actors) {
      const foreignSpoke = a.spoke !== mySpoke;
      const visible =
        a.local || foreignSpoke || a.phase === 'island' || a.phase === 'fallen' || a.sinceDepart < DEPART_VISIBLE_SECONDS;
      a.card.visible = visible;
      // The local player never needs a beacon pointing at themselves.
      a.beacon.visible = visible && !a.local;
      a.fallIcon.visible = visible && !a.local && a.phase === 'fallen';
      if (!visible) continue;

      a.card.position.set(a.walker.x, y + FIGURE_H / 2, a.walker.z);
      a.card.quaternion.copy(camera.quaternion); // billboard, so a card is never edge-on

      if (a.local) continue;
      // Beacons hold a constant *apparent* size rather than a constant world
      // size: the whole point of one is to stay findable across the cavern,
      // and at 200 units a fixed-size marker is as invisible as the card it
      // is meant to advertise. Scaled off distance to the camera, so it reads
      // the same whether the actor is one island away or four.
      const d = camera.position.distanceTo(a.card.position);
      const beaconY = y + FIGURE_H + 0.9 + d * 0.012;
      a.beacon.position.set(a.walker.x, beaconY, a.walker.z);
      a.beacon.scale.setScalar(Math.max(1, d * 0.035));
      a.beacon.rotation.y += 0.01;

      if (a.phase === 'fallen') {
        const iconScale = Math.max(0.6, d * 0.022);
        a.fallIcon.position.set(a.walker.x, beaconY + iconScale * 0.9, a.walker.z);
        a.fallIcon.scale.setScalar(iconScale);
        a.fallIcon.quaternion.copy(camera.quaternion);
      }
    }
  }

  /** Rebuilds the cast: the local player on spoke 0, plus `playersPerSpoke - 1` bots on every spoke. */
  function populateActors() {
    for (const a of actors) {
      scene.remove(a.card);
      scene.remove(a.beacon);
      scene.remove(a.fallIcon);
      a.card.geometry.dispose();
      a.card.material.dispose();
      a.beacon.geometry.dispose();
      a.beacon.material.dispose();
      a.fallIcon.geometry.dispose();
      a.fallIcon.material.dispose(); // fallIconTexture itself is shared and not disposed here
    }
    actors.length = 0;
    if (!spokeCursors.length) return;

    makeActor({ id: 'you', spoke: 0, local: true });
    // One colour per spoke, so which team a distant beacon belongs to is
    // readable at a glance — a stand-in for the real team colours.
    const teamTints = [0x8fd0ff, 0xffd166, 0x9be564, 0xff8fa3];
    for (let s = 0; s < spokeCursors.length; s++) {
      const n = s === 0 ? TUNE.playersPerSpoke - 1 : TUNE.playersPerSpoke;
      for (let i = 0; i < n; i++) {
        makeActor({ id: `s${s}p${i}`, spoke: s, tint: teamTints[s % teamTints.length] });
      }
    }
  }

  /** Back-compat for the tuner's "back to rim" button and buildWorld. */
  function resetWalker() {
    populateActors();
  }

  // ---------------------------------------------------------------- HUD
  const advanceBtn = $('cavAdvance');
  const press = (on) => (e) => {
    holdingForward = on;
    if (on) {
      try {
        advanceBtn.setPointerCapture(e.pointerId);
      } catch {}
    }
  };
  advanceBtn.addEventListener('pointerdown', press(true));
  advanceBtn.addEventListener('pointerup', press(false));
  advanceBtn.addEventListener('pointercancel', press(false));

  // ---------------------------------------------------------------- drag to look
  //
  // Luke, 2026-09-10: "bring in the ability for the player to look around a
  // bit, like they can in Sky Path... I want the player to be able to look up
  // towards the top of the cavern a bit."
  //
  // Deliberately NOT Sky Path's own technique. Sky Path's drag-to-look is a
  // lateral SLIDE of the camera position with the look-at point held fixed —
  // built that way on purpose, to sell parallax between its layered 2D
  // backdrop panels ("the clearest demonstration of the multiplane effect").
  // None of that applies here: the dome is one real 3D mesh, not a stack of
  // flat layers, and a slide's vertical reach is capped by how far the camera
  // can plausibly move — nowhere near enough to look up at a dome overhead.
  // So this is a genuine aim rotation instead: the camera's POSITION still
  // just trails the walker along `facing`, same as always, but the look-AT
  // point is swung by separate yaw/pitch offsets on top of that. Same
  // interaction shape as Sky Path (captured pointer, eased target, clamped
  // range) so it feels like the same control, just applied to rotation
  // instead of position — which is what actually buys the bigger arc.
  const look = { yaw: 0, pitch: 0, tyaw: 0, tpitch: 0 };
  let dragging = null;
  const LOOK_YAW_LIMIT = THREE.MathUtils.degToRad(50);
  const LOOK_PITCH_UP_LIMIT = THREE.MathUtils.degToRad(65); // toward the vent hole overhead
  const LOOK_PITCH_DOWN_LIMIT = THREE.MathUtils.degToRad(20); // the deck underfoot is not the point

  renderer.domElement.addEventListener('pointerdown', (e) => {
    dragging = { id: e.pointerId, x: e.clientX, y: e.clientY, oyaw: look.tyaw, opitch: look.tpitch };
    renderer.domElement.setPointerCapture(e.pointerId);
  });
  renderer.domElement.addEventListener('pointermove', (e) => {
    if (!dragging || dragging.id !== e.pointerId) return;
    const s = 2.6 / surfaceWidth(); // radians per pixel of the surface's own width, so the feel doesn't depend on device resolution
    look.tyaw = THREE.MathUtils.clamp(dragging.oyaw + (e.clientX - dragging.x) * s, -LOOK_YAW_LIMIT, LOOK_YAW_LIMIT);
    look.tpitch = THREE.MathUtils.clamp(
      dragging.opitch - (e.clientY - dragging.y) * s,
      -LOOK_PITCH_DOWN_LIMIT,
      LOOK_PITCH_UP_LIMIT
    );
  });
  const endLookDrag = (e) => {
    if (dragging && dragging.id === e.pointerId) dragging = null;
  };
  renderer.domElement.addEventListener('pointerup', endLookDrag);
  renderer.domElement.addEventListener('pointercancel', endLookDrag);

  const statsEl = $('cavStats');
  let fpsFrames = 0;
  let fpsSince = performance.now();
  let fpsValue = 0;

  function updateStats() {
    const info = renderer.info.render;
    // The wall gap is reported rather than set: it's the leftover between the
    // outermost island and the dome wall, so it's the number that tells you
    // whether "empty space between the starting point and the wall" is
    // actually there after a spacing or island-count change.
    const gap = wallRadiusAtRing() - ringRadius();
    statsEl.textContent =
      `${fpsValue.toFixed(0)} fps   ${surfaceWidth()}x${surfaceHeight()} @${renderer.getPixelRatio().toFixed(1)}x\n` +
      `${info.calls} draw calls   ${(info.triangles / 1000).toFixed(0)}k tris\n` +
      `${spokeCount} spoke(s)   ${islands.length} islands   ${bridges.length} bridges\n` +
      `${actors.length} actors (${actors.filter((a) => a.card.visible).length} visible)\n` +
      `dome r${domeRadius.toFixed(0)}   path r${ringRadius().toFixed(0)}   wall gap ${gap.toFixed(0)}\n` +
      `speed ${walkSpeed().toFixed(1)}/s   ${TUNE.secondsPerIsland.toFixed(2)}s per island`;
  }

  // ---------------------------------------------------------------- loop
  const clock = new THREE.Clock();
  let ready = false;

  manager.onLoad = () => {
    buildWorld();
    ready = true;
    const l = $('cavLoader');
    if (l) l.classList.add('done');
  };

  function tick() {
    if (disposed) return;
    rafId = requestAnimationFrame(tick);
    const dt = Math.min(clock.getDelta(), 0.05);
    const t = clock.getElapsedTime();

    if (ready) {
      bridgeWind.update(t);
      stepActors(dt);

      lavaMat.uniforms.uTime.value = t;
      lavaMat.uniforms.uDarkAlpha.value = TUNE.lavaDarkAlpha;
      lavaMat.uniforms.uScale1.value = LAVA_SCALE_1 * TUNE.lavaScale;
      lavaMat.uniforms.uScale2.value = LAVA_SCALE_2 * TUNE.lavaScale;
      lavaMat.uniforms.uSpeed1.value.copy(LAVA_SPEED_1).multiplyScalar(TUNE.lavaSpeed);
      lavaMat.uniforms.uSpeed2.value.copy(LAVA_SPEED_2).multiplyScalar(TUNE.lavaSpeed);

      look.yaw += (look.tyaw - look.yaw) * Math.min(1, dt * 4);
      look.pitch += (look.tpitch - look.pitch) * Math.min(1, dt * 4);

      const y = ringY();
      world.position.y = y;

      // The camera follows actors[0] — the local player — with no special
      // state of its own. That is the whole point of the actor model: "the
      // player" is just whichever actor this device is driving.
      const me = actors[0];
      if (me) {
        const behind = forward(me.facing, TUNE.camBack);
        camera.position.set(me.walker.x - behind.x, y + TUNE.camHeight, me.walker.z - behind.z);

        // Aim: facing plus the drag-to-look offset, swung as a real rotation
        // (not Sky Path's positional slide — see the drag-to-look section's
        // own comment for why) so pitch can genuinely tilt up toward the dome
        // overhead rather than just nudging the camera's height.
        //
        // `restDy` bakes in Sky Path's own CAM_LOOK_Y convention (the look-at
        // point sits a bit below the camera at rest, since the camera is
        // above head height looking toward chest height) so pitch=0
        // reproduces exactly the same resting gaze as before this existed —
        // drag only adds swing on top of that baseline, in either direction.
        const aimYaw = me.facing + look.yaw;
        const reach = TUNE.camBack * 0.63 + 4;
        const restDy = CAM_LOOK_Y - TUNE.camHeight;
        const aim = forward(aimYaw, reach * Math.cos(look.pitch));
        camera.lookAt(
          camera.position.x + aim.x,
          camera.position.y + restDy + reach * Math.sin(look.pitch),
          camera.position.z + aim.z
        );
      }
      // After the camera, so the cards billboard against this frame's view
      // rather than the previous one's.
      renderActors();
    }

    renderer.render(scene, camera);

    fpsFrames += 1;
    const now = performance.now();
    if (now - fpsSince >= 500) {
      fpsValue = (fpsFrames * 1000) / (now - fpsSince);
      fpsFrames = 0;
      fpsSince = now;
      updateStats();
    }
  }
  tick();

  // ---------------------------------------------------------------- tuner
  const slider = (key, min, max, step, onSet) => ({
    value: TUNE[key],
    min,
    max,
    step,
    set: (v) => {
      TUNE[key] = v;
      onSet?.();
    },
  });

  const tuner = attachBgTuner({
    container,
    id: 'cavernTuner',
    title: 'lava cavern',
    position: 'right',
    panels: {},
    extrasTitle: 'CAVERN',
    extras: {
      'ring height %': slider('ringHeightFrac', 0.05, 0.6, 0.01),
      'cam back': slider('camBack', 5, 40, 0.5),
      'cam height': slider('camHeight', 1, 20, 0.25),
      // Only visible on a WALKING actor — the local player while holding
      // ▲, or a bot mid-crossing. Previously nearly impossible to judge:
      // under the old visibility rule a foreign-spoke bot was only ever
      // drawn for the first second of a crossing (see DEPART_VISIBLE_SECONDS)
      // regardless of how long the whole crossing actually took, so changing
      // this mostly changed an interval nobody could see. Now that foreign
      // spokes are always visible, a bot stays on screen for its entire
      // crossing and the pacing change is obvious. The derived number is
      // also always in the stats readout (top left) if you want to confirm
      // it moved without watching anyone walk.
      's / island': slider('secondsPerIsland', 1, 10, 0.05),
      // Layout changes rebuild every island and bridge, so they are applied on
      // the button rather than continuously — dragging a rebuild through 40
      // intermediate values would measure the rebuild, not the world. Note
      // that raising `spacing` also speeds the walker up to match, so the time
      // between islands stays put (see secondsPerIsland).
      'spacing (bridge len)': slider('spacing', 10, 60, 1),
      'islands/spoke': slider('islandsPerSpoke', 2, 10, 1),
      'players/spoke': slider('playersPerSpoke', 1, 8, 1, () => populateActors()),
      'lava dark %': slider('lavaDarkAlpha', 0, 1, 0.02),
      'lava speed': slider('lavaSpeed', 0, 3, 0.05),
      'lava scale': slider('lavaScale', 0.3, 3, 0.05),
    },
    actions: [
      { label: 'rebuild (apply spacing/count)', onClick: () => buildWorld() },
      { label: '1 spoke', onClick: () => ((spokeCount = 1), buildWorld()) },
      { label: '2 spokes (90°)', onClick: () => ((spokeCount = 2), buildWorld()) },
      { label: '3 spokes (120°)', onClick: () => ((spokeCount = 3), buildWorld()) },
      { label: '4 spokes (90°)', onClick: () => ((spokeCount = 4), buildWorld()) },
      { label: 'back to rim', onClick: () => resetWalker() },
    ],
  });
  // Starts collapsed — Luke, 2026-09-10, now that the numbers above are
  // locked in: "have the menu collapsed by default." attachBgTuner has no
  // start-collapsed option of its own (every other caller wants it open), so
  // this just clicks the panel's own header once, the same toggle a tap
  // would trigger.
  container.querySelector('#cavernTuner > button')?.click();

  // ---------------------------------------------------------------- debug hooks
  if (import.meta.env.DEV) {
    window.__cavern = () => ({
      ready,
      spokeCount,
      islands: islands.length,
      bridges: bridges.length,
      drawCalls: renderer.info.render.calls,
      triangles: renderer.info.render.triangles,
      fps: +fpsValue.toFixed(1),
      actors: actors.length,
      visibleActors: actors.filter((a) => a.card.visible).length,
      me: actors[0]
        ? { x: +actors[0].walker.x.toFixed(2), z: +actors[0].walker.z.toFixed(2), gapIndex: actors[0].gapIndex }
        : null,
      tune: { ...TUNE },
    });
    window.__cavernWalk = (on = true) => {
      holdingForward = on;
    };
    // Stand on island `k` of spoke 0 (0 = the rim, islandsPerSpoke = the
    // centre). Walking the whole spoke to look at the far end is as tedious
    // here as walking six forks is in Sky Path, and this stage will be
    // inspected from the middle far more often than from the rim.
    window.__cavernJump = (k) => {
      const me = actors[0];
      const cursors = spokeCursors[0];
      if (!me || !cursors) return null;
      const i = Math.max(0, Math.min(cursors.length - 1, k));
      me.walker.x = cursors[i].x;
      me.walker.z = cursors[i].z;
      me.facing = cursors[i].heading;
      me.gapIndex = i;
      me.queue = [];
      me.phase = 'island';
      return { island: i, x: +me.walker.x.toFixed(2), z: +me.walker.z.toFixed(2) };
    };
    window.__cavernActors = () =>
      actors.map((a) => ({
        id: a.id,
        spoke: a.spoke,
        phase: a.phase,
        gap: a.gapIndex,
        visible: a.card.visible,
        x: +a.walker.x.toFixed(1),
        z: +a.walker.z.toFixed(1),
      }));
    // Forces one bot into the fallen state on the spot, for checking the icon
    // and the recovery timer without waiting on FALL_CHANCE's own dice roll —
    // real time is also unreliable to wait on in an automated/background tab,
    // since rAF doesn't fire reliably while hidden. Goes through nextLeg()
    // first if needed rather than setting `phase` directly: fallen is only
    // ever reached in real play after gapIndex has already been incremented
    // by a departure, and skipping that step here can hand recovery a
    // gapIndex of 0 to decrement below zero — a bug in this hook, not in the
    // mechanism it's testing.
    window.__cavernForceFall = (id) => {
      const a = actors.find((x) => x.id === id) || actors.find((x) => !x.local);
      if (!a) return null;
      if (a.phase === 'island') nextLeg(a);
      a.phase = 'fallen';
      a.queue = [];
      a.dwell = FALL_RECOVER_SECONDS;
      return { id: a.id, phase: a.phase, gap: a.gapIndex, dwell: a.dwell };
    };
  }

  return {
    dispose() {
      disposed = true;
      if (rafId) cancelAnimationFrame(rafId);
      window.removeEventListener('resize', onResize);
      tuner?.dispose();
      clearWorld();
      for (const a of actors) {
        scene.remove(a.card);
        scene.remove(a.beacon);
        scene.remove(a.fallIcon);
        a.card.geometry.dispose();
        a.card.material.dispose();
        a.beacon.geometry.dispose();
        a.beacon.material.dispose();
        a.fallIcon.geometry.dispose();
        a.fallIcon.material.dispose();
      }
      actors.length = 0;
      fallIconTexture.dispose();
      lavaDisc.geometry.dispose();
      lavaMat.uniforms.uLava1.value?.dispose();
      lavaMat.uniforms.uLavaDark.value?.dispose();
      lavaMat.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      container.classList.remove('cavern-surface');
      container.innerHTML = '';
    },
  };
}
