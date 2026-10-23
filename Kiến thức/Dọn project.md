# Dọn project sau bàn giao — Use when anh wants to slim a finished job: remove unused media from the Premiere project and move unused files (with their proxies) to the Trash.

Quy trình anh chốt 23/10/2026: không tạo bản copy (Project Manager hay lỗi). Review cái gì không dùng, xoá khỏi project, đưa file thừa vào Trash; anh tự xem Trash rồi xoá. Chỉ giữ file đang dùng để khách cần sửa; file gốc anh đã lưu trên Drive.

1. `review_unused_media { keepSequences? }`: chỉ đọc. Mức dùng tính theo timeline (cả nested sequence, multicam). Không truyền `keepSequences` thì mọi sequence được giữ; truyền tên các sequence bàn giao thì sequence khác cũng vào danh sách xoá. Kết quả là báo cáo JSON trong `~/Library/Application Support/MCP Adobe/Don dep/`, kèm tóm tắt: số item xoá khỏi project, số file vào Trash, dung lượng giải phóng, 20 file lớn nhất.
2. Đưa danh sách cho anh xem. Anh đồng ý thì chạy `clean_unused_media { report, confirm: true }`: lưu checkpoint project, kiểm tra lại mức dùng (cái gì vừa được dùng thì bỏ qua), xoá item khỏi project (cả bin rỗng do dọn), lưu project, rồi Finder chuyển file vào Trash (Put Back được).

Vào Trash:
- File đã import nhưng không có trên timeline nào, kèm proxy của nó (proxy đang gắn, hoặc trong thư mục `Proxies` cạnh nguồn).
- File media nằm trong thư mục nguồn (và `Proxies`) mà chưa bao giờ dùng, kể cả âm thanh, ảnh, PSD, SRT.

Luôn giữ:
- File đang dùng và proxy của nó (trừ khi `trashProxiesOfUsed: true`).
- Thư mục bàn giao/render: Edited, Export, Xuất file, Render, Output, Final, Bàn giao.
- File không phải media, project .prproj/.aep, phần còn lại của image sequence đang dùng.

Lưu ý: file trong thư mục nguồn có thể đang dùng ở project khác; xem danh sách trước khi dọn. Lần đầu macOS hỏi quyền cho phép điều khiển Finder; nếu bị chặn, mở System Settings → Privacy & Security → Automation. After Effects có op tương ứng (`project.review_unused`, `project.clean_unused`), cùng định dạng báo cáo.
