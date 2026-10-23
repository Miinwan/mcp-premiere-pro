---
name: dung-video-pr
description: Dựng hoặc sửa video trong Premiere bằng MCP premiere-pro cho anh Quang — rough cut theo khẩu lệnh, chọn shot, màu, bản vuông/dọc, đưa sang After Effects làm hiệu ứng, chuyển cảnh Film Impact, xuất file. Dùng khi anh nói "dựng video", "cắt thô", "rough cut", "làm bản dọc", "xuất cho TikTok/YouTube" trong Premiere.
---

# Dựng video Premiere

Gọi anh, xưng em, tiếng Việt, không emoji.

1. **Nắm bối cảnh**: `verify_premiere_connection`, `get_project_info`; `pr_guide` (chuyển cảnh Film Impact, plugin Mako, xuất file). Không xoá hay sửa folder source gốc; làm trên project anh chỉ định.
2. **Proxy trước tiên**: `create_proxies { sourceFolder }` (ProRes Proxy 1/2 bằng phần cứng, tự gắn vào clip, `proxy_status` xem tiến độ) để máy nhẹ và mát; sau đó mới phân tích và dựng.
   **Source**: `rough_cut_by_cues { sourceFolder, frame }` cắt take theo khẩu lệnh 3-2-1 / action / diễn / đi đến cắt / ok, đặt a→z để anh tự xếp; `describe_sources` ghi mô tả shot vào Project panel. Lần đầu chạy lâu: gọi lại để lấy kết quả.
3. **Plan**: job lớn thì trình thứ tự, nhịp, chuyển cảnh (1–2 họ Film Impact hợp brief, mỗi job một kiểu) và chờ anh duyệt.
4. **Dựng**: transition theo tên (`batch_add_transitions`), màu `add_color_layer` (adjustment + Lumetri), thao tác nhanh qua `mako` (QC, fit/fill, freeze, nest…), nền logo `add_color_matte`. Hiệu ứng phức tạp: `send_to_after_effects` → MCP after-effects `bridge.from_premiere` → làm → `bridge.to_premiere` → `return_from_after_effects`.
5. **Tự xem**: mở sequence rồi `export_frame` ở các điểm quan trọng; `mako { action: "quality_check" }` trước khi giao.
6. **Feedback**: sửa đúng chỗ anh nói, giữ phần đã ổn; mọi thay đổi để anh chỉnh tay được (bản gốc chỉ tắt, không xoá).
7. **Bản vuông/dọc và xuất**: `create_aspect_versions` rồi `export_deliverables { presets, client, title }` (+ `export_status`); báo file, thông số, LUFS.
8. **Bài học**: xong job, ghi vào `Kiến thức/Khách hàng/<khách>.md` (MCP After Effects) phần khách sửa gì, cái gì được khen, để job sau dùng lại.

## Nhạc, take, voiceover, âm lượng, duyệt (pha 6)
- Chọn take: `select_best_takes { sourceFolder, sequenceName }` xếp hạng take có lý do; vẫn để anh xem bằng mắt.
- Nhạc: `detect_beats` (marker đầu ô nhịp) → `cut_to_beats { every: 1|2|4 }` ra bản sao "(theo nhịp)", bản gốc giữ nguyên; sau đó chạy lại màu theo scene trên bản mới.
- Voiceover: `place_voiceover { file, at }` duck nhạc đúng chỗ có giọng; cần thu giọng thì dùng skill long-tieng-voice-studio.
- Âm lượng: `normalize_loudness { dryRun: true }` xem trước rồi áp (thoại -16, nhạc dưới thoại -26 LUFS).
- Trước khi gửi anh: `review_cut { targetSeconds }` rồi mở contact sheet, sửa các marker Review, sau cùng `qc_before_export`.

