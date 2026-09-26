/**
 * The alien abduction event: a flying saucer lowers from off the top of the
 * frame, extends a teleport beam over one player, and carries their card away
 * (Luke, 2026-09-01).
 *
 * Deliberately a *puppet show*, not a special effect. Both source images are
 * photographs of cardboard cut-outs with visible corrugation and hand-cut
 * outlines, and everything here is built to preserve that: flat unlit planes,
 * hard alpha edges, rigid sliding parts. Nothing glows, nothing is additively
 * blended, nothing is soft — with ONE deliberate exception (see GLOW below):
 * the eerie green light that marks the chosen player the instant the sequence
 * starts. Every prop up to that point is a physical thing on strings; the
 * light isn't a prop at all, it's the one moment something not of this stage
 * reaches in and picks someone out — so it's allowed to look like an actual
 * light (soft, additive) precisely because nothing else here does. The ship
 * even has a loop of string photographed at its top — the rig it hangs from
 * is a later job, but the art is already committed to the conceit and the
 * motion has to agree with it.
 *
 * Two structural decisions worth stating up front, because both look like
 * mistakes until you know why:
 *
 *  - **The beam slides; it does not stretch or scale.** A cardboard beam on a
 *    puppet stage is pushed down from behind the scenery, so this translates a
 *    rigid plane in local -Y. Stretching would be one line shorter and would
 *    immediately read as a computer effect rather than a prop.
 *  - **The beam's top is clipped, not masked by the ship's alpha.** The beam
 *    image is taller than the ship image, so its narrow top pokes out above the
 *    ship's cardboard even fully retracted — and slides *further* out of cover
 *    as it extends. Relying on the ship's own silhouette to hide it fails for
 *    exactly the region that matters (the ship's art is transparent above its
 *    cardboard edge, where the string is). See BEAM_CLIP below.
 *
 * Numbers live in ABDUCTION_DEFAULTS and are tuned on app/alien-tuner.html —
 * the same arrangement islandGen/bridgeGen have with their own pages. Find them
 * there, bake them here, don't guess them at the call site.
 */

import * as THREE from 'three';

// ---------------------------------------------------------------- art metadata
//
// Measured off the source PNGs rather than eyeballed, and kept as named
// fractions of the image so they survive a re-export at a different resolution
// (they do NOT survive a re-crop — see the note on each).
//
// The alternative was trimming the transparent margins out of Luke's files so
// the geometry could assume art fills the plane. Rejected: it puts a silent
// build step between what he exports and what ships, and the first time he
// re-exported without it every offset here would be wrong with no error.
const SHIP_ART = {
  width: 833,
  height: 461,
  // Top edge of the CARDBOARD, not of the image. Above this row the only
  // opaque pixels are the hanging string, which is a few px wide and cannot
  // hide anything. This is the line the beam has to be cut at.
  cardboardTop: 161,
  // Apex of the loop of string photographed at the top of the ship — the
  // topmost opaque pixel in the whole image, at x 410..419. This is what the
  // hanging string's knot ties onto.
  loopApexX: 414.5,
  loopApexY: 11,
  // Width of one strand of that loop, a few rows below the apex. Used to size
  // the hanging string so the two ropes read as the same rope.
  loopStrandW: 7.5,
};

const STRING_ART = {
  width: 48,
  height: 1008,
  // The knot at the bottom, measured as the rows where the rope swells past
  // its normal width: rows 985..1004, x 21..38.
  knotX: 29.5,
  knotY: 994.5,
  knotH: 20,
  /** Width of the plain rope away from the knot. */
  strandW: 8,
};

const BEAM_ART = {
  width: 358,
  height: 469,
  // Alpha bounding box of the cone. There is ~59px of empty space above the
  // artwork and ~10px below, so the visible beam is NOT vertically centred in
  // its own image and positioning maths that assumes it is will sit the beam
  // too low by about 5% of its height. Horizontally the cone's mouth spans
  // 15..342 of 358, so the plane has to be built ~10% wider than the beam
  // width actually wanted.
  top: 59,
  bottom: 459,
  left: 15,
  right: 342,
};

/** Where the ship's cardboard edge sits as a fraction down from the plane's top. */
const SHIP_CARDBOARD_TOP_FRAC = SHIP_ART.cardboardTop / SHIP_ART.height; // 0.349
/** Where the cone's tip and mouth sit as fractions down from the beam plane's top. */
const BEAM_ART_TOP_FRAC = BEAM_ART.top / BEAM_ART.height; // 0.126
const BEAM_ART_BOTTOM_FRAC = BEAM_ART.bottom / BEAM_ART.height; // 0.979
/** Fraction of the beam plane's width the cone's mouth actually occupies. */
const BEAM_MOUTH_W_FRAC = (BEAM_ART.right - BEAM_ART.left) / BEAM_ART.width; // 0.913

const SHIP_ASPECT = SHIP_ART.width / SHIP_ART.height;
const BEAM_ASPECT = BEAM_ART.width / BEAM_ART.height;
const STRING_ASPECT = STRING_ART.width / STRING_ART.height;

/** Where the ship's loop apex sits as fractions of its plane, from the centre. */
const SHIP_LOOP_X_FRAC = SHIP_ART.loopApexX / SHIP_ART.width - 0.5; // -0.0024
const SHIP_LOOP_Y_FRAC = 0.5 - SHIP_ART.loopApexY / SHIP_ART.height; // 0.4761
/** Where the string's knot sits as fractions of its plane, from the centre. */
const KNOT_X_FRAC = STRING_ART.knotX / STRING_ART.width - 0.5; // 0.1146
const KNOT_Y_FRAC = 0.5 - STRING_ART.knotY / STRING_ART.height; // -0.4866

