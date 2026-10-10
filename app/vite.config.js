import { writeFileSync, mkdirSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
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
      // Dev-only, likewise: POST JSON to /__save?name=NAME to write
      // recordings/NAME.json — movement recorded for the bots
      // (src/dev/recordTracks.js) and whole sessions recorded for replaying
      // into the projector (src/dev/sessionRecorder.js).
      server.middlewares.use('/__save', (req, res) => {
        if (req.method !== 'POST') return res.end('POST only');
        const name = new URL(req.url, 'http://x').searchParams.get('name') ?? '';
        if (!/^[a-z0-9_-]{1,80}$/i.test(name)) {
          res.statusCode = 400;
          return res.end('bad name');
        }
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          mkdirSync('recordings', { recursive: true });
          const file = `recordings/${name}.json`;
          writeFileSync(file, body);
          res.end(file);
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
/**
 * This computer's address on the local network (e.g. 192.168.0.51), for the
 * lobby's QR code during development: a page opened as `localhost` can't find
 * out its own network address, and "localhost" means nothing to a phone. Luke,
 * 2026-10-05, testing on his phone: the QR "is sending me to the Github
 * address", not the local build. Prefers a private 192.168/10/172.16-31
 * address, skipping virtual adapters (WSL, Hyper-V, VirtualBox), which are
 * unreachable from a phone. Null if there's none.
 */
function lanAddress() {
  const candidates = [];
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    if (/vEthernet|VirtualBox|VMware|WSL|Hyper-V|docker|Loopback/i.test(name)) continue;
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const rank = a.address.startsWith('192.168.') ? 0 : a.address.startsWith('10.') ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(a.address) ? 2 : 3;
      candidates.push({ rank, address: a.address });
    }
  }
  candidates.sort((x, y) => x.rank - y.rank);
  return candidates[0]?.address ?? null;
}

export default {
  base: './',
  // Only read in development (see sessionConfig.js's joinUrl).
  define: { __DEV_LAN_HOST__: JSON.stringify(lanAddress()) },
  plugins: [react(), shotPlugin()],
  // 5181 while the old standalone prototype still runs on 5180 — the two need
  // to be up side by side for Stage A's "plays identically" comparison.
  // PORT, when set, comes from the Code tab's preview launcher (launch.json
  // autoPort), so a second chat can run its own server beside another one;
  // plain `npm run dev` still gets 5181.
  server: { host: true, port: Number(process.env.PORT) || 5181 },
  // es2022, not the prototype's es2020. Originally for skyPath.js's
  // module-scope `await RAPIER.init()`; Rapier now loads on demand
  // (2026-10-10, see loadRapier() there), but the test pages' copies
  // (src/temple3d/) still use top-level await, which isn't valid below
  // es2022, and every browser the game targets supports it anyway.
  build: { target: 'es2022' },
};
