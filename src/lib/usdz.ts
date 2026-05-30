// GLB -> animated USDZ, in pure TypeScript. Scope: node/transform (TRS)
// animation. Skinned/morph animation is intentionally NOT handled (that needs
// UsdSkel); such clips are baked to their first-frame pose and reported.
//
// Key conventions handled here:
//   - glTF and USDZ are both Y-up, right-handed, meters — no axis conversion.
//   - A glTF column-major local matrix maps to a USD row-vector matrix simply by
//     writing its 16 elements in order as four rows (col-major storage of a
//     column-vector matrix == row-major storage of its transpose).
//   - glTF quaternions are (x,y,z,w); we compose TRS exactly as three.js does.
//   - Animation is BAKED to a fixed fps as matrix4d timeSamples, sidestepping
//     glTF interpolation-mode (LINEAR/STEP/CUBICSPLINE) mismatches in USD.
//   - USD texture V is flipped relative to glTF (st.y = 1 - v).

import { Gltf, type GltfNode, type GltfMaterial, type TextureInfo } from './gltf.ts';
import { createUsdz, type ZipEntry } from './zip.ts';

export type UsdzResult = {
  usdz: Uint8Array;
  animated: boolean;
  /** Names of clips skipped (none now — kept for API compatibility). */
  unsupportedClips: string[];
  frameCount: number;
  fps: number;
  /** Number of skinned meshes emitted via UsdSkel. */
  skinnedMeshes: number;
  /** Morph-target meshes ignored (UsdSkel blend shapes not yet emitted). */
  morphMeshesIgnored: number;
  /** Name of the clip that was baked, if any. */
  clipName?: string;
};

export type UsdzOptions = {
  fps?: number;
  animationIndex?: number;
  /** Select the animation clip by name (overrides animationIndex). */
  animationName?: string;
  /**
   * Scale the whole model so its largest world-space dimension equals this many
   * meters (glTF/USDZ are in meters, so an unscaled 1-unit model is 1 m in AR).
   * Omit to keep the model's authored real-world size.
   */
  targetSize?: number;
};

type Vec = number[];

// ---- math ---------------------------------------------------------------

function composeTRS(t: Vec, q: Vec, s: Vec): number[] {
  const [x, y, z, w] = q;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  const [sx, sy, sz] = s;
  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    t[0], t[1], t[2], 1,
  ];
}

