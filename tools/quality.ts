/**
 * Measures how clean the stretch is, not how accurate it is.
 *
 * `align-check.ts` proves the words land in the right place. Nothing so far
 * says anything about what they sound like once stretched, which is the part
 * that separates a usable vocal aligner from an audible one — and the part I
 * cannot judge by ear from here.
 *
 * A sustained vowel stretched by a constant factor should come out as the same
 * vowel, one steady pitch, its harmonics and nothing else. Everything that is
 * neither the fundamental nor one of its harmonics is an artefact of the
 * stretch: period discontinuities throw energy into the gaps between harmonics,
 * and warble modulates them into sidebands. So the number to drive down is the
 * share of output energy sitting off-harmonic.
 *
 *   npx tsx tools/quality.ts
 */
import { warpChannels } from "../src/audio/wsola.js";
import { Fft, nextPowerOfTwo } from "../src/audio/fft.js";

const SAMPLE_RATE = 44100;

/**
 * A vowel: glottal pulse train through two formants.
 *
 * With no vibrato the period is a whole number of samples, so the signal is
 * exactly periodic and its spectrum is pure harmonics. That matters: a pulse
 * train quantised to the nearest sample carries about 0.2 % of jitter, which
 * alone puts −22 dB of energy between the harmonics and hides anything the
 * stretcher does underneath it.
 */
function vowel(seconds: number, f0: number, jitter = 0): Float32Array {
  const length = Math.round(seconds * SAMPLE_RATE);
  const out = new Float32Array(length);
  const period = Math.round(SAMPLE_RATE / f0);

  let phase = 0;
  let r1 = 0;
  let r1p = 0;
  let r2 = 0;
  let r2p = 0;
  const w1 = (2 * Math.PI * 700) / SAMPLE_RATE;
  const w2 = (2 * Math.PI * 1220) / SAMPLE_RATE;

  for (let i = 0; i < length; i++) {
    let pulse = 0;
    if (jitter === 0) {
      // Exactly periodic.
      if (i % period === 0) pulse = 1;
    } else {
      // A vowel with vibrato, because a stretcher that only survives dead-steady
      // input proves nothing.
      phase += (f0 * (1 + jitter * Math.sin((2 * Math.PI * 5.2 * i) / SAMPLE_RATE))) / SAMPLE_RATE;
      if (phase >= 1) {
        phase -= 1;
        pulse = 1;
      }
    }

    const y1 = pulse + 2 * 0.985 * Math.cos(w1) * r1 - 0.985 * 0.985 * r1p;
    r1p = r1;
    r1 = y1;
    const y2 = pulse + 2 * 0.975 * Math.cos(w2) * r2 - 0.975 * 0.975 * r2p;
    r2p = r2;
    r2 = y2;

    out[i] = 0.02 * (y1 + 0.5 * y2);
  }

  let peak = 0;
  for (let i = 0; i < length; i++) peak = Math.max(peak, Math.abs(out[i]!));
  if (peak > 0) for (let i = 0; i < length; i++) out[i] = (out[i]! / peak) * 0.7;
  return out;
}

/**
 * Share of energy that is not the fundamental or one of its harmonics, in dB.
 * Measured over the steady middle of the signal, away from the edges.
 */
function offHarmonic(signal: Float32Array, f0: number, wander: number): number {
  const size = nextPowerOfTwo(Math.round(SAMPLE_RATE * 0.75));
  const from = Math.max(0, Math.floor((signal.length - size) / 2));
  const fft = new Fft(size);
  const re = new Float64Array(size);
  const im = new Float64Array(size);

  for (let i = 0; i < size; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size); // Hann
    re[i] = (signal[from + i] ?? 0) * w;
    im[i] = 0;
  }
  fft.forward(re, im);

  const bins = size / 2;
  const binHz = SAMPLE_RATE / size;

  const harmonic = new Uint8Array(bins);
  for (let k = 1; k * f0 < SAMPLE_RATE / 2; k++) {
    const centre = (k * f0) / binHz;
    // Window leakage is a fixed few bins. Pitch wander, when the signal has
    // any, scales with the harmonic number — but assuming wander that is not
    // there widens the mask until it swallows the whole spectrum and the metric
    // reads the same number no matter what the stretcher did.
    const spread = 4 + Math.ceil((k * wander * f0) / binHz);
    for (let b = Math.round(centre - spread); b <= Math.round(centre + spread); b++) {
      if (b > 0 && b < bins) harmonic[b] = 1;
    }
  }

  let inside = 0;
  let outside = 0;
  for (let b = 1; b < bins; b++) {
    const power = re[b]! * re[b]! + im[b]! * im[b]!;
    if (harmonic[b]) inside += power;
    else outside += power;
  }

  return 10 * Math.log10(outside / (inside + 1e-20) + 1e-20);
}

