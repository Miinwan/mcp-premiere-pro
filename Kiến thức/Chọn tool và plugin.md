# Chọn tool và plugin — Premiere: việc → tool MCP → plugin/hiệu ứng nên dùng → lưu ý; chỉ những gì đã cài trên máy anh Quang

Cập nhật 23/10/2026. Tool đọc thật từ `src/tools/studio.ts` (tool riêng của anh) và `src/tools/index.ts`, `expanded.ts`, `color.ts` (tool gốc). Plugin đã cài cho Premiere: Film Impact (nằm sẵn trong Video Transitions), Mako (panel, MCP gọi được), Premiere Composer của Mister Horse (chỉ qua panel), Beauty Box (Digital Anarchy, dùng chung MediaCore), các panel tay Motion Bro, Motion Array, Epidemic Sound, BeatEdit, AutoCut; 105 MOGRT. Không có Red Giant, Sapphire, BCC, FilmConvert: đừng đề xuất. Tên hiệu ứng gốc chính xác lấy bằng `list_available_effects` / `list_available_transitions`, không đoán.

## Thứ tự một job
1. `create_proxies` (footage 4K) → `checkpoint_project` trước mọi thay đổi lớn → `organize_project_bins`.
2. Dựng: `rough_cut_by_cues` hoặc `describe_sources` rồi tự chọn shot.
3. Màu: `add_scene_color_layers` → chấm → `sync_color_layers`.
4. Hiệu ứng nặng: `send_to_after_effects` → After Effects → `return_from_after_effects`.
5. Bản khác khung: `create_aspect_versions`.
6. Trước giao: `qc_before_export` → `export_deliverables` (+ `export_status`).

## Dựng và cắt

| Việc | Tool | Plugin / hiệu ứng | Lưu ý |
|---|---|---|---|
| Cắt thô theo khẩu lệnh trên set | `rough_cut_by_cues` | Engine Media (Whisper) | Take xếp theo tên file rồi thời gian; hợp đồng dữ liệu ở `MCP Adobe/Media/README.md` |
| Mô tả từng shot để chọn | `describe_sources` | Engine Media (`fast` không tải gì, `deep` dùng model hình local) | |
| Cắt bỏ đoạn lặng | `detect_silence` rồi `razor_timeline_at_time` / `ripple_delete` | — | AutoCut là panel tay; dùng tool MCP trước |
| Tìm điểm cắt trong file đã dựng sẵn | `detect_scene_edits`, `scene_edit_detection` | Scene Edit Detection của Premiere | |
| Nest, dàn clip thành bậc, freeze | `mako` (nest/unnest giữ effect, staircase, freeze_frame) | Mako | Panel Mako phải đã mở một lần trong phiên Premiere |
| Đổi tốc độ | `speed_change`, `set_clip_speed_qe` | — | Speed ramp mượt làm ở AE (`anim.speed_ramp`) qua `send_to_after_effects` |
| Ổn định rung | `stabilize_clip` | Warp Stabilizer | Phân tích lâu; làm trên proxy rồi tắt proxy khi xuất |
| Bản vuông, dọc từ bản ngang | `create_aspect_versions` | Adjustment layer từ template Mako | Đúng cách anh làm tay; không dùng `auto_reframe_sequence` trừ khi anh yêu cầu |

## Chuyển cảnh

| Việc | Tool | Plugin / transition | Lưu ý |
|---|---|---|---|
| Một transition giữa 2 clip | `add_transition`, `add_transition_to_clip` | Film Impact theo tên: Light Leak, Whip, Push, Flash, Zoom Blur, Glitch… | Bảng tên đầy đủ: `Chuyển cảnh Film Impact`; chọn theo tình huống: `After Effects/Kiến thức/Công thức/Chọn chuyển cảnh.md` (ae_guide) |
| Cùng một transition cho mọi điểm cắt của track | `batch_add_transitions` | Film Impact hoặc Cross Dissolve gốc | 70–80 % điểm cắt vẫn để cắt cứng; chỉ batch khi brief yêu cầu |
| Chuyển cảnh kiểu Premiere Composer | — | Premiere Composer (panel) | MCP không gọi được; anh áp tay hoặc dùng kiểu tương đương ở AE (`anim.scene_transition`) |
| Chuyển cảnh đồ hoạ phức tạp | `send_to_after_effects` → AE `template.transition` / `anim.scene_transition` → `return_from_after_effects` | — | |

## Màu

| Việc | Tool | Plugin / hiệu ứng | Lưu ý |
|---|---|---|---|
| Màu theo scene | `add_scene_color_layers`, `sync_color_layers` | Lumetri Color trên adjustment layer | Quy tắc: `Chỉnh màu` |
| Một look chung cả video | `add_color_layer` | Lumetri Color | Đặt trên các layer scene |
| Chỉnh thông số cơ bản | `set_lumetri_basic`, `get_lumetri_basic` | Lumetri Color | |
| Khớp màu shot với shot mẫu | `match_color`, `compare_frames`, `measure_frame_color` | Lumetri Color | Đo da và midtone, lặp đến khi khớp |
| Áp LUT (S-Log3 → Rec.709…) | `apply_lut` | LUT trong Lumetri | |
| Mịn da phỏng vấn | `apply_effect` + `set_effect_property` | Beauty Box | Nặng; áp sau khi chốt cắt |

## Chữ, đồ hoạ, logo

| Việc | Tool | Plugin / template | Lưu ý |
|---|---|---|---|
| Tiêu đề, lower third từ template | `add_text_overlay`, `import_mogrt`, `import_mogrt_from_library` | 105 MOGRT đã cài (danh sách: `After Effects/Kiến thức/Plugin đã cài/MOGRT.md`) | `add_text_overlay` cần đường dẫn .mogrt |
| Nền màu cho logo | `add_color_matte` | — | Không dùng Color Matte của Premiere (hộp chọn màu làm treo script) |
| Logo, animation riêng | AE `template.logo_reveal`, `psd.*` rồi `return_from_after_effects` | — | Logo khách: `brand.find_logo` bên AE |
| Phụ đề | `transcribe_to_captions`, `create_caption_track` | Engine Media | Dùng lại lời đã nghe khi cắt thô |

## Âm thanh

| Việc | Tool | Lưu ý |
|---|---|---|
| Ducking nhạc dưới thoại | `setup_ducking`, `add_audio_keyframes` | |
| Âm lượng clip | `adjust_audio_levels` | Chuẩn giao -14 LUFS: `Xuất file` |
| Hiệu ứng âm thanh | `apply_audio_effect`, `apply_audio_effect_to_all_clips` | Tên lấy bằng `list_available_audio_effects` |

## Kiểm tra và xuất

| Việc | Tool | Lưu ý |
|---|---|---|
| Xem frame | `capture_frame`, `export_frame` | |
| Soát lỗi trước giao | `qc_before_export`, `mako` quality_check | Gap, offline, clip tắt, mảnh 1–2 frame, proxy chưa tắt |
| Xuất theo nền tảng | `export_deliverables`, `export_status` | Preset và đặt tên: `Xuất file` |

## Đang hoàn thiện (phiên chính đang làm, kiểm tra lại tên khi dùng)
`detect_beats`, `cut_to_beats` (cắt theo nhịp nhạc, thay BeatEdit), `select_best_takes`, `place_voiceover`, `normalize_loudness`, `review_cut`.
