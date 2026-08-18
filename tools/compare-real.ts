/**
 * Pairs the onsets of two real takes and reports how the error behaves.
 *
 * A drift that grows steadily means the two are running at different rates —
 * a length or selection mismatch. Errors that jump about mean syllables landed
 * on the wrong neighbours, which is the reported fault.
 */
import * as fs from "node:fs";
import { decodeAudioFile, toMono } from "../src/audio/codec.js";

function onsets(path: string): { at: number[]; seconds: number } {
  const audio = decodeAudioFile(new Uint8Array(fs.readFileSync(path)));
  const mono = toMono(audio);
  const window = Math.round(audio.sampleRate * 0.012);
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
      at.push((f * window) / audio.sampleRate);
      inside = true;
    } else if (inside && envelope[f]! < peak * 0.05) inside = false;
  }
  return { at, seconds: audio.length / audio.sampleRate };
}

const [guidePath, otherPath] = process.argv.slice(2);
const guide = onsets(guidePath!);
const other = onsets(otherPath!);

console.log(`\n  guide  ${guide.seconds.toFixed(3)} s, ${guide.at.length} onsets`);
console.log(`  other  ${other.seconds.toFixed(3)} s, ${other.at.length} onsets`);
console.log(`  length difference: ${((other.seconds - guide.seconds) * 1000).toFixed(0)} ms\n`);

console.log("  guide onset   nearest in other   error");
for (const t of guide.at) {
  let best = Infinity;
  let at = 0;
  for (const o of other.at) {
    if (Math.abs(o - t) < Math.abs(best)) {
      best = o - t;
      at = o;
    }
  }
  const flag = Math.abs(best) > 0.05 ? "   <-- off" : "";
  console.log(
    `    ${t.toFixed(2).padStart(6)} s      ${at.toFixed(2).padStart(6)} s      ${(best * 1000).toFixed(0).padStart(6)} ms${flag}`,
  );
}
console.log();
