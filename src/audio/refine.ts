/**
 * Sub-frame refinement of the DTW map, from fine envelopes.
 *
 * The matcher works on spectral shapes at one frame every 5.8 ms, so its map is
 * blind below that scale — and the residual it leaves behind is exactly the
 * few-millisecond smear a listener sees when two takes are overlaid. Halving
 * the analysis hop was tried first and measured *worse* (3.5 ms of mean lag
 * became 5.1 at 1.6x the cost): a finer path has more tie-break jitter for the
 * smoothing to average, so resolution was never the bottleneck.
 *
 * This goes at it from the other side. Once the map says roughly where the two
 * takes correspond, the fine timing is read off the audio itself: rectified
 * envelopes at sub-millisecond resolution, cross-correlated in a short window
 * around each mapped position. Envelopes rather than waveforms, because two
 * performances of the same phrase share their energy contour but not their
 * phase. The measured residual then bends the map before it is shaped.
 */
import { FFT_SIZE, HOP, type FeatureTrack } from "./features.js";

/** Envelope step in samples — 0.7 ms at 44.1 kHz, well under one map frame. */
const ENV_STEP = 32;
/** Envelope smoothing window, in samples. */
const ENV_WINDOW = 128;
/** Half-width of the patch being compared, in seconds. */
const PATCH = 0.03;
/** Furthest residual worth believing, in seconds. Anything larger is the map's job. */
const SEARCH = 0.008;
/** Correlation below which a measurement says nothing and is not used. */
const TRUST = 0.5;
/**
 * Moving-average half-width over the measured residuals, in map frames.
 *
 * Wider than it looks like it should be — 140 ms either side. The residual a
 * single frame measures is noisy, and the frames where it is noisiest are the
 * ones at the edge of a phrase, where there is least material to correlate and
 * where a wrong answer is most audible. Averaging over a syllable rather than
 * over a few frames lets the confident middle of a note carry the timing into
 * its own attack: measured, that alone takes a cold start from 1.9 ms of error
 * to 0.4, and stops the sibilant bench drifting 5 % long.
 */
const SMOOTH_FRAMES = 24;

/** Rectified, lightly averaged envelope at ENV_STEP resolution. */
export function fineEnvelope(mono: Float32Array): Float32Array {
  const n = Math.floor(mono.length / ENV_STEP);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const centre = i * ENV_STEP;
    const from = Math.max(0, centre - ENV_WINDOW / 2);
    const to = Math.min(mono.length, centre + ENV_WINDOW / 2);
    let sum = 0;
    for (let k = from; k < to; k++) sum += Math.abs(mono[k]!);
    out[i] = sum / Math.max(1, to - from);
  }
  return out;
}

/**
 * Bends `map` by the residual the envelopes can still see at each audible
 * frame. Returns a new map; the original is untouched.
 *
 * @param anchor - Per guide frame audibility, as handed to the curve shaper.
 */
export function refineMap(
  map: Float32Array,
  guideEnv: Float32Array,
  dubEnv: Float32Array,
  anchor: Float32Array,
  sampleRate: number,
): Float32Array {
  const n = map.length;
  const patch = Math.max(4, Math.round((PATCH * sampleRate) / ENV_STEP));
  const search = Math.max(2, Math.round((SEARCH * sampleRate) / ENV_STEP));
  const centreOffset = FFT_SIZE / 2;

  const residual = new Float32Array(n);
  const weight = new Float32Array(n);

  for (let i = 0; i < n; i++) {
    if (anchor[i]! < 0.25) continue;

    const guideAt = Math.round((i * HOP + centreOffset) / ENV_STEP);
    const dubAt = Math.round((map[i]! * HOP + centreOffset) / ENV_STEP);
    if (guideAt - patch < 0 || guideAt + patch >= guideEnv.length) continue;
    if (dubAt - patch - search < 0 || dubAt + patch + search >= dubEnv.length) continue;

    // Normalised cross-correlation of the two envelope patches, over lags.
    let guideEnergy = 0;
    for (let k = -patch; k <= patch; k++) guideEnergy += guideEnv[guideAt + k]! ** 2;
    if (guideEnergy <= 0) continue;

    let best = -Infinity;
    let bestLag = 0;
    const scores = new Float64Array(2 * search + 1);
    for (let lag = -search; lag <= search; lag++) {
      let dot = 0;
      let energy = 0;
      for (let k = -patch; k <= patch; k++) {
        const value = dubEnv[dubAt + lag + k]!;
        dot += guideEnv[guideAt + k]! * value;
        energy += value * value;
      }
      const score = dot / Math.sqrt(guideEnergy * energy + 1e-18);
      scores[lag + search] = score;
      if (score > best) {
        best = score;
        bestLag = lag;
      }
    }

    if (best < TRUST) continue;

    // Parabolic interpolation around the peak takes the lag below one step.
    let lag = bestLag;
    const at = bestLag + search;
    if (at > 0 && at < 2 * search) {
      const left = scores[at - 1]!;
      const mid = scores[at]!;
      const right = scores[at + 1]!;
      const denominator = left - 2 * mid + right;
      if (Math.abs(denominator) > 1e-12) {
        const delta = (0.5 * (left - right)) / denominator;
        if (Math.abs(delta) <= 1) lag += delta;
      }
    }

    // The dub's material sits `lag` env-steps later than the map thought, so
    // the map should point that much further along.
    residual[i] = (lag * ENV_STEP) / HOP;
    weight[i] = (best - TRUST) * anchor[i]!;
  }

  // Smooth the trusted residuals and let quiet spans follow their neighbours;
  // where nothing was measured at all, the map stays as it was.
  const bent = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const from = Math.max(0, i - SMOOTH_FRAMES);
    const to = Math.min(n - 1, i + SMOOTH_FRAMES);
    let sum = 0;
    let mass = 0;
    for (let k = from; k <= to; k++) {
      sum += residual[k]! * weight[k]!;
      mass += weight[k]!;
    }
    bent[i] = mass > 1e-6 ? sum / mass : 0;
  }

  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = map[i]! + bent[i]!;
  // The corners are pinned by construction and must stay pinned.
  out[0] = map[0]!;
  out[n - 1] = map[n - 1]!;
  return out;
}
