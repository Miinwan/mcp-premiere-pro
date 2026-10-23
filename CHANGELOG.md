# Changelog

All notable changes are documented here. Releases use semantic versioning.


## [Unreleased] — Minwan (23/10/2026)

- Pha 6: `detect_beats` (BPM, nhịp, đầu ô nhịp, marker trên timeline, cache `.media/nhip_*.json`, không cần thư viện ngoài), `cut_to_beats` (bản sao sequence, mọi điểm cắt rơi đúng nhịp, giữ Motion), `select_best_takes` (chấm điểm take theo lệnh cắt, độ rõ thoại, tiếng gọi làm lại; dựng sequence selects), `place_voiceover` (đặt VO, duck nhạc đúng chỗ có giọng bằng keyframe chỉnh tay được), `normalize_loudness` (đo LUFS từng clip, đặt level, giữ hình dạng duck), `review_cut` (nhịp dựng, flash frame, jump cut, footage lặp, cắt lệch beat, marker Review, contact sheet).
- `transcribe_to_captions`: phụ đề từ lời thoại media engine đã nghe (`.media`), chỉ lấy chữ trong in/out của từng clip, chia dòng theo số ký tự, ghi `Phụ đề/<sequence>.srt` và tạo caption track.
- `export_deliverables` / `export_status`: master ProRes 422 HQ qua Adobe Media Encoder, deliverable chạy nền bằng ffmpeg với cùng bảng preset và cách đặt tên như MCP After Effects; âm lượng đo trước, mix thô được nén nhẹ rồi chuẩn hoá.
- `checkpoint_project` (lưu bản sao .prproj có nhãn trước thay đổi lớn), `organize_project_bins` (bin 01 Footage → 06 Proxies & renders, có chạy thử), `qc_before_export` (offline, clip tắt, khoảng đen, mảnh 1–2 frame, marker đỏ, track trống/tắt tiếng, khung sai, proxy đang bật; báo theo timecode).
- `create_proxies` / `proxy_status`: bước đầu tiên của job — ProRes Proxy 1/2 (hoặc H.264) bằng VideoToolbox, ưu tiên thấp, từng file, lưu `<source>/Proxies/<tên>_Proxy.mov`, tự gắn proxy vào clip trong project. Chạy thật 5 clip 4K: khoảng 40 giây mỗi file.
- `add_scene_color_layers` / `sync_color_layers`: mỗi source một layer màu "Màu <source>" (Lumetri), cùng source ở nhiều vị trí dùng chung thông số, sync toàn bộ tham số Lumetri sau khi chấm một layer. Sửa regex có `/` trong ngoặc vuông làm ExtendScript không parse được.
- `rough_cut_by_cues`: gọi engine Media của MCP Adobe nghe khẩu lệnh (3-2-1, action, diễn, đi / cắt, ok) trong audio gốc, dựng sequence mới với mọi take nối tiếp a→z, marker từng take (đỏ khi độ tin cậy thấp), khung sequence và Motion scale/vị trí theo Media; đặt take theo điểm kết thúc thật nên không hở.
- `describe_sources`: mô tả từng shot qua Media (nhanh hoặc kỹ với Qwen3.5-2B), ghi vào cột Comment và Log Note của Project panel.
- `send_to_after_effects` / `return_from_after_effects`: cầu nối với MCP After Effects qua file handoff; bản render đặt lên track trên, bản gốc chỉ bị tắt.
- Sửa `export_frame`: truyền timecode theo fps sequence (trước đó truyền số giây/ticks nên ra sai frame mà vẫn báo thành công).
- `create_aspect_versions`: nhân bản ngang thành `… 1x1`, `… 9x16` (hoặc 4:5…), bố cục từng clip cắt từ chính khung ngang (Media `bo-cuc`, căn theo mặt, không lộ viền), chỉ đổi Scale/Position; adjustment layer giữ effect và phóng phủ khung mới. Đã chạy thật trên Rough cut FSI v2.
- `add_color_layer`: layer chỉnh màu (adjustment + Lumetri) phủ sequence trên track riêng; khi project chưa có adjustment layer thì lấy từ template của Mako.
- `mako`: gọi các thao tác của panel Mako (adjustment layer theo clip/điểm cắt, staircase, freeze frame, fit/fill khung, nest/unnest giữ effect, xoá effect, QC, xoá track trống, sequence mới, transparency grid) trên clip chọn theo track/index, khoảng thời gian hoặc tất cả.
- `add_color_matte`: nền trắng/đen (mặc định trắng) hoặc mã màu bất kỳ đúng khung sequence, không mở hộp chọn màu của Premiere; file lưu cạnh project trong `MCP mattes` để không bị offline.
- Panel CEP 1.1.7: tự nạp khi mở Premiere và tự Start Bridge (`autoStart: false` trong `~/.premiere-mcp-bridge/config.json` để tắt).

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

- Fixed an ExtendScript injection vulnerability ([GHSA-rc48-rh69-7487](https://github.com/hetpatel-11/Adobe_Premiere_Pro_MCP/security/advisories/GHSA-rc48-rh69-7487)):
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
