/**
 * Shaping the raw DTW path into a warp curve you would want to hear.
 *
 * The path out of the DTW is optimal in the cost sense and frequently horrible
 * in the musical sense: it is quantised to the feature hop, it jitters inside
 * held vowels where many alignments cost almost the same, and it will happily
 * spend its whole slope budget on a breath. Everything here works on the
 * *shift* — the deviation from a straight line — because that is the quantity
 * the user is actually dialling: smoothing a shift of zero leaves it at zero,
 * whereas smoothing the raw mapping would drag the overall tempo around.
 */

export interface CurveOptions {
  /**
   * Per-frame resistance to being stretched, 0 to 1, indexed like the curve.
   *
   * A stretched s hisses: overlap-add has to reuse material, and reused noise
   * combs against itself. The length of an s is also the least audible thing
   * about it, so it keeps its own and the correction it would have absorbed
   * goes to the vowels either side. The words still land in the same place.
   */
  resist?: Float32Array;
  /**
   * Per-frame audibility, 0 to 1, indexed like the curve — the loudness of the
   * material the output will actually play.
   *
   * In the silence before a phrase starts cold, every offset matches every
   * other, so the matcher's path there is arbitrary — and it is also the one
   * place a correction is free, because nothing plays there. So instead of
   * de-tilting the curve against whatever the smoothing left at the edges, the
   * curve is ramped from zero through the leading and trailing quiet straight
   * to the first and last audible frames, and the opening attack is met
   * exactly rather than approached through an average of silence.
   */
  anchor?: Float32Array;
  // (Weighting the smoothing itself by this same audibility was tried and
  // measured worse everywhere — 3.6 ms of mean lag became 16 ms — so the
  // anchor's one job is the edge ramp above.)
  /** How much of the measured correction to apply, 0–1. */
  strength: number;
  /** Moving-average half-width, in frames. */
  smoothingFrames: number;
  /** Largest local time-stretch, as a ratio > 1 (1.3 = ±30%). */
  maxRatio: number;
}

/** Projection passes for the slope limiter; it converges much faster than this. */
const LIMIT_PASSES = 12;

function movingAverage(values: Float32Array, halfWidth: number): Float32Array {
  const n = values.length;
  if (halfWidth < 1) return values.slice();

  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i]! + values[i]!;

  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const from = Math.max(0, i - halfWidth);
    const to = Math.min(n - 1, i + halfWidth);
    out[i] = (prefix[to + 1]! - prefix[from]!) / (to - from + 1);
  }
  return out;
}

/**
 * @param map - Per guide frame, the dub frame it maps to (from the DTW).
 * @returns A monotonic curve with the same endpoints, obeying `maxRatio`.
 */
export function shapeWarpCurve(map: Float32Array, options: CurveOptions): Float32Array {
  const n = map.length;
  if (n < 2) return map.slice();

  const slope = map[n - 1]! / (n - 1);

  const shift = new Float32Array(n);
  for (let i = 0; i < n; i++) shift[i] = map[i]! - i * slope;

  const anchor = options.anchor && options.anchor.length >= n ? options.anchor : undefined;
  const smoothed = movingAverage(shift, options.smoothingFrames);

  const scaled = new Float32Array(n);
  for (let i = 0; i < n; i++) scaled[i] = smoothed[i]! * options.strength;

  // The take must still start and end exactly where the guide does. The DTW
  // pins the raw corners to zero shift, so with anchors the curve is ramped
  // from zero through the leading and trailing quiet to the first and last
  // audible frames — the ramp lives where nothing plays. Without anchors,
  // fall back to subtracting the tilt the smoothing put on the edges; with
  // them that subtraction would be poison, because a uniformly early double
  // makes the anchored endpoints carry the correction itself, and de-tilting
  // against those would subtract the correction back out of the whole take.
  let firstLoud = 0;
  while (anchor && firstLoud < n && anchor[firstLoud]! < 0.2) firstLoud++;
  let lastLoud = n - 1;
  while (anchor && lastLoud >= 0 && anchor[lastLoud]! < 0.2) lastLoud--;

  if (anchor && firstLoud < lastLoud) {
    for (let i = 0; i < firstLoud; i++) {
      scaled[i] = (scaled[firstLoud]! * i) / firstLoud;
    }
    for (let i = lastLoud + 1; i < n; i++) {
      scaled[i] = (scaled[lastLoud]! * (n - 1 - i)) / (n - 1 - lastLoud);
    }
  } else {
    const first = scaled[0]!;
    const last = scaled[n - 1]!;
    for (let i = 0; i < n; i++) {
      scaled[i] = scaled[i]! - (first + ((last - first) * i) / (n - 1));
    }
  }

  // Slope limiting, as a box constraint on the per-frame increments plus the
  // requirement that they sum to the original span. Clamping alone would move
  // the endpoint, so we alternate clamping with re-centring until both hold.
  const increments = new Float64Array(n - 1);
  for (let i = 0; i < n - 1; i++) {
    increments[i] = slope + (scaled[i + 1]! - scaled[i]!);
  }

  const lowest = Math.max(1e-6, slope / options.maxRatio);
  const highest = slope * options.maxRatio;

  // Hold the resisting frames at their own length.
  const resist = options.resist;
  if (resist && resist.length >= n) {
    for (let i = 0; i < n - 1; i++) {
      const weight = Math.min(1, Math.max(0, resist[i]!));
      if (weight > 0) increments[i] = increments[i]! + (slope - increments[i]!) * weight;
    }
  }

  // Who takes up the slack. Spreading the correction over every frame equally
  // would hand the resisting ones their stretch straight back.
  const share = new Float64Array(n - 1);
  let shares = 0;
  for (let i = 0; i < n - 1; i++) {
    share[i] = resist && resist.length >= n ? 1 - Math.min(1, Math.max(0, resist[i]!)) : 1;
    shares += share[i]!;
  }
  // If nearly everything resisted there is nowhere left to put the correction,
  // so the whole curve absorbs it after all.
  if (shares < (n - 1) * 0.05) {
    for (let i = 0; i < n - 1; i++) share[i] = 1;
    shares = n - 1;
  }

  for (let pass = 0; pass < LIMIT_PASSES; pass++) {
    let sum = 0;
    let clamped = false;
    for (let i = 0; i < n - 1; i++) {
      const value = Math.min(highest, Math.max(lowest, increments[i]!));
      if (value !== increments[i]!) clamped = true;
      increments[i] = value;
      sum += value;
    }

    const error = sum - slope * (n - 1);
    if (Math.abs(error) < 1e-6) break;
    void clamped;

    const correction = error / shares;
    for (let i = 0; i < n - 1; i++) increments[i] = increments[i]! - correction * share[i]!;
  }

  const out = new Float32Array(n);
  out[0] = map[0]!;
  for (let i = 1; i < n; i++) out[i] = out[i - 1]! + increments[i - 1]!;
  return out;
}

/** Largest absolute shift in the curve, in frames — reported back to the user. */
export function peakShiftFrames(curve: Float32Array): number {
  const n = curve.length;
  if (n < 2) return 0;
  const slope = curve[n - 1]! / (n - 1);
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(curve[i]! - i * slope));
  return peak;
}
