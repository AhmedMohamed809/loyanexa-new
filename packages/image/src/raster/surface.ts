export interface RGBA {
  r: number;
  g: number;
  b: number;
  /** 0–1 */
  a: number;
}

export function parseHexColor(hex: string, alpha = 1): RGBA {
  const h = hex.startsWith('#') ? hex.slice(1) : hex;
  const full =
    h.length === 3 ? h[0]! + h[0]! + h[1]! + h[1]! + h[2]! + h[2]! : h;
  if (full.length !== 6 || !/^[0-9a-fA-F]{6}$/.test(full)) {
    throw new Error(`invalid colour: ${hex}`);
  }
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
    a: alpha,
  };
}

/** A straight-alpha RGBA raster that composites source-over. */
export class Surface {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;

  constructor(width: number, height: number) {
    if (width <= 0 || height <= 0) throw new RangeError('surface must be at least 1x1');
    this.width = width;
    this.height = height;
    this.data = new Uint8ClampedArray(width * height * 4);
  }

  fill(c: RGBA): void {
    const a = Math.round(c.a * 255);
    for (let i = 0; i < this.data.length; i += 4) {
      this.data[i] = c.r;
      this.data[i + 1] = c.g;
      this.data[i + 2] = c.b;
      this.data[i + 3] = a;
    }
  }

  /** Composite `c` over the pixel at (x, y) with `coverage` in 0–1. */
  blend(x: number, y: number, c: RGBA, coverage: number): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const sa = c.a * coverage;
    if (sa <= 0) return;
    const i = (y * this.width + x) * 4;
    const da = this.data[i + 3]! / 255;
    const outA = sa + da * (1 - sa);
    if (outA <= 0) return;
    this.data[i] = (c.r * sa + this.data[i]! * da * (1 - sa)) / outA;
    this.data[i + 1] = (c.g * sa + this.data[i + 1]! * da * (1 - sa)) / outA;
    this.data[i + 2] = (c.b * sa + this.data[i + 2]! * da * (1 - sa)) / outA;
    this.data[i + 3] = outA * 255;
  }

  toRGBA(): Uint8Array {
    return new Uint8Array(this.data.buffer, this.data.byteOffset, this.data.byteLength);
  }
}
