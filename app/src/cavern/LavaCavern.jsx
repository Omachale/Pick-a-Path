/**
 * React's entire share of the Lava Cavern spike — a sized div, a mount, and a
 * dispose. Same split as SkyPath.jsx: everything inside the surface is owned
 * by the imperative module, because the HUD updates from the animation loop
 * and routing 60fps through React would buy nothing.
 */
import { useEffect, useRef } from 'react';
import { mountLavaCavern } from './lavaCavern.js';

export default function LavaCavern({ spokes = 4 }) {
  const containerRef = useRef(null);

  useEffect(() => {
    const handle = mountLavaCavern(containerRef.current, { spokes });
    return () => handle.dispose();
  }, [spokes]);

  return <div ref={containerRef} style={{ width: '100%', height: '100%' }} />;
}
