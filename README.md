# Ablign

**An extension for Ableton Live** that lines vocal doubles and backing takes up with your lead take, so the words land together instead of smearing.

Select a time range across the guide and one or more doubles → right-click → **Ablign to guide…** → tick which takes follow the lead, and they all come back time-aligned in one pass.

> This is a Live *extension*, not a plug-in. It installs into Live itself and runs from a right-click in the arrangement — it never sits in a device chain and does nothing in real time. It edits your Set when you ask it to, then gets out of the way.

Built on the Ableton Extensions SDK `1.0.0-beta.1`.

## How it works

1. Every selected track is rendered over the range with `renderPreFxAudio`. The guide is rendered and analysed **once**, however many doubles follow it.
2. Each render is reduced to one feature vector every 5.8 ms — 24 mel bands describing spectral shape, plus a "quiet" axis so silences match silences instead of correlating noise against noise.
3. Banded dynamic time warping finds the path between guide and double. The band is the **Max shift** setting, so the alignment cannot drift further than you allowed, and the cost stays linear in the length of the selection.
4. The raw path is smoothed, scaled by **Strength**, slope-limited to **Max stretch**, and pinned at both ends so the result occupies exactly the range you selected.
5. WSOLA stretches the double along that curve and the result is imported as a new clip.

### Silence while it works

Live plays what it renders, and the API has no transport control, so a run would otherwise blurt the selection out of the speakers once per track with a click between each pass. Ablign mutes the ordinary tracks for the duration and restores them in a `finally`, so cancelling or failing still gives them back. Only tracks it actually muted are restored — your own mutes survive.

This is safe for the result: a track's mute sits downstream of its device chain, while `renderPreFxAudio` is taken upstream of all of it. If a render nonetheless comes back as digital silence, Ablign renders that track once more with monitoring restored, because silence alone cannot distinguish "the mute reached the render" from "there is nothing there".

`song.mainTrack` is never written to. It is typed as an ordinary `Track`, so `mainTrack.mute = true` compiles and looks harmless — and takes the Extension Host down about 37 ms later, with no exception and nothing in the log. `tools/safety-check.ts` reads the source to enforce that, since no type or runtime test can.

### Why it renders audio instead of warping the clip

`AudioClip.warpMarkers` is read-only in API 1.0.0 — the host interface has `audioclipGetWarpMarkers` and no setter. An extension cannot hand Live a warp map and let Live's engine stretch the clip, so Ablign does the stretching itself and gives you audio back. Two consequences follow, and neither is a bug:

- The result is **pre-FX**. `renderPreFxAudio` renders upstream of the track's device chain, so what gets aligned is the clip audio, not the processed sound.
- The result is **unwarped** and placed at the selected range. It sits where it was rendered; it will not follow a later tempo change.

## The controls

| Control | Default | What it does |
|---|---|---|
| **Strength** | 100 % | How much of the measured correction to apply. 0 % is an exact bypass. |
| **Max shift** | 300 ms | The furthest a double may be moved. Also the DTW band, so raising it costs time and memory. |
| **Smoothing** | 60 ms | Averaging on the warp curve. The raw path jitters inside held vowels where many alignments cost nearly the same; too little smoothing is worse than too much (5 ms measures 17 ms of residual lag, 60 ms measures 1.7 ms). |
| **Max stretch** | ±100 % | Local time-stretch limit. **This is the tightness control.** The matcher's own step pattern already caps the path slope at 2x, so 100 and above leave the limit inert; below that it only ever tightens. |
| **Silence** | −55 dB | Level below which a frame counts as silence. |
| **Put it** | Replace, original to a take lane | The aligned take lands on the track, and Live keeps the one it displaced on a take lane below. Also: a new audio track, or a new take lane. |

Every control has a **?** next to it in the dialog that says what it does and which way to move it.

### Selecting part of a clip

Both destinations that touch the original handle it. Replace clears the range, which splits a longer clip and leaves what sits outside untouched.

