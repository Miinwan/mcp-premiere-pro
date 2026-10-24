# Changelog

All notable changes are documented here. Releases use semantic versioning.


## [Unreleased] — studio tools (2026-10-23)

- `score_footage` (2026-10-24): scores b-roll and general footage through Dailies (sharpness on a 6x6 grid, exposure, camera move, shake, flags) and keeps the usable stretches; builds a selects sequence with a marker per segment (score, grade, camera move) and can export FCP7 XML, FCPXML, EDL and CSV for another editor, pointing at the original files with their timecode. Tested end to end on a scratch project: 54 clips scored in 59 s, 64 segments placed with no errors.
- The footage engine is now called Dailies (`dailies` CLI in `MCP Adobe/Dailies`, cache `.dailies/` next to the footage; `DAILIES_DIR` overrides the folder, `MEDIA_DIR` is still read). Beat caches moved to `.dailies/` too.
- `find_shots`: find shots by plain words in English or Vietnamese through the Dailies engine's `tim-shot` (SigLIP 2, local). Every second of each clip's proxy is compared with the query; ranked hits come back with in/out and a score, become markers on the source clips in the Project panel (searching the same words again replaces them), and can optionally be laid out as a "Tìm: <query>" sequence. Uses the clips kept in the project with their proxies, like `describe_sources`.
- Exports use fixed H.264 settings: every H.264 deliverable is processed in 16-bit RGB with high-quality scaling (the equivalent of Render at Maximum Depth / Maximum Render Quality), progressive, square pixels, BT.709; 1-pass VBR at 50 Mbps for Full HD and 20 Mbps for 4K, lowered automatically to keep files at or under 1 GB (`bitrateFor`); the QT Gamma Compensation LUT is applied (`MCP_QT_GAMMA_LUT`; a missing LUT is a clear error), but not to the ProRes master or PNG sequences. ffmpeg is kept instead of a Media Encoder `.epr` preset because the 1 GB cap depends on each video's length.
- `review_unused_media` / `clean_unused_media`: post-delivery clean-up. Reviews unused project items and files (with their proxies, plus media in the source folders that was never used) into a JSON report for approval, then removes the items from the project and moves the files to the Trash with Finder. Files in use, delivery folders and a checkpoint are always kept. Only files inside the job folder go to the Trash; files from elsewhere (SFX and music libraries) are only removed from the project.
- Media-engine tools follow the proxy-first workflow: `rough_cut_by_cues`, `describe_sources` and `select_best_takes` default to the clips kept in the project after junk is filtered out, with their attached proxies, sent to the engine as a list. Clips without a proxy are reported (`allowOriginal` reads the original file instead); `bin` or `sourceFolder` narrow the selection.
- Music, takes, voiceover and review: `detect_beats` (tempo, beats, bar starts, timeline markers, cached in `.media/`, no extra libraries), `cut_to_beats` (a copy of the sequence with every cut on the beat, Motion kept), `select_best_takes` (scores takes by cut calls, speech clarity and retake calls; builds a selects sequence), `place_voiceover` (places a VO and ducks the music only where the voice speaks, with editable keyframes), `normalize_loudness` (per-clip LUFS, levels set, ducking shape kept), `review_cut` (pacing, flash frames, jump cuts, repeated footage, off-beat cuts, Review markers, contact sheet).
- `transcribe_to_captions`: captions from the speech the media engine already heard (`.media`), only the words inside each clip's in/out, split by line length, written to `Phụ đề/<sequence>.srt` and added as a caption track.
- `export_deliverables` / `export_status`: ProRes 422 HQ master through Adobe Media Encoder, then the deliverables in the background with ffmpeg, using the same preset table and file naming as the After Effects MCP; loudness is measured first, and rough mixes are lightly compressed before normalisation.
- `checkpoint_project` (labelled `.prproj` copy before big changes), `organize_project_bins` (bins 01 Footage → 06 Proxies & renders, with a dry run), `qc_before_export` (offline media, disabled clips, gaps, 1–2 frame leftovers, red markers, empty or muted tracks, wrong frame, proxies still on; reported by timecode).
- `create_proxies` / `proxy_status`: first step of a job — 1/2 ProRes Proxy (or H.264) with VideoToolbox, low priority, one file at a time, saved as `<source>/Proxies/<name>_Proxy.mov` and attached to the clips. Measured on five 4K clips: about 40 seconds per file.
- `add_scene_color_layers` / `sync_color_layers`: one colour layer "Màu <source>" (Lumetri) per source; repeated sources share values, and all Lumetri parameters are synced after grading one layer. Fixed a regex with `/` inside brackets that ExtendScript could not parse.
- `rough_cut_by_cues`: calls the media engine to hear slate calls (3-2-1, action / cut, ok, in several languages) in the original audio and builds a new sequence with every take back to back a→z, a marker per take (red when confidence is low), and the sequence frame and Motion scale/position from the engine; takes are placed by their real end so there are no gaps.
- `describe_sources`: describes every shot through the media engine (fast, or deep with a local Qwen vision model) and writes it into the Project panel's Comment and Log Note columns.
- `send_to_after_effects` / `return_from_after_effects`: bridge to the After Effects MCP through a handoff file; the render goes on the track above and the original is only disabled.
- Fixed `export_frame`: the time is now passed as a timecode at the sequence frame rate (it used to pass seconds/ticks, landing on the wrong frame while reporting success).
- `create_aspect_versions`: duplicates a horizontal edit as `… 1x1`, `… 9x16` (or 4:5…), re-framing each clip from the horizontal frame itself (media engine framing, face-aware, no black edges); only Scale/Position change, and adjustment layers keep their effects and are scaled to cover the new frame. Tested on a real client rough cut.
- `add_color_layer`: a grading adjustment layer with Lumetri over the sequence on its own track; when the project has no adjustment layer, one is taken from Mako's template.
- `mako`: runs Mako panel actions (adjustment layers per clip/cut, staircase, freeze frame, fit/fill, nest/unnest with effects kept, clear effects, QC, delete empty tracks, new sequence, transparency grid) on clips chosen by track/index, time range or all.
- `add_color_matte`: white/black (white by default) or any hex colour plate at sequence size without opening Premiere's colour picker; saved next to the project in `MCP mattes` so it never goes offline.
- CEP panel 1.1.7: loads with Premiere and starts the bridge automatically (`autoStart: false` in `~/.premiere-mcp-bridge/config.json` turns it off).

