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

  const smoothed = movingAverage(shift, options.smoothingFrames);

  // Scale by strength, then remove any tilt smoothing introduced at the edges,
  // so the aligned take still starts and ends exactly where the guide does.
  const scaled = new Float32Array(n);
  for (let i = 0; i < n; i++) scaled[i] = smoothed[i]! * options.strength;
  const first = scaled[0]!;
  const last = scaled[n - 1]!;
  for (let i = 0; i < n; i++) {
    scaled[i] = scaled[i]! - (first + ((last - first) * i) / (n - 1));
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
    if (!clamped && Math.abs(error) < 1e-6) break;
    if (Math.abs(error) < 1e-6) break;

    const correction = error / (n - 1);
    for (let i = 0; i < n - 1; i++) increments[i] = increments[i]! - correction;
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
