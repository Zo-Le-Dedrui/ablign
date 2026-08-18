/**
 * Looks at a real pair of takes from a session.
 *
 * Everything measured so far has been synthesised, and none of it reproduces
 * the fault reported in use. This reads actual files and reports what they are
 * and where their energy sits, so the next step is based on the material rather
 * than on a guess about it.
 *
 *   npx tsx tools/inspect-real.ts <guide.wav> <other.wav>
 */
import * as fs from "node:fs";
import { decodeAudioFile, toMono } from "../src/audio/codec.js";

const paths = process.argv.slice(2);
if (paths.length < 1) {
  console.error("usage: inspect-real.ts <file.wav> [more.wav ...]");
  process.exit(1);
}

/** Onset times in seconds, from an envelope averaged well over a pitch period. */
function onsets(mono: Float32Array, sampleRate: number): { at: number[]; envelope: Float64Array } {
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
  return { at, envelope };
}

for (const path of paths) {
  const audio = decodeAudioFile(new Uint8Array(fs.readFileSync(path)));
  const mono = toMono(audio);
  const seconds = audio.length / audio.sampleRate;

  let peak = 0;
  let sum = 0;
  for (let i = 0; i < mono.length; i++) {
    const v = Math.abs(mono[i]!);
    if (v > peak) peak = v;
    sum += v * v;
  }
  const rms = Math.sqrt(sum / mono.length);

  const { at } = onsets(mono, audio.sampleRate);

  console.log(`\n  ${path.split(/[\\/]/).pop()}`);
  console.log(`    ${audio.sampleRate} Hz, ${audio.channels.length} ch, ${seconds.toFixed(3)} s`);
  console.log(`    peak ${peak.toFixed(3)}, rms ${rms.toFixed(4)}`);
  console.log(`    ${at.length} onset(s): ${at.slice(0, 24).map((t) => t.toFixed(2)).join("  ")}`);
}
console.log();
