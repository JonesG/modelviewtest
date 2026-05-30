// HTTPS static server tuned for <model-viewer> augmented reality.
//
// Why HTTPS: AR on the web requires a "secure context". WebXR (Android),
// camera access, and the way iOS hands a .usdz to AR Quick Look all need the
// page to be served over https (or localhost). Plain http silently disables
// the AR button on a phone.
//
// Why custom MIME types: model-viewer and iOS Quick Look refuse assets served
// with the wrong Content-Type. .glb / .gltf / .usdz are not in Node's default
// mime table, so we register them explicitly.
//
// Run directly with Node 24 (native TypeScript type stripping): `node server.ts`.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import express from 'express';
import selfsigned from 'selfsigned';
import { createStore, seedIfEmpty } from './src/db/index.ts';
import type { NewModel } from './src/db/types.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const CERT_DIR = path.join(__dirname, 'certs');

const HTTPS_PORT = Number(process.env.HTTPS_PORT) || 8443;
const HTTP_PORT = Number(process.env.HTTP_PORT) || 8080; // redirects to https

// --- Discover LAN IPv4 addresses so a phone on the same Wi-Fi can connect ---
function lanAddresses(): string[] {
  const out: string[] = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces ?? []) {
      if (i.family === 'IPv4' && !i.internal) out.push(i.address);
    }
  }
  return out;
}

// --- Generate a self-signed certificate the first time, with the right SANs ---
// The cert must list every host the phone might type in the address bar, or the
// TLS handshake fails. We include localhost, 127.0.0.1, and each LAN IP.
function ensureCert(): { key: string | Buffer; cert: string | Buffer } {
  const keyPath = path.join(CERT_DIR, 'key.pem');
  const certPath = path.join(CERT_DIR, 'cert.pem');
  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
  }
  fs.mkdirSync(CERT_DIR, { recursive: true });

  const altNames = [
    { type: 2, value: 'localhost' }, // type 2 = DNS
    { type: 7, ip: '127.0.0.1' }, // type 7 = IP
    ...lanAddresses().map((ip) => ({ type: 7, ip })),
  ];

  const pems = selfsigned.generate(
    [{ name: 'commonName', value: 'localhost' }],
    {
      days: 3650,
      keySize: 2048,
      algorithm: 'sha256',
      extensions: [{ name: 'subjectAltName', altNames }],
    }
  );

  fs.writeFileSync(keyPath, pems.private);
  fs.writeFileSync(certPath, pems.cert);
  console.log('Generated self-signed certificate in ./certs');
  return { key: pems.private, cert: pems.cert };
}

// --- Express app: static files with AR-correct headers ---
const app = express();
app.use(express.json());

// --- Geopositioned model database (SQLite or Postgres via adapter) ---
const store = await createStore();
const seeded = await seedIfEmpty(store);

const num = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// Log API calls so we can see requests arriving from the phone.
app.use('/api', (req, _res, next) => {
  console.log(`[api] ${new Date().toISOString()} ${req.method} ${req.url}`);
  next();
});

// All models.
app.get('/api/models', async (_req, res) => {
  res.json(await store.all());
});

// Models near a point, sorted nearest-first, each with distanceM + bearingDeg.
//   /api/models/nearby?lat=..&lon=..&radius=metres
app.get('/api/models/nearby', async (req, res) => {
  const lat = num(req.query.lat);
  const lon = num(req.query.lon);
  const radius = num(req.query.radius) ?? 50_000;
  if (lat === null || lon === null) {
    res.status(400).json({ error: 'lat and lon query params are required' });
    return;
  }
  res.json(await store.listNearby(lat, lon, radius));
});

app.get('/api/models/:id', async (req, res) => {
  const id = num(req.params.id);
  const m = id === null ? null : await store.getById(id);
  if (!m) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.json(m);
});

