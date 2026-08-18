import { alignTake, DEFAULT_SETTINGS } from "../src/align.js";
import type { DecodedAudio } from "../src/audio/codec.js";

const SR = 44100;
function take(seconds: number, offset: number, seed: number): DecodedAudio {
  const n = Math.round(seconds * SR);
  const left = new Float32Array(n);
  let state = seed >>> 0;
  const rnd = () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 4294967296 - 0.5; };
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const syl = Math.floor(t / 0.5);
    const inside = (t % 0.5) < 0.3;
    phase += (2 * Math.PI * (140 + 60 * (syl % 5))) / SR;
    const drift = Math.sin(t * 0.7 + offset) * 0.06;
    const env = inside ? Math.min(1, ((t % 0.5) - drift) * 30) : 0;
    left[i] = env > 0 ? env * (0.3 * Math.sin(phase) + 0.05 * rnd()) : 0;
  }
  const right = new Float32Array(n);
  for (let i = 0; i < n; i++) right[i] = left[i]! * 0.8;
  return { sampleRate: SR, channels: [left, right], length: n };
}

for (const seconds of [10, 60, 180]) {
  const g = take(seconds, 0, 1);
  const d = take(seconds, 1.4, 2);
  const started = Date.now();
  const r = await alignTake(g, d, DEFAULT_SETTINGS);
  const ms = Date.now() - started;
  console.log(
    `${String(seconds).padStart(3)}s stereo: ${String(ms).padStart(5)} ms  ` +
    `(${(ms / seconds).toFixed(0)} ms per second of audio), peak shift ${r.peakShiftMs.toFixed(0)} ms`,
  );
}
