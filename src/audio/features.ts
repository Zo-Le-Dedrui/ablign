/**
 * Frame features for alignment.
 *
 * Alignment has to survive the two takes being sung differently — different
 * level, different mic, a little more or less air. What it must *not* survive
 * is the words moving, so the frame vector describes spectral shape (which
 * phoneme is sounding) and deliberately throws away level.
 *
 * Silence is the awkward part: the shape of near-silence is noise, and noise
 * correlates with nothing, so a plain spectral distance makes the gaps between
 * phrases look maximally dissimilar and drags the warp path around. The fix is
 * the extra "quiet" dimension appended to every vector — loud frames put their
 * weight in the mel bands, silent frames put it all in that one axis, and two
 * silences then match each other perfectly.
 */
import { Fft } from "./fft.js";

export const FFT_SIZE = 1024;
export const HOP = 256;

const MEL_BANDS = 24;
/** Mel bands plus the quiet axis. */
export const FEATURE_SIZE = MEL_BANDS + 1;

/** Vocal-relevant span; below 60 Hz is rumble, above 8 kHz is mostly air. */
const MEL_LOW_HZ = 60;
const MEL_HIGH_HZ = 8000;

/** Range above the gate over which a frame fades from "silent" to "present". */
const LOUDNESS_RANGE_DB = 40;

export interface FeatureTrack {
  /** `frameCount * FEATURE_SIZE` unit-norm vectors, laid out contiguously. */
  data: Float32Array;
  frameCount: number;
  /** Per-frame loudness in [0, 1]; 0 at or below the gate. */
  loudness: Float32Array;
  /**
   * Per-frame share of energy above 3 kHz, 0 to 1.
   *
   * Near 1 on s, ch, f, near 0 on any vowel. Cruder than a voicing detector and
   * enough: the material that must not be stretched is exactly the material
   * whose energy sits at the top of the band.
   */
  sibilance: Float32Array;
  hop: number;
  sampleRate: number;
}

const hzToMel = (hz: number): number => 2595 * Math.log10(1 + hz / 700);
const melToHz = (mel: number): number => 700 * (10 ** (mel / 2595) - 1);

/** Triangular mel filterbank as a sparse [start, weights] per band. */
function melFilterbank(
  sampleRate: number,
  fftSize: number,
): { start: number; weights: Float64Array }[] {
  const bins = fftSize / 2 + 1;
  const lowMel = hzToMel(MEL_LOW_HZ);
  const highMel = hzToMel(Math.min(MEL_HIGH_HZ, sampleRate / 2));
  const points: number[] = [];

  for (let i = 0; i < MEL_BANDS + 2; i++) {
    const mel = lowMel + ((highMel - lowMel) * i) / (MEL_BANDS + 1);
    points.push(Math.floor(((fftSize + 1) * melToHz(mel)) / sampleRate));
  }

  const filters: { start: number; weights: Float64Array }[] = [];
  for (let band = 0; band < MEL_BANDS; band++) {
    const left = points[band]!;
    const centre = Math.max(left + 1, points[band + 1]!);
    const right = Math.max(centre + 1, points[band + 2]!);
    const end = Math.min(bins - 1, right);
    const weights = new Float64Array(Math.max(0, end - left + 1));

    for (let bin = left; bin <= end; bin++) {
      const weight =
        bin < centre ? (bin - left) / (centre - left) : (right - bin) / (right - centre);
      weights[bin - left] = Math.max(0, weight);
    }
    filters.push({ start: left, weights });
  }
  return filters;
}

export function frameCountFor(length: number): number {
  return Math.max(1, Math.floor((length - FFT_SIZE) / HOP) + 1);
}

/**
 * @param gateDb - Frame level at which a frame counts as fully silent, dBFS.
 */
export function extractAlignmentFeatures(
  signal: Float32Array,
  sampleRate: number,
  gateDb: number,
): FeatureTrack {
  const fft = new Fft(FFT_SIZE);
  const filters = melFilterbank(sampleRate, FFT_SIZE);
  const bins = FFT_SIZE / 2 + 1;

  const hann = new Float64Array(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i++) {
    hann[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / FFT_SIZE));
  }

  const frameCount = frameCountFor(signal.length);
  const data = new Float32Array(frameCount * FEATURE_SIZE);
  const loudness = new Float32Array(frameCount);
  const sibilance = new Float32Array(frameCount);
  const topBin = Math.round((3000 * FFT_SIZE) / sampleRate);

  const re = new Float64Array(FFT_SIZE);
  const im = new Float64Array(FFT_SIZE);
  const magnitude = new Float64Array(bins);
  const mel = new Float64Array(MEL_BANDS);

  for (let frame = 0; frame < frameCount; frame++) {
    const offset = frame * HOP;

    let sumSquares = 0;
    for (let i = 0; i < FFT_SIZE; i++) {
      const sample = signal[offset + i] ?? 0;
      re[i] = sample * hann[i]!;
      im[i] = 0;
      sumSquares += sample * sample;
    }

    const rms = Math.sqrt(sumSquares / FFT_SIZE);
    const db = 20 * Math.log10(rms + 1e-12);
    const level = Math.min(1, Math.max(0, (db - gateDb) / LOUDNESS_RANGE_DB));
    loudness[frame] = level;

    fft.forward(re, im);
    let low = 0;
    let high = 0;
    for (let bin = 0; bin < bins; bin++) {
      magnitude[bin] = Math.hypot(re[bin]!, im[bin]!);
      if (bin < topBin) low += magnitude[bin]!;
      else high += magnitude[bin]!;
    }
    sibilance[frame] = level > 0 ? high / (low + high + 1e-12) : 0;

    let melSum = 0;
    for (let band = 0; band < MEL_BANDS; band++) {
      const filter = filters[band]!;
      let energy = 0;
      for (let i = 0; i < filter.weights.length; i++) {
        const bin = filter.start + i;
        if (bin < bins) energy += magnitude[bin]! * filter.weights[i]!;
      }
      const value = Math.log(energy + 1e-8);
      mel[band] = value;
      melSum += value;
    }

    // Subtracting the mean drops the overall level (and any fixed channel
    // colouration) and leaves the shape, which is what identifies the phoneme.
    const melMean = melSum / MEL_BANDS;
    let norm = 0;
    for (let band = 0; band < MEL_BANDS; band++) {
      mel[band] = mel[band]! - melMean;
      norm += mel[band]! * mel[band]!;
    }
    norm = Math.sqrt(norm);

    const at = frame * FEATURE_SIZE;
    if (norm > 1e-9) {
      const scale = level / norm;
      for (let band = 0; band < MEL_BANDS; band++) data[at + band] = mel[band]! * scale;
    }
    data[at + MEL_BANDS] = 1 - level;

    // Re-normalise so every frame is a unit vector and cosine distance is just
    // `1 - dot`. Only the loud/quiet split above decides where the mass sits.
    let total = 0;
    for (let i = 0; i < FEATURE_SIZE; i++) total += data[at + i]! * data[at + i]!;
    total = Math.sqrt(total);
    if (total > 1e-9) {
      for (let i = 0; i < FEATURE_SIZE; i++) data[at + i] = data[at + i]! / total;
    } else {
      data[at + MEL_BANDS] = 1;
    }
  }

  return { data, frameCount, loudness, sibilance, hop: HOP, sampleRate };
}
