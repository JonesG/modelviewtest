// Minimal glTF 2.0 / GLB parser — just enough to drive a GLB→USDZ converter.
// No three.js: we read the binary directly so the same code runs in the browser
// and in Node. Supports GLB (single binary chunk) and data: URI buffers/images.

export type GltfJson = {
  asset?: { version?: string };
  scene?: number;
  scenes?: { nodes?: number[] }[];
  nodes?: GltfNode[];
  meshes?: GltfMesh[];
  materials?: GltfMaterial[];
  accessors?: GltfAccessor[];
  bufferViews?: GltfBufferView[];
  buffers?: { byteLength: number; uri?: string }[];
  animations?: GltfAnimation[];
  skins?: GltfSkin[];
  images?: { bufferView?: number; mimeType?: string; uri?: string }[];
  textures?: { source?: number; sampler?: number }[];
  samplers?: { wrapS?: number; wrapT?: number }[];
};

export type GltfSkin = {
  joints: number[];
  inverseBindMatrices?: number;
  skeleton?: number;
};

export type GltfNode = {
  name?: string;
  children?: number[];
  matrix?: number[]; // column-major 16
  translation?: [number, number, number];
  rotation?: [number, number, number, number]; // x,y,z,w
  scale?: [number, number, number];
  mesh?: number;
  skin?: number;
};

export type GltfMesh = { name?: string; primitives: GltfPrimitive[] };

export type GltfPrimitive = {
  attributes: Record<string, number>;
  indices?: number;
  material?: number;
  mode?: number; // 4 = TRIANGLES (the only mode we support)
  targets?: Record<string, number>[]; // morph targets (not yet emitted)
};

export type TextureInfo = { index: number; texCoord?: number; scale?: number; strength?: number };

export type GltfMaterial = {
  name?: string;
  pbrMetallicRoughness?: {
    baseColorFactor?: [number, number, number, number];
    baseColorTexture?: TextureInfo;
    metallicFactor?: number;
    roughnessFactor?: number;
    metallicRoughnessTexture?: TextureInfo;
  };
  normalTexture?: TextureInfo;
  occlusionTexture?: TextureInfo;
  emissiveTexture?: TextureInfo;
  emissiveFactor?: [number, number, number];
  alphaMode?: 'OPAQUE' | 'MASK' | 'BLEND';
  doubleSided?: boolean;
};

export type GltfAccessor = {
  bufferView?: number;
  byteOffset?: number;
  componentType: number;
  normalized?: boolean;
  count: number;
  type: 'SCALAR' | 'VEC2' | 'VEC3' | 'VEC4' | 'MAT4';
};

export type GltfBufferView = {
  buffer: number;
  byteOffset?: number;
  byteLength: number;
  byteStride?: number;
};

export type GltfAnimation = {
  name?: string;
  channels: { sampler: number; target: { node?: number; path: string } }[];
  samplers: { input: number; output: number; interpolation?: 'LINEAR' | 'STEP' | 'CUBICSPLINE' }[];
};

const COMPONENT_BYTES: Record<number, number> = {
  5120: 1, // BYTE
  5121: 1, // UNSIGNED_BYTE
  5122: 2, // SHORT
  5123: 2, // UNSIGNED_SHORT
  5125: 4, // UNSIGNED_INT
  5126: 4, // FLOAT
};

const TYPE_COMPONENTS: Record<string, number> = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT4: 16,
};

export class Gltf {
  json: GltfJson;
  private buffers: Uint8Array[];

  constructor(json: GltfJson, buffers: Uint8Array[]) {
    this.json = json;
    this.buffers = buffers;
  }