// column-major 4x4 multiply (a * b) and point transform
function mat4mul(a: number[], b: number[]): number[] {
  const o = new Array(16);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
  return o;
}
function transformPoint(m: number[], p: Vec): Vec {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ];
}
// Full 4x4 inverse (column-major), cofactor method.
function mat4inverse(m: number[]): number[] {
  const inv = new Array(16);
  inv[0] = m[5]*m[10]*m[15]-m[5]*m[11]*m[14]-m[9]*m[6]*m[15]+m[9]*m[7]*m[14]+m[13]*m[6]*m[11]-m[13]*m[7]*m[10];
  inv[4] = -m[4]*m[10]*m[15]+m[4]*m[11]*m[14]+m[8]*m[6]*m[15]-m[8]*m[7]*m[14]-m[12]*m[6]*m[11]+m[12]*m[7]*m[10];
  inv[8] = m[4]*m[9]*m[15]-m[4]*m[11]*m[13]-m[8]*m[5]*m[15]+m[8]*m[7]*m[13]+m[12]*m[5]*m[11]-m[12]*m[7]*m[9];
  inv[12] = -m[4]*m[9]*m[14]+m[4]*m[10]*m[13]+m[8]*m[5]*m[14]-m[8]*m[6]*m[13]-m[12]*m[5]*m[10]+m[12]*m[6]*m[9];
  inv[1] = -m[1]*m[10]*m[15]+m[1]*m[11]*m[14]+m[9]*m[2]*m[15]-m[9]*m[3]*m[14]-m[13]*m[2]*m[11]+m[13]*m[3]*m[10];
  inv[5] = m[0]*m[10]*m[15]-m[0]*m[11]*m[14]-m[8]*m[2]*m[15]+m[8]*m[3]*m[14]+m[12]*m[2]*m[11]-m[12]*m[3]*m[10];
  inv[9] = -m[0]*m[9]*m[15]+m[0]*m[11]*m[13]+m[8]*m[1]*m[15]-m[8]*m[3]*m[13]-m[12]*m[1]*m[11]+m[12]*m[3]*m[9];
  inv[13] = m[0]*m[9]*m[14]-m[0]*m[10]*m[13]-m[8]*m[1]*m[14]+m[8]*m[2]*m[13]+m[12]*m[1]*m[10]-m[12]*m[2]*m[9];
  inv[2] = m[1]*m[6]*m[15]-m[1]*m[7]*m[14]-m[5]*m[2]*m[15]+m[5]*m[3]*m[14]+m[13]*m[2]*m[7]-m[13]*m[3]*m[6];
  inv[6] = -m[0]*m[6]*m[15]+m[0]*m[7]*m[14]+m[4]*m[2]*m[15]-m[4]*m[3]*m[14]-m[12]*m[2]*m[7]+m[12]*m[3]*m[6];
  inv[10] = m[0]*m[5]*m[15]-m[0]*m[7]*m[13]-m[4]*m[1]*m[15]+m[4]*m[3]*m[13]+m[12]*m[1]*m[7]-m[12]*m[3]*m[5];
  inv[14] = -m[0]*m[5]*m[14]+m[0]*m[6]*m[13]+m[4]*m[1]*m[14]-m[4]*m[2]*m[13]-m[12]*m[1]*m[6]+m[12]*m[2]*m[5];
  inv[3] = -m[1]*m[6]*m[11]+m[1]*m[7]*m[10]+m[5]*m[2]*m[11]-m[5]*m[3]*m[10]-m[9]*m[2]*m[7]+m[9]*m[3]*m[6];
  inv[7] = m[0]*m[6]*m[11]-m[0]*m[7]*m[10]-m[4]*m[2]*m[11]+m[4]*m[3]*m[10]+m[8]*m[2]*m[7]-m[8]*m[3]*m[6];
  inv[11] = -m[0]*m[5]*m[11]+m[0]*m[7]*m[9]+m[4]*m[1]*m[11]-m[4]*m[3]*m[9]-m[8]*m[1]*m[7]+m[8]*m[3]*m[5];
  inv[15] = m[0]*m[5]*m[10]-m[0]*m[6]*m[9]-m[4]*m[1]*m[10]+m[4]*m[2]*m[9]+m[8]*m[1]*m[6]-m[8]*m[2]*m[5];
  let det = m[0]*inv[0]+m[1]*inv[4]+m[2]*inv[8]+m[3]*inv[12];
  det = det || 1;
  for (let i = 0; i < 16; i++) inv[i] /= det;
  return inv;
}
// glTF quaternion (x,y,z,w) -> USD quatf order (w,x,y,z) as a formatted tuple.
function quatfLiteral(q: Vec): string {
  return `(${fmt(q[3])}, ${fmt(q[0])}, ${fmt(q[1])}, ${fmt(q[2])})`;
}
// Decompose a column-major TRS matrix into translation, quaternion (x,y,z,w), scale.
function decompose(m: number[]): { t: Vec; r: Vec; s: Vec } {
  const t = [m[12], m[13], m[14]];
  let sx = Math.hypot(m[0], m[1], m[2]);
  const sy = Math.hypot(m[4], m[5], m[6]);
  const sz = Math.hypot(m[8], m[9], m[10]);
  const det =
    m[0] * (m[5] * m[10] - m[6] * m[9]) -
    m[4] * (m[1] * m[10] - m[2] * m[9]) +
    m[8] * (m[1] * m[6] - m[2] * m[5]);
  if (det < 0) sx = -sx;
  const r00 = m[0] / sx, r10 = m[1] / sx, r20 = m[2] / sx;
  const r01 = m[4] / sy, r11 = m[5] / sy, r21 = m[6] / sy;
  const r02 = m[8] / sz, r12 = m[9] / sz, r22 = m[10] / sz;
  const trace = r00 + r11 + r22;
  let x: number, y: number, z: number, w: number;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    w = 0.25 * s; x = (r21 - r12) / s; y = (r02 - r20) / s; z = (r10 - r01) / s;
  } else if (r00 > r11 && r00 > r22) {
    const s = Math.sqrt(1 + r00 - r11 - r22) * 2;
    w = (r21 - r12) / s; x = 0.25 * s; y = (r01 + r10) / s; z = (r02 + r20) / s;
  } else if (r11 > r22) {
    const s = Math.sqrt(1 + r11 - r00 - r22) * 2;
    w = (r02 - r20) / s; x = (r01 + r10) / s; y = 0.25 * s; z = (r12 + r21) / s;
  } else {
    const s = Math.sqrt(1 + r22 - r00 - r11) * 2;
    w = (r10 - r01) / s; x = (r02 + r20) / s; y = (r12 + r21) / s; z = 0.25 * s;
  }
  return { t, r: [x, y, z, w], s: [sx, sy, sz] };
}

function quatSlerp(a: Vec, b: Vec, f: number): Vec {
  let cos = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const bb = b.slice();
  if (cos < 0) { cos = -cos; for (let i = 0; i < 4; i++) bb[i] = -bb[i]; }
  if (cos > 0.9995) {
    const r = [a[0] + (bb[0] - a[0]) * f, a[1] + (bb[1] - a[1]) * f, a[2] + (bb[2] - a[2]) * f, a[3] + (bb[3] - a[3]) * f];
    return normalizeQuat(r);
  }
  const theta = Math.acos(cos);
  const s = Math.sin(theta);
  const wa = Math.sin((1 - f) * theta) / s;
  const wb = Math.sin(f * theta) / s;
  return [a[0] * wa + bb[0] * wb, a[1] * wa + bb[1] * wb, a[2] * wa + bb[2] * wb, a[3] * wa + bb[3] * wb];
}

