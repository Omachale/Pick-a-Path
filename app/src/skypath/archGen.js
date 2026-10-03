/**
 * Shrine archway: two pillars and a crossbar, ancient and a little magical.
 * Built from Luke's sketch (2026-10-03): 1.5 m across the pillars' outer
 * edges, beam roughly twice that long, pillars about 1.3 m tall to the beam.
 *
 * Units are metres, Y up, ground at y=0, the arch centred on the origin and
 * spanning X. You walk through it along Z. That keeps it 1:1 with Blender,
 * and the game can scale it to fit wherever it goes.
 *
 * Construction follows the game's art convention (see CLAUDE.md): unlit
 * MeshBasicMaterial, with lighting baked in. Wear, moss and grime are painted
 * into procedural textures (archTextures.js), and directional shade plus
 * contact darkening is baked per-vertex into COLOR_0. Every part has real
 * UVs, so the 'clay' material mode doubles as the texture-wrap fallback:
 * same meshes and UVs, one plain material per slot for Blender.
 *
 * Geometry is merged per material slot (~11 draw calls for the whole arch).
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { buildArchTextures, rng } from './archTextures.js';

export const ARCH_DEFAULTS = {
  seed: 7,
  span: 1.5,            // outer edge to outer edge of the two pillar shafts, at their foot
  // Slimmed from 0.095/0.084 (Luke, 2026-10-03, after the first preview).
  // Plinth, drum and bearing block scale with this, so they stay in proportion.
  pillarRadius: 0.08,   // at the foot
  pillarTopRadius: 0.071, // entasis: pillars taper slightly toward the top
  clearHeight: 1.27,    // ground to the underside of the beam, at the centre
  beamLength: 2.6,      // main (red) beam
  beamHeight: 0.2,
  beamDepth: 0.16,
  capLength: 2.78,      // dark cap board on top; overhangs the beam and flares
  capHeight: 0.12,
  capDepth: 0.25,
  upturn: 0.075,        // how far the beam's ends lift; the cap follows the same curve
  capFlare: 0.3,        // extra cap thickness at its tips, as a fraction of capHeight
  plinthTop: 0.33,      // stone base height, where the wooden shaft begins
  bracketHeight: 0.14,  // bracket stack between shaft top and beam
  // Rope raised to sit just under the pillars' head bands, and thinned, so
  // word signs can hang from it (Luke, 2026-10-03).
  ropeHeight: 1.065,    // where the sacred rope is tied around the pillars
  ropeSag: 0.07,
  ropeThickness: 0.6,   // multiplier on the rope's original girth
  ropeCharms: true,     // zigzag paper and straw fringes; off when signs hang there instead
  plinthSides: 8,       // faceted stone plinth: 8 or 6
  lotusPetals: 12,
  midBand: true,        // the plain bronze band halfway up each pillar
  bells: true,
  weathering: 1,        // scales the geometric warp/jitter (0 = machine-perfect)
};

// ------------------------------------------------------------------ builder

/** Tiny indexed mesh builder: positions + UVs, normals computed at the end. */
class MB {
  constructor() {
    this.p = [];
    this.uv = [];
    this.idx = [];
  }
  v(x, y, z, u, v) {
    this.p.push(x, y, z);
    this.uv.push(u, v);
    return this.p.length / 3 - 1;
  }
  /** Triangle; if `want` is given, winding is flipped to face along it. */
  tri(a, b, c, want) {
    if (want) {
      const P = this.p;
      const ax = P[a * 3], ay = P[a * 3 + 1], az = P[a * 3 + 2];
      const ux = P[b * 3] - ax, uy = P[b * 3 + 1] - ay, uz = P[b * 3 + 2] - az;
      const vx = P[c * 3] - ax, vy = P[c * 3 + 1] - ay, vz = P[c * 3 + 2] - az;
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      if (nx * want.x + ny * want.y + nz * want.z < 0) [b, c] = [c, b];
    }
    this.idx.push(a, b, c);
  }
  quad(a, b, c, d, want) {
    this.tri(a, b, c, want);
    this.tri(a, c, d, want);
  }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setIndex(this.idx);
    g.computeVertexNormals();
    return g;
  }
}

/**
 * Lathe with control over seams. `profile` is [[r, y, hard?], ...] traced
 * bottom-outer → top-inner (inner surfaces traced downward first, as for a
 * bell). A `hard` point is emitted twice so the normals break there (a crisp
 * moulding edge instead of a smeared one). `flat` gives faceted sides (the
 * octagonal plinth); `mod(r, y, theta)` lets carving push the radius around.
 * v follows arc length 0..1 up the profile; u goes once around times uRepeat.
 */
function revolve(profile, segs, o = {}) {
  const phase = o.phase ?? 0, uRep = o.uRepeat ?? 1;
  const rows = [];
  let len = 0;
  for (let i = 0; i < profile.length; i++) {
    const [r, y, hard] = profile[i];
    if (i) len += Math.hypot(r - profile[i - 1][0], y - profile[i - 1][1]);
    rows.push({ r, y, s: len, dupNext: false });
    if (hard && i > 0 && i < profile.length - 1) rows.push({ r, y, s: len, dupNext: false, dup: true });
  }
  const mb = new MB();
  const ring = (row, a, u) => {
    const r = o.mod ? o.mod(row.r, row.y, a) : row.r;
    return mb.v(Math.sin(a + phase) * r, row.y, Math.cos(a + phase) * r, u * uRep, row.s / len);
  };
  const build = (cols) => {
    for (let j = 0; j < rows.length - 1; j++) {
      if (rows[j + 1].dup) continue;
      for (let i = 0; i < cols.length - 1; i++) {
        const a = cols[i][j], b = cols[i + 1][j], c = cols[i + 1][j + 1], d = cols[i][j + 1];
        mb.tri(a, b, c);
        mb.tri(a, c, d);
      }
    }
  };
  const colFor = (k) => rows.map((row) => ring(row, (k / segs) * Math.PI * 2, k / segs));
  if (o.flat) {
    for (let k = 0; k < segs; k++) build([colFor(k), colFor(k + 1)]);
  } else {
    const cols = [];
    for (let k = 0; k <= segs; k++) cols.push(colFor(k));
    build(cols);
  }
  return mb.geometry();
}

