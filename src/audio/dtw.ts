/**
 * Banded dynamic time warping between two feature tracks.
 *
 * Both takes are rendered from the same arrangement selection, so the answer
 * always lives near the diagonal — a full N x M cost matrix would spend
 * essentially all of its memory on alignments no vocalist could produce. The
 * band is the user's "max shift" expressed in frames, which keeps the cost
 * linear in the selection length and doubles as a guarantee: the result can
 * never drift further than the user allowed.
 *
 * The step pattern is the symmetric type-III set {(1,1), (1,2), (2,1)}, which
 * bounds the local slope to [1/2, 2]. Plain {(1,1), (0,1), (1,0)} would let the
 * path run along a row for free, mapping an entire held vowel onto one dub
 * frame and stuttering it on playback.
 */
import { FEATURE_SIZE, ONSET_SIZE, type FeatureTrack } from "./features.js";

/** Refuse rather than ask Live for a gigabyte. Roughly 10 min at ±300 ms. */
const MAX_CELLS = 48_000_000;

/**
 * Loudness below which a double's frame carries no usable evidence.
 *
 * `loudness` is already gated: it reaches 0 at the Silence setting and rises
 * over the 40 dB above it, so this is a little over 4 dB into that range.
 */
const SILENT_BELOW = 0.1;

/**
 * Weight of the onset term against the spectral shape term.
 *
 * The shape term is a cosine distance in [0, 2] and speaks on every frame; the
 * onset term is a Euclidean distance that is zero unless something is starting.
 * They are summed rather than blended, so this only decides how loudly the
 * transitions get to speak over the sustains.
 */
const ONSET_WEIGHT = 0.15;

const STEP_DIAGONAL = 0;
const STEP_WIDE = 1; // (i-1, j-2): the dub covers two frames while the guide covers one
const STEP_TALL = 2; // (i-2, j-1): the guide covers two frames while the dub covers one

export interface DtwProgress {
  onProgress?: (fraction: number) => Promise<void>;
  shouldAbort?: () => boolean;
}

export interface DtwResult {
  /** Per guide frame, the fractional dub frame it maps to. */
  map: Float32Array;
  /** Mean per-frame path cost — near 0 when the takes really are the same part. */
  cost: number;
}

/**
 * @param radius - Band half-width in frames; the largest shift the path may use.
 */
/**
 * @param guides - References to match against, all on the same timeline and of
 *   the same length. More than one is the point of chaining: a double often
 *   resembles the double above it more than it resembles the lead, and taking
 *   whichever agrees best at each frame lets it use both. The frames where they
 *   disagree are exactly the ambiguous ones.
 */
