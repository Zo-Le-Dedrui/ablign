/**
 * Does a second backing part align better when it can also see the first?
 *
 * The case this is for: a lead in one register and two backing parts in
 * another. Matched against the lead alone, a backing part is being compared to
 * a voice that does not sound much like it — and where two of its syllables are
 * similar, the lead may not be enough to tell them apart. The part beside it is
 * a much closer match.
 *
 * So: a low lead, two higher backing parts, and a phrase with two syllables
 * built alike on purpose. The second part is aligned twice, once against the
 * lead alone and once with the first part chained in, and the two are measured
 * against where the syllables should have landed.
 *
 *   npx tsx tools/chain-check.ts
 */
import { alignAgainst, chainReference, prepareGuide, DEFAULT_SETTINGS } from "../src/align.js";
import type { DecodedAudio } from "../src/audio/codec.js";

const SAMPLE_RATE = 44100;
const TOTAL = 5.0;

interface Voice {
  pitch: number;
  formants: [number, number];
}

const LEAD: Voice = { pitch: 118, formants: [640, 1100] };
const BACK: Voice = { pitch: 249, formants: [880, 1720] };

/** Syllable shapes; two of them are deliberately near-identical. */
const SHAPES: [number, number][] = [
  [1.0, 1.0],
  [1.35, 0.72],
  [1.0, 1.0], // same as the first
  [0.78, 1.4],
  [1.02, 0.99], // and again
  [1.3, 1.25],
];

function say(voice: Voice, starts: number[], seed: number): DecodedAudio {
  const length = Math.round(TOTAL * SAMPLE_RATE);
  const signal = new Float32Array(length);
  let state = seed >>> 0;
  const random = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296 - 0.5;
  };

  starts.forEach((start, index) => {
    const shape = SHAPES[index % SHAPES.length]!;
    const from = Math.round(start * SAMPLE_RATE);
    const count = Math.round(0.36 * SAMPLE_RATE);
    let phase = 0;
    let r1 = 0;
    let r1p = 0;
    let r2 = 0;
    let r2p = 0;
    const w1 = (2 * Math.PI * voice.formants[0] * shape[0]) / SAMPLE_RATE;
    const w2 = (2 * Math.PI * voice.formants[1] * shape[1]) / SAMPLE_RATE;

    for (let i = 0; i < count; i++) {
      const at = from + i;
      if (at < 0 || at >= length) continue;
      const p = i / count;
      const envelope = Math.min(1, p * 28) * Math.min(1, (1 - p) * 10) ** 0.5;

      phase += voice.pitch / SAMPLE_RATE;
      let pulse = 0;
      if (phase >= 1) {
        phase -= 1;
        pulse = 1;
      }
      const y1 = pulse + 2 * 0.984 * Math.cos(w1) * r1 - 0.984 * 0.984 * r1p;
      r1p = r1;
      r1 = y1;
      const y2 = pulse + 2 * 0.972 * Math.cos(w2) * r2 - 0.972 * 0.972 * r2p;
      r2p = r2;
      r2 = y2;

      signal[at] = signal[at]! + envelope * (0.02 * (y1 + 0.55 * y2) + 0.004 * random());
    }
  });

  let peak = 0;
  for (let i = 0; i < length; i++) peak = Math.max(peak, Math.abs(signal[i]!));
  if (peak > 0) for (let i = 0; i < length; i++) signal[i] = (signal[i]! / peak) * 0.7;
  return { sampleRate: SAMPLE_RATE, channels: [signal], length };
}

const onsets = [0.4, 1.15, 1.9, 2.65, 3.4, 4.15];
const drift1 = [0, 0.06, -0.05, 0.07, -0.04, 0.05];
const drift2 = [0, 0.05, -0.06, 0.06, -0.03, 0.06];

const lead = say(LEAD, onsets, 3);
const back1 = say(BACK, onsets.map((t, i) => t + drift1[i]!), 17);
const back2 = say(BACK, onsets.map((t, i) => t + drift2[i]!), 29);

/** Mean distance from each expected onset to the nearest one found, ms. */
function onsetError(signal: Float32Array): number {
  const window = 128;
  const frames = Math.floor(signal.length / window);
  const rms = new Float64Array(frames);
  let peak = 0;
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let i = 0; i < window; i++) sum += signal[f * window + i]! ** 2;
    rms[f] = Math.sqrt(sum / window);
    peak = Math.max(peak, rms[f]!);
  }

  const found: number[] = [];
  let inside = false;
  for (let f = 0; f < frames; f++) {
    if (!inside && rms[f]! > peak * 0.2) {
      found.push((f * window) / SAMPLE_RATE);
      inside = true;
    } else if (inside && rms[f]! < peak * 0.08) inside = false;
  }

  let total = 0;
  for (const want of onsets) {
    let best = Infinity;
    for (const got of found) best = Math.min(best, Math.abs(got - want));
    total += best;
  }
  return (total / onsets.length) * 1000;
}

const base = prepareGuide(lead, DEFAULT_SETTINGS);

const alone = await alignAgainst(base, back2, DEFAULT_SETTINGS);

const first = await alignAgainst(base, back1, DEFAULT_SETTINGS);
const chained = await alignAgainst(
  chainReference(base, first, DEFAULT_SETTINGS),
  back2,
  DEFAULT_SETTINGS,
);

const before = onsetError(back2.channels[0]!);
const withoutChain = onsetError(alone.channels[0]!);
const withChain = onsetError(chained.channels[0]!);

console.log(`\n  second backing part, onset error against the guide\n`);
console.log(`    unaligned            ${before.toFixed(1)} ms`);
console.log(`    lead only            ${withoutChain.toFixed(1)} ms`);
console.log(`    lead + first backing ${withChain.toFixed(1)} ms`);
console.log(
  `\n  chaining changes it by ${(withChain - withoutChain >= 0 ? "+" : "") + (withChain - withoutChain).toFixed(1)} ms\n`,
);