/**
 * String plane width, as a fraction of the ship plane's width, that makes the
 * hanging rope exactly as thick as the loop already photographed on the ship.
 * Both are pictures of real string, so matching the strand widths is what
 * makes them read as one continuous prop rather than two different ropes —
 * and it is a ratio, so it holds at any ship size.
 */
// A strand is `loopStrandW/shipImageW` of the ship plane and
// `strandW/stringImageW` of the string plane; equating the two world widths
// and solving for the string plane leaves this ratio. ≈ 0.054.
const STRING_W_PER_SHIP_W =
  (SHIP_ART.loopStrandW / SHIP_ART.width) * (STRING_ART.width / STRING_ART.strandW);

/**
 * A soft round falloff — white, opaque at the centre, transparent at the
 * edge — used as the alpha mask for the GROUND mark. Generated once and
 * shared by every abduction rig built for the rest of the page's life (a
 * buildAbduction() call per event, one event at a time in practice, so
 * regenerating this per call would be pure waste): it's plain white so the
 * SAME texture can be tinted any colour later just by changing a material's
 * `color`, rather than baking green into the pixels and being stuck with it.
 *
 * Deliberately NOT shared with the card mark — see glowTextureSoft() below,
 * which needs a genuinely different (much more diffuse) shape, not just a
 * smaller or fainter copy of this one.
 */
let glowTextureCache = null;
function glowTexture() {
  if (glowTextureCache) return glowTextureCache;
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const r = size / 2;
  const g = ctx.createRadialGradient(r, r, 0, r, r, r);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.4)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  glowTextureCache = new THREE.CanvasTexture(canvas);
  return glowTextureCache;
}

/**
 * A genuinely BLURRED mask (not just a wider gradient) for the card mark.
 * Luke, 2026-09-04, after the first version (glowTexture() reused, small and
 * fully opaque at its centre) read as "a green spot on the player's stomach"
 * rather than an ambient wash: a radial *gradient* still has a hard, bright
 * core, however wide its falloff — a small solid circle actually blurred
 * (real pixel diffusion, via the canvas `filter` primitive, the same
 * technique nameTag.js already uses for its own glow) is what removes that
 * core rather than just widening it.
 *
 * `'filter' in ctx` mirrors nameTag.js's own guard — every real browser this
 * game targets supports it, but degrading to a wide, low-contrast gradient
 * (still far softer than glowTexture()'s) is a safer failure than a canvas
 * that silently draws nothing.
 */
