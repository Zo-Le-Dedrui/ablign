/**
 * Ablign — line vocal doubles up with the guide take.
 *
 * Live's extension API exposes `AudioClip.warpMarkers` read-only, so there is
 * no way to hand Live a warp map and let its engine do the stretching. Ablign
 * therefore renders the takes, works out the alignment itself, stretches each
 * double offline and hands the results back as new clips. That is why the
 * output arrives as audio rather than as warp markers on the original, and why
 * it is pre-FX: `renderPreFxAudio` is the only way in.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  initialize,
  AudioTrack,
  DataModelObject,
  type ActivationContext,
  type ArrangementSelection,
  type ExtensionContext,
  type Handle,
  AudioClip,
} from "@ableton-extensions/sdk";

import dialogHtml from "./dialog.html";
import {
  encodeWavFloat32,
  decodeAudioFile,
  type DecodedAudio,
} from "./audio/codec.js";
import {
  alignAgainst,
  chainReference,
  prepareGuide,
  DEFAULT_SETTINGS,
  type AlignResult,
  type AlignSettings,
} from "./align.js";

const COMMAND = "ablign.align";

/** Mean path cost above which two takes look like different material. */
const MISMATCH_COST = 0.8;

type Destination = "track" | "take" | "replace";

interface PlaceReport {
  /** Takes left running because they overhang the selection. */
  stillPlaying?: string[];
  /** Track whose displaced take had to be rebuilt rather than moved. */
  rebuilt?: string;
}

interface DialogResult extends Partial<AlignSettings> {
  apply: boolean;
  guide?: number;
  dubs?: number[];
  destination?: Destination;
  /** Let each double also match against the ones already aligned above it. */
  chain?: boolean;
}

type Context = ExtensionContext<"1.0.0">;

async function showDialog(
  context: Context,
  payload: unknown,
  width: number,
  height: number,
): Promise<DialogResult> {
  // Track names reach the page as data, so escape anything that could close the
  // script element early.
  const json = JSON.stringify(payload).replace(/</g, "\\u003c");
  const html = dialogHtml.replace('"__ABLIGN_PAYLOAD__"', json);

  try {
    return JSON.parse(await context.ui.showModalDialog(
      `data:text/html,${encodeURIComponent(html)}`,
      width,
      height,
    )) as DialogResult;
  } catch {
    return { apply: false }; // dismissed from the window frame
  }
}

const showMessage = (context: Context, message: string): Promise<DialogResult> =>
  showDialog(context, { mode: "message", message }, 380, 190);

/**
 * Turns whatever was thrown into something worth reading.
 *
 * Not everything Live rejects with is an `Error`; some of it is `undefined`,
 * and `String(undefined)` is the word "undefined", which is exactly what a
 * dialog once showed instead of a reason. Anything unreadable is named as such
 * and pushed to the log, where the raw value survives.
 */
function describeError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error.trim()) return error;

  if (error !== null && typeof error === "object") {
    try {
      const text = JSON.stringify(error);
      if (text && text !== "{}") return text;
    } catch {
      // Circular or otherwise unserialisable — fall through to the wording.
    }
  }

  return "Live refused the operation without giving a reason. ExtensionHost.txt has the raw error.";
}

/**
 * Silences monitoring for the duration of a run.
 *
 * Live plays what it renders and the API has no transport control, so a run
 * otherwise blurts the selection out of the speakers once per track, with a
 * click between each pass. The mixer is the only lever: a track's mute sits
 * downstream of its device chain, while `renderPreFxAudio` is taken upstream of
 * all of it, so muting a source cannot change what comes back from rendering
 * it.
 *
 * Nothing here holds a `Track` across an await. A run creates tracks and take
 * lanes, every one of those changes the Set, and an object held across that
 * goes stale — which is how an earlier version left the whole Set muted after
 * placing a clip: restoring threw on the first dead reference and the rest
 * never got their mute back. Handle ids outlive the objects, so the mutes are
 * remembered as ids and the tracks are looked up again at the end.
 *
 * It must also never write to `song.mainTrack` — that is typed as an ordinary
 * `Track`, so the assignment compiles, and Live tears the Extension Host down
 * about 37 ms later with no error and nothing in the log. And it must not
 * clobber the user's own mutes, so only tracks it actually changed are touched.
 */
