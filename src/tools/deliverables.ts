// Platform deliverables from one master file: the preset table, ffmpeg
// arguments, file naming and the export log. Pure apart from encode(), which
// runs ffmpeg. The same file lives in the After Effects MCP;
// keep the two identical (After Effects: src/deliverables.ts).

import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";

export interface DeliverablePreset {
  id: string;
  label: string;
  /** Frame; null keeps the master's size (masters, PNG). */
  width: number | null;
  height: number | null;
  /** Aspect tag used in the file name. */
  aspect: string;
  codec: "h264" | "prores_hq" | "png";
  /** Fixed target (kbps) instead of bitrateFor()'s size class; still capped to 1 GB. */
  kbps?: number;
  audio: "aac" | "pcm" | "none";
  /** Integrated loudness target (LUFS); null leaves the mix as it is. */
  lufs: number | null;
  watermark?: boolean;
  note: string;
}

export const PRESETS: Record<string, DeliverablePreset> = {
  youtube_4k: { id: "youtube_4k", label: "YouTube 4K", width: 3840, height: 2160, aspect: "16x9", codec: "h264", audio: "aac", lufs: -14, note: "H.264 High VBR 1 pass 20 Mbps (≤ 1 GB), LUT QT Gamma, AAC 320k, -14 LUFS (YouTube chuẩn hoá về -14)" },
  youtube_1080: { id: "youtube_1080", label: "YouTube 1080", width: 1920, height: 1080, aspect: "16x9", codec: "h264", audio: "aac", lufs: -14, note: "H.264 High VBR 1 pass 50 Mbps (≤ 1 GB), LUT QT Gamma, AAC 320k, -14 LUFS" },
  reels: { id: "reels", label: "Reels / TikTok", width: 1080, height: 1920, aspect: "9x16", codec: "h264", audio: "aac", lufs: -14, note: "1080x1920 H.264 VBR 1 pass 50 Mbps (≤ 1 GB), LUT QT Gamma, AAC 320k, -14 LUFS; chữ trong vùng an toàn (trừ 250 px trên, 420 px dưới)" },
  feed_4x5: { id: "feed_4x5", label: "Feed 4:5", width: 1080, height: 1350, aspect: "4x5", codec: "h264", audio: "aac", lufs: -14, note: "1080x1350 H.264 VBR 1 pass 50 Mbps (≤ 1 GB), LUT QT Gamma, AAC 320k, -14 LUFS" },
  square: { id: "square", label: "Vuông 1:1", width: 1080, height: 1080, aspect: "1x1", codec: "h264", audio: "aac", lufs: -14, note: "1080x1080 H.264 VBR 1 pass 50 Mbps (≤ 1 GB), LUT QT Gamma, AAC 320k, -14 LUFS" },
  led: { id: "led", label: "LED", width: null, height: null, aspect: "LED", codec: "h264", audio: "none", lufs: null, note: "Đúng kích thước pixel màn hình mall (truyền width/height), H.264 VBR 1 pass theo khung (≤ 1 GB), LUT QT Gamma, không tiếng trừ khi brief yêu cầu" },
  review: { id: "review", label: "Bản review", width: null, height: 720, aspect: "review", codec: "h264", kbps: 5000, audio: "aac", lufs: -14, watermark: true, note: "Cao 720 px, 5 Mbps, LUT QT Gamma, watermark 'BẢN REVIEW' và timecode để khách góp ý theo giây" },
  master: { id: "master", label: "Master ProRes 422 HQ", width: null, height: null, aspect: "Master", codec: "prores_hq", audio: "pcm", lufs: null, note: "ProRes 422 HQ, PCM 24-bit 48 kHz, giữ nguyên mix, không LUT" },
  png_alpha: { id: "png_alpha", label: "PNG sequence alpha", width: null, height: null, aspect: "PNG", codec: "png", audio: "none", lufs: null, note: "Chuỗi PNG RGBA trong một thư mục, cho overlay, không LUT" },
};

/** Largest H.264 deliverable: 1 GB (decimal, as Finder and upload forms count it). */
export const MAX_FILE_BYTES = 1_000_000_000;

/**
 * VBR 1-pass video bitrate (kbps) for a frame size, as set in the owner's AME preset:
 * Full HD class 50 Mbps, 4K class (more pixels than 2560x1440) 20 Mbps. A long
 * video is brought down so video + audio stay under 1 GB with a 3% margin for
 * the container and rate-control overshoot. Pure, for tests.
 */