let glowTextureSoftCache = null;
function glowTextureSoft() {
  if (glowTextureSoftCache) return glowTextureSoftCache;
  const size = 256; // bigger canvas than glowTexture()'s — the blur needs open margin to spread into without clipping
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const r = size / 2;
  if ('filter' in ctx) {
    ctx.filter = `blur(${size * 0.16}px)`;
    ctx.beginPath();
    ctx.arc(r, r, size * 0.17, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.fill();
    ctx.filter = 'none';
  } else {
    const g = ctx.createRadialGradient(r, r, 0, r, r, r);
    g.addColorStop(0, 'rgba(255,255,255,0.75)');
    g.addColorStop(0.35, 'rgba(255,255,255,0.45)');
    g.addColorStop(0.7, 'rgba(255,255,255,0.15)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  }
  glowTextureSoftCache = new THREE.CanvasTexture(canvas);
  return glowTextureSoftCache;
}

/**
 * FINAL — tuned on app/alien-tuner.html. Durations are seconds; distances are
 * world units (the same units FIGURE_H = 1.27 is in); angles are degrees.
 */
export const ABDUCTION_DEFAULTS = {
  // ---- ship
  // Ship size and hover height are a joint constraint, not two free choices.
  // The whole composition — ship, a cone long enough to read, and the card on
  // the ground — only just fits the game's camera at 52° fov from 7.3 back.
  // Hover too low and the ship swallows the beam (under ~1.5 units of cone in
  // open air it shows two rings and stops looking like a beam at all); hover
  // too high and the ship leaves the top of frame. These two, camPitch and
  // camFollowDur were solved together against that framing — change one and
  // re-check the tuner's "visible cone" read-out.
  shipWidth: 4.9,        // the saucer is wide and flat; height follows from the art's aspect
  hoverHeight: 4.75,     // ship centre above the player's feet once settled
  // Entry and exit slants are ROLLED FRESH on every start(), independently,
  // uniformly in ±this many degrees off vertical (Luke, 2026-09-02). So the
  // ship can arrive from the left and leave to the right, or come almost
  // straight down — the event doesn't play out identically twice, which
  // matters for something a class will watch several times in a round.
  // 0 disables the randomness and drops both slants to dead vertical.
  angleRange: 40,
  entryDistance: 12,     // how far back along that angle it starts, i.e. how far off-frame
  descendDur: 2.6,
  hoverDur: 2.25,
  bobAmp: 0.03,          // gentle suspended-on-a-string drift, runs the whole time
  bobFreq: 0.45,

  // ---- beam
  beamWidth: 1.95,       // width of the cone's mouth at full extension
  beamTravel: 2.35,      // how far it slides down out of the ship
  beamGap: 0.18,         // clearance left between the cone's mouth and the card's head — "almost touch"
  beamDur: 1.6,
  beamHoldDur: 0.45,
  beamOpacity: 1,        // <1 switches the material to blended; see buildAbduction()
  beamClipNudge: 0,      // fine adjustment on the hide-line, in world units (+ = cut lower)

  // ---- card
  liftDur: 1.4,
  // How far the card rises during the lift. This is the "partially hidden
  // behind the beam" control, and it has a hard ceiling: the beam's cardboard
  // is opaque, so lifting the card level with the cone's mouth does not veil
  // it, it deletes it. At this value ~42% of the card still shows below the
  // mouth — head and shoulders drawn up into the cone, legs dangling clear.
  // Past about 1.25 the card vanishes outright; the tuner's read-out shows the
  // percentage so this stays a judgement rather than a guess.
  captureRise: 1.1,
  swayAmp: 7,            // degrees of roll once the beam has it
  swayFreq: 1.15,

  // ---- string
  // The puppet string. Its knot is landed on the loop already photographed at
  // the top of the ship so the two read as tied together; `stringDrop` is how
  // far below that loop's apex the knot's centre sits, i.e. how much they
  // overlap. Thickness is a multiplier on the width that matches the ship's
  // own loop strand exactly (see STRING_W_PER_SHIP_W) — 1 means "the same
  // rope", which is what the art wants.
  stringThickness: 1,
  stringDrop: 0.06,

  // ---- glow
  // The eerie green light — see the header comment for why this is the one
  // effect here allowed to glow. Two soft green marks, one flat on the
  // ground under the target's feet and one on the card's own face, so the
  // player reads as "marked" the instant the sequence begins rather than only
  // once the beam physically reaches them. Both share one timeline:
  //
  //   fades IN over glowFadeInDur, starting at t=0 — Luke, 2026-09-03: "the
  //   first visual indication that something is happening", i.e. before the
  //   ship has even cleared the top of frame.
  //
  //   fades OUT over glowFadeOutDur, starting the moment the LIFT phase
  //   begins — i.e. the instant the card starts to rise. Originally anchored
  //   to beam progress instead and just 0.35s long; Luke, 2026-09-04: "turns
  //   off too early and too suddenly" — tying it to the lift instead means it
  //   stays lit through the whole beam-hold beat (the card just standing
  //   there, marked, beam fully extended) and only lets go once something is
  //   actually happening to them.
  glowColor: 0x33ff66,
  glowFadeInDur: 0.35,
  glowFadeOutDur: 1.0,
  groundGlowRadius: 1.0,   // world units
  // Card mark only (see glowTextureSoft()'s own comment for why the ground
  // mark keeps its original texture and doesn't need either of these). Scale
  // is a large multiple of the card's own size on purpose: glowTextureSoft()
  // is a blurred blob with no hard edge, so most of what actually shows over
  // the card is its outer, faint reach — sizing it tight would just crop the
  // soft part off and leave the same bright core this exists to get rid of.
  cardGlowScale: 2.2,
  cardGlowOpacity: 0.5,    // weaker than the ground mark — Luke, 2026-09-04: "a bit weaker"

  // ---- exit
  ascendDur: 2.8,
  exitDistance: 16,
  // How much of the beam's own extension reels back up into the ship over
  // the course of the ascent — 0 leaves it fully extended (dangling below
  // the ship the whole way out, the original behaviour), 1 pulls it flush
  // to fully retracted. Luke, 2026-09-04: "have the beams, as well as the
  // character avatar behind them, retract into the ship... they don't have
  // to go all the way, but should be mostly hidden by the time the ship
  // leaves the screen." The card rides this same retraction (see apply()) so
  // it stays tucked at the same point inside the cone rather than drifting
  // relative to it — the two are meant to read as being reeled in together,
  // not as two separately-timed animations that happen to overlap.
  exitRetract: 0.85,

  // ---- camera
  camFollow: true,
  // Fraction of the WHOLE sequence at which the tilt begins — not of any one
  // phase. It has to be able to start during the descent: a ship big enough to
  // read, hovering high enough for the beam to show a full cone, does not fit
  // in the game's level-camera frame at all, so the tilt is what makes the
  // hover composition possible rather than just a flourish at the end.
  // Sharing the scrubber's 0..1 axis also makes it directly readable.
  // One slow ramp rather than two stages: starting early and running long, it
  // passes through ~8° by the time the beam is over the card (which is what
  // fits the hover composition in frame) and reaches full pitch during the
  // ascent (which is what follows the ship out). A single ramp that happens to
  // read as two beats beats two ramps that have to be kept in step.
  camFollowStart: 0.2,
  camFollowDur: 6.5,
  camPitch: 21,          // degrees the camera tilts up by
  // How far the camera dollies BACK as the saucer arrives, as a multiple of
  // its normal trailing distance (1 = no change). Tilting up alone swings the
  // player out of the bottom of frame long before the ship reaches the top of
  // it (Luke, 2026-09-02: "the camera moves up so far that the player can't be
  // seen"); backing off widens what one frame can hold, so the ship and the
  // player fit in it together.
  //
  // On its OWN clock, not the tilt's ramp, deliberately: sharing one ramp was
  // the first attempt and it makes the two asks contradictory — the tilt is
  // wanted later and gentler, the dolly wanted earlier, and one curve cannot
  // be both.
  //
  // camPullbackStart is an ABSOLUTE time, seconds from the very start of the
  // sequence (t=0 at the moment the ship begins its descent) — not an offset
  // from arrival, which is what this was before (Luke, 2026-09-03: that
  // offset's effect was too small to see, because ±a couple of seconds off an
  // 11s sequence barely reads, and it didn't reach the one place it actually
  // needed to: WHILE the ship is still coming down). An absolute time set
  // below descendDur (2.6) starts the zoom mid-descent — the default already
  // does this, well before the ship has settled.
  camPullback: 1.45,
  camPullbackDur: 4.0,
  camPullbackStart: 0.5,
};

/** Phase order and which default holds each one's duration. */
const PHASES = [
  { name: 'descend', dur: 'descendDur' },
  { name: 'hover', dur: 'hoverDur' },
  { name: 'beam', dur: 'beamDur' },
  { name: 'beamHold', dur: 'beamHoldDur' },
  { name: 'lift', dur: 'liftDur' },
  { name: 'ascend', dur: 'ascendDur' },
];

export function totalDuration(p) {
  return PHASES.reduce((sum, ph) => sum + p[ph.dur], 0);
}

/**
 * Splits an absolute time into `{ phase, u }` — which phase it lands in and how
 * far (0..1) through that phase it is. Past the end, returns the last phase at
 * u=1 so a finished sequence holds its final pose rather than snapping back.
 */
function phaseAt(p, time) {
  let t = time;
  for (const ph of PHASES) {
    const d = p[ph.dur];
    if (t < d || ph === PHASES[PHASES.length - 1]) {
      return { phase: ph.name, u: d > 0 ? THREE.MathUtils.clamp(t / d, 0, 1) : 1 };
    }
    t -= d;
  }
  return { phase: 'ascend', u: 1 };
}

// Ease-out for arrivals (the ship settling), ease-in for departures (the ship
// pulling away), smootherstep for things that both start and stop.
const easeOut = (u) => 1 - Math.pow(1 - u, 3);
const easeIn = (u) => u * u * u;
const smooth = (u) => u * u * u * (u * (u * 6 - 15) + 10);

/** Whether `phase` has already been passed, given the phase we're currently in. */
function phaseIndex(name) {
  return PHASES.findIndex((ph) => ph.name === name);
}

/**
 * Builds the rig and returns a controller.
 *
 * `textures` wants `{ ship, beams }` — already-loaded THREE.Textures, so the
 * caller keeps ownership of loading and can register them with whatever
 * LoadingManager it uses (skyPath.js gates character select on its manager;
 * the tuner page doesn't).
 *
 * The returned controller does NOT add itself to the scene's update loop or
 * touch the camera on its own — call `update(dt)` each frame and read
 * `cameraPitch` if you want the follow. That keeps the module honest about
 * side effects and makes it trivially testable from the tuner.
 */
export function buildAbduction({ scene, textures, params = {} }) {
  const p = { ...ABDUCTION_DEFAULTS, ...params };

  const rig = new THREE.Group();
  scene.add(rig);

  // Layering, front to back: ship, then beam, then the card. Small local +Z
  // offsets rather than renderOrder — with alphaTest (not blending) the depth
  // buffer sorts these correctly by itself, in any draw order, which is one
  // less thing to get wrong when the card is a separate object owned by the
  // caller and drawn whenever it happens to be drawn.
  const SHIP_Z = 0.3;
  const BEAM_Z = 0.15;
  // In front of the ship, so the knot reads as tied ON TO the loop rather than
  // disappearing behind it. Safe to put in front because the string art lives
  // entirely above the ship's cardboard edge — it crosses only the loop.
  const STRING_Z = 0.4;

  const shipH = p.shipWidth / SHIP_ASPECT;
  const ship = new THREE.Mesh(
    new THREE.PlaneGeometry(p.shipWidth, shipH),
    new THREE.MeshBasicMaterial({ map: textures.ship, transparent: true, alphaTest: 0.45, side: THREE.DoubleSide })
  );
  ship.position.z = SHIP_Z;
  ship.name = 'alien-ship';
  rig.add(ship);

  // The beam plane is sized so the CONE'S MOUTH is beamWidth, not so the whole
  // image is — the image is a cone inside a mostly-empty rectangle, and sizing
  // the rectangle would make the visible beam narrower than asked for by
  // however much margin the art happens to carry.
  const beamPlaneW = p.beamWidth / BEAM_MOUTH_W_FRAC;
  const beamPlaneH = beamPlaneW / BEAM_ASPECT;
  const beam = new THREE.Mesh(
    new THREE.PlaneGeometry(beamPlaneW, beamPlaneH),
    new THREE.MeshBasicMaterial({
      map: textures.beams,
      transparent: true,
      alphaTest: p.beamOpacity >= 1 ? 0.45 : 0,
      opacity: p.beamOpacity,
      depthWrite: p.beamOpacity >= 1,
      side: THREE.DoubleSide,
    })
  );
  beam.position.z = BEAM_Z;
  beam.name = 'alien-beam';
  beam.renderOrder = 1; // only consulted if beamOpacity < 1 turns off depthWrite
  rig.add(beam);

  // ---------------------------------------------------------------- string
  // Sized so its rope is exactly as thick as the loop on the ship, then
  // positioned by its KNOT rather than by its centre: the whole point is that
  // one specific feature of the art lands on one specific feature of another
  // image, and centring the plane would make that a coincidence to be
  // re-tuned by hand every time either size changed.
  const stringPlaneW = p.shipWidth * STRING_W_PER_SHIP_W * p.stringThickness;
  const stringPlaneH = stringPlaneW / STRING_ASPECT;
  const string = new THREE.Mesh(
    new THREE.PlaneGeometry(stringPlaneW, stringPlaneH),
    new THREE.MeshBasicMaterial({ map: textures.string, transparent: true, alphaTest: 0.45, side: THREE.DoubleSide })
  );
  string.position.set(
    // Where the loop's apex is, minus where the knot sits inside its own plane.
    SHIP_LOOP_X_FRAC * p.shipWidth - KNOT_X_FRAC * stringPlaneW,
    SHIP_LOOP_Y_FRAC * shipH - p.stringDrop - KNOT_Y_FRAC * stringPlaneH,
    STRING_Z
  );
  string.name = 'alien-string';
  // No shadow: a shadow-casting hair-thin plane produces shimmering dashes at
  // any practical shadow-map resolution, and a puppet string reads better
  // without one anyway.
  rig.add(string);

  // ---------------------------------------------------------------- eerie glow
  //
  // See the header comment: the one effect here that's allowed to glow. Two
  // marks, tinted green via `color` (not baked into either texture's pixels)
  // and sharing one timeline (see the fade maths in apply(), below), but
  // deliberately NOT sharing a texture — the ground mark wants a defined
  // spotlight edge, the card mark wants no defined edge at all (see
  // glowTextureSoft()'s comment). NOT children of `rig` — the ship bobs and
  // later flies off, but both marks are about the TARGET, not the ship, and
  // have finished fading out long before the ship would otherwise carry them
  // anywhere.
  //
  // Built here, in the scene, at throwaway placeholder sizes: start() moves
  // and resizes both once it actually knows where the target is standing and
  // how big their card is, and re-parents the card mark onto that card.
  const glowMatBase = {
    color: p.glowColor,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: false,
  };

  // Flat on the ground: rotated to lie in the XZ plane, facing up. A small +Y
  // lift keeps it off the actual deck surface — coplanar with it, a flat
  // decal like this z-fights unpredictably depending on camera angle.
  const groundGlow = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({ ...glowMatBase, map: glowTexture() })
  );
  groundGlow.rotation.x = -Math.PI / 2;
  groundGlow.renderOrder = 2;
  groundGlow.name = 'alien-glow-ground';
  scene.add(groundGlow);

  // On the card's own face: a hair in front of the character art (+Z, same
  // side the camera trails from — see SHIP_Z/BEAM_Z/STRING_Z above), sized
  // once start() supplies the card's real dimensions. Uses the blurred
  // texture, not the ground's — see glowTextureSoft()'s comment for why: a
  // sharp radial gradient here read as "a green spot on the player's
  // stomach" (Luke, 2026-09-04) however wide its falloff was made, because a
  // gradient still has a hard, bright centre. Real diffusion removes the
  // centre instead of just widening it.
  const cardGlow = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({ ...glowMatBase, map: glowTextureSoft() })
  );
  cardGlow.position.z = 0.02;
  cardGlow.renderOrder = 2;
  cardGlow.name = 'alien-glow-card';

  // ---------------------------------------------------------------- the hide-line
  //
  // A world-space horizontal clipping plane, applied to the beam material only.
  //
  // World-space is correct here despite the beam being a child of a rig that
  // yaws to face the camera: the cut is horizontal, and a horizontal plane is
  // invariant under rotation about Y. It would NOT be safe if the rig ever
  // pitched or rolled, which is why the rig is yaw-only (see facePoint below).
  //
  // Pinned to the SHIP, not the beam. The beam is the thing that moves; if the
  // cut travelled with it, the beam would carry its own hidden region downward
  // and expose its top the moment it started extending — which is precisely
  // the failure this exists to prevent.
  const clipPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 0);
  beam.material.clippingPlanes = [clipPlane];
  beam.material.clipShadows = true;

  /** Local Y the beam sits at when fully retracted, i.e. entirely up behind the ship. */
  const beamRetractedY = shipH / 2 - beamPlaneH * BEAM_ART_TOP_FRAC - 0.05;

  const state = {
    time: 0,
    playing: false,
    /** Extra pitch (radians) the caller should add to its camera; 0 until the follow starts. */
    cameraPitch: 0,
    /**
     * Multiplier the caller should apply to its camera's trailing distance;
     * 1 until the follow starts, easing to camPullback. Supplied as a number
     * to apply rather than a camera move, for the same reason as cameraPitch:
     * the game's own trailing camera stays the single thing placing the view.
     */
    cameraPull: 1,
    // The slants rolled for THIS run (see ABDUCTION_DEFAULTS.angleRange).
    // Exposed rather than kept private so a caller — the tuner, today — can
    // show what it got; judging a random range means seeing the rolls.
    entryAngle: 0,
    exitAngle: 0,
  };

  /** Where the rig should end up: directly over the target, at hover height. */
  const anchor = new THREE.Vector3();
  /** The target card, so the beam can stop just short of its head and the card can be lifted. */
  let card = null;
  let cardBaseX = 0;
  let cardBaseY = 0;
  let cardBaseZ = 0;
  let cardHalfH = 0;
  /**
   * How far the beam has to slide for its mouth to stop `beamGap` above the
   * card's head. Computed ONCE per start(), from the anchor rather than from
   * the rig's live position: the rig bobs, and recomputing this every frame
   * would hold the mouth at a fixed world height while the ship moved — i.e.
   * the beam would counter-bob against the ship it is supposedly bolted to.
   * A rigid prop travels with its puppet.
   */
  let beamTravel = 0;

  /**
   * A world offset `distance` away along a path tilted `angleDeg` off vertical,
   * where the tilt leans along the rig's own local +X.
   *
   * Computed from the rig's live yaw rather than baked into a world vector at
   * start(), because the rig yaws to face the camera: local +X is therefore
   * always screen-right, so the slant reads as an actual slant on screen from
   * any camera angle instead of foreshortening into the distance when the
   * bridge (and so the camera) happens to run east-west.
   */
  const offsetScratch = new THREE.Vector3();
  function tiltedOffset(distance, angleDeg, out = offsetScratch) {
    const a = THREE.MathUtils.degToRad(angleDeg);
    const yaw = rig.rotation.y;
    // The rig's local +X expressed in world space, for a yaw about Y.
    return out
      .set(Math.cos(yaw), 0, -Math.sin(yaw))
      .multiplyScalar(Math.sin(a) * distance)
      .setY(Math.cos(a) * distance);
  }

  /**
   * Aims the rig at a target. `at` is the player's feet position; `targetCard`
   * is their figure Object3D (optional — without one the beam simply extends to
   * its full travel and nothing is lifted, which is what the tuner shows before
   * a card is attached). `cardWidth` only matters for sizing the card's own
   * glow mark (see below) — everything else about the card is happy with just
   * its height.
   */
  function start({ at, targetCard = null, cardHeight = 0, cardWidth = 0, glowPreLit = false }) {
    state.glowPreLit = glowPreLit;
    anchor.set(at.x, at.y + p.hoverHeight, at.z);
    card = targetCard;
    cardHalfH = cardHeight / 2;
    cardBaseX = card ? card.position.x : 0;
    cardBaseY = card ? card.position.y : 0;
    cardBaseZ = card ? card.position.z : 0;

    // ---- eerie glow: placed and sized now, against the REAL target, not the
    // throwaway 1x1 planes buildAbduction() left them as.
    groundGlow.scale.setScalar(p.groundGlowRadius * 2);
    groundGlow.position.set(at.x, at.y + 0.02, at.z);
    if (card && cardWidth > 0 && cardHeight > 0) {
      cardGlow.scale.set(cardWidth * p.cardGlowScale, cardHeight * p.cardGlowScale, 1);
      card.add(cardGlow); // reparents if it was sitting under a previous target
      cardGlow.visible = true;
    } else {
      cardGlow.visible = false; // no card (or no size given, e.g. an old caller) — nothing to mark
    }

    // See beamTravel's declaration for why this is fixed here rather than
    // tracked per frame. Measured from the anchor, which is where the rig
    // actually is for the whole of the beam phase.
    if (card) {
      const mouthWhenRetracted =
        anchor.y + beamRetractedY - beamPlaneH * (BEAM_ART_BOTTOM_FRAC - 0.5);
      beamTravel = Math.max(0, mouthWhenRetracted - (cardBaseY + cardHalfH) - p.beamGap);
    } else {
      beamTravel = p.beamTravel;
    }

    // Rolled independently, so entry and exit are unrelated — the ship can
    // come in from one side and leave toward the other.
    const roll = () => (Math.random() * 2 - 1) * p.angleRange;
    state.entryAngle = roll();
    state.exitAngle = roll();

    state.time = 0;
    state.playing = true;
    state.cameraPitch = 0;
    state.cameraPull = 1;
    rig.visible = true;
    apply();
  }

  /**
   * Yaws the rig to face `point` (the camera). Yaw only — see the clip-plane
   * note above for why pitch/roll would break the hide-line.
   *
   * Measured from the ANCHOR, not from the rig's live position, and that is
   * load-bearing rather than a shortcut. tiltedOffset() derives the entry and
   * exit slants from this yaw, and the rig's position derives from those
   * slants — so facing from the live position closes a feedback loop: the
   * offset turns the rig, the turn rotates the offset, and the entry path
   * spirals away from the axis it was supposed to lean along. (Observed: an
   * 18° lean meant to read across the screen quietly migrated into depth
   * instead.) The anchor is fixed for the whole event, so reading the yaw from
   * it breaks the loop outright. The difference in where the ship actually
   * points is at most a degree or two at the extremes of the flight, on a flat
   * cut-out seen from tens of units away.
   */
  function facePoint(point) {
    rig.rotation.y = Math.atan2(point.x - anchor.x, point.z - anchor.z);
  }

  /** Positions everything for the current `state.time`. */
  function apply() {
    const { phase, u } = phaseAt(p, state.time);
    const idx = phaseIndex(phase);
    const past = (name) => idx > phaseIndex(name);

    // ---- rig position
    // Descending: in from off-frame along the entry slant, easing to a settle.
    // Ascending: out along the exit slant, easing in so it accelerates away.
    // Everything between sits at the anchor, bobbing.
    //
    // tiltedOffset() returns a shared scratch vector, so each result must be
    // consumed before the next call — it is, here and again for the card below.
    rig.position.copy(anchor);
    if (phase === 'descend') {
      rig.position.addScaledVector(tiltedOffset(p.entryDistance, state.entryAngle), 1 - easeOut(u));
    } else if (phase === 'ascend') {
      rig.position.addScaledVector(tiltedOffset(p.exitDistance, state.exitAngle), easeIn(u));
    }
    // The bob runs continuously off absolute time so it never restarts at a
    // phase boundary — a discontinuity there would read as a jolt exactly when
    // the ship is meant to be hanging still.
    rig.position.y += Math.sin(state.time * p.bobFreq * Math.PI * 2) * p.bobAmp;

    // ---- beam extension
    // `exitRetractDist` is the world-unit distance the beam has reeled back
    // up by, during the ascend phase specifically — 0 everywhere else. The
    // card block below adds this same distance to the card's own height, so
    // the two move together (see exitRetract's own comment).
    let beamU = 0;
    let exitRetractDist = 0;
    if (phase === 'beam') {
      beamU = smooth(u);
    } else if (phase === 'ascend') {
      const retract = smooth(u) * p.exitRetract;
      beamU = 1 - retract;
      exitRetractDist = beamTravel * retract;
    } else if (past('beam')) {
      beamU = 1;
    }

    beam.position.y = beamRetractedY - beamTravel * beamU;

    // ---- the hide-line, recomputed from the ship's live world position
    const cardboardTopY = rig.position.y + shipH / 2 - shipH * SHIP_CARDBOARD_TOP_FRAC;
    // Plane is (0,-1,0)·x + c = 0, keeping the half-space BELOW the line.
    clipPlane.constant = cardboardTopY + p.beamClipNudge;

    // ---- the card
    if (card) {
      let liftU = 0;
      if (phase === 'lift') liftU = smooth(u);
      else if (past('lift')) liftU = 1;

      // During the ascent the card rides the SAME slant vector as the rig, so
      // it stays inside the beam instead of trailing out of the bottom of it.
      card.position.y = cardBaseY + p.captureRise * liftU;
      card.position.x = cardBaseX;
      if (phase === 'ascend') {
        const exit = tiltedOffset(p.exitDistance, state.exitAngle);
        const e = easeIn(u);
        card.position.x += exit.x * e;
        // + exitRetractDist: rides UP by the same amount the beam has just
        // reeled in by, so the card stays put relative to the cone's mouth
        // instead of being left behind as the mouth rises past it.
        card.position.y += exit.y * e + exitRetractDist;
        card.position.z = cardBaseZ + exit.z * e;
      } else {
        card.position.z = cardBaseZ;
      }

      // Sway ramps in with the lift and persists through the exit.
      const swayAmount = liftU;
      card.rotation.z = THREE.MathUtils.degToRad(p.swayAmp) * swayAmount *
        Math.sin(state.time * p.swayFreq * Math.PI * 2);
    }

    // ---- eerie glow
    // In: a fixed, near-instant ramp from t=0 — the first thing to happen in
    // the whole sequence, on purpose (see the header comment).
    // glowPreLit: the target already has buildWaitingGlow()'s identical mark
    // on them (they waited out the defence with it lit) — start at full so
    // the hand-off from that glow to this one is invisible, not a dip.
    const glowIn = state.glowPreLit
      ? 1
      : smooth(THREE.MathUtils.clamp(state.time / Math.max(1e-6, p.glowFadeInDur), 0, 1));
    // Out: anchored to the START OF THE LIFT PHASE — the instant the card
    // begins to rise — not a fixed time or a fraction of the beam's own
    // extension (both tried first; see ABDUCTION_DEFAULTS' own comment for
    // why neither held up). liftStart is the sum of every phase before it,
    // computed fresh rather than cached since retiming any earlier phase has
    // to move this point with it.
    const liftStart = PHASES.slice(0, phaseIndex('lift')).reduce((s, ph) => s + p[ph.dur], 0);
    const glowOut = 1 - smooth(THREE.MathUtils.clamp((state.time - liftStart) / Math.max(1e-6, p.glowFadeOutDur), 0, 1));
    const glowOpacity = glowIn * glowOut;
    groundGlow.material.opacity = glowOpacity;
    cardGlow.material.opacity = glowOpacity * p.cardGlowOpacity;

    // ---- camera follow
    if (p.camFollow) {
      const followStart = totalDuration(p) * p.camFollowStart;
      const fu = THREE.MathUtils.clamp((state.time - followStart) / Math.max(1e-6, p.camFollowDur), 0, 1);
      state.cameraPitch = THREE.MathUtils.degToRad(p.camPitch) * smooth(fu);
      // Its own clock, an absolute time from t=0 — see camPullbackStart.
      const pu = THREE.MathUtils.clamp(
        (state.time - p.camPullbackStart) / Math.max(1e-6, p.camPullbackDur), 0, 1
      );
      state.cameraPull = 1 + (p.camPullback - 1) * smooth(pu);
    } else {
      state.cameraPitch = 0;
      state.cameraPull = 1;
    }
  }

  function update(dt) {
    if (state.playing) {
      state.time += dt;
      if (state.time >= totalDuration(p)) {
        state.time = totalDuration(p);
        state.playing = false;
      }
    }
    apply();
  }

  /** Jumps to an absolute time without playing — the tuner's scrubber. */
  function seek(time) {
    state.time = THREE.MathUtils.clamp(time, 0, totalDuration(p));
    apply();
  }

  function dispose() {
    scene.remove(rig);
    for (const m of [ship, beam, string]) {
      m.geometry.dispose();
      m.material.dispose();
    }
    // groundGlow lives directly in `scene`; cardGlow lives wherever the last
    // start() parented it (a caller's card, or nowhere at all if start() was
    // never called with one) — `parent?.remove` covers both without caring
    // which. Materials are per-instance (see glowMat()); the texture they
    // share is cached at module scope and outlives every instance, so it is
    // deliberately NOT disposed here.
    for (const m of [groundGlow, cardGlow]) {
      m.parent?.remove(m);
      m.geometry.dispose();
      m.material.dispose();
    }
  }

  return {
    rig,
    ship,
    beam,
    string,
    groundGlow,
    cardGlow,
    params: p,
    state,
    /**
     * Derived sizes the caller would otherwise have to recompute from the art
     * constants and keep in step by hand. Read-only, and refreshed by start()
     * — `beamTravel` in particular is only known once there is a card to reach.
     */
    get metrics() {
      return {
        shipH,
        beamPlaneW,
        beamPlaneH,
        beamRetractedY,
        /** How far the beam actually slides for this target. */
        beamTravel,
        /** Local Y of the ship's cardboard top edge — where the beam is cut. */
        cardboardTopLocal: shipH / 2 - shipH * SHIP_CARDBOARD_TOP_FRAC,
        /** Local Y of the beam's own top edge when retracted, for comparison. */
        beamTopLocal: beamRetractedY + beamPlaneH / 2,
        stringPlaneW,
        stringPlaneH,
        /** The two features that have to coincide — each relative to its OWN mesh's origin. */
        loopApexLocalX: SHIP_LOOP_X_FRAC * p.shipWidth,
        loopApexLocalY: SHIP_LOOP_Y_FRAC * shipH,
        knotLocalX: KNOT_X_FRAC * stringPlaneW,
        knotLocalY: KNOT_Y_FRAC * stringPlaneH,
        knotHeight: (STRING_ART.knotH / STRING_ART.height) * stringPlaneH,
      };
    },
    start,
    update,
    seek,
    apply,
    facePoint,
    dispose,
    get duration() {
      return totalDuration(p);
    },
  };
}

