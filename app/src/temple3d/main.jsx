/**
 * TEMPLE 3D TEST (2026-10-06): entry for temple-3d.html. Sky Path in solo
 * mode, as `?solo=1&role=player` would mount it, but running the test copy
 * (skyPathTemple3d.js) with the 3D temple and starting on the last island.
 * Nothing in the real game imports anything from src/temple3d/.
 */
import { createRoot } from 'react-dom/client';
import SkyPath from './SkyPathTemple3d.jsx';
import '../styles.css';

const params = new URLSearchParams(location.search);

createRoot(document.getElementById('root')).render(
  <div style={{ position: 'fixed', inset: 0 }}>
    <SkyPath
      role={params.get('role') === 'guide' ? 'guide' : 'player'}
      forks={params.get('forks')}
      onRoundEnd={(result) => console.log('[round end]', result)}
    />
  </div>,
);