function silencer(context: Context) {
  const mutedIds = new Set<bigint>();
  let abandoned = false;

  const tracks = () => context.application.song?.tracks ?? [];

  return {
    get abandoned() {
      return abandoned;
    },

    /**
     * Safe to call before every render: tracks created part-way through a run
     * start unmuted, and a track already muted is left alone and not recorded.
     */
    engage() {
      if (abandoned) return;
      const pending = tracks().filter((track) => !track.mute);
      if (!pending.length) return;
      // One transaction, so the Set gains a single undo step rather than one
      // per track.
      context.withinTransaction(() => {
        for (const track of pending) {
          track.mute = true;
          mutedIds.add(track.handle.id);
        }
      });
    },

    release() {
      if (!mutedIds.size) return;
      try {
        const restoring = tracks().filter(
          (track) => mutedIds.has(track.handle.id) && track.mute,
        );
        if (restoring.length) {
          context.withinTransaction(() => {
            for (const track of restoring) track.mute = false;
          });
        }
        mutedIds.clear();
      } catch (error) {
        // This runs in a finally. Throwing here would replace whatever real
        // error was on its way out and still leave the Set muted, so it is
        // logged and swallowed instead.
        console.error(`[Ablign] could not restore mutes: ${String(error)}`);
      }
    },

    /** The mute reached the render after all — stop trying for this run. */
    abandon() {
      abandoned = true;
      this.release();
    },
  };
}

const isSilent = (audio: DecodedAudio): boolean =>
  audio.channels.every((channel) => {
    for (let i = 0; i < channel.length; i++) {
      if (Math.abs(channel[i]!) > 1e-6) return false;
    }
    return true;
  });

/** Renders a track over the selection and decodes whatever format Live wrote. */
async function renderTrack(
  context: Context,
  track: AudioTrack<"1.0.0">,
  from: number,
  to: number,
) {
  const rendered = await context.resources.renderPreFxAudio(track, from, to);
  return decodeAudioFile(await fs.readFile(rendered));
}

/** Writes the aligned audio out and hands back its path inside the project. */
async function importResult(context: Context, result: AlignResult): Promise<string> {
  const directory = context.environment.tempDirectory ?? os.tmpdir();
  const unique = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const temporary = path.join(directory, `ablign-${unique}.wav`);

  await fs.writeFile(temporary, encodeWavFloat32(result.channels, result.sampleRate));
  const imported = await context.resources.importIntoProject(temporary);
  if (imported !== temporary) await fs.rm(temporary, { force: true });
  return imported;
}

/**
 * Deactivates the takes the aligned copy now stands in for, over the selected
 * range only.
 *
 * Only used when the result lands on its own track: there the original keeps
 * playing, and hearing a take on top of its own alignment is a doubling nobody
 * asked for.
 *
 * `Clip.muted` is the whole clip or nothing, so a take running past the
 * selection has to be split first. The 1.0.0 API has no split — but it has
 * `clearClipsInRange`, which is how the SDK's strip-silence example carves
 * regions out of a longer clip, and clearing a hairline at each edge leaves the
 * selected part standing as a clip of its own.
 *
 * The hairline is taken from *inside* the selection on purpose. The gap it
 * leaves then falls under the aligned copy, where nothing plays it, instead of
 * punching a hole in audio that carries on.
 *
 * If the split does not take — a hairline is small enough that Live may round
 * it away — nothing is inside the selection afterwards, nothing gets muted, and
 * the caller reports the take as still playing. Failing that way costs a
 * message rather than a take.
 */
