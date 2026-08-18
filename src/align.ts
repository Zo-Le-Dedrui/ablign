/**
 * The alignment pipeline, with Live kept out of it.
 *
 * Everything here is decoded audio in, decoded audio out, so the interesting
 * half of Ablign can be exercised from `tools/align-check.ts` without opening
 * a Live Set.
 */
import { toMono, type DecodedAudio } from "./audio/codec.js";
import {
  extractAlignmentFeatures,
  FFT_SIZE,
  HOP,
  type FeatureTrack,
} from "./audio/features.js";
import { alignFeatureTracks } from "./audio/dtw.js";
import { peakShiftFrames, shapeWarpCurve } from "./audio/curve.js";
import { warpChannels } from "./audio/wsola.js";

export interface AlignSettings {
  /** How much of the measured correction to apply, 0–100 %. */
  strength: number;
  /** Widest correction the alignment may use, in milliseconds. */
  maxShiftMs: number;
  /** How much the warp curve is averaged, in milliseconds. */
  smoothingMs: number;
  /**
   * Largest local time-stretch, in percent (30 = between 0.77x and 1.3x).
   * The matcher's own step pattern already caps the path slope at 2x, so 100
   * and above leave this limit inert — it only ever tightens, never loosens.
   */
  maxStretchPercent: number;
  /** Level below which a frame counts as silence, dBFS. */
  gateDb: number;
}

export const DEFAULT_SETTINGS: AlignSettings = {
  strength: 100,
  maxShiftMs: 300,
  smoothingMs: 60,
  // Anything below 100 fights the matcher rather than guiding it: at 40 the
  // limiter spends its budget flattening corrections the path had right, and
  // measured lag against the guide goes from 1.7 ms to 14 ms.
  maxStretchPercent: 100,
  gateDb: -55,
};

export interface AlignHooks {
  onStage?: (text: string, fraction: number) => Promise<void>;
  shouldAbort?: () => boolean;
}

export interface AlignResult {
  channels: Float32Array[];
  sampleRate: number;
  /** Largest correction actually applied, in milliseconds. */
  peakShiftMs: number;
  /** Mean per-frame path cost, 0–2. Above ~0.5 the takes probably differ. */
  cost: number;
}

/**
 * The guide, analysed once. Several doubles get aligned to the same lead in a
 * pass, and re-deriving its features per double would be most of the cost for
 * none of the benefit.
 */
export interface PreparedGuide {
  /** The lead first, then any aligned doubles chained on after it. */
  features: FeatureTrack[];
  length: number;
  sampleRate: number;
}

export function prepareGuide(guide: DecodedAudio, settings: AlignSettings): PreparedGuide {
  if (guide.length < FFT_SIZE * 4) {
    throw new Error("Selection is too short to align — use at least half a second.");
  }
  return {
    features: [extractAlignmentFeatures(toMono(guide), guide.sampleRate, settings.gateDb)],
    length: guide.length,
    sampleRate: guide.sampleRate,
  };
}

/**
 * Adds an already-aligned take to the references a later double will match
 * against.
 *
 * It sits on the guide's timeline now, so it can be compared frame for frame.
 * A backing part usually resembles the backing part beside it — same register,
 * same delivery — more closely than it resembles the lead, so having both to
 * choose from is most useful exactly where the lead alone is ambiguous.
 */
export function chainReference(
  guide: PreparedGuide,
  aligned: AlignResult,
  settings: AlignSettings,
): PreparedGuide {
  const mono =
    aligned.channels.length === 1
      ? aligned.channels[0]!
      : toMono({
          sampleRate: aligned.sampleRate,
          channels: aligned.channels,
          length: aligned.channels[0]!.length,
        });

  return {
    ...guide,
    features: [
      ...guide.features,
      extractAlignmentFeatures(mono, aligned.sampleRate, settings.gateDb),
    ],
  };
}

