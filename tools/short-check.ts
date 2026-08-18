/**
 * Do short syllables land as well as long ones?
 *
 * Reported from a session: it goes wrong on the short syllables, picking the
 * wrong word to line them up with. That follows directly from how the matcher
 * scores. Its cost accumulates one frame at a time, so a 400 ms held vowel
 * casts five times the vote of an 80 ms syllable — and getting the short one
 * wrong costs the path almost nothing. The long material decides, and the short
 * material is dragged along wherever that leaves it.
 *
 * The phrase here alternates long and short deliberately, and the short ones
 * drift the other way from their neighbours so that following the neighbour is
 * measurably wrong. Errors are reported for the two kinds separately, because
 * an average over both hides exactly the failure being looked for.
 *
 *   npx tsx tools/short-check.ts
 */
import { alignTake, DEFAULT_SETTINGS, type AlignSettings } from "../src/align.js";
import type { DecodedAudio } from "../src/audio/codec.js";

const SAMPLE_RATE = 44100;
const TOTAL = 7.0;

interface Syllable {
  at: number;
  seconds: number;
  formants: [number, number];
}

/**
 * A long vowel to anchor each end, and a run of short syllables between them
 * that are all built alike.
 *
 * Identical on purpose: a short syllable carries barely a dozen frames of
 * evidence, and when its neighbours look the same, lining it up with the wrong
 * one costs the path almost nothing. Spaced 300 ms apart and drifted 160, the
 * wrong neighbour actually sits closer to the diagonal than the right answer
 * does — so anything that decides by weight of frames rather than by evidence
 * will take it.
 */
const SHORT: [number, number] = [430, 2100];
const LAYOUT: { at: number; seconds: number; formants: [number, number] }[] = [
  { at: 0.35, seconds: 0.45, formants: [700, 1150] },
  { at: 1.10, seconds: 0.10, formants: SHORT },
  { at: 1.40, seconds: 0.10, formants: SHORT },
  { at: 1.70, seconds: 0.10, formants: SHORT },
  { at: 2.00, seconds: 0.10, formants: SHORT },
  { at: 2.30, seconds: 0.10, formants: SHORT },
  { at: 2.75, seconds: 0.45, formants: [640, 1300] },
  { at: 3.50, seconds: 0.10, formants: SHORT },
  { at: 3.80, seconds: 0.10, formants: SHORT },
  { at: 4.10, seconds: 0.10, formants: SHORT },
  { at: 4.40, seconds: 0.10, formants: SHORT },
  { at: 4.70, seconds: 0.10, formants: SHORT },
  { at: 5.15, seconds: 0.45, formants: [820, 1250] },
  { at: 5.90, seconds: 0.45, formants: [700, 1150] },
];

const isShort = (index: number) => LAYOUT[index]!.seconds < 0.2;

function say(starts: number[], seed: number): DecodedAudio {
  const length = Math.round(TOTAL * SAMPLE_RATE);
  const signal = new Float32Array(length);
  let state = seed >>> 0;
  const random = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296 - 0.5;
  };

  starts.forEach((start, index) => {
    const shape = LAYOUT[index]!;
    const from = Math.round(start * SAMPLE_RATE);
    const count = Math.round(shape.seconds * SAMPLE_RATE);
    let phase = 0;
    let r1 = 0;
    let r1p = 0;
    let r2 = 0;
    let r2p = 0;
    const w1 = (2 * Math.PI * shape.formants[0]) / SAMPLE_RATE;
    const w2 = (2 * Math.PI * shape.formants[1]) / SAMPLE_RATE;

    for (let i = 0; i < count; i++) {
      const at = from + i;
      if (at < 0 || at >= length) continue;
      const p = i / count;
      const envelope = Math.min(1, p * 40) * Math.min(1, (1 - p) * 12) ** 0.5;

      phase += 148 / SAMPLE_RATE;
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

      // Short syllables sit well below the long ones, as they do in speech.
      // That matters: quiet frames are pushed towards the "quiet" axis of the
      // feature vector, so a short syllable can end up with almost no say.
      const level = shape.seconds < 0.2 ? 0.22 : 1;
      signal[at] =
        signal[at]! + level * envelope * (0.02 * (y1 + 0.55 * y2) + 0.003 * random());
    }
  });

  let peak = 0;
  for (let i = 0; i < length; i++) peak = Math.max(peak, Math.abs(signal[i]!));
  if (peak > 0) for (let i = 0; i < length; i++) signal[i] = (signal[i]! / peak) * 0.7;
  return { sampleRate: SAMPLE_RATE, channels: [signal], length };
}

