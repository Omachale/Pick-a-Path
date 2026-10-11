/**
 * sound-preview.html: plays each sound in sfx.js on its own, for Luke to
 * judge before any of them go into the game (2026-10-11, asked for as a
 * separate preview). "Save WAV" renders a sound offline and downloads it.
 */
import * as SFX from './sfx.js';

const LIST = [
  { key: 'wind', name: 'Cold wind', tag: 'requested · loop', loop: true, secs: 8, where: 'Underneath everything, most of the time. Faint airy hiss with a thin wandering whistle; gusts never repeat.' },
  { key: 'bridgeCrossing', name: 'Bridge creaking', tag: 'requested · loop', loop: true, secs: 6, where: 'While a player walks a bridge (hold ▲). Random creaks every ~0.5–1.5 s; stops when they stop.' },
  { key: 'creak', name: 'Single creak', tag: 'requested', secs: 1.2, where: 'One creak on its own, as the loop above uses. Also for a bridge settling under a waiting player.' },
  { key: 'plankBreak', name: 'Plank breaking', tag: 'requested', secs: 1, where: 'The wrong bridge’s planks snapping (triggerPlankBreak).' },
  { key: 'shipArrive', name: 'Alien ship arriving', tag: 'requested', secs: 4, where: 'The saucer flying in (startAbduction).' },
  { key: 'shipDepart', name: 'Alien ship leaving', tag: 'requested', secs: 3.5, where: 'The saucer flying away, with or without its catch.' },
  { key: 'beamAbduct', name: 'Abduction beam', tag: 'requested', secs: 5, where: 'Beam sweeps down, holds the player, lifts them up.' },
  { key: 'cardTap', name: 'Cardboard tap', tag: 'suggested', secs: 0.4, where: 'Tapping a word sign to choose, and other cardboard buttons. Confirms the tap landed.' },
  { key: 'fallWhoosh', name: 'Falling', tag: 'suggested', secs: 2.2, where: 'The player dropping off the edge (startFall), straight after the plank break.' },
  { key: 'jetpack', name: 'Jetpack', tag: 'suggested', secs: 3.2, where: 'The jetpack rescue firing (startRescue).' },
  { key: 'templeDoors', name: 'Temple doors', tag: 'suggested', secs: 2.6, where: 'The temple doors swinging open at the end (startTempleEntry).' },
  { key: 'chimes', name: 'Wind chimes', tag: 'suggested', secs: 3.5, where: 'Arriving at the temple, or reaching the next island. Soft, so it rewards without fanfare.' },
];

let ctx = null;
let master = null;
const running = new Map(); // key -> { stop }

function audio() {
  if (!ctx) {
    ctx = new AudioContext();
    // A gentle limiter so overlapping sounds never clip.
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -6;
    comp.ratio.value = 8;
    master = ctx.createGain();
    master.gain.value = Number(document.getElementById('vol').value);
    master.connect(comp).connect(ctx.destination);
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

function wav(buffer) {
  const data = buffer.getChannelData(0);
  const sr = buffer.sampleRate;
  const bytes = new ArrayBuffer(44 + data.length * 2);
  const v = new DataView(bytes);
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + data.length * 2, true);
  str(8, 'WAVEfmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sr, true);
  v.setUint32(28, sr * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, data.length * 2, true);
  let peak = 0;
  for (const s of data) peak = Math.max(peak, Math.abs(s));
  const scale = peak > 0.98 ? 0.98 / peak : 1;
  for (let i = 0; i < data.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, data[i] * scale)) * 32767, true);
  return new Blob([bytes], { type: 'audio/wav' });
}

async function saveWav(item) {
  const sr = 44100;
  const off = new OfflineAudioContext(1, Math.ceil(sr * item.secs), sr);
  SFX[item.key](off, off.destination, item.loop ? { duration: item.secs } : {});
  const blob = wav(await off.startRendering());
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `skypath-${item.key}.wav`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

const grid = document.getElementById('grid');
for (const item of LIST) {
  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = `<span class="tag">${item.tag}</span><h2>${item.name}</h2><div class="where">${item.where}</div>`;
  const btns = document.createElement('div');
  btns.className = 'btns';
  const play = document.createElement('button');
  play.className = 'play';
  play.textContent = item.loop ? 'Start' : 'Play';
  play.addEventListener('click', () => {
    const c = audio();
    if (!item.loop) return SFX[item.key](c, master);
    if (running.has(item.key)) {
      running.get(item.key).stop();
      running.delete(item.key);
      play.textContent = 'Start';
      play.classList.remove('on');
    } else {
      running.set(item.key, SFX[item.key](c, master));
      play.textContent = 'Stop';
      play.classList.add('on');
    }
  });
  const save = document.createElement('button');
  save.textContent = 'Save WAV';
  save.addEventListener('click', () => saveWav(item));
  btns.append(play, save);
  card.append(btns);
  grid.append(card);
}

document.getElementById('vol').addEventListener('input', (e) => {
  if (master) master.gain.value = Number(e.target.value);
});
document.getElementById('stopAll').addEventListener('click', () => {
  for (const [, h] of running) h.stop();
  running.clear();
  document.querySelectorAll('button.play.on').forEach((b) => {
    b.classList.remove('on');
    b.textContent = 'Start';
  });
});

// Dev check hook: renders every sound offline and reports length/peak/RMS,
// so silent or clipping sounds show up without listening.
window.__renderAll = async () => {
  const out = {};
  for (const item of LIST) {
    const sr = 44100;
    const off = new OfflineAudioContext(1, Math.ceil(sr * item.secs), sr);
    SFX[item.key](off, off.destination, item.loop ? { duration: item.secs } : {});
    const d = (await off.startRendering()).getChannelData(0);
    let peak = 0;
    let sum = 0;
    for (const s of d) {
      peak = Math.max(peak, Math.abs(s));
      sum += s * s;
    }
    out[item.key] = { peak: +peak.toFixed(3), rms: +Math.sqrt(sum / d.length).toFixed(4) };
  }
  return out;
};
