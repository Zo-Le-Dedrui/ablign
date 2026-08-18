/**
 * Time-varying WSOLA — the resynthesis step.
 *
 * Live will not let an extension write warp markers (`AudioClip.warpMarkers` is
 * read-only in the 1.0.0 API), so Ablign cannot hand the stretch to Live's
 * engine and has to render the aligned take itself.
 *
 * Overlap-add alone, resampling the read pointer to follow the warp curve,
 * chops periods mid-cycle and buzzes. WSOLA's fix is to allow each grain to
 * slide within a tolerance window and to pick the position whose waveform
 * continues the previous grain most smoothly — the warp curve says roughly
 * where to read, the correlation search says exactly where. Two takes of the
 * same vocal need shifts of tens of milliseconds at most, so the tolerance
 * never has to be wide and the curve is always obeyed to well within a period.
 */
import { Fft, nextPowerOfTwo } from "./fft.js";

/** Grain length at 44.1 kHz, ~46 ms — two periods of a low male voice. */
const WINDOW_AT_44K = 2048;
const REFERENCE_RATE = 44100;

/** Pull toward the curve's own answer, as a fraction of the best possible score. */
const CENTRE_BIAS = 0.15;

/** Normalised match below which the centre bias is dropped. See `bestOffset`. */
const FREE_SEARCH_BELOW = 0.4;

/**
 * Energy, relative to the take's own average, below which a segment counts as
 * silence. Correlation says nothing there and normalising by a vanishing
 * denominator says something actively wrong, so the floor keeps both in check.
 */
const SILENCE_FRACTION = 1e-3;

export interface WarpOptions {
  sampleRate: number;
  /** Output sample position -> input sample position. Must be non-decreasing. */
  inputAt: (outputSample: number) => number;
  outputLength: number;
  onProgress?: (fraction: number) => Promise<void>;
  shouldAbort?: () => boolean;
}

/** Cross-correlation of a fixed-length template against a search region. */
class Matcher {
  private readonly fft: Fft;
  private readonly re1: Float64Array;
  private readonly im1: Float64Array;
  private readonly re2: Float64Array;
  private readonly im2: Float64Array;
  private readonly energy: Float64Array;

  constructor(
    private readonly length: number,
    private readonly radius: number,
    /** Typical energy of a `length`-sample segment of this take. */
    private readonly floor: number,
  ) {
    const span = length + 2 * radius;
    this.fft = new Fft(nextPowerOfTwo(length + span));
    const size = this.fft.size;
    this.re1 = new Float64Array(size);
    this.im1 = new Float64Array(size);
    this.re2 = new Float64Array(size);
    this.im2 = new Float64Array(size);
    this.energy = new Float64Array(span + 1);
  }

