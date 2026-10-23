# Xuất file — preset từng nền tảng, đặt tên, âm lượng, cách gọi

Cập nhật 23/10/2026. After Effects: `ae_do render.export { comp, presets, client, title }` (+ `render.export_status`). Premiere: `export_deliverables { sequenceName, presets, client, title }` (+ `export_status`); master ProRes 422 HQ qua Adobe Media Encoder nên Premiere vẫn dùng được trong lúc xuất. Tên file: `<Khách> <Tên video> <Tỉ lệ> V<n>` (tự lấy số V kế tiếp), nhật ký `Kết quả xuất.md` trong thư mục xuất (mặc định `<thư mục project>/Xuất file`).

| Preset | Tên | Khung | Codec | Âm lượng | Ghi chú |
|---|---|---|---|---|---|
| youtube_4k | YouTube 4K | 3840x2160 | h264 45M | -14 LUFS | H.264 High VBR 45 Mbps, AAC 320k, -14 LUFS (YouTube chuẩn hoá về -14) |
| youtube_1080 | YouTube 1080 | 1920x1080 | h264 16M | -14 LUFS | H.264 High VBR 16 Mbps, AAC 320k, -14 LUFS |
| reels | Reels / TikTok | 1080x1920 | h264 14M | -14 LUFS | 1080x1920 H.264 14 Mbps, AAC 320k, -14 LUFS; chữ trong vùng an toàn (trừ 250 px trên, 420 px dưới) |
| feed_4x5 | Feed 4:5 | 1080x1350 | h264 12M | -14 LUFS | 1080x1350 H.264 12 Mbps, AAC 320k, -14 LUFS |
| square | Vuông 1:1 | 1080x1080 | h264 12M | -14 LUFS | 1080x1080 H.264 12 Mbps, AAC 320k, -14 LUFS |
| led | LED | giữ khung | h264 40M | giữ nguyên | Đúng kích thước pixel màn hình mall (truyền width/height), H.264 40 Mbps, không tiếng trừ khi brief yêu cầu |
| review | Bản review | cao 720 | h264 5M | -14 LUFS | Cao 720 px, 5 Mbps, watermark 'BẢN REVIEW' và timecode để khách góp ý theo giây |
| master | Master ProRes 422 HQ | giữ khung | prores_hq | giữ nguyên | ProRes 422 HQ, PCM 24-bit 48 kHz, giữ nguyên mix |
| png_alpha | PNG sequence alpha | giữ khung | png | giữ nguyên | Chuỗi PNG RGBA trong một thư mục, cho overlay |

- Bản dọc/vuông: xuất từ sequence 9x16/1x1 (`create_aspect_versions`) hoặc comp đúng tỉ lệ; khác tỉ lệ thì bị letterbox.
- Âm lượng: đo trước một lượt. Mix đã hoàn chỉnh được chỉnh tuyến tính đúng mục tiêu; tiếng thô hoặc độ động lớn được nén nhẹ rồi chuẩn hoá (đạt khoảng -15 LUFS với tiếng hiện trường chưa mix), đỉnh dưới -1 dBTP.
- LED: truyền width/height đúng pixel màn hình của mall.
