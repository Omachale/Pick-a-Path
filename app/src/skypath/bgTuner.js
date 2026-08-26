/**
 * THROWAWAY — a live tuning panel for the world-floor backdrop.
 *
 * Where the sky meets the water is a judgement call you can only make by
 * looking at it: the art is at a fixed aspect ratio, the camera pitches as the
 * walker moves, and "does that read as a horizon" is not something arithmetic
 * settles. So: sliders, and bake the numbers back into skyPath.js once they
 * look right.
 *
 * "H" means depth-into-the-scene for the flat land/sea deck and height for the
 * upright sky. Both sit in the camera-following backdrop rig, so Z reads as
 * distance in front of the camera rather than as a world position — and since
 * the sky draws after the deck, pulling its Z closer eats into the back of the
 * sea rather than disappearing behind it.
 */

// Ranges are derived from each panel's own starting size, because a curved sky
// and a ground deck differ by an order of magnitude and one fixed range cannot
// serve both.
//
// The curved sky reads differently from the flat panels: "Z" is its radius —
// its distance from the camera in every direction at once — and it gains an
// ARC row, since how far round it wraps is the whole point of curving it.
const rowsFor = (state, isShell) => {
  const { h, z } = state;
  const rows = [
    ['y', 'Y (height)', -Math.max(200, Math.abs(z) * 1.5), Math.max(200, Math.abs(z)), 0.5],
    ['h', 'H (size)', 1, h * 4, Math.max(1, Math.round(h / 200))],
  ];
  if (isShell) {
    rows.push(['z', 'R (radius)', 20, Math.max(1200, Math.abs(z) * 3), 1]);
    rows.push(['arc', 'ARC (degrees)', 20, 340, 1]);
  } else {
    // Positive z is behind the camera, which the ground deck legitimately
    // wants — it runs from underfoot outwards, not from the horizon inwards.
    rows.push(['z', 'Z (depth)', -Math.max(900, Math.abs(z) * 3), 200, 1]);
  }
  return rows;
};

const isShellMesh = (mesh) => !!mesh.userData?.shell;

