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
5. The map is then refined below the matcher's own resolution: fine envelopes of both takes, at sub-millisecond steps, are cross-correlated around each mapped position, and the few-millisecond residual they can still see bends the map before it is shaped. Envelopes rather than waveforms, because two performances share their energy contour but not their phase.
6. WSOLA stretches the double along that curve and the result is imported as a new clip.

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

`tools/quality.ts` measures what the stretch *sounds* like rather than where it lands: off-harmonic energy on a sustained vowel, spectral flatness of a stretched sibilant, and whether transients survive. Sustained vowels cost nothing measurable at any ratio tested, and 66 consonant bursts go in and 66 come out with their peaks within 1.5 %.

Sibilants were the one real artefact, and the cause was not obvious. Stretching by a ratio reuses material at a fixed distance of roughly hop x (1 - 1/ratio) — about 293 samples at +40 %, which is a comb near 150 Hz, heard as a metallic whistle. The regularity came from the centre bias: on noise every candidate offset correlates about equally by chance, so the bias decided every grain and put each one exactly on the ideal position. Dropping the bias where nothing periodic is found lets chance spread that distance out. Flatness cost went from −2.5 % to −0.4 % at +12 %, and −4.8 % to −3.3 % at +40 %, with no change to voiced material, transients or alignment accuracy.

Sibilants are also left at their own length rather than stretched. Two takes of the same word hold the s differently, and matching them means stretching one — measured at +50 % on a double whose s is half the length of the guide's. A stretched s is where overlap-add sounds worst, and its duration is the least audible thing about it, so short runs of high-frequency energy are held at their own length and the vowels either side absorb the correction. The words still land in the same place; `tools/sibilant-check.ts` guards it.

That costs a little accuracy on the synthetic bench — mean waveform lag goes from 1.9 ms to 3.6 ms — because its syllables are noisy along their whole length and so are partly protected. Real speech is sibilant for a much smaller share of its duration.

A phrase that starts cold — silence, then a hit — lands its opening attack exactly rather than approximately. In the silence before it every offset matches every other, so the matcher's path there is arbitrary, and the curve used to approach the first attack through an average of that. It now ramps from zero through the leading and trailing quiet straight to the first audible frame: the silence is where a correction is free, since nothing plays there. Cold-start attacks measure 1.9 ms instead of 7.0 ms, and a uniformly early double is corrected fully instead of partially; `tools/attack-check.ts` guards both.

Two optimisations were tried on the way to those numbers and rejected by measurement: halving the analysis hop, the obvious way to buy resolution, made the mean lag *worse* (3.5 ms to 5.1 at 1.6x the cost — a finer path has more tie-break jitter to smooth), and weighting the curve smoothing by audibility took it to 16 ms. The envelope refinement is what actually closed the gap, and it costs nothing measurable at runtime.

`npm run check` runs seven suites. `tools/align-check.ts` synthesises a guide take of twelve syllables and doubles that drift in known ways, then measures where the syllables actually landed:

| Check | Result |
|---|---|
| Waveform lag, realistic double | 40.8 ms → **2.1 ms** mean, 5.8 ms worst — through sibilant protection |
| Onset error, same take | 42 ms → **2 ms** (27.9x better) |
| Self-alignment is a no-op | peak shift 0.0 ms, residual **−120 dB** |
| Stereo channels stay locked | worst deviation 2.5e-7 |
| Strength is proportional | 100 % lands 1.9 ms out, 50 % 19.7 ms, 0 % 40.8 ms |
| Strength 0 bypasses | 42 ms → 42 ms |
| Max stretch actually binds | harsh double: 31 ms at ±40 %, **9 ms** at ±150 % |
| Level preserved | peak 0.483 vs source 0.483 |

The waveform-lag figure correlates envelopes rather than raw samples: the noisy syllables are *different* noise in the two takes, so their waveforms never correlate however well they are aligned, but their shapes do — and shape is what you line up by eye in the arrangement.

`tools/safety-check.ts` reads the source for the one mistake that kills Live silently — any write reaching through `song.mainTrack` — and checks the mutes are paired with a restore in a `finally`. It is verified by breaking it on purpose: adding `song.mainTrack.mute = true` makes it fail.

`tools/dialog-check.ts` covers what TypeScript cannot see. The dialog is an inlined string reached over `postMessage`, so nothing type-checks across that boundary: it asserts every `getElementById` resolves, that the slider readouts pair up, that every field the dialog emits is one the command actually reads, and that a track named `</script>` cannot break out of the page. `tools/activate-check.ts` requires the built bundle against a stub host and asserts it registers.

`npx tsx tools/tighten.ts` sweeps Smoothing against Max stretch on voice-like material — that is where the ±40 % problem showed up. `npx tsx tools/timing.ts` for runtime, around **22 ms per second of stereo audio** on the machine it was written on, scaling linearly:

```
 10s stereo:   236 ms, 60s: 1330 ms, 180s: 3721 ms
```

Live's own rendering usually costs more than the alignment does, and the guide is only rendered once per run. Everything runs under a cancellable progress dialog.

## Known limits

- **Not calibrated on real voices.** Every number above comes from synthetic takes. The defaults are reasoned and measured, but measured against a signal generator — expect to move Smoothing and Max stretch on real material.
- **Arrangement only.** `renderPreFxAudio` takes beat positions on a track, so a Session slot has no range to render.
- **No group tracks.** A group of audio tracks is an `AudioTrack` to the API, but Live refuses to render one, so groups are left out of the selection. Pick the tracks inside the group.
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