export function bitrateFor(width: number, height: number, durationSec: number, opts: { audioKbps?: number; kbps?: number | undefined } = {}): { kbps: number; maxKbps: number; capped: boolean } {
  const base = opts.kbps ?? (width * height > 2560 * 1440 ? 20_000 : 50_000);
  let kbps = base;
  if (durationSec > 0 && Number.isFinite(durationSec)) {
    const budget = Math.floor((MAX_FILE_BYTES * 8 * 0.97) / durationSec / 1000 - (opts.audioKbps ?? 320));
    kbps = Math.max(100, Math.min(base, budget));
  }
  return { kbps, maxKbps: Math.round(kbps * 1.5), capped: kbps < base };
}

/** Adobe's QT Gamma Compensation LUT (env MCP_QT_GAMMA_LUT overrides the path). */
export function qtGammaLutPath(): string {
  return process.env.MCP_QT_GAMMA_LUT || "/Users/minwan/Desktop/01. Personal/Resources/QT Gamma Compensation.cube";
}

export function ffmpegPath(): string {
  for (const p of [process.env.FFMPEG_PATH, "/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", path.join(homedir(), ".local/bin/ffmpeg")]) {
    if (p && existsSync(p)) return p;
  }
  return "ffmpeg";
}

/** `<Khách> <Tên video> <Tỉ lệ> V<n>` with the first free version number. */
export function deliverableName(dir: string, client: string, title: string, aspect: string, ext: string, version?: number): string {
  const clean = (s: string) => s.replace(/[\\/:*?"<>|]/g, " ").replace(/\s+/g, " ").trim();
  const stem = [clean(client), clean(title), aspect].filter(Boolean).join(" ");
  if (version) return `${stem} V${version}${ext}`;
  const taken = existsSync(dir) ? readdirSync(dir) : [];
  for (let v = 1; v < 1000; v++) {
    const name = `${stem} V${v}${ext}`;
    if (!taken.includes(name) && !taken.includes(`${stem} V${v}`)) return name;
  }
  return `${stem} V999${ext}`;
}

/**
 * Audio filter that lands a mix on `target` LUFS with peaks under -1 dBTP.
 * A finished mix (small gain, normal range) gets loudnorm's exact linear
 * second pass; raw or very dynamic sound (unmixed dialogue, -28 LUFS with a
 * 16 LU range) first goes through gentle compression, otherwise any limiter
 * pulls it back 3–4 LU short. Pure, for tests.
 */
export function loudnessFilter(target: number, m: Loudness | null): string {
  if (!m || !Number.isFinite(Number(m.input_i))) return `loudnorm=I=${target}:TP=-1:LRA=11`;
  const inI = Number(m.input_i);
  const gain = target - inI;
  const lra = Number(m.input_lra);
  if (gain <= 6 && lra <= 11) {
    return `loudnorm=I=${target}:TP=-1:LRA=11:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`;
  }
  const threshold = Math.round(inI - 2);
  const makeup = Math.min(12, Math.max(2, Math.round(gain / 2)));
  return `acompressor=threshold=${threshold}dB:ratio=3:attack=10:release=250:makeup=${makeup}dB,loudnorm=I=${target}:TP=-1:LRA=11`;
}

export interface Loudness { input_i: string; input_tp: string; input_lra: string; input_thresh: string; target_offset: string }

/** ffmpeg filter that applies a .cube LUT (1D or 3D, from the file header). */
export function lutFilter(file: string, is3d: boolean): string {
  if (/[':\\]/.test(file)) throw new Error(`LUT path cannot contain ' : or \\ (ffmpeg filter syntax): ${file}`);
  return `${is3d ? "lut3d" : "lut1d"}=file='${file}'`;
}

/** Highest-quality scaler, the "Maximum Render Quality" of Premiere/AE. */
const HQ = "flags=lanczos+accurate_rnd+full_chroma_int";

/**
 * ffmpeg arguments for one preset. `measured` (first loudnorm pass) makes the
 * gain exact; `kbps` comes from bitrateFor(); `lut` is the colour LUT applied to
 * every H.264 file ({ file, is3d }, null for none). Pure, for tests.
 */
export function ffmpegArgs(p: DeliverablePreset, input: string, output: string, opts: { width?: number; height?: number; watermark?: string; font?: string; measured?: Loudness | null; kbps?: number | undefined; lut?: { file: string; is3d: boolean } | null } = {}): string[] {
  const w = opts.width ?? p.width;
  const h = opts.height ?? p.height;
  const h264 = p.codec === "h264";
  const vf: string[] = [];
  // H.264 is graded in 16-bit RGB ("Render at Maximum Depth"): BT.709 in, LUT,
  // resize, back to BT.709 4:2:0 once at the end.
  if (h264) vf.push(`scale=in_color_matrix=bt709:in_range=tv:${HQ}`, "format=gbrp16le");
  if (h264 && opts.lut) vf.push(lutFilter(opts.lut.file, opts.lut.is3d));
  const flags = h264 ? HQ : "flags=lanczos";
  if (w && h) vf.push(`scale=${w}:${h}:force_original_aspect_ratio=decrease:${flags}`, `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black`);
  else if (h) vf.push(`scale=-2:${h}:${flags}`);
  if (h264) vf.push("setsar=1", `scale=out_color_matrix=bt709:out_range=tv:${HQ}`, "format=yuv420p");
  if (p.watermark) {
    const font = opts.font ?? "/System/Library/Fonts/Supplemental/Arial Unicode.ttf";
    const text = (opts.watermark ?? "BẢN REVIEW").replace(/[:'\\]/g, " ");
    vf.push(`drawtext=fontfile='${font}':text='${text}':fontcolor=white@0.35:fontsize=min(w\\,h)/9:x=(w-tw)/2:y=(h-th)/2`);
    vf.push(`drawtext=fontfile='${font}':text='%{pts\\:hms}':fontcolor=white@0.8:fontsize=min(w\\,h)/22:x=w-tw-20:y=h-th-20:box=1:boxcolor=black@0.4`);
  }
  const a = ["-y", "-hide_banner", "-loglevel", "error", "-i", input];
  if (p.codec === "png") return [...a, "-map", "0:v:0", ...(vf.length ? ["-vf", vf.join(",")] : []), "-pix_fmt", "rgba", output];
  // Video and audio only: AE markers come through as a chapter/data track.
  a.push("-map", "0:v:0", "-map", "0:a?", "-dn", "-map_chapters", "-1");
  if (vf.length) a.push("-vf", vf.join(","));
  if (h264) {
    // VBR 1 pass: average `kbps`, peaks to 1.5x. Frame rate and size follow the source / preset.
    const kbps = opts.kbps ?? p.kbps ?? bitrateFor(w ?? 1920, h ?? 1080, 0).kbps;
    const max = Math.round(kbps * 1.5);
    a.push("-c:v", "libx264", "-profile:v", "high", "-pix_fmt", "yuv420p", "-preset", "slow", "-b:v", `${kbps}k`, "-maxrate", `${max}k`, "-bufsize", `${max}k`, "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv", "-movflags", "+faststart", "-write_tmcd", "0");
  }
  if (p.codec === "prores_hq") a.push("-c:v", "prores_ks", "-profile:v", "3", "-vendor", "apl0", "-pix_fmt", "yuv422p10le");
  if (p.audio === "none") a.push("-an");
  else {
    if (p.lufs !== null) {
      const m = opts.measured;
      a.push("-af", loudnessFilter(p.lufs, m ?? null), "-ar", "48000");
    }
    if (p.audio === "aac") a.push("-c:a", "aac", "-b:a", "320k");
    else a.push("-c:a", "pcm_s24le", "-ar", "48000");
  }
  a.push(output);
  return a;
}

function run(bin: string, args: string[]): Promise<{ code: number; err: string }> {
  return new Promise((resolve) => {
    const c = spawn(bin, args);
    let err = "";
    c.stderr.on("data", (d) => (err += d.toString()));
    c.on("close", (code) => resolve({ code: code ?? -1, err }));
    c.on("error", (e) => resolve({ code: -1, err: String(e) }));
  });
}

/** First loudnorm pass: what the mix measures against `target`, or null (no audio). */
export async function measureForLoudnorm(file: string, target: number): Promise<Loudness | null> {
  const r = await run(ffmpegPath(), ["-hide_banner", "-nostats", "-i", file, "-vn", "-af", `loudnorm=I=${target}:TP=-1:LRA=11:print_format=json`, "-f", "null", "-"]);
  const j = /\{[^{}]*"input_i"[^{}]*\}/.exec(r.err);
  if (!j) return null;
  try {
    return JSON.parse(j[0]) as Loudness;
  } catch {
    return null;
  }
}

/** Integrated loudness of a file (LUFS), or null. */
export async function measureLufs(file: string): Promise<number | null> {
  const r = await run(ffmpegPath(), ["-hide_banner", "-nostats", "-i", file, "-filter_complex", "ebur128", "-f", "null", "-"]);
  const m = /I:\s*(-?\d+(?:\.\d+)?) LUFS/.exec(r.err.split("Summary:").pop() ?? "");
  return m ? Number(m[1]) : null;
}

export function ffprobePath(): string {
  const ff = ffmpegPath();
  const probe = path.join(path.dirname(ff), "ffprobe");
  return ff !== "ffmpeg" && existsSync(probe) ? probe : "ffprobe";
}

/** Width, height and duration (s) of a file's first video stream; zeros when unreadable. */
export async function probeVideo(file: string): Promise<{ width: number; height: number; duration: number }> {
  const out = await new Promise<string>((resolve) => {
    const c = spawn(ffprobePath(), ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:format=duration", "-of", "json", file]);
    let o = "";
    c.stdout.on("data", (d) => (o += d.toString()));
    c.on("close", () => resolve(o));
    c.on("error", () => resolve(""));
  });
  try {
    const j = JSON.parse(out) as { streams?: { width?: number; height?: number }[]; format?: { duration?: string } };
    return { width: j.streams?.[0]?.width ?? 0, height: j.streams?.[0]?.height ?? 0, duration: Number(j.format?.duration) || 0 };
  } catch {
    return { width: 0, height: 0, duration: 0 };
  }
}

/** The QT Gamma LUT and whether it is 3D, or an error when the file is missing. */
export function loadLut(file = qtGammaLutPath()): { file: string; is3d: boolean } | { error: string } {
  if (!existsSync(file)) return { error: `QT Gamma Compensation LUT not found at ${file}; set MCP_QT_GAMMA_LUT to the .cube file` };
  if (/[':\\]/.test(file)) return { error: `LUT path cannot contain ' : or \\ (ffmpeg filter syntax): ${file}` };
  const head = readFileSync(file, "utf8").slice(0, 4096);
  return { file, is3d: /^\s*LUT_3D_SIZE/m.test(head) };
}

export interface DeliverableResult {
  preset: string;
  ok: boolean;
  file?: string;
  error?: string;
  lufs?: number | null;
  seconds?: number;
  /** H.264 only: video bitrate used and whether the 1 GB cap lowered it. */
  kbps?: number;
  capped?: boolean;
}

/** Encode one deliverable from `master` into `dir` and log it in `dir/Kết quả xuất.md`. */
export async function encode(master: string, dir: string, presetId: string, naming: { client: string; title: string; version?: number }, opts: { width?: number; height?: number; watermark?: string } = {}): Promise<DeliverableResult> {
  const p = PRESETS[presetId];
  if (!p) return { preset: presetId, ok: false, error: `unknown preset ${presetId}. Known: ${Object.keys(PRESETS).join(", ")}` };
  if (p.id === "led" && !(opts.width && opts.height)) return { preset: presetId, ok: false, error: "led needs width and height (the screen's pixels)" };
  mkdirSync(dir, { recursive: true });
  const aspect = p.id === "led" ? `LED ${opts.width}x${opts.height}` : p.aspect;
  const ext = p.codec === "h264" ? ".mp4" : p.codec === "prores_hq" ? ".mov" : "";
  const name = deliverableName(dir, naming.client, naming.title, aspect, ext, naming.version);
  let out = path.join(dir, name);
  if (p.codec === "png") {
    mkdirSync(out, { recursive: true });
    out = path.join(out, "frame_%05d.png");
  }
  let rate: { kbps: number; capped: boolean } | undefined;
  let lut: { file: string; is3d: boolean } | null = null;
  if (p.codec === "h264") {
    const l = loadLut();
    if ("error" in l) return { preset: presetId, ok: false, error: l.error };
    lut = l;
    const src = await probeVideo(master);
    const w = opts.width ?? p.width ?? (p.height && src.height ? Math.round((src.width * p.height) / src.height) : src.width);
    const h = opts.height ?? p.height ?? src.height;
    rate = bitrateFor(w, h, src.duration, { audioKbps: p.audio === "none" ? 0 : 320, kbps: p.kbps });
  }
  const t0 = Date.now();
  const measured = p.lufs !== null && p.audio !== "none" ? await measureForLoudnorm(master, p.lufs) : null;
  const r = await run(ffmpegPath(), ffmpegArgs(p, master, out, { ...opts, measured, kbps: rate?.kbps, lut }));
  const seconds = Math.round((Date.now() - t0) / 100) / 10;
  if (r.code !== 0) return { preset: presetId, ok: false, error: r.err.slice(-600), seconds };
  const file = p.codec === "png" ? path.dirname(out) : out;
  const lufs = p.audio !== "none" && p.codec !== "png" ? await measureLufs(file) : null;
  const rateNote = rate ? ` · ${Math.round(rate.kbps / 100) / 10} Mbps${rate.capped ? " (hạ để ≤ 1 GB)" : ""}` : "";
  const line = `- ${new Date().toLocaleString("vi-VN")} · ${path.basename(file)} · ${p.label} · ${p.note}${rateNote}${lufs !== null ? ` · đo được ${lufs} LUFS` : ""} · ${seconds} s\n`;
  const log = path.join(dir, "Kết quả xuất.md");
  if (!existsSync(log)) appendFileSync(log, "# Kết quả xuất\n\n");
  appendFileSync(log, line);
  return { preset: presetId, ok: true, file, lufs, seconds, ...(rate ? { kbps: rate.kbps, capped: rate.capped } : {}) };
}

// ---------------------------------------------------------------- background jobs

export interface ExportJob {
  id: string;
  state: "waiting_master" | "encoding" | "done" | "failed";
  master: string;
  dir: string;
  presets: string[];
  results: DeliverableResult[];
  current: string | null;
  started: number;
  error?: string;
}
const jobs = new Map<string, ExportJob>();

/** Master size stable for `quietMs` (an encoder still writing it keeps growing). */
async function waitStable(file: string, timeoutMs: number, quietMs = 8000): Promise<boolean> {
  const { statSync } = await import("node:fs");
  const t0 = Date.now();
  let last = -1;
  let since = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    let size = -1;
    try {
      size = statSync(file).size;
    } catch {
      size = -1;
    }
    if (size > 0 && size === last) {
      if (Date.now() - since >= quietMs) return true;
    } else {
      last = size;
      since = Date.now();
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

/** Encode the deliverables in the background (optionally after the master finishes writing). */
export function startExportJob(master: string, dir: string, presets: string[], naming: { client: string; title: string; version?: number }, opts: { width?: number; height?: number; watermark?: string } = {}, waitForMaster = false): ExportJob {
  const job: ExportJob = { id: Math.random().toString(36).slice(2, 10), state: waitForMaster ? "waiting_master" : "encoding", master, dir, presets, results: [], current: null, started: Date.now() };
  jobs.set(job.id, job);
  void (async () => {
    if (waitForMaster && !(await waitStable(master, 4 * 3600_000))) {
      job.state = "failed";
      job.error = "the master never finished writing";
      return;
    }
    job.state = "encoding";
    for (const id of presets) {
      job.current = id;
      job.results.push(await encode(master, dir, id, naming, opts));
    }
    job.current = null;
    job.state = job.results.every((r) => r.ok) ? "done" : "failed";
  })();
  return job;
}

export function exportJob(id: string): ExportJob | undefined {
  return jobs.get(id);
}

export function exportJobView(j: ExportJob) {
  return { jobId: j.id, state: j.state, current: j.current, done: j.results, remaining: j.presets.slice(j.results.length), elapsedSec: Math.round((Date.now() - j.started) / 1000), folder: j.dir, log: path.join(j.dir, "Kết quả xuất.md"), ...(j.error ? { error: j.error } : {}) };
}

/** Wait up to `ms` for a job to finish, then report it. */
export async function waitJob(j: ExportJob, ms: number) {
  const t0 = Date.now();
  while ((j.state === "encoding" || j.state === "waiting_master") && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 1000));
  return exportJobView(j);
}
