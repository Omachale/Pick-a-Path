import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
// import OrientationGuard from './OrientationGuard.jsx'; // see below
// import { armBestEffortFullscreen } from './fullscreen.js'; // see below
import './styles.css';

// DISABLED 2026-09-24 — Luke: playtesting means constantly switching tabs,
// and fullscreen makes that a chore (have to exit fullscreen every time).
// See TODO.md's "Fullscreen — disabled for playtesting" entry to re-enable;
// it's a two-line uncomment (this and the import above), nothing else changed.
// armBestEffortFullscreen();

createRoot(document.getElementById('root')).render(
  <StrictMode>
    {/* DISABLED 2026-09-25 — Luke: the "Rotate your device" prompt (shown
        in portrait) was getting in the way of checking things on a normal
        desktop browser window while playtesting. See TODO.md's
        "Orientation guard — disabled for playtesting" entry to re-enable;
        it's this wrapper plus the import above, nothing else changed. */}
    {/* <OrientationGuard> */}
    <App />
    {/* </OrientationGuard> */}
  </StrictMode>,
);
