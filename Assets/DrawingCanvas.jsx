/**
 * Standalone drawing surface for the drawing/guessing game.
 *
 * Deliberately has ZERO knowledge of Sky Path, the lobby, rounds, or
 * Supabase. It captures strokes/shapes and renders them — nothing else.
 * Safe to build and iterate on now; wire into the real multiplayer flow
 * later once useLobby.js / GameRoom.jsx have been reviewed.
 *
 * DATA FORMAT (the thing that will eventually travel over the wire):
 *
 *   Freehand (pen or eraser):
 *     { id, tool: 'pen' | 'eraser', color, width,
 *       points: [{ x: number, y: number }] }   // 0..1 normalised
 *
 *   Shapes (line / circle / square):
 *     { id, tool: 'line' | 'circle' | 'square', color, width,
 *       start: { x: number, y: number },       // 0..1 normalised
 *       end:   { x: number, y: number } }
 *
 * All coordinates are normalised (0-1), not raw pixels, so a mark made on
 * one phone's canvas renders correctly on another phone with a different
 * screen size/resolution. This is a vector format, not raster (image
 * snapshots): far smaller payloads, resizes cleanly.
 *
 * "square" covers a drag-to-size rectangle (start corner -> opposite
 * corner), not a four-independently-draggable-corner quadrilateral. A true
 * irregular quadrilateral would need separate corner handles; flagged here
 * as a deliberate scope decision rather than an oversight.
 *
 * Eraser reuses the freehand stroke mechanic with a destination-out canvas
 * composite operation, so it "cuts" existing marks rather than painting
 * background-coloured strokes over them (matters once the canvas can be
 * exported/shared, since it stays transparent where erased).
 *
 * EXTENSION POINTS (kept deliberately open, not built yet):
 *   - `onStrokeStart` / `onStrokeUpdate` / `onStrokeEnd` callbacks: fire as
 *     a mark is drawn, so a future real-time layer can broadcast
 *     in-progress marks rather than waiting for completion.
 *   - `words` prop: defaults to the prototype list, but accepts any array
 *     so a teacher-entered list can be dropped in later.
 *   - `swatches` prop: override the default colour palette.
 *
 * FILL TOOL — a different kind of item, worth understanding:
 * Bucket fill is a pixel-level flood fill, not a vector shape like the
 * others. It's stored as { id, tool: 'fill', color, point } (point
 * normalised, like everything else) and replayed by reading the canvas's
 * *already-rendered* pixels at that point and flood-filling outward — it
 * depends on whatever was drawn before it, same as a real paint program.
 * That's consistent with how this component already redraws all items in
 * order on every change, so it works without restructuring anything.
 *
 * The one real tradeoff: fill resolves against rendered pixels, so it is
 * NOT resolution-independent the way pen/shape strokes are. Two devices
 * with different canvas pixel sizes could rasterise a boundary line
 * slightly differently and get a fill that leaks past it on one but not
 * the other. Invisible for local/solo use; worth revisiting only once
 * this is actually synced across devices with mismatched canvas sizes.
 */
import { useRef, useState, useCallback, useEffect } from 'react';

const DEFAULT_WORDS = ['House', 'Car', 'TV', 'Phone'];
const DEFAULT_SWATCHES = ['#1a1a1a', '#e03131', '#2f9e44', '#1971c2', '#f08c00', '#ffffff'];
const DEFAULT_WIDTH = 6;
const MIN_WIDTH = 2;
const MAX_WIDTH = 24;

const TOOLS = {
  PEN: 'pen',
  ERASER: 'eraser',
  LINE: 'line',
  CIRCLE: 'circle',
  SQUARE: 'square',
  FILL: 'fill',
};

const FILL_TOLERANCE = 32; // per-channel colour distance treated as "same colour"

const FREEHAND_TOOLS = new Set([TOOLS.PEN, TOOLS.ERASER]);
const SHAPE_TOOLS = new Set([TOOLS.LINE, TOOLS.CIRCLE, TOOLS.SQUARE]);

function makeId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// Convert a pointer event to normalised (0-1) coords relative to the canvas.
function toNormalisedPoint(evt, canvasEl) {
  const rect = canvasEl.getBoundingClientRect();
  return {
    x: (evt.clientX - rect.left) / rect.width,
    y: (evt.clientY - rect.top) / rect.height,
  };
}

