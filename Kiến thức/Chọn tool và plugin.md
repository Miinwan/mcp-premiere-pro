# Choosing tools and plugins — Premiere: task → MCP tool → plugin/effect to use → notes; only what is installed on the editing machine

Updated 2026-10-23. Tools read from `src/tools/studio.ts` (studio tools) and `src/tools/index.ts`, `expanded.ts`, `color.ts` (base tools). Plugins installed for Premiere: Film Impact (built into Video Transitions), Mako (panel, callable from the MCP), Premiere Composer by Mister Horse (panel only), Beauty Box (Digital Anarchy, shared MediaCore), the manual panels Motion Bro, Motion Array, Epidemic Sound, BeatEdit, AutoCut; 105 MOGRTs. No Red Giant, Sapphire, BCC or FilmConvert: do not suggest them. Get exact built-in effect names with `list_available_effects` / `list_available_transitions`; never guess.

## Order of a job
1. `create_proxies` (4K footage) → `checkpoint_project` before any large change → `organize_project_bins`.
2. Assembly: `rough_cut_by_cues`, or `describe_sources` / `find_shots` and pick shots; `select_best_takes` to rank takes.
3. Music: `detect_beats` → `cut_to_beats`; voice: `place_voiceover`; levels: `normalize_loudness`.
4. Colour: `add_scene_color_layers` → grade → `sync_color_layers`.
5. Heavy effects: `send_to_after_effects` → After Effects → `return_from_after_effects`.
6. Other frames: `create_aspect_versions`.
7. Before delivery: `review_cut` → `qc_before_export` → `export_deliverables` (+ `export_status`).
8. After delivery: `review_unused_media` → (approval) → `clean_unused_media`.

## Assembly and cutting

| Task | Tool | Plugin / effect | Notes |
|---|---|---|---|
| Rough cut by the slate calls on set | `rough_cut_by_cues` | Dailies (Whisper) | Takes ordered by file name then time; data contract in `MCP Adobe/Dailies/README.md` |
| Describe every shot to choose from | `describe_sources` | Dailies (`fast` needs no download, `deep` uses a local vision model) | |
| Find shots by words | `find_shots` | Dailies (SigLIP 2) | English or Vietnamese query; markers on source clips, optional "Tìm: <query>" sequence; first search on a folder reads the images (about 30 s per 5 min of footage) |
| Pick usable b-roll (sharp, steady, well exposed) and build a selects sequence or hand an XML/EDL to another editor | `score_footage` | Dailies | kind `b_roll` for gimbal/drone, `static` for locked-off shots; threshold 0.85 by default |
| Rank takes | `select_best_takes` | Dailies | Same cache as `rough_cut_by_cues`; always check the picks by eye |
| Remove silences | `detect_silence` then `razor_timeline_at_time` / `ripple_delete` | — | AutoCut is a manual panel; use the MCP tools first |
| Find cut points in an already edited file | `detect_scene_edits`, `scene_edit_detection` | Premiere's Scene Edit Detection | |
| Nest, staircase clips, freeze | `mako` (nest/unnest keeps effects, staircase, freeze_frame) | Mako | The Mako panel must have opened once in the Premiere session |
| Speed changes | `speed_change`, `set_clip_speed_qe` | — | Smooth speed ramps in AE (`anim.speed_ramp`) via `send_to_after_effects` |
| Stabilise | `stabilize_clip` | Warp Stabilizer | Slow analysis; run on proxies, turn proxies off for export |
| Square and vertical from the horizontal edit | `create_aspect_versions` | Adjustment layer from the Mako template | Matches the manual workflow; do not use `auto_reframe_sequence` unless asked |

## Transitions

| Task | Tool | Plugin / transition | Notes |
|---|---|---|---|
| One transition between two clips | `add_transition`, `add_transition_to_clip` | Film Impact by name: Light Leak, Whip, Push, Flash, Zoom Blur, Glitch… | Full name table: `Chuyển cảnh Film Impact`; choosing by situation: `After Effects/Kiến thức/Công thức/Chọn chuyển cảnh.md` (ae_guide) |
| The same transition on every cut of a track | `batch_add_transitions` | Film Impact or the built-in Cross Dissolve | 70–80 % of cuts stay hard cuts; batch only when the brief asks |
| Premiere Composer-style transition | — | Premiere Composer (panel) | Not callable from the MCP; apply by hand or use the AE equivalent (`anim.scene_transition`) |
| Complex graphic transition | `send_to_after_effects` → AE `template.transition` / `anim.scene_transition` → `return_from_after_effects` | — | |

## Colour

| Task | Tool | Plugin / effect | Notes |
|---|---|---|---|
| Per-scene colour | `add_scene_color_layers`, `sync_color_layers` | Lumetri Color on adjustment layers | Rules: `Chỉnh màu` |
| One global look | `add_color_layer` | Lumetri Color | Above the scene layers |
| Basic adjustments | `set_lumetri_basic`, `get_lumetri_basic` | Lumetri Color | |
| Match a shot to a reference | `match_color`, `compare_frames`, `measure_frame_color` | Lumetri Color | Measure skin and midtones, repeat until they match |
| Apply a LUT (S-Log3 → Rec.709…) | `apply_lut` | LUT in Lumetri | |
| Skin smoothing for interviews | `apply_effect` + `set_effect_property` | Beauty Box | Heavy; apply after picture lock |

## Text, graphics, logos

| Task | Tool | Plugin / template | Notes |
|---|---|---|---|
| Titles, lower thirds from templates | `add_text_overlay`, `import_mogrt`, `import_mogrt_from_library` | 105 installed MOGRTs (list: `After Effects/Kiến thức/Plugin đã cài/MOGRT.md`) | `add_text_overlay` needs a .mogrt path |
| Colour plate for a logo | `add_color_matte` | — | Not Premiere's Color Matte (its colour picker blocks scripting) |
| Logos, custom animation | AE `template.logo_reveal`, `psd.*` then `return_from_after_effects` | — | Client logos: `brand.find_logo` on the AE side |
| Captions | `transcribe_to_captions`, `create_caption_track` | Dailies | Reuses the speech heard during the rough cut |

## Audio

| Task | Tool | Notes |
|---|---|---|
| Voiceover with music ducking | `place_voiceover` | Ducks only where the voice speaks; keyframes stay editable |
| Generic ducking | `setup_ducking`, `add_audio_keyframes` | |
| Even out levels | `normalize_loudness` | Dialogue -16, music under voice -26 LUFS; dryRun first |
| Clip volume | `adjust_audio_levels` | Delivery standard -14 LUFS: `Xuất file` |
| Audio effects | `apply_audio_effect`, `apply_audio_effect_to_all_clips` | Names from `list_available_audio_effects` |
| Beats | `detect_beats`, `cut_to_beats` | Replaces BeatEdit; check tempo by ear |

## Review and export

| Task | Tool | Notes |
|---|---|---|
| Look at frames | `capture_frame`, `export_frame` | |
| Editor's review | `review_cut` | Pacing, flash frames, jump cuts, contact sheet |
| Pre-delivery check | `qc_before_export`, `mako` quality_check | Gaps, offline, disabled clips, 1–2 frame leftovers, proxies still on |
| Platform exports | `export_deliverables`, `export_status` | Presets and naming: `Xuất file` |
| Clean-up after delivery | `review_unused_media`, `clean_unused_media` | Workflow: `Dọn project` |
