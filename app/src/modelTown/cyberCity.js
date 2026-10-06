/**
 * The view out of the model-town room's window. Luke, 2026-10-06, in turn:
 * "cyberpunk: Tall buildings, neon, flying cars"; "more realistic, more
 * clean-cut. Not like toys or cardboard. Not retro"; "too bright and
 * crowded... 5 [towers]... haze/cloud... much more dystopian/dark"; then
 * "the close towers are too close. Imagine the apartment is an extremely
 * high elevation, and only clouds are visible, except that a few sleek,
 * dark, futuristic towers are poking through. The closest should still be
 * far enough away that we can see its entire width."
 *
 * So the room is above the clouds. Below eye level, a sea of cloud to the
 * horizon, lit faintly from beneath here and there by the city it hides;
 * above, a dark sky. Five sleek dark towers rise through the cloud, the
 * nearest about 650 m out (its whole width inside the window), the rest
 * further and further into the haze. The homely retro room with its toy
 * train, perched over that, is the point.
 *
 * Real 3D at real scale (metres), eye level about 1.7 m. The scene's fog
 * (main.js, exponential, far too thin to touch anything indoors) melts the
 * far towers and the cloud into the horizon; bloom picks out only the
 * over-bright lights here (GLOW).
 */
import * as THREE from 'three';

// Light sources outside are this many times brighter than white, so the
// bloom picks them out and nothing indoors (see main.js).
export const GLOW = 5;
// The haze colour at the horizon, shared with main.js's fog.
export const SMOG = 0x262a36;

// The cloud sea's surface, metres below the room's floor. Luke: "lower the
// cloud level: we should be able to see further down the towers" (was -90).
const CLOUD_TOP = -380;

function canvasTex(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 16;
  return t;
}
const glowColor = (hex, k = GLOW) => new THREE.Color(hex).multiplyScalar(k);

// The towers: [x, distance, width at the cloud top, height above the cloud
// top]. The window sees about 0.27 of the distance either side of centre;
// the nearest (650 m, ±175 m in view) sits well inside that. Heights grew
// with the cloud's drop, so the tops stay where they were.
const TOWERS = [
  [-95, 650, 52, 710],
  [150, 1150, 70, 970],
  [-330, 1800, 84, 1190],
  [430, 2700, 112, 1440],
  [-40, 3800, 145, 1790],
];