/**
 * Sweeps a convex cross-section along X. `profile` is [[y, z], ...] around
 * the section; every corner is hard. `yOff(x)` bends the sweep (the beam's
 * upturn) and `scale(x)` -> [sy, sz] grows it (the cap's flaring tips).
 * Ends are capped. u runs 0..1 along the length, v 0..1 around the perimeter.
 */
function sweepX(profile, x0, x1, n, o = {}) {
  const yOff = o.yOff ?? (() => 0), scale = o.scale ?? (() => [1, 1]);
  const cy = profile.reduce((s, p) => s + p[0], 0) / profile.length;
  const cz = profile.reduce((s, p) => s + p[1], 0) / profile.length;
  const per = [0];
  for (let i = 0; i < profile.length; i++) {
    const a = profile[i], b = profile[(i + 1) % profile.length];
    per.push(per[i] + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  const P = per[per.length - 1];
  // uvScale: tile by metres (tileable textures) instead of stretching 0..1
  const us = o.uvScale ? Math.abs(x1 - x0) * o.uvScale : 1, vs = o.uvScale ? P * o.uvScale : 1;
  const at = (x, p) => {
    const [sy, sz] = scale(x);
    return [x, yOff(x) + cy + (p[0] - cy) * sy, cz + (p[1] - cz) * sz];
  };
  const mb = new MB();
  const want = new THREE.Vector3();
  for (let e = 0; e < profile.length; e++) {
    const a = profile[e], b = profile[(e + 1) % profile.length];
    want.set(0, (a[0] + b[0]) / 2 - cy, (a[1] + b[1]) / 2 - cz);
    const ia = [], ib = [];
    for (let k = 0; k <= n; k++) {
      const x = x0 + ((x1 - x0) * k) / n, u = k / n;
      ia.push(mb.v(...at(x, a), u * us, (per[e] / P) * vs));
      ib.push(mb.v(...at(x, b), u * us, (per[e + 1] / P) * vs));
    }
    for (let k = 0; k < n; k++) mb.quad(ia[k], ib[k], ib[k + 1], ia[k + 1], want);
  }
  if (o.caps !== false) {
    const tris = THREE.ShapeUtils.triangulateShape(profile.map((p) => new THREE.Vector2(p[1], p[0])), []);
    for (const [x, sgn] of [[x0, -1], [x1, 1]]) {
      const ids = profile.map((p) => mb.v(...at(x, p), 0.5 + p[1] * 2, p[0] * 2));
      for (const t of tris) mb.tri(ids[t[0]], ids[t[1]], ids[t[2]], new THREE.Vector3(sgn, 0, 0));
    }
  }
  return mb.geometry();
}

/**
 * Tube along a polyline with per-point radius. Frames use a fixed reference
 * axis rather than Frenet, so near-straight runs (ropes, cords) don't twist.
 */
function tube(points, radius, radial = 8, o = {}) {
  const ref = o.ref ?? new THREE.Vector3(0, 0, 1);
  const uScale = o.uScale ?? 1;
  const mb = new MB();
  const T = new THREE.Vector3(), N = new THREE.Vector3(), B = new THREE.Vector3(), out = new THREE.Vector3();
  let len = 0;
  const rings = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (i) len += p.distanceTo(points[i - 1]);
    T.subVectors(points[Math.min(i + 1, points.length - 1)], points[Math.max(i - 1, 0)]).normalize();
    N.crossVectors(ref, T).normalize();
    B.crossVectors(T, N);
    const r = typeof radius === 'function' ? radius(i / (points.length - 1)) : radius;
    const ring = [];
    for (let k = 0; k <= radial; k++) {
      const a = (k / radial) * Math.PI * 2;
      out.copy(p).addScaledVector(N, Math.cos(a) * r).addScaledVector(B, Math.sin(a) * r);
      ring.push(mb.v(out.x, out.y, out.z, len * uScale, k / radial));
    }
    rings.push({ ring, p: p.clone() });
  }
  const want = new THREE.Vector3(), tmp = new THREE.Vector3();
  for (let i = 0; i < rings.length - 1; i++)
    for (let k = 0; k < radial; k++) {
      const a = rings[i].ring[k], b = rings[i].ring[k + 1], c = rings[i + 1].ring[k + 1], d = rings[i + 1].ring[k];
      want.set(mb.p[a * 3], mb.p[a * 3 + 1], mb.p[a * 3 + 2]).sub(tmp.copy(rings[i].p));
      mb.quad(a, b, c, d, want);
    }
  return mb.geometry();
}

// ------------------------------------------------------------------ finishing

/**
 * Smooth-ish 3D wobble from position alone, so vertices duplicated at hard
 * edges move together and seams never open.
 */
function warp(g, amp, freq = 9) {
  if (!amp) return g;
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i) * freq, y = p.getY(i) * freq, z = p.getZ(i) * freq;
    p.setXYZ(
      i,
      p.getX(i) + amp * Math.sin(y * 1.3 + Math.sin(z * 0.7)) * Math.sin(z * 1.1 + 2),
      p.getY(i) + amp * 0.6 * Math.sin(x * 1.7 + Math.sin(z * 1.3)) * Math.sin(z * 0.9 + 1),
      p.getZ(i) + amp * Math.sin(x * 1.1 + Math.sin(y * 1.9)) * Math.sin(y * 0.8 + 3),
    );
  }
  g.computeVertexNormals();
  return g;
}

