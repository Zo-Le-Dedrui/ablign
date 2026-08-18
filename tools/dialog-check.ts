/**
 * Static checks for the modal dialog.
 *
 * Nothing else catches these: the HTML is inlined as a string, so TypeScript
 * never sees it, and a typo in an element id only shows up as a dialog that
 * silently does nothing once it is already open inside Live.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const html = fs.readFileSync(path.join(root, "src", "dialog.html"), "utf8");

const failures: string[] = [];
const check = (label: string, ok: boolean, detail: string) => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}: ${detail}`);
  if (!ok) failures.push(label);
};

const placeholder = '"__ABLIGN_PAYLOAD__"';
const occurrences = html.split(placeholder).length - 1;
check("payload placeholder", occurrences === 1, `${occurrences} occurrence(s)`);

// Every id the script reaches for has to exist in the markup above it.
const referenced = [...html.matchAll(/getElementById\("([^"]+)"\)/g)].map((m) => m[1]!);
const suffixed = [...html.matchAll(/getElementById\(([a-zA-Z]+) \+ "-value"\)/g)].length;
const declared = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]!));
const missing = [...new Set(referenced)].filter((id) => !declared.has(id));
check("element ids resolve", missing.length === 0, missing.length ? missing.join(", ") : `${new Set(referenced).size} ids`);

// The slider readouts are built by concatenation, so check that pairing too.
const sliderIds = [...html.matchAll(/\[\s*"(\w+)",\s*\(v\)/g)].map((m) => m[1]!);
const readoutsMissing = sliderIds.filter((id) => !declared.has(`${id}-value`) || !declared.has(id));
check(
  "slider readouts exist",
  sliderIds.length > 0 && readoutsMissing.length === 0 && suffixed === 1,
  readoutsMissing.length ? readoutsMissing.join(", ") : `${sliderIds.length} sliders`,
);

// Each "?" button reveals the panel whose data-for matches its data-help. The
// pairing is a string on both sides and nothing enforces it: a mismatch gives a
// button that visibly does nothing when clicked.
const helps = [...html.matchAll(/class="help" data-help="([^"]+)"/g)].map((m) => m[1]!);
const panels = [...html.matchAll(/class="explain" data-for="([^"]+)"/g)].map((m) => m[1]!);
const orphanButtons = helps.filter((name) => !panels.includes(name));
const orphanPanels = panels.filter((name) => !helps.includes(name));
check(
  "every ? opens a panel",
  helps.length > 0 && orphanButtons.length === 0 && orphanPanels.length === 0,
  orphanButtons.length || orphanPanels.length
    ? `buttons without a panel: ${orphanButtons.join(", ") || "none"}; panels without a button: ${orphanPanels.join(", ") || "none"}`
    : `${helps.length} paired`,
);

// Explanations that say nothing are worse than none — they cost a click.
const bodies = [...html.matchAll(/class="explain" data-for="[^"]+">\s*<p>([^<]+)<\/p>/g)].map(
  (m) => m[1]!.trim(),
);
const thin = bodies.filter((text) => text.length < 40);
check(
  "explanations have substance",
  bodies.length === helps.length && thin.length === 0,
  thin.length ? `too short: ${thin.join(" | ")}` : `${bodies.length} explanation(s)`,
);

// A track called `</script>` must not be able to break out of the page.
const hostile = {
  mode: "settings",
  range: "4.0 s selected",
  tracks: ['Lead </script><script>alert(1)</script>', 'Dub "quoted"   odd'],
  settings: { strength: 100, maxShift: 300, smoothing: 60, maxStretch: 40, gate: -55 },
};
const injected = html.replace(placeholder, JSON.stringify(hostile).replace(/</g, "\\u003c"));
const closers = injected.split("</script>").length - 1;
check("injection is contained", closers === 1, `${closers} closing script tag(s)`);

// And the injected literal still has to be readable JavaScript.
// Line-ending agnostic on purpose: a tool that rewrites the file can flip it to
// CRLF, and the previous slice-to-";\n" version then swallowed the rest of the
// page instead of failing, which is worse than having no check at all.
const declaration = injected
  .split(/\r?\n/)
  .find((line) => line.includes("const payload = "));
const value = (declaration ?? "")
  .replace(/^\s*const payload = /, "")
  .replace(/;\s*$/, "");
let parsed: { tracks?: string[] } = {};
let parseError = "";
try {
  parsed = JSON.parse(value) as { tracks?: string[] };
} catch (error) {
  parseError = error instanceof Error ? error.message : String(error);
}
check(
  "payload round-trips",
  parsed.tracks?.[0] === hostile.tracks[0],
  parseError || `${parsed.tracks?.length ?? 0} track name(s) intact`,
);

// The dialog and the command agree on a payload shape by convention only —
// nothing type-checks across the `postMessage` boundary. Renaming a field on
// one side and not the other yields a dialog that closes and does nothing.
const emitted = html.slice(html.indexOf("closeWithResult({"));
const emittedKeys = [...emitted.slice(0, emitted.indexOf("});")).matchAll(/^\s{12}(\w+):/gm)].map(
  (m) => m[1]!,
);
const extension = fs.readFileSync(path.join(root, "src", "extension.ts"), "utf8");
const interfaceBody = extension.slice(
  extension.indexOf("interface DialogResult"),
  extension.indexOf("type Context ="),
);
const settingsBody = fs.readFileSync(path.join(root, "src", "align.ts"), "utf8");
const known = (name: string) =>
  new RegExp(`\\b${name}\\??:`).test(interfaceBody) ||
  new RegExp(`\\b${name}: number;`).test(settingsBody);
const unread = emittedKeys.filter((key) => !known(key));
check(
  "dialog fields are read",
  emittedKeys.length >= 5 && unread.length === 0,
  unread.length ? `not read by the command: ${unread.join(", ")}` : emittedKeys.join(", "),
);

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("\ndialog ok");
