/**
 * Does an already-tight double stay where it is?
 *
 * The failure this exists for, reported from a session: the takes that were
 * best to begin with are the ones that go wrong, a syllable jumping half a
 * second out of place. That is not a stretching fault, it is the matcher
 * having nothing to prefer. When a phrase repeats a similar syllable, the path
 * that lines take up correctly and the path that lines syllable three up with
 * syllable five cost nearly the same, and the cheaper of two near-equal costs
 * is decided by noise.
 *
 * So the phrase here repeats its shapes on purpose, and the double is already
 * within a few milliseconds. The right answer is "barely move anything", and
 * anything that moves a syllable a long way is the bug.
 *
 *   npx tsx tools/stability-check.ts
 */
import { alignTake, DEFAULT_SETTINGS, type AlignSettings } from "../src/align.js";
import type { DecodedAudio } from "../src/audio/codec.js";

const SAMPLE_RATE = 44100;
const TOTAL = 6.2;

/** Formant pairs; several repeat, which is what makes the phrase ambiguous. */
const SHAPES: [number, number][] = [
  [700, 1150],
  [520, 1800],
  [700, 1150], // same as 0
  [820, 1300],
  [520, 1800], // same as 1
  [700, 1150], // same as 0 again
  [820, 1300], // same as 3
  [610, 1500],
];

const ONSETS = [0.45, 1.1, 1.75, 2.4, 3.05, 3.7, 4.35, 5.0];

function say(starts: number[], pitch: number, seed: number): DecodedAudio {
  const length = Math.round(TOTAL * SAMPLE_RATE);
  const signal = new Float32Array(length);
  let state = seed >>> 0;
  const random = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296 - 0.5;
  };

  starts.forEach((start, index) => {
    const [f1, f2] = SHAPES[index]!;
    const from = Math.round(start * SAMPLE_RATE);
    const count = Math.round(0.34 * SAMPLE_RATE);
    let phase = 0;
    let r1 = 0;
    let r1p = 0;
    let r2 = 0;
    let r2p = 0;
    const w1 = (2 * Math.PI * f1) / SAMPLE_RATE;
    const w2 = (2 * Math.PI * f2) / SAMPLE_RATE;

    for (let i = 0; i < count; i++) {
      const at = from + i;
      if (at < 0 || at >= length) continue;
      const p = i / count;
      const envelope = Math.min(1, p * 30) * Math.min(1, (1 - p) * 9) ** 0.5;

      phase += pitch / SAMPLE_RATE;
      let pulse = 0;
      if (phase >= 1) {
        phase -= 1;
        pulse = 1;
      }
      const y1 = pulse + 2 * 0.984 * Math.cos(w1) * r1 - 0.984 * 0.984 * r1p;
      r1p = r1;
      r1 = y1;
      const y2 = pulse + 2 * 0.973 * Math.cos(w2) * r2 - 0.973 * 0.973 * r2p;
      r2p = r2;
      r2 = y2;

      signal[at] = signal[at]! + envelope * (0.02 * (y1 + 0.5 * y2) + 0.003 * random());
    }
  });

  let peak = 0;
  for (let i = 0; i < length; i++) peak = Math.max(peak, Math.abs(signal[i]!));
  if (peak > 0) for (let i = 0; i < length; i++) signal[i] = (signal[i]! / peak) * 0.7;
  return { sampleRate: SAMPLE_RATE, channels: [signal], length };
}

/** Onset times, seconds. */
function onsets(signal: Float32Array): number[] {
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
    } else if (inside && rms[f]! < peak * 0.07) inside = false;
  }
  return found;
}

/** Worst distance from an expected onset to the nearest one found, ms. */
function worstError(expected: number[], found: number[]): number {
  let worst = 0;
  for (const want of expected) {
    let best = Infinity;
    for (const got of found) best = Math.min(best, Math.abs(got - want));
    worst = Math.max(worst, best);
  }
  return worst * 1000;
}

const failures: string[] = [];
const check = (label: string, ok: boolean, detail: string) => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}: ${detail}`);
  if (!ok) failures.push(label);
};

const guide = say(ONSETS, 152, 21);

/** Already tight: a few milliseconds out, no more. */
const tight = [0.004, -0.003, 0.005, -0.002, 0.003, -0.004, 0.002, -0.003];

// Hold off is the default and is allowed to wander; the point of the control
// is that raising it stops the wandering, so that is what is asserted.
for (const [label, settings, allowed] of [
  ["hold off", DEFAULT_SETTINGS, 60],
  ["hold 100", { ...DEFAULT_SETTINGS, holdPercent: 100 }, 15],
  ["hold 100, max shift 600 ms", { ...DEFAULT_SETTINGS, holdPercent: 100, maxShiftMs: 600 }, 15],
] as [string, AlignSettings, number][]) {
  const dub = say(
    ONSETS.map((t, i) => t + tight[i]!),
    152,
    22,
  );
  const result = await alignTake(guide, dub, settings);

  const before = worstError(ONSETS, onsets(dub.channels[0]!));
  const after = worstError(ONSETS, onsets(result.channels[0]!));

  // A take this close should barely be touched. Onsets alone do not show it:
  // they sit on attacks, and the path is free to wander through the sustains
  // and gaps between them. Peak shift is what catches that wandering, and it
  // is the same mechanism that throws a syllable a long way when a phrase
  // repeats itself.
  check(
    `tight double stays put, ${label}`,
    after < 20 && result.peakShiftMs < allowed,
    `worst onset ${before.toFixed(1)} ms -> ${after.toFixed(1)} ms, peak shift ${result.peakShiftMs.toFixed(0)} ms`,
  );
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("\nstability ok");
