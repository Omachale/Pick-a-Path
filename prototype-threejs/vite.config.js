import { writeFileSync, mkdirSync } from 'node:fs';

/**
 * Dev-only: lets the page POST a data-URL to /__shot so a frame can be saved
 * to disk for inspection. Not part of the build.
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

export default {
  base: './',
  plugins: [shotPlugin()],
  server: { host: true, port: 5180 },
  build: { target: 'es2020' },
};
