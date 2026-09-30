/**
 * Scene pieces for the island-throwing minigame that aren't backdrop: the
 * temple island underfoot, the course's islands (Sky Path's own
 * island-basic-v2.glb and deck texture), the target's markings, and the
 * throw trails.
 *
 * Collision never looks at these meshes. It uses course.js's
 * disc-plus-cone islands, so the headless validator and the game agree
 * exactly. The meshes are scaled so their decks match those discs.
 */
import * as THREE from 'three';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';

/** Converts a glTF import to unlit materials, as Sky Path does for every prop (see skyPath.js's temple-island loader). */
function toUnlit(root) {
  root.traverse((o) => {
    if (!o.isMesh) return;
    const src = o.material;
    o.material = new THREE.MeshBasicMaterial({
      map: src.map ?? null,
      color: src.color ? src.color.clone() : undefined,
      vertexColors: src.vertexColors,
      side: src.side,
    });
  });
}

/**
 * Loads island-basic-v2.glb the way skyPath.js does. The deck is found as the
 * flattest mesh, retextured with island-circle, and its radius measured from
 * its actual vertices (not a bounding box, which overstates a disc by sqrt 2;
 * see skyPath.js). Resolves to a factory for islands of any deck radius.
 */
export function loadIslandFactory(gltfLoader, deckTex) {
  return new Promise((resolve, reject) => {
    gltfLoader.load('models/island-basic-v2.glb', (gltf) => {
      const src = gltf.scene;
      toUnlit(src);
      let deckMesh = null;
      let flattest = Infinity;
      src.traverse((o) => {
        if (!o.isMesh) return;
        o.geometry.computeBoundingBox();
        const h = o.geometry.boundingBox.max.y - o.geometry.boundingBox.min.y;
        if (h < flattest) { flattest = h; deckMesh = o; }
      });
      deckMesh.material = new THREE.MeshBasicMaterial({ map: deckTex });
      src.updateWorldMatrix(true, true);
      const p = deckMesh.geometry.attributes.position;
      const v = new THREE.Vector3();
      let deckR = 0;
      let deckTop = -Infinity;
      for (let i = 0; i < p.count; i++) {
        v.fromBufferAttribute(p, i).applyMatrix4(deckMesh.matrixWorld);
        deckR = Math.max(deckR, Math.hypot(v.x, v.z));
        deckTop = Math.max(deckTop, v.y);
      }
      resolve((radius) => {
        const s = radius / deckR;
        const holder = new THREE.Group();
        const inst = src.clone(true);
        inst.scale.setScalar(s);
        inst.position.y = -deckTop * s; // deck surface exactly at the holder's origin
        holder.add(inst);
        return holder;
      });
    }, undefined, reject);
  });
}

/**
 * The temple island, placed BEHIND the throw line. Its front edge sits just past
 * z = 0, where the player stands, with its top at y = 0. Sky Path's own
 * scaling (1.5x the temple's width; its baked 1.05/0.55/0.5 squash) is kept
 * so it's recognisably the same island.
 */
export function loadTempleIsland(gltfLoader, scene) {
  const TEMPLE_W = 19.5 * (128 / 70) * (1024 / 463); // TEMPLE_H * TEMPLE_ASPECT, as skyPath.js derives them
  gltfLoader.load('models/temple-island.glb', (gltf) => {
    const island = gltf.scene;
    toUnlit(island);
    const box = new THREE.Box3().setFromObject(island);
    const width = Math.max(box.max.x - box.min.x, box.max.z - box.min.z);
    const base = (TEMPLE_W * 1.5) / width;
    island.scale.set(base * 1.05, base * 0.55, base * 0.5);
    island.updateWorldMatrix(true, true);
    const b2 = new THREE.Box3().setFromObject(island);
    // front edge a touch in front of the throw point, so the player visibly stands on the lip
    island.position.set(-(b2.min.x + b2.max.x) / 2, 0, -b2.min.z - 0.6);
    scene.add(island);
  });
}

/** Bullseye rings on the target deck plus a light beacon above it; the 3-2-1 zones match course.js's scoreLanding. */
export function buildTargetMarker(radius) {
  const g = new THREE.Group();
  const ring = (r0, r1, color, opacity) => {
    const m = new THREE.Mesh(
      new THREE.RingGeometry(r0, r1, 64),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2 })
    );
    m.rotation.x = -Math.PI / 2;
    m.position.y = 0.04;
    m.renderOrder = 7;
    g.add(m);
  };
  ring(0, radius * 0.25, 0xffce3a, 0.75);
  ring(radius * 0.25, radius * 0.6, 0xfff4d6, 0.35);
  ring(radius * 0.6, radius, 0xffce3a, 0.18);
  ring(radius * 0.97, radius, 0xffce3a, 0.8);

  // beacon: a tall open cylinder fading upward, so a far target can be found at a glance
  const H = 22;
  const geo = new THREE.CylinderGeometry(radius * 0.18, radius * 0.25, H, 20, 6, true);
  const pos = geo.attributes.position;
  const cols = [];
  for (let i = 0; i < pos.count; i++) {
    const f = (pos.getY(i) + H / 2) / H; // 0 bottom, 1 top
    cols.push(1, 0.85, 0.35, 0.5 * (1 - f) * (1 - f));
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 4));
  const beacon = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide }));
  beacon.position.y = H / 2;
  beacon.renderOrder = 8;
  g.add(beacon);
  g.userData.beacon = beacon;
  return g;
}

/** A persistent trail for one throw, coloured by plane type. */
export function createTrail(scene, color) {
  const mat = new LineMaterial({ color, linewidth: 3, transparent: true, opacity: 0.85 });
  mat.resolution.set(innerWidth, innerHeight);
  const line = new Line2(new LineGeometry(), mat);
  line.frustumCulled = false; // points rewritten wholesale each frame; see aeroProto.js's trail note
  line.visible = false;
  scene.add(line);
  const pts = [];
  return {
    line,
    push(p) {
      pts.push(p.x, p.y, p.z);
      if (pts.length >= 6) {
        line.geometry.setPositions(pts);
        line.visible = true;
      }
    },
    fade(opacity) { mat.opacity = opacity; },
    resize() { mat.resolution.set(innerWidth, innerHeight); },
    dispose() {
      scene.remove(line);
      line.geometry.dispose();
      mat.dispose();
    },
  };
}