const KEY = new THREE.Vector3(0.45, 0.8, 0.4).normalize();

/**
 * Bakes form shading into COLOR_0: a soft key light from front-left-above,
 * a sky term, and contact darkening from `ao(x, y, z)`. Vertex colour is
 * capped at 1 (glTF COLOR_0 is 0..1); the textures carry the brightness.
 */
function bake(g, ao) {
  const p = g.attributes.position, n = g.attributes.normal;
  const col = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const nx = n.getX(i), ny = n.getY(i), nz = n.getZ(i);
    const d = Math.max(0, nx * KEY.x + ny * KEY.y + nz * KEY.z);
    let s = 0.5 + 0.42 * d + 0.1 * ny;
    s *= ao(p.getX(i), p.getY(i), p.getZ(i));
    s = Math.min(1, Math.max(0.2, s));
    // shadows lean slightly cool, lit faces slightly warm
    col[i * 3] = Math.min(1, s * (0.97 + 0.05 * d));
    col[i * 3 + 1] = s;
    col[i * 3 + 2] = Math.min(1, s * (1.03 - 0.06 * d));
  }
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return g;
}

/**
 * Colour schemes. `lacquer` tints the painted wood (pillars, beam, brackets)
 * and `cap` the top board; only the surviving paint takes the tint (see the
 * lacquer masks in archTextures.js), so bare wood, grime and stone stay
 * natural. `bronze` tints the metalwork (white = as painted) and `runes`
 * is the plinth glow. Tints multiply a neutral off-white, so a tint reads
 * about 10% darker than its hex on screen.
 *
 * Deliberately restrained (Luke, 2026-10-04, after a six-colour set that
 * included jade, indigo and ochre: "I don't want them looking so
 * colourful"): the original red, black, white and a dark brown, all with
 * the same untinted bronze and the original teal rune glow.
 */
export const ARCH_PALETTES = [
  { name: 'red', lacquer: 0xc4321f, cap: 0x2b2420, bronze: 0xffffff, runes: 0x5cf0c8 },
  { name: 'black', lacquer: 0x36312d, cap: 0x1c1814, bronze: 0xffffff, runes: 0x5cf0c8 },
  { name: 'white', lacquer: 0xe6dcc6, cap: 0x3a2d24, bronze: 0xffffff, runes: 0x5cf0c8 },
  { name: 'dark brown', lacquer: 0x5c3b26, cap: 0x231912, bronze: 0xffffff, runes: 0x5cf0c8 },
];

const LACQUERED = { pillar: 'lacquer', beam: 'lacquer', trim: 'lacquer', cap: 'cap' };

/**
 * Self-lit "fill" for the 'lit' mode, as a share of the surface's own
 * (tinted) colour added on top of whatever the scene's lights give it. The
 * game's lights are weak — the decks and most of the scene are unlit, so
 * nothing ever needed more — and at dawn (sun 0.5, sky 0.32) a lit arch read
 * as muddy grey (2026-10-04). The fill restores a floor of brightness while
 * the sun still models the form and colours it through the day. One shared
 * uniform: changing .value updates every lit arch at once.
 */
export const ARCH_LIT_FILL = { value: 0.6 };

/**
 * Shader patches on an arch material: `mask`+`colour` multiply the surviving
 * paint by a colour after the map is sampled (lacquer tint); `fill` adds
 * ARCH_LIT_FILL (lit materials only). Uniform objects live per material, so
 * every arch gets its own colour while all share compiled programs.
 */
function patchArchShader(mat, { mask = null, colour = 0xffffff, fill = false }) {
  if (!mask && !fill) return;
  const lacquerColor = { value: new THREE.Color(colour) };
  mat.onBeforeCompile = (sh) => {
    let head = '';
    if (mask) {
      sh.uniforms.lacquerMask = { value: mask };
      sh.uniforms.lacquerColor = lacquerColor;
      head += 'uniform sampler2D lacquerMask;\nuniform vec3 lacquerColor;\n';
      sh.fragmentShader = sh.fragmentShader.replace(
        '#include <map_fragment>',
        '#include <map_fragment>\n\tdiffuseColor.rgb *= mix(vec3(1.0), lacquerColor, texture2D(lacquerMask, vMapUv).r);',
      );
    }
    if (fill) {
      sh.uniforms.archFill = ARCH_LIT_FILL;
      head += 'uniform float archFill;\n';
      sh.fragmentShader = sh.fragmentShader.replace(
        '#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\n\ttotalEmissiveRadiance += diffuseColor.rgb * archFill;',
      );
    }
    sh.fragmentShader = head + sh.fragmentShader;
  };
  const key = `arch-${mask ? 'tint' : ''}-${fill ? 'fill' : ''}`;
  mat.customProgramCacheKey = () => key;
}
const tintLacquer = (mat, mask, colour) => patchArchShader(mat, { mask, colour });

