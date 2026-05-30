// Shows only the model(s) at your physical GPS location (within LOCAL_RADIUS_M),
// full-screen, ready for AR. No list of remote places — if you're not there,
// there's nothing to select. Create a model "here" and it appears.
//
// On iOS the GLB is converted to an animated USDZ at runtime for AR Quick Look.
// <model-viewer> is registered by /vendor/model-viewer.min.js.

import { glbToUsdz } from '../lib/usdz.ts';

type NearbyModel = {
  id: number;
  name: string;
  filePath: string;
  clip: string | null;
  lat: number;
  lon: number;
  scaleM: number | null;
  distanceM: number;
  bearingDeg: number;
};

// How close (metres) a model must be to count as "here". Generous enough to
// absorb GPS drift; small enough that you only see models at your spot.
const LOCAL_RADIUS_M = 200;

const isIOS =
  /iP(hone|ad|od)/.test(navigator.platform) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) ||
  /iPhone|iPad|iPod/.test(navigator.userAgent);

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const statusEl = $('status');
const viewerEl = $('viewer');
const refreshBtn = $<HTMLButtonElement>('refresh');
const cycleBtn = $<HTMLButtonElement>('cycle');
const delBtn = $<HTMLButtonElement>('del');
const createToggle = $<HTMLButtonElement>('create-toggle');
const form = $<HTMLFormElement>('create-form');
const backdrop = $('create-backdrop');
const fName = $<HTMLInputElement>('c-name');
const fFile = $<HTMLSelectElement>('c-file');
const fClip = $<HTMLSelectElement>('c-clip');
const fScale = $<HTMLInputElement>('c-scale');
const fMarker = $<HTMLInputElement>('c-marker');
const fTarget = $<HTMLInputElement>('c-target');
const fLoc = $('c-loc');
const fLocate = $<HTMLButtonElement>('c-locate');
const fCreate = $<HTMLButtonElement>('c-create');
const fCancel = $<HTMLButtonElement>('c-cancel');
const fMsg = $('c-msg');

// --- model-viewer ---
const mv = document.createElement('model-viewer') as HTMLElement & { loaded?: boolean };
mv.setAttribute('ar', '');
mv.setAttribute('ar-modes', 'webxr scene-viewer quick-look');
mv.setAttribute('camera-controls', '');
mv.setAttribute('touch-action', 'pan-y');
mv.setAttribute('shadow-intensity', '1');
mv.setAttribute('autoplay', '');
mv.setAttribute('environment-image', 'neutral');
const arBtn = document.createElement('button');
arBtn.slot = 'ar-button';
arBtn.className = 'ar-button';
arBtn.textContent = 'View in AR';
mv.append(arBtn);
viewerEl.append(mv);

const usdzCache = new Map<number, string>();
async function ensureIosSrc(m: NearbyModel): Promise<void> {
  if (!isIOS) return;
  let url = usdzCache.get(m.id);
  if (!url) {
    const buf = await (await fetch(m.filePath)).arrayBuffer();
    const { usdz } = glbToUsdz(buf, { animationName: m.clip ?? undefined, targetSize: m.scaleM ?? 0.6 });
    url = URL.createObjectURL(new Blob([usdz as BlobPart], { type: 'model/vnd.usdz+zip' }));
    usdzCache.set(m.id, url);
  }
  mv.setAttribute('ios-src', url);
}

async function loadModel(m: NearbyModel): Promise<void> {
  mv.setAttribute('src', m.filePath);
  if (m.clip) mv.setAttribute('animation-name', m.clip);
  else mv.removeAttribute('animation-name');
  mv.removeAttribute('ios-src');
  try {
    await ensureIosSrc(m);
  } catch (e) {
    console.warn('USDZ conversion failed; iOS falls back to auto USDZ', e);
  }
}

