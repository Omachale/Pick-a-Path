/**
 * Generated from "Keyboard Cardboard.png" (Luke's supplied photo/render,
 * cut into 38 individual key PNGs under public/textures/keyboard/) by
 * measuring each key's actual cropped bounding box and normalizing to a
 * 0-100 design space. Regenerate this by rerunning the same extraction
 * script against a new source image rather than hand-editing these numbers
 * — they're measurements, not tuned values.
 */
export const KEY_LAYOUT = {
  '1': { left: 0.000, top: 0.426, width: 8.428, height: 18.621 },
  '2': { left: 8.557, top: 0.213, width: 8.201, height: 18.763 },
  '3': { left: 16.952, top: 0.000, width: 8.266, height: 18.905 },
  '4': { left: 25.509, top: 0.000, width: 8.008, height: 18.905 },
  '5': { left: 33.839, top: 0.142, width: 7.975, height: 18.621 },
  '6': { left: 42.138, top: 0.142, width: 7.911, height: 18.834 },
  '7': { left: 50.404, top: 0.071, width: 7.911, height: 18.905 },
  '8': { left: 58.670, top: 0.142, width: 7.879, height: 18.692 },
  '9': { left: 66.936, top: 0.142, width: 7.975, height: 18.621 },
  '0': { left: 75.266, top: 0.071, width: 7.943, height: 18.692 },
  BACKSPACE: { left: 83.532, top: 0.000, width: 16.468, height: 18.977 },
  Q: { left: 2.648, top: 20.398, width: 9.590, height: 18.977 },
  W: { left: 12.464, top: 20.469, width: 9.751, height: 18.977 },
  E: { left: 22.538, top: 20.469, width: 9.009, height: 18.977 },
  R: { left: 31.966, top: 20.469, width: 9.202, height: 19.048 },
  T: { left: 41.621, top: 20.469, width: 9.396, height: 19.048 },
  Y: { left: 51.501, top: 20.540, width: 9.332, height: 18.905 },
  U: { left: 61.350, top: 20.611, width: 9.073, height: 18.834 },
  I: { left: 70.940, top: 20.611, width: 8.880, height: 18.834 },
  O: { left: 80.304, top: 20.611, width: 8.428, height: 18.834 },
  P: { left: 89.151, top: 20.611, width: 8.266, height: 18.834 },
  A: { left: 6.038, top: 40.938, width: 9.881, height: 19.261 },
  S: { left: 16.306, top: 41.009, width: 9.687, height: 19.119 },
  D: { left: 26.445, top: 41.009, width: 9.525, height: 19.119 },
  F: { left: 36.487, top: 41.080, width: 9.235, height: 19.119 },
  G: { left: 46.206, top: 41.080, width: 9.332, height: 19.119 },
  H: { left: 56.054, top: 41.080, width: 9.202, height: 19.119 },
  J: { left: 65.773, top: 41.009, width: 9.041, height: 19.190 },
  K: { left: 75.299, top: 40.938, width: 9.073, height: 19.332 },
  L: { left: 84.856, top: 41.080, width: 8.847, height: 19.261 },
  Z: { left: 12.625, top: 61.549, width: 9.913, height: 19.048 },
  X: { left: 22.925, top: 61.549, width: 9.848, height: 19.048 },
  C: { left: 33.226, top: 61.620, width: 9.622, height: 18.977 },
  V: { left: 43.300, top: 61.692, width: 9.751, height: 18.905 },
  B: { left: 53.600, top: 61.763, width: 9.525, height: 18.834 },
  N: { left: 63.675, top: 61.763, width: 9.687, height: 18.834 },
  M: { left: 73.813, top: 61.763, width: 10.623, height: 18.977 },
  SPACE: { left: 21.828, top: 81.734, width: 52.858, height: 18.266 },
};

// width / height of the design space the percentages above are relative to.
export const KEY_LAYOUT_ASPECT = 2.201137;

export function keyImageSrc(name) {
  const file = name.length === 1 ? name : name.toLowerCase();
  return `/textures/keyboard/${file}.png`;
}
