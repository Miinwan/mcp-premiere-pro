// Music beat detection without extra dependencies: ffmpeg decodes to mono PCM,
// a spectral-flux onset envelope gives the "attack" curve, autocorrelation picks
// the tempo and dynamic programming (Ellis 2007) lays the beats on the onsets.
// Results are cached next to the music in "<folder>/.dailies/nhip_<file>.json".

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { ffmpegPath } from './deliverables.js';

const SR = 11025;
const WIN = 1024;
const HOP = 256;

export interface BeatResult {
  file: string;
  bpm: number;
  beats: number[];
  downbeats: number[];
  duration: number;
}

export function decodeMono(file: string, sr = SR, from?: number, length?: number): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    const args = ['-hide_banner', '-nostats', '-v', 'error'];
    if (from !== undefined) args.push('-ss', String(from));
    if (length !== undefined) args.push('-t', String(length));
    args.push('-i', file, '-vn', '-ac', '1', '-ar', String(sr), '-f', 'f32le', '-');
    const p = spawn(ffmpegPath(), args);
    const chunks: Buffer[] = [];
    let err = '';
    p.stdout.on('data', (d: Buffer) => chunks.push(d));
    p.stderr.on('data', (d: Buffer) => (err += d.toString()));
    p.on('error', reject);
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg decode failed: ${err.slice(-300)}`));
      const buf = Buffer.concat(chunks);
      resolve(new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4)));
    });
  });
}

/** In-place radix-2 FFT on (re, im). */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b]! * cr - im[b]! * ci;
        const ti = re[b]! * ci + im[b]! * cr;
        re[b] = re[a]! - tr; im[b] = im[a]! - ti;
        re[a] = re[a]! + tr; im[a] = im[a]! + ti;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

/** Spectral flux of log magnitudes, one value per hop, normalised to unit std. */
export function onsetEnvelope(x: Float32Array, win = WIN, hop = HOP): Float64Array {
  const frames = Math.max(0, Math.floor((x.length - win) / hop) + 1);
  const env = new Float64Array(frames);
  const hann = new Float64Array(win).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / win));
  let prev = new Float64Array(win / 2);
  const re = new Float64Array(win), im = new Float64Array(win);
  for (let f = 0; f < frames; f++) {
    for (let i = 0; i < win; i++) { re[i] = x[f * hop + i]! * hann[i]!; im[i] = 0; }
    fft(re, im);
    const mag = new Float64Array(win / 2);
    let flux = 0;
    for (let k = 1; k < win / 2; k++) {
      mag[k] = Math.log1p(100 * Math.hypot(re[k]!, im[k]!));
      const d = mag[k]! - prev[k]!;
      if (d > 0) flux += d;
    }
    env[f] = flux;
    prev = mag;
  }
  // remove slow trend (local mean) and keep the positive part
  const out = new Float64Array(frames);
  const w = 16;
  for (let i = 0; i < frames; i++) {
    let s = 0, n = 0;
    for (let j = Math.max(0, i - w); j <= Math.min(frames - 1, i + w); j++) { s += env[j]!; n++; }
    out[i] = Math.max(0, env[i]! - s / n);
  }
  const mean = out.reduce((a, b) => a + b, 0) / Math.max(1, frames);
  const sd = Math.sqrt(out.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, frames)) || 1;
  return out.map((v) => v / sd);
}

/** Tempo (BPM) from the envelope's autocorrelation, weighted towards 120 BPM. */
export function estimateTempo(env: Float64Array, fps: number, min = 70, max = 180): number {
  let best = 120, bestScore = -Infinity;
  for (let bpm = min; bpm <= max; bpm += 0.5) {
    const lag = (60 / bpm) * fps;
    const l0 = Math.floor(lag), fr = lag - l0;
    let s = 0;
    for (let i = 0; i + l0 + 1 < env.length; i++) s += env[i]! * (env[i + l0]! * (1 - fr) + env[i + l0 + 1]! * fr);
    s /= Math.max(1, env.length - l0);
    const w = Math.exp(-0.5 * (Math.log2(bpm / 120) / 1.0) ** 2);
    if (s * w > bestScore) { bestScore = s * w; best = bpm; }
  }
  return best;
}

/** Beat frames by dynamic programming over the onset envelope. */
export function trackBeats(env: Float64Array, fps: number, bpm: number, tightness = 100): number[] {
  const period = (60 / bpm) * fps;
  const n = env.length;
  const score = new Float64Array(n), back = new Int32Array(n).fill(-1);
  for (let t = 0; t < n; t++) {
    let bestV = 0, bestP = -1;
    const lo = Math.max(0, Math.round(t - 2 * period)), hi = Math.round(t - period / 2);
    for (let p = lo; p <= hi; p++) {
      const v = score[p]! - tightness * Math.log((t - p) / period) ** 2;
      if (bestP < 0 || v > bestV) { bestV = v; bestP = p; }
    }
    score[t] = env[t]! + (bestP >= 0 ? bestV : 0);
    back[t] = bestP;
  }
  // start from the best-scoring frame in the last period
  let t = n - 1, m = -Infinity;
  for (let i = Math.max(0, Math.floor(n - period)); i < n; i++) if (score[i]! > m) { m = score[i]!; t = i; }
  const beats: number[] = [];
  while (t >= 0) { beats.push(t); t = back[t]!; }
  return beats.reverse();
}

/** Every 4th beat starting at the phase with the strongest onsets. */
export function pickDownbeats(beatFrames: number[], env: Float64Array, perBar = 4): number[] {
  let bestPhase = 0, best = -Infinity;
  for (let ph = 0; ph < perBar; ph++) {
    let s = 0;
    for (let i = ph; i < beatFrames.length; i += perBar) s += env[beatFrames[i]!] ?? 0;
    if (s > best) { best = s; bestPhase = ph; }
  }
  return beatFrames.filter((_, i) => i % perBar === bestPhase);
}

export function analyseSignal(x: Float32Array, sr = SR): Omit<BeatResult, 'file'> {
  const env = onsetEnvelope(x);
  const fps = sr / HOP;
  const bpm = estimateTempo(env, fps);
  const frames = trackBeats(env, fps, bpm);
  const toSec = (f: number) => Math.round(((f * HOP + WIN / 2) / sr) * 1000) / 1000;
  // The tracked beats give a finer tempo than the autocorrelation grid.
  const med = frames.length > 2 ? (frames[frames.length - 1]! - frames[0]!) / (frames.length - 1) : 0;
  return {
    bpm: med ? Math.round((60 * fps / med) * 10) / 10 : bpm,
    beats: frames.map(toSec),
    downbeats: pickDownbeats(frames, env).map(toSec),
    duration: Math.round((x.length / sr) * 1000) / 1000
  };
}

function cachePath(file: string): string {
  return join(dirname(file), '.dailies', `nhip_${basename(file)}.json`);
}

export async function detectBeats(file: string, force = false): Promise<BeatResult & { cached: boolean }> {
  const st = statSync(file);
  const key = `${st.size}-${Math.round(st.mtimeMs)}`;
  const cp = cachePath(file);
  if (!force && existsSync(cp)) {
    try {
      const c = JSON.parse(readFileSync(cp, 'utf8'));
      if (c.key === key) return { ...c.result, cached: true };
    } catch { /* re-analyse */ }
  }
  const x = await decodeMono(file);
  const result: BeatResult = { file, ...analyseSignal(x) };
  try {
    mkdirSync(dirname(cp), { recursive: true });
    writeFileSync(cp, JSON.stringify({ key, result }), 'utf8');
  } catch { /* read-only folder: no cache */ }
  return { ...result, cached: false };
}

/**
 * New clip lengths so every cut lands on the beat grid. Each clip keeps its in
 * point; its end moves to the grid point nearest its current length, never
 * shorter than minLen and never past the media it has (maxLen). Pure, for tests.
 */
export function beatLayout(clips: { len: number; maxLen: number }[], grid: number[], start: number, minLen = 0.4): { at: number; len: number; onBeat: boolean }[] {
  const out: { at: number; len: number; onBeat: boolean }[] = [];
  let cursor = start;
  for (const c of clips) {
    const want = cursor + c.len;
    const cands = grid.filter((g) => g >= cursor + minLen - 1e-6 && g <= cursor + c.maxLen + 1e-6);
    let end = want, onBeat = false;
    if (cands.length) {
      end = cands.reduce((a, b) => (Math.abs(b - want) < Math.abs(a - want) ? b : a));
      onBeat = true;
    }
    out.push({ at: round3(cursor), len: round3(end - cursor), onBeat });
    cursor = end;
  }
  return out;
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
