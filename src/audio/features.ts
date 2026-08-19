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

/** Bands in the separate onset representation. */
export const ONSET_SIZE = MEL_BANDS;

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
   * `frameCount * MEL_BANDS` decaying onset strengths, laid out contiguously.
   *
   * Zero wherever nothing is starting, which is the point. Spectral shape says
   * *what* is sounding and holds steady through a syllable; it is poor at
   * saying *when* anything changed, and a held vowel looks the same a frame
   * either side. These say only when, and say nothing the rest of the time.
   *
   * Kept apart from `data` rather than appended to it. Folding movement into
   * the shape vector was tried and made things worse — it adds noise across
   * every sustained frame, where there is nothing to detect. Compared with a
   * plain Euclidean distance, two frames that are both mid-vowel score zero
   * together and contribute nothing to the path; only a transition in one take
   * without a matching transition in the other costs anything.
   *
   * After Ewert, Müller and Grosche, "High Resolution Audio Synchronization
   * Using Chroma Onset Features" (ICASSP 2009), where the same construction is
   * built on chroma.
   */
  onset: Float32Array;
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
  const onset = new Float32Array(frameCount * MEL_BANDS);
  const previousMel = new Float64Array(MEL_BANDS);
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

    // Half-wave rectified flux per band: what grew since the last frame, and
    // nothing for what faded. Taken from the log-mel before the shape is
    // normalised, so it measures the band getting louder rather than the
    // balance between bands shifting.
    const onsetAt = frame * MEL_BANDS;
    if (frame > 0) {
      for (let band = 0; band < MEL_BANDS; band++) {
        const grew = mel[band]! + melMean - previousMel[band]!;
        onset[onsetAt + band] = grew > 0 ? grew : 0;
      }
    }
    for (let band = 0; band < MEL_BANDS; band++) previousMel[band] = mel[band]! + melMean;

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

  // Decay each band forward in time, so an onset is a short ridge rather than
  // a one-frame spike. At 5.8 ms per frame a spike is too brittle to line up
  // against another take; a ridge tolerates a few milliseconds of disagreement
  // and still pulls the path towards the transition.
  const halfLife = Math.round((0.045 * sampleRate) / HOP);
  const decay = Math.pow(0.5, 1 / Math.max(1, halfLife));
  for (let frame = 1; frame < frameCount; frame++) {
    const at = frame * MEL_BANDS;
    const before = at - MEL_BANDS;
    for (let band = 0; band < MEL_BANDS; band++) {
      const carried = onset[before + band]! * decay;
      if (carried > onset[at + band]!) onset[at + band] = carried;
    }
  }

  // Normalised against the loudest onset nearby rather than globally, so a
  // quiet passage still votes. Without this a whispered line would be silent
  // in the cost matrix next to a belted one.
  const span = Math.round((1.5 * sampleRate) / HOP);
  for (let frame = 0; frame < frameCount; frame++) {
    const from = Math.max(0, frame - span);
    const to = Math.min(frameCount - 1, frame + span);
    let loudest = 0;
    for (let k = from; k <= to; k++) {
      const at = k * MEL_BANDS;
      for (let band = 0; band < MEL_BANDS; band++) {
        if (onset[at + band]! > loudest) loudest = onset[at + band]!;
      }
    }
    if (loudest <= 1e-9) continue;
    const at = frame * MEL_BANDS;
    for (let band = 0; band < MEL_BANDS; band++) onset[at + band] = onset[at + band]! / loudest;
  }

  return { data, frameCount, loudness, sibilance, onset, hop: HOP, sampleRate };
}
