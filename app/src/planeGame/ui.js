/**
 * Everything on screen that isn't the 3D world: plane picker, angle gauge,
 * aiming arrow, wind badge, results card and the looks panel.
 *
 * Plain DOM, built once. Layering rule (learned the hard way in earlier
 * attempts, where an invisible panel kept swallowing taps): there is NO
 * full-screen overlay with pointer-events tricks. Each control is its own
 * small absolutely-positioned box that takes its own taps; everything else
 * on screen is the canvas, which gets the rest. A hidden control is
 * display:none, never just transparent.
 */

import { PLANES, PLANE_ORDER, AIM } from './flight.js';
import { RINGS } from './course.js';
import { PLANE_COLORS } from './planes.js';

const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
};

/** Top-down silhouettes for the picker and chip (drawn to match planes.js). */
export const PLANE_ICONS = {
  dart: '<path d="M50 4 L64 92 L50 80 L36 92 Z"/>',
  allrounder: '<path d="M44 6 L56 6 L86 74 L90 92 L84 92 L50 84 L16 92 L10 92 L14 74 Z"/>',
  glider: '<path d="M50 6 L55 34 L96 36 L96 52 L55 54 L55 80 L68 84 L68 92 L32 92 L32 84 L45 80 L45 54 L4 52 L4 36 L45 34 Z"/>',
};
const icon = (key, color) => `<svg viewBox="0 0 100 100" class="pgIcon" style="fill:${color}">${PLANE_ICONS[key]}</svg>`;

/** Plane traits as pips (no numbers): speed, how long it floats, how much wind moves it. */
const TRAITS = {
  dart: { fast: 3, floaty: 1, wind: 1 },
  allrounder: { fast: 2, floaty: 2, wind: 2 },
  glider: { fast: 1, floaty: 3, wind: 3 },
};
const pips = (n) => [0, 1, 2].map((i) => `<i class="${i < n ? 'on' : ''}"></i>`).join('');