/** Materials per slot. 'unlit' is the game look; 'lit' and 'clay' are for inspection/export. */
export function archMaterials(tex, mode = 'unlit', palette = ARCH_PALETTES[0]) {
  const slots = ['pillar', 'beam', 'cap', 'trim', 'stone', 'bronze', 'paper', 'plaque', 'runes', 'rope', 'tassel'];
  const clayTint = { stone: 0x9a9890, bronze: 0xa08050, paper: 0xe8e0c8, runes: 0x7ff0d0, rope: 0xc0a870, tassel: 0xa03030 };
  const m = {};
  for (const s of slots) {
    const special = s === 'paper' ? { side: THREE.DoubleSide, alphaTest: 0.5 } : s === 'runes' ? { transparent: true, depthWrite: false } : {};
    if (mode === 'clay') {
      m[s] = new THREE.MeshBasicMaterial({ color: clayTint[s] ?? 0xb8b0a8, vertexColors: s !== 'runes', side: special.side ?? THREE.FrontSide });
    } else if (mode === 'lit' && s !== 'runes') {
      m[s] = new THREE.MeshStandardMaterial({ map: tex[s], roughness: s === 'bronze' ? 0.45 : 0.85, metalness: s === 'bronze' ? 0.5 : 0, ...special });
    } else {
      m[s] = new THREE.MeshBasicMaterial({ map: tex[s], vertexColors: s !== 'runes', ...special });
    }
    if (mode !== 'clay') {
      const tinted = LACQUERED[s] && tex[s + 'Mask'];
      patchArchShader(m[s], {
        mask: tinted ? tex[s + 'Mask'] : null,
        colour: tinted ? palette[LACQUERED[s]] : 0xffffff,
        fill: m[s].isMeshStandardMaterial,
      });
      if (s === 'bronze') m[s].color.set(palette.bronze);
      if (s === 'runes') m[s].color.set(palette.runes);
    }
    m[s].name = `arch-${s}`;
  }
  return m;
}

/**
 * Small, seeded shape differences so no two arches are twins. Applied on
 * top of whatever params the caller fixed — the span, beam clearance and
 * rope the game sizes for its word signs are left alone; this only touches
 * proportion and ornament. Returns a new params object.
 */
export function varyArch(params, seed) {
  const r = rng(seed * 7919 + 17);
  const range = (a, b) => a + (b - a) * r();
  const pick = (list) => list[Math.floor(r() * list.length)];
  const P = { ...ARCH_DEFAULTS, ...params };
  const pillar = P.pillarRadius * range(0.92, 1.08);
  const beamLength = P.beamLength;
  return {
    ...P,
    pillarRadius: pillar,
    pillarTopRadius: pillar * range(0.84, 0.94),
    upturn: range(0.045, 0.11),
    capFlare: range(0.15, 0.45),
    capLength: beamLength + range(0.12, 0.32),
    capHeight: P.capHeight * range(0.88, 1.15),
    beamHeight: P.beamHeight * range(0.9, 1.1),
    plinthTop: range(0.3, 0.37),
    bracketHeight: range(0.13, 0.15), // more would push the head band down onto the rope
    plinthSides: pick([6, 8, 8]),
    lotusPetals: pick([8, 10, 12, 12, 16]),
    midBand: r() < 0.7,
    bells: r() < 0.75,
  };
}

// ------------------------------------------------------------------ parts

const SQ2 = Math.SQRT2;

const sstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const hash = (x, y, z) => {
  const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return s - Math.floor(s);
};

/** Box UVs are 0..1 per face; shrink them so tiny parts don't squash a whole texture. */
function tileUV(g, k) {
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * k, uv.getY(i) * k);
  return g;
}

/** Cracked flagstone footing under each pillar. */
function footing(x, w, k) {
  const g = new THREE.BoxGeometry(0.58 * k, 0.06, 0.58 * k, 8, 1, 8);
  g.translate(0, 0.02, 0);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const vx = p.getX(i), vy = p.getY(i), vz = p.getZ(i);
    const h = hash(vx, 0, vz), top = vy > 0.03;
    let ny = vy;
    if (top) ny += (h - 0.5) * 0.012 * w;
    if (top && Math.abs(vx) > 0.25 * k && Math.abs(vz) > 0.25 * k) ny -= 0.022 * w * h; // chipped corners
    p.setXYZ(i, vx + (hash(vz, 1, vx) - 0.5) * 0.02 * w, ny, vz + (hash(vx, 2, vz) - 0.5) * 0.02 * w);
  }
  g.computeVertexNormals();
  g.translate(x, 0, 0);
  return g;
}

