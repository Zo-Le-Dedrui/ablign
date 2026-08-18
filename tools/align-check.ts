/**
 * Offline checks for the alignment pipeline. Run with `npm run check`.
 *
 * Builds a guide take and doubles of it that drift in known ways, aligns them,
 * and measures where the syllables actually landed. The harsh scenario exists
 * to pin down the Max stretch control: a correction that would need more
 * stretch than allowed is supposed to come out partially applied, not wrong.
 */
import { alignTake, DEFAULT_SETTINGS, type AlignSettings } from "../src/align.js";
import type { DecodedAudio } from "../src/audio/codec.js";

const SAMPLE_RATE = 44100;

interface Syllable {
  /** Seconds. */
  start: number;
  duration: number;
  /** Fundamental, Hz — varied so the matcher has something to tell them apart. */
  pitch: number;
  /** 0 = pure tone, 1 = pure noise. Stands in for vowels versus consonants. */
  noise: number;
}

function render(
  syllables: Syllable[],
  totalSeconds: number,
  seed: number,
  channelCount = 1,
): DecodedAudio {
  const length = Math.round(totalSeconds * SAMPLE_RATE);
  const signal = new Float32Array(length);

  // Deterministic noise so a failure is reproducible.
  let state = seed >>> 0;
  const random = (): number => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296 - 0.5;
  };

  for (const syllable of syllables) {
    const from = Math.round(syllable.start * SAMPLE_RATE);
    const count = Math.round(syllable.duration * SAMPLE_RATE);
    let phase = 0;

    for (let i = 0; i < count; i++) {
      const at = from + i;
      if (at < 0 || at >= length) continue;
      const position = i / count;
      // Fast attack, slow decay — roughly syllable-shaped.
      const envelope =
        Math.min(1, position * 40) * Math.min(1, (1 - position) * 8) ** 0.5;

      const vibrato = 1 + 0.01 * Math.sin((2 * Math.PI * 5 * i) / SAMPLE_RATE);
      phase += (2 * Math.PI * syllable.pitch * vibrato) / SAMPLE_RATE;
      const harmonics =
        Math.sin(phase) + 0.5 * Math.sin(2 * phase) + 0.25 * Math.sin(3 * phase);

      signal[at] =
        signal[at]! +
        envelope * ((1 - syllable.noise) * harmonics * 0.3 + syllable.noise * random());
    }
  }

  const channels = [signal];
  // A second channel at a fixed lower level checks that both sides get the same
  // grain positions rather than being searched independently.
  for (let c = 1; c < channelCount; c++) {
    const copy = new Float32Array(length);
    for (let i = 0; i < length; i++) copy[i] = signal[i]! * 0.7;
    channels.push(copy);
  }
  return { sampleRate: SAMPLE_RATE, channels, length };
}

/** Burst starts, from a short-window RMS envelope crossing a relative threshold. */
function detectOnsets(signal: Float32Array): number[] {
  const window = 256;
  const frames = Math.floor(signal.length / window);
  const rms = new Float64Array(frames);
  let peak = 0;

  for (let frame = 0; frame < frames; frame++) {
    let sum = 0;
    for (let i = 0; i < window; i++) {
      const value = signal[frame * window + i]!;
      sum += value * value;
    }
    rms[frame] = Math.sqrt(sum / window);
    peak = Math.max(peak, rms[frame]!);
  }

  const threshold = peak * 0.12;
  const onsets: number[] = [];
  let inside = false;
  for (let frame = 0; frame < frames; frame++) {
    if (!inside && rms[frame]! > threshold) {
      onsets.push((frame * window) / SAMPLE_RATE);
      inside = true;
    } else if (inside && rms[frame]! < threshold * 0.5) {
      inside = false;
    }
  }
  return onsets;
}

/** Mean absolute distance from each expected onset to the nearest detected one, ms. */
function onsetError(expected: number[], found: number[]): number {
  if (!found.length) return Infinity;
  let total = 0;
  for (const time of expected) {
    let best = Infinity;
    for (const candidate of found) best = Math.min(best, Math.abs(candidate - time));
    total += best;
  }
  return (total / expected.length) * 1000;
}

const pitches = [180, 220, 165, 240, 196, 147, 262, 208, 175, 233, 155, 294];
const noises = [0.1, 0.7, 0.15, 0.2, 0.8, 0.1, 0.25, 0.6, 0.12, 0.2, 0.75, 0.15];