export function attachBgTuner({ container, panels, toggles = {}, setClearColor = null }) {
  // Flat panels are PlaneGeometry at a fixed size, so "height" is applied as a
  // scale against whatever they were built at rather than by rebuilding the
  // geometry on every slider tick. The ground deck is a plane too — rotated
  // flat rather than upright — so the same maths drives it, and its "H" reads
  // as depth-into-the-scene instead of height. The sky shell is unit-sized
  // geometry scaled to radius and height, so it needs no base at all.
  const layers = {};
  for (const [name, mesh] of Object.entries(panels)) {
    if (mesh) layers[name] = { mesh, shell: isShellMesh(mesh), base: geomSize(mesh), state: read(mesh) };
  }

  function geomSize(mesh) {
    const p = mesh.geometry.parameters;
    return { w: p.width, h: p.height };
  }
  function read(mesh) {
    if (isShellMesh(mesh)) {
      // Unit cylinder: the scale *is* the size.
      return {
        y: mesh.position.y,
        h: mesh.scale.y,
        z: mesh.scale.x,
        arc: mesh.userData.shell.arcDeg,
      };
    }
    const p = mesh.geometry.parameters;
    return { y: mesh.position.y, h: p.height * mesh.scale.y, z: mesh.position.z };
  }
  function apply(layer) {
    const { mesh, base, state, shell } = layer;
    mesh.position.y = state.y;
    if (shell) {
      // Radius on x/z, height on y — they are independent dials here, and the
      // shell stays centred on the camera rather than moving in z.
      mesh.scale.set(state.z, state.h, state.z);
      if (state.arc !== mesh.userData.shell.arcDeg) mesh.userData.shell.setArc(state.arc);
      return;
    }
    mesh.position.z = state.z;
    // Uniform scale: the art's aspect ratio is part of the painting, and
    // stretching only the height is what makes a sea look like a smear.
    const k = state.h / base.h;
    mesh.scale.set(k, k, 1);
  }

  // ------------------------------------------------------------------ panel
  const panel = document.createElement('div');
  panel.id = 'bgTuner';
  panel.style.cssText = [
    'position:absolute',
    'right:8px',
    'top:calc(env(safe-area-inset-top, 0px) + 8px)',
    'z-index:31',
    'width:210px',
    'max-height:calc(100% - 24px)',
    'overflow-y:auto',
    'padding:8px 10px',
    'border-radius:10px',
    'background:rgba(10,20,30,0.6)',
    'backdrop-filter:blur(6px)',
    'color:#eaf2f8',
    'font:600 11px/1.4 system-ui, sans-serif',
  ].join(';');

  const body = document.createElement('div');

  const head = document.createElement('button');
  head.textContent = 'backdrop ▾';
  head.style.cssText =
    'display:block;width:100%;border:0;border-radius:6px;padding:5px;margin-bottom:6px;font:700 11px/1 system-ui,sans-serif;color:#12212f;background:#f4f7fa;';
  head.addEventListener('click', () => {
    const open = body.style.display !== 'none';
    body.style.display = open ? 'none' : '';
    head.textContent = open ? 'backdrop ▸' : 'backdrop ▾';
  });
  panel.appendChild(head);
  panel.appendChild(body);

  for (const [name, layer] of Object.entries(layers)) {
    const title = document.createElement('div');
    title.textContent = name.toUpperCase();
    title.style.cssText = 'margin:4px 0 2px;opacity:0.7;letter-spacing:0.08em;';
    body.appendChild(title);

    for (const [key, label, min, max, step] of rowsFor(layer.state, layer.shell)) {
      const row = document.createElement('label');
      row.style.cssText = 'display:block;margin-bottom:2px;';

      const cap = document.createElement('span');
      cap.style.cssText = 'display:flex;justify-content:space-between;';
      const val = document.createElement('span');
      const setCap = () => {
        val.textContent = layer.state[key].toFixed(1);
      };
      cap.append(Object.assign(document.createElement('span'), { textContent: label }), val);

      const input = document.createElement('input');
      input.type = 'range';
      input.min = min;
      input.max = max;
      input.step = step;
      input.value = layer.state[key];
      input.style.cssText = 'width:100%;margin:0;';
      input.addEventListener('input', () => {
        layer.state[key] = Number(input.value);
        setCap();
        apply(layer);
      });

      setCap();
      row.append(cap, input);
      body.appendChild(row);
    }
  }

  // Visibility switches for every other layer that can paint into the horizon
  // band. Identifying an unwanted layer is a process of elimination, and a
  // checkbox does that in one click where reading z values does not.
  const toggleNames = Object.keys(toggles);
  if (toggleNames.length) {
    const title = document.createElement('div');
    title.textContent = 'LAYERS';
    title.style.cssText = 'margin:8px 0 2px;opacity:0.7;letter-spacing:0.08em;';
    body.appendChild(title);

    for (const name of toggleNames) {
      const mesh = toggles[name];
      if (!mesh) continue;
      const row = document.createElement('label');
      row.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:1px;cursor:pointer;';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = mesh.visible;
      box.style.cssText = 'margin:0;';
      box.addEventListener('change', () => {
        mesh.visible = box.checked;
      });
      row.append(box, Object.assign(document.createElement('span'), { textContent: name }));
      body.appendChild(row);
    }
  }

  // The clear colour is not a layer — it is the void showing through wherever
  // no painted panel covers the frame. It can't be toggled off, so the control
  // is a swatch: set it to magenta to see exactly where the gap is.
  if (setClearColor) {
    const title = document.createElement('div');
    title.textContent = 'VOID (clear colour)';
    title.style.cssText = 'margin:8px 0 2px;opacity:0.7;letter-spacing:0.08em;';
    body.appendChild(title);

    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:4px;align-items:center;';

    const swatch = document.createElement('input');
    swatch.type = 'color';
    swatch.value = '#6b4a5a';
    swatch.style.cssText = 'flex:1;height:22px;padding:0;border:0;background:none;cursor:pointer;';
    swatch.addEventListener('input', () => setClearColor(swatch.value));

    const mk = (label, fn) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.style.cssText =
        'border:0;border-radius:5px;padding:4px 6px;font:600 10px/1 system-ui,sans-serif;color:#12212f;background:#cfe3f5;cursor:pointer;';
      b.addEventListener('click', fn);
      return b;
    };
    row.append(
      swatch,
      mk('flag', () => {
        swatch.value = '#ff00ff';
        setClearColor('#ff00ff');
      }),
      mk('auto', () => setClearColor(null))
    );
    body.appendChild(row);
  }

  const dump = document.createElement('button');
  dump.textContent = 'log values';
  dump.style.cssText =
    'width:100%;margin-top:6px;border:0;border-radius:6px;padding:6px;font:600 11px/1 system-ui,sans-serif;color:#12212f;background:#cfe3f5;';
  dump.addEventListener('click', () => {
    const text = Object.entries(layers)
      .map(([n, l]) =>
        l.shell
          ? `${n}: radius: ${l.state.z}, height: ${l.state.h}, y: ${l.state.y}, arcDeg: ${l.state.arc}`
          : `${n}: y: ${l.state.y}, h: ${l.state.h}, z: ${l.state.z}`
      )
      .join('\n');
    console.log('[bgTuner]\n' + text);
    navigator.clipboard?.writeText(text).catch(() => {});
    dump.textContent = 'copied ✓';
    setTimeout(() => (dump.textContent = 'log values'), 1200);
  });
  body.appendChild(dump);

  container.appendChild(panel);

  for (const layer of Object.values(layers)) apply(layer);

  return {
    dispose() {
      panel.remove();
    },
  };
}
