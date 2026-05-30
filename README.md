# model-viewer AR server (with animated iOS Quick Look)

A small **TypeScript / Node** HTTPS server that hosts a
[`<model-viewer>`](https://modelviewer.dev) augmented-reality gallery — a
reproduction of <https://modelviewer.dev/examples/augmentedreality/> — set up
correctly so that AR works on real phones, **including animated models on iOS**.

Everything is TypeScript: the server runs as `.ts` directly on Node 24 (native
type stripping), and the browser code is bundled from `src/client/main.ts` with
esbuild.

## Why a special server is needed for AR

Three things break AR if you just open the HTML from disk or a plain `http://`
server:

1. **HTTPS / secure context.** WebXR (Android), camera access, and AR Quick Look
   require a secure context. The AR button is silently disabled over plain
   `http://` on a phone. This server uses a self-signed certificate and listens
   on HTTPS (`localhost` over HTTP is also a secure context, so desktop dev
   works without the cert warning).
2. **Correct MIME types.** `model-viewer` and iOS Quick Look reject assets
   served with the wrong `Content-Type`. The server sets:
   - `.glb`  → `model/gltf-binary`
   - `.gltf` → `model/gltf+json`
   - `.usdz` → `model/vnd.usdz+zip`
3. **HTTP range requests.** iOS Quick Look streams large `.usdz` files with
   `Range` requests; Express static serves `206 Partial Content` correctly.

## Animations on iOS — the key point

iOS AR uses **AR Quick Look**, which only understands **USDZ**. `model-viewer`
can auto-generate a USDZ from your `.glb` on the fly, **but that auto-generated
USDZ is static — it does not include animation** (this is a documented
model-viewer limitation).

> To get an **animated** model in AR on iOS you must supply a pre-built,
> animated `.usdz` via the `ios-src` attribute (or a plain
> `<a rel="ar" href="model.usdz">` link).

The page shows a single full-screen `<model-viewer>` of one `.glb`
(`public/models/RobotExpressive.glb`). On web/Android it renders and AR-launches
the GLB directly; on iOS the GLB is converted to an **animated USDZ in the
browser** and used as `ios-src`, so AR Quick Look animates too. Change `SRC` /
`CLIP` in [`src/client/main.ts`](src/client/main.ts) to use a different model.

## Runtime GLB → animated USDZ converter (TypeScript)

[`src/lib/usdz.ts`](src/lib/usdz.ts) is a dependency-free converter (no three.js,
no WASM) that turns a GLB into an **animated** USDZ. The same code runs in the
browser (on iOS, before AR launch) and in Node (offline pre-baking). It:

- bakes **node / transform (TRS) animation** to `matrix4d` `timeSamples`;
- bakes **skinned / skeletal animation** to `UsdSkel` (Skeleton + SkelAnimation +
  per-vertex `skel:jointIndices` / `skel:jointWeights`), with each joint's pose
  emitted relative to its parent joint so the skeleton-space accumulation
  reproduces the glTF scene-global pose;
- emits geometry, normals, UVs, and `UsdPreviewSurface` materials (incl. textures,
  copied byte-for-byte from the GLB — no image re-encoding);
- optionally scales the model to a target real-world size (`targetSize`);
- packages a spec-compliant USDZ (stored, 64-byte-aligned zip).

For transform- or skinned-animated models you can ship **just a `.glb`** — the
page fetches it, converts in the browser, and sets the result as `ios-src` so
model-viewer's own AR button launches the animated Quick Look.

### Scope and limits

- ✅ **Transform / node animation** (translate / rotate / scale).
- ✅ **Skinned / skeletal animation** via `UsdSkel` (e.g. RobotExpressive). The
  skinning math is verified against glTF in Node to sub-micron accuracy.
- ❌ **Morph targets (blend shapes)** are not yet emitted — meshes with morph
  targets render at their base shape (e.g. RobotExpressive's facial expressions).
  The count is reported by the CLI / `morphMeshesIgnored`.

### Pre-bake from the command line

Instead of converting in the browser you can bake a `.usdz` once and serve it as a
static file (set `iosSrc` to it):

```bash
npm run usdz -- public/models/RobotExpressive.glb public/models/RobotExpressive.usdz
```

The CLI also validates the output (zip alignment, USD content, presence of
animation timeSamples).

## Run

Requires **Node 24+** (for running `.ts` directly).

```bash
npm install
npm start
```

`npm start` bundles the client and starts the server. It prints a `Local:` URL
and one or more `Network:` URLs.

- **Desktop:** open the `Local:` URL — `https://localhost:8443/` (or
  `http://localhost:8080/`, also a secure context).
- **Phone (same Wi-Fi):** open the **`Network:`** URL, e.g.
  `https://192.168.1.90:8443/`.

### Trusted cert via a tunnel (recommended for phones)

The self-signed cert triggers a "Not Secure" warning on first visit, and — more
importantly — **iOS Safari blocks geolocation on untrusted certs** (see the GPS
note below). The clean fix is a tunnel, which gives a real, trusted HTTPS URL.

**cloudflared** (recommended — no account, no interstitial page). Install it
with `winget install Cloudflare.cloudflared` (Windows) / `brew install
cloudflared` (macOS), then, with the server running (`npm start`), in another
terminal:

```bash
npm run tunnel        # = cloudflared tunnel --url http://localhost:8080
```

It prints a `https://<random>.trycloudflare.com` URL. Open that on the phone — no
cert warning, no click-through, real HTTPS, AR + GPS work.

Always point the tunnel at the **HTTP port `8080`**, not the TLS port `8443`. The
tunnel terminates TLS at its edge and forwards plain HTTP with
`X-Forwarded-Proto: https`, which the server detects and serves directly.

> The `…trycloudflare.com` URL is **ephemeral** — a new random URL each run. For
> a **stable** URL that survives restarts, set up a named tunnel ↓.

#### Permanent URL (named tunnel on your own domain)

A quick tunnel (above) is throwaway. A *named* tunnel gives a fixed hostname like
`https://ar.example.com`. Requires a domain on a free Cloudflare account.

```bash
# 1. authorize cloudflared with your Cloudflare account (opens a browser; pick the zone)
cloudflared tunnel login

# 2. create a tunnel (writes a <UUID>.json credentials file under ~/.cloudflared)
cloudflared tunnel create ar

# 3. point a hostname at it (creates the DNS record for you)
cloudflared tunnel route dns ar ar.example.com
```

Then create `~/.cloudflared/config.yml`:

```yaml
tunnel: ar
credentials-file: /absolute/path/to/<UUID>.json
ingress:
  - hostname: ar.example.com
    service: http://localhost:8080   # the server's HTTP port
  - service: http_status:404
```

Run it (and leave `npm start` running):

```bash
cloudflared tunnel run ar
```

`https://ar.example.com` now always reaches your server — same trusted-cert
benefit, but a stable URL you can bookmark on the phone.

<details><summary>Alternative: ngrok</summary>

```bash
ngrok http 8080        # needs a free account / authtoken; shows a one-time interstitial
```

`ERR_NGROK_3004` means ngrok was pointed at the HTTPS port (`ngrok http 8443`):
ngrok speaks plain HTTP to the upstream but `8443` only speaks TLS. Use `8080`.

</details>

### Testing AR

- **Android:** open in Chrome → tap **View in AR** (Scene Viewer / WebXR).
- **iPhone / iPad:** open in Safari → tap **View in AR** → AR Quick Look opens
  and the model animates (the GLB is converted to an animated USDZ in-browser).

## Geopositioning & database

Models are stored in a database with a real-world location, and the page lists
the ones **near the device**, sorted by distance, with bearing. On a **phone**
(iOS or Android) selecting a model goes **straight to AR**; on desktop it loads
inline (the **View in AR** button stays as a fallback if a browser blocks the
auto-launch). New placements are created via an **explicit, optional form**
("＋ Create model"), not an automatic drop.

> Scope: this is **location-aware selection** (GPS → which models to show).
> True world-anchored AR (a model pinned to exact coordinates as you walk) is not
> supported by iOS AR Quick Look or standard WebXR, so it's out of scope.

> **iOS + GPS needs a _trusted_ certificate.** Safari/WebKit blocks
> `navigator.geolocation` on a self-signed cert (the LAN `https://<ip>:8443`
> URL) even after you tap through the warning — location comes back empty. Use a
> tunnel for a real cert (`cloudflared tunnel --url http://localhost:8080`, then
> open the `…trycloudflare.com` URL), or trust the cert on the device. Also
> ensure **Settings ▸ Privacy ▸ Location Services** is on and Safari is allowed
> to use Location. (Android/Chrome behaves the same way with untrusted certs.)

### Database adapter (SQLite or Postgres)

Selected at runtime via `DB_DRIVER`; both implement the same
[`ModelStore`](src/db/types.ts) interface ([`geo.ts`](src/db/geo.ts) does the
haversine distance + bearing):

```bash
# SQLite (default) — built-in node:sqlite, no native deps, file at ./data/models.db
npm start

# Postgres — needs a running server
DB_DRIVER=postgres DATABASE_URL=postgres://user:pass@localhost:5432/ar npm start
```

On first run the DB is seeded with a few sample placements (NYC / Paris / Sydney)
so the list isn't empty.

### HTTP API

| Method & path | Purpose |
| --- | --- |
| `GET /api/models` | all models |
| `GET /api/models/nearby?lat=&lon=&radius=` | models within `radius` m, nearest-first, each with `distanceM` + `bearingDeg` |
| `GET /api/models/:id` | one model |
| `POST /api/models` | place a model (`{name, filePath, lat, lon, clip?, scaleM?, markerSrc?, targetIndex?}`) |
| `PATCH /api/models/:id` | update fields (e.g. bind a marker: `{markerSrc, targetIndex, clip?}`) |
| `DELETE /api/models/:id` | remove a model |

### Adding / placing your own model

1. Drop `YourModel.glb` into `public/models/`.
2. Add it to the **Model** dropdown in the create form
   ([`public/index.html`](public/index.html)), then place it via **＋ Create
   model** in the UI — or `POST /api/models` with
   `filePath: "models/YourModel.glb"` and `lat`/`lon`.

The runtime converter produces the iOS USDZ automatically (transform + skinned
animation). If you'd rather pre-bake a static `.usdz` instead:

### Producing an animated USDZ

There is no reliable pure-JavaScript glTF→animated-USDZ converter (three.js /
model-viewer's own exporter drops animation). Use one of:

- The built-in converter (`npm run usdz -- in.glb out.usdz`) for transform +
  skinned animation.
- **Reality Converter** / **Blender** / Apple `usdzconvert` (macOS) for anything
  it doesn't cover (e.g. morph targets).

## Marker (image-target) AR

`/marker/` is a marker-based AR page using **MindAR** (MIT, no account/key,
runs in iOS Safari). Unlike GPS placement, a model is anchored to a **printed
image marker** and appears with **no manual placement**.

Each DB model can be **bound to a marker** via two fields:
- `markerSrc` — a compiled MindAR `.mind` file (e.g. `/marker/targets.mind`).
- `targetIndex` — which image within that file (0-based).

The page reads `/api/models`, takes the models bound to one `.mind` file
(`?src=` or the first bound model's file), and renders each on its
`targetIndex`. MindAR tracks multiple images from one file, so point the camera
at any registered marker and its model appears.

**Set up your markers:**
1. Compile your marker image(s) into a `.mind` at the
   [MindAR compiler](https://hiukim.github.io/mind-ar-js-doc/tools/compile)
   (the order you add them = `targetIndex`). Drop the file in `public/marker/`.
2. Bind models: create with `markerSrc`/`targetIndex` (the create form has
   **Marker** + **Target #** inputs), or
   `PATCH /api/models/:id {"markerSrc":"/marker/targets.mind","targetIndex":0}`.
3. Open `/marker/` and point at a marker.

A bundled example target (`public/marker/card.{mind,png}`) works out of the box —
bind a model to `/marker/card.mind` / index `0` and display/print `card.png`.

> Scope: this is **image-marker** anchoring (model appears on the marker), not
> GPS/world anchoring. Marker model scale/rotation default to a flat-marker
> upright pose; tune in [`public/marker/index.html`](public/marker/index.html).

## Layout

```
server.ts              HTTPS static server + MIME types + geo REST API (run with: node server.ts)
src/db/                Storage adapter: types.ts, geo.ts, sqlite.ts, postgres.ts, index.ts (factory + seed)
src/lib/               Pure-TS GLB→USDZ converter (gltf.ts, zip.ts, usdz.ts)
src/client/main.ts     Geolocation + nearby list + viewer (bundled to public/main.js)
public/index.html      Page shell; loads the self-hosted model-viewer bundle
public/styles.css
public/vendor/model-viewer.min.js   Self-hosted model-viewer (works offline)
public/models/         .glb assets
tools/build-usdz.ts    CLI: bake + validate a .usdz from a .glb
.claude/launch.json    Preview/dev launch config (port 8080)
```

## Config

| Env var | Default | Purpose |
| --- | --- | --- |
| `HTTPS_PORT` | `8443` | HTTPS listener |
| `HTTP_PORT` | `8080` | HTTP listener (serves localhost, redirects LAN hosts to HTTPS) |
| `DB_DRIVER` | `sqlite` | `sqlite` or `postgres` |
| `SQLITE_PATH` | `./data/models.db` | SQLite file (when `DB_DRIVER=sqlite`) |
| `DATABASE_URL` | — | Postgres connection string (required when `DB_DRIVER=postgres`) |
