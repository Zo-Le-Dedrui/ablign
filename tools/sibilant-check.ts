/**
 * Does an s keep its own length through an alignment that stretches around it?
 *
 * The artefact bench drives the stretcher directly, so it cannot see anything
 * the warp curve decides — and refusing to stretch a sibilant is a curve
 * decision. This runs the whole pipeline on a phrase shaped like speech and
 * measures the one thing that matters here: how long the s came out.
 *
 * The double is built the way two real takes differ: the same word, but the s
 * held for a different length. The guide draws it out to 240 ms and the double
 * clips it at 120 ms, so matching them means stretching the double's s to twice
 * its length — unless it is allowed to keep it, and the vowels either side take
 * the correction instead.
 *
 *   npx tsx tools/sibilant-check.ts
 */
import { alignTake, DEFAULT_SETTINGS } from "../src/align.js";
import type { DecodedAudio } from "../src/audio/codec.js";

const SAMPLE_RATE = 44100;
const TOTAL = 2.6;

interface Part {
  at: number;
  seconds: number;
  /** Hz for a vowel, 0 for a sibilant. */
  pitch: number;
}

function phrase(parts: Part[], seed: number): DecodedAudio {
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
    let phase = 0;
    let r1 = 0;
    let r1p = 0;
    let r2 = 0;
    let r2p = 0;
    let low = 0;
    const w1 = (2 * Math.PI * 700) / SAMPLE_RATE;
    const w2 = (2 * Math.PI * 1220) / SAMPLE_RATE;

    for (let i = 0; i < count; i++) {
      const at = from + i;
      if (at < 0 || at >= length) continue;
      const p = i / count;
      const envelope = Math.min(1, p * 30) * Math.min(1, (1 - p) * 30);

      if (part.pitch === 0) {
        const white = random();
        low += 0.55 * (white - low);
        signal[at] = signal[at]! + envelope * (white - low) * 1.3;
      } else {
        phase += part.pitch / SAMPLE_RATE;
        let pulse = 0;
        if (phase >= 1) {
          phase -= 1;
          pulse = 1;
        }
        const y1 = pulse + 2 * 0.985 * Math.cos(w1) * r1 - 0.985 * 0.985 * r1p;
        r1p = r1;
        r1 = y1;
        const y2 = pulse + 2 * 0.975 * Math.cos(w2) * r2 - 0.975 * 0.975 * r2p;
        r2p = r2;
        r2 = y2;
        signal[at] = signal[at]! + envelope * 0.02 * (y1 + 0.5 * y2);
      }
    }
  }

  let peak = 0;
  for (let i = 0; i < length; i++) peak = Math.max(peak, Math.abs(signal[i]!));
  if (peak > 0) for (let i = 0; i < length; i++) signal[i] = (signal[i]! / peak) * 0.7;
  return { sampleRate: SAMPLE_RATE, channels: [signal], length };
}

/**
 * Length of the hissy stretch, in ms, from a crude high-band envelope. A vowel
 * has almost nothing up here, so the region that lights up is the sibilant.
 */
function hissLength(signal: Float32Array): number {
  const window = 256;
  const frames = Math.floor(signal.length / window);
  const band = new Float64Array(frames);
  let loudest = 0;

  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let i = 1; i < window; i++) {
      // A one-pole difference: everything below a couple of kHz falls away.
      const d = signal[f * window + i]! - signal[f * window + i - 1]!;
      sum += d * d;
    }
    band[f] = Math.sqrt(sum / window);
    loudest = Math.max(loudest, band[f]!);
  }

  let count = 0;
  for (let f = 0; f < frames; f++) if (band[f]! > loudest * 0.4) count++;
  return (count * window * 1000) / SAMPLE_RATE;
}

const guide = phrase(
  [
    { at: 0.3, seconds: 0.75, pitch: 147 },
    { at: 1.1, seconds: 0.24, pitch: 0 },
    { at: 1.4, seconds: 0.75, pitch: 165 },
  ],
  11,
);

const dub = phrase(
  [
    { at: 0.3, seconds: 0.75, pitch: 147 },
    { at: 1.1, seconds: 0.12, pitch: 0 },
    { at: 1.4, seconds: 0.75, pitch: 165 },
  ],
  12,
);

const result = await alignTake(guide, dub, DEFAULT_SETTINGS);

const source = hissLength(dub.channels[0]!);
const out = hissLength(result.channels[0]!);
const grew = ((out - source) / source) * 100;

console.log(`\n  s in the double  ${source.toFixed(0)} ms`);
console.log(`  s in the result  ${out.toFixed(0)} ms   ${(grew >= 0 ? "+" : "") + grew.toFixed(0)} %\n`);

// Protected, it keeps its own length and the vowels absorb the difference.
// Unprotected, matching the guide doubles it.
if (grew > 25) {
  console.error(`the s was stretched by ${grew.toFixed(0)} %, it should keep its length\n`);
  process.exit(1);
}
console.log("sibilant kept its length\n");
