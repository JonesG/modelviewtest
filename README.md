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

### Self-signed certificate warning

The first visit on each device shows a "Not Secure" / certificate warning
because the cert is self-signed. Tap **Advanced → Proceed / Visit Website**.

To avoid the warning entirely (and get a trusted public URL for testing), run a
tunnel to the **HTTP port `8080`** (not the TLS port):

```bash
# cloudflared
cloudflared tunnel --url http://localhost:8080
# or ngrok
ngrok http 8080
```

Then open the `https://…trycloudflare.com` / `…ngrok.app` URL on your phone — no
cert warning, real HTTPS, AR works. The tunnel terminates TLS at its edge and
sets `X-Forwarded-Proto: https`, which the server detects and serves directly.

> **`ERR_NGROK_3004`** means ngrok was pointed at the **HTTPS** port
> (`ngrok http 8443`): ngrok speaks plain HTTP to the upstream, but `8443` only
> speaks TLS, so it sees an "invalid HTTP response". Use `ngrok http 8080`.

### Testing AR

- **Android:** open in Chrome → tap **View in your space** (Scene Viewer / WebXR).
- **iPhone / iPad:** open in Safari → tap **View in your space** or the Toy
  Drummer image → AR Quick Look opens. The drummer animates.

## Adding your own model

1. Drop `YourModel.glb` into `public/models/`.
2. Add an entry to the `MODELS` array in
   [`src/client/main.ts`](src/client/main.ts) with `src: 'models/YourModel.glb'`.
3. For **animated AR on iOS**, also produce an animated `YourModel.usdz` and set
   `iosSrc: 'models/YourModel.usdz'`.

### Producing an animated USDZ

There is no reliable pure-JavaScript glTF→animated-USDZ converter (three.js /
model-viewer's own exporter drops animation). Use one of:

- **Reality Converter** (free, macOS) — drag in a `.glb`, export `.usdz`.
- **Apple `usdzconvert`** (part of Apple's USD tools, macOS).
- **Blender** — import glTF, export USDZ (skeletal animation supported in
  recent versions).
- Or use a known-animated `.usdz` such as Apple's
  [Quick Look gallery](https://developer.apple.com/augmented-reality/quick-look/)
  models (the Toy Drummer in this project comes from there).

Place the resulting `.usdz` in `public/models/` and reference it with `ios-src`.

## Layout

```
server.ts              HTTPS static server + cert generation + MIME types (run with: node server.ts)
src/client/main.ts     Builds the <model-viewer> gallery (bundled to public/main.js)
public/index.html      Page shell; loads the self-hosted model-viewer bundle
public/styles.css
public/vendor/model-viewer.min.js   Self-hosted model-viewer (works offline)
public/models/         .glb / .usdz assets + drummer poster
.claude/launch.json    Preview/dev launch config (port 8080)
```

## Config

| Env var | Default | Purpose |
| --- | --- | --- |
| `HTTPS_PORT` | `8443` | HTTPS listener |
| `HTTP_PORT` | `8080` | HTTP listener (serves localhost, redirects LAN hosts to HTTPS) |
