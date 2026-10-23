// Project clean-up after delivery: which media a job no longer uses, a report
// anh can read before anything happens, and moving the unused files to the
// macOS Trash through Finder (never rm, never emptied: anh empties it himself).
// The report format is shared with the After Effects MCP (project.review_unused).

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';

export const CLEANUP_DIR = join(homedir(), 'Library', 'Application Support', 'MCP Adobe', 'Don dep');

const MEDIA_EXT = new Set([
  '.mp4', '.mov', '.mxf', '.mts', '.m2ts', '.avi', '.mkv', '.m4v', '.mpg', '.mpeg', '.r3d', '.braw', '.crm', '.insv',
  '.wav', '.mp3', '.aif', '.aiff', '.m4a', '.aac', '.flac', '.ogg',
  '.jpg', '.jpeg', '.png', '.tif', '.tiff', '.psd', '.ai', '.eps', '.heic', '.dng', '.exr', '.gif', '.svg', '.webp',
  '.srt', '.mogrt'
]);

/** Folders that hold deliveries or renders: never scanned, never trashed. */
export const KEEP_DIR = /(^|\/)(edited|export|exports|xuất file|xuat file|render|renders|output|deliver|delivery|deliverables|final|bàn giao|ban giao)(\/|$)/i;

export interface ProjectMediaItem { id: string; name: string; path: string | null; proxy: string | null; used: boolean; isSequence: boolean }

export interface CleanupReport {
  phien_ban: 1;
  app: 'premiere' | 'ae';
  project: string;
  tao_luc: string;
  giu: string[];
  dang_dung: { path: string; size: number }[];
  xoa_khoi_project: { id: string; name: string; path: string | null; ly_do: string }[];
  dua_vao_trash: { path: string; size: number; ly_do: string }[];
  tong_dung_luong: number;
  canh_bao: string[];
}

const norm = (p: string) => p.normalize('NFC');

function size(p: string): number {
  try { return statSync(p).size; } catch { return 0; }
}