export async function alignFeatureTracks(
  guides: FeatureTrack[],
  dub: FeatureTrack,
  radius: number,
  inertia: number,
  progress: DtwProgress = {},
  centre?: Float32Array,
): Promise<DtwResult> {
  const guide = guides[0]!;
  const n = guide.frameCount;
  const m = dub.frameCount;
  if (n < 4 || m < 4) throw new Error("Selection is too short to align.");

  const slope = (m - 1) / (n - 1);

  // Row geometry up front: `lo[i]` is the first dub frame row i considers and
  // `offset[i]` where that row starts in the flat cost array.
  const lo = new Int32Array(n);
  const hi = new Int32Array(n);
  const offset = new Int32Array(n + 1);
  let cells = 0;
  const guided = centre && centre.length === n ? centre : undefined;

  for (let i = 0; i < n; i++) {
    // Centred on the diagonal by default; on a coarse pass's answer when there
    // is one, which is what lets a fine pass use a much narrower band.
    const middle = guided ? guided[i]! : i * slope;
    lo[i] = Math.max(0, Math.floor(middle) - radius);
    hi[i] = Math.min(m - 1, Math.ceil(middle) + radius);
    offset[i] = cells;
    cells += hi[i]! - lo[i]! + 1;
  }
  offset[n] = cells;

  if (cells > MAX_CELLS) {
    throw new Error(
      "Selection is too long to align in one pass. Align a shorter range, or reduce Max shift.",
    );
  }

  // Only references that line up frame for frame can be compared this way.
  const references = guides
    .filter((track) => track.frameCount === n)
    .map((track) => track.data);
  const referenceOnsets = guides
    .filter((track) => track.frameCount === n)
    .map((track) => track.onset);
  const dubData = dub.data;
  const dubOnset = dub.onset;

  /**
   * Cosine distance in [0, 2]; both sides are unit vectors. With several
   * references, the closest one wins the frame — an average would let a
   * reference that is wrong here blur one that is right.
   */
  // Priced against the shape term's own spread rather than as an absolute.
  // These are unit vectors, so a genuine match scores a cosine distance around
  // a thousandth while a mismatch scores about one — an onset term of a few
  // hundredths, which looks negligible, is fifty times the margin the shape
  // term decides by and simply takes over. Measured first, weighted after.
  let onsetPrice = 0;

  const distance = (i: number, j: number): number => {
    const a = i * FEATURE_SIZE;
    const b = j * FEATURE_SIZE;
    const oa = i * ONSET_SIZE;
    const ob = j * ONSET_SIZE;
    let best = Infinity;

    for (let r = 0; r < references.length; r++) {
      const data = references[r]!;
      let dot = 0;
      for (let k = 0; k < FEATURE_SIZE; k++) dot += data[a + k]! * dubData[b + k]!;

      // Euclidean, not cosine: two frames with nothing starting are both zero
      // vectors and score zero together, so a sustained passage contributes
      // nothing here and the shape term decides it alone. A transition in one
      // take with none in the other is what costs.
      const onsets = referenceOnsets[r]!;
      let apart = 0;
      for (let k = 0; k < ONSET_SIZE; k++) {
        const d = onsets[oa + k]! - dubOnset[ob + k]!;
        apart += d * d;
      }

      const cost = 1 - dot + onsetPrice * Math.sqrt(apart);
      if (cost < best) best = cost;
    }
    return best;
  };

  const local = new Float32Array(cells);
  const total = new Float32Array(cells);
  const step = new Uint8Array(cells);

  /**
   * A price on changing pace, charged once per step that is not the diagonal.
   *
   * Without it the matcher has nothing to prefer when a phrase repeats itself:
   * lining syllable three up with syllable three and lining it up with the
   * similar syllable five cost almost exactly the same, and which of two
   * near-equal costs wins is then decided by noise in the features. That is why
   * the takes that were tightest to begin with were the ones that went wrong —
   * a take already in place has no strong evidence pulling it anywhere, so
   * anything at all can outvote the truth.
   *
   * On the steps rather than on the distance from the diagonal. Charging by
   * distance was tried first and is the wrong shape: it punishes a take that is
   * genuinely and steadily late just as hard as one that is wandering, and
   * since these features barely change through a held syllable, it flattened
   * real corrections — mean lag went from 2.1 ms to 14 at every setting tried,
   * from 0.001 upwards. A path that runs straight, however far off the
   * diagonal, now pays nothing; only changing pace costs, which is exactly the
   * wandering that throws a syllable across the phrase.
   *
   * Charging it only on the rows whose features look ambiguous was tried too —
   * the surgical version of the same idea — and stopped working entirely: the
   * spurious drift stayed at its full 43 ms at every setting while the cost
   * remained. The flat charge is the one that does the job.
   *
   * Priced against what the data costs. These are unit vectors, so a genuine
   * match scores a cosine distance around a thousandth, and an absolute penalty
   * that looks negligible can still swamp the whole signal. The scale is
   * measured across the band rather than along the diagonal: a take compared
   * with itself scores zero there, give or take the last bit of a float, and a
   * mean landing a hair below zero would flip the penalty into a reward for
   * wandering.
   */
  let shapeSpread = 0;
  let spreadRows = 0;
  {
    const rowStep = Math.max(1, Math.floor(n / 96));
    for (let i = 0; i < n; i += rowStep) {
      let low = Infinity;
      let sum = 0;
      let cells = 0;
      for (let j = lo[i]!; j <= hi[i]!; j++) {
        const cost = distance(i, j);
        if (cost < low) low = cost;
        sum += cost;
        cells++;
      }
      if (cells > 0) {
        shapeSpread += sum / cells - low;
        spreadRows++;
      }
    }
  }
  shapeSpread = spreadRows > 0 ? Math.max(0, shapeSpread / spreadRows) : 0;
  onsetPrice = ONSET_WEIGHT * shapeSpread;

  let scale = 0;
  let scaleCells = 0;
  const rowStep = Math.max(1, Math.floor(n / 192));
  for (let i = 0; i < n; i += rowStep) {
    for (let j = lo[i]!; j <= hi[i]!; j++) {
      scale += distance(i, j);
      scaleCells++;
    }
  }
  scale = scaleCells > 0 ? Math.max(0, scale / scaleCells) : 0;
  const paceChange = Math.max(0, inertia) * scale;

  /**
   * Where the double is silent, every column costs the same.
   *
   * A backing part does not sing every word the lead sings. On the real take
   * that prompted this, four of the lead's thirteen syllables had no
   * counterpart within 900 ms — the double simply is not there. The matcher
   * still has to map those frames somewhere, and the "quiet" axis in the
   * feature vector makes silence look actively wrong under a loud lead, so it
   * reaches for whatever material is nearest and drags the path off the
   * syllables that *did* have a counterpart.
   *
   * Giving those columns a flat cost lets the path coast through instead. It
   * has no reason to prefer any of them, so the step pattern and the anchored
   * material either side decide, which is the only honest answer available:
   * there is nothing there to align to.
   *
   * The flat value is the band's own mean, so coasting is neither cheaper nor
   * dearer than matching — the path is not pushed into silence or away from it.
   *
   * Only when the silence is one-sided. Where both takes are quiet the silence
   * is real evidence and the quiet axis matches it correctly; flattening that
   * too was tried and cost the main bench 2.1 ms of mean lag against 12.8.
   */
  const dubLoudness = dub.loudness;
  const guideLoudness = guide.loudness;

  for (let i = 0; i < n; i++) {
    const start = offset[i]!;
    const leadIsSinging = guideLoudness[i]! >= SILENT_BELOW;
    for (let j = lo[i]!; j <= hi[i]!; j++) {
      const oneSided = leadIsSinging && dubLoudness[j]! < SILENT_BELOW;
      local[start + j - lo[i]!] = oneSided ? scale : distance(i, j);
    }
  }

  /** Accumulated cost at (i, j), or Infinity outside the band. */
  const costAt = (i: number, j: number): number => {
    if (i < 0 || j < 0 || j < lo[i]! || j > hi[i]!) return Infinity;
    return total[offset[i]! + j - lo[i]!]!;
  };
  const localAt = (i: number, j: number): number => {
    if (i < 0 || j < 0 || j < lo[i]! || j > hi[i]!) return Infinity;
    return local[offset[i]! + j - lo[i]!]!;
  };

  total.fill(Infinity);
  total[0] = local[0]!; // (0, 0) — both takes start together by construction

  let lastReport = 0;
  for (let i = 0; i < n; i++) {
    const start = offset[i]!;
    const rowLo = lo[i]!;

    for (let j = rowLo; j <= hi[i]!; j++) {
      if (i === 0 && j === 0) continue;
      const here = local[start + j - rowLo]!;

      const diagonal = costAt(i - 1, j - 1);
      // The intermediate cell of a two-frame step is charged too, so a wide or
      // tall step is never cheaper simply for visiting fewer cells — and each
      // also pays `paceChange`, since both of them alter the pace.
      const wide = costAt(i - 1, j - 2) + localAt(i, j - 1) + paceChange;
      const tall = costAt(i - 2, j - 1) + localAt(i - 1, j) + paceChange;

      let best = diagonal;
      let choice = STEP_DIAGONAL;
      if (wide < best) {
        best = wide;
        choice = STEP_WIDE;
      }
      if (tall < best) {
        best = tall;
        choice = STEP_TALL;
      }

      total[start + j - rowLo] = best + here;
      step[start + j - rowLo] = choice;
    }

    if (progress.shouldAbort?.()) throw new Error("Cancelled.");
    if (i - lastReport > 512) {
      lastReport = i;
      await progress.onProgress?.(i / n);
    }
  }

  const endCost = costAt(n - 1, m - 1);
  if (!Number.isFinite(endCost)) {
    throw new Error("No alignment path fits within Max shift. Try raising it.");
  }

  // Walk the pointers back, recording the dub frames each guide frame saw.
  const sum = new Float64Array(n);
  const hits = new Int32Array(n);
  let i = n - 1;
  let j = m - 1;
  let steps = 0;

  while (i > 0 || j > 0) {
    sum[i] = sum[i]! + j;
    hits[i] = hits[i]! + 1;
    steps++;

    const choice = step[offset[i]! + j - lo[i]!]!;
    if (choice === STEP_WIDE) {
      // The skipped dub frame belongs to this guide frame as well.
      sum[i] = sum[i]! + (j - 1);
      hits[i] = hits[i]! + 1;
      i -= 1;
      j -= 2;
    } else if (choice === STEP_TALL) {
      sum[i - 1] = sum[i - 1]! + j;
      hits[i - 1] = hits[i - 1]! + 1;
      i -= 2;
      j -= 1;
    } else {
      i -= 1;
      j -= 1;
    }
    if (i < 0) i = 0;
    if (j < 0) j = 0;
  }
  sum[0] = sum[0]! + j;
  hits[0] = hits[0]! + 1;

  const map = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    map[k] = hits[k]! > 0 ? sum[k]! / hits[k]! : NaN;
  }

  // A tall step leaves its skipped guide frame unvisited; interpolate across.
  for (let k = 0; k < n; k++) {
    if (!Number.isNaN(map[k]!)) continue;
    let before = k - 1;
    while (before >= 0 && Number.isNaN(map[before]!)) before--;
    let after = k + 1;
    while (after < n && Number.isNaN(map[after]!)) after++;
    if (before < 0 && after >= n) map[k] = k * slope;
    else if (before < 0) map[k] = map[after]!;
    else if (after >= n) map[k] = map[before]!;
    else map[k] = map[before]! + ((map[after]! - map[before]!) * (k - before)) / (after - before);
  }

  map[0] = 0;
  map[n - 1] = m - 1;

  return { map, cost: endCost / Math.max(1, steps) };
}

