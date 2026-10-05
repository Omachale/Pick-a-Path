/**
 * The three paper planes, folded in code.
 *
 * Each is a handful of flat paper panels meeting at creases, shaded per
 * facet (lit, flat normals), so every fold catches the light differently:
 * that's what makes it read as folded paper rather than a plastic toy. The
 * silhouettes are deliberately unlike each other, so a plane can be named
 * from its shape alone (the brief's "someone should be able to name the
 * plane from its silhouette"), with colour only as a second cue:
 *
 *  - Dart: long, narrow, sharp. A slim arrowhead with a deep keel.
 *  - Classic: the plane everyone folds first. Broad triangle wings, a
 *    blunt folded nose, and little upturned wingtips.
 *  - Glider: wide, straight wings like a sailplane on a short body, with a
 *    curled-up trailing edge and a tail.
 *
 * Model space: nose toward -z, wings along x, up +y, about 1 unit long; the
 * game scales them (PLANE_SCALE).
 *
 * Paper looks (switchable): plain white, notebook (ruled lines and a red
 * margin, as torn from an exercise book), and coloured origami paper.
 */

import * as THREE from 'three';

// Bigger than a real paper plane next to the thrower (a toy's proportions):
// at true size it's a speck a few metres away.
export const PLANE_SCALE = 0.8;

// Per-plane colour identity, used by the trail and the UI as well.
export const PLANE_COLORS = {
  dart: '#e2533f',
  allrounder: '#3f86e2',
  glider: '#e8b13a',
};

