/**
 * Guards the one mistake that kills Live silently.
 *
 * `song.mainTrack` is typed as an ordinary `Track`, so `mainTrack.mute = true`
 * compiles and reads as harmless. It is not: Live tears the Extension Host down
 * about 37 ms later. The process dies rather than throwing, so `try`/`catch`
 * cannot save it and nothing reaches ExtensionHost.txt — from the user's side
 * the dialog just vanishes and "nothing happens". No type or test can catch
 * that, which leaves reading the source.
 *
 *   npx tsx tools/safety-check.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sources = fs
  .readdirSync(path.join(root, "src"), { recursive: true, encoding: "utf8" })
  .filter((name) => name.endsWith(".ts"))
  .map((name) => path.join(root, "src", name));

const failures: string[] = [];
const check = (label: string, ok: boolean, detail: string) => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}: ${detail}`);
  if (!ok) failures.push(label);
};

const writes: string[] = [];
const mentions: string[] = [];

for (const file of sources) {
  const relative = path.relative(root, file);
  fs.readFileSync(file, "utf8")
    .split(/\r?\n/)
    .forEach((line, index) => {
      const code = line.replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, "");
      if (!code.includes("mainTrack")) return;
      mentions.push(`${relative}:${index + 1}`);
      // Any assignment, increment, or delete whose target reaches through
      // mainTrack. Reads are fine; nothing here needs even those.
      if (/mainTrack\s*(\.\s*\w+\s*)?(=[^=]|\+\+|--)/.test(code)) {
        writes.push(`${relative}:${index + 1}`);
      }
    });
}

check(
  "nothing writes to mainTrack",
  writes.length === 0,
  writes.length ? writes.join(", ") : `${mentions.length} mention(s), all reads`,
);

// The silencer must take its list from the ordinary tracks collection. If it
// ever grew a `returnTracks` or `mainTrack` arm this would say so.
const extension = fs.readFileSync(path.join(root, "src", "extension.ts"), "utf8");
const silencer = extension.slice(
  extension.indexOf("function silencer("),
  extension.indexOf("const isSilent"),
);
const readsTracks = /song\??\.tracks/.test(silencer);
const reachesFurther = /mainTrack|returnTracks/.test(silencer);
check(
  "silencer only touches ordinary tracks",
  readsTracks && !reachesFurther,
  !readsTracks ? "never reads song.tracks" : reachesFurther ? "reaches past song.tracks" : "song.tracks only",
);

// Holding a Track across an await is how a run once ended with the whole Set
// muted: placing a clip changes the Set, the held object goes stale, and the
// restore throws on the first dead reference. Handle ids outlive the objects.
const holdsObjects = /(?:let|const)\s+\w+\s*:\s*Track<[^>]*>\[\]/.test(silencer);
check(
  "silencer remembers ids, not objects",
  !holdsObjects && silencer.includes("handle.id"),
  holdsObjects
    ? "holds a Track[] across the run"
    : silencer.includes("handle.id")
      ? "keyed on handle ids"
      : "does not key on handle ids",
);

// Restoring runs inside a finally, where an escaping error would both hide the
// real failure and leave every track muted.
const releaseBody = silencer.slice(silencer.indexOf("release()"), silencer.indexOf("abandon()"));
check(
  "restoring cannot throw",
  releaseBody.includes("try {") && releaseBody.includes("catch"),
  releaseBody.includes("catch") ? "guarded" : "no catch around the restore",
);

// Muting and restoring have to be paired, and the restore has to be in a
// finally — a cancelled run that leaves every track muted is worse than noise.
const engages = (extension.match(/playback\.engage\(\)/g) ?? []).length;
const finallyBlock = extension.slice(extension.indexOf("} finally {"));
check(
  "mutes are restored in a finally",
  engages > 0 && finallyBlock.includes("playback.release()"),
  `${engages} engage(s), release in finally: ${finallyBlock.includes("playback.release()")}`,
);

// Deactivating reads the double's clips, and creating a track changes the Set.
// Reverse these two and the read happens through a stale reference.
const calls = (extension.match(/deactivateOriginals\(context/g) ?? []).length;
const deactivatesAt = extension.indexOf("deactivateOriginals(context");
const createsTrackAt = extension.indexOf("song.createAudioTrack()");
check(
  "originals are deactivated before the Set changes",
  calls === 1 && deactivatesAt > 0 && deactivatesAt < createsTrackAt,
  calls !== 1 ? `${calls} call sites, expected 1` : deactivatesAt < createsTrackAt ? "before createAudioTrack" : "after createAudioTrack",
);

// A dialog once showed the word "undefined" as its reason, because not
// everything Live rejects with is an Error and String(undefined) says that.
const stringifiesRaw = /message = error instanceof Error \? error\.message : String\(error\)/.test(
  extension,
);
check(
  "errors are described, not stringified",
  extension.includes("describeError(error)") && !stringifiesRaw,
  stringifiesRaw ? "still falls back to String(error)" : "routed through describeError",
);

// place() reports what it could not do cleanly — takes left playing, a take
// Live failed to keep. Dropping that return value compiles, runs, and silently
// removes the only warning the user would ever get. It has already happened
// once, through a patch whose indentation did not match.
const placeCalls = (extension.match(/await place\(/g) ?? []).length;
const consumed = /const \w+ = await place\(/.test(extension);
const readsBoth = /\.stillPlaying/.test(extension) && /\.rebuilt/.test(extension);
check(
  "place's report is read",
  placeCalls === 1 && consumed && readsBoth,
  placeCalls !== 1
    ? `${placeCalls} call sites, expected 1`
    : !consumed
      ? "return value discarded"
      : !readsBoth
        ? "a reported field is never read"
        : "assigned and both fields read",
);

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("\nsafety ok");