export function buildCyberCity({ renderer, backZ, rand }) {
  const group = new THREE.Group();

  // ------------------------------------------------------------------- sky
  // Near black overhead, a cold dim blue-grey down at the horizon, a scatter
  // of faint stars high up.
  // Drawn at the sky plane's own proportions (16000 x 6000), so the stars
  // come out round rather than stretched into dashes.
  const skyTex = canvasTex(2048, 768, (g, w, h) => {
    const grad = g.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, '#020306');
    grad.addColorStop(0.45, '#080a12');
    grad.addColorStop(0.62, '#161a26');
    grad.addColorStop(0.68, '#262a36');
    grad.addColorStop(1, '#262a36');
    g.fillStyle = grad;
    g.fillRect(0, 0, w, h);
    for (let i = 0; i < 500; i++) {
      g.fillStyle = `rgba(220,226,255,${0.15 + rand() * 0.5})`;
      const s = rand() < 0.1 ? 2 : 1;
      g.fillRect(rand() * w, rand() * h * 0.5, s, s);
    }
  });
  // Placed so its horizon band (two-thirds down) sits at eye level.
  const sky = new THREE.Mesh(new THREE.PlaneGeometry(16000, 6000), new THREE.MeshBasicMaterial({ map: skyTex, fog: false }));
  sky.position.set(0, 1000, backZ - 7000);
  group.add(sky);

  // The towers' glass reflects this sky, brightened, or dark glass under a
  // dark sky shows no form at all.
  const envScene = new THREE.Scene();
  envScene.add(new THREE.Mesh(new THREE.SphereGeometry(10, 32, 16), new THREE.MeshBasicMaterial({ map: skyTex, color: new THREE.Color(5, 5, 5), side: THREE.BackSide })));
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envMap = pmrem.fromScene(envScene, 0.04).texture;
  pmrem.dispose();

  // ----------------------------------------------------------------- clouds
  // A tile of soft billows, seamless both ways so it can repeat and drift.
  const cloudTex = canvasTex(1024, 1024, (g, w, h) => {
    for (let i = 0; i < 900; i++) {
      const x = rand() * w;
      const y = rand() * h;
      const r = 20 + rand() * 90;
      for (const dx of [0, w, -w]) {
        for (const dy of [0, h, -h]) {
          const cx = x + dx;
          const cy = y + dy;
          if (cx + r < 0 || cx - r > w || cy + r < 0 || cy - r > h) continue;
          const rg = g.createRadialGradient(cx, cy, 0, cx, cy, r);
          rg.addColorStop(0, 'rgba(255,255,255,0.16)');
          rg.addColorStop(1, 'rgba(255,255,255,0)');
          g.fillStyle = rg;
          g.fillRect(cx - r, cy - r, r * 2, r * 2);
        }
      }
    }
  });
  // The city's glow seen through thinner cloud: a few dull warm and magenta
  // patches on the base layer.
  const glowTex = canvasTex(1024, 1024, (g, w, h) => {
    g.fillStyle = '#14161e';
    g.fillRect(0, 0, w, h);
    for (let i = 0; i < 26; i++) {
      const x = rand() * w;
      const y = rand() * h;
      const r = 60 + rand() * 160;
      const c = rand() < 0.6 ? '150,80,40' : '140,40,110';
      const rg = g.createRadialGradient(x, y, 0, x, y, r);
      rg.addColorStop(0, `rgba(${c},0.55)`);
      rg.addColorStop(1, `rgba(${c},0)`);
      g.fillStyle = rg;
      g.fillRect(x - r, y - r, r * 2, r * 2);
    }
  });
  const clouds = [];
  const SEA_W = 16000;
  const SEA_D = 9000;
  const seaZ = backZ - SEA_D / 2 - 150;
  {
    // The solid floor of the sea, with the glow patches.
    glowTex.repeat.set(SEA_W / 2400, SEA_D / 2400);
    const base = new THREE.Mesh(new THREE.PlaneGeometry(SEA_W, SEA_D), new THREE.MeshBasicMaterial({ map: glowTex }));
    base.rotation.x = -Math.PI / 2;
    base.position.set(0, CLOUD_TOP - 40, seaZ);
    group.add(base);
    clouds.push({ tex: glowTex, speed: 0.0012 });
  }
  // Billow layers over it, each a little higher and drifting at its own pace,
  // so the surface has depth and moves; lit coolly from above.
  // [height above the cloud top, opacity, metres per texture tile, drift]
  [
    [-30, 0.95, 900, 0.004],
    [-16, 0.8, 650, 0.006],
    [-6, 0.6, 1300, 0.003],
    [0, 0.45, 500, 0.008],
  ].forEach(([dy, opacity, tile, speed]) => {
    const tex = cloudTex.clone();
    tex.needsUpdate = true;
    tex.repeat.set(SEA_W / tile, SEA_D / tile);
    tex.offset.set(rand(), rand());
    const layer = new THREE.Mesh(
      new THREE.PlaneGeometry(SEA_W, SEA_D),
      new THREE.MeshBasicMaterial({ map: tex, color: 0x6c7282, transparent: true, opacity, depthWrite: false }),
    );
    layer.rotation.x = -Math.PI / 2;
    layer.position.set(0, CLOUD_TOP + dy, seaZ);
    group.add(layer);
    clouds.push({ tex, speed });
  });

  // ----------------------------------------------------------------- towers
  // Sleek: tall faceted shafts tapering to a needle, near-black glass with a
  // dull sheen of the sky, thin cold light lines up two edges, a ring of
  // light where the shaft meets the needle, a blinking light at the tip.
  // No clutter.
  const glass = new THREE.MeshStandardMaterial({ color: 0x0b0d12, metalness: 0.95, roughness: 0.16, envMap, envMapIntensity: 1.2, flatShading: true });
  const lineMat = new THREE.MeshBasicMaterial({ color: glowColor(0x7fd8ff, 2.6) });
  const ringMat = new THREE.MeshBasicMaterial({ color: glowColor(0xff3a8a, 2.2) });
  const beaconMat = new THREE.MeshBasicMaterial({ color: glowColor(0xff2018, 6) });
  // Dull: just over white, so they glow faintly rather than blaze.
  const bandMats = [0x5fc8e0, 0xd0508a, 0xc08a3a, 0x8a70d8].map((c) => new THREE.MeshBasicMaterial({ color: glowColor(c, 1.5) }));
  for (const [x, dist, w, h] of TOWERS) {
    const t = new THREE.Group();
    t.position.set(x, CLOUD_TOP, backZ - dist);
    group.add(t);
    const sides = rand() < 0.5 ? 6 : 8;
    const below = 300; // the shaft carries on down out of sight into the cloud
    const total = h + below;
    const spin = rand() * Math.PI;
    // Body: wide at the cloud, tapering, then a long needle.
    const bodyH = total * 0.82;
    const rTop = w * 0.18;
    const body = new THREE.Mesh(new THREE.CylinderGeometry(rTop, w / 2, bodyH, sides, 1), glass);
    body.position.y = bodyH / 2 - below;
    body.rotation.y = spin;
    t.add(body);
    const needleH = total * 0.25;
    const needle = new THREE.Mesh(new THREE.CylinderGeometry(0.6, rTop, needleH, sides), glass);
    needle.position.y = bodyH - below + needleH / 2;
    needle.rotation.y = spin;
    t.add(needle);
    const topY = bodyH - below + needleH;
    // Light lines up two opposite edges of the body, following its taper.
    if (rand() < 0.75) {
      for (const k of [0, sides / 2]) {
        // CylinderGeometry's vertex i sits at angle i/sides*2π from +z
        // toward +x, then the mesh's spin turns it.
        const a = (k / sides) * Math.PI * 2 + spin;
        const p0 = new THREE.Vector3(Math.sin(a) * (w / 2), -below, Math.cos(a) * (w / 2));
        const p1 = new THREE.Vector3(Math.sin(a) * rTop, bodyH - below, Math.cos(a) * rTop);
        const line = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.6, p0.distanceTo(p1), 4), lineMat);
        line.position.copy(p0).lerp(p1, 0.5);
        line.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), p1.clone().sub(p0).normalize());
        t.add(line);
      }
    }
    const ring = new THREE.Mesh(new THREE.TorusGeometry(rTop + 0.6, 0.5, 6, 32), ringMat);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = bodyH - below - 4;
    t.add(ring);
    // Bands of dull neon round the body (Luke: "a few more horizontal bands
    // of dull neon light"), each following the shaft's facets at its height:
    // a polygonal ring with a corner on each of the body's edges.
    const bands = 3 + Math.floor(rand() * 4);
    for (let i = 0; i < bands; i++) {
      const y = h * (0.12 + 0.75 * ((i + 0.3 + rand() * 0.4) / bands)); // above the cloud top
      const r = w / 2 + (rTop - w / 2) * ((y + below) / bodyH);
      const band = new THREE.Mesh(new THREE.TorusGeometry(r + 0.8, 1.4, 4, sides), bandMats[Math.floor(rand() * bandMats.length)]);
      band.rotation.x = Math.PI / 2; // the torus lies flat, its first corner on +x
      const holder = new THREE.Group();
      holder.rotation.y = spin - Math.PI / 2; // turn that corner onto the body's first edge (+z, then spun)
      holder.position.y = y;
      holder.add(band);
      t.add(holder);
    }
    const tip = new THREE.Mesh(new THREE.SphereGeometry(1.6 + dist * 0.0012, 10, 8), beaconMat);
    tip.position.y = topY + 1;
    t.add(tip);
  }

  // ---------------------------------------------------------- flying cars
  // A few, crossing above the cloud between the towers.
  const cars = [];
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x101217, metalness: 0.95, roughness: 0.2, envMap });
  const headMat = new THREE.MeshBasicMaterial({ color: glowColor(0xd8e6f0, 3.5) });
  const tailMat = new THREE.MeshBasicMaterial({ color: glowColor(0xff2a30, 3.5) });
  const bodyGeo = new THREE.CapsuleGeometry(0.85, 3.6, 6, 16);
  bodyGeo.rotateZ(Math.PI / 2);
  bodyGeo.scale(1, 0.55, 1);
  for (let i = 0; i < 6; i++) {
    const car = new THREE.Group();
    car.add(new THREE.Mesh(bodyGeo, bodyMat));
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.18, 1.3), headMat);
    head.position.set(2.65, 0.05, 0);
    car.add(head);
    const tail = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.16, 1.5), tailMat);
    tail.position.set(-2.65, 0.05, 0);
    car.add(tail);
    const dist = 250 + rand() * 1200;
    const span = dist * 0.5 + 100;
    const dir = rand() < 0.5 ? 1 : -1;
    car.rotation.y = dir > 0 ? 0 : Math.PI;
    car.position.set((rand() * 2 - 1) * span, -150 + rand() * 180, backZ - dist);
    group.add(car);
    cars.push({ car, span, speed: dir * (30 + rand() * 40) });
  }

  let time = 0;
  return {
    group,
    update(dt) {
      time += dt;
      for (const c of cars) {
        c.car.position.x += c.speed * dt;
        if (c.car.position.x > c.span) c.car.position.x = -c.span;
        if (c.car.position.x < -c.span) c.car.position.x = c.span;
      }
      for (const c of clouds) c.tex.offset.x += c.speed * dt;
      // Tip lights: a slow blink, on for a moment every 1.6 s.
      beaconMat.visible = time % 1.6 < 0.5;
    },
  };
}