function normalizeQuat(q: Vec): Vec {
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}

function fmt(n: number): string {
  if (!isFinite(n)) return '0';
  if (Math.abs(n) < 1e-6) return '0';
  const r = Math.round(n * 1e6) / 1e6;
  return Number.isInteger(r) ? String(r) : String(r);
}

// ---- animation sampling --------------------------------------------------

type Sampler = { times: number[]; values: number[]; comp: number; interp: string };

function sampleAt(s: Sampler, t: number, isQuat: boolean): Vec {
  const { times, values, comp, interp } = s;
  const n = times.length;
  const get = (k: number) => values.slice(k * comp, k * comp + comp);
  if (t <= times[0]) return interp === 'CUBICSPLINE' ? values.slice(comp, comp * 2) : get(0);
  if (t >= times[n - 1]) {
    const k = n - 1;
    return interp === 'CUBICSPLINE' ? values.slice(k * 3 * comp + comp, k * 3 * comp + 2 * comp) : get(k);
  }
  let i = 0;
  while (i < n - 1 && times[i + 1] < t) i++;
  const t0 = times[i], t1 = times[i + 1];
  const span = t1 - t0 || 1;
  const f = (t - t0) / span;

  if (interp === 'STEP') return getCubicOrPlain(s, i, false);
  if (interp === 'CUBICSPLINE') {
    const a = i * 3 * comp, b = (i + 1) * 3 * comp;
    const p0 = values.slice(a + comp, a + 2 * comp);
    const m0 = values.slice(a + 2 * comp, a + 3 * comp).map((v) => v * span);
    const p1 = values.slice(b + comp, b + 2 * comp);
    const m1 = values.slice(b, b + comp).map((v) => v * span);
    const s2 = f * f, s3 = s2 * f;
    const h00 = 2 * s3 - 3 * s2 + 1, h10 = s3 - 2 * s2 + f, h01 = -2 * s3 + 3 * s2, h11 = s3 - s2;
    const out = p0.map((_, c) => h00 * p0[c] + h10 * m0[c] + h01 * p1[c] + h11 * m1[c]);
    return isQuat ? normalizeQuat(out) : out;
  }
  // LINEAR
  const A = get(i), B = get(i + 1);
  if (isQuat) return quatSlerp(A, B, f);
  return A.map((v, c) => v + (B[c] - v) * f);
}

function getCubicOrPlain(s: Sampler, i: number, _cubic: boolean): Vec {
  return s.values.slice(i * s.comp, i * s.comp + s.comp);
}

// ---- USD identifier helpers ---------------------------------------------

function ident(name: string | undefined, fallback: string): string {
  let s = (name ?? '').replace(/[^A-Za-z0-9_]/g, '_');
  if (!s || /^[0-9]/.test(s)) s = '_' + s;
  return s || fallback;
}

// ---- main ----------------------------------------------------------------

