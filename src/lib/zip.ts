// Minimal ZIP writer that produces USDZ-compliant archives.
//
// USDZ is just a zip with strict rules (per the USD spec / Apple):
//   - every file is STORED (compression method 0), never deflated;
//   - each file's DATA must begin at a 64-byte-aligned offset in the archive,
//     achieved by padding the local header's "extra" field;
//   - the first file should be the root layer (the .usda).
// Readers (USD / Quick Look) ignore the extra-field padding bytes.

export type ZipEntry = { name: string; data: Uint8Array };

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const LOCAL_HEADER = 30; // bytes before the (name + extra) fields
const ALIGN = 64;

/** Pack entries into a USDZ-compliant (aligned, stored) zip archive. */
export function createUsdz(entries: ZipEntry[]): Uint8Array {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  let offset = 0;
  const central: Uint8Array[] = [];

  const push = (b: Uint8Array) => {
    chunks.push(b);
    offset += b.length;
  };

  for (const entry of entries) {
    const nameBytes = enc.encode(entry.name);
    const crc = crc32(entry.data);
    const size = entry.data.length;

    // Pad the extra field so the file DATA lands on a 64-byte boundary.
    const dataStartNoExtra = offset + LOCAL_HEADER + nameBytes.length;
    let extra = (ALIGN - (dataStartNoExtra % ALIGN)) % ALIGN;
    // A zip extra field can't be 1..3 bytes (it needs a 4-byte id+len header),
    // so bump by a full block if the required padding is too small to express.
    if (extra > 0 && extra < 4) extra += ALIGN;

    const local = new Uint8Array(LOCAL_HEADER + nameBytes.length + extra);
    const dv = new DataView(local.buffer);
    dv.setUint32(0, 0x04034b50, true); // local file header signature
    dv.setUint16(4, 20, true); // version needed
    dv.setUint16(6, 0, true); // flags
    dv.setUint16(8, 0, true); // method = store
    dv.setUint16(10, 0, true); // mod time
    dv.setUint16(12, 0, true); // mod date
    dv.setUint32(14, crc, true);
    dv.setUint32(18, size, true); // compressed size
    dv.setUint32(22, size, true); // uncompressed size
    dv.setUint16(26, nameBytes.length, true);
    dv.setUint16(28, extra, true);
    local.set(nameBytes, LOCAL_HEADER);
    if (extra >= 4) {
      // Dummy extra field: id 0x0000, payload length = extra-4, zero-filled.
      dv.setUint16(LOCAL_HEADER + nameBytes.length, 0x0000, true);
      dv.setUint16(LOCAL_HEADER + nameBytes.length + 2, extra - 4, true);
    }

    const localHeaderOffset = offset;
    push(local);
    push(entry.data);

    // Build the matching central-directory record (no extra field needed here).
    const cd = new Uint8Array(46 + nameBytes.length);
    const cdv = new DataView(cd.buffer);
    cdv.setUint32(0, 0x02014b50, true); // central dir signature
    cdv.setUint16(4, 20, true); // version made by
    cdv.setUint16(6, 20, true); // version needed
    cdv.setUint16(8, 0, true);
    cdv.setUint16(10, 0, true); // method = store
    cdv.setUint16(12, 0, true);
    cdv.setUint16(14, 0, true);
    cdv.setUint32(16, crc, true);
    cdv.setUint32(20, size, true);
    cdv.setUint32(24, size, true);
    cdv.setUint16(28, nameBytes.length, true);
    cdv.setUint16(30, 0, true); // extra len
    cdv.setUint16(32, 0, true); // comment len
    cdv.setUint16(34, 0, true); // disk number
    cdv.setUint16(36, 0, true); // internal attrs
    cdv.setUint32(38, 0, true); // external attrs
    cdv.setUint32(42, localHeaderOffset, true);
    cd.set(nameBytes, 46);
    central.push(cd);
  }

  const centralStart = offset;
  let centralSize = 0;
  for (const cd of central) {
    push(cd);
    centralSize += cd.length;
  }

  const end = new Uint8Array(22);
  const edv = new DataView(end.buffer);
  edv.setUint32(0, 0x06054b50, true); // end of central directory signature
  edv.setUint16(8, entries.length, true);
  edv.setUint16(10, entries.length, true);
  edv.setUint32(12, centralSize, true);
  edv.setUint32(16, centralStart, true);
  push(end);

  const out = new Uint8Array(offset);
  let p = 0;
  for (const c of chunks) {
    out.set(c, p);
    p += c.length;
  }
  return out;
}