export function buildUI(root, handlers) {
  const ui = {};

  // --- top bar: island card, wind badge, stars, looks button
  const top = el('div', 'pgTop');
  ui.island = el('div', 'pgCard pgIsland');
  ui.wind = el('div', 'pgCard pgWind');
  ui.wind.innerHTML = `<svg viewBox="-50 -50 100 100" class="pgWindDial"><circle r="44" class="ring"/><g class="arrow"><path d="M0 -34 L14 -8 L5 -8 L5 30 L-5 30 L-5 -8 L-14 -8 Z"/></g><circle r="5" class="hub"/></svg><div class="pgWindText"><b class="word"></b><span class="bars"></span></div>`;
  ui.score = el('div', 'pgCard pgScore');
  ui.looksBtn = el('button', 'pgBtn pgLooksBtn', '<span>Looks</span>');
  top.append(ui.island, ui.wind, ui.score, ui.looksBtn);
  root.append(top);

  // --- plane chip (bottom-left) and picker
  ui.chip = el('button', 'pgChip');
  ui.picker = el('div', 'pgPicker');
  ui.picker.innerHTML = `<div class="pgPickerTitle">Choose a plane</div><div class="pgCards"></div>`;
  const cards = ui.picker.querySelector('.pgCards');
  ui.cards = {};
  for (const key of PLANE_ORDER) {
    const p = PLANES[key];
    const t = TRAITS[key];
    const c = el('button', 'pgPlaneCard');
    c.style.setProperty('--pc', PLANE_COLORS[key]);
    c.innerHTML = `${icon(key, PLANE_COLORS[key])}<div class="name">${p.name}</div>
      <div class="traits">
        <div><span class="lbl">Fast</span><span class="pips">${pips(t.fast)}</span></div>
        <div><span class="lbl">Floats</span><span class="pips">${pips(t.floaty)}</span></div>
        <div><span class="lbl">Wind moves it</span><span class="pips">${pips(t.wind)}</span></div>
      </div>
      <div class="blurb">${p.blurb}</div>`;
    c.addEventListener('click', () => handlers.onPickPlane(key));
    cards.append(c);
    ui.cards[key] = c;
  }
  ui.chip.addEventListener('click', () => handlers.onOpenPicker());
  root.append(ui.chip, ui.picker);

  // --- angle gauge (left side): a side view, horizon to steep, no numbers
  ui.gauge = el('div', 'pgGauge');
  const maxDeg = (AIM.maxAngle * 180) / Math.PI;
  ui.gauge.innerHTML = `<svg viewBox="-8 -108 116 116">
      <path class="fan" d="M0 0 L100 0 A100 100 0 0 0 ${(100 * Math.cos(AIM.maxAngle)).toFixed(1)} ${(-100 * Math.sin(AIM.maxAngle)).toFixed(1)} Z"/>
      <line class="ground" x1="-4" y1="0" x2="104" y2="0"/>
      <g class="ghosts"></g>
      <g class="needle"><line x1="0" y1="0" x2="92" y2="0"/><g class="tipPlane" transform="translate(92 0) rotate(90)"><path d="M0 -12 L7 9 L0 5 L-7 9 Z"/></g></g>
      <circle class="hub" r="5"/>
    </svg><div class="pgGaugeLabel">Angle</div>`;
  ui.needle = ui.gauge.querySelector('.needle');
  ui.ghosts = ui.gauge.querySelector('.ghosts');
  ui.gauge.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    handlers.onGaugeTap();
  });
  // Gauge and its redo button stacked in one column on the left.
  ui.left = el('div', 'pgLeft');
  ui.left.append(ui.gauge);
  root.append(ui.left);
  ui.maxDeg = maxDeg;

  // --- redo-angle button (shown while aiming)
  ui.redo = el('button', 'pgBtn pgRedo', '↺ Angle');
  ui.redo.addEventListener('click', () => handlers.onRedoAngle());
  ui.left.append(ui.redo);

  // --- instruction line (bottom centre)
  ui.hint = el('div', 'pgHint');
  root.append(ui.hint);

  // --- the aiming arrow: an SVG laid over the canvas, purely visual
  // (pointer-events: none, it never takes a tap).
  ui.arrowSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  ui.arrowSvg.setAttribute('class', 'pgArrow');
  ui.arrowSvg.innerHTML = `<circle class="reach"/><circle class="dead"/><g class="arrowG"><line class="shaft"/><path class="head"/></g><g class="cancelX"><line/><line/></g>`;
  root.append(ui.arrowSvg);

  // --- fast-forward badge
  ui.ff = el('div', 'pgFF', '▶▶');
  root.append(ui.ff);

  // --- results card
  ui.result = el('div', 'pgResult');
  ui.result.innerHTML = `<div class="pgResultMap"></div><div class="pgResultBody"><div class="title"></div><div class="why"></div><div class="stars"></div><div class="btns"></div></div>`;
  root.append(ui.result);

  // --- looks panel (variations), opened from the top bar
  ui.looks = el('div', 'pgLooks');
  root.append(ui.looks);
  ui.looksBtn.addEventListener('click', () => {
    ui.looks.classList.toggle('open');
  });

  // --- loading / intro
  ui.loading = el('div', 'pgLoading', '<div class="t">Paper Planes</div><div class="bar"><i></i></div>');
  root.append(ui.loading);
  ui.tapToStart = el('div', 'pgTapStart');
  root.append(ui.tapToStart);

  // ---------------------------------------------------------- methods

  ui.setIsland = (index, total, target, throwsUsed, throwsMax, best) => {
    const dots = Array.from({ length: throwsMax }, (_, i) => `<i class="${i < throwsUsed ? 'used' : ''}"></i>`).join('');
    const stars = [0, 1, 2].map((i) => `<b class="${i < best ? 'on' : ''}">★</b>`).join('');
    ui.island.innerHTML = `<div class="n">Island ${index + 1}<span>/${total}</span></div><div class="nm">${target.name}</div><div class="row"><span class="throws" title="throws">${dots}</span><span class="st">${stars}</span></div>`;
  };
  ui.setScore = (stars) => {
    ui.score.innerHTML = `<b>★</b> ${stars}`;
  };
  ui.setWind = (speed, screenAngle) => {
    const words = speed < 0.15 ? 'Calm' : speed < 1.2 ? 'Light wind' : speed < 2 ? 'Windy' : 'Strong wind';
    ui.wind.querySelector('.word').textContent = words;
    const bars = speed < 0.15 ? 0 : speed < 1.2 ? 1 : speed < 2 ? 2 : 3;
    ui.wind.querySelector('.bars').innerHTML = [0, 1, 2].map((i) => `<i class="${i < bars ? 'on' : ''}"></i>`).join('');
    const arrow = ui.wind.querySelector('.arrow');
    arrow.style.display = bars ? '' : 'none';
    arrow.setAttribute('transform', `rotate(${((screenAngle * 180) / Math.PI).toFixed(1)})`);
    ui.wind.classList.toggle('calm', !bars);
  };
  ui.setPlane = (key) => {
    ui.chip.innerHTML = `${icon(key, PLANE_COLORS[key])}<span>${PLANES[key].name}</span><em>Change</em>`;
    for (const k of PLANE_ORDER) ui.cards[k].classList.toggle('sel', k === key);
  };
  ui.showPicker = (on) => {
    ui.picker.classList.toggle('open', on);
    ui.chip.style.display = on ? 'none' : 'flex';
  };
  ui.setNeedle = (angle) => {
    ui.needle.setAttribute('transform', `rotate(${(-(angle * 180) / Math.PI).toFixed(2)})`);
  };
  ui.setGhosts = (angles) => {
    ui.ghosts.innerHTML = angles
      .map((a, i) => {
        const d = (-(a * 180) / Math.PI).toFixed(2);
        const op = (0.35 + (0.5 * (i + 1)) / angles.length).toFixed(2);
        return `<line class="ghost" x1="60" y1="0" x2="100" y2="0" transform="rotate(${d})" style="opacity:${op}"/>`;
      })
      .join('');
  };
  ui.setGaugeMode = (mode) => {
    // 'hidden' | 'sweep' | 'locked'
    ui.gauge.style.display = mode === 'hidden' ? 'none' : 'block';
    ui.gauge.classList.toggle('locked', mode === 'locked');
  };
  ui.setHint = (text) => {
    ui.hint.innerHTML = text || '';
    ui.hint.style.display = text ? 'block' : 'none';
  };
  ui.showRedo = (on) => {
    ui.redo.style.display = on ? 'block' : 'none';
  };
  ui.drawArrow = (state) => {
    // state: null | {x0, y0, x1, y1, reach, dead, color, cancel}
    const svg = ui.arrowSvg;
    if (!state) {
      svg.style.display = 'none';
      return;
    }
    svg.style.display = 'block';
    const { x0, y0, x1, y1, reach, dead, color, cancel } = state;
    const R = svg.querySelector('.reach');
    R.setAttribute('cx', x0);
    R.setAttribute('cy', y0);
    R.setAttribute('r', reach);
    const D = svg.querySelector('.dead');
    D.setAttribute('cx', x0);
    D.setAttribute('cy', y0);
    D.setAttribute('r', dead);
    const g = svg.querySelector('.arrowG');
    const X = svg.querySelector('.cancelX');
    g.style.display = cancel ? 'none' : '';
    X.style.display = cancel ? '' : 'none';
    if (cancel) {
      const s = 12;
      const [l1, l2] = X.querySelectorAll('line');
      l1.setAttribute('x1', x0 - s);
      l1.setAttribute('y1', y0 - s);
      l1.setAttribute('x2', x0 + s);
      l1.setAttribute('y2', y0 + s);
      l2.setAttribute('x1', x0 - s);
      l2.setAttribute('y1', y0 + s);
      l2.setAttribute('x2', x0 + s);
      l2.setAttribute('y2', y0 - s);
      return;
    }
    // A plain, standard arrow: straight shaft, sharp triangular head,
    // starting at the press point so "a little left" is a little left.
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const head = Math.min(26, len * 0.45);
    const bx = x1 - ux * head;
    const by = y1 - uy * head;
    const shaft = svg.querySelector('.shaft');
    shaft.setAttribute('x1', x0);
    shaft.setAttribute('y1', y0);
    shaft.setAttribute('x2', bx);
    shaft.setAttribute('y2', by);
    shaft.style.stroke = color;
    const w = head * 0.62;
    const hp = svg.querySelector('.head');
    hp.setAttribute('d', `M${x1} ${y1} L${bx - uy * w} ${by + ux * w} L${bx + uy * w} ${by - ux * w} Z`);
    hp.style.fill = color;
  };
  ui.showFF = (on) => {
    ui.ff.style.display = on ? 'block' : 'none';
  };

  /**
   * The result card. `r` from results.js: { title, why, stars, tone,
   * map: {...} }. Buttons: [{label, primary, onClick}].
   */
  ui.showResult = (r, buttons, side = 'right') => {
    if (!r) {
      ui.result.classList.remove('open');
      return;
    }
    ui.result.classList.toggle('left', side === 'left');
    const body = ui.result.querySelector('.pgResultBody');
    body.querySelector('.title').textContent = r.title;
    body.querySelector('.title').className = 'title ' + (r.tone || '');
    body.querySelector('.why').innerHTML = r.why || '';
    body.querySelector('.stars').innerHTML = [0, 1, 2].map((i) => `<b class="${i < r.stars ? 'on' : ''}">★</b>`).join('');
    const btns = body.querySelector('.btns');
    btns.innerHTML = '';
    for (const b of buttons) {
      const x = el('button', 'pgBtn' + (b.primary ? ' primary' : ''), b.label);
      x.addEventListener('click', b.onClick);
      btns.append(x);
    }
    ui.result.querySelector('.pgResultMap').innerHTML = resultMap(r.map);
    ui.result.classList.add('open');
  };

  ui.setLoading = (f) => {
    ui.loading.querySelector('i').style.width = `${Math.round(f * 100)}%`;
  };
  ui.hideLoading = () => {
    ui.loading.style.display = 'none';
  };

  return ui;
}