  /**
   * @param templateAt - Start of the segment the previous grain wants to continue into.
   * @param idealAt - Where the warp curve says to read.
   * @returns The chosen input start and how well it matched, 0 to 1.
   */
  bestOffset(
    signal: Float32Array,
    templateAt: number,
    idealAt: number,
  ): { at: number; match: number } {
    const { re1, im1, re2, im2, fft, length, radius, energy, floor } = this;
    const size = fft.size;
    const span = length + 2 * radius;
    const from = idealAt - radius;

    re1.fill(0);
    im1.fill(0);
    re2.fill(0);
    im2.fill(0);

    let templateEnergy = 0;
    for (let i = 0; i < length; i++) {
      const value = signal[templateAt + i] ?? 0;
      re1[i] = value;
      templateEnergy += value * value;
    }

    // Nothing to match against: hold the curve's answer rather than let the
    // search wander. Without this the grain drifts a full radius every frame
    // through every gap between phrases, and the take never comes back.
    if (templateEnergy < floor) return { at: idealAt, match: 1 };

    for (let i = 0; i < span; i++) re2[i] = signal[from + i] ?? 0;

    // Running energy of every candidate segment, so the score can be normalised
    // without favouring whichever window happens to be loudest.
    energy[0] = 0;
    for (let i = 0; i < span; i++) {
      const value = re2[i]!;
      energy[i + 1] = energy[i]! + value * value;
    }

    fft.forward(re1, im1);
    fft.forward(re2, im2);
    for (let i = 0; i < size; i++) {
      const ar = re1[i]!;
      const ai = -im1[i]!;
      const br = re2[i]!;
      const bi = im2[i]!;
      re1[i] = ar * br - ai * bi;
      im1[i] = ar * bi + ai * br;
    }
    fft.inverse(re1, im1);

    // Cauchy-Schwarz caps the normalised score at ||template||, which makes it
    // the natural unit for the centre bias too.
    const ceiling = Math.sqrt(templateEnergy + floor);
    const lastLag = span - length;
    let best = -Infinity;
    let bestLag = radius;
    let bestFree = -Infinity;
    let bestFreeLag = radius;

    for (let lag = 0; lag <= lastLag; lag++) {
      const segment = energy[lag + length]! - energy[lag]!;
      const raw = re1[lag]! / Math.sqrt(segment + floor);
      if (raw > bestFree) {
        bestFree = raw;
        bestFreeLag = lag;
      }

      const score = raw - (CENTRE_BIAS * ceiling * Math.abs(lag - radius)) / radius;
      if (score > best) {
        best = score;
        bestLag = lag;
      }
    }

    // On anything periodic the bias is a useful tiebreak: it keeps the grain
    // near where the curve asked rather than a period away.
    //
    // On noise it is the whole problem. Every candidate correlates about
    // equally by chance, so the bias decides every time, and every grain lands
    // exactly on the ideal position. That makes the reused material recur at a
    // fixed distance — hop x (1 - 1/ratio) — which is a comb, and a comb is the
    // metallic whistle on a stretched s. Letting chance pick the offset instead
    // spreads that distance out, and the join is still the best-matching one
    // available rather than a random cut.
    const confident = bestFree / (ceiling || 1) >= FREE_SEARCH_BELOW;
    const chosen = confident ? bestLag : bestFreeLag;
    return { at: from + chosen, match: ceiling > 0 ? Math.max(0, bestFree / ceiling) : 0 };
  }
}

export async function warpChannels(
  channels: Float32Array[],
  mono: Float32Array,
  options: WarpOptions,
): Promise<Float32Array[]> {
  const { sampleRate, inputAt, outputLength } = options;

  let window = Math.round((WINDOW_AT_44K * sampleRate) / REFERENCE_RATE);
  window += window % 2; // an even length keeps the 50 % hop exact
  const hop = window / 2;
  const radius = hop;

  const hann = new Float64Array(window);
  for (let i = 0; i < window; i++) {
    hann[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / window));
  }

  let meanSquare = 0;
  for (let i = 0; i < mono.length; i++) meanSquare += mono[i]! * mono[i]!;
  meanSquare /= Math.max(1, mono.length);

  const output = channels.map(() => new Float32Array(outputLength));
  const normalisation = new Float32Array(outputLength);
  const matcher = new Matcher(hop, radius, meanSquare * hop * SILENCE_FRACTION);
  const inputLength = mono.length;

  const frameCount = Math.ceil(outputLength / hop) + 1;
  let previous = -1;
  let lastReport = 0;

  for (let frame = 0; frame < frameCount; frame++) {
    const outputAt = frame * hop;
    const ideal = Math.round(inputAt(outputAt));

    // The first grain has nothing to continue, so it lands exactly on the curve.
    const source = previous < 0 ? ideal : matcher.bestOffset(mono, previous + hop, ideal).at;
    previous = source;

    for (let i = 0; i < window; i++) {
      const to = outputAt + i;
      if (to >= outputLength) break;
      const at = source + i;
      if (at < 0 || at >= inputLength) continue;

      const weight = hann[i]!;
      for (let c = 0; c < channels.length; c++) {
        output[c]![to] = output[c]![to]! + channels[c]![at]! * weight;
      }
      normalisation[to] = normalisation[to]! + weight;
    }

    if (options.shouldAbort?.()) throw new Error("Cancelled.");
    if (frame - lastReport > 64) {
      lastReport = frame;
      await options.onProgress?.(frame / frameCount);
    }
  }

  // Hann at a half-window hop sums to 1 everywhere except the first and last
  // half-grain; dividing through fixes those without touching the middle.
  for (let i = 0; i < outputLength; i++) {
    const weight = normalisation[i]!;
    if (weight < 1e-4) continue;
    for (let c = 0; c < channels.length; c++) output[c]![i] = output[c]![i]! / weight;
  }

  return output;
}
