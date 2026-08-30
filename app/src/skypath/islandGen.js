/**
 * Procedural floating rock island generator.
 *
 * Shared by the real game (skyPath.js, where forks stand on these) and the
 * standalone tuning page (island-proto.html / islandProto.js, where the
 * parameters below were found). Keep them in sync by editing here, not by
 * copying — the tuning page exists specifically so a future re-tune doesn't
 * require touching game code at all.
 *
 * Shape strategy: a LatheGeometry profile (a rock tapering from a wide flat
 * top down to a narrow base) gives the floating-island silhouette almost for
 * free, since revolving one hand-picked profile around Y is already roughly
 * the right shape. That alone looks like a smooth vase, not rock, so every
 * vertex is displaced by fractal value noise — small near the top (so the
 * paved deck stays flat and walkable) and large toward the bottom (so the
 * underside reads as broken stone). A separate flat disc caps the top as the
 * paved surface, and the whole mesh is rendered flat-shaded: at this
 * polycount, smooth normals read as wet clay, and per-face normals read as
 * rock immediately.
 */
import * as THREE from 'three';

// ---------------------------------------------------------------- noise
// Hand-rolled value noise, not a library: one bumpy-surface effect doesn't
// justify a dependency. Not gradient/simplex noise, so it has a faint grid
// bias at high amplitude — masked here by the rock's own irregularity.
function hash3(x, y, z) {
  const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453123;
  return s - Math.floor(s);
}
function valueNoise3(x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const w = zf * zf * (3 - 2 * zf);
  const lerp = (a, b, t) => a + (b - a) * t;
  const c000 = hash3(xi, yi, zi), c100 = hash3(xi + 1, yi, zi);
  const c010 = hash3(xi, yi + 1, zi), c110 = hash3(xi + 1, yi + 1, zi);
  const c001 = hash3(xi, yi, zi + 1), c101 = hash3(xi + 1, yi, zi + 1);
  const c011 = hash3(xi, yi + 1, zi + 1), c111 = hash3(xi + 1, yi + 1, zi + 1);
  const x00 = lerp(c000, c100, u), x10 = lerp(c010, c110, u);
  const x01 = lerp(c001, c101, u), x11 = lerp(c011, c111, u);
  const y0 = lerp(x00, x10, v), y1 = lerp(x01, x11, v);
  return lerp(y0, y1, w) * 2 - 1; // [-1, 1]
}
function fbm3(x, y, z, octaves = 4) {
  let sum = 0, amp = 0.5, freq = 1;
  for (let i = 0; i < octaves; i++) {
    sum += amp * valueNoise3(x * freq, y * freq, z * freq);
    amp *= 0.5;
    freq *= 2.1; // not a clean power of 2, so octaves don't share a lattice
  }
  return sum;
}