## [1.2.0] - 2026-08-17

- Fixed `add_marker`, `update_marker`, `delete_marker`, `list_markers`, `lock_track` and
  `toggle_track_visibility` ignoring the required `sequenceId` and always operating on the
  active sequence. They now act on the requested sequence and return a truthful error when the
  ID resolves to nothing, instead of reporting `success: true` against the wrong timeline.
- Fixed `list_sequence_tracks` and `delete_track` silently falling back to the active sequence
  when `sequenceId` did not resolve. `list_sequence_tracks` also no longer echoes the requested
  ID back next to a different sequence's name.
- `delete_track` now works across sequences. Premiere exposes no DOM track-deletion API, so it
  falls through to the QE DOM, which reaches any sequence Premiere has open rather than only the
  active one. A sequence QE cannot address is reported by name instead of having a track deleted
  from whichever timeline is on screen.
- Fixed `create_bin` and `import_folder` resolving a named parent with `children[name]`, which
  never matches: `ProjectItemCollection` is index-only, so the lookup always fell through to the
  project root while the response echoed the requested name back.
- Fixed `add_to_timeline` reporting a pre-existing clip as the one it placed, and removing linked
  audio matched against that clip's start time, whenever the placement could not be confirmed.
- Fixed `insertMode` being accepted and echoed but never applied; `insert` now inserts and shifts
  rather than overwriting.
- Fixed `duplicate_sequence` falling back to the active sequence when the clone could not be
  resolved, then renaming it and, with `clearContents`, emptying it.
- Caller-supplied strings interpolated into generated ExtendScript are now serialised, closing an
  arbitrary-code-execution path and fixing ordinary names containing a double quote.
