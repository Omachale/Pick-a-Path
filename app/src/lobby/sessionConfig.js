/**
 * Settings shared by the teacher's lobby board and the player side.
 */

/**
 * Teacher sign-in. OFF for now (Luke, 2026-10-05: "If we turn off the
 * sign-in for now, it will be easy enough to reinstate later? ... don't
 * delete any of the related code, just disable it").
 *
 * While off: creating a game writes NOTHING to Supabase. A join code just
 * names the realtime channel (`lobby-CODE`), so no SQL migration was needed.
 * The cost: a typed code can't be checked against the `sessions` table, so
 * JoinByCode.jsx accepts any well-formed code (a mistyped one lands in an
 * empty room).
 *
 * To reinstate: set this true, then have the board create its game through
 * TeacherDashboard.jsx's startSession() path (sign-in via its AuthForm, then
 * the `classes` + `sessions` inserts). All of that code is still there,
 * untouched; see TODO.md, "Plan 2026-10-05".
 */
export const TEACHER_SIGN_IN = false;

/**
 * The most players one game takes. Luke, 2026-10-05: equal to the dials'
 * largest setting (4 teams x 6), so there is always a dial setting that
 * places everyone, and Start can insist that nobody is left in Unassigned.
 * A 25th player is told the game is full.
 */
export const PLAYER_CAP = 24;

/** The published game, which students' phones load from a QR code. */
export const PUBLIC_URL = 'https://omachale.github.io/Pick-a-Path/';

/**
 * The link a QR code carries.
 * - Published (GitHub Pages, or any real host): the page's own address.
 * - Local development opened as `localhost`: that address means nothing to a
 *   phone, so this computer's network address is used instead, found by the
 *   dev server (vite.config.js's lanAddress), so phones load THIS local build.
 *   Luke, 2026-10-05, testing on his phone: it "is sending me to the Github
 *   address", which doesn't have the newest screens until a push. Falls back
 *   to the Pages address if the computer has no network address.
 */
export function joinUrl(code) {
  const local = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  let base = `${location.origin}${location.pathname}`;
  if (local) {
    // eslint-disable-next-line no-undef
    const lan = import.meta.env.DEV ? __DEV_LAN_HOST__ : null;
    base = lan ? `${location.protocol}//${lan}:${location.port}${location.pathname}` : PUBLIC_URL;
  }
  return `${base}?join=${code}`;
}

/** The colour a player's name shows in until they pick one: the game's own fallback (skyPath.js). */
export const DEFAULT_PLAYER_COLOUR = 0xffe9b8;