function applyStrokeStyle(ctx, item) {
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = item.width;
  if (item.tool === TOOLS.ERASER) {
    ctx.globalCompositeOperation = 'destination-out';
    ctx.strokeStyle = 'rgba(0,0,0,1)'; // colour irrelevant in destination-out
  } else {
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = item.color;
  }
}

function hexToRgb(hex) {
  const clean = hex.replace('#', '');
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
  const num = parseInt(full, 16);
  return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
}

// Stack-based flood fill directly on the canvas's device pixels. Reads
// whatever is already rendered (see FILL TOOL note above) and fills
// contiguous same-colour pixels outward from the tapped point.
function floodFill(ctx, devicePx, devicePy, deviceWidth, deviceHeight, fillColor) {
  if (
    devicePx < 0 || devicePy < 0 ||
    devicePx >= deviceWidth || devicePy >= deviceHeight
  ) {
    return;
  }

  const imageData = ctx.getImageData(0, 0, deviceWidth, deviceHeight);
  const data = imageData.data;
  const { r: fr, g: fg, b: fb } = hexToRgb(fillColor);

  const startIdx = (devicePy * deviceWidth + devicePx) * 4;
  const startR = data[startIdx];
  const startG = data[startIdx + 1];
  const startB = data[startIdx + 2];
  const startA = data[startIdx + 3];

  // Already the target colour — nothing to do (also guards against
  // re-filling an already-filled area every render).
  if (
    Math.abs(startR - fr) < 2 &&
    Math.abs(startG - fg) < 2 &&
    Math.abs(startB - fb) < 2 &&
    startA === 255
  ) {
    return;
  }

  const matches = (idx) => {
    const dr = data[idx] - startR;
    const dg = data[idx + 1] - startG;
    const db = data[idx + 2] - startB;
    const da = data[idx + 3] - startA;
    return Math.sqrt(dr * dr + dg * dg + db * db + da * da) <= FILL_TOLERANCE;
  };

  const setColor = (idx) => {
    data[idx] = fr;
    data[idx + 1] = fg;
    data[idx + 2] = fb;
    data[idx + 3] = 255;
  };

  const stack = [[devicePx, devicePy]];
  const visited = new Uint8Array(deviceWidth * deviceHeight);

  while (stack.length > 0) {
    const [x, y] = stack.pop();
    if (x < 0 || y < 0 || x >= deviceWidth || y >= deviceHeight) continue;
    const pixelPos = y * deviceWidth + x;
    if (visited[pixelPos]) continue;
    const idx = pixelPos * 4;
    if (!matches(idx)) continue;

    visited[pixelPos] = 1;
    setColor(idx);

    stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
  }

  ctx.putImageData(imageData, 0, 0);
}

function drawItem(ctx, item, width, height, devicePixelRatio) {
  if (item.tool === TOOLS.FILL) {
    const deviceWidth = Math.round(width * devicePixelRatio);
    const deviceHeight = Math.round(height * devicePixelRatio);
    const devicePx = Math.round(item.point.x * deviceWidth);
    const devicePy = Math.round(item.point.y * deviceHeight);
    floodFill(ctx, devicePx, devicePy, deviceWidth, deviceHeight, item.color);
    return;
  }

  applyStrokeStyle(ctx, item);

  if (FREEHAND_TOOLS.has(item.tool)) {
    if (item.points.length === 0) return;
    ctx.beginPath();
    const [first, ...rest] = item.points;
    ctx.moveTo(first.x * width, first.y * height);
    for (const p of rest) ctx.lineTo(p.x * width, p.y * height);
    ctx.stroke();
    return;
  }

  // Shapes: nothing to draw until there's both a start and an end point.
  if (!item.start || !item.end) return;
  const sx = item.start.x * width;
  const sy = item.start.y * height;
  const ex = item.end.x * width;
  const ey = item.end.y * height;

  if (item.tool === TOOLS.LINE) {
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(ex, ey);
    ctx.stroke();
  } else if (item.tool === TOOLS.CIRCLE) {
    // Bounding box from start->end, drawn as an ellipse inscribed in it —
    // reads as "drag a circle" the way people expect, even off-diagonal.
    const cx = (sx + ex) / 2;
    const cy = (sy + ey) / 2;
    const rx = Math.abs(ex - sx) / 2;
    const ry = Math.abs(ey - sy) / 2;
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.stroke();
  } else if (item.tool === TOOLS.SQUARE) {
    ctx.strokeRect(sx, sy, ex - sx, ey - sy);
  }
}