/**
 * A feature track at a coarser time resolution.
 *
 * Frames are averaged in groups of `factor` and renormalised. A coarse pass has
 * fewer, blunter frames, and that is the point: local ambiguity is what sends a
 * path two syllables away, and at a quarter of the resolution there is much
 * less of it to trip over. Its answer then confines the fine pass to a narrow
 * band, so the fine pass keeps its precision without keeping its freedom to
 * wander off.
 *
 * Onsets are carried across as a maximum rather than a mean: they are sparse by
 * construction, and averaging would dilute exactly what makes them useful.
 */
export function coarsen(track: FeatureTrack, factor: number): FeatureTrack {
  const frames = Math.max(2, Math.floor(track.frameCount / factor));
  const data = new Float32Array(frames * FEATURE_SIZE);
  const onset = new Float32Array(frames * ONSET_SIZE);
  const loudness = new Float32Array(frames);
  const sibilance = new Float32Array(frames);

  for (let coarse = 0; coarse < frames; coarse++) {
    const from = coarse * factor;
    const to = Math.min(track.frameCount, from + factor);
    const at = coarse * FEATURE_SIZE;
    const onsetAt = coarse * ONSET_SIZE;

    for (let k = from; k < to; k++) {
      const source = k * FEATURE_SIZE;
      for (let d = 0; d < FEATURE_SIZE; d++) data[at + d] = data[at + d]! + track.data[source + d]!;
      loudness[coarse] = loudness[coarse]! + track.loudness[k]!;
      sibilance[coarse] = sibilance[coarse]! + track.sibilance[k]!;

      const onsetSource = k * ONSET_SIZE;
      for (let d = 0; d < ONSET_SIZE; d++) {
        if (track.onset[onsetSource + d]! > onset[onsetAt + d]!) {
          onset[onsetAt + d] = track.onset[onsetSource + d]!;
        }
      }
    }

    const count = Math.max(1, to - from);
    loudness[coarse] = loudness[coarse]! / count;
    sibilance[coarse] = sibilance[coarse]! / count;

    // Back to unit length, so the cosine distance means the same thing here.
    let norm = 0;
    for (let d = 0; d < FEATURE_SIZE; d++) norm += data[at + d]! * data[at + d]!;
    norm = Math.sqrt(norm);
    if (norm > 1e-9) for (let d = 0; d < FEATURE_SIZE; d++) data[at + d] = data[at + d]! / norm;
  }

  return {
    data,
    frameCount: frames,
    loudness,
    sibilance,
    onset,
    hop: track.hop * factor,
    sampleRate: track.sampleRate,
  };
}