- Fixed `set_sequence_settings` never writing anything. It compared the requested width and
  height against the current ones, wrote no settings, and reported a match; a caller asking for
  a different frame size got `success: true` and an unchanged sequence. It now applies the
  settings and reports what it wrote. Frame size can be changed after creation — assigned
  through `getSettings()`/`setSettings()` and confirmed by read-back on 26.0.2.
- Fixed the bridge's response serializer silently passing raw control characters through
  instead of escaping them. A single stray control character anywhere in a clip or marker
  name could make the entire tool response unparseable, not just that field. The bridge and
  CEP panel now share a conformant serializer, tested against the platform's own parser plus
  a large generated corpus.
- Added the missing `JSON.parse` read direction to the ExtendScript prelude. The engine ships
  no native `JSON` object; the prelude previously installed only `stringify`, so any generated
  script that needed to *decode* a payload — including `add_text_overlay`'s MOGRT text
  decoding — failed with `JSON.parse is not a function` on every call.
- Made the command/response file handoff between the server and CEP panel atomic (write to a
  scratch name, then rename into place) instead of writing directly to the polled filename.
  Previously a truncated read during a write could permanently fail a command that had
  actually executed, and a slow response could be overwritten before the caller read it.

### Security

- Fixed an ExtendScript injection vulnerability (GHSA-rc48-rh69-7487):
  a small set of tool arguments (including `clipId` in `split_clip`, `add_transition`, and
  `add_transition_to_clip`) were interpolated unquoted into generated ExtendScript. A value
  containing a double quote could break out of the string literal and execute arbitrary
  ExtendScript, including forging a fake `success: true` tool result. All interpolated values
  are now serialised with `JSON.stringify` at the point of use. Reported and patched by
  [@medazizktata](https://github.com/medazizktata).

### Breaking

- `move_clip` now rejects `newTrackIndex` instead of accepting and ignoring it. The parameter
  never moved a clip between tracks; callers that passed it were silently getting a time-only
  move. Use `move_clip_to_track`, which on this build is a remove-and-reinsert: it can overwrite
  whatever occupies the destination and gives the clip a new id, so it is a separate call rather
  than an option here.
- `add_marker` and `update_marker` now reject a `color` outside the eight-name palette instead of
  silently storing green. Any name Premiere does not have was previously accepted and produced a
  green marker, so a caller asking for `magenta` got green and no error.
- Tools that resolve a `sequenceId` now fail when it does not resolve, where many previously fell
  back to the active sequence and reported success. Callers relying on a bad or stale id to mean
  "use whatever is open" will now see an error; pass no id for that behaviour.

- Sequence-scoped marker and track tools now reject an empty `sequenceId` at the schema layer
  and report the resolved `sequenceId`/`sequenceName` they acted on.

## [1.1.6] - 2026-08-05

- Added `get_capabilities`, a read-only report of local bridge installation, catalog coverage, and optional live connection status.
- Added installable Codex and Claude Code plugin packages that reuse the supported local MCP server and Premiere editing skill.
- Reworked the README entry path around client-specific installation and read-only connection verification.

## [1.1.5] - 2026-08-05

- Added reproducible CEP ZXP signing, verification, and release-upload workflows.
- Added a local macOS helper that creates a private self-signed certificate and stores its password in the macOS Keychain.

## [1.1.4] - 2026-08-05

- Added the official Claude Desktop MCPB bundle to the release artifact workflow.
- Added `verify_premiere_connection`, a read-only CEP bridge and Premiere host readiness check.
- Added release notes and a security policy, and clarified supported CEP, unsigned archive, and experimental UXP status.

## [1.1.3] - 2026-08-05

- Stabilized the release artifact workflow with a clean CI test run.
- Published the first verified unsigned CEP release archive.

## [1.1.2] - 2026-08-05

- Added the public npm package, `premiere-pro-mcp` CLI, CEP installer, and diagnostics command.
- Added package-content verification and npm publishing workflow.

## [1.1.1] - 2026-08-05

- Renamed the published package identifier to `adobe-premiere-pro-mcp`.

## [1.1.0] - 2026-08-05

- Added dialog-safe handling for FCP XML import, sequence creation, EDL import, and Media Encoder availability.
- Migrated the MCP server to the current v2 transport implementation.
