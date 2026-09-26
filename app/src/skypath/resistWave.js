/**
 * The "aliens repelled" effect — Luke, 2026-09-23: "a powerful shimmer
 * through the air, like a distortion wave moves in an upward arc from the
 * player."
 *
 * A real distortion, not a drawn ring: while a wave is playing, the scene is
 * rendered to an offscreen target and drawn back to the screen through a
 * shockwave shader that bends the image itself — so it reads as the air
 * warping, over whatever happens to be behind it. Outside a wave, render()
 * is a plain renderer.render(), so this costs nothing the rest of the time.
 *
 * The centre is a WORLD point, re-projected every frame, so the wave stays
 * on the player if the camera moves mid-wave. "Upward arc": each ring is
 * weighted by how far above the centre it is, so it swells up and over the
 * player rather than spreading as a flat full circle. Several rings, each a
 * little later and weaker than the last, are what make it read as a surge
 * rather than one thin ripple.
 *
 * Distances are in units of screen HEIGHT (aspect-corrected), so the wave
 * is the same shape in portrait and landscape.
 */
import * as THREE from 'three';

// Tuned live in-game by Luke, 2026-09-23 (see TODO.md's "Repel wave" entry
// for how) — rings:1 and arcSpread:0 means, in practice, one sharp pulse
// travelling straight up, not the wider multi-ring burst this started as.
export const RESIST_WAVE_DEFAULTS = {
  duration: 1.4, // s, per ring
  rings: 1,
  ringStagger: 0.14, // s between successive rings — moot at rings:1, kept for if that changes
  ringFalloff: 0.55, // each later ring's strength × this
  maxRadius: 0.95, // × screen height, where a ring ends up
  ringWidth: 0.1, // × screen height, at full size (starts thinner)
  strength: 0.041, // peak UV displacement
  arcSpread: 0, // 0 = only straight up, 1 = full circle
  shimmer: 0.35, // high-frequency wobble along the ring, relative to strength
  chroma: 0.33, // colour split, relative to displacement
  brighten: 0.32, // lift in the ring itself
};

const MAX_RINGS = 4;

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  uniform sampler2D tScene;
  uniform vec2 uCenter;      // screen UV of the player
  uniform float uAspect;     // width / height
  uniform float uRadius[${MAX_RINGS}];
  uniform float uWidth[${MAX_RINGS}];
  uniform float uAmp[${MAX_RINGS}];
  uniform float uArcSpread;
  uniform float uShimmer;
  uniform float uChroma;
  uniform float uBrighten;
  uniform float uTime;
  varying vec2 vUv;

  void main() {
    // Aspect-corrected offset from the centre, in screen-height units.
    vec2 d = vUv - uCenter;
    d.x *= uAspect;
    float dist = length(d);
    vec2 dir = dist > 1e-5 ? d / dist : vec2(0.0, 1.0);

    // Upward arc: full weight straight up, fading toward the sides and
    // gone below — how far round it reaches is uArcSpread.
    float arc = smoothstep(-uArcSpread, 1.0 - uArcSpread * 0.5, dir.y);

    float angle = atan(d.y, d.x);
    float disp = 0.0;
    float glow = 0.0;
    for (int i = 0; i < ${MAX_RINGS}; i++) {
      if (uAmp[i] <= 0.0) continue;
      float x = (dist - uRadius[i]) / max(uWidth[i], 1e-4); // -1..1 across the ring
      if (abs(x) >= 1.0) continue;
      // Lens profile: pushes outward on the leading half and pulls inward
      // on the trailing half, which is what makes the image look refracted
      // rather than just smeared. Zero at the ring's edges and centre line.
      float lens = sin(x * 3.14159) * (1.0 - x * x);
      float wobble = 1.0 + uShimmer * sin(angle * 38.0 + uTime * 24.0 + float(i) * 1.7)
                         * sin(angle * 11.0 - uTime * 9.0);
      disp += lens * uAmp[i] * wobble;
      glow += (1.0 - x * x) * uAmp[i];
    }
    disp *= arc;
    glow *= arc;

    vec2 off = dir * disp;
    off.x /= uAspect; // back to UV space
    vec2 uv = vUv - off;
    vec2 split = off * uChroma;
    vec4 c;
    c.r = texture2D(tScene, uv - split).r;
    c.g = texture2D(tScene, uv).g;
    c.b = texture2D(tScene, uv + split).b;
    c.a = 1.0;
    c.rgb += glow * uBrighten * 20.0;
    gl_FragColor = c;
    #include <colorspace_fragment>
  }