/** Band-limited noise: a sibilant, the material WSOLA is worst on. */
function sibilant(seconds: number, seed: number): Float32Array {
  const length = Math.round(seconds * SAMPLE_RATE);
  const out = new Float32Array(length);
  let state = seed >>> 0;
  let low = 0;
  let high = 0;
  for (let i = 0; i < length; i++) {
    state = (state * 1664525 + 1013904223) >>> 0;
    const white = state / 4294967296 - 0.5;
    low += 0.35 * (white - low);   // shelve the very top off
    high += 0.02 * (low - high);   // and the very bottom
    out[i] = (low - high) * 1.4;
  }
  return out;
}

/**
 * Spectral flatness of the top of the band, 0 to 1.
 *
 * Noise reads near 1, anything tonal falls towards 0. This is the measure that
 * matches the complaint: stretching by r reuses material at a fixed offset of
 * about hop x (1 - 1/r), which is a comb — 293 samples at +40 %, a tone near
 * 150 Hz. A peak-of-autocorrelation measure cannot tell that apart from noise
 * spread over many lags, and the difference is the whole artefact: one whistles,
 * the other does not.
 */
function flatness(signal: Float32Array): number {
  const size = 16384;
  const from = Math.max(0, Math.floor(signal.length / 2) - size / 2);
  const fft = new Fft(size);
  const re = new Float64Array(size);
  const im = new Float64Array(size);

  for (let i = 0; i < size; i++) {
    re[i] = (signal[from + i] ?? 0) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size));
    im[i] = 0;
  }
  fft.forward(re, im);

  // Only where a sibilant actually lives, so the measure is not dominated by
  // bins that hold nothing either way.
  const lowBin = Math.round((2000 * size) / SAMPLE_RATE);
  const highBin = Math.round((12000 * size) / SAMPLE_RATE);

  let logSum = 0;
  let sum = 0;
  let count = 0;
  for (let b = lowBin; b < highBin; b++) {
    const power = re[b]! * re[b]! + im[b]! * im[b]! + 1e-18;
    logSum += Math.log(power);
    sum += power;
    count++;
  }
  return Math.exp(logSum / count) / (sum / count);
}

async function stretch(signal: Float32Array, ratio: number): Promise<Float32Array> {
  const out = await warpChannels([signal], signal, {
    sampleRate: SAMPLE_RATE,
    inputAt: (s) => s / ratio,
    outputLength: Math.round(signal.length * ratio),
  });
  return out[0]!;
}

const cases: [string, number, number, number][] = [
  // label, f0, vibrato depth, stretch ratio
  ["low voice, held", 95, 0, 1.0],
  ["low voice, +12 %", 95, 0, 1.12],
  ["low voice, +40 %", 95, 0, 1.4],
  ["low voice, -25 %", 95, 0, 0.75],
  ["mid voice, +12 %", 165, 0, 1.12],
  ["mid voice, +40 %", 165, 0, 1.4],
  ["high voice, +12 %", 260, 0, 1.12],
  ["high voice, +40 %", 260, 0, 1.4],
  ["mid voice, vibrato +12 %", 165, 0.005, 1.12],
];

console.log("\noff-harmonic energy, lower is cleaner\n");
console.log("  case                    source     stretched     cost");
console.log("  " + "-".repeat(56));

const failures: string[] = [];
let total = 0;
let counted = 0;
for (const [label, f0, jitter, ratio] of cases) {
  const source = vowel(2.5, f0, jitter);
  const actual = jitter === 0 ? SAMPLE_RATE / Math.round(SAMPLE_RATE / f0) : f0;
  const before = offHarmonic(source, actual, jitter);
  const after = offHarmonic(await stretch(source, ratio), actual, jitter);
  const cost = after - before;
  if (ratio !== 1) {
    total += cost;
    counted++;
  }
  console.log(
    `  ${label.padEnd(22)} ${before.toFixed(1).padStart(6)} dB ${after.toFixed(1).padStart(9)} dB ${(cost >= 0 ? "+" : "") + cost.toFixed(1)} dB`,
  );
}

console.log("  " + "-".repeat(56));
console.log(`  mean cost of stretching: ${(total / counted).toFixed(1)} dB\n`);

console.log("\nintroduced periodicity on unvoiced material, lower is cleaner\n");
console.log("  case                    source     stretched     cost");
console.log("  " + "-".repeat(56));

// Averaged over several noise realisations. One is not enough: the spread
// between seeds is as large as the effect being measured, and tuning against a
// single one is tuning against chance.
const SEEDS = [9001, 4242, 77003, 131, 55555, 31337];