const guideSyllables: Syllable[] = pitches.map((pitch, i) => ({
  start: 0.5 + i * 0.6,
  duration: 0.35,
  pitch,
  noise: noises[i]!,
}));
const totalSeconds = 0.5 + pitches.length * 0.6 + 0.5;
const expected = guideSyllables.map((syllable) => syllable.start);

function double(
  drifts: number[],
  stretch: number,
  seed: number,
  channels = 1,
): DecodedAudio {
  return render(
    guideSyllables.map((syllable, i) => ({
      ...syllable,
      start: syllable.start + drifts[i]!,
      duration: syllable.duration * (i % 2 === 0 ? stretch : 2 - stretch),
    })),
    totalSeconds,
    seed,
    channels,
  );
}

/** What a singer actually does: never quite together, never wildly apart. */
const realistic = [0, 0.05, 0.09, 0.04, -0.02, -0.07, -0.03, 0.02, 0.07, 0.03, -0.02, -0.06];
/** Adjacent syllables up to 170 ms apart — beyond what 40 % stretch can absorb. */
const harsh = [0, 0.08, -0.05, 0.12, 0.03, -0.09, 0.06, 0.11, -0.04, 0.07, -0.1, 0.05];

const guide = render(guideSyllables, totalSeconds, 12345);