  /** Parse a .glb ArrayBuffer/Uint8Array. */
  static fromGlb(data: ArrayBuffer | Uint8Array): Gltf {
    const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const magic = dv.getUint32(0, true);
    if (magic !== 0x46546c67) throw new Error('Not a GLB (bad magic)');

    let offset = 12;
    let json: GltfJson | null = null;
    let bin: Uint8Array | null = null;
    while (offset < u8.byteLength) {
      const chunkLen = dv.getUint32(offset, true);
      const chunkType = dv.getUint32(offset + 4, true);
      const chunkData = u8.subarray(offset + 8, offset + 8 + chunkLen);
      if (chunkType === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(chunkData));
      else if (chunkType === 0x004e4942) bin = chunkData;
      offset += 8 + chunkLen;
    }
    if (!json) throw new Error('GLB has no JSON chunk');

    const buffers = (json.buffers ?? []).map((b, i) => {
      if (!b.uri) {
        if (!bin) throw new Error('GLB buffer references missing BIN chunk');
        return bin!;
      }
      if (b.uri.startsWith('data:')) return decodeDataUri(b.uri);
      throw new Error(`External buffer URIs are not supported (buffer ${i})`);
    });

    return new Gltf(json, buffers);
  }

  bufferViewBytes(viewIndex: number): Uint8Array {
    const view = this.json.bufferViews![viewIndex];
    const buf = this.buffers[view.buffer];
    const start = view.byteOffset ?? 0;
    return buf.subarray(start, start + view.byteLength);
  }

  /** Read an accessor into a flat number[] (grouped element-by-element by the caller). */
  readAccessor(index: number): { data: number[]; components: number; count: number } {
    const acc = this.json.accessors![index];
    const components = TYPE_COMPONENTS[acc.type];
    const compBytes = COMPONENT_BYTES[acc.componentType];
    const count = acc.count;
    const out: number[] = new Array(count * components);

    if (acc.bufferView === undefined) {
      out.fill(0); // sparse/empty accessor — treat as zeros
      return { data: out, components, count };
    }
    const view = this.json.bufferViews![acc.bufferView];
    const buf = this.buffers[view.buffer];
    const baseOffset = (view.byteOffset ?? 0) + (acc.byteOffset ?? 0);
    const stride = view.byteStride ?? components * compBytes;
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

    for (let i = 0; i < count; i++) {
      const elemOffset = baseOffset + i * stride;
      for (let c = 0; c < components; c++) {
        const o = elemOffset + c * compBytes;
        let v: number;
        switch (acc.componentType) {
          case 5120: v = dv.getInt8(o); if (acc.normalized) v = Math.max(v / 127, -1); break;
          case 5121: v = dv.getUint8(o); if (acc.normalized) v = v / 255; break;
          case 5122: v = dv.getInt16(o, true); if (acc.normalized) v = Math.max(v / 32767, -1); break;
          case 5123: v = dv.getUint16(o, true); if (acc.normalized) v = v / 65535; break;
          case 5125: v = dv.getUint32(o, true); break;
          case 5126: v = dv.getFloat32(o, true); break;
          default: throw new Error(`Unsupported componentType ${acc.componentType}`);
        }
        out[i * components + c] = v;
      }
    }
    return { data: out, components, count };
  }

  /** Raw bytes + mime for an image (bufferView or data: URI). */
  imageBytes(imageIndex: number): { bytes: Uint8Array; mime: string } | null {
    const img = this.json.images?.[imageIndex];
    if (!img) return null;
    if (img.bufferView !== undefined) {
      return { bytes: this.bufferViewBytes(img.bufferView), mime: img.mimeType ?? 'image/png' };
    }
    if (img.uri?.startsWith('data:')) {
      const mime = img.uri.slice(5, img.uri.indexOf(';'));
      return { bytes: decodeDataUri(img.uri), mime: mime || 'image/png' };
    }
    return null; // external image URIs unsupported
  }
}

function decodeDataUri(uri: string): Uint8Array {
  const comma = uri.indexOf(',');
  const meta = uri.slice(5, comma);
  const dataPart = uri.slice(comma + 1);
  if (meta.includes('base64')) {
    if (typeof atob === 'function') {
      const bin = atob(dataPart);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
    // Node fallback
    return new Uint8Array(Buffer.from(dataPart, 'base64'));
  }
  return new TextEncoder().encode(decodeURIComponent(dataPart));
}
