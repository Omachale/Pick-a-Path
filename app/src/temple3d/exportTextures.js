/**
 * TEMPLE 3D TEST, dev only: regenerates the temple's slow textures and saves
 * them, so the game can load small WebP files instead of spending most of its
 * temple build time drawing them pixel by pixel (see templeBuilder.js's
 * FILE_TEXTURES).
 *
 * Needed only when a texture generator or the seed changes. To re-run, on
 * http://localhost:5181/temple-3d.html, in the browser console:
 *
 *   (await import('/src/temple3d/exportTextures.js')).saveTempleTextures()
 *
 * Each file goes through the dev server's existing /__shot endpoint (see
 * vite.config.js), which saves to app/shots/<timestamp>.png whatever the
 * contents (these are WebP bytes, whatever the name). The returned list says
 * which saved file is which; move each to app/public/textures/temple3d/<name>.webp.
 */
import { exportTempleTextures } from './templeBuilder.js';

export async function saveTempleTextures() {
  const out = [];
  for (const { name, dataUrl } of exportTempleTextures()) {
    const saved = await (await fetch('/__shot', { method: 'POST', body: dataUrl })).text();
    out.push({ name, saved, bytes: Math.round((dataUrl.length - dataUrl.indexOf(',') - 1) * 0.75) });
  }
  return out;
}