/**
 * The same two green marks buildAbduction() lights at t=0, on their own,
 * with no ship — Luke, 2026-09-23: "while this new introduction message is
 * being displayed, show the green light that currently begins the abduction
 * sequence. This light will stay on until the player is actually abducted
 * ... or until the aliens are repelled." A queued defender can sit under it
 * for a long time (waiting for their guide), so it's its own object rather
 * than a paused abduction. On abduction, dispose this and start the real
 * sequence with `glowPreLit: true` so the light never dips; on a resist,
 * `release()` fades it out and `update()` reports when it's done.
 */
export function buildWaitingGlow({ scene, at, card = null, cardHeight = 0, cardWidth = 0, params = {} }) {
  const p = { ...ABDUCTION_DEFAULTS, ...params };
  const matBase = {
    color: p.glowColor,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: false,
  };
  const groundGlow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ ...matBase, map: glowTexture() }));
  groundGlow.rotation.x = -Math.PI / 2;
  groundGlow.renderOrder = 2;
  groundGlow.scale.setScalar(p.groundGlowRadius * 2);
  groundGlow.position.set(at.x, at.y + 0.02, at.z);
  scene.add(groundGlow);

  const cardGlow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ ...matBase, map: glowTextureSoft() }));
  cardGlow.position.z = 0.02;
  cardGlow.renderOrder = 2;
  if (card && cardWidth > 0 && cardHeight > 0) {
    cardGlow.scale.set(cardWidth * p.cardGlowScale, cardHeight * p.cardGlowScale, 1);
    card.add(cardGlow);
  }

  let level = 0; // 0..1, before easing
  let releasing = false;

  /** Advances the fade; returns false once a released glow has fully faded (caller should dispose). */
  function update(dt) {
    if (releasing) level = Math.max(0, level - dt / Math.max(1e-6, p.glowFadeOutDur));
    else level = Math.min(1, level + dt / Math.max(1e-6, p.glowFadeInDur));
    const o = smooth(level);
    groundGlow.material.opacity = o;
    cardGlow.material.opacity = o * p.cardGlowOpacity;
    return !(releasing && level === 0);
  }

  function dispose() {
    for (const m of [groundGlow, cardGlow]) {
      m.parent?.remove(m);
      m.geometry.dispose();
      m.material.dispose();
    }
  }

  return {
    update,
    release: () => {
      releasing = true;
    },
    dispose,
  };
}

