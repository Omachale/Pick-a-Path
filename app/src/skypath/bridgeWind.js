/**
 * Wind sway for the rope bridges.
 *
 * Six layers, each independently switchable (Luke, 2026-09-01: "make sure all
 * six are fully able to be disabled" — we expect to drop some once they can be
 * compared in isolation). Every layer's `on` flag is a *uniform*, not a
 * `#define`, so toggling one takes effect on the next frame without a shader
 * recompile — which is what makes flicking them on and off against each other
 * actually usable.
 *
 *   1. swing    — lateral push, downwind, zero at both anchors
 *   2. travel   — phase lag, so the wave moves across the world (see below)
 *   3. roll     — planks bank about the direction of travel
 *   4. bob      — small vertical bounce, off-phase from the swing
 *   5. octaves  — extra sines at incommensurate ratios, so it never loops
 *   6. gust     — slow global swell shared by every bridge in the scene
 *
 * ── Why the phase depends on world position ──────────────────────────────
 * The requirement was that the two ends of a bridge, and the two bridges of a
 * fork, sway with a slight delay from each other while still reading as one
 * wind. Rather than assigning per-bridge offsets by hand, the wave's phase is
 * advanced by distance along the wind direction:
 *
 *     phase = time·frequency − k · dot(worldPosition.xz, windDirection)
 *
 * Everything then falls out on its own and stays consistent: the near and far
 * ends of a span lag, the two parallel bridges lag (they are offset across the
 * wind), separate forks lag, and none of it can drift out of agreement because
 * there is only ever one direction and one clock. It also keeps working if a
 * bridge is ever moved, with no bookkeeping to update.
 *
 * ── The GLSL/JS twin ─────────────────────────────────────────────────────
 * The same function exists twice: once as GLSL (for the geometry) and once as
 * `evaluate()` (for the walker, who has to ride the deck or they will stand
 * still while it slides out from under them). They MUST stay in step. They are
 * kept adjacent in this file for exactly that reason — if you change one,
 * change the other in the same edit. There is no test that will catch a
 * mismatch; it shows up as a character drifting off the planks.
 *
 * ── NOT DONE YET: shadows ────────────────────────────────────────────────
 * Vertex displacement happens in the material's own shader, which the shadow
 * pass does not use — it renders through a separate depth material. So a
 * swaying plank currently casts a STATIONARY shadow. This is invisible in the
 * tuning page (which renders no shadows at all) but will show the moment
 * bridges land in the game, where `renderer.shadowMap.enabled` is on and the
 * planks are created with `castShadow = true`.
 *
 * The fix is to give the plank mesh a `customDepthMaterial` carrying the same
 * injection. It is deliberately not written here: it cannot be exercised on
 * this page, and untested shader code that merely looks right is worse than an
 * honest note. Do it as part of game integration, where it can be seen.
 *
 * ── Assumption worth knowing ─────────────────────────────────────────────
 * Bridge geometry is built in world coordinates and its group is left at the
 * origin with no transform (see buildBridge), so model space and world space
 * are the same thing here. The shader relies on that to add a world-space
 * offset to a local-space vertex. If a bridge group is ever given a position
 * or rotation, this breaks quietly — displacement would be rotated by the
 * group's transform.
 */

import * as THREE from 'three';

/**
 * FINAL — agreed with Luke 2026-09-01 on the tuning page (app/bridge-tuner.html,
 * whose wind panel is now parked; see the header comment there for how to bring
 * it back). Roll and swing looked "a bit silly" at the exploratory amplitudes
 * used while isolating each layer — both came down hard from where they were
 * (swing 0.16 → 0.1, roll 0.35 → 0.05) once judged together rather than solo.
 * Re-open that page rather than editing these by eye.
 *
 * `on` at the top switches the whole system off; each layer then has its own
 * `on`. `frequency` is the base tempo shared by every layer — turning `swing`
 * off silences the lateral movement but leaves that clock running for roll and
 * bob, which is what made isolating one layer meaningful during tuning.
 */
export const WIND_DEFAULTS = {
  on: true,
  direction: 0.6,   // radians; the world heading the wind blows toward
  frequency: 0.5,   // base tempo, radians/sec

  swing: { on: true, amplitude: 0.1 },    // world units of lateral push at midspan
  travel: { on: true, wavelength: 24 },   // world units per wave — smaller = more visible lag end-to-end
  roll: { on: true, amount: 0.05 },       // radians of plank bank at full swing
  bob: { on: true, amplitude: 0.045, frequency: 1.7 }, // frequency is a multiple of the base
  octaves: { on: true, amplitude: 0.4, ratio: 2.3 },   // amplitude relative to the base sine
  gust: { on: true, amplitude: 0.55, period: 11 },     // seconds per swell
};

/**
 * The wind function, as GLSL. Mirrored by evaluate() below — keep them
 * identical. Every layer is gated by a `*On` uniform that is exactly 0 or 1,
 * so a disabled layer contributes exactly nothing rather than merely a small
 * amount.
 */
