import { encodePNG } from './png/encode.ts';
import { Surface, parseHexColor } from './raster/surface.ts';

type Version = 1 | 2 | 3 | 4;

// Data codewords / EC codewords for ECC level L, versions 1-4 (single RS
// block — versions 1-4 never split into multiple blocks at level L).
const CAP: Record<Version, number> = { 1: 19, 2: 34, 3: 55, 4: 80 };
const ECW: Record<Version, number> = { 1: 7, 2: 10, 3: 15, 4: 20 };
const ALIGNMENT_CENTER: Record<2 | 3 | 4, number> = { 2: 18, 3: 22, 4: 26 };

/**
 * Minimal but correct QR encoder — byte mode, ECC level L, versions 1..4.
 *
 * Ported from prototype/index.html's `qrMatrix` (GF(256) Reed-Solomon with
 * primitive 0x11D, mask patterns 0-7, alignment patterns for versions 2-4).
 * Structural correctness (finder patterns, matrix size, determinism, a
 * representative enrol-URL length) is verified in qr.test.ts.
 */
export function qrMatrix(text: string, forceMask?: number): boolean[][] {
  const bytes = [...new TextEncoder().encode(text)];
  let ver: Version | 0 = 0;
  for (const v of [1, 2, 3, 4] as const) {
    if (bytes.length + 2 <= CAP[v]) {
      ver = v;
      break;
    }
  }
  if (!ver) throw new Error(`text too long for QR versions 1-4: ${bytes.length} bytes`);
  const size = 17 + 4 * ver;
  const cap = CAP[ver];
  const ecn = ECW[ver];

  // ---- bit stream: mode(0100) + count(8) + data ----
  const bits: number[] = [];
  const put = (val: number, len: number): void => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1);
  };
  put(0b0100, 4);
  put(bytes.length, 8);
  for (const b of bytes) put(b, 8);
  put(0, Math.min(4, cap * 8 - bits.length)); // terminator
  while (bits.length % 8) bits.push(0);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  }
  const PAD = [0xec, 0x11];
  for (let i = 0; data.length < cap; i++) data.push(PAD[i % 2]!);

  // ---- Reed-Solomon over GF(256), primitive 0x11D ----
  const EXP = new Array<number>(512).fill(0);
  const LOG = new Array<number>(256).fill(0);
  for (let i = 0, x = 1; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]!;
  const mul = (a: number, b: number): number => (a === 0 || b === 0 ? 0 : EXP[LOG[a]! + LOG[b]!]!);

  let gen: number[] = [1];
  for (let i = 0; i < ecn; i++) {
    const next = new Array<number>(gen.length + 1).fill(0);
    for (let j = 0; j < gen.length; j++) {
      next[j] = next[j]! ^ gen[j]!;
      next[j + 1] = next[j + 1]! ^ mul(gen[j]!, EXP[i]!);
    }
    gen = next;
  }
  const rem = new Array<number>(ecn).fill(0);
  for (const d of data) {
    const factor = d ^ rem[0]!;
    rem.shift();
    rem.push(0);
    for (let j = 0; j < ecn; j++) rem[j] = rem[j]! ^ mul(gen[j + 1]!, factor);
  }
  const all = [...data, ...rem];

  // ---- matrix ----
  const m: (0 | 1 | null)[][] = Array.from({ length: size }, () => new Array<0 | 1 | null>(size).fill(null));
  const set = (r: number, c: number, v: 0 | 1): void => {
    if (r >= 0 && r < size && c >= 0 && c < size) m[r]![c] = v;
  };

  const finder = (r: number, c: number): void => {
    for (let i = -1; i <= 7; i++) {
      for (let j = -1; j <= 7; j++) {
        const inside = i >= 0 && i < 7 && j >= 0 && j < 7;
        const dark = inside && (i === 0 || i === 6 || j === 0 || j === 6 || (i >= 2 && i <= 4 && j >= 2 && j <= 4));
        set(r + i, c + j, dark ? 1 : 0);
      }
    }
  };
  finder(0, 0);
  finder(0, size - 7);
  finder(size - 7, 0);

  for (let i = 8; i < size - 8; i++) {
    // timing pattern
    const b: 0 | 1 = i % 2 === 0 ? 1 : 0;
    set(6, i, b);
    set(i, 6, b);
  }

  if (ver >= 2) {
    // alignment pattern
    const c = ALIGNMENT_CENTER[ver as 2 | 3 | 4];
    for (let i = -2; i <= 2; i++) {
      for (let j = -2; j <= 2; j++) {
        set(c + i, c + j, Math.abs(i) === 2 || Math.abs(j) === 2 || (i === 0 && j === 0) ? 1 : 0);
      }
    }
  }
  set(size - 8, 8, 1); // dark module
  for (let i = 0; i < 9; i++) {
    // format info reserve
    if (m[8]![i] === null) set(8, i, 0);
    if (m[i]![8] === null) set(i, 8, 0);
  }
  for (let i = 0; i < 8; i++) {
    set(8, size - 1 - i, 0);
    set(size - 1 - i, 8, 0);
  }

  // ---- data placement (zigzag, upward/downward columns) ----
  const mask = forceMask ?? 0;
  const MASKS: Array<(r: number, c: number) => boolean> = [
    (r, c) => (r + c) % 2 === 0,
    (r, c) => r % 2 === 0,
    (r, c) => c % 3 === 0,
    (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r, c) => (r * c) % 2 + (r * c) % 3 === 0,
    (r, c) => ((r * c) % 2 + (r * c) % 3) % 2 === 0,
    (r, c) => ((r + c) % 2 + (r * c) % 3) % 2 === 0,
  ];
  const maskFn = MASKS[mask] ?? MASKS[0]!;
  let bi = 0;
  let up = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--; // skip timing column
    for (let k = 0; k < size; k++) {
      const row = up ? size - 1 - k : k;
      for (const c of [col, col - 1]) {
        if (m[row]![c] !== null) continue;
        let bit = 0;
        if (bi < all.length * 8) bit = (all[bi >> 3]! >> (7 - (bi & 7))) & 1;
        bi++;
        m[row]![c] = maskFn(row, c) ? ((bit ^ 1) as 0 | 1) : (bit as 0 | 1);
      }
    }
    up = !up;
  }

  // ---- format info: ECC L = 01, BCH(15,5) ----
  const fmtData = (0b01 << 3) | mask;
  let v = fmtData << 10;
  for (let i = 4; i >= 0; i--) {
    if ((v >> (i + 10)) & 1) v ^= 0b10100110111 << i;
  }
  const fmt = ((fmtData << 10) | v) ^ 0b101010000010010;
  for (let i = 0; i < 15; i++) {
    const b: 0 | 1 = ((fmt >> i) & 1) as 0 | 1;
    if (i < 6) set(i, 8, b);
    else if (i < 8) set(i + 1, 8, b);
    else set(size - 15 + i, 8, b);
    if (i < 8) set(8, size - 1 - i, b);
    else if (i === 8) set(8, 7, b);
    else set(8, 14 - i, b);
  }
  set(size - 8, 8, 1);

  return m.map((row) =>
    row.map((cell) => {
      if (cell === null) throw new Error('qrMatrix: unfilled module — encoder bug');
      return cell === 1;
    })
  );
}