async function deactivateOriginals(
  context: Context,
  track: AudioTrack<"1.0.0">,
  from: number,
  to: number,
): Promise<{ deactivated: number; skipped: string[] }> {
  const edge = 1e-6; // beats; a selection rarely lands exactly on a clip edge
  const tempo = context.application.song?.tempo ?? 120;
  // One millisecond, in beats. Half of that was tried first and Live appears to
  // have rounded it away; this is the next step up, and it still falls under the
  // aligned copy where nothing plays it.
  const hairline = (0.001 * tempo) / 60;

  const covers = (clip: { startTime: number; endTime: number; muted: boolean }) =>
    clip.endTime > from + edge && clip.startTime < to - edge && !clip.muted;

  const overhangs = track.arrangementClips.some(
    (clip) => covers(clip) && (clip.startTime < from - edge || clip.endTime > to + edge),
  );

  if (overhangs && to - from > hairline * 8) {
    try {
      // Inside a transaction, like strip-silence and the replace branch. A bare
      // await of this is the one shape not known to work, and it is what the
      // first attempt used before Live rejected it.
      await Promise.all(
        context.withinTransaction(() => [
          track.clearClipsInRange(from, from + hairline),
          track.clearClipsInRange(to - hairline, to),
        ]),
      );
    } catch (error) {
      // A refused hairline costs the split, not the alignment. Whatever is left
      // straddling the selection is reported below instead.
      console.error(`[Ablign] could not split ${track.name}: ${describeError(error)}`);
    }
  }

  // Re-read: the clears just rewrote this track's clips.
  const covering = track.arrangementClips.filter(covers);
  const inside = covering.filter(
    (clip) => clip.startTime >= from - edge && clip.endTime <= to + edge,
  );
  const skipped = covering.filter((clip) => !inside.includes(clip)).map((clip) => clip.name);

  if (inside.length) {
    context.withinTransaction(() => {
      for (const clip of inside) clip.muted = true;
    });
  }
  return { deactivated: inside.length, skipped };
}

async function place(
  context: Context,
  destination: Destination,
  dubTrack: AudioTrack<"1.0.0">,
  filePath: string,
  startTime: number,
  duration: number,
  name: string,
): Promise<PlaceReport> {
  if (destination === "take") {
    const lane = await dubTrack.createTakeLane();
    const clip = await lane.createAudioClip({ filePath, startTime, duration, isWarped: false });
    clip.name = name;
    lane.name = name;
    return {};
  }

  if (destination === "replace") {
    const edge = 1e-6;
    const endTime = startTime + duration;
    const spans = (clip: { startTime: number; endTime: number }) =>
      clip.endTime > startTime + edge && clip.startTime < endTime - edge;

    // Every block the selection displaces, whatever take each came from, read
    // while they still exist. They all end up together on one take lane.
    //
    // Live sometimes moves them there itself, which is the better outcome — a
    // moved clip keeps its warp markers, gain and fades, which a rebuild
    // cannot. It has been seen not to, and then the take survives only in the
    // undo stack. So: capture first, check afterwards, rebuild only when Live
    // did not, and stay quiet either way.
    const originals = dubTrack.arrangementClips
      .filter(spans)
      .filter((clip): clip is AudioClip<"1.0.0"> => clip instanceof AudioClip)
      .map((clip) => ({
        filePath: clip.filePath,
        startTime: clip.startTime,
        duration: clip.duration,
        name: clip.name,
        warping: clip.warping,
        // Where the clip reads from inside its file. Without these a clip cut
        // from the middle of a long recording would rebuild playing the file
        // from its start — the wrong audio, quietly.
        startMarker: clip.startMarker,
        endMarker: clip.endMarker,
      }));

    const onTakeLanes = () =>
      dubTrack.takeLanes.reduce(
        (count, lane) => count + lane.clips.filter(spans).length,
        0,
      );
    const before = onTakeLanes();

    // One transaction so the clear and the new clip undo together.
    await Promise.all(
      context.withinTransaction(() => [
        dubTrack.clearClipsInRange(startTime, endTime),
      ]),
    );
    const clip = await dubTrack.createAudioClip({ filePath, startTime, duration, isWarped: false });
    clip.name = name;

    if (!originals.length || onTakeLanes() > before) return {};

    const lane = await dubTrack.createTakeLane();
    lane.name = "Before Ablign";
    for (const original of originals) {
      const base = {
        filePath: original.filePath,
        startTime: original.startTime,
        duration: original.duration,
        isWarped: original.warping,
      };
      let copy;
      try {
        copy = await lane.createAudioClip({
          ...base,
          loopSettings: {
            looping: false,
            startMarker: original.startMarker,
            endMarker: original.endMarker,
            loopStart: original.startMarker,
            loopEnd: original.endMarker,
          },
        });
      } catch {
        // Live enforces its own rules on these five fields. If the take's
        // markers do not satisfy them, a clip reading from the top of the file
        // still beats no clip at all.
        copy = await lane.createAudioClip(base);
      }
      copy.name = original.name;
    }
    return { rebuilt: dubTrack.name };
  }

  // Before creating anything: `createAudioTrack` changes the Set, and
  // `dubTrack` would not survive it.
  const { skipped } = await deactivateOriginals(context, dubTrack, startTime, startTime + duration);

  const song = context.application.song;
  if (!song) throw new Error("No Live Set is open.");
  const track = await song.createAudioTrack();
  track.name = name;
  const clip = await track.createAudioClip({ filePath, startTime, duration, isWarped: false });
  clip.name = name;
  return { stillPlaying: skipped };
}

