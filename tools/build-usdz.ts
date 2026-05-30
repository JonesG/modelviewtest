// Node CLI: convert a .glb to an animated .usdz and structurally validate it.
//   node tools/build-usdz.ts public/models/BoxAnimated.glb [public/models/BoxAnimated.usdz]
//
// Validation (no USD runtime available here):
//   - zip parses, every file's DATA offset is 64-byte aligned (USDZ requirement)
//   - the root layer is model.usda and parses as text
//   - if animated: timeCodesPerSecond + xformOp:transform.timeSamples are present

import fs from 'node:fs';
import path from 'node:path';
import { glbToUsdz } from '../src/lib/usdz.ts';

const inPath = process.argv[2];
if (!inPath) {
  console.error('usage: node tools/build-usdz.ts <input.glb> [output.usdz]');
  process.exit(1);
}
const outPath = process.argv[3] ?? inPath.replace(/\.glb$/i, '.usdz');

const glb = fs.readFileSync(inPath);
const result = glbToUsdz(glb);
fs.writeFileSync(outPath, result.usdz);

console.log(`wrote ${outPath}  (${result.usdz.length} bytes)`);
console.log(`animated=${result.animated} clip=${result.clipName ?? '(none)'} frames=${result.frameCount} fps=${result.fps}`);
console.log(`skinnedMeshes=${result.skinnedMeshes} morphMeshesIgnored=${result.morphMeshesIgnored}`);
if (result.morphMeshesIgnored > 0) {
  console.log('note: morph-target (blend shape) meshes are not yet emitted — those vertices stay at base shape.');
}

// --- validate zip structure + alignment ---
const u8 = result.usdz;
const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
let off = 0;
const files: { name: string; dataOffset: number; size: number }[] = [];
let ok = true;
while (off + 4 <= u8.length && dv.getUint32(off, true) === 0x04034b50) {
  const nameLen = dv.getUint16(off + 26, true);
  const extraLen = dv.getUint16(off + 28, true);
  const size = dv.getUint32(off + 18, true);
  const name = new TextDecoder().decode(u8.subarray(off + 30, off + 30 + nameLen));
  const dataOffset = off + 30 + nameLen + extraLen;
  files.push({ name, dataOffset, size });
  if (dataOffset % 64 !== 0) {
    console.error(`  ✗ ${name} data offset ${dataOffset} is NOT 64-byte aligned`);
    ok = false;
  }
  off = dataOffset + size;
}
console.log('files:', files.map((f) => `${f.name}@${f.dataOffset}`).join(', '));

const rootIsUsda = files[0]?.name.endsWith('.usda');
if (!rootIsUsda) { console.error('  ✗ first file is not the .usda root layer'); ok = false; }

// --- validate USD text ---
const usdaFile = files.find((f) => f.name.endsWith('.usda'))!;
const usda = new TextDecoder().decode(u8.subarray(usdaFile.dataOffset, usdaFile.dataOffset + usdaFile.size));
const checks: [string, boolean][] = [
  ['header #usda 1.0', usda.startsWith('#usda 1.0')],
  ['defaultPrim Root', usda.includes('defaultPrim = "Root"')],
  ['has Mesh', /def Mesh /.test(usda)],
  ['has points', usda.includes('point3f[] points')],
];
if (result.animated) {
  checks.push(['timeCodesPerSecond', usda.includes('timeCodesPerSecond')]);
  checks.push(['xformOp timeSamples', usda.includes('xformOp:transform.timeSamples')]);
  const m = usda.match(/(\d+): \( \(/g);
  checks.push(['multiple time samples', (m?.length ?? 0) > 1]);
}
for (const [label, pass] of checks) {
  console.log(`  ${pass ? '✓' : '✗'} ${label}`);
  if (!pass) ok = false;
}

console.log(ok ? '\nVALID ✅' : '\nINVALID ❌');
process.exit(ok ? 0 : 1);