export default function DrawingCanvas({
  words = DEFAULT_WORDS,
  swatches = DEFAULT_SWATCHES,
  onStrokeStart,
  onStrokeUpdate,
  onStrokeEnd,
}) {
  const canvasRef = useRef(null);
  const containerRef = useRef(null);
  const [items, setItems] = useState([]);
  const [current, setCurrent] = useState(null);
  const [tool, setTool] = useState(TOOLS.PEN);
  const [color, setColor] = useState(swatches[0]);
  const [brushWidth, setBrushWidth] = useState(DEFAULT_WIDTH);
  const [prompt, setPrompt] = useState(() => words[Math.floor(Math.random() * words.length)]);
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const el = containerRef.current;
    const canvas = canvasRef.current;
    if (!el || !canvas) return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      const { width, height } = entry.contentRect;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      setCanvasSize({ width, height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || canvasSize.width === 0) return;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    ctx.clearRect(0, 0, canvasSize.width, canvasSize.height);
    for (const item of items) drawItem(ctx, item, canvasSize.width, canvasSize.height, dpr);
    if (current) drawItem(ctx, current, canvasSize.width, canvasSize.height, dpr);
  }, [items, current, canvasSize]);

  const handlePointerDown = useCallback(
    (evt) => {
      evt.preventDefault();
      const canvas = canvasRef.current;
      canvas.setPointerCapture(evt.pointerId);
      const point = toNormalisedPoint(evt, canvas);

      if (tool === TOOLS.FILL) {
        // Fill applies immediately on tap — no drag, no "current" preview
        // state, straight into the completed items list.
        const fillItem = { id: makeId(), tool: TOOLS.FILL, color, point };
        setItems((prev) => [...prev, fillItem]);
        onStrokeStart?.(fillItem);
        onStrokeEnd?.(fillItem);
        return;
      }

      const base = { id: makeId(), tool, color, width: brushWidth };
      const next = FREEHAND_TOOLS.has(tool)
        ? { ...base, points: [point] }
        : { ...base, start: point, end: point };

      setCurrent(next);
      onStrokeStart?.(next);
    },
    [tool, color, brushWidth, onStrokeStart, onStrokeEnd],
  );

  const handlePointerMove = useCallback(
    (evt) => {
      if (!current) return;
      evt.preventDefault();
      const canvas = canvasRef.current;
      const point = toNormalisedPoint(evt, canvas);

      setCurrent((prev) => {
        const updated = FREEHAND_TOOLS.has(prev.tool)
          ? { ...prev, points: [...prev.points, point] }
          : { ...prev, end: point };
        onStrokeUpdate?.(updated);
        return updated;
      });
    },
    [current, onStrokeUpdate],
  );

  const handlePointerUp = useCallback(
    (evt) => {
      if (!current) return;
      evt.preventDefault();
      setItems((prev) => [...prev, current]);
      onStrokeEnd?.(current);
      setCurrent(null);
    },
    [current, onStrokeEnd],
  );

  const handleUndo = useCallback(() => setItems((prev) => prev.slice(0, -1)), []);
  const handleClear = useCallback(() => setItems([]), []);
  const handleNewWord = useCallback(() => {
    setPrompt(words[Math.floor(Math.random() * words.length)]);
    setItems([]);
  }, [words]);

  const toolButton = (value, label) => (
    <button
      style={{ ...styles.toolButton, ...(tool === value ? styles.toolButtonActive : {}) }}
      onClick={() => setTool(value)}
    >
      {label}
    </button>
  );

  return (
    <div style={styles.wrapper}>
      <div style={styles.promptBar}>
        <span style={styles.promptLabel}>Draw:</span>
        <span style={styles.promptWord}>{prompt}</span>
      </div>

      <div ref={containerRef} style={styles.canvasContainer}>
        <canvas
          ref={canvasRef}
          style={styles.canvas}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
        />
      </div>

      <div style={styles.toolRow}>
        {toolButton(TOOLS.PEN, 'Pen')}
        {toolButton(TOOLS.ERASER, 'Eraser')}
        {toolButton(TOOLS.LINE, 'Line')}
        {toolButton(TOOLS.CIRCLE, 'Circle')}
        {toolButton(TOOLS.SQUARE, 'Square')}
        {toolButton(TOOLS.FILL, 'Fill')}
      </div>

      <div style={styles.paletteRow}>
        {swatches.map((sw) => (
          <button
            key={sw}
            onClick={() => setColor(sw)}
            style={{
              ...styles.swatch,
              background: sw,
              ...(color === sw && tool !== TOOLS.ERASER ? styles.swatchActive : {}),
              ...(sw === '#ffffff' ? styles.swatchBorder : {}),
            }}
            aria-label={`colour ${sw}`}
          />
        ))}
      </div>

      <div style={styles.toolbar}>
        <label style={styles.brushLabel}>
          Width
          <input
            type="range"
            min={MIN_WIDTH}
            max={MAX_WIDTH}
            value={brushWidth}
            onChange={(e) => setBrushWidth(Number(e.target.value))}
            style={styles.slider}
          />
        </label>
        <button style={styles.button} onClick={handleUndo} disabled={items.length === 0}>
          Undo
        </button>
        <button style={styles.button} onClick={handleClear} disabled={items.length === 0}>
          Clear
        </button>
        <button style={{ ...styles.button, ...styles.newWordButton }} onClick={handleNewWord}>
          New word
        </button>
      </div>
    </div>
  );
}