export async function alignAgainst(
  guide: PreparedGuide,
  dub: DecodedAudio,
  settings: AlignSettings,
  hooks: AlignHooks = {},
): Promise<AlignResult> {
  if (guide.sampleRate !== dub.sampleRate) {
    throw new Error("The two renders have different sample rates.");
  }
  const sampleRate = guide.sampleRate;
  if (dub.length < FFT_SIZE * 4) {
    throw new Error("Selection is too short to align — use at least half a second.");
  }

  await hooks.onStage?.("Analysing", 0);
  const dubMono = toMono(dub);
  const dubFeatures = extractAlignmentFeatures(dubMono, sampleRate, settings.gateDb);

  if (hooks.shouldAbort?.()) throw new Error("Cancelled.");

  await hooks.onStage?.("Matching", 0.15);
  const radius = Math.max(
    2,
    Math.round((settings.maxShiftMs / 1000) * sampleRate / HOP),
  );
  const { map, cost } = await alignFeatureTracks(guide.features, dubFeatures, radius, {
    onProgress: (fraction) => hooks.onStage?.("Matching", 0.15 + fraction * 0.35) ?? Promise.resolve(),
    ...(hooks.shouldAbort ? { shouldAbort: hooks.shouldAbort } : {}),
  });

  const curve = shapeWarpCurve(map, {
    resist: sibilantRuns(dubFeatures, map),
    strength: Math.min(1, Math.max(0, settings.strength / 100)),
    smoothingFrames: Math.max(
      0,
      Math.round((settings.smoothingMs / 1000) * sampleRate / HOP / 2),
    ),
    maxRatio: 1 + Math.max(1, settings.maxStretchPercent) / 100,
  });

  // Feature frame k is centred half an analysis window in, on both sides, so
  // the two half-windows cancel — but spelling it out keeps the mapping honest
  // if either hop or window ever changes.
  const centre = FFT_SIZE / 2;
  const lastFrame = curve.length - 1;
  const inputAt = (outputSample: number): number => {
    const position = (outputSample - centre) / HOP;
    let frame: number;
    // Extrapolate past both ends rather than clamping. Clamping would flatten
    // the curve over the first and last half-window, and WSOLA — which only
    // ever asks for a smooth continuation of wherever it started — carries that
    // flat head along as a constant delay through the whole take.
    if (position <= 0) {
      frame = curve[0]! + position * (curve[1]! - curve[0]!);
    } else if (position >= lastFrame) {
      frame =
        curve[lastFrame]! +
        (position - lastFrame) * (curve[lastFrame]! - curve[lastFrame - 1]!);
    } else {
      const index = Math.floor(position);
      const a = curve[index]!;
      const b = curve[index + 1]!;
      frame = a + (b - a) * (position - index);
    }
    return frame * HOP + centre;
  };

  await hooks.onStage?.("Stretching", 0.5);
  const channels = await warpChannels(dub.channels, dubMono, {
    sampleRate,
    inputAt,
    outputLength: guide.length,
    onProgress: (fraction) =>
      hooks.onStage?.("Stretching", 0.5 + fraction * 0.5) ?? Promise.resolve(),
    ...(hooks.shouldAbort ? { shouldAbort: hooks.shouldAbort } : {}),
  });

  return {
    channels,
    sampleRate,
    peakShiftMs: (peakShiftFrames(curve) * HOP * 1000) / sampleRate,
    cost,
  };
}

/** Sibilance above which a frame counts as an s, ch or f. */
const SIBILANT_AT = 0.45;
/** Longest run to protect, in seconds. */
const SIBILANT_MAX = 0.28;

/**
 * Marks the guide frames whose dub material is a short sibilant.
 *
 * Only short runs. A real s or ch lasts a fraction of a second, and refusing to
 * stretch anything noisy for as long as it happens to last would hand the
 * correction nowhere to go — a take that is broadly hissy would simply stop
 * being alignable.
 */
function sibilantRuns(dub: FeatureTrack, map: Float32Array): Float32Array {
  const resist = new Float32Array(map.length);
  const longest = Math.round((SIBILANT_MAX * dub.sampleRate) / HOP);

  // Sibilance sampled along the map, so it is indexed by guide frame like the
  // curve it will shape.
  const along = new Float32Array(map.length);
  for (let i = 0; i < map.length; i++) {
    const at = Math.min(dub.frameCount - 1, Math.max(0, Math.round(map[i]!)));
    along[i] = dub.sibilance[at]!;
  }

  let start = -1;
  for (let i = 0; i <= along.length; i++) {
    const hot = i < along.length && along[i]! >= SIBILANT_AT;
    if (hot && start < 0) start = i;
    if (!hot && start >= 0) {
      if (i - start <= longest) {
        // Taper the ends, so the curve bends into and out of the protected run
        // instead of stepping.
        const edge = Math.max(1, Math.round((i - start) / 4));
        for (let k = start; k < i; k++) {
          const into = Math.min(k - start + 1, i - k, edge) / edge;
          resist[k] = Math.min(1, into);
        }
      }
      start = -1;
    }
  }
  return resist;
}

/** One guide, one double — the shape the offline tools use. */
export const alignTake = (
  guide: DecodedAudio,
  dub: DecodedAudio,
  settings: AlignSettings,
  hooks: AlignHooks = {},
): Promise<AlignResult> =>
  alignAgainst(prepareGuide(guide, settings), dub, settings, hooks);