// mulberry32: tiny seeded PRNG so a given seed always reproduces the same
// island, without pulling in a library for one function.
export function mulberry32(seed) {
  let a = seed;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- colours
const ROCK_DARK = new THREE.Color(0x4a4238);
const ROCK_LIGHT = new THREE.Color(0x8a7d6a);
const DIRT = new THREE.Color(0x5c4a35);
const GRASS = new THREE.Color(0x5f7a3d);
const PAVER_A = new THREE.Color(0x9a9284);
const PAVER_B = new THREE.Color(0x7d7669);

/**
 * Builds one island as a THREE.Group (rock + paved deck + grass tufts).
 * The deck sits at local y≈0 — position the returned group so that lines up
 * with wherever the caller's walker plane is.
 *
 * @param {number} seed - any integer; same seed always gives the same island.
 * @param {number} bump - 0..1, how rough the rock surface is.
 * @param {number} taper - 0..1, how sharply the sides narrow toward the base.
 * @param {number} depth - multiplier on total height, independent of taper
 *   (taper shapes the curve, depth scales how far down it goes).
 * @param {number} size - world diameter at the deck.
 * @param {number} grassCount - number of grass-tuft instances at the rim.
 */
export function buildIsland({ seed, bump, taper, depth, size, grassCount }) {
  const rnd = mulberry32(seed);

  // ---- profile: wide flat top, tapering down to a rough point -----------
  // Points are (radius, y), y=0 at the deck, negative going down. Small
  // per-ring jitter on radius breaks the perfect-lathe look before noise is
  // even applied.
  const topR = size * 0.5;
  const H = size * (0.55 + taper * 0.55) * depth;
  const rings = 22;
  const profile = [];
  for (let i = 0; i <= rings; i++) {
    const t = i / rings; // 0 at top, 1 at bottom
    const y = -t * H;
    // Shape curve: stays near topR briefly (the vertical "cliff" under the
    // deck lip), then tapers — an eased power reads more like undercut rock
    // than a cone.
    const shape = Math.pow(t, 1 + taper * 1.4);
    let r = topR * (1 - shape) + 0.03 * topR * (1 - t); // never quite reaches 0
    r = Math.max(r, topR * 0.04);
    r *= 1 + (rnd() - 0.5) * 0.12; // per-ring silhouette jitter
    profile.push(new THREE.Vector2(r, y));
  }
  profile.push(new THREE.Vector2(0.001, -H * 1.04)); // close the base to a point

  const radialSegments = 48;
  const geo = new THREE.LatheGeometry(profile, radialSegments);

  // ---- displace + colour every vertex ------------------------------------
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const v = new THREE.Vector3();
  const noiseScale = 0.55;
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const depthT = THREE.MathUtils.clamp(-v.y / H, 0, 1); // 0 top, 1 bottom
    // Noise amplitude ramps with depth: the deck rim stays close to true so
    // the paved top reads flat; the underside gets the full bumpy treatment.
    // Two frequency bands, not one: large-scale fbm for lumps/undercuts, a
    // fast high-frequency term layered on top for the fine rock grain a
    // single low-octave fbm at this polycount washes out.
    const amp = bump * size * 0.35 * (0.15 + depthT * 1.3);
    const n1 = fbm3(v.x * noiseScale, v.y * noiseScale, v.z * noiseScale, 4);
    const n2 = fbm3(v.x * noiseScale * 5, v.y * noiseScale * 5, v.z * noiseScale * 5, 2);
    const n = n1 * 0.75 + n2 * 0.25;
    const len = Math.hypot(v.x, v.z) || 1;
    const nx = v.x / len, nz = v.z / len;
    // Push mostly radially (keeps rings from self-intersecting) with a
    // smaller vertical wobble for extra roughness.
    v.x += nx * n * amp;
    v.z += nz * n * amp;
    v.y += fbm3(v.x * noiseScale + 50, v.y * noiseScale, v.z * noiseScale + 50, 3) * amp * 0.5;
    pos.setXYZ(i, v.x, v.y, v.z);

    // Colour: grass right at the rim, dirt just under it, rock further down,
    // all with noise-driven variation so it isn't a clean gradient.
    const c = new THREE.Color();
    const patch = fbm3(v.x * 0.4, v.y * 0.4, v.z * 0.4, 3);
    if (depthT < 0.06) {
      c.copy(GRASS).lerp(DIRT, 0.3 + patch * 0.3);
    } else if (depthT < 0.16) {
      c.copy(DIRT).lerp(ROCK_LIGHT, THREE.MathUtils.clamp((depthT - 0.06) / 0.1, 0, 1));
    } else {
      c.copy(ROCK_LIGHT).lerp(ROCK_DARK, THREE.MathUtils.clamp(depthT + patch * 0.3, 0, 1));
    }
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();

  // Faceted, not smooth: toNonIndexed() gives every triangle its own vertex
  // copies so computeVertexNormals() (called again below) produces flat
  // per-face normals instead of smoothed ones.
  const flatGeo = geo.toNonIndexed();
  flatGeo.computeVertexNormals();

  // Bake a fixed fake sun into the vertex colours themselves, then render
  // unlit. Every other prop in this game (temple, figure, pavers aside) is
  // MeshBasicMaterial with its shading painted into the art rather than
  // computed by the renderer — real-time lighting was never tuned for
  // anything but shadow-casting. Real lighting on this mesh looked right from
  // the tuning page's elevated orbit camera (which sees mostly the
  // top-facing deck and rim) but went almost pure black in-game, where the
  // camera sits low and close and mostly sees the rock's near-vertical
  // outward faces at a grazing angle to the overhead key light. Baking the
  // shading in fixes it for every camera angle and every time of day, rather
  // than for the one angle it happened to be tuned against.
  const fGeoNormal = flatGeo.attributes.normal;
  const fGeoColor = flatGeo.attributes.color;
  const fakeLight = new THREE.Vector3(0.35, 1, 0.55).normalize();
  const n = new THREE.Vector3();
  for (let i = 0; i < fGeoNormal.count; i++) {
    n.fromBufferAttribute(fGeoNormal, i);
    // Half-lambert remap, floored well above zero: contrast between facets
    // without any face ever going fully black.
    const term = THREE.MathUtils.clamp(n.dot(fakeLight) * 0.5 + 0.5, 0.55, 1.15);
    fGeoColor.setXYZ(i, fGeoColor.getX(i) * term, fGeoColor.getY(i) * term, fGeoColor.getZ(i) * term);
  }
  fGeoColor.needsUpdate = true;

  const rockMat = new THREE.MeshBasicMaterial({ vertexColors: true });
  const rock = new THREE.Mesh(flatGeo, rockMat);
  rock.castShadow = rock.receiveShadow = true;

  // ---- paved deck: a flat disc capping the top ---------------------------
  const deckR = topR * 0.94; // slightly inset from the rock's own top ring
  const deckGeo = new THREE.CircleGeometry(deckR, radialSegments, 0, Math.PI * 2);
  deckGeo.rotateX(-Math.PI / 2);
  const dPos = deckGeo.attributes.position;
  const dColors = new Float32Array(dPos.count * 3);
  for (let i = 0; i < dPos.count; i++) {
    const x = dPos.getX(i), z = dPos.getZ(i);
    // Cheap paving-stone look: checker the plane in a rock-relative grid,
    // then jitter per-cell so it doesn't read as a perfect tile grid.
    const cell = fbm3(Math.floor(x * 1.8) * 0.3, 0, Math.floor(z * 1.8) * 0.3, 2);
    const c = new THREE.Color().copy(PAVER_A).lerp(PAVER_B, (cell + 1) / 2);
    dColors[i * 3] = c.r;
    dColors[i * 3 + 1] = c.g;
    dColors[i * 3 + 2] = c.b;
  }
  deckGeo.setAttribute('color', new THREE.BufferAttribute(dColors, 3));
  // Unlit for the same reason as the rock: the deck faces straight up, so it
  // would actually be well-lit by an overhead sun, but keeping it unlit means
  // its paving stays equally legible at every time of day without needing a
  // second baked-shading pass for a surface that has no facets to shade.
  const deck = new THREE.Mesh(deckGeo, new THREE.MeshBasicMaterial({ vertexColors: true }));
  deck.position.y = 0.02; // avoids z-fighting with the rock's own top ring
  deck.receiveShadow = true;

  const tufts = buildGrassTufts({ radius: deckR, count: grassCount, size, rnd });

  const g = new THREE.Group();
  g.add(rock, deck, tufts);
  return g;
}

/**
 * Grass tufts scattered just inside a deck's rim, as instanced cones.
 * Pulled out of buildIsland() so a hand-modelled mesh (which won't carry
 * InstancedMesh grass through a Blender round-trip — glTF export drops it
 * silently, no error) can still get the same grass by calling this directly
 * against its own deck radius.
 *
 * @param {number} radius - the deck's radius; tufts scatter just inside it.
 * @param {number} count - number of tuft instances.
 * @param {number} size - overall island scale, so tuft size matches the rock
 *   they're planted on (defaults to `radius * 2`, i.e. deck diameter, when
 *   called standalone rather than from buildIsland).
 * @param {() => number} rnd - a 0..1 random source; pass a seeded one for
 *   reproducible placement.
 */
export function buildGrassTufts({ radius, count, size = radius * 2, rnd = Math.random }) {
  const tuftGeo = new THREE.ConeGeometry(0.05 * (size / 7), 0.3 * (size / 7), 4);
  const tuftMat = new THREE.MeshBasicMaterial({ color: 0x6f9146 });
  const tufts = new THREE.InstancedMesh(tuftGeo, tuftMat, count);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  for (let i = 0; i < count; i++) {
    const a = rnd() * Math.PI * 2;
    const r = radius * (0.85 + rnd() * 0.22); // scattered right around the deck edge
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    // Sample the rock surface height near this point isn't cheap for a
    // lathe mesh, so tufts are simply planted at deck level with a little
    // downward jitter — close enough at this scale to look rooted.
    const y = -0.05 - rnd() * 0.25;
    q.setFromEuler(new THREE.Euler((rnd() - 0.5) * 0.6, rnd() * Math.PI * 2, (rnd() - 0.5) * 0.6));
    m.compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(1, 0.7 + rnd() * 0.8, 1));
    tufts.setMatrixAt(i, m);
  }
  tufts.instanceMatrix.needsUpdate = true;
  return tufts;
}
