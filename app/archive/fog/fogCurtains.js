/**
 * ARCHIVED — not imported, built or shipped. The fog, removed from Sky Path
 * on 2026-10-10 (Luke: "let's just remove the fog from the game completely.
 * Don't delete it; keep the files and the code archived and referenced
 * somewhere so we can reinstate it later if needed").
 *
 * These are verbatim cuts from app/src/skypath/skyPath.js (as of commit
 * after c7daaf3), all from inside mountSkyPath(), where they read its locals
 * (scene, THREE, TEX, role, walker, forward, tintScratch, smoothstep, ...).
 * This file is a record, not a module: it won't run on its own.
 *
 * TO REINSTATE
 *  1. Texture: move archive/fog/fog-noise.webp back to public/textures/, and
 *     in skyPath.js's TEX add
 *       fogNoise: tex('fog-noise', { linear: true, tile: true }),
 *     (fogPuff is still there: the engine smoke uses the same puff.)
 *  2. Paste PART A (the curtain section) back where skyPath.js's
 *     "---- fog" pointer comment is, after the smoothstep helper.
 *  3. In buildFork(), after the section object `sec` is built and before
 *     `sections.push(sec)`:
 *       sec.curtain = makeCurtain(advance(sec.fork, sec.fork.heading, CURTAIN_DIST), sec.fork.heading);
 *  4. In the frame loop, straight after applyAtmosphere(sunP):
 *       updateCurtains(dt, t);
 *  5. In the reset/dispose code next to the pillars' disposal: PART C.
 *  6. Optional: PART D's debug hooks, next to window.__spawnBird.
 *  7. Scene-wide fog (it was already switched off, FOG_ENABLED = false, since
 *     2026-09-24): PART B after `const scene = new THREE.Scene();`, and in
 *     applyAtmosphere the fog colour lines in PART E. Materials still carry
 *     their `fog: false` flags, so the backdrop layers stay unfogged as before.
 */

