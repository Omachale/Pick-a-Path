/**
 * Luke, 2026-09-21: best-effort fullscreen on phones. The real Fullscreen
 * API only works on Android Chrome from an ordinary tab — iOS Safari
 * doesn't support it there at all (only via a home-screen shortcut; see
 * manifest.webmanifest's own header for that half of the story), and
 * silently no-ops rather than erroring, so this is safe to always attempt.
 *
 * Attached once, globally, to whichever element the player first taps.
 * There's no single "start" button shared by every entry point (lobby,
 * the `?solo=1`/`?debugKeyboard=1` dev routes, the teacher dashboard), and
 * the Fullscreen API requires a genuine user gesture, so listening at the
 * document level for the very first tap is the one place guaranteed to
 * catch it regardless of which screen loads first.
 */
export function armBestEffortFullscreen() {
  document.addEventListener(
    'pointerdown',
    () => {
      document.documentElement.requestFullscreen?.().catch(() => {});
    },
    { once: true },
  );
}
