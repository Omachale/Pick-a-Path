/**
 * The end-of-series victory scene: the model town (modelTown/victoryTown.js)
 * full screen. On the teacher's board, over the lobby, with a way back
 * (`onClose`); on the projector too (Luke: the victory screen "will
 * absolutely be on the projector"), with no button. Phones just say "look at
 * the big screen".
 */
import { useEffect, useRef } from 'react';
import { mountVictoryTown } from '../modelTown/victoryTown.js';

export default function VictoryTown({ teams, onClose }) {
  const hostRef = useRef(null);
  useEffect(() => {
    const town = mountVictoryTown(hostRef.current, { teams });
    return () => town.dispose();
  }, [teams]);
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 20, background: '#1d1712' }}>
      <div ref={hostRef} style={{ position: 'absolute', inset: 0 }} />
      {onClose && <button
        onClick={onClose}
        style={{
          position: 'absolute',
          right: 12,
          bottom: 12,
          zIndex: 2,
          padding: '8px 16px',
          border: 0,
          borderRadius: 6,
          background: 'rgba(20,14,8,0.75)',
          color: '#f3e6cf',
          font: '600 14px system-ui, sans-serif',
          cursor: 'pointer',
        }}
      >
        Back to lobby
      </button>}
    </div>
  );
}
