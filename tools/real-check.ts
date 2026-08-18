/**
 * The reported fault, on the audio it was reported from.
 *
 * Four synthetic benches failed to reproduce it, which is why four attempts at
 * fixing it went nowhere. This one uses a real lead and a real double out of
 * the session, truncated to a common span, so the thing being measured is the
 * thing being complained about.
 *
 * The files are not in the repository — they are somebody's vocal takes. Point
 * this at a pair of your own:
 *
 *   npx tsx tools/real-check.ts <guide.wav> <dub.wav>
 */
import * as fs from "node:fs";
import { alignTake, DEFAULT_SETTINGS, type AlignSettings } from "../src/align.js";
import { decodeAudioFile, toMono, type DecodedAudio } from "../src/audio/codec.js";

const [guidePath, dubPath] = process.argv.slice(2);
if (!guidePath || !dubPath) {
  console.error("usage: real-check.ts <guide.wav> <dub.wav>");
  process.exit(1);
}

function load(path: string): DecodedAudio {
  return decodeAudioFile(new Uint8Array(fs.readFileSync(path)));
}

/** Trims to `samples`, so both takes cover the same span as a render would. */
function trim(audio: DecodedAudio, samples: number): DecodedAudio {
  const length = Math.min(audio.length, samples);
  return {
    sampleRate: audio.sampleRate,
    channels: audio.channels.map((c) => c.subarray(0, length)),
    length,
  };
}

/** Onset times in seconds, from an envelope wider than a pitch period. */
function onsets(mono: Float32Array, sampleRate: number): number[] {
  const window = Math.round(sampleRate * 0.012);
  const frames = Math.floor(mono.length / window);
  const envelope = new Float64Array(frames);
  let peak = 0;
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let i = 0; i < window; i++) sum += mono[f * window + i]! ** 2;
    envelope[f] = Math.sqrt(sum / window);
    peak = Math.max(peak, envelope[f]!);
  }

  const at: number[] = [];
  let inside = false;
  for (let f = 0; f < frames; f++) {
    if (!inside && envelope[f]! > peak * 0.14) {
      at.push((f * window) / sampleRate);
      inside = true;
    } else if (inside && envelope[f]! < peak * 0.05) inside = false;
  }
  return at;
}

const guideFull = load(guidePath);
const guide = guideFull;
const dub = trim(load(dubPath), guideFull.length);

const guideOnsets = onsets(toMono(guide), guide.sampleRate);

/**
 * For every onset in the guide, how far the nearest onset in the other take
 * sits. Reported as a list as well as a mean, because the shape of the errors
 * is the diagnosis: a steady drift is a rate problem, isolated jumps of half a
 * second are syllables landing on the wrong neighbour.
 */
function errors(audio: DecodedAudio): number[] {
  const found = onsets(toMono(audio), audio.sampleRate);
  return guideOnsets.map((want) => {
    let best = Infinity;
    for (const got of found) {
      if (Math.abs(got - want) < Math.abs(best)) best = got - want;
    }
    return best * 1000;
  });
}

/**
 * Only the words the double actually sings.
 *
 * Measuring every lead onset was the wrong ruler and said nothing could be
 * fixed: a backing part does not sing every word, so where it is silent there
 * will never be an onset in the result however well the alignment did. Those
 * lead syllables were being counted as permanent failures — 4 of 13 — and they
 * drowned out the question that matters, which is whether the words the double
 * *does* sing land in the right place.
 *
 * So the pairs are chosen from the unaligned take: a lead onset with a double
 * onset already within 150 ms is a real counterpart, and the alignment's job is
 * to close the remaining gap. Anything further apart is the double not being
 * there, and is not the alignment's to answer for.
 */
const PAIRED_WITHIN = 150;
const unaligned = errors(dub);
const paired = guideOnsets
  .map((_, i) => i)
  .filter((i) => Math.abs(unaligned[i]!) <= PAIRED_WITHIN);

const summarise = (values: number[]) => {
  const absolute = paired.map((i) => Math.abs(values[i]!));
  const mean = absolute.reduce((a, b) => a + b, 0) / absolute.length;
  const worst = Math.max(...absolute);
  const wrong = absolute.filter((v) => v > 60).length;
  return { mean, worst, wrong };
};

console.log(
  `  ${paired.length} of ${guideOnsets.length} lead syllables have a counterpart in the double
`,
);

const settings: [string, AlignSettings][] = [
  ["max shift 200 (default)", DEFAULT_SETTINGS],
  ["max shift 100", { ...DEFAULT_SETTINGS, maxShiftMs: 100 }],
  ["max shift 300", { ...DEFAULT_SETTINGS, maxShiftMs: 300 }],
  ["max shift 800", { ...DEFAULT_SETTINGS, maxShiftMs: 800 }],
];

for (const [label, setting] of settings) {
  const result = await alignTake(guide, dub, setting);
  const summary = summarise(
    errors({ sampleRate: result.sampleRate, channels: result.channels, length: result.channels[0]!.length }),
  );
  console.log(
    `  ${label.padEnd(18)} mean ${summary.mean.toFixed(0).padStart(4)} ms   worst ${summary.worst.toFixed(0).padStart(4)} ms   ${summary.wrong} past 60 ms   (peak shift ${result.peakShiftMs.toFixed(0)} ms, cost ${result.cost.toFixed(3)})`,
  );
}
console.log();