/**
 * A short "the ship makes a run at them, then gets blown away" beat for a
 * successful resist — Luke, 2026-09-23: "after the cardboard UI goes back
 * up, I want the ship to be lowered quickly towards player and then blown
 * away with the repulsion wave." Two phases, no beam/string/card (a resist
 * never reaches the real abduction's beam stage): a fast descend to just
 * above the player, then a knockback straight up — the resist wave (see
 * resistWave.js) travels dead vertical by design, so the ship is flung the
 * same way, along it, tumbling and shrinking as it recedes rather than
 * arcing off to a side the wave never touched.
 *
 * Its own tiny state machine rather than reusing buildAbduction()'s
 * PHASES/phaseAt: that machine is built around the beam/card choreography
 * this doesn't have, and bending it to skip straight to a two-beat
 * descend-then-blow would be more contortion than the two easing lines
 * this needs on its own.
 */
export const REPEL_SHIP_DEFAULTS = {
  shipWidth: ABDUCTION_DEFAULTS.shipWidth / 2, // "make the ship half as big" — Luke, 2026-09-23
  hoverHeight: 3.2, // above the player's feet — lower than a real abduction's hover; this is a quick tease, not the full descent
  descendDistance: 7, // world units above the hover point it starts from
  descendDur: 0.7, // "lower down at half the speed" — Luke, 2026-09-23; was 0.35 (double the duration over the same descendDistance)
  blowDistance: 14, // world units it's flung upward before dispose()
  blowDur: 0.85,
  spin: 720, // degrees of roll over the whole knockback
  bobAmp: 0.04, // same suspended-on-a-string drift as the real abduction, while it hovers
  bobFreq: 0.6,
};

