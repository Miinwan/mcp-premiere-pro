# Chỉnh màu — mỗi source một layer màu, cùng source dùng chung thông số

Quy tắc anh Quang (23/10/2026):
- Màu đặt trên adjustment layer riêng cho từng scene (từng source), không dồn vào một layer chung cả video.
- Cùng một source xuất hiện ở nhiều vị trí trên timeline: các layer cùng tên "Màu <source>" và cùng thông số, để không lệch màu giữa các lần xuất hiện.
- Hai source khác nhau: luôn hai layer màu riêng.

Cách làm bằng MCP:
1. `add_scene_color_layers { sequenceName, sourceTrack, basic, perSource }` tạo layer "Màu <source>" trên track mới, clip liền nhau cùng source gộp một layer, có Lumetri Color sẵn.
2. Chấm màu một layer (tay hoặc `set_lumetri_basic` / `match_color`), rồi `sync_color_layers` để mọi layer cùng tên nhận đủ thông số Lumetri (basic, creative, curves, wheels, HSL, vignette). `fromPlayhead: true` lấy layer dưới đầu đọc làm chuẩn.
3. `add_color_layer` chỉ dùng cho một look chung phủ cả video (nếu cần) phía trên các layer scene.
4. Bản vuông/dọc (`create_aspect_versions`) giữ nguyên các layer màu và phóng phủ khung mới.