/**
 * Onset times, seconds.
 *
 * The window has to be longer than a pitch period or the envelope rides the
 * individual glottal pulses and every one of them reads as an onset — 380 of
 * them for a phrase with fourteen syllables. 512 samples is 12 ms, comfortably
 * over the period at 148 Hz and still eight frames inside a 100 ms syllable.
 */
function onsets(signal: Float32Array): number[] {
  const window = 512;
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
    if (!inside && rms[f]! > peak * 0.15) {
      found.push((f * window) / SAMPLE_RATE);
      inside = true;
    } else if (inside && rms[f]! < peak * 0.05) inside = false;
  }
  return found;
}

/**
 * Mean error over the given syllables, ms, pairing them in order.
 *
 * Nearest-onset matching is useless here and quietly said everything was fine:
 * when five identical syllables sit 300 ms apart, one landing where its
 * neighbour belongs still leaves an onset near every expected time, so a clean
 * swap scores zero. Pairing the nth detected onset with the nth expected one is
 * what makes a swap visible — which is the failure being hunted.
 */
function errorOver(want: number[], found: number[], indices: number[]): number {
  if (found.length !== want.length) return Infinity;
  let total = 0;
  for (const i of indices) total += Math.abs(found[i]! - want[i]!);
  return (total / indices.length) * 1000;
}

const failures: string[] = [];
const check = (label: string, ok: boolean, detail: string) => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}: ${detail}`);
  if (!ok) failures.push(label);
};

const guideStarts = LAYOUT.map((s) => s.at);
const guide = say(guideStarts, 31);

// Everything late by 160 ms. For the short runs that puts the previous
// neighbour nearer the diagonal than the true match, which is the trap.
const dubStarts = LAYOUT.map((s) => s.at + 0.16);
const dub = say(dubStarts, 32);

const longIndices = guideStarts.map((_, i) => i).filter((i) => !isShort(i));
const shortIndices = guideStarts.map((_, i) => i).filter((i) => isShort(i));

for (const [label, settings] of [
  ["defaults", DEFAULT_SETTINGS],
] as [string, AlignSettings][]) {
  const result = await alignTake(guide, dub, settings);
  const found = onsets(result.channels[0]!);
  const before = onsets(dub.channels[0]!);

  const longAfter = errorOver(guideStarts, found, longIndices);
  const shortAfter = errorOver(guideStarts, found, shortIndices);
  const shortBefore = errorOver(dubStarts, before, shortIndices);
  console.log(`  onsets: ${found.length} found, ${guideStarts.length} expected`);

  console.log(
    `\n  ${label}: long ${longAfter.toFixed(1)} ms, short ${shortBefore.toFixed(1)} -> ${shortAfter.toFixed(1)} ms\n`,
  );

  check(`long syllables land, ${label}`, longAfter < 12, `${longAfter.toFixed(1)} ms`);
  check(`short syllables land, ${label}`, shortAfter < 15, `${shortBefore.toFixed(1)} ms -> ${shortAfter.toFixed(1)} ms`);
  // The whole point: a short syllable should not be markedly worse served than
  // a long one just for being short.
  check(
    `short are not the poor relation, ${label}`,
    shortAfter < longAfter * 2.5 + 4,
    `short ${shortAfter.toFixed(1)} ms vs long ${longAfter.toFixed(1)} ms`,
  );
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("\nshort syllables ok");