function pillarSet(side, P, add, pillarR, shaftTop) {
  const x = side * (P.span / 2 - P.pillarRadius);
  const w = P.weathering;
  const at = (g) => g.translate(x, 0, 0);
  const k = P.pillarRadius / 0.095; // base parts were drawn around a 0.095 pillar

  add('stone', footing(x, w, k));

  // Faceted plinth, one flat face toward the path. Radii below are apothems
  // (centre to the middle of a face); revolve wants centre-to-corner.
  const n = P.plinthSides;
  const A = (a) => (a / Math.cos(Math.PI / n)) * k;
  const facets = { flat: true, phase: Math.PI / n };
  const y0 = 0.05;
  add('stone', at(revolve([
    [A(0.205), y0 - 0.01, true], [A(0.205), 0.078, true], [A(0.19), 0.093, true],
    [A(0.19), 0.2, true], [A(0.165), 0.214, true], [A(0.15), 0.222, true], [0, 0.222],
  ], n, facets)));
  // Glowing carved runes wrapping the plinth's middle band.
  add('runes', at(revolve([[A(0.19) + 0.0018 * k, 0.112], [A(0.19) + 0.0018 * k, 0.18]], n, facets)));

  // Lotus drum: petals pushed out of a round cushion.
  const drum = [[0.156 * k, 0.222, true]];
  const dh = P.plinthTop - 0.238;
  for (let i = 0; i <= 16; i++) {
    const t = i / 16;
    drum.push([(0.15 - 0.046 * t ** 1.4) * k, 0.228 + t * dh]);
  }
  drum.push([0.104 * k, P.plinthTop, true], [0, P.plinthTop]);
  add('stone', at(revolve(drum, 96, {
    mod: (r, y, a) => {
      if (y < 0.228 || y > 0.228 + dh) return r;
      const t = Math.min(1, Math.max(0, (y - 0.228) / dh));
      // two staggered rows: broad low petals, narrower ones rising between them
      const low = (0.5 + 0.5 * Math.cos(a * P.lotusPetals)) ** (0.8 + 2 * t) * (1 - t) ** 0.7;
      const high = (0.5 + 0.5 * Math.cos(a * P.lotusPetals + Math.PI)) ** (1 + 3 * t) * Math.sin(Math.PI * Math.min(1, t * 1.15));
      return r + (0.026 * Math.max(low, 0.8 * high) - 0.01) * k;
    },
  })));

  // Wooden shaft, faintly warped with age.
  const shaft = [];
  for (let i = 0; i <= 24; i++) {
    const y = P.plinthTop - 0.01 + ((shaftTop - P.plinthTop + 0.01) * i) / 24;
    shaft.push([pillarR(y), y]);
  }
  shaft.push([0, shaftTop]);
  add('pillar', at(revolve(shaft, 40, {
    mod: (r, y, a) => r + 0.0014 * w * Math.sin(a * 5 + y * 9 + side) * Math.sin(y * 23),
  })));

  // Bronze bands with bead edges; studs on the foot and head bands.
  const band = (yb, h, studs) => {
    const r = pillarR(yb + h / 2);
    add('bronze', at(revolve([
      [r - 0.002, yb, true], [r + 0.012, yb + 0.003], [r + 0.015, yb + 0.009, true],
      [r + 0.008, yb + 0.013, true], [r + 0.008, yb + h - 0.013, true], [r + 0.015, yb + h - 0.009, true],
      [r + 0.012, yb + h - 0.003], [r - 0.002, yb + h, true],
    ], 40)));
    for (let k = 0; k < studs; k++) {
      const a = (k / studs) * Math.PI * 2 + 0.13;
      const s = new THREE.SphereGeometry(0.0085, 8, 6);
      s.translate(x + Math.sin(a) * (r + 0.008), yb + h / 2, Math.cos(a) * (r + 0.008));
      add('bronze', s);
    }
  };
  band(P.plinthTop - 0.005, 0.075, 12);
  if (P.midBand) band(0.695, 0.036, 0);
  band(shaftTop - 0.05, 0.05, 12); // slim, so the rope can sit just beneath it

  // Bracket stack: flared bearing block, crossed arms, small blocks up to the beam.
  const db = shaftTop, dt = db + 0.055;
  add('trim', at(revolve([
    [0.086 * k * SQ2, db - 0.004, true], [0.086 * k * SQ2, db + 0.016, true], [0.112 * k * SQ2, db + 0.04, true],
    [0.112 * k * SQ2, dt, true], [0, dt],
  ], 4, { flat: true, phase: Math.PI / 4 })));
  const armH = 0.05;
  const arm = (half) => {
    const prof = [
      [armH, -half], [armH, half], [armH * 0.55, half], [armH * 0.18, half - 0.016],
      [0, half - 0.045], [0, -(half - 0.045)], [armH * 0.18, -(half - 0.016)], [armH * 0.55, -half],
    ];
    return sweepX(prof, -0.036, 0.036, 1, { uvScale: 3 }); // section in X, swept along Z after rotation
  };
  const armX = arm(0.24);
  armX.rotateY(Math.PI / 2);
  add('trim', armX.translate(x, dt, 0));
  const armZ = arm(0.13);
  add('trim', armZ.translate(x, dt, 0));
  const blockTop = (bx) => P.clearHeight + P.up(bx);
  for (const [bx, bz] of [[-0.19, 0], [0, 0], [0.19, 0], [0, -0.1], [0, 0.1]]) {
    const top = blockTop(x + bx), bot = dt + armH;
    const g = tileUV(new THREE.BoxGeometry(0.062, top - bot + 0.004, 0.072), 0.25);
    g.translate(x + bx, (top + bot) / 2, bz);
    add('trim', g);
  }

  return x;
}

