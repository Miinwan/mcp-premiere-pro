# Exports — per-platform presets, naming, loudness, how to call

Updated 2026-10-23 (the project's fixed settings). After Effects: `ae_do render.export { comp, presets, client, title }` (+ `render.export_status`). Premiere: `export_deliverables { sequenceName, presets, client, title }` (+ `export_status`); the ProRes 422 HQ master goes through Adobe Media Encoder, so Premiere stays usable while exporting. File name: `<Client> <Video name> <Aspect> V<n>` (the next free V number is picked automatically); a log `Kết quả xuất.md` is kept in the export folder (default `<project folder>/Xuất file`), one line per file with the bitrate used.

| Preset | Name | Frame | Codec | Loudness | Notes |
|---|---|---|---|---|---|
| youtube_4k | YouTube 4K | 3840x2160 | H.264 VBR 20 Mbps | -14 LUFS | QT Gamma LUT, ≤ 1 GB |
| youtube_1080 | YouTube 1080 | 1920x1080 | H.264 VBR 50 Mbps | -14 LUFS | QT Gamma LUT, ≤ 1 GB |
| reels | Reels / TikTok | 1080x1920 | H.264 VBR 50 Mbps | -14 LUFS | QT Gamma LUT, ≤ 1 GB; keep text in the safe area (250 px top, 420 px bottom) |
| feed_4x5 | Feed 4:5 | 1080x1350 | H.264 VBR 50 Mbps | -14 LUFS | QT Gamma LUT, ≤ 1 GB |
| square | Square 1:1 | 1080x1080 | H.264 VBR 50 Mbps | -14 LUFS | QT Gamma LUT, ≤ 1 GB |
| led | LED | screen width/height | H.264 VBR by frame size | no audio | QT Gamma LUT, ≤ 1 GB; exact pixel size of the venue screen |
| review | Review copy | 720 high | H.264 5 Mbps | -14 LUFS | QT Gamma LUT; 'BẢN REVIEW' watermark and timecode so the client can comment by the second |
| master | Master ProRes 422 HQ | source frame | ProRes 422 HQ | unchanged | PCM 24-bit 48 kHz, no LUT |
| png_alpha | PNG sequence with alpha | source frame | PNG RGBA | no audio | For overlays, no LUT |

## Fixed H.264 settings (matching the owner's Media Encoder preset)

- H.264 High, `.mp4`, source frame rate, progressive, square pixels (`setsar=1`), BT.709 TV range, AAC 320k 48 kHz.
- Render at Maximum Depth + Use Maximum Render Quality: ffmpeg works in 16-bit RGB (`format=gbrp16le`), lanczos scaling with `accurate_rnd+full_chroma_int`, and converts to YUV 4:2:0 only once at the end.
- 1-pass VBR (`-b:v`, peak `-maxrate` = 1.5×): Full HD frames (up to 2560x1440) 50 Mbps; 4K frames (above 2560x1440) 20 Mbps. 4K at 20 Mbps (lower than Full HD) is intentional — keep it, do not "fix" it.
- Files ≤ 1 GB (1,000,000,000 bytes): long videos get a lower bitrate = 1 GB × 0.97 ÷ duration − 320k audio. Full HD at 50 Mbps hits the cap at about 150 s, 4K at 20 Mbps at about 380 s. See `bitrateFor(width, height, durationSec)` in `deliverables.ts`.
- Colour: every H.264 file gets Adobe's "QT Gamma Compensation" LUT (1D, gamma 2.4 → 1.96) before resizing, so QuickTime, YouTube and browsers show the same colour as Premiere/AE (without it the picture looks washed out). The default `.cube` location is set in `deliverables.ts`; override it with the `MCP_QT_GAMMA_LUT` environment variable and do not move or edit the file. A missing file is a clear error for H.264 deliverables; nothing is exported without the LUT. Not applied to the ProRes master or PNG alpha (the master is the source for further work). Never put this LUT on an adjustment layer in the timeline.

## Why ffmpeg rather than a Media Encoder .epr preset

- ffmpeg handles every H.264 deliverable; the ProRes master still goes through AME. Reasons: the 1 GB cap means the bitrate depends on each video's length, while an `.epr` preset has one fixed bitrate; LUT, frame, -14 LUFS loudness and naming live in one place, identical for AE and Premiere; it runs in the background without tying up AME.
- Tested 2026-10-23 on a real 1x1 client master (ProRes 1080x1080, 23.976): a 10-second excerpt came out at 50.2 Mbps, High, progressive, SAR 1:1, BT.709; the full 272.8-second piece dropped automatically to 28.1 Mbps, measured 28.7 Mbps, 988.7 MB (x264 overshoots the target by about 2 %, the 3 % margin is enough). After the LUT the average frame brightness drops from 60 to 49 (out of 255) when read by ffmpeg — as intended: QuickTime and browsers brighten it back to the Premiere/AE look. To export straight from AME instead, build a preset by hand with exactly the settings above plus the Lumetri Look "QT Gamma Compensation".

## Other

- Vertical/square: export from the 9x16/1x1 sequences (`create_aspect_versions`) or a comp with the right aspect; any other aspect is letterboxed.
- Loudness: measured first. A finished mix is adjusted linearly to the target; raw or very dynamic audio is lightly compressed then normalised (about -15 LUFS for unmixed location sound), peaks below -1 dBTP.
- LED: pass width/height equal to the screen's exact pixel size.