// ============================================================ PART A
// The fork curtains: the section, as it stood.
  // ---------------------------------------------------------------- fog curtains
  //
  // A curtain is the prop standing just past each fork that hides everything
  // beyond it. Because a closed curtain blocks the view, the path beyond can
  // already be standing there fully built without the player ever seeing it
  // get built — which is the whole point.
  //
  // It's built as a hybrid of two parts, because the two jobs pull against
  // each other: hiding the path *reliably*, and looking like mist.
  //
  //   1. One dense sheet does the hiding. Its alpha is computed in a shader
  //      from scrolling tileable noise, and is saturated to a solid 1 across
  //      the core while closed — so occlusion is guaranteed by construction,
  //      not by hoping enough sprites overlap.
  //   2. A ring of soft puff sprites in front of it does the looking. These
  //      are free to be loose and gappy precisely because the sheet behind
  //      them is already doing the occluding.
  //
  // Opening is a dissolve, not a curtain-parting: a threshold rises through
  // the noise field so holes open and widen and tendrils thin out, while the
  // puffs drift outward, shrink and fade. Nothing slides aside as a rigid
  // rectangle.
  //
  // Cost note: on a mid-range phone the budget here is overdraw, not CPU. The
  // sheet is ~1x fullscreen at its closest (the old three-layer stack was 3x),
  // which leaves room for the puffs — ~28 sprites at roughly 9% of frame each.
  // Only the nearest un-dissolved curtain is ever visible, since a closed one
  // hides every curtain behind it, so this cost is paid once at a time.
  // The sheet's *physical* quad is much bigger than the fog anyone will ever
  // see. Visibility is governed entirely by CORE_R*/FADE_R* below — the quad
  // just needs to be large enough that its edge sits well past FADE_R (plus
  // the domain warp's own reach), so that edge is provably always at alpha 0,
  // never something the geometry itself has to draw a line at.
  const FOG_W = 16;
  const FOG_H = 11.04; // scaled up with the visible radii to maintain margin past FADE_RY
  const FOG_Y = 1.6; // centre height — unrelated to FOG_H now; see CORE_RY/FADE_RY for what's actually visible
  const FOG_RISE = 0.9; // the bank lifts a little as it burns off
  const FOG_EXPAND = 0.14; // ...and swells slightly, as thinning fog does

  // The guaranteed-solid zone, in world units from the sheet's centre — must
  // cover the path corridor (±1.3) with a little margin. Nothing here ever
  // gets warped or faded; see the warp gate in FOG_FRAG for why that's exact,
  // not approximate. Scaled 30% larger to block more of downstream geometry.
  const FOG_CORE_RX = 2.106;
  const FOG_CORE_RY = 1.482;
  // Where alpha reaches 0. The gap between CORE and FADE is deliberately much
  // wider in X than Y — "wider is fine" for how gradually it dissipates
  // sideways, but a matching vertical expansion would undo the earlier fix
  // for the fog sitting too high. Scaled 30% to match the core.
  const FOG_FADE_RX = 8.58;
  const FOG_FADE_RY = 3.588;
  // Domain warp: bends the whole silhouette in flowing curves instead of a
  // smooth-but-still-rectangular product of two 1D falloffs, which is what
  // still read as a soft-edged box even after the noisy-border pass. Sized
  // well under (FADE - CORE) on each axis so the quad-size margin above still
  // holds even at the warp's full reach.
  const FOG_WARP_X = 1.0;
  const FOG_WARP_Y = 0.4;

  const PUFF_COUNT = 28;
  const PUFF_ALPHA = 0.5;
  const PUFF_SPREAD_X = 7.02; // scaled 20% more with the fog radii
  const PUFF_SPREAD_Y = 4.1184; // scaled 20% more with the fog radii
  const PUFF_SIZE = [1.1, 2.5];
  const PUFF_DEPTH = [0.05, 1.6]; // all in front of the sheet — see renderOrder note below
  const PUFF_PUSH = 2.6; // outward drift once dissolving
  const PUFF_LIFT = 1.5;

  // Was `BRANCH_LEN * 0.4` — a fraction of *path* length, with no reference to
  // the island's own size. At the old, smaller island (radius 3.5) that
  // happened to land past the deck edge; at the current radius (6) it lands
  // at ~4.2, well *inside* the deck — the curtain would stand on top of solid
  // paving rather than out past its edge. Tied directly to ISLAND_RADIUS
  // instead: this needs to track the island's actual size, not a fraction of
  // an unrelated path-length constant. (The wrong branch's own fall point used
  // to be tied to this the same way, as a fraction of the branch's own curve;
  // it's now wherever BRIDGE_WRONG_GAP_T puts the breakable planks — see
  // buildFork.)
  const CURTAIN_DIST = ISLAND_AHEAD + ISLAND_RADIUS + 1.5; // how far past the fork the curtain stands — must clear the deck's edge (the island sits ISLAND_AHEAD forward of the fork)
  const CURTAIN_OPEN_LEAD = 1.6; // starts dissolving this far before the avatar reaches it
  const CURTAIN_OPEN_TIME = 1.0; // seconds to fully dissolve
  const CURTAIN_GUIDE_OPACITY = 0.28; // guide sees through it — the cheap version of "the guide can see ahead"

  const curtains = [];
  // Hidden 2026-09-13 while the real-movement tracking rebuild was being
  // tested end to end (Luke: "go ahead and disable the fog altogether...
  // that way we can test that everyone else can see everything they
  // should"). Re-enabled 2026-09-14 once that rebuild was confirmed working
  // through every movement type and the guide's camera-follow behaviour —
  // see TODO.md's step-by-step entry. The curtains occlude real movement
  // now, same as any other piece of scenery, rather than replacing it with
  // a stand-in the way the old fog system used to.
  const FOG_CURTAINS_VISIBLE = true;

  const FOG_VERT = /* glsl */ `
    varying vec2 vUv;
    varying vec2 vPos; // local xy in world units — see FOG_FRAG for why this replaced vUv there
    void main() {
      vUv = uv;
      vPos = position.xy;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `;

  // Three samples of one tiling noise texture at different scales, drifting in
  // different directions, stand in for fbm — enough churn to read as moving
  // fog. Extra texture samples cost ALU/bandwidth but no extra *blended*
  // pixels, which is the cheap direction to spend on mobile.
  //
  // Sampled from vPos (world units) rather than vUv: the quad is much bigger
  // than the visible fog (see FOG_W/H above), so UV-based frequencies would
  // have stretched — and blurred — the noise pattern across that extra empty
  // margin. World-space frequencies stay a fixed apparent size regardless of
  // how big the quad's own dead space is.
  //
  // uOpen drives a threshold sweeping through that noise field: at 0 the
  // smoothstep saturates to 1 everywhere in the core (guaranteed occlusion),
  // and by 1 it has passed above the field's maximum so nothing is left.
  const FOG_FRAG = /* glsl */ `
    uniform sampler2D uNoise;
    uniform float uTime;
    uniform float uOpen;
    uniform float uAlpha;
    uniform vec3 uColor;
    varying vec2 vUv;
    varying vec2 vPos;

    void main() {
      float n =
        0.50 * texture2D(uNoise, vPos * 0.14 + vec2( 0.013,  0.007) * uTime).r +
        0.30 * texture2D(uNoise, vPos * 0.29 + vec2(-0.021,  0.011) * uTime).r +
        0.20 * texture2D(uNoise, vPos * 0.60 + vec2( 0.008, -0.017) * uTime).r;

      // Denser low, wispier up top: reads as fog sitting on the path, and
      // means it burns off from above first as it dissolves.
      float vert = mix(1.0, 0.72, smoothstep(-2.0, 2.5, vPos.y));
      float base = (0.58 + 0.42 * n) * vert;

      float thr = mix(-0.30, 1.10, uOpen);
      float a = smoothstep(thr, thr + 0.38, base);

      // The silhouette: two independent per-axis falloffs (CORE_R* stays
      // solid, fades out to 0 by FADE_R*), rather than one shared distance —
      // that's deliberate, not a simplification, because it's what lets the
      // fade reach much further sideways (FOG_CORE_RX..FOG_FADE_RX is a wide
      // gap) without also pulling the vertical extent back up to where the
      // fog used to sit too high (FOG_CORE_RY..FOG_FADE_RY stays tight).
      //
      // A plain product of two such falloffs is still, structurally, a
      // rounded rectangle — soft-edged, but a rectangle. What breaks that up
      // is domain-warping the position before measuring it: bending the
      // sampled point along flowing noise, rather than jittering the boundary
      // in place, turns the contour into an organic blob instead of a box.
      // The warp is gated to exactly zero inside the guaranteed core (see
      // warpGate below), so it can never be the thing that lets something
      // through that was supposed to stay hidden.
      vec2 warpUv = vPos * 0.10 + vec2(0.037, 0.021) * uTime;
      vec2 warpN = vec2(
        texture2D(uNoise, warpUv).r - 0.5,
        texture2D(uNoise, warpUv * 1.3 + 3.7).r - 0.5
      );
      float gx = smoothstep(${FOG_CORE_RX}, ${FOG_CORE_RX + 0.8}, abs(vPos.x));
      float gy = smoothstep(${FOG_CORE_RY}, ${FOG_CORE_RY + 0.8}, abs(vPos.y));
      float warpGate = max(gx, gy);
      vec2 wp = vPos + warpN * vec2(${FOG_WARP_X}, ${FOG_WARP_Y}) * warpGate;

      float ex = 1.0 - smoothstep(${FOG_CORE_RX}, ${FOG_FADE_RX}, abs(wp.x));
      float ey = 1.0 - smoothstep(${FOG_CORE_RY}, ${FOG_FADE_RY}, abs(wp.y));
      a *= ex * ey;

      gl_FragColor = vec4(uColor, a * uAlpha);

      // THREE.Color holds values in the linear working space, and a raw
      // ShaderMaterial gets none of the output conversion the built-in
      // materials do for free — without this the fog draws markedly darker
      // than its own tint colour.
      #include <colorspace_fragment>
    }
  `;

  function makeCurtain(pos, heading) {
    const group = new THREE.Group();
    group.position.set(pos.x, FOG_Y, pos.z);
    group.rotation.y = heading; // plane's own normal is +Z, i.e. back toward the approaching avatar

    const sheet = new THREE.Mesh(
      new THREE.PlaneGeometry(FOG_W, FOG_H),
      new THREE.ShaderMaterial({
        uniforms: {
          uNoise: { value: TEX.fogNoise },
          uTime: { value: 0 },
          uOpen: { value: 0 },
          uAlpha: { value: 1 },
          uColor: { value: new THREE.Color(0xffffff) },
        },
        vertexShader: FOG_VERT,
        fragmentShader: FOG_FRAG,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      })
    );
    sheet.renderOrder = 8; // after the stones and the temple
    group.add(sheet);

    // Puffs are one InstancedMesh — a single draw call however many there are.
    // They all sit *in front* of the sheet (PUFF_DEPTH is positive, and +Z
    // local faces the approaching avatar) because an InstancedMesh sorts as one
    // object: instances can't individually sort against the sheet, so keeping
    // them all on the near side makes "draw after the sheet" always correct.
    const puffs = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        map: TEX.fogPuff,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        fog: false,
        opacity: PUFF_ALPHA,
      }),
      PUFF_COUNT
    );
    puffs.renderOrder = 9;
    puffs.frustumCulled = false; // instances move via per-instance matrices; see the stone meshes for the same reasoning
    group.add(puffs);

    const seeds = [];
    for (let i = 0; i < PUFF_COUNT; i++) {
      seeds.push({
        bx: (Math.random() * 2 - 1) * PUFF_SPREAD_X,
        // biased low so the bank is thickest around path level
        by: -FOG_H / 2 + Math.pow(Math.random(), 0.7) * PUFF_SPREAD_Y,
        bz: PUFF_DEPTH[0] + Math.random() * (PUFF_DEPTH[1] - PUFF_DEPTH[0]),
        size: PUFF_SIZE[0] + Math.random() * (PUFF_SIZE[1] - PUFF_SIZE[0]),
        rot: Math.random() * Math.PI * 2,
        rotSpeed: (Math.random() - 0.5) * 0.25,
        p1: Math.random() * Math.PI * 2,
        p2: Math.random() * Math.PI * 2,
        p3: Math.random() * Math.PI * 2,
        delay: Math.random() * 0.4, // staggers which puffs wink out first
      });
    }

    // Luke, 2026-09-13: "go ahead and disable the fog altogether. Don't
    // delete it, just hide it. That way we can test that everyone else can
    // see everything they should." Everything else about a curtain still
    // builds and animates as before — flip this back on to restore it.
    group.visible = FOG_CURTAINS_VISIBLE;
    scene.add(group);
    const curtain = { group, sheet, puffs, seeds, pos, heading, open: 0, opening: false, done: false };
    curtains.push(curtain);
    return curtain;
  }

  // (smoothstep stayed in skyPath.js: the birds, the jetpack and others use it.)

  const puffDummy = new THREE.Object3D();

  /**
   * Dissolves any curtain the avatar has walked up to, and keeps every
   * curtain's colour/opacity current. Colour comes from tintScratch, which
   * applyAtmosphere has already set for this frame — that way a curtain takes
   * the dawn/dusk grading like the rest of the sky without having to live in
   * atmosphereMaterials (whose entries are never removed, so putting
   * per-journey props in it would leak across resets).
   */
  function updateCurtains(dt, t) {
    const roleScale = role === 'guide' ? CURTAIN_GUIDE_OPACITY : 1;
    for (const c of curtains) {
      if (c.done) continue;
      if (!c.opening) {
        const f = forward(c.heading, 1);
        const ahead = (walker.x - c.pos.x) * f.x + (walker.z - c.pos.z) * f.z;
        if (ahead > -CURTAIN_OPEN_LEAD) c.opening = true;
      }
      if (c.opening) c.open = Math.min(1, c.open + dt / CURTAIN_OPEN_TIME);

      const u = c.sheet.material.uniforms;
      u.uTime.value = t;
      u.uOpen.value = c.open;
      u.uAlpha.value = roleScale;
      u.uColor.value.copy(tintScratch);
      c.sheet.position.y = FOG_RISE * c.open;
      c.sheet.scale.set(1 + FOG_EXPAND * c.open, 1 + FOG_EXPAND * 0.6 * c.open, 1);

      c.puffs.material.color.copy(tintScratch);
      c.puffs.material.opacity = PUFF_ALPHA * roleScale * (1 - smoothstep(0.55, 1.0, c.open));

      for (let i = 0; i < c.seeds.length; i++) {
        const s = c.seeds[i];
        // Sine fields rather than a real simulation: cheaper, and easier to
        // keep looking like a slow churn rather than drifting particles.
        const churnX = Math.sin(t * 0.32 + s.p1) * 0.28;
        const churnY = Math.sin(t * 0.24 + s.p2) * 0.2;
        const churnZ = Math.sin(t * 0.29 + s.p3) * 0.16;
        const spent = THREE.MathUtils.clamp((c.open - s.delay) / (1 - s.delay), 0, 1);
        const shrink = 1 - smoothstep(0, 1, spent);
        const push = Math.sign(s.bx || 1) * PUFF_PUSH * c.open;

        puffDummy.position.set(s.bx + churnX + push, s.by + churnY + PUFF_LIFT * c.open, s.bz + churnZ);
        puffDummy.rotation.set(0, 0, s.rot + t * s.rotSpeed);
        const sc = s.size * shrink;
        puffDummy.scale.set(sc, sc, 1);
        puffDummy.updateMatrix();
        c.puffs.setMatrixAt(i, puffDummy.matrix);
      }
      c.puffs.instanceMatrix.needsUpdate = true;

      if (c.open >= 1) {
        c.group.visible = false;
        c.done = true;
      }
    }
  }


