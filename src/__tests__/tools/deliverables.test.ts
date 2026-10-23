import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { bitrateFor, deliverableName, ffmpegArgs, loadLut, loudnessFilter, lutFilter, MAX_FILE_BYTES, PRESETS } from "../../tools/deliverables.js";

const LUT = { file: "/luts/QT Gamma Compensation.cube", is3d: false };

describe("deliverables", () => {
  it("names files <Khách> <Tên> <Tỉ lệ> V<n> with the next free version", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "xuat-"));
    expect(deliverableName(dir, "Studio", "Workshop week 3", "9x16", ".mp4")).toBe("Studio Workshop week 3 9x16 V1.mp4");
    writeFileSync(path.join(dir, "Studio Workshop week 3 9x16 V1.mp4"), "");
    expect(deliverableName(dir, "Studio", "Workshop week 3", "9x16", ".mp4")).toBe("Studio Workshop week 3 9x16 V2.mp4");
    expect(deliverableName(dir, "A/B", "x", "1x1", ".mp4", 4)).toBe("A B x 1x1 V4.mp4");
  });

  it("reels: 1080x1920, H.264 VBR 50 Mbps, LUT, -14 LUFS", () => {
    const a = ffmpegArgs(PRESETS.reels!, "in.mov", "out.mp4", { lut: LUT }).join(" ");
    expect(a).toContain("scale=1080:1920");
    expect(a).toContain("-b:v 50000k -maxrate 75000k");
    expect(a).toContain("lut1d=file='/luts/QT Gamma Compensation.cube'");
    expect(a).toContain("loudnorm=I=-14");
    expect(a).toContain("+faststart");
    expect(a).toContain("setsar=1");
    expect(a).toContain("-colorspace bt709");
  });

  it("H.264 is processed in 16-bit RGB with the LUT before resizing and 4:2:0 last", () => {
    const vf = ffmpegArgs(PRESETS.youtube_4k!, "in.mov", "out.mp4", { lut: LUT, kbps: 20_000 });
    const chain = vf[vf.indexOf("-vf") + 1]!;
    const order = ["format=gbrp16le", "lut1d", "scale=3840:2160", "format=yuv420p"].map((k) => chain.indexOf(k));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
    expect(chain).toContain("accurate_rnd+full_chroma_int");
    expect(vf.join(" ")).toContain("-b:v 20000k");
    expect(lutFilter("/a/b.cube", true)).toBe("lut3d=file='/a/b.cube'");
  });

  it("master keeps size and mix, ProRes HQ + PCM, no LUT", () => {
    const a = ffmpegArgs(PRESETS.master!, "in.mov", "out.mov", { lut: LUT }).join(" ");
    expect(a).not.toContain("scale=");
    expect(a).not.toContain("loudnorm");
    expect(a).not.toContain("lut1d");
    expect(a).toContain("prores_ks -profile:v 3");
    expect(a).toContain("pcm_s24le");
    expect(ffmpegArgs(PRESETS.png_alpha!, "in.mov", "f_%05d.png", { lut: LUT }).join(" ")).not.toContain("lut");
  });

  it("review burns a watermark and timecode; led takes the screen size, no audio", () => {
    const review = ffmpegArgs(PRESETS.review!, "i", "o.mp4", { lut: LUT }).join(" ");
    expect(review).toMatch(/drawtext.*BẢN REVIEW.*pts/);
    expect(review).toContain("-b:v 5000k");
    const led = ffmpegArgs(PRESETS.led!, "i", "o.mp4", { width: 1664, height: 672 }).join(" ");
    expect(led).toContain("scale=1664:672");
    expect(led).toContain("-an");
  });

  it("loadLut reports a missing file and reads 1D/3D from the header", () => {
    expect(loadLut("/khong/co/file.cube")).toMatchObject({ error: expect.stringContaining("MCP_QT_GAMMA_LUT") });
    const dir = mkdtempSync(path.join(os.tmpdir(), "lut-"));
    writeFileSync(path.join(dir, "a.cube"), "TITLE x\nLUT_3D_SIZE 2\n");
    writeFileSync(path.join(dir, "b.cube"), "TITLE x\nLUT_1D_SIZE 1024\n");
    expect(loadLut(path.join(dir, "a.cube"))).toEqual({ file: path.join(dir, "a.cube"), is3d: true });
    expect(loadLut(path.join(dir, "b.cube"))).toEqual({ file: path.join(dir, "b.cube"), is3d: false });
  });
});

describe("bitrateFor", () => {
  it("Full HD class 50 Mbps, 4K class 20 Mbps (owner's AME setting)", () => {
    expect(bitrateFor(1920, 1080, 60)).toEqual({ kbps: 50_000, maxKbps: 75_000, capped: false });
    expect(bitrateFor(1080, 1920, 60).kbps).toBe(50_000);
    expect(bitrateFor(1080, 1080, 60).kbps).toBe(50_000);
    expect(bitrateFor(3840, 2160, 60).kbps).toBe(20_000);
    expect(bitrateFor(4096, 2160, 60).kbps).toBe(20_000);
  });

  it("long video is lowered so the file stays under 1 GB", () => {
    // 50 Mbps fits ~150 s; 10 minutes must come down.
    const r = bitrateFor(1920, 1080, 600);
    expect(r.capped).toBe(true);
    expect(((r.kbps + 320) * 1000 * 600) / 8).toBeLessThanOrEqual(MAX_FILE_BYTES * 0.97);
    expect(r.kbps).toBe(12_613); // 1 GB x 0.97 over 600 s = 12.93 Mbps, minus 320k audio
    // 4K at 20 Mbps fits ~380 s.
    expect(bitrateFor(3840, 2160, 300).capped).toBe(false);
    expect(bitrateFor(3840, 2160, 3600).kbps).toBeLessThan(2_000);
  });

  it("no audio leaves more room; unknown duration keeps the base rate; fixed kbps is still capped", () => {
    expect(bitrateFor(1920, 1080, 600, { audioKbps: 0 }).kbps).toBe(bitrateFor(1920, 1080, 600).kbps + 320);
    expect(bitrateFor(1920, 1080, 0)).toMatchObject({ kbps: 50_000, capped: false });
    expect(bitrateFor(1280, 720, 60, { kbps: 5000 }).kbps).toBe(5000);
    expect(bitrateFor(1280, 720, 4 * 3600, { kbps: 5000 }).capped).toBe(true);
  });
});

describe("loudness", () => {
  const m = (i: string, lra: string) => ({ input_i: i, input_tp: "-3", input_lra: lra, input_thresh: "-30", target_offset: "0.2" });
  it("finished mix: exact linear second pass", () => {
    expect(loudnessFilter(-14, m("-16.5", "7"))).toMatch(/linear=true/);
  });
  it("raw dialogue: compress first, then normalise", () => {
    const f = loudnessFilter(-14, m("-28.41", "16.5"));
    expect(f).toMatch(/^acompressor=threshold=-30dB/);
    expect(f).toContain("loudnorm=I=-14");
  });
  it("unmeasured: one-pass loudnorm", () => {
    expect(loudnessFilter(-14, null)).toBe("loudnorm=I=-14:TP=-1:LRA=11");
  });
});