export function glbToUsdz(data: ArrayBuffer | Uint8Array, opts: UsdzOptions = {}): UsdzResult {
  const fps = opts.fps ?? 60;
  const gltf = Gltf.fromGlb(data);
  const json = gltf.json;
  const nodes = json.nodes ?? [];
  const parentNode: Record<number, number> = {};
  nodes.forEach((nd, i) => (nd.children ?? []).forEach((c) => (parentNode[c] = i)));

  // --- gather transform animation for the chosen clip ---
  const clips = json.animations ?? [];
  let animIndex = opts.animationIndex ?? 0;
  if (opts.animationName) {
    const found = clips.findIndex((a) => a.name === opts.animationName);
    if (found >= 0) animIndex = found;
  }
  const anim = clips[animIndex];
  const unsupportedClips: string[] = [];

  // node index -> { translation/rotation/scale: Sampler }
  const animTracks = new Map<number, { translation?: Sampler; rotation?: Sampler; scale?: Sampler }>();
  let duration = 0;
  if (anim) {
    for (const ch of anim.channels) {
      const node = ch.target.node;
      if (node === undefined) continue;
      if (ch.target.path === 'weights') continue; // morph — unsupported
      const sDef = anim.samplers[ch.sampler];
      const times = gltf.readAccessor(sDef.input).data;
      const outAcc = gltf.readAccessor(sDef.output);
      const comp = ch.target.path === 'rotation' ? 4 : 3;
      const sampler: Sampler = {
        times,
        values: outAcc.data,
        comp,
        interp: sDef.interpolation ?? 'LINEAR',
      };
      duration = Math.max(duration, times[times.length - 1] ?? 0);
      const rec = animTracks.get(node) ?? {};
      (rec as any)[ch.target.path] = sampler;
      animTracks.set(node, rec);
    }
  }
  const animated = animTracks.size > 0 && duration > 0;
  const frameCount = animated ? Math.max(1, Math.round(duration * fps)) : 0;

  // --- emit USD ---
  const L: string[] = [];
  L.push('#usda 1.0');
  L.push('(');
  L.push('    defaultPrim = "Root"');
  L.push('    metersPerUnit = 1');
  L.push('    upAxis = "Y"');
  if (animated) {
    L.push(`    timeCodesPerSecond = ${fps}`);
    L.push('    startTimeCode = 0');
    L.push(`    endTimeCode = ${frameCount}`);
  }
  L.push(')');
  L.push('');

  const extraFiles: ZipEntry[] = [];
  const usedMaterials = new Set<number>();

  // local-matrix for a node at a given time code (or static)
  const nodeStaticMatrix = (n: GltfNode): number[] => {
    if (n.matrix) return n.matrix.slice();
    return composeTRS(n.translation ?? [0, 0, 0], n.rotation ?? [0, 0, 0, 1], n.scale ?? [1, 1, 1]);
  };
  const nodeMatrixAtFrame = (nodeIndex: number, frame: number): number[] => {
    const n = nodes[nodeIndex];
    const tr = animTracks.get(nodeIndex)!;
    const time = frame / fps;
    const t = tr.translation ? sampleAt(tr.translation, time, false) : n.translation ?? [0, 0, 0];
    const r = tr.rotation ? sampleAt(tr.rotation, time, true) : n.rotation ?? [0, 0, 0, 1];
    const s = tr.scale ? sampleAt(tr.scale, time, false) : n.scale ?? [1, 1, 1];
    return composeTRS(t, r, s);
  };

  // Animated local matrix for any node (guards against non-animated nodes).
  const nodeLocalMatAtFrame = (nodeIndex: number, frame: number): number[] =>
    animated && animTracks.has(nodeIndex) ? nodeMatrixAtFrame(nodeIndex, frame) : nodeStaticMatrix(nodes[nodeIndex]);
  // Scene-global (world) matrix for a node at a frame, walking up the hierarchy.
  const nodeGlobalCache = new Map<string, number[]>();
  const nodeGlobalAtFrame = (nodeIndex: number, frame: number): number[] => {
    const key = frame + ':' + nodeIndex;
    const c = nodeGlobalCache.get(key);
    if (c) return c;
    const p = parentNode[nodeIndex];
    const m = p === undefined
      ? nodeLocalMatAtFrame(nodeIndex, frame)
      : mat4mul(nodeGlobalAtFrame(p, frame), nodeLocalMatAtFrame(nodeIndex, frame));
    nodeGlobalCache.set(key, m);
    return m;
  };

  const matrixLiteral = (m: number[]): string =>
    `( (${fmt(m[0])}, ${fmt(m[1])}, ${fmt(m[2])}, ${fmt(m[3])}), ` +
    `(${fmt(m[4])}, ${fmt(m[5])}, ${fmt(m[6])}, ${fmt(m[7])}), ` +
    `(${fmt(m[8])}, ${fmt(m[9])}, ${fmt(m[10])}, ${fmt(m[11])}), ` +
    `(${fmt(m[12])}, ${fmt(m[13])}, ${fmt(m[14])}, ${fmt(m[15])}) )`;

  const emitXformOp = (nodeIndex: number, pad: string) => {
    const n = nodes[nodeIndex];
    if (animated && animTracks.has(nodeIndex)) {
      L.push(`${pad}matrix4d xformOp:transform.timeSamples = {`);
      for (let f = 0; f <= frameCount; f++) {
        L.push(`${pad}    ${f}: ${matrixLiteral(nodeMatrixAtFrame(nodeIndex, f))},`);
      }
      L.push(`${pad}}`);
    } else {
      const m = nodeStaticMatrix(n);
      if (!isIdentity(m)) L.push(`${pad}matrix4d xformOp:transform = ${matrixLiteral(m)}`);
    }
    L.push(`${pad}uniform token[] xformOpOrder = ["xformOp:transform"]`);
  };

  // --- geometry ---
  // skelPath set => emit UsdSkel binding primvars for skinned primitives.
  const emitMesh = (meshIndex: number, primName: string, pad: string, skelPath?: string) => {
    const mesh = json.meshes![meshIndex];
    mesh.primitives.forEach((prim, pi) => {
      if (prim.mode !== undefined && prim.mode !== 4) return; // triangles only
      const pos = gltf.readAccessor(prim.attributes['POSITION']);
      const points: number[] = pos.data;
      const idx = prim.indices !== undefined
        ? gltf.readAccessor(prim.indices).data
        : Array.from({ length: pos.count }, (_, i) => i);
      const name = `${primName}_${pi}`;
      const skinned =
        skelPath !== undefined &&
        prim.attributes['JOINTS_0'] !== undefined &&
        prim.attributes['WEIGHTS_0'] !== undefined;
      // Any prim with a material binding / skinning must apply the matching API
      // schema, or ARKit/RealityKit rejects the file.
      const schemas: string[] = [];
      if (skinned) schemas.push('"SkelBindingAPI"');
      if (prim.material !== undefined) schemas.push('"MaterialBindingAPI"');
      if (schemas.length) {
        L.push(`${pad}def Mesh "${name}" (`);
        L.push(`${pad}    prepend apiSchemas = [${schemas.join(', ')}]`);
        L.push(`${pad})`);
      } else {
        L.push(`${pad}def Mesh "${name}"`);
      }
      L.push(`${pad}{`);
      const p2 = pad + '    ';

      // extent
      let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      for (let i = 0; i < pos.count; i++) {
        const x = points[i * 3], y = points[i * 3 + 1], z = points[i * 3 + 2];
        minX = Math.min(minX, x); minY = Math.min(minY, y); minZ = Math.min(minZ, z);
        maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); maxZ = Math.max(maxZ, z);
      }
      L.push(`${p2}float3[] extent = [(${fmt(minX)}, ${fmt(minY)}, ${fmt(minZ)}), (${fmt(maxX)}, ${fmt(maxY)}, ${fmt(maxZ)})]`);
      L.push(`${p2}int[] faceVertexCounts = [${new Array(idx.length / 3).fill(3).join(', ')}]`);
      L.push(`${p2}int[] faceVertexIndices = [${idx.join(', ')}]`);

      const pts: string[] = [];
      for (let i = 0; i < pos.count; i++) pts.push(`(${fmt(points[i * 3])}, ${fmt(points[i * 3 + 1])}, ${fmt(points[i * 3 + 2])})`);
      L.push(`${p2}point3f[] points = [${pts.join(', ')}]`);

      if (prim.attributes['NORMAL'] !== undefined) {
        const nrm = gltf.readAccessor(prim.attributes['NORMAL']);
        const ns: string[] = [];
        for (let i = 0; i < nrm.count; i++) ns.push(`(${fmt(nrm.data[i * 3])}, ${fmt(nrm.data[i * 3 + 1])}, ${fmt(nrm.data[i * 3 + 2])})`);
        L.push(`${p2}normal3f[] normals = [${ns.join(', ')}] (interpolation = "vertex")`);
      }
      if (prim.attributes['TEXCOORD_0'] !== undefined) {
        const uv = gltf.readAccessor(prim.attributes['TEXCOORD_0']);
        const us: string[] = [];
        for (let i = 0; i < uv.count; i++) us.push(`(${fmt(uv.data[i * 2])}, ${fmt(1 - uv.data[i * 2 + 1])})`);
        L.push(`${p2}texCoord2f[] primvars:st = [${us.join(', ')}] (interpolation = "vertex")`);
      }
      L.push(`${p2}uniform token subdivisionScheme = "none"`);
      if (skinned) {
        const ji = gltf.readAccessor(prim.attributes['JOINTS_0']); // VEC4
        const jw = gltf.readAccessor(prim.attributes['WEIGHTS_0']); // VEC4
        // USDA separates metadata fields by NEWLINES (not commas).
        L.push(`${p2}int[] primvars:skel:jointIndices = [${ji.data.map((v) => v | 0).join(', ')}] (`);
        L.push(`${p2}    elementSize = 4`);
        L.push(`${p2}    interpolation = "vertex"`);
        L.push(`${p2})`);
        L.push(`${p2}float[] primvars:skel:jointWeights = [${jw.data.map(fmt).join(', ')}] (`);
        L.push(`${p2}    elementSize = 4`);
        L.push(`${p2}    interpolation = "vertex"`);
        L.push(`${p2})`);
        L.push(`${p2}matrix4d primvars:skel:geomBindTransform = ( (1, 0, 0, 0), (0, 1, 0, 0), (0, 0, 1, 0), (0, 0, 0, 1) )`);
        L.push(`${p2}rel skel:skeleton = <${skelPath}>`);
      }
      if (prim.material !== undefined) {
        usedMaterials.add(prim.material);
        L.push(`${p2}rel material:binding = </Root/Materials/Material_${prim.material}>`);
      }
      L.push(`${pad}}`);
    });
  };

  // --- node tree ---
  const emitNode = (nodeIndex: number, pad: string) => {
    const n = nodes[nodeIndex];
    const name = ident(n.name, `node_${nodeIndex}`);
    L.push(`${pad}def Xform "${name}_${nodeIndex}"`);
    L.push(`${pad}{`);
    const p2 = pad + '    ';
    emitXformOp(nodeIndex, p2);
    // Skinned meshes are emitted separately under a SkelRoot (their node
    // transform is ignored per the glTF spec).
    if (n.mesh !== undefined && n.skin === undefined) emitMesh(n.mesh, `mesh_${n.mesh}`, p2);
    for (const child of n.children ?? []) emitNode(child, p2);
    L.push(`${pad}}`);
  };

  const sceneNodes = json.scenes?.[json.scene ?? 0]?.nodes ?? nodes.map((_, i) => i).filter((i) => !nodes.some((p) => p.children?.includes(i)));

  // Optional: scale the model to a target real-world size (max dimension).
  let rootScale = 1;
  if (opts.targetSize && opts.targetSize > 0) {
    const mn = [Infinity, Infinity, Infinity];
    const mx = [-Infinity, -Infinity, -Infinity];
    const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const walk = (nodeIndex: number, parent: number[]) => {
      const n = nodes[nodeIndex];
      const world = mat4mul(parent, nodeStaticMatrix(n));
      // skinned meshes are placed by the skeleton, not the node transform
      if (n.mesh !== undefined && n.skin === undefined) {
        for (const prim of json.meshes![n.mesh].primitives) {
          if (prim.attributes['POSITION'] === undefined) continue;
          const pos = gltf.readAccessor(prim.attributes['POSITION']);
          for (let k = 0; k < pos.count; k++) {
            const p = transformPoint(world, [pos.data[k * 3], pos.data[k * 3 + 1], pos.data[k * 3 + 2]]);
            for (let d = 0; d < 3; d++) { mn[d] = Math.min(mn[d], p[d]); mx[d] = Math.max(mx[d], p[d]); }
          }
        }
      }
      for (const c of n.children ?? []) walk(c, world);
    };
    for (const ni of sceneNodes) walk(ni, I);
    const maxDim = Math.max(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]);
    if (isFinite(maxDim) && maxDim > 0) rootScale = opts.targetSize / maxDim;
  }

  // --- skinning (UsdSkel) ---
  type SkinData = { jointNodes: number[]; paths: string[]; bind: number[][]; rest: number[][]; parentJoint: number[] };
  const skinCache = new Map<number, SkinData>();
  const buildSkin = (skinIndex: number): SkinData => {
    const cached = skinCache.get(skinIndex);
    if (cached) return cached;
    const skin = json.skins![skinIndex];
    const jointNodes = skin.joints;
    const count = jointNodes.length;
    const jointIndexOf = new Map<number, number>();
    jointNodes.forEach((nodeIdx, i) => jointIndexOf.set(nodeIdx, i));
    const used = new Set<string>();
    const names = jointNodes.map((nodeIdx, i) => {
      const base = ident(nodes[nodeIdx].name, `joint_${i}`);
      let nm = base, k = 1;
      while (used.has(nm)) nm = `${base}_${k++}`;
      used.add(nm);
      return nm;
    });
    const parentJoint = jointNodes.map((nodeIdx) => {
      const p = parentNode[nodeIdx];
      return p !== undefined && jointIndexOf.has(p) ? jointIndexOf.get(p)! : -1;
    });
    const paths: string[] = new Array(count);
    const pathFor = (i: number): string => {
      if (paths[i]) return paths[i];
      const pj = parentJoint[i];
      return (paths[i] = pj >= 0 ? `${pathFor(pj)}/${names[i]}` : names[i]);
    };
    for (let i = 0; i < count; i++) pathFor(i);
    const ibm = gltf.readAccessor(skin.inverseBindMatrices!).data;
    const bind = jointNodes.map((_, i) => mat4inverse(ibm.slice(i * 16, i * 16 + 16)));
    const rest = bind.map((b, i) => {
      const pj = parentJoint[i];
      return pj >= 0 ? mat4mul(mat4inverse(bind[pj]), b) : b.slice();
    });
    const data: SkinData = { jointNodes, paths, bind, rest, parentJoint };
    skinCache.set(skinIndex, data);
    return data;
  };

  const emitSkinnedNode = (nodeIndex: number, pad: string) => {
    const n = nodes[nodeIndex];
    const sk = buildSkin(n.skin!);
    const rootName = `Skin_${nodeIndex}`;
    const rootPath = `/Root/${rootName}`;
    const skelPath = `${rootPath}/Skel`;
    const jointsTok = `[${sk.paths.map((p) => `"${p}"`).join(', ')}]`;
    const p2 = pad + '    ';
    const p3 = p2 + '    ';

    L.push(`${pad}def SkelRoot "${rootName}"`);
    L.push(`${pad}{`);

    L.push(`${p2}def Skeleton "Skel" (`);
    L.push(`${p2}    prepend apiSchemas = ["SkelBindingAPI"]`);
    L.push(`${p2})`);
    L.push(`${p2}{`);
    L.push(`${p3}uniform token[] joints = ${jointsTok}`);
    L.push(`${p3}uniform matrix4d[] bindTransforms = [${sk.bind.map(matrixLiteral).join(', ')}]`);
    L.push(`${p3}uniform matrix4d[] restTransforms = [${sk.rest.map(matrixLiteral).join(', ')}]`);
    if (animated) L.push(`${p3}rel skel:animationSource = <${rootPath}/Anim>`);
    L.push(`${p2}}`);

    if (animated) {
      // Each joint's transform RELATIVE TO ITS PARENT JOINT, computed from full
      // scene-global matrices. This makes the skeleton-space accumulation in USD
      // reproduce the glTF scene-global pose, even when the skeleton root has
      // non-identity ancestors (which bindTransforms = inverse(IBM) encode).
      const skelLocal = (jointIdx: number, f: number): { t: Vec; r: Vec; s: Vec } => {
        const jn = sk.jointNodes[jointIdx];
        const pj = sk.parentJoint[jointIdx];
        const g = nodeGlobalAtFrame(jn, f);
        const m = pj >= 0 ? mat4mul(mat4inverse(nodeGlobalAtFrame(sk.jointNodes[pj], f)), g) : g;
        return decompose(m);
      };
      const sampleBlock = (label: string, type: string, val: (trs: { t: Vec; r: Vec; s: Vec }) => string) => {
        L.push(`${p3}${type} ${label}.timeSamples = {`);
        for (let f = 0; f <= frameCount; f++) {
          L.push(`${p3}    ${f}: [${sk.jointNodes.map((_, ji) => val(skelLocal(ji, f))).join(', ')}],`);
        }
        L.push(`${p3}}`);
      };
      L.push(`${p2}def SkelAnimation "Anim"`);
      L.push(`${p2}{`);
      L.push(`${p3}uniform token[] joints = ${jointsTok}`);
      sampleBlock('rotations', 'quatf[]', (trs) => quatfLiteral(trs.r));
      sampleBlock('scales', 'half3[]', (trs) => `(${fmt(trs.s[0])}, ${fmt(trs.s[1])}, ${fmt(trs.s[2])})`);
      sampleBlock('translations', 'float3[]', (trs) => `(${fmt(trs.t[0])}, ${fmt(trs.t[1])}, ${fmt(trs.t[2])})`);
      L.push(`${p2}}`);
    }

    emitMesh(n.mesh!, `Mesh_${n.mesh}`, p2, skelPath);
    L.push(`${pad}}`);
  };

  L.push('def Xform "Root"');
  L.push('{');
  if (rootScale !== 1) {
    const s = rootScale;
    L.push(`    matrix4d xformOp:transform = ( (${fmt(s)}, 0, 0, 0), (0, ${fmt(s)}, 0, 0), (0, 0, ${fmt(s)}, 0), (0, 0, 0, 1) )`);
    L.push('    uniform token[] xformOpOrder = ["xformOp:transform"]');
  }
  for (const ni of sceneNodes) emitNode(ni, '    ');
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].skin !== undefined && nodes[i].mesh !== undefined) emitSkinnedNode(i, '    ');
  }

  // --- materials ---
  L.push('    def Scope "Materials"');
  L.push('    {');
  for (const mi of usedMaterials) emitMaterial(mi);
  L.push('    }');
  L.push('}');

  function emitMaterial(mi: number) {
    const mat: GltfMaterial = json.materials?.[mi] ?? {};
    const pbr = mat.pbrMetallicRoughness ?? {};
    const base = pbr.baseColorFactor ?? [1, 1, 1, 1];
    const path = `/Root/Materials/Material_${mi}`;
    const pad = '        ';
    const p2 = pad + '    ';
    L.push(`${pad}def Material "Material_${mi}"`);
    L.push(`${pad}{`);
    L.push(`${p2}token outputs:surface.connect = <${path}/Shader.outputs:surface>`);

    // texture network (only what the material actually uses)
    const texShaders: string[] = [];
    let needSt = false;
    const addTex = (info: TextureInfo | undefined, label: string, raw: boolean): string | null => {
      if (!info) return null;
      const tex = json.textures?.[info.index];
      if (!tex || tex.source === undefined) return null;
      const img = gltf.imageBytes(tex.source);
      if (!img) return null;
      const ext = img.mime.includes('jpeg') || img.mime.includes('jpg') ? 'jpg' : 'png';
      const file = `textures/tex_${tex.source}.${ext}`;
      if (!extraFiles.some((e) => e.name === file)) extraFiles.push({ name: file, data: img.bytes });
      needSt = true;
      const sampler = tex.sampler !== undefined ? json.samplers?.[tex.sampler] : undefined;
      const wrap = (w?: number) => (w === 33071 ? 'clamp' : w === 33648 ? 'mirror' : 'repeat');
      texShaders.push(
        `${p2}def Shader "tex_${label}"\n${p2}{\n` +
        `${p2}    uniform token info:id = "UsdUVTexture"\n` +
        `${p2}    asset inputs:file = @${file}@\n` +
        `${p2}    float2 inputs:st.connect = <${path}/stReader.outputs:result>\n` +
        `${p2}    token inputs:wrapS = "${wrap(sampler?.wrapS)}"\n` +
        `${p2}    token inputs:wrapT = "${wrap(sampler?.wrapT)}"\n` +
        (raw ? `${p2}    token inputs:sourceColorSpace = "raw"\n` : '') +
        `${p2}    float3 outputs:rgb\n${p2}    float outputs:a\n${p2}}`
      );
      return `tex_${label}`;
    };

    const baseTex = addTex(pbr.baseColorTexture, 'baseColor', false);
    const mrTex = addTex(pbr.metallicRoughnessTexture, 'metallicRoughness', true);
    const normTex = addTex(mat.normalTexture, 'normal', true);
    const emisTex = addTex(mat.emissiveTexture, 'emissive', false);
    const occTex = addTex(mat.occlusionTexture, 'occlusion', true);
    const emissive = mat.emissiveFactor ?? [0, 0, 0];

    L.push(`${p2}def Shader "Shader"`);
    L.push(`${p2}{`);
    const p3 = p2 + '    ';
    L.push(`${p3}uniform token info:id = "UsdPreviewSurface"`);
    if (baseTex) L.push(`${p3}color3f inputs:diffuseColor.connect = <${path}/${baseTex}.outputs:rgb>`);
    else L.push(`${p3}color3f inputs:diffuseColor = (${fmt(base[0])}, ${fmt(base[1])}, ${fmt(base[2])})`);
    if (baseTex && (mat.alphaMode === 'BLEND' || mat.alphaMode === 'MASK')) {
      L.push(`${p3}float inputs:opacity.connect = <${path}/${baseTex}.outputs:a>`);
    } else if (base[3] < 1) {
      L.push(`${p3}float inputs:opacity = ${fmt(base[3])}`);
    }
    if (mrTex) {
      L.push(`${p3}float inputs:roughness.connect = <${path}/${mrTex}.outputs:g>`);
      L.push(`${p3}float inputs:metallic.connect = <${path}/${mrTex}.outputs:b>`);
    } else {
      L.push(`${p3}float inputs:roughness = ${fmt(pbr.roughnessFactor ?? 1)}`);
      L.push(`${p3}float inputs:metallic = ${fmt(pbr.metallicFactor ?? 1)}`);
    }
    if (emisTex) L.push(`${p3}color3f inputs:emissiveColor.connect = <${path}/${emisTex}.outputs:rgb>`);
    else if (emissive.some((v) => v > 0)) L.push(`${p3}color3f inputs:emissiveColor = (${fmt(emissive[0])}, ${fmt(emissive[1])}, ${fmt(emissive[2])})`);
    if (normTex) L.push(`${p3}normal3f inputs:normal.connect = <${path}/${normTex}.outputs:rgb>`);
    if (occTex) L.push(`${p3}float inputs:occlusion.connect = <${path}/${occTex}.outputs:r>`);
    L.push(`${p3}int inputs:useSpecularWorkflow = 0`);
    L.push(`${p3}token outputs:surface`);
    L.push(`${p2}}`);

    if (needSt) {
      L.push(`${p2}def Shader "stReader"`);
      L.push(`${p2}{`);
      L.push(`${p2}    uniform token info:id = "UsdPrimvarReader_float2"`);
      L.push(`${p2}    token inputs:varname = "st"`);
      L.push(`${p2}    float2 outputs:result`);
      L.push(`${p2}}`);
    }
    for (const s of texShaders) L.push(s);
    L.push(`${pad}}`);
  }

  const usda = new TextEncoder().encode(L.join('\n') + '\n');
  const entries: ZipEntry[] = [{ name: 'model.usda', data: usda }, ...extraFiles];
  const usdz = createUsdz(entries);

  let skinnedMeshes = 0;
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].skin !== undefined && nodes[i].mesh !== undefined) skinnedMeshes++;
  }
  let morphMeshesIgnored = 0;
  for (const m of json.meshes ?? []) {
    if (m.primitives.some((p) => p.targets && p.targets.length > 0)) morphMeshesIgnored++;
  }

  return {
    usdz,
    animated,
    unsupportedClips,
    frameCount,
    fps,
    skinnedMeshes,
    morphMeshesIgnored,
    clipName: anim?.name,
  };
}

function isIdentity(m: number[]): boolean {
  const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  for (let i = 0; i < 16; i++) if (Math.abs(m[i] - I[i]) > 1e-9) return false;
  return true;
}
