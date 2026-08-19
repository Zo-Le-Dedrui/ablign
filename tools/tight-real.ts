/**
 * What happens to a take that is already where it should be?
 *
 * Reported: applying it to a track that is already aligned shifts everything.
 * This builds that case out of real audio rather than synthesis — the same
 * performance, offset by a few milliseconds, which is as close to "already
 * tight" as a session ever gets.
 *
 *   npx tsx tools/tight-real.ts <take.wav>
 */
import * as fs from "node:fs";
import { alignTake, DEFAULT_SETTINGS, type AlignSettings } from "../src/align.js";
import { decodeAudioFile, type DecodedAudio } from "../src/audio/codec.js";

const [path] = process.argv.slice(2);
const audio = decodeAudioFile(new Uint8Array(fs.readFileSync(path!)));

/** The same take, shifted by `ms` and padded so both cover the same span. */
function offsetBy(source: DecodedAudio, ms: number): DecodedAudio {
  const shift = Math.round((ms / 1000) * source.sampleRate);
  const channels = source.channels.map((c) => {
    const out = new Float32Array(source.length);
    for (let i = 0; i < source.length; i++) {
      const from = i - shift;
      out[i] = from >= 0 && from < source.length ? c[from]! : 0;
    }
    return out;
  });
  return { sampleRate: source.sampleRate, channels, length: source.length };
}

console.log(`\n  ${(audio.length / audio.sampleRate).toFixed(2)} s of real audio, used as both takes\n`);
console.log("  offset applied   peak shift   what the alignment did");

for (const ms of [0, 5, 15, 40]) {
  const dub = offsetBy(audio, ms);
  for (const [label, settings] of [
    ["", DEFAULT_SETTINGS],
    [" (strength 50)", { ...DEFAULT_SETTINGS, strength: 50 }],
  ] as [string, AlignSettings][]) {
    const result = await alignTake(audio, dub, settings);
    // A take offset by `ms` should come back moved by about `ms`. Anything much
    // larger is the alignment inventing a correction.
    const excess = result.peakShiftMs - Math.abs(ms);
    console.log(
      `  ${(ms + " ms" + label).padEnd(18)} ${result.peakShiftMs.toFixed(0).padStart(5)} ms    ${
        excess > 20 ? `${excess.toFixed(0)} ms more than asked for` : "in proportion"
      }`,
    );
  }
}
console.log();
