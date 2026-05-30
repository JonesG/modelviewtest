// Minimal page: a single <model-viewer>.
//   - web / Android: renders and AR-launches the .glb directly.
//   - iOS: the .glb is converted to an animated USDZ in the browser (pure TS)
//     and used as ios-src, so AR Quick Look animates too.
//
// The <model-viewer> element is registered by /vendor/model-viewer.min.js.

import { glbToUsdz } from '../lib/usdz.ts';

const SRC = 'models/RobotExpressive.glb';
// Which animation clip to bake into the iOS USDZ (model-viewer plays it inline too).
const CLIP = 'Dance';

const isIOS =
  /iP(hone|ad|od)/.test(navigator.platform) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) ||
  /iPhone|iPad|iPod/.test(navigator.userAgent);

const mv = document.createElement('model-viewer');
mv.setAttribute('src', SRC);
mv.setAttribute('ar', '');
mv.setAttribute('ar-modes', 'webxr scene-viewer quick-look');
mv.setAttribute('camera-controls', '');
mv.setAttribute('touch-action', 'pan-y');
mv.setAttribute('shadow-intensity', '1');
mv.setAttribute('autoplay', '');
mv.setAttribute('animation-name', CLIP);
mv.setAttribute('environment-image', 'neutral');
mv.setAttribute('loading', 'eager');

const arButton = document.createElement('button');
arButton.slot = 'ar-button';
arButton.className = 'ar-button';
arButton.textContent = 'View in AR';
mv.append(arButton);

document.body.append(mv);

// On iOS, build the animated USDZ from the GLB and use it for Quick Look.
if (isIOS) {
  (async () => {
    try {
      const buf = await (await fetch(SRC)).arrayBuffer();
      // targetSize caps the largest dimension (meters) so it isn't placed at its
      // authored real-world size in AR — an unscaled 1-unit model is 1 m.
      const { usdz } = glbToUsdz(buf, { animationName: CLIP, targetSize: 0.6 });
      const url = URL.createObjectURL(new Blob([usdz as BlobPart], { type: 'model/vnd.usdz+zip' }));
      mv.setAttribute('ios-src', url);
    } catch {
      /* fall back to model-viewer's (static) auto USDZ */
    }
  })();
}