const failures: string[] = [];
const check = (label: string, ok: boolean, detail: string) => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}: ${detail}`);
  if (!ok) failures.push(label);
};

async function run(dub: DecodedAudio, settings: AlignSettings = DEFAULT_SETTINGS) {
  const result = await alignTake(guide, dub, settings);
  return {
    error: onsetError(expected, detectOnsets(result.channels[0]!)),
    before: onsetError(expected, detectOnsets(dub.channels[0]!)),
    result,
  };
}

const started = Date.now();
const stereo = double(realistic, 1.04, 67890, 2);
const normal = await run(stereo);
const elapsed = (Date.now() - started) / 1000;

console.log(`\nalign: ${totalSeconds.toFixed(1)}s stereo in ${elapsed.toFixed(1)}s`);
console.log(
  `path cost ${normal.result.cost.toFixed(3)}, peak shift ${normal.result.peakShiftMs.toFixed(0)} ms\n`,
);

const aligned = normal.result.channels;
check("output length", aligned[0]!.length === guide.length, `${aligned[0]!.length} samples`);
check("channel count", aligned.length === 2, `${aligned.length}`);

let finite = true;
let peak = 0;
for (const value of aligned[0]!) {
  if (!Number.isFinite(value)) finite = false;
  peak = Math.max(peak, Math.abs(value));
}
let sourcePeak = 0;
for (const value of stereo.channels[0]!) sourcePeak = Math.max(sourcePeak, Math.abs(value));
check("no NaN or Inf", finite, finite ? "clean" : "found non-finite samples");
check(
  "level preserved",
  peak > sourcePeak * 0.6 && peak < sourcePeak * 1.4,
  `peak ${peak.toFixed(3)} vs source ${sourcePeak.toFixed(3)}`,
);

// The right channel is the left at 0.7x; if the two were searched separately
// their grains would diverge and that ratio would wander.
let worstRatio = 0;
for (let i = 0; i < aligned[0]!.length; i++) {
  if (Math.abs(aligned[0]![i]!) < 0.02) continue;
  worstRatio = Math.max(worstRatio, Math.abs(aligned[1]![i]! / aligned[0]![i]! - 0.7));
}
check("channels stay locked", worstRatio < 1e-4, `worst deviation ${worstRatio.toExponential(1)}`);

check(
  "onsets corrected",
  normal.error < 20,
  `${normal.before.toFixed(0)} ms -> ${normal.error.toFixed(0)} ms`,
);
// The onset detector works on 256-sample frames and the syllables take ~9 ms
// to reach full level, so a few milliseconds of the residual are the ruler
// rather than the alignment. 3x is the most this measurement can honestly ask.
check(
  "clear improvement",
  normal.error < normal.before / 3,
  `${(normal.before / Math.max(normal.error, 1e-6)).toFixed(1)}x better`,
);

// Max stretch is a real limit, not a suggestion: the harsh double needs more
// than the default allows, so it should improve less — and improve more once
// the limit is raised.
const harshDub = double(harsh, 1.12, 4242);
const limited = await run(harshDub, { ...DEFAULT_SETTINGS, maxStretchPercent: 40 });
const loosened = await run(harshDub, { ...DEFAULT_SETTINGS, maxStretchPercent: 150 });
check(
  "max stretch binds",
  loosened.error < limited.error * 0.7,
  `${limited.error.toFixed(0)} ms at 40% -> ${loosened.error.toFixed(0)} ms at 150%`,
);
check(
  "harsh case still improves",
  limited.error < limited.before,
  `${limited.before.toFixed(0)} ms -> ${limited.error.toFixed(0)} ms`,
);

// Onset detection bottoms out around 6 ms, so it cannot tell a good alignment
// from an excellent one. This measures the same thing the eye does in the
// arrangement: the lag at which each aligned syllable best lines up with the
// guide. It correlates envelopes rather than raw samples on purpose — the
// noisy syllables are different noise in the two takes, so their waveforms
// never correlate however well they are aligned, but their shapes do.
const ENVELOPE_HOP = 64;

function envelope(signal: Float32Array): Float32Array {
  const frames = Math.floor(signal.length / ENVELOPE_HOP);
  const out = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame++) {
    let sum = 0;
    for (let i = 0; i < ENVELOPE_HOP; i++) {
      const value = signal[frame * ENVELOPE_HOP + i]!;
      sum += value * value;
    }
    out[frame] = Math.sqrt(sum / ENVELOPE_HOP);
  }
  return out;
}

const guideEnvelope = envelope(guide.channels[0]!);

function waveformLag(take: Float32Array): { mean: number; worst: number } {
  const taken = envelope(take);
  const half = Math.round((0.06 * SAMPLE_RATE) / ENVELOPE_HOP);
  const search = Math.round((0.15 * SAMPLE_RATE) / ENVELOPE_HOP);
  let total = 0;
  let worst = 0;

  for (const syllable of guideSyllables) {
    const centre = Math.round((syllable.start * SAMPLE_RATE) / ENVELOPE_HOP);
    let best = -Infinity;
    let bestLag = 0;
    for (let lag = -search; lag <= search; lag++) {
      let dot = 0;
      let energy = 0;
      for (let i = centre - half; i < centre + half; i++) {
        const value = taken[i + lag] ?? 0;
        dot += (guideEnvelope[i] ?? 0) * value;
        energy += value * value;
      }
      const score = dot / Math.sqrt(energy + 1e-12);
      if (score > best) {
        best = score;
        bestLag = lag;
      }
    }
    const ms = Math.abs((bestLag * ENVELOPE_HOP * 1000) / SAMPLE_RATE);
    total += ms;
    worst = Math.max(worst, ms);
  }
  return { mean: total / guideSyllables.length, worst };
}

const lag = waveformLag(aligned[0]!);
const lagBefore = waveformLag(stereo.channels[0]!);
check("waveform lag", lag.mean < 5, `${lagBefore.mean.toFixed(1)} ms -> ${lag.mean.toFixed(1)} ms mean`);
check("worst syllable", lag.worst < 12, `${lagBefore.worst.toFixed(1)} ms -> ${lag.worst.toFixed(1)} ms`);

// Strength has to be a usable dial across its whole range, not a switch: half
// the strength should leave roughly half the original error, so backing off to
// keep two takes from fusing is predictable rather than a guess.
const halfway = await run(stereo, { ...DEFAULT_SETTINGS, strength: 50 });
const halfLag = waveformLag(halfway.result.channels[0]!).mean;
check(
  "strength is proportional",
  halfLag > lag.mean * 3 && halfLag < lagBefore.mean * 0.75,
  `100% ${lag.mean.toFixed(1)} ms, 50% ${halfLag.toFixed(1)} ms, 0% ${lagBefore.mean.toFixed(1)} ms`,
);

// Strength 0 must be a bypass, or the control is lying about its range.
const bypass = await run(stereo, { ...DEFAULT_SETTINGS, strength: 0 });
check(
  "strength 0 bypasses",
  Math.abs(bypass.error - bypass.before) < 6,
  `${bypass.before.toFixed(0)} ms -> ${bypass.error.toFixed(0)} ms`,
);

// Aligning a take against itself must be a no-op, otherwise the pipeline is
// inventing corrections and every real run carries that error too.
const identity = await alignTake(guide, guide, DEFAULT_SETTINGS);
let drift = 0;
let energy = 0;
for (let i = 0; i < guide.length; i++) {
  const difference = identity.channels[0]![i]! - guide.channels[0]![i]!;
  drift += difference * difference;
  energy += guide.channels[0]![i]! * guide.channels[0]![i]!;
}
const residualDb = 10 * Math.log10(drift / (energy + 1e-12) + 1e-12);
check("self-align is a no-op", identity.peakShiftMs < 12, `peak shift ${identity.peakShiftMs.toFixed(1)} ms`);
check("self-align residual", residualDb < -60, `${residualDb.toFixed(0)} dB below source`);

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("\nall checks passed");