export function activate(activation: ActivationContext) {
  const context = initialize(activation, "1.0.0");

  const run = async (
    selection: ArrangementSelection,
    progress: { stage: string },
  ): Promise<void> => {
    const from = selection.time_selection_start;
    const to = selection.time_selection_end;

    // A group of audio tracks is an AudioTrack as far as the API is concerned,
    // but renderPreFxAudio refuses one — rejecting with nothing, which used to
    // take the whole run down. There is no "is a group" flag; a group is
    // whatever some other track calls its groupTrack.
    const groupIds = new Set<bigint>();
    for (const track of context.application.song?.tracks ?? []) {
      const group = track.groupTrack;
      if (group) groupIds.add(group.handle.id);
    }

    const edge = 1e-6;
    const handles: Handle[] = [];
    const names: string[] = [];
    let groupsSkipped = 0;
    let emptySkipped = 0;

    for (const handle of selection.selected_lanes) {
      const object = context.getObjectFromHandle(handle, DataModelObject);
      if (!(object instanceof AudioTrack)) continue;
      if (groupIds.has(handle.id)) {
        groupsSkipped++;
        continue;
      }

      // Dragging a range across three tracks catches the empty one sitting
      // between them. Rendering it produces silence, aligning silence produces
      // nonsense, and placing it leaves a bounced empty clip in the Set — so it
      // never gets that far.
      const hasAudio = object.arrangementClips.some(
        (clip) => clip.endTime > from + edge && clip.startTime < to - edge && !clip.muted,
      );
      if (!hasAudio) {
        emptySkipped++;
        continue;
      }

      handles.push(handle);
      names.push(object.name);
    }

    if (handles.length < 2) {
      await showMessage(
        context,
        groupsSkipped > 0
          ? "Ablign needs at least two ordinary audio tracks. Group tracks cannot be rendered, so they are left out — select the tracks inside the group instead."
          : emptySkipped > 0
            ? "Ablign needs at least two audio tracks with something on them over this range. Tracks that are empty here are left out."
            : "Ablign needs at least two audio tracks: the guide, and one or more doubles. Drag a time range across all of them, then right-click inside it.",
      );
      return;
    }
    if (to - from <= 0) {
      await showMessage(context, "Select a time range in the arrangement first.");
      return;
    }

    const song = context.application.song;
    if (!song) return;
    const seconds = ((to - from) * 60) / song.tempo;

    const answer = await showDialog(
      context,
      {
        mode: "settings",
        range: `${seconds.toFixed(1)} s selected`,
        tracks: names,
        chain: false,
        settings: {
          strength: DEFAULT_SETTINGS.strength,
          maxShift: DEFAULT_SETTINGS.maxShiftMs,
          smoothing: DEFAULT_SETTINGS.smoothingMs,
          maxStretch: DEFAULT_SETTINGS.maxStretchPercent,
          gate: DEFAULT_SETTINGS.gateDb,
          hold: DEFAULT_SETTINGS.holdPercent,
        },
      },
      470,
      610,
    );

    if (!answer.apply) return;

    const settings: AlignSettings = {
      strength: answer.strength ?? DEFAULT_SETTINGS.strength,
      maxShiftMs: answer.maxShiftMs ?? DEFAULT_SETTINGS.maxShiftMs,
      smoothingMs: answer.smoothingMs ?? DEFAULT_SETTINGS.smoothingMs,
      maxStretchPercent: answer.maxStretchPercent ?? DEFAULT_SETTINGS.maxStretchPercent,
      gateDb: answer.gateDb ?? DEFAULT_SETTINGS.gateDb,
      holdPercent: answer.holdPercent ?? DEFAULT_SETTINGS.holdPercent,
    };
    const destination: Destination = answer.destination ?? "replace";
    const chain = answer.chain === true;

    const guideIndex = answer.guide ?? 0;
    const doubles = (answer.dubs ?? [])
      .filter((index) => index !== guideIndex && index >= 0 && index < handles.length);
    if (!doubles.length) return;

    if (groupsSkipped > 0) {
      console.log(`[Ablign] left out ${groupsSkipped} group track(s): they cannot be rendered`);
    }
    if (emptySkipped > 0) {
      console.log(`[Ablign] left out ${emptySkipped} track(s) with nothing over this range`);
    }

    const poor: string[] = [];
    const stillPlaying: string[] = [];
    const rebuilt: string[] = [];

    await context.ui.withinProgressDialog(
      "Ablign",
      { progress: 0 },
      async (update, abortSignal) => {
        // Re-resolve from the handles: the dialog was open for a while, and
        // objects must never be cached across it.
        const guideTrack = context.getObjectFromHandle(handles[guideIndex]!, AudioTrack);
        const guideName = guideTrack.name;
        const playback = silencer(context);

        try {
          playback.engage();

          progress.stage = `rendering the guide, ${guideName}`;
          await update(`Rendering ${guideName}`, 1);
          let guideAudio = await renderTrack(context, guideTrack, from, to);

          // Muting is meant to be invisible to a pre-FX render. Digital silence
          // coming back cannot be told apart from a genuinely empty stretch, so
          // look once more with monitoring restored: only an answer carrying
          // signal separates "the mute reached the render" from "there is
          // nothing there".
          if (isSilent(guideAudio) && !playback.abandoned) {
            playback.abandon();
            guideAudio = await renderTrack(context, guideTrack, from, to);
          }
          if (abortSignal.aborted) return;

          // The guide is the same for every double, so its features are worth
          // computing once even when only one double is queued. With chaining
          // on it also grows: each aligned take joins the references the next
          // one gets to match against.
          let guide = prepareGuide(guideAudio, settings);
          const share = 96 / doubles.length;

          for (const [position, index] of doubles.entries()) {
            const dubTrack = context.getObjectFromHandle(handles[index]!, AudioTrack);
            const dubName = dubTrack.name;
            const counter = doubles.length > 1 ? ` (${position + 1}/${doubles.length})` : "";
            const base = 3 + position * share;

            progress.stage = `rendering ${dubName}`;
            await update(`Rendering ${dubName}${counter}`, base);
            // Placing the previous result may have added a track; it starts
            // unmuted and would be heard during this render.
            playback.engage();
            let dubAudio = await renderTrack(context, dubTrack, from, to);
            if (isSilent(dubAudio) && !playback.abandoned) {
              playback.abandon();
              dubAudio = await renderTrack(context, dubTrack, from, to);
            }
            if (abortSignal.aborted) return;

            // Still silent with monitoring restored: there is genuinely nothing
            // there. Aligning silence yields nonsense and placing it leaves an
            // empty bounce behind, so the take is skipped.
            if (isSilent(dubAudio)) {
              console.log(`[Ablign] skipped ${dubName}: nothing to align over this range`);
              continue;
            }

            progress.stage = `aligning ${dubName}`;
            const result = await alignAgainst(guide, dubAudio, settings, {
              onStage: (text, fraction) =>
                update(`${text} ${dubName}${counter}`, base + share * (0.15 + fraction * 0.75)),
              shouldAbort: () => abortSignal.aborted,
            });
            if (abortSignal.aborted) return;

            progress.stage = `placing ${dubName}`;
            await update(`Placing ${dubName}${counter}`, base + share * 0.95);
            const imported = await importResult(context, result);
            const report = await place(
              context,
              destination,
              dubTrack,
              imported,
              from,
              to - from,
              `${dubName} (Ablign)`,
            );
            if (report.stillPlaying?.length) stillPlaying.push(...report.stillPlaying);
            if (report.rebuilt) rebuilt.push(report.rebuilt);

            // Chained after placing, not before, so a cancelled run leaves
            // nothing half-referenced.
            if (chain) guide = chainReference(guide, result, settings);

            if (result.cost > MISMATCH_COST) poor.push(dubName);
            console.log(
              `[Ablign] ${dubName} -> ${guideName}: peak shift ${result.peakShiftMs.toFixed(0)} ms, path cost ${result.cost.toFixed(3)}`,
            );
          }

          // Every double is on the timeline from here. Whatever fails after
          // this is clean-up, not work anyone lost.
          progress.stage = "finished";
        } finally {
          // Cancelling and failing both land here; leaving a Set full of muted
          // tracks would be a far worse bug than the noise this avoids.
          playback.release();
        }
      },
    );

    // Rebuilding is not news: either way the displaced blocks end up together
    // on one take lane, which is the whole of what the user asked for. It stays
    // in the log because whether Live preserves a take is worth knowing.
    if (rebuilt.length) {
      console.log(`[Ablign] rebuilt the displaced take on: ${[...new Set(rebuilt)].join(", ")}`);
    }

    // Nothing here interrupts. A finished run closes its progress dialog and
    // gets out of the way; what it noticed goes to the log. Only a request
    // Ablign cannot carry out, or one that failed, is worth a dialog.
    if (stillPlaying.length) {
      console.log(
        `[Ablign] still playing under the aligned copy, too long to deactivate: ${[...new Set(stillPlaying)].join(", ")}`,
      );
    }

    if (poor.length) {
      console.log(`[Ablign] poor match against the guide: ${poor.join(", ")}`);
    }
  };

  context.commands.registerCommand(COMMAND, (arg: unknown) => {
    const progress = { stage: "starting" };

    void run(arg as ArrangementSelection, progress).catch((error: unknown) => {
      const message = describeError(error);
      if (message === "Cancelled." || (error instanceof Error && error.message === "Cancelled.")) {
        return;
      }

      console.error(`[Ablign] failed at "${progress.stage}": ${message}`);
      console.error("[Ablign] raw error:", error);
      if (error instanceof Error && error.stack) console.error(error.stack);

      // Once the takes are placed, what remains is closing a dialog and putting
      // mutes back. Live has been seen to reject that with nothing at all, and
      // alarming someone whose work completed is worse than the failure being
      // described. The log still keeps it.
      if (progress.stage !== "finished") void showMessage(context, message);
    });
  });

  void context.ui.registerContextMenuAction(
    "AudioTrack.ArrangementSelection",
    "Ablign to guide…",
    COMMAND,
  );
}