export function buildRepelledShip({ scene, textures, params = {} }) {
  const p = { ...REPEL_SHIP_DEFAULTS, ...params };
  const shipH = p.shipWidth / SHIP_ASPECT;
  const ship = new THREE.Mesh(
    new THREE.PlaneGeometry(p.shipWidth, shipH),
    new THREE.MeshBasicMaterial({ map: textures.ship, transparent: true, alphaTest: 0.45, side: THREE.DoubleSide })
  );
  ship.visible = false;
  scene.add(ship);

  const anchor = new THREE.Vector3();
  let phase = 'idle'; // 'descend' | 'blow' | 'idle'
  let t = 0;

  function start(at) {
    anchor.set(at.x, at.y + p.hoverHeight, at.z);
    ship.position.set(anchor.x, anchor.y + p.descendDistance, anchor.z);
    ship.rotation.z = 0;
    ship.scale.setScalar(1);
    ship.material.opacity = 1;
    ship.visible = true;
    phase = 'descend';
    t = 0;
  }

  /** Yaws to face `point` (the camera) — same billboard-toward-viewer idea as buildAbduction()'s facePoint, yaw only. */
  function facePoint(point) {
    ship.rotation.y = Math.atan2(point.x - ship.position.x, point.z - ship.position.z);
  }

  function update(dt) {
    if (phase === 'idle') return;
    t += dt;
    if (phase === 'descend') {
      const u = Math.min(1, t / p.descendDur);
      ship.position.y = anchor.y + p.descendDistance * (1 - easeOut(u));
      ship.position.y += Math.sin(t * p.bobFreq * Math.PI * 2) * p.bobAmp;
      if (u >= 1) {
        phase = 'blow';
        t = 0;
      }
    } else if (phase === 'blow') {
      const u = Math.min(1, t / p.blowDur);
      const e = easeIn(u);
      ship.position.y = anchor.y + p.blowDistance * e;
      ship.rotation.z = THREE.MathUtils.degToRad(p.spin) * e;
      ship.scale.setScalar(1 - 0.5 * e);
      ship.material.opacity = 1 - Math.max(0, (u - 0.6) / 0.4); // holds fully opaque, then fades over the last 40%
      if (u >= 1) {
        phase = 'idle';
        ship.visible = false;
      }
    }
  }

  function dispose() {
    scene.remove(ship);
    ship.geometry.dispose();
    ship.material.dispose();
  }

  return {
    start,
    update,
    facePoint,
    dispose,
    ship,
    get playing() {
      return phase !== 'idle';
    },
    get phase() {
      return phase;
    },
  };
}
