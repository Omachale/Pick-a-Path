/**
 * The model railway's models, in more detail: the train, the buildings, the
 * hill, the greenery and the street furniture. Luke, 2026-10-06: "up the
 * detail on the interior models. The train, the buildings, the hill...
 * Those were examples. Also the greenery."
 *
 * Still a homemade model railway, not realism: card and paint, slightly
 * imperfect (small random tilts and offsets), chunky enough to read at
 * model scale. Units are metres; a building is a few centimetres tall.
 *
 * Everything is built from a `kit` handed in by main.js (its materials,
 * card texture and seeded random), so it matches the rest of the room.
 */
import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

function canvasTex(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

export function makeModels(kit) {
  const { mat, card, rand } = kit;
  const shadow = (m) => {
    m.castShadow = m.receiveShadow = true;
    return m;
  };
  const box = (w, h, d, material, x, y, z, parent) => {
    const m = shadow(new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material));
    m.position.set(x, y, z);
    parent.add(m);
    return m;
  };
  const cyl = (rTop, rBot, len, material, parent, segs = 16) => {
    const m = shadow(new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBot, len, segs), material));
    parent.add(m);
    return m;
  };
  // A small tilt and shift, as a hand-assembled model has.
  const wonky = (o, k = 1) => {
    o.rotation.z += (rand() - 0.5) * 0.03 * k;
    o.rotation.x += (rand() - 0.5) * 0.03 * k;
    return o;
  };

  // ----------------------------------------------------------- materials
  const black = mat(0x1d1b1a, { roughness: 0.6 });
  const brass = mat(0xc9a23a, { metalness: 0.7, roughness: 0.35 });
  const red = mat(0xa8362a, { roughness: 0.6 });
  const cream = card(0xeee2c4);
  const pane = mat(0x2e3a44, { roughness: 0.25, metalness: 0.2 });
  const stone = mat(0xffffff, {
    map: canvasTex(256, 256, (g, w, h) => {
      g.fillStyle = '#8f877a';
      g.fillRect(0, 0, w, h);
      // Rough courses of blocks, each a shade off, with dark mortar.
      for (let y = 0, row = 0; y < h; y += 32, row++) {
        for (let x = (row % 2) * -24; x < w; x += 48) {
          const v = 120 + rand() * 50;
          g.fillStyle = `rgb(${v},${v - 6},${v - 16})`;
          g.fillRect(x + 2, y + 2, 44, 28);
        }
      }
    }),
  });

  // ================================================================ train
  // Spokes for a wheel's face, painted on card.
  const spokeTex = canvasTex(128, 128, (g, w) => {
    g.fillStyle = '#a8362a';
    g.beginPath();
    g.arc(64, 64, 64, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#2a2220';
    g.beginPath();
    g.arc(64, 64, 52, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = '#a8362a';
    g.lineWidth = 7;
    for (let k = 0; k < 10; k++) {
      const a = (k / 10) * Math.PI * 2;
      g.beginPath();
      g.moveTo(64, 64);
      g.lineTo(64 + Math.cos(a) * 54, 64 + Math.sin(a) * 54);
      g.stroke();
    }
    g.fillStyle = '#c9a23a';
    g.beginPath();
    g.arc(64, 64, 11, 0, Math.PI * 2);
    g.fill();
    void w;
  });
  const wheelFace = mat(0xffffff, { map: spokeTex, roughness: 0.6 });
  const wheelRim = mat(0x3a3330, { metalness: 0.5, roughness: 0.4 });
  // A wheel in its own spinning holder; axle along z.
  function wheel(parent, x, z, r, spoked) {
    const holder = new THREE.Group();
    holder.position.set(x, r + 0.0015, z);
    const m = shadow(new THREE.Mesh(new THREE.CylinderGeometry(r, r, 0.004, 20), spoked ? [wheelRim, wheelFace, wheelFace] : [wheelRim, wheelRim, wheelRim]));
    m.rotation.x = Math.PI / 2;
    holder.add(m);
    parent.add(holder);
    return { holder, r };
  }
  // A lathe-turned part from a profile of [radius, height] pairs.
  // Double-sided: a lathe's faces point inward or outward depending on the
  // profile's direction, and these are seen only from outside anyway.
  const lathe = (pts, material, parent) => {
    const m = shadow(new THREE.Mesh(new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(r, y)), 20), material.clone()));
    m.material.side = THREE.DoubleSide;
    parent.add(m);
    return m;
  };
  // A curved roof: a thin open slice of cylinder lying along x, arc on top
  // (open-ended, or its end caps show as big wedges reaching to the axis).
  const curvedRoof = (r, len, arc, material, parent) => {
    const m = shadow(new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 24, 1, true, Math.PI / 2 - arc / 2, arc), material.clone()));
    m.material.side = THREE.DoubleSide;
    m.rotation.z = Math.PI / 2;
    parent.add(m);
    return m;
  };

  function buildEngine() {
    const g = new THREE.Group();
    const wheels = [];
    const body = mat(0x24384a, { roughness: 0.45, metalness: 0.15 });
    // Running board and frame.
    box(0.112, 0.006, 0.042, black, -0.004, 0.019, 0, g);
    box(0.1, 0.01, 0.026, black, -0.004, 0.012, 0, g);
    // Boiler with brass bands, smokebox at the front.
    const boiler = cyl(0.0155, 0.0155, 0.058, body, g, 24);
    boiler.rotation.z = Math.PI / 2;
    boiler.position.set(0.012, 0.037, 0);
    for (const bx of [-0.012, 0.008, 0.028]) {
      const band = cyl(0.0159, 0.0159, 0.0018, brass, g, 24);
      band.rotation.z = Math.PI / 2;
      band.position.set(bx, 0.037, 0);
    }
    const smokebox = cyl(0.0162, 0.0162, 0.014, black, g, 24);
    smokebox.rotation.z = Math.PI / 2;
    smokebox.position.set(0.047, 0.037, 0);
    const door = cyl(0.0125, 0.0125, 0.002, mat(0x3a3836), g, 24);
    door.rotation.z = Math.PI / 2;
    door.position.set(0.0545, 0.037, 0);
    box(0.002, 0.002, 0.008, brass, 0.0558, 0.037, 0, g); // door handle
    // Flared chimney, steam dome, sand dome.
    const chimney = lathe([[0.004, 0], [0.0045, 0.012], [0.0055, 0.016], [0.0075, 0.019], [0.0068, 0.02], [0, 0.02]], black, g);
    chimney.position.set(0.046, 0.051, 0);
    const dome = lathe([[0.0085, 0], [0.0085, 0.004], [0.007, 0.008], [0.004, 0.0105], [0, 0.011]], brass, g);
    dome.position.set(0.012, 0.051, 0);
    const sand = lathe([[0.006, 0], [0.006, 0.003], [0.004, 0.0065], [0, 0.0075]], body, g);
    sand.position.set(-0.008, 0.051, 0);
    // Cab: front, sides with window openings, back pillars, curved roof.
    const cx = -0.04;
    box(0.003, 0.034, 0.04, body, cx + 0.0155, 0.04, 0, g); // front sheet
    for (const k of [-1, 1]) {
      const spec = cyl(0.0035, 0.0035, 0.002, pane, g, 12);
      spec.rotation.z = Math.PI / 2;
      spec.position.set(cx + 0.0172, 0.048, k * 0.01);
      box(0.032, 0.016, 0.003, body, cx, 0.03, k * 0.0195, g); // side, below the window
      box(0.006, 0.014, 0.003, body, cx - 0.013, 0.045, k * 0.0195, g); // pillar behind the window
      box(0.004, 0.034, 0.003, body, cx + 0.014, 0.04, k * 0.0195, g); // pillar in front
    }
    // A shallow slice of a cylinder lying along the train, its arc on top.
    const roof = curvedRoof(0.04, 0.042, 1.1, black, g);
    roof.position.set(cx, 0.02, 0);
    // Cowcatcher (a red wedge), buffer beam, buffers, lamp.
    const wedge = new THREE.Shape([new THREE.Vector2(0, 0), new THREE.Vector2(0.012, 0), new THREE.Vector2(0, 0.012)]);
    const cow = shadow(new THREE.Mesh(new THREE.ExtrudeGeometry(wedge, { depth: 0.036, bevelEnabled: false }), red));
    cow.geometry.translate(0, 0, -0.018);
    cow.position.set(0.052, 0.002, 0);
    g.add(cow);
    box(0.004, 0.009, 0.044, red, 0.054, 0.018, 0, g);
    for (const k of [-1, 1]) {
      const b = cyl(0.0025, 0.0025, 0.006, black, g, 10);
      b.rotation.z = Math.PI / 2;
      b.position.set(0.059, 0.018, k * 0.014);
    }
    box(0.004, 0.005, 0.005, black, 0.054, 0.058, 0, g);
    const lamp = cyl(0.002, 0.002, 0.001, new THREE.MeshBasicMaterial({ color: 0xfff1c0 }), g, 10);
    lamp.rotation.z = Math.PI / 2;
    lamp.position.set(0.0565, 0.058, 0);
    // Driving wheels, a small leading pair, coupling rods.
    for (const k of [-1, 1]) {
      for (const x of [0.024, 0.0, -0.024]) wheels.push(wheel(g, x, k * 0.0205, 0.0105, true));
      wheels.push(wheel(g, 0.044, k * 0.0205, 0.0065, false));
    }
    const rods = [-1, 1].map((k) => box(0.05, 0.0025, 0.0015, mat(0xb8b4ac, { metalness: 0.7, roughness: 0.3 }), 0, 0.012, k * 0.0232, g));
    return {
      g,
      length: 0.118,
      chimney: new THREE.Vector3(0.046, 0.072, 0),
      // Wheels turn with the distance run; the rods follow the crank pins.
      roll(dist) {
        for (const w of wheels) w.holder.rotation.z = -dist / w.r;
        const a = -dist / 0.0105;
        rods.forEach((rod, i) => {
          const ph = a + (i ? Math.PI / 2 : 0); // the two sides a quarter turn apart
          rod.position.x = Math.cos(ph) * 0.006;
          rod.position.y = 0.012 + Math.sin(ph) * 0.006;
        });
      },
    };
  }

  function buildTender() {
    const g = new THREE.Group();
    const wheels = [];
    const body = mat(0x24384a, { roughness: 0.45, metalness: 0.15 });
    box(0.062, 0.006, 0.036, black, 0, 0.012, 0, g);
    box(0.058, 0.026, 0.038, body, 0, 0.03, 0, g);
    box(0.06, 0.003, 0.04, brass, 0, 0.0435, 0, g); // brass top edge
    // Coal heaped up inside.
    // A lumpy mound: the lower half of a ball flattened away, the rest jittered.
    const coalGeo = jitter(new THREE.IcosahedronGeometry(1, 2), 0.25);
    const p = coalGeo.attributes.position;
    for (let i = 0; i < p.count; i++) p.setY(i, Math.max(0, p.getY(i)));
    coalGeo.computeVertexNormals();
    const coal = shadow(new THREE.Mesh(coalGeo, mat(0x161514, { roughness: 0.5, flatShading: true })));
    coal.scale.set(0.026, 0.01, 0.016);
    coal.position.set(0.004, 0.042, 0);
    g.add(coal);
    for (const k of [-1, 1]) for (const x of [-0.018, 0.018]) wheels.push(wheel(g, x, k * 0.0195, 0.0085, false));
    return { g, length: 0.064, roll: (d) => wheels.forEach((w) => (w.holder.rotation.z = -d / w.r)) };
  }

  function buildCoach(colour) {
    const g = new THREE.Group();
    const wheels = [];
    const body = card(colour);
    const L = 0.088;
    box(L - 0.004, 0.005, 0.03, black, 0, 0.013, 0, g); // underframe
    box(L, 0.032, 0.036, body, 0, 0.032, 0, g);
    // A cream band through the windows, framed panes in it, lining below.
    for (const k of [-1, 1]) {
      box(L - 0.006, 0.013, 0.0012, cream, 0, 0.038, k * 0.0185, g);
      for (let i = 0; i < 5; i++) box(0.011, 0.009, 0.0014, pane, -0.033 + i * 0.0165, 0.038, k * 0.0187, g);
      box(L - 0.006, 0.0012, 0.0012, brass, 0, 0.026, k * 0.0186, g);
      for (const dx of [-L / 2 + 0.006, L / 2 - 0.006]) box(0.0012, 0.026, 0.0012, black, dx, 0.031, k * 0.0187, g); // door lines
    }
    // Curved roof with a slight overhang.
    const roof = curvedRoof(0.03, L + 0.004, 1.4, mat(0x4a4642, { roughness: 0.7 }), g);
    roof.position.set(0, 0.0255, 0);
    // Bogies, four small wheels each.
    for (const bx of [-0.028, 0.028]) {
      box(0.022, 0.005, 0.03, black, bx, 0.009, 0, g);
      for (const k of [-1, 1]) for (const x of [bx - 0.007, bx + 0.007]) wheels.push(wheel(g, x, k * 0.0175, 0.0055, false));
    }
    // Buffers and a coupling at each end.
    for (const end of [-1, 1]) {
      for (const k of [-1, 1]) {
        const b = cyl(0.0022, 0.0022, 0.005, black, g, 10);
        b.rotation.z = Math.PI / 2;
        b.position.set(end * (L / 2 + 0.002), 0.017, k * 0.012);
      }
      box(0.006, 0.002, 0.003, black, end * (L / 2 + 0.003), 0.015, 0, g);
    }
    return { g, length: L, roll: (d) => wheels.forEach((w) => (w.holder.rotation.z = -d / w.r)) };
  }

  // The whole train, front to back, each car with its distance behind the
  // engine's middle along the track.
  function buildTrain() {
    const cars = [buildEngine(), buildTender(), ...[0xa8462f, 0x3d6b4a, 0xc9a23a].map(buildCoach)];
    let back = 0;
    cars.forEach((car, i) => {
      car.offset = i === 0 ? 0 : back + 0.004 + car.length / 2;
      back = car.offset + car.length / 2;
    });
    return cars;
  }

  // ============================================================ buildings
  const shingleTex = (hex) =>
    canvasTex(128, 128, (g, w, h) => {
      g.fillStyle = hex;
      g.fillRect(0, 0, w, h);
      // Overlapping rows of tiles, each row's lower edge shadowed.
      for (let y = 0, row = 0; y < h; y += 16, row++) {
        for (let x = (row % 2) * -8; x < w; x += 16) {
          g.fillStyle = `rgba(0,0,0,${0.05 + rand() * 0.12})`;
          g.fillRect(x + 1, y, 14, 15);
        }
        g.fillStyle = 'rgba(0,0,0,0.3)';
        g.fillRect(0, y + 14, w, 2);
      }
    });
  const roofMats = new Map();
  const roofMat = (hex) => {
    if (!roofMats.has(hex)) {
      const t = shingleTex(`#${hex.toString(16).padStart(6, '0')}`);
      t.repeat.set(6, 6);
      roofMats.set(hex, mat(0xffffff, { map: t, roughness: 0.85 }));
    }
    return roofMats.get(hex);
  };
  const awningTex = (a, b) =>
    canvasTex(128, 32, (g, w, h) => {
      for (let x = 0; x < w; x += 16) {
        g.fillStyle = (x / 16) % 2 ? a : b;
        g.fillRect(x, 0, 16, h);
      }
      g.fillStyle = 'rgba(0,0,0,0.2)';
      for (let x = 0; x < w; x += 8) g.fillRect(x, h - 5, 8, 5);
    });
  const signMat = (text, bg = '#2f3d4c', fg = '#f3e6cf') =>
    new THREE.MeshStandardMaterial({
      roughness: 0.8,
      map: canvasTex(256, 64, (g, w, h) => {
        g.fillStyle = bg;
        g.fillRect(0, 0, w, h);
        g.strokeStyle = fg;
        g.lineWidth = 3;
        g.strokeRect(5, 5, w - 10, h - 10);
        g.fillStyle = fg;
        g.font = "bold 36px Georgia, 'Times New Roman', serif";
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.fillText(text, w / 2, h / 2 + 2);
      }),
    });

  // A window on a wall: cream frame, dark pane, glazing bars, a sill.
  function windowOn(parent, x, y, z, w, h, face = 1) {
    const f = face;
    box(w + 0.003, h + 0.003, 0.0015, cream, x, y, z + f * 0.0008, parent);
    box(w, h, 0.0015, pane, x, y, z + f * 0.0016, parent);
    box(0.0008, h, 0.0012, cream, x, y, z + f * 0.0024, parent);
    box(w, 0.0008, 0.0012, cream, x, y + h * 0.1, z + f * 0.0024, parent);
    box(w + 0.005, 0.0018, 0.004, cream, x, y - h / 2 - 0.0012, z + f * 0.002, parent);
  }

  /**
   * spec: { x, z, w, d, h, wall, roof, pitched, rot, shop: 'BAKERY' | null,
   *   awning: ['#c33', '#eee'] | null }. Long side along x, front facing +z.
   */
  function building(spec, parent) {
    const { w, d, h, wall, pitched = true } = spec;
    const g = new THREE.Group();
    g.position.set(spec.x, spec.y, spec.z);
    g.rotation.y = spec.rot ?? 0;
    const wallMat = card(wall);
    const trim = card(new THREE.Color(wall).multiplyScalar(0.72).getHex());
    box(w, h, d, wallMat, 0, h / 2, 0, g);
    box(w + 0.003, 0.008, d + 0.003, trim, 0, 0.004, 0, g); // base course
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) box(0.004, h, 0.004, trim, (sx * w) / 2, h / 2, (sz * d) / 2, g); // corner trims
    box(w + 0.004, 0.003, d + 0.004, trim, 0, h - 0.0015, 0, g); // eaves band
    if (pitched) {
      const rise = d * 0.42;
      const over = 0.006; // the eaves overhang the walls
      const angle = Math.atan2(rise, d / 2);
      const run = d / 2 + over;
      const rm = roofMat(spec.roof);
      // Two slabs from the ridge down past the walls, each centred halfway
      // down its slope.
      for (const k of [-1, 1]) {
        const slab = box(w + 0.014, 0.003, run / Math.cos(angle), rm, 0, 0, 0, g);
        slab.rotation.x = k * angle;
        slab.position.set(0, h + rise - (run / 2) * Math.tan(angle) + 0.0015, (k * run) / 2);
      }
      box(w + 0.016, 0.004, 0.006, trim, 0, h + rise + 0.001, 0, g); // ridge
      // Gable ends.
      const tri = new THREE.Shape([new THREE.Vector2(-d / 2, 0), new THREE.Vector2(d / 2, 0), new THREE.Vector2(0, rise)]);
      for (const k of [-1, 1]) {
        const gable = shadow(new THREE.Mesh(new THREE.ShapeGeometry(tri), wallMat));
        gable.rotation.y = (k * Math.PI) / 2;
        gable.position.set((k * w) / 2, h, 0);
        g.add(gable);
      }
      // A chimney stack with pots.
      const cxp = (rand() - 0.5) * w * 0.6;
      box(0.012, rise + 0.02, 0.01, trim, cxp, h + rise / 2 + 0.01, -d * 0.12, g);
      for (const k of [-1, 1]) {
        const pot = cyl(0.0018, 0.0022, 0.006, red, g, 8);
        pot.position.set(cxp + k * 0.003, h + rise + 0.023, -d * 0.12);
      }
    } else {
      // Flat roof: parapet, a water tank on legs, a vent.
      box(w, 0.002, d, card(0x6a6660), 0, h + 0.001, 0, g);
      for (const [px, pz, pw, pd] of [[0, d / 2, w + 0.003, 0.004], [0, -d / 2, w + 0.003, 0.004], [w / 2, 0, 0.004, d], [-w / 2, 0, 0.004, d]]) box(pw, 0.008, pd, trim, px, h + 0.004, pz, g);
      const tank = cyl(0.01, 0.01, 0.014, card(0x8a7258), g, 14);
      tank.position.set(w * 0.2, h + 0.017, -d * 0.1);
      const tankRoof = cyl(0, 0.011, 0.006, card(0x5a4a3a), g, 14);
      tankRoof.position.set(w * 0.2, h + 0.027, -d * 0.1);
      for (const k of [-1, 1]) box(0.0015, 0.01, 0.0015, black, w * 0.2 + k * 0.007, h + 0.005, -d * 0.1, g);
      box(0.008, 0.008, 0.008, card(0x9a9690), -w * 0.25, h + 0.006, d * 0.15, g);
    }
    // Windows on front and back, in floors; the door in the middle of the front.
    const floors = Math.max(1, Math.floor(h / 0.036));
    const cols = Math.max(2, Math.floor(w / 0.026));
    const doorCol = Math.floor(cols / 2);
    for (let f = 0; f < floors; f++) {
      for (let c = 0; c < cols; c++) {
        const wx = -w / 2 + (w / cols) * (c + 0.5);
        const wy = (h / floors) * (f + 0.55);
        if (f === 0 && (c === doorCol || spec.shop)) continue;
        windowOn(g, wx, wy, d / 2, 0.01, 0.014, 1);
        windowOn(g, wx, wy, -d / 2, 0.01, 0.014, -1);
      }
    }
    // Door, frame and a step.
    const dx = -w / 2 + (w / cols) * (doorCol + 0.5);
    box(0.016, 0.026, 0.0015, cream, dx, 0.013, d / 2 + 0.0008, g);
    box(0.012, 0.023, 0.002, card(spec.door ?? 0x5a3b26), dx, 0.0125, d / 2 + 0.0015, g);
    box(0.02, 0.003, 0.008, card(0x9a948a), dx, 0.0015, d / 2 + 0.004, g);
    // A shop: wide window either side of the door, a sign, a striped awning.
    if (spec.shop) {
      for (const k of [-1, 1]) windowOn(g, dx + k * (w / 4 + 0.006), 0.016, d / 2, w / 2 - 0.028, 0.018, 1);
      const sign = shadow(new THREE.Mesh(new THREE.PlaneGeometry(w * 0.7, w * 0.7 * 0.25), signMat(spec.shop)));
      sign.position.set(0, (h / floors) * 1.0 - 0.004, d / 2 + 0.003);
      g.add(sign);
      if (spec.awning) {
        const t = awningTex(spec.awning[0], spec.awning[1]);
        t.repeat.set(w / 0.04, 1);
        const aw = shadow(new THREE.Mesh(new THREE.PlaneGeometry(w * 0.9, 0.016), mat(0xffffff, { map: t, side: THREE.DoubleSide, roughness: 0.9 })));
        aw.rotation.x = -1.0;
        aw.position.set(0, 0.03, d / 2 + 0.007);
        g.add(aw);
      }
    }
    wonky(g, 0.5);
    parent.add(g);
    return g;
  }

  // The station: a platform with a striped edge, a canopy on posts with a
  // fringe, a bench and the station's name board.
  function station(parent, x, z, len, depth) {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    box(len, 0.012, depth, card(0xb8ab98), 0, 0.006, 0, g);
    box(len, 0.0015, 0.004, card(0xe8d26a), 0, 0.0125, -depth / 2 + 0.003, g); // safety line
    const posts = 5;
    for (let i = 0; i < posts; i++) {
      const p = cyl(0.0018, 0.0018, 0.042, mat(0x2f4a3a), g, 8);
      p.position.set(-len * 0.4 + (i / (posts - 1)) * len * 0.8, 0.033, depth * 0.15);
    }
    box(len * 0.88, 0.003, depth * 0.95, card(0x7a3a2e), 0, 0.055, 0, g);
    // Fringe: a row of little teeth along the canopy's front edge.
    for (let i = 0; i < 40; i++) {
      const tooth = box(len * 0.88 / 40 - 0.0008, 0.005, 0.001, cream, -len * 0.44 + (i + 0.5) * (len * 0.88 / 40), 0.0515, -depth * 0.475, g);
      tooth.castShadow = false;
    }
    box(0.03, 0.002, 0.007, card(0x6a4a2a), -len * 0.15, 0.019, depth * 0.25, g); // bench seat
    box(0.03, 0.006, 0.0015, card(0x6a4a2a), -len * 0.15, 0.024, depth * 0.28, g); // bench back
    for (const k of [-1, 1]) box(0.0015, 0.007, 0.006, black, -len * 0.15 + k * 0.013, 0.0155, depth * 0.25, g);
    const board = shadow(new THREE.Mesh(new THREE.PlaneGeometry(0.06, 0.012), signMat('MODEL TOWN', '#1f3a5a')));
    board.position.set(len * 0.2, 0.04, depth * 0.3);
    g.add(board);
    for (const k of [-1, 1]) {
      const leg = cyl(0.001, 0.001, 0.034, black, g, 6);
      leg.position.set(len * 0.2 + k * 0.026, 0.023, depth * 0.3 - 0.001);
    }
    parent.add(g);
    return g;
  }

  // A street lamp: post, arm, lantern.
  function lampPost(parent, x, y, z) {
    const g = new THREE.Group();
    g.position.set(x, y, z);
    const post = cyl(0.0012, 0.0016, 0.05, black, g, 8);
    post.position.y = 0.025;
    const lantern = cyl(0.0035, 0.0025, 0.007, mat(0xfff0c8, { emissive: 0xffe2a0, emissiveIntensity: 0.4 }), g, 6);
    lantern.position.y = 0.053;
    const cap = cyl(0, 0.0045, 0.003, black, g, 6);
    cap.position.y = 0.058;
    wonky(g, 2);
    parent.add(g);
  }

  // A little parked car.
  function car(parent, x, z, rot, colour) {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    g.rotation.y = rot;
    box(0.03, 0.007, 0.014, card(colour), 0, 0.0065, 0, g);
    box(0.016, 0.006, 0.012, card(colour), -0.002, 0.0125, 0, g);
    for (const k of [-1, 1]) box(0.012, 0.004, 0.0004, pane, -0.002, 0.0128, k * 0.0061, g);
    for (const k of [-1, 1]) for (const wx of [-0.01, 0.01]) {
      const wh = cyl(0.0032, 0.0032, 0.002, black, g, 10);
      wh.rotation.x = Math.PI / 2;
      wh.position.set(wx, 0.0032, k * 0.0068);
    }
    parent.add(g);
  }

  // ============================================================ greenery
  const greens = [0x3a6436, 0x2f5a30, 0x46743c, 0x557f42, 0x63883f];
  const greenMats = greens.map((c) => mat(c, { flatShading: true, roughness: 0.95 }));
  const leafMats = [0x5d8a46, 0x6f9a4a, 0x7da450, 0x4f7f40].map((c) => mat(c, { flatShading: true, roughness: 0.95 }));
  const trunkMat = mat(0x5b3d24);
  // Jitter a geometry's vertices a little, for a shaggier, handmade shape.
  // Welded first, so faces that share a corner move together and the shape
  // stays closed; then split again, for the faceted (flat-shaded) look.
  const jitter = (raw, k) => {
    const geo = mergeVertices(raw.index ? raw.toNonIndexed() : raw);
    const p = geo.attributes.position;
    for (let i = 0; i < p.count; i++) p.setXYZ(i, p.getX(i) + (rand() - 0.5) * k, p.getY(i) + (rand() - 0.5) * k * 0.6, p.getZ(i) + (rand() - 0.5) * k);
    const out = geo.toNonIndexed();
    out.computeVertexNormals();
    return out;
  };
  // A pine: four or five shaggy tiers, merged into one mesh.
  function pine(s) {
    const parts = [];
    const tiers = 4 + Math.floor(rand() * 2);
    for (let k = 0; k < tiers; k++) {
      const r = 0.026 * s * (1 - k * 0.18);
      const cone = jitter(new THREE.ConeGeometry(r, 0.034 * s, 7, 1), r * 0.25);
      cone.rotateY(rand() * Math.PI);
      cone.translate(0, 0.024 * s + k * 0.019 * s, 0);
      parts.push(cone);
    }
    const g = new THREE.Group();
    g.add(shadow(new THREE.Mesh(mergeGeometries(parts), greenMats[Math.floor(rand() * greenMats.length)])));
    const trunk = cyl(0.0028 * s, 0.0036 * s, 0.018 * s, trunkMat, g, 6);
    trunk.position.y = 0.009 * s;
    return g;
  }
  // A broadleaf: a clump of leafy blobs on a forked trunk.
  function broadleaf(s) {
    const parts = [];
    const blobs = 4 + Math.floor(rand() * 3);
    for (let k = 0; k < blobs; k++) {
      const b = jitter(new THREE.IcosahedronGeometry(0.014 * s * (0.75 + rand() * 0.5), 1), 0.004 * s);
      const a = rand() * Math.PI * 2;
      const rr = k === 0 ? 0 : 0.012 * s;
      b.translate(Math.cos(a) * rr, 0.044 * s + (k === 0 ? 0.008 * s : (rand() - 0.3) * 0.012 * s), Math.sin(a) * rr);
      parts.push(b);
    }
    const g = new THREE.Group();
    g.add(shadow(new THREE.Mesh(mergeGeometries(parts), leafMats[Math.floor(rand() * leafMats.length)])));
    const trunk = cyl(0.0022 * s, 0.0034 * s, 0.034 * s, trunkMat, g, 6);
    trunk.position.y = 0.017 * s;
    for (const k of [-1, 1]) {
      const br = cyl(0.0012 * s, 0.0018 * s, 0.014 * s, trunkMat, g, 5);
      br.position.set(k * 0.004 * s, 0.032 * s, 0);
      br.rotation.z = -k * 0.6;
    }
    return g;
  }
  // A low bush: three or four small blobs.
  function bush(s) {
    const parts = [];
    for (let k = 0; k < 3 + Math.floor(rand() * 2); k++) {
      const b = jitter(new THREE.IcosahedronGeometry(0.008 * s * (0.8 + rand() * 0.5), 1), 0.002 * s);
      b.translate((rand() - 0.5) * 0.014 * s, 0.006 * s, (rand() - 0.5) * 0.01 * s);
      parts.push(b);
    }
    const g = new THREE.Group();
    g.add(shadow(new THREE.Mesh(mergeGeometries(parts), leafMats[Math.floor(rand() * leafMats.length)])));
    return g;
  }
  // Grass tufts and flowers, instanced: thousands of them in one draw each.
  function scatter(parent, points, kind) {
    const geo = kind === 'grass' ? new THREE.ConeGeometry(0.0022, 0.009, 4) : new THREE.IcosahedronGeometry(0.0016, 0);
    if (kind === 'grass') geo.translate(0, 0.0045, 0);
    const colours = kind === 'grass' ? [0x6f8f44, 0x7d9a4a, 0x5f7f3c, 0x8fa555] : [0xe8d24a, 0xd8443a, 0xf4f0e6, 0xb070d0, 0xe88ab0];
    const mesh = new THREE.InstancedMesh(geo, mat(0xffffff, { roughness: 0.9 }), points.length);
    const o = new THREE.Object3D();
    const c = new THREE.Color();
    points.forEach(([x, y, z], i) => {
      o.position.set(x, y + (kind === 'grass' ? 0 : 0.006 + rand() * 0.003), z);
      o.rotation.set((rand() - 0.5) * 0.4, rand() * Math.PI, (rand() - 0.5) * 0.4);
      o.scale.setScalar(0.7 + rand() * 0.7);
      o.updateMatrix();
      mesh.setMatrixAt(i, o.matrix);
      mesh.setColorAt(i, c.set(colours[Math.floor(rand() * colours.length)]));
    });
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  }

  // =============================================================== hill
  // A heightfield over an elliptical footprint: a rounded mass with ridges
  // and gullies (layered noise), papier-mâché faceted, grass on the gentle
  // slopes and bare rock where it's steep, rock outcrops and trees on it.
  // heightAt() is exported for the tunnel, the trees and the smoke.
  function hash(x, y) {
    const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
    return s - Math.floor(s);
  }
  function noise(x, y) {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const fx = x - xi;
    const fy = y - yi;
    const u = fx * fx * (3 - 2 * fx);
    const v = fy * fy * (3 - 2 * fy);
    const a = hash(xi, yi);
    const b = hash(xi + 1, yi);
    const c = hash(xi, yi + 1);
    const d = hash(xi + 1, yi + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }
  const fbm = (x, y) => noise(x, y) * 0.55 + noise(x * 2.1, y * 2.1) * 0.28 + noise(x * 4.3, y * 4.3) * 0.17;

  function buildHill(parent, Mt, ground) {
    const heightAt = (x, z) => {
      const dx = (x - Mt.x) / Mt.rx;
      const dz = (z - Mt.z) / Mt.rz;
      const r = Math.hypot(dx, dz);
      if (r >= 1.12) return 0;
      // A full body that falls away near the rim (so the tunnel under the
      // corner is well covered), then a short skirt into the board.
      const body = r < 1 ? Math.pow(1 - r * r, 0.75) : 0;
      const n = fbm(x * 9 + 3, z * 9 + 7);
      const ridge = 1 - Math.abs(noise(x * 6 + 11, z * 6) * 2 - 1); // sharp crests
      return Math.max(0, Mt.h * body * (0.62 + 0.38 * n + 0.18 * ridge * body));
    };
    const W = Mt.rx * 2.3;
    const D = Mt.rz * 2.3;
    const geo = new THREE.PlaneGeometry(W, D, 90, 80).toNonIndexed();
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i) + Mt.x;
      const z = pos.getZ(i) + Mt.z;
      const h = heightAt(x, z);
      pos.setY(i, h > 0 ? h : -0.004); // outside the hill: tucked just under the board
    }
    geo.computeVertexNormals();
    // Colour by slope and height: grass, scrubby, rock, a few paler crags.
    const colours = [];
    const nrm = geo.attributes.normal;
    const grass = new THREE.Color(0x6a8a48);
    const scrub = new THREE.Color(0x7d7a50);
    const rock = new THREE.Color(0x8e8270);
    const crag = new THREE.Color(0xb0a690);
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i += 3) {
      const up = (nrm.getY(i) + nrm.getY(i + 1) + nrm.getY(i + 2)) / 3;
      const y = (pos.getY(i) + pos.getY(i + 1) + pos.getY(i + 2)) / 3 / Mt.h;
      const steep = 1 - THREE.MathUtils.smoothstep(up, 0.5, 0.85);
      c.copy(grass).lerp(scrub, THREE.MathUtils.clamp(y * 1.2, 0, 1) * 0.6);
      c.lerp(steep > 0.6 && y > 0.5 ? crag : rock, steep);
      c.multiplyScalar(0.9 + rand() * 0.16);
      for (let j = 0; j < 3; j++) colours.push(c.r, c.g, c.b);
    }
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colours, 3));
    const hill = shadow(new THREE.Mesh(geo, mat(0xffffff, { vertexColors: true, flatShading: true, roughness: 0.95 })));
    hill.position.set(Mt.x, ground, Mt.z);
    parent.add(hill);
    // Rock outcrops on the steeper ground, trees on the gentler.
    const rockMat = mat(0x9a9080, { flatShading: true, roughness: 0.9 });
    for (let k = 0, tries = 0; k < 14 && tries < 400; tries++) {
      const a = rand() * Math.PI * 2;
      const rr = 0.25 + rand() * 0.6;
      const x = Mt.x + Math.cos(a) * rr * Mt.rx;
      const z = Mt.z + Math.sin(a) * rr * Mt.rz;
      const h = heightAt(x, z);
      const slope = Math.abs(heightAt(x + 0.01, z) - h) + Math.abs(heightAt(x, z + 0.01) - h);
      if (slope < 0.006) continue;
      const rg = jitter(new THREE.DodecahedronGeometry(0.008 + rand() * 0.01, 0), 0.004);
      const m = shadow(new THREE.Mesh(rg, rockMat));
      m.position.set(x, ground + h - 0.002, z);
      m.rotation.set(rand() * 3, rand() * 3, rand() * 3);
      m.scale.y = 0.6;
      parent.add(m);
      k++;
    }
    const tops = [];
    for (let k = 0, tries = 0; k < 16 && tries < 600; tries++) {
      const a = rand() * Math.PI * 2;
      const rr = 0.15 + rand() * 0.75;
      const x = Mt.x + Math.cos(a) * rr * Mt.rx;
      const z = Mt.z + Math.sin(a) * rr * Mt.rz;
      const h = heightAt(x, z);
      const slope = Math.abs(heightAt(x + 0.01, z) - h) + Math.abs(heightAt(x, z + 0.01) - h);
      if (slope > 0.008 || h < 0.07) continue; // gentle ground, and well above the tunnel
      const t = pine(0.55 + rand() * 0.4);
      t.position.set(x, ground + h - 0.003, z);
      t.rotation.y = rand() * Math.PI * 2;
      parent.add(t);
      tops.push(t);
      k++;
    }
    return { heightAt };
  }

  // A tunnel mouth: a stone face with an arch of blocks round a dark
  // opening, a darker tunnel just inside. Local +x points out of the hill.
  function tunnelMouth(parent, archR) {
    const g = new THREE.Group();
    const face = new THREE.Shape();
    face.moveTo(-archR * 1.7, 0);
    face.lineTo(archR * 1.7, 0);
    face.lineTo(archR * 1.55, archR * 2.2);
    face.lineTo(-archR * 1.55, archR * 2.2);
    face.closePath();
    const hole = new THREE.Path();
    hole.moveTo(archR, 0);
    hole.absarc(0, 0, archR, 0, Math.PI, false);
    hole.lineTo(archR, 0);
    face.holes.push(hole);
    const faceGeo = new THREE.ExtrudeGeometry(face, { depth: 0.01, bevelEnabled: false, curveSegments: 20 });
    const uv = faceGeo.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 12, uv.getY(i) * 12);
    const wall = shadow(new THREE.Mesh(faceGeo, stone));
    wall.rotation.y = -Math.PI / 2; // the extrusion (+z) now runs along -x, into the hill
    wall.position.x = 0.002;
    g.add(wall);
    // Arch blocks (voussoirs), with a keystone.
    const blocks = 9;
    for (let i = 0; i < blocks; i++) {
      const a = (i + 0.5) / blocks * Math.PI;
      const key = i === Math.floor(blocks / 2);
      const b = box(0.008, key ? 0.012 : 0.009, 0.009, key ? mat(0xb8ae9a) : mat(0xa49a88, { roughness: 0.9 }), 0.0035, 0, 0, g);
      b.position.set(0.0035, Math.sin(a) * (archR + 0.004), Math.cos(a) * (archR + 0.004));
      b.rotation.x = -(a - Math.PI / 2);
    }
    // The dark inside: a half-disc set back, and the tunnel's walls.
    const dark = new THREE.MeshBasicMaterial({ color: 0x0a0806, side: THREE.DoubleSide });
    const back = new THREE.Mesh(new THREE.CircleGeometry(archR, 20, 0, Math.PI), dark);
    back.rotation.y = Math.PI / 2;
    back.position.x = -0.03;
    g.add(back);
    const tube = new THREE.Mesh(new THREE.CylinderGeometry(archR, archR, 0.032, 20, 1, true, 0, Math.PI), dark);
    tube.rotation.z = Math.PI / 2; // axis along x, its half-round on top
    tube.position.x = -0.014;
    g.add(tube);
    parent.add(g);
    return g;
  }

  return { buildTrain, building, station, lampPost, car, pine, broadleaf, bush, scatter, buildHill, tunnelMouth };
}
