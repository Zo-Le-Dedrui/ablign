/**
 * Experiment harness for alignment tightness.
 *
 * `align-check.ts` measures onset error with a 256-sample detector, which
 * bottoms out around 6 ms — fine as a regression guard, useless for telling
 * whether a change moved the result from 8 ms to 3 ms. This measures what you
 * actually see in the arrangement instead: per syllable, the lag at which the
 * aligned take correlates best against the guide.
 *
 *   npx tsx tools/tighten.ts
 */
import { alignTake, DEFAULT_SETTINGS, type AlignSettings } from "../src/align.js";
import type { DecodedAudio } from "../src/audio/codec.js";

const SAMPLE_RATE = 44100;

interface Syllable {
  start: number;
  duration: number;
  pitch: number;
  noise: number;
}

/**
 * Voice-ish: a buzzing source through a couple of fixed resonances, with a
 * consonant burst on the front. The burst matters — it is the thing whose
 * position the eye judges in a waveform.
 */
function render(syllables: Syllable[], totalSeconds: number, seed: number): DecodedAudio {
  const length = Math.round(totalSeconds * SAMPLE_RATE);
  const signal = new Float32Array(length);

  let state = seed >>> 0;
  const random = (): number => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296 - 0.5;
  };

  for (const syllable of syllables) {
    const from = Math.round(syllable.start * SAMPLE_RATE);
    const count = Math.round(syllable.duration * SAMPLE_RATE);
    const burst = Math.round(0.02 * SAMPLE_RATE);
    let phase = 0;
    // Two resonators standing in for formants, so the spectrum is not flat.
    let r1 = 0;
    let r1p = 0;
    let r2 = 0;
    let r2p = 0;

    for (let i = 0; i < count; i++) {
      const at = from + i;
      if (at < 0 || at >= length) continue;
      const position = i / count;
      const envelope =
        Math.min(1, position * 30) * Math.min(1, (1 - position) * 8) ** 0.5;

      const vibrato = 1 + 0.01 * Math.sin((2 * Math.PI * 5 * i) / SAMPLE_RATE);
      phase += (2 * Math.PI * syllable.pitch * vibrato) / SAMPLE_RATE;
      const glottal = Math.sin(phase) + 0.5 * Math.sin(2 * phase) + 0.25 * Math.sin(3 * phase);

      const excitation = (1 - syllable.noise) * glottal + syllable.noise * random() * 2;

      // Direct-form resonators, unrolled for the two formants.
      const w1 = (2 * Math.PI * 700) / SAMPLE_RATE;
      const w2 = (2 * Math.PI * 1400) / SAMPLE_RATE;
      const y1 = excitation + 2 * 0.97 * Math.cos(w1) * r1 - 0.97 * 0.97 * r1p;
      r1p = r1;
      r1 = y1;
      const y2 = excitation + 2 * 0.95 * Math.cos(w2) * r2 - 0.95 * 0.95 * r2p;
      r2p = r2;
      r2 = y2;

      // A short noisy consonant on the front of every syllable.
      const attack = i < burst ? (1 - i / burst) * random() * 3 : 0;

      signal[at] = signal[at]! + envelope * (0.02 * (y1 + 0.6 * y2) + attack * 0.4);
    }
  }

  let peak = 0;
  for (let i = 0; i < length; i++) peak = Math.max(peak, Math.abs(signal[i]!));
  if (peak > 0) for (let i = 0; i < length; i++) signal[i] = (signal[i]! / peak) * 0.7;

  return { sampleRate: SAMPLE_RATE, channels: [signal], length };
}

/** Lag, in samples, at which `b` best matches `a` over one window. */
function bestLag(a: Float32Array, b: Float32Array, centre: number, half: number, search: number): number {
  let best = -Infinity;
  let bestAt = 0;
  for (let lag = -search; lag <= search; lag++) {
    let dot = 0;
    let energy = 0;
    for (let i = centre - half; i < centre + half; i++) {
      const value = b[i + lag] ?? 0;
      dot += (a[i] ?? 0) * value;
      energy += value * value;
    }
    const score = dot / Math.sqrt(energy + 1e-12);
    if (score > best) {
      best = score;
      bestAt = lag;
    }
  }
  return bestAt;
}

const pitches = [180, 220, 165, 240, 196, 147, 262, 208, 175, 233, 155, 294];
const noises = [0.1, 0.7, 0.15, 0.2, 0.8, 0.1, 0.25, 0.6, 0.12, 0.2, 0.75, 0.15];
const drifts = [0, 0.05, 0.09, 0.04, -0.02, -0.07, -0.03, 0.02, 0.07, 0.03, -0.02, -0.06];

const guideSyllables: Syllable[] = pitches.map((pitch, i) => ({
  start: 0.5 + i * 0.6,
  duration: 0.35,
  pitch,
  noise: noises[i]!,
}));
const totalSeconds = 0.5 + pitches.length * 0.6 + 0.5;

const guide = render(guideSyllables, totalSeconds, 12345);
const dub = render(
  guideSyllables.map((syllable, i) => ({
    ...syllable,
    start: syllable.start + drifts[i]!,
    duration: syllable.duration * (i % 2 === 0 ? 1.04 : 0.96),
  })),
  totalSeconds,
  67890,
);

/** Mean and worst |lag| between the guide and a take, measured per syllable. */
function measure(take: Float32Array): { mean: number; worst: number } {
  const half = Math.round(0.06 * SAMPLE_RATE);
  const search = Math.round(0.15 * SAMPLE_RATE);
  let total = 0;
  let worst = 0;
  for (const syllable of guideSyllables) {
    // Centre on the attack, which is what the eye lines up.
    const centre = Math.round((syllable.start + 0.03) * SAMPLE_RATE);
    const lag = Math.abs((bestLag(guide.channels[0]!, take, centre, half, search) / SAMPLE_RATE) * 1000);
    total += lag;
    worst = Math.max(worst, lag);
  }
  return { mean: total / guideSyllables.length, worst };
}

const before = measure(dub.channels[0]!);
console.log(`\nunaligned double: mean ${before.mean.toFixed(1)} ms, worst ${before.worst.toFixed(1)} ms\n`);

const variants: [string, Partial<AlignSettings>][] = [
  ["defaults", {}],
  ["strength 90", { strength: 90 }],
  ["strength 80", { strength: 80 }],
  ["strength 70", { strength: 70 }],
  ["strength 50", { strength: 50 }],
  ["strength 25", { strength: 25 }],
  ["strength 0", { strength: 0 }],
  ["smoothing 20", { smoothingMs: 20 }],
  ["smoothing 0", { smoothingMs: 0 }],
  ["max stretch 40", { maxStretchPercent: 40 }],
];

for (const [label, overrides] of variants) {
  const settings: AlignSettings = { ...DEFAULT_SETTINGS, ...overrides };
  const result = await alignTake(guide, dub, settings);
  const after = measure(result.channels[0]!);
  console.log(
    `${label.padEnd(24)} mean ${after.mean.toFixed(1).padStart(5)} ms   worst ${after.worst.toFixed(1).padStart(5)} ms`,
  );
}