/** Builds a geometry from a list of triangles [[x,y,z]x3], flat-shaded. */
function fromTriangles(tris) {
  const pos = new Float32Array(tris.length * 9);
  tris.forEach((t, i) => t.forEach((v, j) => pos.set(v, i * 9 + j * 3)));
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.computeVertexNormals(); // non-indexed: one normal per face = crisp creases
  // UVs: a top-down projection, so paper texture runs along the plane.
  const uv = new Float32Array((pos.length / 3) * 2);
  for (let i = 0; i < pos.length / 3; i++) {
    uv[i * 2] = pos[i * 3] * 0.9 + 0.5;
    uv[i * 2 + 1] = pos[i * 3 + 2] * 0.9 + 0.5;
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return g;
}

/** Mirror helper: a right-side triangle and its left twin (winding flipped). */
function both(tris) {
  const out = [];
  for (const t of tris) {
    out.push(t);
    out.push([t[0], t[2], t[1]].map(([x, y, z]) => [-x, y, z]));
  }
  return out;
}

const SHAPES = {
  // Long narrow delta. Wing in two facets (an inner panel and an outer one
  // folded slightly up), a deep keel below the centre crease.
  dart() {
    const L = 0.6; // half length
    const nose = [0, 0, -L];
    const tail = [0, 0, L];
    const fold = [0.1, 0.012, L]; // inner crease meets the trailing edge
    const tip = [0.27, 0.07, L * 0.98];
    const keelTail = [0, -0.13, L * 0.92];
    const keelNose = [0, -0.02, -L * 0.55];
    return both([
      [nose, fold, tail],
      [nose, tip, fold],
      [nose, tail, keelTail],
      [nose, keelTail, keelNose],
    ]);
  },
  // The first plane everyone folds: broad wings, a blunt nose where the
  // corners were folded in, upturned tips.
  allrounder() {
    const L = 0.5;
    const noseL = [0.035, 0, -L];
    const noseC = [0, -0.01, -L + 0.02];
    const tail = [0, 0, L];
    const fold = [0.13, 0.02, L];
    const wingRoot = [0.13, 0.02, -L * 0.2];
    const tipFront = [0.38, 0.05, L * 0.55];
    const tipBack = [0.38, 0.05, L];
    const wingletTop = [0.4, 0.17, L * 0.97];
    const wingletFront = [0.4, 0.12, L * 0.62];
    const keelTail = [0, -0.11, L * 0.9];
    return both([
      [noseC, noseL, tail],
      [noseL, fold, tail],
      [noseL, wingRoot, fold],
      [wingRoot, tipFront, fold],
      [fold, tipFront, tipBack],
      [tipFront, wingletFront, tipBack],
      [tipBack, wingletFront, wingletTop],
      [noseC, tail, keelTail],
    ]);
  },
  // Sailplane: long straight wings, short body, a tail, the trailing edge
  // curled up a little (the "flaps" that make a paper glider float).
  glider() {
    const body = 0.42;
    const nose = [0, 0, -body];
    const tailEnd = [0, 0.02, body + 0.08];
    const le = -0.08; // wing leading edge z
    const te = 0.14; // trailing edge z
    const span = 0.6;
    const rootLE = [0.04, 0.01, le];
    const rootTE = [0.04, 0.01, te];
    const tipLE = [span, 0.07, le + 0.05];
    const tipTE = [span, 0.08, te - 0.01];
    const flapIn = [0.04, 0.04, te + 0.05];
    const flapOut = [span, 0.11, te + 0.03];
    const midLE = [span * 0.5, 0.035, le + 0.015];
    const midTE = [span * 0.5, 0.04, te + 0.005];
    const keelLow = [0, -0.07, 0.05];
    const tailL = [0.17, 0.03, body + 0.06];
    const tailRoot = [0, 0.02, body - 0.06];
    const fin = [0, 0.15, body + 0.1];
    return [
      ...both([
        [nose, rootLE, [0, 0.005, te]],
        [rootLE, midLE, rootTE],
        [midLE, midTE, rootTE],
        [midLE, tipLE, midTE],
        [tipLE, tipTE, midTE],
        [rootTE, midTE, flapIn],
        [midTE, flapOut, flapIn],
        [midTE, tipTE, flapOut],
        [nose, [0, 0.005, te], keelLow],
        [[0, 0.005, te], tailRoot, tailEnd],
        [tailRoot, tailL, tailEnd],
      ]),
      [tailRoot, tailEnd, fin],
      [tailRoot, fin, tailEnd],
    ];
  },
};

// ------------------------------------------------------------------ paper

function paperCanvas(draw) {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d');
  draw(g, 512);
  // Paper fibre: faint speckle over everything.
  const img = g.getImageData(0, 0, 512, 512);
  let s = 7;
  for (let i = 0; i < img.data.length; i += 4) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const n = ((s >> 8) & 15) - 7;
    img.data[i] += n;
    img.data[i + 1] += n;
    img.data[i + 2] += n;
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

const textureCache = new Map();
function paperTexture(look, key) {
  const id = look + ':' + key;
  if (textureCache.has(id)) return textureCache.get(id);
  let t;
  if (look === 'notebook') {
    t = paperCanvas((g, S) => {
      g.fillStyle = '#fbf8ee';
      g.fillRect(0, 0, S, S);
      g.strokeStyle = 'rgba(80,130,205,0.75)';
      g.lineWidth = 3;
      for (let y = 18; y < S; y += 34) {
        g.beginPath();
        g.moveTo(0, y);
        g.lineTo(S, y);
        g.stroke();
      }
      g.strokeStyle = 'rgba(214,72,72,0.8)';
      g.lineWidth = 4;
      g.beginPath();
      g.moveTo(S * 0.3, 0);
      g.lineTo(S * 0.3, S);
      g.stroke();
    });
  } else if (look === 'colour') {
    t = paperCanvas((g, S) => {
      g.fillStyle = PLANE_COLORS[key];
      g.fillRect(0, 0, S, S);
    });
  } else {
    t = paperCanvas((g, S) => {
      g.fillStyle = '#f7f5f0';
      g.fillRect(0, 0, S, S);
    });
  }
  // Lines run across the plane, not along it: rotate the projection.
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.rotation = look === 'notebook' ? Math.PI / 2 : 0;
  textureCache.set(id, t);
  return t;
}

/**
 * A plane mesh, ready to place. `look` is 'plain' | 'notebook' | 'colour'.
 * The coloured stripe on plain/notebook paper (a marker line along the
 * crease) carries the plane's colour identity there too.
 */
export function buildPlane(key, look = 'plain') {
  const group = new THREE.Group();
  const geo = fromTriangles(SHAPES[key]());
  // A little of the paper's own colour added back as emissive: paper is
  // the brightest thing in a dusk sky, and fully lit-only it went grey
  // whenever a wing turned away from the sun.
  const tex = paperTexture(look, key);
  const mat = new THREE.MeshLambertMaterial({
    map: tex,
    emissive: 0x555555,
    emissiveMap: tex,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geo, mat);
  group.add(mesh);
  // Crisp edges: a thin dark outline on every fold and edge, which keeps a
  // white plane readable against a pale sky.
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(geo, 1),
    new THREE.LineBasicMaterial({ color: look === 'colour' ? 0x3a2a24 : 0x6b6460, transparent: true, opacity: 0.55 })
  );
  group.add(edges);
  // The outline is one pixel whatever the distance, so on a far-off plane it
  // would swamp the paper and turn it into a dark speck. Fade it out with
  // distance from the camera.
  edges.onBeforeRender = (_r, _s, cam) => {
    const d = cam.position.distanceTo(group.getWorldPosition(_wp));
    edges.material.opacity = 0.55 * THREE.MathUtils.clamp(1 - (d - 2.5) / 3, 0, 1);
  };
  edges.material = edges.material.clone();
  if (look !== 'colour') {
    // A marker stripe down the centre crease in the plane's own colour.
    const stripe = new THREE.Mesh(
      new THREE.PlaneGeometry(0.035, key === 'glider' ? 0.75 : 1.0),
      new THREE.MeshLambertMaterial({ color: PLANE_COLORS[key], side: THREE.DoubleSide })
    );
    stripe.rotation.x = -Math.PI / 2;
    stripe.position.set(0, 0.006, key === 'glider' ? 0.02 : 0.05);
    stripe.scale.y = key === 'allrounder' ? 0.9 : key === 'glider' ? 1 : 1.1;
    group.add(stripe);
  }
  group.scale.setScalar(PLANE_SCALE);
  group.userData.key = key;
  return group;
}

/**
 * Places a plane mesh for a flight state: nose along `heading` (radians
 * right of straight out, -z), pitched by `pitch`, rolled by `roll`.
 */
const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _wp = new THREE.Vector3();
export function posePlane(obj, x, y, z, heading, pitch, roll = 0) {
  obj.position.set(x, y, z);
  _e.set(pitch, -heading, roll, 'YXZ');
  obj.quaternion.setFromEuler(_e);
}
