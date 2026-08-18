/**
 * Does the built extension actually load and register?
 *
 * Everything else here tests pieces. This tests the one thing that has to work
 * before any of them matter: that requiring the bundle and calling `activate()`
 * succeeds and leaves context-menu entries behind. A crash at activation is
 * invisible in Live — no menu item, no error, nothing — which is exactly the
 * shape of "I click and nothing happens".
 *
 *   npx tsx tools/activate-check.ts
 */
import { createRequire } from "node:module";
import * as path from "node:path";

const registeredCommands: string[] = [];
const registeredMenus: { scope: string; title: string; command: string }[] = [];
const problems: string[] = [];

/**
 * esbuild inlines the SDK into the bundle, so the real `initialize()` runs and
 * asks the activation context for the host modules. This stands in for the
 * host: anything not spelled out answers with a no-op, so the stub stays small
 * while the extension believes it is talking to Live.
 */
function noopModule(overrides: Record<string, unknown>): unknown {
  return new Proxy(overrides, {
    get(target, property) {
      if (property in target) return target[property as string];
      return () => undefined;
    },
    has: () => true,
  });
}

function fakeHost() {
  const rootHandle = { id: 1n };
  const songHandle = { id: 2n };

  return {
    commands: noopModule({
      registerCommand: (id: string) => registeredCommands.push(id),
    }),
    ui: noopModule({
      registerContextMenuAction: (
        scope: string,
        title: string,
        command: string,
        onRegistered?: (unregister: (done: () => void) => void) => void,
      ) => {
        registeredMenus.push({ scope, title, command });
        onRegistered?.(() => undefined);
      },
    }),
    dataModel: noopModule({
      getRoot: () => rootHandle,
      rootGetSong: () => songHandle,
      // The registry asks "is this handle a Song?" and refuses to build an
      // object when nothing says yes.
      getObjectIsOfClass: () => true,
      getObjectCanonicalParent: () => null,
      songGetTracks: () => [],
      songGetReturnTracks: () => [],
      songGetScenes: () => [],
      songGetCuePoints: () => [],
      songGetTempo: () => 120,
      withinTransaction: <T>(fn: () => T): T => fn(),
    }),
    environment: noopModule({
      storageDirectory: undefined,
      tempDirectory: undefined,
      language: "EN",
    }),
    resources: noopModule({}),
  };
}

const bundle = path.resolve("dist", "extension.js");
console.log(`\nLoading ${bundle}\n`);

let activate: ((activation: unknown) => void) | undefined;
try {
  const required = createRequire(import.meta.url)(bundle) as {
    activate?: (activation: unknown) => void;
  };
  activate = required.activate;
} catch (problem) {
  problems.push(`requiring the bundle threw: ${String(problem)}`);
}

if (!problems.length && typeof activate !== "function") {
  problems.push("the bundle exports no activate() function");
}

if (!problems.length && activate) {
  try {
    activate({
      hostApiVersion: "1.0.0",
      initializeExtensionHost: () => fakeHost(),
    });
  } catch (problem) {
    problems.push(`activate() threw: ${String(problem)}`);
  }
}

const check = (name: string, ok: boolean, detail: string) => {
  if (!ok) problems.push(name);
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name} — ${detail}`);
};

check("the bundle loads and activates", problems.length === 0, problems[0] ?? "no error thrown");
check(
  "commands are registered",
  registeredCommands.length > 0,
  registeredCommands.join(", ") || "none",
);
check(
  "context-menu entries are registered",
  registeredMenus.length > 0,
  registeredMenus.map((entry) => `${entry.scope}:"${entry.title}"`).join(", ") || "none",
);
check(
  "every menu entry points at a real command",
  registeredMenus.every((entry) => registeredCommands.includes(entry.command)),
  registeredMenus
    .filter((entry) => !registeredCommands.includes(entry.command))
    .map((entry) => entry.command)
    .join(", ") || "all matched",
);

const failed = problems.length;
console.log(failed === 0 ? "\nThe extension activates cleanly.\n" : `\n${failed} problem(s).\n`);
process.exit(failed === 0 ? 0 : 1);
