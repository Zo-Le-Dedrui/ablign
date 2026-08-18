/**
 * Iterative radix-2 FFT, used to compute the YIN difference function via
 * correlation. Brute-force YIN is O(window x lag) per frame, which is seconds of
 * work for a few bars of audio; the FFT route brings it down to something that
 * fits comfortably inside a progress dialog.
 */
export class Fft {
  readonly size: number;
  private readonly cos: Float64Array;
  private readonly sin: Float64Array;
  private readonly reversed: Uint32Array;

  constructor(size: number) {
    if (size < 2 || (size & (size - 1)) !== 0) {
      throw new Error(`FFT size must be a power of two, got ${size}.`);
    }
    this.size = size;
    this.cos = new Float64Array(size / 2);
    this.sin = new Float64Array(size / 2);
    for (let i = 0; i < size / 2; i++) {
      this.cos[i] = Math.cos((-2 * Math.PI * i) / size);
      this.sin[i] = Math.sin((-2 * Math.PI * i) / size);
    }

    const bits = Math.log2(size);
    this.reversed = new Uint32Array(size);
    for (let i = 0; i < size; i++) {
      let value = 0;
      for (let bit = 0; bit < bits; bit++) {
        value = (value << 1) | ((i >>> bit) & 1);
      }
      this.reversed[i] = value;
    }
  }

  /** In-place forward transform. */
  forward(re: Float64Array, im: Float64Array): void {
    const { size, reversed, cos, sin } = this;

    for (let i = 0; i < size; i++) {
      const j = reversed[i]!;
      if (j > i) {
        const tr = re[i]!;
        re[i] = re[j]!;
        re[j] = tr;
        const ti = im[i]!;
        im[i] = im[j]!;
        im[j] = ti;
      }
    }

    for (let span = 2; span <= size; span <<= 1) {
      const half = span >> 1;
      const step = size / span;
      for (let start = 0; start < size; start += span) {
        for (let k = 0; k < half; k++) {
          const twiddle = k * step;
          const wr = cos[twiddle]!;
          const wi = sin[twiddle]!;
          const a = start + k;
          const b = a + half;
          const xr = re[b]! * wr - im[b]! * wi;
          const xi = re[b]! * wi + im[b]! * wr;
          re[b] = re[a]! - xr;
          im[b] = im[a]! - xi;
          re[a] = re[a]! + xr;
          im[a] = im[a]! + xi;
        }
      }
    }
  }

  /** In-place inverse transform (scaled by 1/size). */
  inverse(re: Float64Array, im: Float64Array): void {
    for (let i = 0; i < this.size; i++) im[i] = -im[i]!;
    this.forward(re, im);
    const scale = 1 / this.size;
    for (let i = 0; i < this.size; i++) {
      re[i] = re[i]! * scale;
      im[i] = -im[i]! * scale;
    }
  }
}

export const nextPowerOfTwo = (value: number): number => {
  let size = 1;
  while (size < value) size <<= 1;
  return size;
};

/**
 * Correlator for a fixed window/lag geometry.
 *
 * `correlate` returns r[tau] = sum over j in [0, window) of x[j] * x[j + tau],
 * for tau in [0, maxLag]. Reuses its scratch buffers across frames.
 */
export class Correlator {
  private readonly fft: Fft;
  private readonly re1: Float64Array;
  private readonly im1: Float64Array;
  private readonly re2: Float64Array;
  private readonly im2: Float64Array;
  readonly output: Float64Array;

  constructor(
    readonly window: number,
    readonly maxLag: number,
  ) {
    const span = window + maxLag;
    this.fft = new Fft(nextPowerOfTwo(window + span));
    const size = this.fft.size;
    this.re1 = new Float64Array(size);
    this.im1 = new Float64Array(size);
    this.re2 = new Float64Array(size);
    this.im2 = new Float64Array(size);
    this.output = new Float64Array(maxLag + 1);
  }

  correlate(signal: Float32Array, offset: number): Float64Array {
    const { re1, im1, re2, im2, fft, window, maxLag } = this;
    const size = fft.size;
    const span = window + maxLag;

    re1.fill(0);
    im1.fill(0);
    re2.fill(0);
    im2.fill(0);

    for (let i = 0; i < window; i++) re1[i] = signal[offset + i] ?? 0;
    for (let i = 0; i < span; i++) re2[i] = signal[offset + i] ?? 0;

    fft.forward(re1, im1);
    fft.forward(re2, im2);

    // conj(X1) * X2, then back to the time domain.
    for (let i = 0; i < size; i++) {
      const ar = re1[i]!;
      const ai = -im1[i]!;
      const br = re2[i]!;
      const bi = im2[i]!;
      re1[i] = ar * br - ai * bi;
      im1[i] = ar * bi + ai * br;
    }
    fft.inverse(re1, im1);

    for (let lag = 0; lag <= maxLag; lag++) this.output[lag] = re1[lag]!;
    return this.output;
  }
}