for (const [label, ratio] of [
  ["sibilant, +12 %", 1.12],
  ["sibilant, +40 %", 1.4],
  ["sibilant, -25 %", 0.75],
] as [string, number][]) {
  let beforeSum = 0;
  let afterSum = 0;
  for (const seed of SEEDS) {
    const source = sibilant(2.5, seed);
    beforeSum += flatness(source);
    afterSum += flatness(await stretch(source, ratio));
  }
  const before = beforeSum / SEEDS.length;
  const after = afterSum / SEEDS.length;
  const drop = ((after - before) / before) * 100;
  // The bias-free search on noise measured -0.4 % and -3.3 %. Anything much
  // past that means the centre bias has crept back onto unvoiced material and
  // the comb with it.
  const allowed = ratio > 1.2 ? -4.5 : -1.5;
  if (drop < allowed) {
    failures.push(`${label}: flatness ${drop.toFixed(1)} %, allowed ${allowed} %`);
  }
  console.log(
    `  ${label.padEnd(22)} ${before.toFixed(3).padStart(6)}    ${after.toFixed(3).padStart(9)}    ${(drop >= 0 ? "+" : "") + drop.toFixed(1)} %`,
  );
}
console.log();

/** Consonants: short, sharp bursts with silence between them. */
function attacks(seconds: number, seed: number): Float32Array {
  const length = Math.round(seconds * SAMPLE_RATE);
  const out = new Float32Array(length);
  let state = seed >>> 0;
  const random = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296 - 0.5;
  };
  const every = Math.round(0.25 * SAMPLE_RATE);
  const decay = Math.round(0.03 * SAMPLE_RATE);
  for (let at = every; at + decay < length; at += every) {
    for (let i = 0; i < decay; i++) {
      out[at + i] = random() * 2 * Math.exp(-4 * (i / decay));
    }
  }
  return out;
}

/**
 * Counts bursts and measures how tall they stayed.
 *
 * Crest factor looked like the obvious measure and is confounded: stretching
 * adds silence between attacks, so the RMS falls and the crest rises whatever
 * the stretcher did. What actually goes wrong on a transient is duplication —
 * the attack reused by two grains, played twice — and smearing, which pulls its
 * peak down. Both of those survive a change of duty cycle.
 */
function bursts(signal: Float32Array): { count: number; peak: number } {
  const window = 128;
  const frames = Math.floor(signal.length / window);
  const envelope = new Float64Array(frames);
  let loudest = 0;
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let i = 0; i < window; i++) sum += signal[f * window + i]! ** 2;
    envelope[f] = Math.sqrt(sum / window);
    loudest = Math.max(loudest, envelope[f]!);
  }

  const on = loudest * 0.25;
  const off = loudest * 0.08;
  let count = 0;
  let inside = false;
  let peakSum = 0;
  let current = 0;

  for (let f = 0; f < frames; f++) {
    if (!inside && envelope[f]! > on) {
      inside = true;
      current = envelope[f]!;
      count++;
    } else if (inside) {
      current = Math.max(current, envelope[f]!);
      if (envelope[f]! < off) {
        inside = false;
        peakSum += current;
      }
    }
  }
  if (inside) peakSum += current;

  return { count, peak: count > 0 ? peakSum / count : 0 };
}

console.log("\nattack sharpness, higher keeps more edge\n");
console.log("  case                bursts in -> out    peak height");
console.log("  " + "-".repeat(56));

for (const [label, ratio] of [
  ["consonants, +12 %", 1.12],
  ["consonants, +40 %", 1.4],
  ["consonants, -25 %", 0.75],
] as [string, number][]) {
  let inCount = 0;
  let outCount = 0;
  let heightSum = 0;
  for (const seed of SEEDS) {
    const source = attacks(3, seed);
    const before = bursts(source);
    const after = bursts(await stretch(source, ratio));
    inCount += before.count;
    outCount += after.count;
    heightSum += before.peak > 0 ? after.peak / before.peak : 1;
  }
  const kept = ((heightSum / SEEDS.length - 1) * 100).toFixed(1);
  if (inCount !== outCount) failures.push(`${label}: ${inCount} bursts in, ${outCount} out`);
  console.log(
    `  ${label.padEnd(20)} ${String(inCount).padStart(5)} -> ${String(outCount).padEnd(8)}    ${(Number(kept) >= 0 ? "+" : "") + kept} %`,
  );
}
console.log();

if (Math.abs(total / counted) > 0.5) {
  failures.push(`voiced material costs ${(total / counted).toFixed(1)} dB`);
}

if (failures.length) {
  console.error(`${failures.length} quality check(s) failed:`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
console.log("quality ok\n");