/**
 * Render a QR matrix as a PNG, `moduleSize` px per module plus a
 * `quietZone`-module blank border on every side (the border a scanner needs
 * to lock onto the finder patterns).
 */
export function renderQrPng(text: string, moduleSize = 6, quietZone = 4): Buffer {
  if (!Number.isInteger(moduleSize) || moduleSize < 1) {
    throw new RangeError(`moduleSize must be a positive integer, got ${moduleSize}`);
  }
  if (!Number.isInteger(quietZone) || quietZone < 0) {
    throw new RangeError(`quietZone must be a non-negative integer, got ${quietZone}`);
  }

  const matrix = qrMatrix(text);
  const size = matrix.length;
  const px = (size + quietZone * 2) * moduleSize;
  const surface = new Surface(px, px);
  const white = parseHexColor('#ffffff', 1);
  const black = parseHexColor('#000000', 1);
  surface.fill(white);

  for (let r = 0; r < size; r++) {
    const row = matrix[r]!;
    for (let c = 0; c < size; c++) {
      if (!row[c]) continue;
      const x0 = (c + quietZone) * moduleSize;
      const y0 = (r + quietZone) * moduleSize;
      for (let y = 0; y < moduleSize; y++) {
        for (let x = 0; x < moduleSize; x++) {
          surface.blend(x0 + x, y0 + y, black, 1);
        }
      }
    }
  }

  return encodePNG(surface.toRGBA(), px, px);
}