// ============================================================ PART B
// The scene-wide fog.
  // One mild atmospheric fog for both roles — purely for depth. Hiding the
  // path ahead is no longer this fog's job: that's the curtain props standing
  // at each junction (see makeCurtain), which is why there is no longer a
  // per-role near/far swap here.
  //
  // Temporarily disabled, per Luke, 2026-09-24: "let's disable the fog for
  // now." Still a real THREE.Fog object, not null — the day/night colour
  // cycle below (fogScratch) and a debug hook both read scene.fog.color/
  // near/far unconditionally — just pushed out past the camera's own
  // 5000-unit far plane (see its own comment below) so nothing ever renders
  // far enough to actually fog. Flip FOG_ENABLED back on to restore the real
  // near/far.
  const FOG_ENABLED = false;
  scene.fog = new THREE.Fog(0xbcd8ea, FOG_ENABLED ? 24 : 100000, FOG_ENABLED ? 260 : 100001);

// ============================================================ PART C
// Disposal, in the journey reset next to the pillars'.
    for (const c of curtains) {
      scene.remove(c.group);
      for (const part of [c.sheet, c.puffs]) {
        part.geometry.dispose();
        part.material.dispose();
      }
      c.puffs.dispose(); // InstancedMesh also owns its instance buffers
    }
    curtains.length = 0;

// ============================================================ PART D
// Debug hooks.
    window.__curtains = () =>
      curtains.map((c) => ({
        z: +c.pos.z.toFixed(2),
        open: +c.open.toFixed(2),
        done: c.done,
        visible: c.group.visible,
        sheet: {
          uOpen: +c.sheet.material.uniforms.uOpen.value.toFixed(3),
          uAlpha: +c.sheet.material.uniforms.uAlpha.value.toFixed(3),
          y: +c.sheet.position.y.toFixed(3),
        },
        puffOpacity: +c.puffs.material.opacity.toFixed(3),
      }));
    window.__curtainObjs = () => curtains;

// ============================================================ PART E
// The fog colour in the day/night cycle (applyAtmosphere and its constants).
  const FOG_DAWN = new THREE.Color(0xe7a37c);
  const FOG_NOON = new THREE.Color(0xbcd8ea);
  const FOG_DUSK = new THREE.Color(0xcf8266);
  const fogScratch = new THREE.Color();
  // in applyAtmosphere(p):
    threeStopLerp(fogScratch, FOG_DAWN, FOG_NOON, FOG_DUSK, p);
    scene.fog.color.copy(fogScratch);