const WIND_GLSL = /* glsl */ `
uniform float uWindOn;
uniform float uWindTime;
uniform vec2  uWindDir;
uniform float uWindFreq;
uniform float uSwingOn;
uniform float uSwingAmp;
uniform float uTravelOn;
uniform float uTravelK;
uniform float uRollOn;
uniform float uRollAmt;
uniform float uBobOn;
uniform float uBobAmp;
uniform float uBobFreq;
uniform float uOctOn;
uniform float uOctAmp;
uniform float uOctRatio;
uniform float uGustOn;
uniform float uGustAmp;
uniform float uGustW;
attribute float aSpanT;

vec3 bridgeWind(vec3 wp, float spanT, out float roll) {
  // Zero at both anchors: the ropes are tied to the posts and must not leave
  // them. Everything below is scaled by this.
  float env = sin(3.141592653589793 * clamp(spanT, 0.0, 1.0));

  float d = dot(wp.xz, uWindDir);
  float phase = uWindTime * uWindFreq - uTravelOn * uTravelK * d;

  // Layer 5: extra sines at ratios that don't divide evenly, so the motion has
  // no visible period. Normalised so switching octaves on doesn't also make
  // everything louder.
  float wave = sin(phase);
  wave += uOctOn * uOctAmp * sin(phase * uOctRatio + 1.7);
  wave += uOctOn * uOctAmp * 0.5 * sin(phase * uOctRatio * 1.93 + 4.1);
  wave /= 1.0 + uOctOn * uOctAmp * 1.5;

  // Layer 6: one swell, shared by every bridge because it depends only on time.
  float gust = 1.0 + uGustOn * uGustAmp * sin(uWindTime * uGustW);

  float lateral = uSwingOn * uSwingAmp * env * wave * gust;
  float vert = uBobOn * uBobAmp * env * sin(phase * uBobFreq + 2.3) * gust;

  roll = uRollOn * uRollAmt * env * wave * gust * uWindOn;

  return vec3(uWindDir.x * lateral, vert, uWindDir.y * lateral) * uWindOn;
}
`;

/**
 * Builds one shared wind instance. Every bridge material patched by the same
 * instance references the *same* uniform objects, so one update moves the whole
 * scene together — which is what guarantees a single consistent wind rather
 * than each bridge running its own.
 */