/** "clip_0001.png" → /^clip_\d+\.png$/ so the rest of an image sequence is kept with its first frame. */
export function sequencePattern(file: string): RegExp | null {
  const m = /^(.*?)(\d{2,})(\.[^.]+)$/.exec(basename(file));
  if (!m) return null;
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${esc(m[1]!)}\\d{${m[2]!.length}}${esc(m[3]!)}$`, 'i');
}

/**
 * What to take out of the project and which files on disk can go to the Trash.
 * `listDir` is injectable for tests. Pure apart from it.
 */
export function planCleanup(items: ProjectMediaItem[], opts: { trashProxiesOfUsed?: boolean; scanFolders?: boolean; listDir?: (dir: string) => string[] } = {}) {
  const listDir = opts.listDir ?? ((d: string) => { try { return readdirSync(d); } catch { return []; } });
  const usedFiles = new Set<string>();
  const usedSeqPatterns: { dir: string; re: RegExp }[] = [];
  for (const it of items.filter((i) => i.used)) {
    if (it.path) {
      usedFiles.add(norm(it.path));
      const re = sequencePattern(it.path);
      if (re && /\.(png|jpe?g|tiff?|exr|dpx|tga)$/i.test(it.path)) usedSeqPatterns.push({ dir: norm(dirname(it.path)), re });
    }
    if (it.proxy && !opts.trashProxiesOfUsed) usedFiles.add(norm(it.proxy));
  }
  const isUsed = (p: string) => usedFiles.has(norm(p)) || usedSeqPatterns.some((s) => s.dir === norm(dirname(p)) && s.re.test(basename(p)));

  const removeFromProject = items
    .filter((i) => !i.used)
    .map((i) => ({ id: i.id, name: i.name, path: i.path, ly_do: i.isSequence ? 'sequence không nằm trong danh sách giữ' : i.path ? 'không có trên timeline nào' : 'item không dùng (matte, adjustment layer, caption…)' }));

  const trash = new Map<string, string>();
  const add = (p: string, why: string) => {
    if (!p || isUsed(p) || KEEP_DIR.test(p) || !MEDIA_EXT.has(extname(p).toLowerCase())) return;
    if (!trash.has(norm(p))) trash.set(norm(p), why);
  };
  for (const it of items.filter((i) => !i.used)) {
    if (it.path) add(it.path, 'đã import nhưng không dùng');
    if (it.proxy) add(it.proxy, 'proxy của file không dùng');
  }
  if (opts.trashProxiesOfUsed) for (const it of items.filter((i) => i.used && i.proxy)) add(it.proxy!, 'proxy của file đang dùng (tạo lại được)');
  if (opts.scanFolders !== false) {
    const dirs = new Set<string>();
    for (const it of items) if (it.path && !KEEP_DIR.test(it.path)) dirs.add(norm(dirname(it.path)));
    for (const d of [...dirs]) dirs.add(join(d, 'Proxies'));
    for (const d of dirs) for (const f of listDir(d)) {
      if (f.startsWith('.')) continue;
      add(join(d, norm(f)), d.endsWith('/Proxies') ? 'proxy không dùng trong thư mục nguồn' : 'nằm trong thư mục nguồn nhưng không dùng');
    }
  }
  return { usedFiles: [...usedFiles], removeFromProject, trash: [...trash.entries()].map(([path, ly_do]) => ({ path, ly_do })) };
}

export function writeReport(r: Omit<CleanupReport, 'phien_ban' | 'tao_luc'>): { file: string; report: CleanupReport } {
  mkdirSync(CLEANUP_DIR, { recursive: true });
  const d = new Date();
  const p2 = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
  const report: CleanupReport = { phien_ban: 1, tao_luc: d.toISOString(), ...r };
  const file = join(CLEANUP_DIR, `${basename(r.project).replace(/\.[^.]+$/, '')} ${stamp}.json`);
  writeFileSync(file, JSON.stringify(report, null, 2), 'utf8');
  return { file, report };
}

export function withSizes<T extends { path: string }>(rows: T[]): (T & { size: number })[] {
  return rows.map((r) => ({ ...r, size: size(r.path) }));
}

export function humanSize(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${Math.round(bytes / 1e3)} KB`;
}

const asAppleString = (p: string) => `"${p.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** Move files to the Trash with Finder (Put Back works). Batches of 40. */
export async function moveToTrash(paths: string[]): Promise<{ trashed: string[]; failed: { path: string; error: string }[] }> {
  const trashed: string[] = [];
  const failed: { path: string; error: string }[] = [];
  const live = paths.filter((p) => existsSync(p));
  for (const p of paths.filter((x) => !existsSync(x))) failed.push({ path: p, error: 'không còn trên ổ đĩa' });
  for (let i = 0; i < live.length; i += 40) {
    const batch = live.slice(i, i + 40);
    const script = `tell application "Finder" to delete {${batch.map((p) => `POSIX file ${asAppleString(p)} as alias`).join(', ')}}`;
    const r = await new Promise<{ code: number; err: string }>((resolve) => {
      const proc = spawn('osascript', ['-e', script]);
      let err = '';
      proc.stderr.on('data', (d: Buffer) => (err += d.toString()));
      proc.on('error', (e) => resolve({ code: 1, err: String(e) }));
      proc.on('close', (code) => resolve({ code: code ?? 1, err }));
    });
    for (const p of batch) {
      if (!existsSync(p)) trashed.push(p);
      else failed.push({ path: p, error: r.code === 0 ? 'Finder không chuyển được' : r.err.trim().slice(0, 200) || 'osascript lỗi' });
    }
    if (r.code !== 0 && /-1743|not authori[sz]ed|không được phép/i.test(r.err)) {
      for (const p of live.slice(i + 40)) failed.push({ path: p, error: 'chưa chạy: Finder chưa cho phép điều khiển (System Settings → Privacy & Security → Automation)' });
      break;
    }
  }
  return { trashed, failed };
}
