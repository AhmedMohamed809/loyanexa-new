import { inflateSync } from 'node:zlib';

export interface DecodedImage {
  width: number;
  height: number;
  rgba: Uint8Array;
}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// Matches jpeg-js's own default cap (maxResolutionInMP: 100 in jpeg.ts) so
// neither decoder in this package is the unguarded one. Width/height in
// IHDR are attacker-controlled — a ~1MB file can declare 30000x30000 and
// force multi-gigabyte allocations before decompression even starts, which
// is a denial-of-service surface on the merchant-upload path (decodeImage).
const MAX_PIXELS = 100_000_000;

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Decode an 8-bit, non-interlaced PNG to RGBA. */
export function decodePNG(buf: Uint8Array): DecodedImage {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  if (b.length < 8) throw new Error('truncated: shorter than the PNG signature');
  for (let i = 0; i < 8; i++) {
    if (b[i] !== SIGNATURE[i]) throw new Error('bad PNG signature');
  }

  let width = 0;
  let height = 0;
  let colourType = 6;
  let palette: Uint8Array | undefined;
  let transparency: Uint8Array | undefined;
  const idat: Buffer[] = [];
  let sawIEND = false;

  let o = 8;
  while (o + 8 <= b.length) {
    const len = b.readUInt32BE(o);
    const type = b.subarray(o + 4, o + 8).toString('latin1');
    const end = o + 8 + len;
    if (end + 4 > b.length) throw new Error(`truncated: chunk ${type} runs past end of file`);
    const data = b.subarray(o + 8, end);

    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (width * height > MAX_PIXELS) {
        throw new Error(
          `image too large: ${width}x${height} (${width * height} pixels) exceeds the ${MAX_PIXELS}-pixel limit`
        );
      }
      const depth = data[8]!;
      colourType = data[9]!;
      if (depth !== 8) throw new Error(`unsupported bit depth ${depth}; only 8 is supported`);
      if (data[12] !== 0) throw new Error('interlaced PNGs are not supported');
    } else if (type === 'PLTE') {
      palette = Uint8Array.from(data);
    } else if (type === 'tRNS') {
      transparency = Uint8Array.from(data);
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      sawIEND = true;
      break;
    }
    o = end + 4;
  }

  if (!sawIEND) throw new Error('truncated: no IEND chunk');
  if (idat.length === 0) throw new Error('truncated: no IDAT data');

  const channels = colourType === 0 ? 1 : colourType === 2 ? 3 : colourType === 3 ? 1 : colourType === 4 ? 2 : 4;
  const stride = width * channels;
  // Exact expected size of the decompressed scanline data (one filter byte
  // plus `stride` pixel bytes per row). Bounded transitively by the
  // MAX_PIXELS check above, and belt-and-braces against a decompression
  // bomb where the IDAT payload doesn't match what IHDR declared.
  const raw = inflateSync(Buffer.concat(idat), { maxOutputLength: (stride + 1) * height });

  // Undo per-scanline filtering in place.
  const lines = new Uint8Array(stride * height);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = new Uint8Array(stride);
    for (let x = 0; x < stride; x++) {
      const rv = row[x]!;
      const a = x >= channels ? cur[x - channels]! : 0;
      const up = prev[x]!;
      const ul = x >= channels ? prev[x - channels]! : 0;
      let v: number;
      switch (filter) {
        case 0: v = rv; break;
        case 1: v = rv + a; break;
        case 2: v = rv + up; break;
        case 3: v = rv + ((a + up) >> 1); break;
        case 4: v = rv + paeth(a, up, ul); break;
        default: throw new Error(`unknown filter type ${filter} on row ${y}`);
      }
      cur[x] = v & 0xff;
    }
    lines.set(cur, y * stride);
    prev = cur;
  }

  // Expand whatever colour type we got into straight RGBA.
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0, p = 0; i < width * height; i++, p += 4) {
    const s = i * channels;
    if (colourType === 6) {
      rgba[p] = lines[s]!; rgba[p + 1] = lines[s + 1]!; rgba[p + 2] = lines[s + 2]!; rgba[p + 3] = lines[s + 3]!;
    } else if (colourType === 2) {
      rgba[p] = lines[s]!; rgba[p + 1] = lines[s + 1]!; rgba[p + 2] = lines[s + 2]!; rgba[p + 3] = 255;
    } else if (colourType === 0) {
      const g = lines[s]!;
      rgba[p] = g; rgba[p + 1] = g; rgba[p + 2] = g; rgba[p + 3] = 255;
    } else if (colourType === 4) {
      const g = lines[s]!;
      rgba[p] = g; rgba[p + 1] = g; rgba[p + 2] = g; rgba[p + 3] = lines[s + 1]!;
    } else if (colourType === 3) {
      if (!palette) throw new Error('palette image with no PLTE chunk');
      const idx = lines[s]!;
      rgba[p] = palette[idx * 3] ?? 0;
      rgba[p + 1] = palette[idx * 3 + 1] ?? 0;
      rgba[p + 2] = palette[idx * 3 + 2] ?? 0;
      rgba[p + 3] = transparency ? (transparency[idx] ?? 255) : 255;
    } else {
      throw new Error(`unsupported colour type ${colourType}`);
    }
  }

  return { width, height, rgba };
}