function beamAndCap(P, add) {
  const w = P.weathering;
  const half = P.beamLength / 2, d = P.beamDepth, h = P.beamHeight, c = 0.012;
  const body = [
    [0, -d / 2 + c], [0, d / 2 - c], [c, d / 2], [h - c, d / 2],
    [h, d / 2 - c], [h, -d / 2 + c], [h - c, -d / 2], [c, -d / 2],
  ];
  const bodyY = (x) => P.clearHeight + P.up(x);
  add('beam', warp(sweepX(body, -half, half, 90, { yOff: bodyY }), 0.0025 * w, 5));
  // Bronze sheaths over the beam ends, studded front and back.
  for (const s of [-1, 1]) {
    const a = s * (half - 0.07), b = s * (half + 0.005);
    add('bronze', sweepX(body, Math.min(a, b), Math.max(a, b), 6, { yOff: bodyY, scale: () => [1.08, 1.08], uvScale: 4 }));
    for (const z of [-1, 1])
      for (const dy of [0.05, 0.15]) {
        const st = new THREE.SphereGeometry(0.0085, 8, 6);
        const sx = s * (half - 0.035);
        st.translate(sx, bodyY(sx) + dy, z * (d / 2 * 1.08 + 0.002));
        add('bronze', st);
      }
  }

  const ch = P.capHeight, cd = P.capDepth, chalf = P.capLength / 2;
  const cap = [
    [0, -cd * 0.44], [0, cd * 0.44], [ch * 0.55, cd / 2], [ch * 0.8, cd * 0.46],
    [ch, cd * 0.1], [ch, -cd * 0.1], [ch * 0.8, -cd * 0.46], [ch * 0.55, -cd / 2],
  ];
  const capY = (x) => P.clearHeight + h + P.up(x) - 0.002;
  // The flare grows the section about its centre, so its underside dips into
  // the beam where both exist: hidden, and it keeps the tips' silhouette.
  const flare = (x) => 1 + P.capFlare * sstep(half * 0.82, chalf, Math.abs(x));
  add('cap', warp(sweepX(cap, -chalf, chalf, 110, { yOff: capY, scale: (x) => [flare(x), 1] }), 0.003 * w, 4));
  for (const s of [-1, 1]) {
    const a = s * (chalf - 0.055), b = s * (chalf + 0.004);
    add('bronze', sweepX(cap, Math.min(a, b), Math.max(a, b), 6, {
      yOff: capY, scale: (x) => [flare(x) * 1.07, 1.07], uvScale: 4,
    }));
  }

  // Gilded plaque, front and back, framed in bronze.
  const pw = 0.44, ph = 0.168, py = bodyY(0) + h / 2;
  for (const s of [1, -1]) {
    const z = s * (d / 2 + 0.007);
    const board = new THREE.BoxGeometry(pw, ph, 0.014);
    if (s < 0) board.rotateY(Math.PI);
    board.translate(0, py, z);
    add('plaque', board);
    const fz = s * (d / 2 + 0.012);
    for (const [bw, bh, bx, by] of [[pw + 0.03, 0.016, 0, ph / 2], [pw + 0.03, 0.016, 0, -ph / 2], [0.016, ph, pw / 2, 0], [0.016, ph, -pw / 2, 0]]) {
      const bar = new THREE.BoxGeometry(bw, bh, 0.016);
      bar.translate(bx, py + by, fz);
      add('bronze', bar);
    }
    for (const [cx, cy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const st = new THREE.SphereGeometry(0.011, 10, 8);
      st.translate((cx * pw) / 2, py + (cy * ph) / 2, fz + s * 0.008);
      add('bronze', st);
    }
  }

  // Bells under the beam ends: cord, bell, clapper, red tassel.
  const bell = [
    [0, 0.054], [0.018, 0.046], [0.025, 0.02], [0.028, 0.004], [0.031, 0, true], [0.035, 0.004],
    [0.032, 0.02], [0.026, 0.042], [0.018, 0.056], [0.009, 0.062], [0, 0.064],
  ];
  for (const s of P.bells ? [-1, 1] : []) {
    const bx = s * (half - 0.2), top = bodyY(bx), yb = top - 0.11;
    add('rope', tube([new THREE.Vector3(bx, top + 0.005, 0), new THREE.Vector3(bx, yb + 0.06, 0)], 0.0035, 6, { ref: new THREE.Vector3(1, 0, 0), uScale: 10 }));
    add('bronze', revolve(bell.map(([r, y, hd]) => [r, yb + y, hd]), 24).translate(bx, 0, 0));
    add('bronze', new THREE.SphereGeometry(0.008, 8, 6).translate(bx, yb - 0.004, 0));
    add('tassel', new THREE.SphereGeometry(0.009, 8, 6).translate(bx, yb - 0.02, 0));
    add('tassel', new THREE.ConeGeometry(0.016, 0.085, 10).translate(bx, yb - 0.065, 0));
  }
}

/** Twisted sacred rope between the pillars, with zigzag paper and straw fringes. */
function rope(P, add, pillarR, px) {
  const y = P.ropeHeight;
  const a = px - pillarR(y) + 0.004;
  const n = 90, twists = 10;
  const R = (t) => (0.016 + 0.014 * Math.sin(Math.PI * t)) * P.ropeThickness;
  const cy = (x) => y - P.ropeSag * (1 - (x / a) ** 2);
  for (let k = 0; k < 2; k++) {
    const pts = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n, x = -a + 2 * a * t;
      const dydx = (2 * P.ropeSag * x) / (a * a);
      const nl = Math.hypot(1, dydx);
      const N = new THREE.Vector3(-dydx / nl, 1 / nl, 0);
      const ph = t * twists * Math.PI * 2 + k * Math.PI;
      const off = 0.55 * R(t);
      pts.push(new THREE.Vector3(x, cy(x), 0).addScaledVector(N, Math.cos(ph) * off).add(new THREE.Vector3(0, 0, Math.sin(ph) * off)));
    }
    add('rope', tube(pts, (t) => 0.62 * R(t), 8, { uScale: 8 }));
  }
  for (const s of [-1, 1]) {
    const th = P.ropeThickness;
    const ring = new THREE.TorusGeometry(pillarR(y) + 0.012 * th, 0.015 * th, 8, 40);
    ring.rotateX(Math.PI / 2);
    add('rope', ring.translate(s * px, y, 0));
    add('rope', new THREE.SphereGeometry(0.024 * th, 10, 8).translate(s * (px - pillarR(y) - 0.012 * th), y, 0.004));
  }
  const info = { half: a, y: cy };
  if (!P.ropeCharms) return info;

  // Shide: paper folded into a zigzag of four panels.
  const r = rng(P.seed + 31);
  for (const sx of [-0.3, 0, 0.3]) {
    const mb = new MB();
    const ph = 0.052, pw = 0.04, top = cy(sx) - 0.012;
    const yaw = (r() - 0.5) * 0.7;
    const place = (lx, ly, lz) => new THREE.Vector3(lx, ly, lz).applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    for (let i = 0; i < 4; i++) {
      const ox = (i % 2 ? 0.022 : 0) - 0.011, oz = (i % 2 ? 0.006 : -0.006);
      const y1 = top - i * ph, y2 = y1 - ph;
      const corners = [[ox - pw / 2, y2], [ox + pw / 2, y2], [ox + pw / 2, y1], [ox - pw / 2, y1]];
      const ids = corners.map(([lx, ly], j) => {
        const q = place(lx, 0, oz + (j < 2 ? 0.004 : -0.004));
        return mb.v(sx + q.x, ly, q.z, 0.81 + (j === 1 || j === 2 ? 0.18 : 0), 1 - (i * ph + (j < 2 ? ph : 0)) / (4 * ph));
      });
      mb.quad(ids[0], ids[1], ids[2], ids[3], new THREE.Vector3(0, 0, 1));
    }
    add('paper', mb.geometry());
  }
  // Straw fringes between the paper.
  for (const sx of [-0.15, 0.15])
    for (let k = 0; k < 3; k++) {
      const len = 0.08 + r() * 0.03;
      const g = new THREE.ConeGeometry(0.011, len, 6);
      g.translate(sx + (k - 1) * 0.012, cy(sx) - len / 2 - 0.01, (r() - 0.5) * 0.01);
      add('rope', g);
    }
  return info;
}