/**
 * The little top-down map on the result card: the target's rings, where
 * this throw ended (a plane icon, or an X at the edge pointing the way it
 * went), the earlier throws as faint dots, and the wind. "Up" on the map is
 * away from the thrower, so short is down, long is up, left is left.
 */
function resultMap(m) {
  if (!m) return '';
  const S = 100; // svg units; the island's radius is 30
  const R = 30;
  const toMap = (p) => ({ x: (p.side / m.r) * R, y: -(p.along / m.r) * R });
  const clampEdge = (p) => {
    const d = Math.hypot(p.x, p.y);
    const lim = 44;
    return d > lim ? { x: (p.x / d) * lim, y: (p.y / d) * lim, out: true } : { ...p, out: false };
  };
  let s = `<svg viewBox="${-S / 2} ${-S / 2} ${S} ${S}">`;
  s += `<circle r="${R}" class="isl"/>`;
  s += `<circle r="${R * RINGS.inner}" class="ringInner"/>`;
  s += `<circle r="${R * RINGS.bull}" class="ringBull"/>`;
  // Throw line: from the thrower (below the map) to the middle.
  s += `<line x1="0" y1="48" x2="0" y2="${R + 2}" class="line"/>`;
  for (const g of m.ghosts || []) {
    const p = clampEdge(toMap(g));
    s += `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3" class="ghost"/>`;
  }
  if (m.end) {
    const p = clampEdge(toMap(m.end));
    if (p.out) {
      const a = Math.atan2(p.y, p.x);
      s += `<g transform="translate(${p.x.toFixed(1)} ${p.y.toFixed(1)}) rotate(${((a * 180) / Math.PI + 90).toFixed(1)})"><path d="M0 -7 L6 5 L-6 5 Z" class="outArrow"/></g>`;
    } else {
      s += `<g transform="translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})"><circle r="6.5" class="endHalo"/><path d="M0 -6 L4 5 L0 3 L-4 5 Z" class="end"/></g>`;
    }
  }
  if (m.wind && m.wind.speed > 0.15) {
    // Wind arrow in the corner, in map orientation.
    const a = m.wind.mapAngle;
    s += `<g transform="translate(36 -36) rotate(${((a * 180) / Math.PI).toFixed(1)})"><path d="M0 -11 L6 -2 L2 -2 L2 10 L-2 10 L-2 -2 L-6 -2 Z" class="windArrow"/></g>`;
  }
  s += '</svg>';
  return s;
}