`;

export function createResistWave(renderer, params = RESIST_WAVE_DEFAULTS) {
  const p = params; // live object — a tuning panel may write into it mid-wave
  const size = new THREE.Vector2();
  renderer.getDrawingBufferSize(size);
  const target = new THREE.WebGLRenderTarget(size.x, size.y, { samples: 4, type: THREE.HalfFloatType });

  const material = new THREE.ShaderMaterial({
    uniforms: {
      tScene: { value: target.texture },
      uCenter: { value: new THREE.Vector2(0.5, 0.5) },
      uAspect: { value: 1 },
      uRadius: { value: new Array(MAX_RINGS).fill(0) },
      uWidth: { value: new Array(MAX_RINGS).fill(0) },
      uAmp: { value: new Array(MAX_RINGS).fill(0) },
      uArcSpread: { value: p.arcSpread },
      uShimmer: { value: p.shimmer },
      uChroma: { value: p.chroma },
      uBrighten: { value: p.brighten },
      uTime: { value: 0 },
    },
    vertexShader,
    fragmentShader,
    depthTest: false,
    depthWrite: false,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  quad.frustumCulled = false;
  const quadScene = new THREE.Scene();
  quadScene.add(quad);
  const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const center = new THREE.Vector3();
  const projected = new THREE.Vector3();
  let startedAt = null;

  const easeOut = (u) => 1 - Math.pow(1 - u, 3);

  function totalDuration() {
    return p.duration + p.ringStagger * (Math.min(p.rings, MAX_RINGS) - 1);
  }

  return {
    /** Starts a wave centred on `worldPos` (the player's chest, say). A second call restarts it. */
    trigger(worldPos) {
      center.copy(worldPos);
      startedAt = performance.now();
    },
    get active() {
      return startedAt !== null;
    },
    /** Use in place of renderer.render(scene, camera) every frame. */
    render(scene, camera) {
      if (startedAt === null) {
        renderer.render(scene, camera);
        return;
      }
      const t = (performance.now() - startedAt) / 1000;
      if (t >= totalDuration()) {
        startedAt = null;
        renderer.render(scene, camera);
        return;
      }
      projected.copy(center).project(camera);
      if (projected.z > 1) {
        // Behind the camera — nothing sensible to centre on.
        renderer.render(scene, camera);
        return;
      }
      const u = material.uniforms;
      u.uCenter.value.set(projected.x * 0.5 + 0.5, projected.y * 0.5 + 0.5);
      u.uAspect.value = camera.aspect ?? 1;
      u.uArcSpread.value = p.arcSpread;
      u.uShimmer.value = p.shimmer;
      u.uChroma.value = p.chroma;
      u.uBrighten.value = p.brighten;
      u.uTime.value = t;
      const rings = Math.min(Math.round(p.rings), MAX_RINGS);
      for (let i = 0; i < MAX_RINGS; i++) {
        const k = (t - i * p.ringStagger) / p.duration;
        if (i >= rings || k <= 0 || k >= 1) {
          u.uAmp.value[i] = 0;
          continue;
        }
        const e = easeOut(k);
        u.uRadius.value[i] = e * p.maxRadius;
        u.uWidth.value[i] = p.ringWidth * (0.35 + 0.65 * e);
        // Strong punch at the start, dying away as it spreads.
        u.uAmp.value[i] = p.strength * Math.pow(p.ringFalloff, i) * Math.pow(1 - k, 1.5) * Math.min(1, k * 8);
      }

      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
      renderer.setRenderTarget(null);
      renderer.render(quadScene, quadCam);
    },
    setSize() {
      renderer.getDrawingBufferSize(size);
      target.setSize(size.x, size.y);
    },
    dispose() {
      target.dispose();
      material.dispose();
      quad.geometry.dispose();
    },
  };
}
