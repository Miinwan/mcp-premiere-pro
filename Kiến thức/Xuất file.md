# Xuất file — preset từng nền tảng, đặt tên, âm lượng, cách gọi

Cập nhật 23/10/2026 (setting anh Quang chốt). After Effects: `ae_do render.export { comp, presets, client, title }` (+ `render.export_status`). Premiere: `export_deliverables { sequenceName, presets, client, title }` (+ `export_status`); master ProRes 422 HQ qua Adobe Media Encoder nên Premiere vẫn dùng được trong lúc xuất. Tên file: `<Khách> <Tên video> <Tỉ lệ> V<n>` (tự lấy số V kế tiếp), nhật ký `Kết quả xuất.md` trong thư mục xuất (mặc định `<thư mục project>/Xuất file`), mỗi dòng ghi bitrate đã dùng.

| Preset | Tên | Khung | Codec | Âm lượng | Ghi chú |
|---|---|---|---|---|---|
| youtube_4k | YouTube 4K | 3840x2160 | H.264 VBR 20 Mbps | -14 LUFS | LUT QT Gamma, ≤ 1 GB |
| youtube_1080 | YouTube 1080 | 1920x1080 | H.264 VBR 50 Mbps | -14 LUFS | LUT QT Gamma, ≤ 1 GB |
| reels | Reels / TikTok | 1080x1920 | H.264 VBR 50 Mbps | -14 LUFS | LUT QT Gamma, ≤ 1 GB; chữ trong vùng an toàn (trừ 250 px trên, 420 px dưới) |
| feed_4x5 | Feed 4:5 | 1080x1350 | H.264 VBR 50 Mbps | -14 LUFS | LUT QT Gamma, ≤ 1 GB |
| square | Vuông 1:1 | 1080x1080 | H.264 VBR 50 Mbps | -14 LUFS | LUT QT Gamma, ≤ 1 GB |
| led | LED | width/height màn hình | H.264 VBR theo khung | không tiếng | LUT QT Gamma, ≤ 1 GB; đúng pixel màn hình mall |
| review | Bản review | cao 720 | H.264 5 Mbps | -14 LUFS | LUT QT Gamma; watermark 'BẢN REVIEW' và timecode để khách góp ý theo giây |
| master | Master ProRes 422 HQ | giữ khung | ProRes 422 HQ | giữ nguyên | PCM 24-bit 48 kHz, không LUT |
| png_alpha | PNG sequence alpha | giữ khung | PNG RGBA | không tiếng | Cho overlay, không LUT |

## Setting H.264 anh chốt (theo preset AME của anh)

- H.264 High, `.mp4`, fps theo nguồn, progressive, square pixel (`setsar=1`), BT.709 tv range, AAC 320k 48 kHz.
- Render at Maximum Depth + Use Maximum Render Quality: ffmpeg xử lý trong RGB 16-bit (`format=gbrp16le`), scale lanczos với `accurate_rnd+full_chroma_int`, chỉ về YUV 4:2:0 một lần ở cuối.
- Bitrate VBR 1 pass (`-b:v`, peak `-maxrate` = 1.5 lần): khung Full HD (đến 2560x1440) 50 Mbps; khung 4K (lớn hơn 2560x1440) 20 Mbps. Anh ghi đúng 4K 20 Mbps (thấp hơn Full HD) — giữ nguyên theo anh, không tự "sửa".
- File ≤ 1 GB (1.000.000.000 byte): video dài thì tự hạ bitrate = 1 GB × 0,97 ÷ thời lượng − 320k audio. Full HD 50 Mbps chạm trần ở khoảng 150 giây, 4K 20 Mbps ở khoảng 380 giây. Hàm `bitrateFor(width, height, durationSec)` trong `deliverables.ts`.
- Màu: mọi bản H.264 áp LUT "QT Gamma Compensation" (Adobe, 1D, hạ gamma từ 2.4 về 1.96) trước khi resize, để xem trên QuickTime/YouTube/trình duyệt đúng màu như trong Premiere/AE (không áp sẽ bị nhạt). File gốc `/Users/minwan/Desktop/01. Personal/Resources/QT Gamma Compensation.cube`, không sửa/di chuyển; đổi chỗ thì đặt env `MCP_QT_GAMMA_LUT`. Thiếu file thì bản H.264 báo lỗi rõ, không xuất thiếu LUT. Không áp cho master ProRes và PNG alpha (master là bản gốc để làm tiếp). Không đặt LUT này lên adjustment layer trong timeline.

## Vì sao ffmpeg, không dùng preset .epr của AME

- Đã chọn ffmpeg cho mọi bản H.264, master ProRes vẫn qua AME. Lý do: trần 1 GB phải tính bitrate theo thời lượng từng video, preset `.epr` cố định một bitrate; LUT, khung, âm lượng -14 LUFS và đặt tên đều nằm chung một chỗ, AE và Premiere dùng y hệt nhau; chạy nền không chiếm AME.
- Đã kiểm thật 23/10/2026 trên master FSI 1x1 (ProRes 1080x1080, 23.976): đoạn 10 giây ra 50,2 Mbps, High, progressive, SAR 1:1, BT.709; cả bản 272,8 giây tự hạ còn 28,1 Mbps, đo được 28,7 Mbps, file 988,7 MB (x264 vượt mục tiêu khoảng 2%, biên 3% đủ). Sau LUT, độ sáng trung bình frame giảm từ 60 xuống 49 (trên thang 255) khi đọc bằng ffmpeg — đúng ý LUT: QuickTime/trình duyệt hiển thị sáng lại thành màu như trong Premiere/AE. Nếu cần xuất thẳng bằng AME thì tạo preset tay theo đúng các dòng trên + Lumetri Look "QT Gamma Compensation".

## Khác

- Bản dọc/vuông: xuất từ sequence 9x16/1x1 (`create_aspect_versions`) hoặc comp đúng tỉ lệ; khác tỉ lệ thì bị letterbox.
- Âm lượng: đo trước một lượt. Mix đã hoàn chỉnh được chỉnh tuyến tính đúng mục tiêu; tiếng thô hoặc độ động lớn được nén nhẹ rồi chuẩn hoá (đạt khoảng -15 LUFS với tiếng hiện trường chưa mix), đỉnh dưới -1 dBTP.
- LED: truyền width/height đúng pixel màn hình của mall.
