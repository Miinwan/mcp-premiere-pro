# Plugin và panel đang cài cho Premiere — cái nào MCP gọi được, cái nào dùng tay

Cập nhật 23/10/2026.

- **Mako** (`com.basicsstudio.mako`): MCP gọi được trực tiếp qua tool `mako` (cùng engine script `session`, cần panel Mako đã nạp một lần trong phiên Premiere): adjustment_layer (theo cả đoạn, từng clip, từng điểm cắt), staircase/unstaircase, freeze_frame, fit_frame (fit/fill), nest/unnest giữ effect, clear_effects, quality_check (gap đỏ, offline cam, clip tắt vàng, mảnh 1–2 frame tím), delete_empty_tracks, new_sequence, transparency_grid. Adjustment layer của các tool `add_color_layer`, `create_aspect_versions` cũng lấy từ template của Mako.
- **Film Impact Dashboard**: transition đã gộp vào Premiere, gọi theo tên (xem `Chuyển cảnh Film Impact.md`).
- **Premiere Composer / Animation Composer** (Mister Horse): thư viện preset trên cloud, mã hoá trong plugin, chỉ áp qua panel; MCP không gọi được ổn định. Khi brief cần kiểu của Composer, anh áp tay hoặc dùng kiểu tương đương của MCP After Effects (`anim.*`, `template.*`, `anim.scene_transition`).
- **Motion Bro, Motion Array, Epidemic Sound, BeatEdit, AutoCut**: panel dùng tay; BeatEdit/AutoCut sau này có thể thay bằng engine Media (beat, cắt lặng).
- Nền màu cho logo: `add_color_matte` (trắng/đen/mã màu), không dùng Color Matte của Premiere vì nó mở hộp chọn màu làm treo script.

- **Proxy**: bước đầu tiên của mọi job có footage 4K — `create_proxies` (Proxies/ cạnh source, gắn sẵn; bật Toggle Proxies trong Program Monitor khi dựng, tắt khi xuất).
