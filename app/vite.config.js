import { writeFileSync, mkdirSync } from 'node:fs';
import react from '@vitejs/plugin-react';

/**
 * Dev-only: lets the page POST a data-URL to /__shot so a rendered frame can
 * be written to disk. Carried over from the standalone prototype because this
 * project genuinely needs it — the preview pane reports `document.hidden`, so
 * it never composites and ordinary screenshots time out, but the WebGL canvas
 * still renders on demand via `window.__capture()`. Not part of the build.
 */
function shotPlugin() {
  return {
    name: 'shot',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__shot', (req, res) => {
        if (req.method !== 'POST') return res.end('POST only');
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          const [, b64] = body.split(',');
          mkdirSync('shots', { recursive: true });
          const name = `shots/${Date.now()}.png`;
          writeFileSync(name, Buffer.from(b64, 'base64'));
          res.end(name);
        });
      });
    },
  };
}

/**
 * One app, one build. Replaces the four separate static prototypes
 * (relay-smoke-test, lobby-prototype, persistent-classes, prototype-threejs),
 * each of which had its own hand-copied gitignored `config.js`. Supabase
 * credentials now come from Vite env vars instead — see .env.example.
 *
 * `base: './'` keeps the built bundle path-relative so it can be served from
 * a GitHub Pages project subpath without a rebuild (handoff: static hosting
 * on GitHub Pages, no server logic).
 */
export default {
  base: './',
  plugins: [react(), shotPlugin()],
  // 5181 while the old standalone prototype still runs on 5180 — the two need
  // to be up side by side for Stage A's "plays identically" comparison.
  // PORT, when set, comes from the Code tab's preview launcher (launch.json
  // autoPort), so a second chat can run its own server beside another one;
  // plain `npm run dev` still gets 5181.
  server: { host: true, port: Number(process.env.PORT) || 5181 },
  // es2022, not the prototype's es2020: skyPath.js keeps the prototype's
  // module-scope `await RAPIER.init()` (Rapier is WASM and needs it before any
  // RAPIER.* class exists), and top-level await isn't valid below es2022.
  build: { target: 'es2022' },
};