export function createBridgeWind(config = {}) {
  const cfg = {
    ...WIND_DEFAULTS,
    ...config,
    swing: { ...WIND_DEFAULTS.swing, ...config.swing },
    travel: { ...WIND_DEFAULTS.travel, ...config.travel },
    roll: { ...WIND_DEFAULTS.roll, ...config.roll },
    bob: { ...WIND_DEFAULTS.bob, ...config.bob },
    octaves: { ...WIND_DEFAULTS.octaves, ...config.octaves },
    gust: { ...WIND_DEFAULTS.gust, ...config.gust },
  };

  const uniforms = {
    uWindOn: { value: 0 },
    uWindTime: { value: 0 },
    uWindDir: { value: new THREE.Vector2(1, 0) },
    uWindFreq: { value: 0 },
    uSwingOn: { value: 0 },
    uSwingAmp: { value: 0 },
    uTravelOn: { value: 0 },
    uTravelK: { value: 0 },
    uRollOn: { value: 0 },
    uRollAmt: { value: 0 },
    uBobOn: { value: 0 },
    uBobAmp: { value: 0 },
    uBobFreq: { value: 0 },
    uOctOn: { value: 0 },
    uOctAmp: { value: 0 },
    uOctRatio: { value: 0 },
    uGustOn: { value: 0 },
    uGustAmp: { value: 0 },
    uGustW: { value: 0 },
  };

  /** Pushes the config into the uniforms. Cheap; call it after any change. */
  function apply() {
    uniforms.uWindOn.value = cfg.on ? 1 : 0;
    uniforms.uWindDir.value.set(Math.cos(cfg.direction), Math.sin(cfg.direction));
    uniforms.uWindFreq.value = cfg.frequency;
    uniforms.uSwingOn.value = cfg.swing.on ? 1 : 0;
    uniforms.uSwingAmp.value = cfg.swing.amplitude;
    uniforms.uTravelOn.value = cfg.travel.on ? 1 : 0;
    uniforms.uTravelK.value = (2 * Math.PI) / Math.max(0.001, cfg.travel.wavelength);
    uniforms.uRollOn.value = cfg.roll.on ? 1 : 0;
    uniforms.uRollAmt.value = cfg.roll.amount;
    uniforms.uBobOn.value = cfg.bob.on ? 1 : 0;
    uniforms.uBobAmp.value = cfg.bob.amplitude;
    uniforms.uBobFreq.value = cfg.bob.frequency;
    uniforms.uOctOn.value = cfg.octaves.on ? 1 : 0;
    uniforms.uOctAmp.value = cfg.octaves.amplitude;
    uniforms.uOctRatio.value = cfg.octaves.ratio;
    uniforms.uGustOn.value = cfg.gust.on ? 1 : 0;
    uniforms.uGustAmp.value = cfg.gust.amplitude;
    uniforms.uGustW.value = (2 * Math.PI) / Math.max(0.001, cfg.gust.period);
  }
  apply();

  /**
   * The JS twin of bridgeWind() above — same maths, same layer gates. Used for
   * the walker, who must ride the deck. Returns the world-space offset and the
   * roll angle. KEEP IN STEP WITH THE GLSL.
   */
  function evaluate(worldX, worldZ, spanT, out = new THREE.Vector3()) {
    if (!cfg.on) return { offset: out.set(0, 0, 0), roll: 0 };
    const env = Math.sin(Math.PI * THREE.MathUtils.clamp(spanT, 0, 1));
    const dirX = Math.cos(cfg.direction);
    const dirZ = Math.sin(cfg.direction);

    const travelOn = cfg.travel.on ? 1 : 0;
    const k = (2 * Math.PI) / Math.max(0.001, cfg.travel.wavelength);
    const d = worldX * dirX + worldZ * dirZ;
    const phase = uniforms.uWindTime.value * cfg.frequency - travelOn * k * d;

    const octOn = cfg.octaves.on ? 1 : 0;
    const octAmp = cfg.octaves.amplitude;
    let wave = Math.sin(phase);
    wave += octOn * octAmp * Math.sin(phase * cfg.octaves.ratio + 1.7);
    wave += octOn * octAmp * 0.5 * Math.sin(phase * cfg.octaves.ratio * 1.93 + 4.1);
    wave /= 1 + octOn * octAmp * 1.5;

    const gustOn = cfg.gust.on ? 1 : 0;
    const gustW = (2 * Math.PI) / Math.max(0.001, cfg.gust.period);
    const gust = 1 + gustOn * cfg.gust.amplitude * Math.sin(uniforms.uWindTime.value * gustW);

    const lateral = (cfg.swing.on ? 1 : 0) * cfg.swing.amplitude * env * wave * gust;
    const vert =
      (cfg.bob.on ? 1 : 0) * cfg.bob.amplitude * env * Math.sin(phase * cfg.bob.frequency + 2.3) * gust;
    const roll = (cfg.roll.on ? 1 : 0) * cfg.roll.amount * env * wave * gust;

    return { offset: out.set(dirX * lateral, vert, dirZ * lateral), roll };
  }

  /**
   * Injects the wind into a material's vertex shader.
   *
   * `mode` is 'instanced' for the planks (which also bank, and whose world
   * position comes from their instance matrix) or 'vertex' for the ropes
   * (plain geometry, already in world space, no banking — a rope does not have
   * an up).
   *
   * Ropes and planks must be patched by the same wind instance or the deck will
   * visibly tear away from the ropes carrying it.
   */
  function patch(material, mode) {
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = WIND_GLSL + shader.vertexShader;

      if (mode === 'instanced') {
        shader.vertexShader = shader.vertexShader.replace(
          '#include <begin_vertex>',
          /* glsl */ `
          #include <begin_vertex>
          // The instance's own world position — its translation column. Using
          // the instance rather than the vertex keeps every corner of a plank
          // on the same phase, so a plank stays rigid instead of shearing.
          vec3 windAnchor = (instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
          float windRoll;
          vec3 windOffset = bridgeWind(windAnchor, aSpanT, windRoll);
          // Bank about the plank's own local Z, which makeBasis() aligned with
          // the direction of travel.
          float wcr = cos(windRoll);
          float wsr = sin(windRoll);
          transformed.xy = mat2(wcr, wsr, -wsr, wcr) * transformed.xy;
          `
        );
        // The offset has to land AFTER instanceMatrix (it is a world-space
        // push, not a local one), so project_vertex is rebuilt rather than
        // prepended to.
        shader.vertexShader = shader.vertexShader.replace(
          '#include <project_vertex>',
          /* glsl */ `
          vec4 mvPosition = vec4( transformed, 1.0 );
          #ifdef USE_INSTANCING
            mvPosition = instanceMatrix * mvPosition;
          #endif
          mvPosition.xyz += windOffset;
          mvPosition = modelViewMatrix * mvPosition;
          gl_Position = projectionMatrix * mvPosition;
          `
        );
      } else {
        shader.vertexShader = shader.vertexShader.replace(
          '#include <begin_vertex>',
          /* glsl */ `
          #include <begin_vertex>
          float windRoll;
          transformed += bridgeWind(transformed, aSpanT, windRoll);
          `
        );
      }
    };
    // Without this, three caches one compiled program per material *type* and
    // the two modes would collide with each other and with unpatched Lambert.
    material.customProgramCacheKey = () => `bridgeWind-${mode}`;
    return material;
  }

  return {
    config: cfg,
    uniforms,
    apply,
    evaluate,
    patch,
    /** Advance the clock. One call per frame moves every bridge in the scene. */
    update(elapsedSeconds) {
      uniforms.uWindTime.value = elapsedSeconds;
    },
  };
}