const styles = {
  wrapper: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    width: '100%',
    background: '#f2ede3',
    fontFamily: 'system-ui, sans-serif',
  },
  promptBar: {
    display: 'flex',
    alignItems: 'baseline',
    gap: 8,
    padding: '10px 16px',
    background: '#fff',
    borderBottom: '1px solid #ddd6c8',
  },
  promptLabel: { fontSize: 13, color: '#8a8272', textTransform: 'uppercase', letterSpacing: 0.5 },
  promptWord: { fontSize: 20, fontWeight: 700, color: '#1a1a1a' },
  canvasContainer: {
    flex: 1,
    minHeight: 0,
    touchAction: 'none',
    background: '#fff',
  },
  canvas: {
    display: 'block',
    width: '100%',
    height: '100%',
    cursor: 'crosshair',
  },
  toolRow: {
    display: 'flex',
    gap: 6,
    padding: '8px 16px 0',
    background: '#fff',
    flexWrap: 'wrap',
  },
  toolButton: {
    padding: '6px 10px',
    fontSize: 13,
    border: '1px solid #ccc',
    borderRadius: 6,
    background: '#f7f4ee',
    cursor: 'pointer',
  },
  toolButtonActive: {
    background: '#1a1a1a',
    color: '#fff',
    borderColor: '#1a1a1a',
  },
  paletteRow: {
    display: 'flex',
    gap: 8,
    padding: '10px 16px',
    background: '#fff',
    borderBottom: '1px solid #ddd6c8',
  },
  swatch: {
    width: 26,
    height: 26,
    borderRadius: '50%',
    border: '2px solid transparent',
    cursor: 'pointer',
    padding: 0,
  },
  swatchActive: {
    border: '2px solid #1a1a1a',
  },
  swatchBorder: {
    border: '1px solid #ccc',
  },
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '10px 16px',
    background: '#fff',
    borderTop: '1px solid #ddd6c8',
  },
  brushLabel: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 12,
    color: '#555',
    flex: 1,
  },
  slider: { flex: 1 },
  button: {
    padding: '8px 12px',
    fontSize: 13,
    border: '1px solid #ccc',
    borderRadius: 6,
    background: '#f7f4ee',
    cursor: 'pointer',
  },
  newWordButton: {
    background: '#1a1a1a',
    color: '#fff',
    borderColor: '#1a1a1a',
  },
};
