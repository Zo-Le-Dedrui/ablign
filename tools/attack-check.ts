/**
 * Does a phrase that starts cold land its first attacks exactly?
 *
 * The case: a phrase opens with two sharp hits — nothing before them but
 * silence — and the double pushes ahead, so its hits sit early. In the silence
 * every offset matches every other, the matcher's path there is whatever it
 * happened to tie-break to, and smoothing then averages that arbitrary path
 * into the attack's correction. The silence is also exactly where a correction
 * is free: nothing plays there, so the curve can ramp through it and meet the
 * first hit dead on.
 *
 * Also runs the case that would catch an over-eager fix: the whole double
 * uniformly early, where mishandling the curve's edges can silently undo the
 * entire correction instead of applying it.
 *
 *   npx tsx tools/attack-check.ts
 */
import { alignTake, DEFAULT_SETTINGS } from "../src/align.js";
import type { DecodedAudio } from "../src/audio/codec.js";

const SAMPLE_RATE = 44100;
const TOTAL = 4.4;

interface Part {
  at: number;
  /** 0 for a bang — click plus thump — otherwise a vowel at this pitch. */
  pitch: number;
  seconds: number;
}

function render(parts: Part[], seed: number): DecodedAudio {
  const length = Math.round(TOTAL * SAMPLE_RATE);
  const signal = new Float32Array(length);
  let state = seed >>> 0;
  const random = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296 - 0.5;
  };

  for (const part of parts) {
    const from = Math.round(part.at * SAMPLE_RATE);
    const count = Math.round(part.seconds * SAMPLE_RATE);

    if (part.pitch === 0) {
      // A bang: 2 ms of noise click, then a decaying 110 Hz thump.
      const click = Math.round(0.002 * SAMPLE_RATE);
      let phase = 0;
      for (let i = 0; i < count; i++) {
        const at = from + i;
        if (at < 0 || at >= length) continue;
        phase += (2 * Math.PI * 110) / SAMPLE_RATE;
        const decay = Math.exp(-6 * (i / count));
        const burst = i < click ? random() * 2 : 0;
        signal[at] = signal[at]! + burst + Math.sin(phase) * 0.8 * decay;
      }
    } else {
      let phase = 0;
      let r1 = 0;
      let r1p = 0;
      const w1 = (2 * Math.PI * 760) / SAMPLE_RATE;
      for (let i = 0; i < count; i++) {
        const at = from + i;
        if (at < 0 || at >= length) continue;
        const p = i / count;
        const envelope = Math.min(1, p * 25) * Math.min(1, (1 - p) * 10) ** 0.5;
        phase += part.pitch / SAMPLE_RATE;
        let pulse = 0;
        if (phase >= 1) {
          phase -= 1;
          pulse = 1;
        }
        const y1 = pulse + 2 * 0.984 * Math.cos(w1) * r1 - 0.984 * 0.984 * r1p;
        r1p = r1;
        r1 = y1;
        signal[at] = signal[at]! + envelope * 0.03 * y1;
      }
    }
  }

  let peak = 0;
  for (let i = 0; i < length; i++) peak = Math.max(peak, Math.abs(signal[i]!));
  if (peak > 0) for (let i = 0; i < length; i++) signal[i] = (signal[i]! / peak) * 0.7;
  return { sampleRate: SAMPLE_RATE, channels: [signal], length };
}

/** Onset times from a short-window envelope, seconds. */
function onsets(signal: Float32Array): number[] {
  const window = 64;
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
    if (!inside && rms[f]! > peak * 0.22) {
      found.push((f * window) / SAMPLE_RATE);
      inside = true;
    } else if (inside && rms[f]! < peak * 0.06) inside = false;
  }
  return found;
}

function errorAt(expected: number[], found: number[]): number {
  let total = 0;
  for (const want of expected) {
    let best = Infinity;
    for (const got of found) best = Math.min(best, Math.abs(got - want));
    total += best;
  }
  return (total / expected.length) * 1000;
}

const failures: string[] = [];
const check = (label: string, ok: boolean, detail: string) => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}: ${detail}`);
  if (!ok) failures.push(label);
};

// The guide: 0.8 s of nothing, bang, bang, then two vowels.
const guideParts: Part[] = [
  { at: 0.8, pitch: 0, seconds: 0.22 },
  { at: 1.25, pitch: 0, seconds: 0.22 },
  { at: 1.85, pitch: 155, seconds: 0.65 },
  { at: 2.75, pitch: 139, seconds: 0.75 },
];
const guide = render(guideParts, 5);
const bangTimes = [0.8, 1.25];

// Cold start: the double pushes the bangs 45 ms ahead, the vowels drift less.
{
  const dub = render(
    [
      { at: 0.755, pitch: 0, seconds: 0.22 },
      { at: 1.205, pitch: 0, seconds: 0.22 },
      { at: 1.87, pitch: 155, seconds: 0.65 },
      { at: 2.72, pitch: 139, seconds: 0.75 },
    ],
    6,
  );

  const result = await alignTake(guide, dub, DEFAULT_SETTINGS);
  const before = errorAt(bangTimes, onsets(dub.channels[0]!));
  const after = errorAt(bangTimes, onsets(result.channels[0]!));

  check("cold-start attacks land", after < 5, `${before.toFixed(1)} ms -> ${after.toFixed(1)} ms`);
}

// Uniformly early: everything 50 ms ahead, including at the selection edges.
// A curve that mishandles its edges can quietly subtract the whole correction.
{
  const dub = render(
    guideParts.map((part) => ({ ...part, at: part.at - 0.05 })),
    7,
  );

  const result = await alignTake(guide, dub, DEFAULT_SETTINGS);
  // Bangs only: the envelope detector cannot see the vowels next to
  // full-scale hits, and the attacks are what this file is about.
  const before = errorAt(bangTimes, onsets(dub.channels[0]!));
  const after = errorAt(bangTimes, onsets(result.channels[0]!));

  check("uniform offset still corrected", after < 8, `${before.toFixed(1)} ms -> ${after.toFixed(1)} ms`);
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("\nattacks ok");