/** Paper talisman pasted round a pillar, one corner peeling. */
function talisman(add, x, pillarR, theta, y0, cell, tilt) {
  const w = 0.07, h = 0.22, nu = 4, nv = 12;
  const mb = new MB();
  const grid = [];
  for (let j = 0; j <= nv; j++)
    for (let i = 0; i <= nu; i++) {
      const lx = i / nu, ly = j / nv, y = y0 + ly * h;
      const R = pillarR(y) + 0.0025;
      const ang = theta + ((lx - 0.5) * w + tilt * (ly - 0.5) * h) / R;
      const lift = 0.024 * Math.max(0, (0.35 - ly) / 0.35) ** 2 * lx ** 1.5;
      const rr = R + lift;
      grid.push(mb.v(x + Math.sin(ang) * rr, y, Math.cos(ang) * rr, (cell + 0.03 + lx * 0.94) / 5, 0.01 + ly * 0.98));
    }
  const want = new THREE.Vector3(Math.sin(theta), 0, Math.cos(theta));
  for (let j = 0; j < nv; j++)
    for (let i = 0; i < nu; i++) {
      const a = j * (nu + 1) + i;
      mb.quad(grid[a], grid[a + 1], grid[a + nu + 2], grid[a + nu + 1], want);
    }
  add('paper', mb.geometry());
}

// ------------------------------------------------------------------ sign frames

/**
 * Wooden frames for the cardboard word signs that hang from the rope —
 * three candidates for Luke to choose between (2026-10-04): "a slight
 * wooden frame... the frame should be very thin so it doesn't cover the
 * area where the words go." Every frame overlaps the cardboard's own edge
 * by less than its padding (the letters sit ~17% of the sign's height in
 * from each edge), so it can never touch a letter.
 *
 * Built around a w×h sign centred on the origin in the XY plane, in the
 * sign's own units, with bars straddling z = 0 so they sit in front of the
 * card's edge. Returns { group, above, cordX, dispose }: `above` is how far
 * the cord attachment sits above the sign's top edge, `cordX` the attachment
 * x positions.
 */
export const SIGN_FRAMES = {
  rail: 'Slim rail — four thin square bars, bronze corner caps and hanging rings',
  lintel: 'Lintel — a heavier top bar that overhangs and turns up at the ends, like the arch',
  scroll: 'Scroll — round rods top and bottom with bronze finials, hairline sides',
};

export function buildSignFrame(variant, w, h, tex, woodTint = 0x4a3222) {
  const wood = new THREE.MeshBasicMaterial({ map: tex.trim, vertexColors: true });
  if (tex.trimMask) tintLacquer(wood, tex.trimMask, woodTint);
  const metal = new THREE.MeshBasicMaterial({ map: tex.bronze, vertexColors: true });
  const parts = { wood: [], metal: [] };
  const add = (slot, g) => parts[slot].push(g);
  const box = (bw, bh, bd, x, y, z = 0) => tileUV(new THREE.BoxGeometry(bw, bh, bd), 3 * Math.max(bw, bh)).translate(x, y, z);
  const cordX = [-0.34 * w, 0.34 * w];
  let above;

  if (variant === 'rail') {
    const t = 0.05 * h, d = 0.06 * h, lap = 0.6 * t;
    const W = w + 2 * (t - lap), H = h + 2 * (t - lap);
    const yT = H / 2 - t / 2;
    add('wood', box(W, t, d, 0, yT));
    add('wood', box(W, t, d, 0, -yT));
    for (const s of [-1, 1]) add('wood', box(t, H - 2 * t, d, s * (W / 2 - t / 2), 0));
    for (const sx of [-1, 1])
      for (const sy of [-1, 1]) add('metal', box(t * 1.25, t * 1.25, d * 1.15, sx * (W / 2 - t / 2), sy * yT));
    const ringR = 0.045 * h;
    for (const x of cordX) {
      const ring = new THREE.TorusGeometry(ringR, 0.009 * h, 6, 16);
      add('metal', ring.translate(x, H / 2 + ringR * 0.8, 0));
    }
    above = H / 2 - h / 2 + ringR * 1.8;
  } else if (variant === 'lintel') {
    const t = 0.04 * h, d = 0.05 * h, lap = 0.6 * t;
    const W = w + 2 * (t - lap);
    const lh = 0.085 * h, ld = 0.075 * h, overhang = 0.09 * h;
    const lHalf = W / 2 + overhang;
    const yTop = h / 2 - lap * 0.5; // underside of the lintel
    const lift = 0.045 * h;
    const yOff = (x) => yTop + lift * (Math.abs(x) / lHalf) ** 3;
    const prof = [[0, -ld / 2], [0, ld / 2], [lh * 0.8, ld / 2], [lh, ld * 0.3], [lh, -ld * 0.3], [lh * 0.8, -ld / 2]];
    add('wood', sweepX(prof, -lHalf, lHalf, 24, { yOff, uvScale: 3 }));
    for (const s of [-1, 1]) {
      const a = s * (lHalf - 0.03 * h), b = s * (lHalf + 0.002 * h);
      add('metal', sweepX(prof, Math.min(a, b), Math.max(a, b), 3, { yOff, scale: () => [1.1, 1.1], uvScale: 6 }));
    }
    const yB = -h / 2 - t / 2 + lap;
    add('wood', box(W + 0.05 * h, t, d, 0, yB));
    for (const s of [-1, 1]) add('wood', box(t * 0.8, yTop - yB, d * 0.9, s * (W / 2 - t * 0.4), (yTop + yB) / 2));
    above = yTop + lh - h / 2;
  } else {
    const rodR = 0.04 * h, lap = rodR * 0.7;
    const rodHalf = w / 2 + 0.08 * h;
    const rod = (y) => {
      const g = new THREE.CylinderGeometry(rodR, rodR, rodHalf * 2, 12, 1);
      g.rotateZ(Math.PI / 2);
      tileUV(g, 2);
      add('wood', g.translate(0, y, 0));
      for (const s of [-1, 1]) {
        const knob = revolve([[0, 0], [rodR * 0.9, 0.004 * h], [rodR * 1.5, 0.03 * h], [rodR * 1.1, 0.055 * h], [0, 0.065 * h]], 12);
        knob.rotateZ(-s * Math.PI / 2).translate(s * rodHalf, y, 0);
        add('metal', knob);
      }
    };
    const yT = h / 2 + rodR - lap, yB = -h / 2 - rodR + lap;
    rod(yT);
    rod(yB);
    const t = 0.022 * h;
    for (const s of [-1, 1]) add('wood', box(t, yT - yB, t, s * (w / 2 - t * 0.3), 0));
    above = yT + rodR - h / 2;
  }

  const group = new THREE.Group();
  group.name = `sign-frame-${variant}`;
  const geoms = [];
  for (const [slot, list] of Object.entries(parts)) {
    if (!list.length) continue;
    for (const g of list) {
      for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
      bake(g, () => 1);
    }
    const merged = mergeGeometries(list);
    list.forEach((g) => g.dispose());
    geoms.push(merged);
    group.add(new THREE.Mesh(merged, slot === 'wood' ? wood : metal));
  }
  return {
    group,
    above,
    cordX,
    dispose() {
      geoms.forEach((g) => g.dispose());
      wood.dispose();
      metal.dispose();
    },
  };
}

