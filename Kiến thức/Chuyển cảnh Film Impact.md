# Chuyển cảnh Film Impact — tên gọi trong Premiere 2026, khi nào dùng, thời lượng

Cập nhật 23/10/2026. Film Impact đã nằm sẵn trong danh sách Video Transitions của Premiere 26.5 (không còn tiền tố "Impact"). Áp bằng tên qua `add_transition`, `add_transition_to_clip` hoặc `batch_add_transitions { sequenceId, trackIndex, transitionName, duration }` (đã chạy thật: "Light Leak" trên mọi điểm cắt). Panel "Film Impact Dashboard" chỉ để duyệt và chỉnh; tham số chi tiết chỉnh trong Effect Controls sau khi áp.

| Nhóm | Tên transition | Dùng khi | Thời lượng gợi ý |
|---|---|---|---|
| Ánh sáng | Light Leak, Chroma Leak, Light Sweep, Flare, Flash, Glow, Ray | Hotel, resort, F&B sang, chuyển cảnh mềm có cảm xúc; Flash cho event recap theo beat | Leak 16–24 frame; Flash 4–8 frame |
| Chuyển động | Push, Slide, Whip, Pull Motion, Pop Motion, Spin Motion, Spring Motion, Travel Motion, Block Motion, Flip Motion, Fold Motion, Motion Tween | Reel nhịp nhanh, F&B, mall sale; Whip theo hướng máy lia | 8–12 frame, đặt đúng beat |
| 3D | 3D Roll, 3D Spinback, Page Peel, Roll, Film Roll | Đổi chủ đề, giới thiệu món, trang sự kiện | 12–16 frame |
| Nhòe, zoom | Zoom Blur, Directional Blur, Radial Blur, Lens Blur, Blur Dissolve, Cross Zoom | Dồn năng lượng, cắt cùng hướng chuyển động; Blur Dissolve cho resort nhịp chậm | 8–14 frame |
| Méo, nhiễu | Glitch, VHS Damage, Earthquake, Chaos, Liquid Distortion, Wave, Phosphor, TV Power | Teaser trẻ, sự kiện âm nhạc, nhấn beat mạnh | 4–10 frame |
| Hình khối | Linear Wipe, Radial Wipe, Clock Wipe, Star Wipe, Neon Wipe, Panel Wipe, Plateau Wipe, Shape Flow, Shape Dissolve, Stripe, Slice, Mosaic, Kaleidoscope, Mirror, Split, Stretch, Stretch Wipe | Thiết kế đồ hoạ, menu, khuyến mãi | 10–16 frame |
| Mềm cổ điển | Cross Dissolve, Additive Dissolve, Film Dissolve, Luma Fade, Dip to Black, Dip to White, Dip to Color, Non-Additive Dissolve | Resort chậm, phỏng vấn, kết video | 12–24 frame |
| Chữ | Typewriter, Text Animator | Chuyển cảnh mang chữ | theo độ dài chữ |

Nguyên tắc: một video chỉ dùng 1–2 họ transition chính; không đặt transition lên cut đang có nhịp nhạc mạnh mà không khớp beat; job khác nhau thì đổi họ, không lặp một kiểu cho mọi job.

Chọn theo tình huống (Premiere và After Effects chung một bảng): `After Effects/Kiến thức/Công thức/Chọn chuyển cảnh.md` (đọc bằng ae_guide).