const fmtDist = (m: number) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`);

// --- local models ---
let here: NearbyModel[] = [];
let idx = 0;

async function showCurrent(): Promise<void> {
  const m = here[idx];
  statusEl.textContent = `${m.name} · ${fmtDist(m.distanceM)} away`;
  cycleBtn.hidden = here.length < 2;
  cycleBtn.textContent = `${idx + 1}/${here.length} ▸`;
  delBtn.hidden = false;
  await loadModel(m);
}

let lastPos: { lat: number; lon: number } | null = null;
let lastPosReal = false;

async function refresh(): Promise<void> {
  if (!lastPos) return;
  const url = `/api/models/nearby?lat=${lastPos.lat}&lon=${lastPos.lon}&radius=${LOCAL_RADIUS_M}`;
  here = await (await fetch(url)).json();
  idx = 0;
  if (here.length) {
    await showCurrent();
  } else {
    statusEl.textContent = 'No models here — tap ＋ Create here to place one.';
    mv.removeAttribute('src');
    mv.removeAttribute('ios-src');
    cycleBtn.hidden = true;
    delBtn.hidden = true;
  }
}

async function deleteCurrent(): Promise<void> {
  if (!here.length) return;
  const m = here[idx];
  if (!confirm(`Delete “${m.name}”?`)) return;
  try {
    const res = await fetch(`/api/models/${m.id}`, { method: 'DELETE' });
    if (!res.ok && res.status !== 404) throw new Error(`server ${res.status}`);
    const cached = usdzCache.get(m.id);
    if (cached) URL.revokeObjectURL(cached);
    usdzCache.delete(m.id);
    await refresh(); // re-query; shows the next local model or "No models here"
  } catch (err) {
    statusEl.textContent = `Could not delete: ${(err as Error).message}`;
  }
}

cycleBtn.addEventListener('click', () => {
  if (here.length < 2) return;
  idx = (idx + 1) % here.length;
  void showCurrent();
});

// --- create flow (modal) ---
const maybeUntrustedCert =
  location.protocol === 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1';

function geoError(err: GeolocationPositionError | Error): string {
  const m = 'message' in err ? err.message : String(err);
  const hint = maybeUntrustedCert
    ? ' — iOS blocks GPS on untrusted certs. Use the trusted tunnel URL, and check Settings ▸ Privacy ▸ Location Services.'
    : ' — allow location access for this site.';
  return `No GPS (${m})${hint}`;
}

function getPosition(): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('no geolocation'));
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      timeout: 10_000,
      maximumAge: 60_000,
    });
  });
}

let formPos: { lat: number; lon: number } | null = null;

async function captureLocation(): Promise<void> {
  fLoc.textContent = 'Getting GPS…';
  fCreate.disabled = true;
  try {
    const pos = await getPosition();
    formPos = { lat: pos.coords.latitude, lon: pos.coords.longitude };
    const acc = pos.coords.accuracy;
    fLoc.textContent = `${formPos.lat.toFixed(6)}, ${formPos.lon.toFixed(6)}` + (acc ? ` (±${Math.round(acc)} m)` : '');
    fCreate.disabled = false;
  } catch (e) {
    if (lastPos && lastPosReal) {
      formPos = lastPos;
      fLoc.textContent = `${formPos.lat.toFixed(6)}, ${formPos.lon.toFixed(6)} (current)`;
      fCreate.disabled = false;
    } else {
      formPos = null;
      fCreate.disabled = true;
      fLoc.textContent = geoError(e as GeolocationPositionError);
    }
  }
}

function openForm(): void {
  form.hidden = false;
  backdrop.hidden = false;
  fMsg.textContent = '';
  // Reuse the location we already have; 📍 re-captures a fresh fix if wanted.
  if (lastPos && lastPosReal) {
    formPos = lastPos;
    fLoc.textContent = `${lastPos.lat.toFixed(6)}, ${lastPos.lon.toFixed(6)} (current)`;
    fCreate.disabled = false;
  } else {
    void captureLocation();
  }
}
function closeForm(): void {
  form.hidden = true;
  backdrop.hidden = true;
}

function msg(text: string): void {
  fMsg.textContent = text;
  statusEl.textContent = text;
}

async function createModel(): Promise<void> {
  if (!formPos) {
    msg('No GPS location yet — tap 📍 to capture it.');
    return;
  }
  const body = {
    name: fName.value.trim() || 'Untitled',
    filePath: fFile.value,
    clip: fClip.value,
    scaleM: Number(fScale.value) || 0.6,
    lat: formPos.lat,
    lon: formPos.lon,
    description: 'Created from the browser',
    markerSrc: fMarker.value.trim() || null,
    targetIndex: fTarget.value.trim() === '' ? null : Number(fTarget.value),
  };
  fCreate.disabled = true;
  fMsg.textContent = 'Creating…';
  try {
    const res = await fetch('/api/models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`server ${res.status}`);
    const created: NearbyModel = await res.json();
    closeForm();
    await refresh(); // the new model is at distance ~0, so it shows immediately
    statusEl.textContent = `Created “${created.name}”.`;
  } catch (err) {
    fMsg.textContent = `✗ Could not create: ${(err as Error).message}`;
    fCreate.disabled = false;
  }
}

function locate(): void {
  statusEl.textContent = 'Locating…';
  if (!navigator.geolocation) {
    statusEl.textContent = 'Geolocation not supported by this browser.';
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      lastPos = { lat: pos.coords.latitude, lon: pos.coords.longitude };
      lastPosReal = true;
      void refresh();
    },
    (err) => {
      statusEl.textContent = geoError(err);
      lastPosReal = false;
    },
    { enableHighAccuracy: true, timeout: 10_000 }
  );
}

refreshBtn.addEventListener('click', () => locate());
delBtn.addEventListener('click', () => void deleteCurrent());
createToggle.addEventListener('click', openForm);
fLocate.addEventListener('click', () => void captureLocation());
fCancel.addEventListener('click', closeForm);
fCreate.addEventListener('click', () => void createModel());
form.addEventListener('submit', (e) => { e.preventDefault(); void createModel(); });
locate();