// ------------------------------------------------------------------ assembly

/**
 * Builds the arch. Returns { group, textures, meshes, rope, setMode(mode), dispose() }.
 * `opts.mode`: 'unlit' (game look, default), 'lit', or 'clay' (UVs only).
 * `opts.palette`: one of ARCH_PALETTES (default vermilion).
 * `opts.textures`: shared textures; the caller then owns their disposal.
 */
export function buildArch(params = {}, opts = {}) {
  const P = { ...ARCH_DEFAULTS, ...params };
  const half = P.beamLength / 2;
  P.up = (x) => P.upturn * (Math.abs(x) / half) ** 2.4;
  const shaftTop = P.clearHeight - P.bracketHeight;
  const pillarR = (y) => {
    const t = Math.min(1, Math.max(0, (y - P.plinthTop) / (shaftTop - P.plinthTop)));
    return P.pillarRadius + (P.pillarTopRadius - P.pillarRadius) * t + 0.003 * Math.sin(Math.PI * t);
  };

  const parts = {};
  const add = (slot, g) => (parts[slot] ??= []).push(g);

  let px = 0;
  for (const s of [-1, 1]) px = pillarSet(s, P, add, pillarR, shaftTop);
  beamAndCap(P, add);
  const ropeInfo = rope(P, add, pillarR, px);
  talisman(add, -px, pillarR, 0, 0.4, 0, 0.06);
  talisman(add, -px, pillarR, Math.PI + 0.3, 0.75, 2, -0.04);
  talisman(add, px, pillarR, 0.25, 0.36, 1, -0.05);
  talisman(add, px, pillarR, Math.PI - 0.2, 0.45, 3, 0.05);

  // Contact darkening: ground, and the throat under the beam.
  const ao = (x, y) => {
    let k = 1 - 0.42 * Math.exp(-y / 0.07);
    if (Math.abs(x) < half) {
      const under = P.clearHeight + P.up(x) - y;
      if (under > -0.001 && under < 0.3) k *= 1 - 0.28 * Math.exp(-under / 0.06);
    }
    return k;
  };

  const tex = opts.textures ?? buildArchTextures(P.seed);
  const palette = opts.palette ?? ARCH_PALETTES[0];
  let mats = archMaterials(tex, opts.mode ?? 'unlit', palette);
  const group = new THREE.Group();
  group.name = 'shrine-arch';
  const meshes = {};
  for (const [slot, list] of Object.entries(parts)) {
    for (const g of list) {
      for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
      bake(g, ao);
    }
    const merged = mergeGeometries(list);
    for (const g of list) g.dispose();
    const mesh = new THREE.Mesh(merged, mats[slot]);
    mesh.name = `arch-${slot}`;
    if (slot === 'runes') mesh.renderOrder = 1;
    meshes[slot] = mesh;
    group.add(mesh);
  }

  return {
    group,
    textures: tex,
    meshes,
    /** The rope's centreline in the arch's own units: half = x reach from centre, y(x). */
    rope: ropeInfo,
    setMode(mode) {
      const next = archMaterials(tex, mode, palette);
      for (const [slot, mesh] of Object.entries(meshes)) mesh.material = next[slot];
      Object.values(mats).forEach((m) => m.dispose());
      mats = next;
    },
    dispose() {
      Object.values(meshes).forEach((m) => m.geometry.dispose());
      Object.values(mats).forEach((m) => m.dispose());
      if (!opts.textures) Object.values(tex).forEach((t) => t.dispose());
    },
  };
}