The new-track destination deactivates the take it stands in for, and `Clip.muted` is the whole clip or nothing — so a longer clip is split first. There is no split in the 1.0.0 API, but `clearClipsInRange` carves a region out of a clip (it is what the SDK's strip-silence example is built on), and clearing a hairline at each edge leaves the selected part standing on its own. The hairline is taken from *inside* the selection deliberately: the gap it leaves falls under the aligned copy, where nothing plays it, rather than punching a hole in audio that carries on.

A millisecond may still be small enough for Live to round away. If the split does not take, nothing ends up inside the selection and nothing is deactivated — the take carries on playing under the aligned copy, and the log names it.

### How replace keeps the original

Ablign clears the selected range and puts the aligned take there. Live usually keeps the take it displaced on a take lane underneath, by itself — it moves the clip rather than rebuilding it, so warping, clip gain and fades all come along. That is much better than anything an extension could reconstruct.

Usually, not always: it has been seen to leave the take lanes empty, which would put the original in the undo stack and nowhere else. So Ablign reads what it needs to rebuild the take before clearing anything, counts the clips on the take lanes either side of the operation, and only rebuilds when Live did not. Every block the selection displaced lands on the same lane, whatever take each one came from.

The rebuild carries the file, the position and the clip markers, but warp markers, gain and fades have no setter in 1.0.0 and cannot come with it. Which of the two happened only reaches the log — either way the take is on a lane, and undo restores the exact one.

### A note on Max stretch

It shipped at ±40 % and that was the wrong call: it spent its budget flattening corrections the matcher had right, and the result sat about **14 ms** off the guide. At ±100 % the same material lands at **1.7 ms**. Lower it if a take warbles on a hard correction; that is the real trade, not tightness against safety.

## Verified

`npm run check` runs four suites. `tools/align-check.ts` synthesises a guide take of twelve syllables and doubles that drift in known ways, then measures where the syllables actually landed:

| Check | Result |
|---|---|
| Waveform lag, realistic double | 40.8 ms → **1.9 ms** mean, 5.8 ms worst |
| Onset error, same take | 42 ms → **2 ms** (27.9x better) |
| Self-alignment is a no-op | peak shift 0.0 ms, residual **−120 dB** |
| Stereo channels stay locked | worst deviation 2.5e-7 |
| Strength 0 bypasses | 42 ms → 42 ms |
| Max stretch actually binds | harsh double: 31 ms at ±40 %, **9 ms** at ±150 % |
| Level preserved | peak 0.483 vs source 0.483 |

The waveform-lag figure correlates envelopes rather than raw samples: the noisy syllables are *different* noise in the two takes, so their waveforms never correlate however well they are aligned, but their shapes do — and shape is what you line up by eye in the arrangement.

`tools/safety-check.ts` reads the source for the one mistake that kills Live silently — any write reaching through `song.mainTrack` — and checks the mutes are paired with a restore in a `finally`. It is verified by breaking it on purpose: adding `song.mainTrack.mute = true` makes it fail.

`tools/dialog-check.ts` covers what TypeScript cannot see. The dialog is an inlined string reached over `postMessage`, so nothing type-checks across that boundary: it asserts every `getElementById` resolves, that the slider readouts pair up, that every field the dialog emits is one the command actually reads, and that a track named `</script>` cannot break out of the page. `tools/activate-check.ts` requires the built bundle against a stub host and asserts it registers.

`npx tsx tools/tighten.ts` sweeps Smoothing against Max stretch on voice-like material — that is where the ±40 % problem showed up. `npx tsx tools/timing.ts` for runtime, roughly **38 ms per second of stereo audio**, scaling linearly:

```
 10s stereo:   378 ms, 60s: 2130 ms, 180s: 6796 ms
```

Live's own rendering usually costs more than the alignment does, and the guide is only rendered once per run. Everything runs under a cancellable progress dialog.

## Known limits

- **Not calibrated on real voices.** Every number above comes from synthetic takes. The defaults are reasoned and measured, but measured against a signal generator — expect to move Smoothing and Max stretch on real material.
- **Arrangement only.** `renderPreFxAudio` takes beat positions on a track, so a Session slot has no range to render.
- **WSOLA, not Élastique.** Held vowels stretched hard can warble. Lowering Max stretch is the lever, at the cost of tightness.
- **The takes must be the same part.** A poor match is logged rather than raised, so a confident wrong answer on genuinely different material is possible. A finished run never interrupts: only a request Ablign cannot carry out, or one that failed, opens a dialog.
- **Monophonic material.** The features describe one spectral shape per frame; two singers in one track will not align sensibly. A stereo backing pair is fine — align the left and right tracks separately against the lead, which is what ticking both does.

## Requirements

Live 12 Suite on the **beta channel** — 12.4.5 or later, the build that ships the Extensions host. Extensions do not run on the stable Live 12 release. If you are not in the Ableton beta programme yet, you can sign up for it free.

## Install

Download the `.ablx` from the [latest release](../../releases/latest) and drop it onto Live. That is the whole install — no build step, nothing else to fetch.

## Building it yourself

The Ableton Extensions SDK is deliberately **not** in this repository — its licence forbids redistributing the SDK, or any part of it, outside your own application. Download it free from ableton.com and copy the three packages into `vendor/`:

```
vendor/ableton-extensions-sdk-1.0.0-beta.1.tgz
vendor/ableton-extensions-cli-1.0.0-beta.1.tgz
vendor/ableton-create-extension-1.0.0-beta.1.tgz
```

Then Node 24.16 or later:

```bash
npm install
npm run package
```

For development, enable Developer Mode in Live's *Preferences → Extensions*, copy `.env.example` to `.env` and point `EXTENSION_HOST_PATH` at your own install, then:

```bash
npm start
```

## Licence

MIT — see [LICENSE](LICENSE). The built `.ablx` contains SDK code inlined by the bundler, which the SDK licence expressly permits: it grants the right to distribute applications "using parts or all of the Extensions SDK". What it forbids is shipping the SDK on its own, which is why `vendor/` is git-ignored.

Not affiliated with or endorsed by Ableton AG.