// Place a model at a location (used by the "Place here" button).
app.post('/api/models', async (req, res) => {
  const b = req.body ?? {};
  const lat = num(b.lat);
  const lon = num(b.lon);
  if (lat === null || lon === null || !b.name || !b.filePath) {
    res.status(400).json({ error: 'name, filePath, lat and lon are required' });
    return;
  }
  const model: NewModel = {
    name: String(b.name),
    filePath: String(b.filePath),
    clip: b.clip != null ? String(b.clip) : null,
    lat,
    lon,
    altitude: num(b.altitude),
    heading: num(b.heading),
    scaleM: num(b.scaleM),
    description: b.description != null ? String(b.description) : null,
  };
  res.status(201).json(await store.insert(model));
});

// Delete a placed model.
app.delete('/api/models/:id', async (req, res) => {
  const id = num(req.params.id);
  if (id === null) {
    res.status(400).json({ error: 'bad id' });
    return;
  }
  const removed = await store.delete(id);
  res.status(removed ? 204 : 404).end();
});

const MIME: Record<string, string> = {
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.usdz': 'model/vnd.usdz+zip',
  '.bin': 'application/octet-stream',
  '.hdr': 'application/octet-stream',
  '.wasm': 'application/wasm',
};

app.use(
  express.static(PUBLIC_DIR, {
    etag: true,
    lastModified: true,
    // express.static already supports HTTP range requests, which Quick Look
    // uses to stream large .usdz files — we just need the right Content-Type.
    setHeaders(res, filePath) {
      const ext = path.extname(filePath).toLowerCase();
      if (MIME[ext]) res.setHeader('Content-Type', MIME[ext]);
      // Allow assets to be loaded cross-origin too. Harmless for a local demo.
      res.setHeader('Access-Control-Allow-Origin', '*');
      // Never cache the app shell / code, so phones always get the latest build
      // (models/*.glb can still be cached — they're immutable assets).
      if (ext === '.html' || ext === '.js' || ext === '.css') {
        res.setHeader('Cache-Control', 'no-store');
      }
    },
  })
);

app.get('/healthz', (_req, res) => res.type('text').send('ok'));

// --- Boot ---
const { key, cert } = ensureCert();

https.createServer({ key, cert }, app).listen(HTTPS_PORT, '0.0.0.0', () => {
  const lines = [
    '',
    'model-viewer AR server running (HTTPS).',
    `  Database: ${store.driver}` + (seeded ? ` (seeded ${seeded} sample models)` : ''),
    '',
    '  Local:    https://localhost:' + HTTPS_PORT + '/',
  ];
  for (const ip of lanAddresses()) {
    lines.push('  Network:  https://' + ip + ':' + HTTPS_PORT + '/   <- open this on your phone');
  }
  lines.push(
    '',
    'First visit on each device shows a "Not Secure / certificate" warning',
    '(the cert is self-signed). Tap Advanced -> Proceed / Visit to continue.',
    'A tunnel (cloudflared / ngrok) avoids the warning entirely — see README.',
    ''
  );
  console.log(lines.join('\n'));
});

// Plain HTTP listener. We serve the app directly when the request is already
// secure, and only force a redirect for genuinely-insecure LAN requests:
//   - localhost / 127.0.0.1 is a "secure context" per the browser spec.
//   - Behind a TLS-terminating tunnel/proxy (ngrok, cloudflared, a load
//     balancer), the edge sets `X-Forwarded-Proto: https` and forwards plain
//     HTTP to us — the browser already has HTTPS, so serve directly. Point your
//     tunnel at THIS port (8080), not the TLS port: `ngrok http 8080`.
//   - A phone hitting the raw LAN IP over http:// is the only insecure case, so
//     we 301 it to HTTPS (the AR button is disabled over plain http on-device).
http
  .createServer((req, res) => {
    const host = (req.headers.host ?? '').replace(/:\d+$/, '');
    const forwardedProto = String(req.headers['x-forwarded-proto'] ?? '')
      .split(',')[0]
      .trim();
    const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
    if (isLocal || forwardedProto === 'https') {
      app(req, res);
      return;
    }
    res.writeHead(301, { Location: `https://${host}:${HTTPS_PORT}${req.url}` });
    res.end();
  })
  .listen(HTTP_PORT, '0.0.0.0');
