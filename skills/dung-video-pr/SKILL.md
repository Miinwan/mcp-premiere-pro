---
name: dung-video-pr
description: Edit or revise a video in Premiere Pro through the premiere-pro MCP — proxies, rough cut from slate calls, shot search and selection, beats, voiceover, colour, square/vertical versions, After Effects effects round trip, Film Impact transitions, exports and clean-up. Use when the user asks (often in Vietnamese) "dựng video", "cắt thô", "rough cut", "tìm shot", "làm bản dọc", "xuất cho TikTok/YouTube" or similar in Premiere.
---

# Editing video in Premiere

Owner's convention: reply in Vietnamese, address the user as "anh", refer to yourself as "em", no emoji.

1. **Context**: `verify_premiere_connection`, `get_project_info`; `pr_guide` (Film Impact transitions, Mako plugin, exports). Never delete or modify the original source folders; work in the project the user names.
2. **Proxies first**: `create_proxies { sourceFolder }` (hardware ProRes Proxy at 1/2, attached to the clips automatically, `proxy_status` for progress) so the machine stays light and cool; analyse and edit only after that.
   **Sources**: `rough_cut_by_cues { frame }` (by default uses the clips the user kept in the project after filtering, with their proxies; add `bin` or `sourceFolder` to narrow it) cuts takes by the slate calls 3-2-1 / action / diễn / đi through cắt / cut / ok, ordered a→z so the user can reorder them; `describe_sources` writes shot descriptions into the Project panel. The first run is slow: call again to collect the result.
   **Find shots by words**: `find_shots { query }` — describe the picture in Vietnamese or English ("cô gái cầm menu", "close-up of a face", "wide shot of the restaurant"); it returns ranked hits with in/out and score, puts a marker on each source clip (searching the same words again replaces them), and with `placeOnTimeline: true` builds a "Tìm: <query>" sequence in rank order. Same clip selection as `describe_sources` (clips kept in the project with proxies; `bin`, `sourceFolder`, `allowOriginal`, `top`). The first search on a folder reads the images (about 30 s per 5 minutes of footage); later searches take seconds. Use it to pull B-roll for a script line or a client note, then check the hits by eye.
3. **Plan**: for a large job, present the order, pacing and transitions (one or two Film Impact families that fit the brief, a different style per job) and wait for approval.
4. **Edit**: transitions by name (`batch_add_transitions`), colour with `add_scene_color_layers` / `sync_color_layers` (or `add_color_layer` for a global look), quick operations through `mako` (QC, fit/fill, freeze, nest…), logo plates with `add_color_matte`. Complex effects: `send_to_after_effects` → after-effects MCP `bridge.from_premiere` → do the work → `bridge.to_premiere` → `return_from_after_effects`.
5. **Check your own work**: open the sequence and `export_frame` at key points; `mako { action: "quality_check" }` before delivery.
6. **Feedback**: change exactly what the user asked and keep what already works; every change must stay editable by hand (originals are only disabled, never deleted).
7. **Square/vertical and export**: `create_aspect_versions`, then `export_deliverables { presets, client, title }` (+ `export_status`); report the files, settings and LUFS.
8. **Lessons**: when the job is done, note in `Kiến thức/Khách hàng/<client>.md` (After Effects MCP) what the client changed and what they liked, so the next job can reuse it.

## Music, takes, voiceover, loudness, review
- Takes: `select_best_takes { sourceFolder, sequenceName }` ranks takes with reasons; the user still checks them by eye.
- Music: `detect_beats` (bar-start markers) → `cut_to_beats { every: 1|2|4 }` makes a "(theo nhịp)" copy and leaves the original untouched; then re-run per-scene colour on the new copy.
- Voiceover: `place_voiceover { file, at }` ducks the music exactly where the voice speaks; to record a voice first, use the long-tieng-voice-studio skill.
- Loudness: `normalize_loudness { dryRun: true }` to preview, then apply (dialogue -16, music under voice -26 LUFS).
- Before showing the user: `review_cut { targetSeconds }`, open the contact sheet, fix the Review markers, and finish with `qc_before_export`.

## Project clean-up after delivery
`review_unused_media` → show the user the list (items to remove, files to the Trash, space freed) → only after they agree, `clean_unused_media { report, confirm: true }`. Never confirm on the user's behalf and never delete permanently. Details: pr_guide "Dọn project".
