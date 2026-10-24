import { z } from 'zod';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import type { PremiereProTransport } from '../bridge/types.js';
import type { MCPTool } from './index.js';
import { encodeRgbaPng } from './expanded.js';
import { exportJob, ffmpegPath, PRESETS as DELIVERABLES, startExportJob, waitJob } from './deliverables.js';
import { beatLayout, detectBeats } from './beats.js';
import { humanSize, insideFolder, jobFolderFor, moveToTrash, planCleanup, writeReport, withSizes, type CleanupReport, type ProjectMediaItem } from './cleanup.js';

/**
 * Studio tools: rough cut from slate cues and shot descriptions via
 * Dailies, the MCP Adobe footage engine (`dailies` CLI in MCP Adobe/Dailies, JSON contract v1
 * in Dailies/README.md), and a round trip to After Effects
 * through a handoff JSON that the After Effects MCP reads and writes
 * (bridge.from_premiere / bridge.to_premiere). Nothing is destructive: the
 * rough cut goes into a NEW sequence, and an AE render is laid on the track
 * above the original, which is only disabled.
 */
export const studioToolNames = [
  'rough_cut_by_cues',
  'describe_sources',
  'inspect_footage',
  'find_shots',
  'score_footage',
  'send_to_after_effects',
  'return_from_after_effects',
  'create_aspect_versions',
  'add_color_layer',
  'mako',
  'add_color_matte',
  'pr_guide',
  'export_deliverables',
  'export_status',
  'add_scene_color_layers',
  'sync_color_layers',
  'create_proxies',
  'proxy_status',
  'checkpoint_project',
  'organize_project_bins',
  'qc_before_export',
  'transcribe_to_captions',
  'detect_beats',
  'cut_to_beats',
  'select_best_takes',
  'place_voiceover',
  'normalize_loudness',
  'review_cut',
  'review_unused_media',
  'clean_unused_media'
] as const;

export function isStudioTool(name: string): boolean {
  return (studioToolNames as readonly string[]).includes(name);
}

// ---------------------------------------------------------------- Dailies CLI (footage engine)

const DAILIES_DIR = process.env.DAILIES_DIR || process.env.MEDIA_DIR || join(homedir(), 'Desktop', '03. Code', 'MCP Adobe', 'Dailies');
function uvPath(): string {
  for (const p of [process.env.UV_PATH, join(homedir(), '.local/bin/uv'), '/opt/homebrew/bin/uv', '/usr/local/bin/uv']) {
    if (p && existsSync(p)) return p;
  }
  return 'uv';
}

interface DailiesJob {
  key: string;
  args: string[];
  started: number;
  done: boolean;
  code: number | null;
  stdout: string;
  stderrTail: string[];
  waiters: Array<() => void>;
}
const jobs = new Map<string, DailiesJob>();

/** Start (or join) a Dailies run; resolves when it ends or after waitMs, whichever comes first. */
async function runDailies(args: string[], waitMs: number, fast: boolean): Promise<DailiesJob> {
  const key = args.join('\u0000');
  let job = jobs.get(key);
  if (!job || (job.done && job.code !== 0)) {
    const j: DailiesJob = { key, args, started: Date.now(), done: false, code: null, stdout: '', stderrTail: [], waiters: [] };
    const child = spawn(uvPath(), ['run', 'dailies', ...args], {
      cwd: DAILIES_DIR,
      env: { ...process.env, ...(fast ? { DAILIES_CHE_DO: 'nhanh' } : {}) }
    });
    child.stdout.on('data', (d) => { j.stdout += d.toString(); });
    child.stderr.on('data', (d) => {
      for (const line of d.toString().split(/\r?\n/)) if (line.trim()) j.stderrTail.push(line.trim());
      if (j.stderrTail.length > 12) j.stderrTail.splice(0, j.stderrTail.length - 12);
    });
    child.on('close', (code) => { j.done = true; j.code = code; j.waiters.splice(0).forEach((w) => w()); });
    child.on('error', (e) => { j.done = true; j.code = -1; j.stderrTail.push(String(e)); j.waiters.splice(0).forEach((w) => w()); });
    jobs.set(key, j);
    job = j;
  }
  if (!job.done) {
    const j = job;
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, waitMs);
      j.waiters.push(() => { clearTimeout(t); resolve(); });
    });
  }
  return job;
}

function parseDailies(job: DailiesJob): any {
  try { return JSON.parse(job.stdout); } catch { return null; }
}

/** Shared handling of exit codes 1/3/4 and "still running". Returns null when the JSON is usable. */
function dailiesProblem(job: DailiesJob, tool: string): any | null {
  if (!job.done) {
    return {
      success: true, tool, status: 'running',
      elapsedSec: Math.round((Date.now() - job.started) / 1000),
      progress: job.stderrTail.slice(-3),
      next: `Call ${tool} again with the same arguments to wait for the result (results are cached next to the footage, nothing restarts).`
    };
  }
  const out = parseDailies(job);
  if (job.code === 0 && out) return null;
  if (out?.loi === 'thieu_proxy') return { success: false, tool, missingProxy: out.file, hint: 'Make proxies for these clips first (Premiere Create Proxies, or create_proxies), then call again; or pass allowOriginal: true to read the originals.' };
  if (job.code === 3) return { success: false, tool, needsConfirmation: true, question: out?.cau_hoi ?? out, hint: 'Ask the user first: the Dailies engine needs their OK (usually a download).' };
  if (job.code === 4) return { success: false, tool, missingModel: true, detail: out, hint: 'The deep mode model is not installed: run `uv run dailies cai-mo-ta --model 2b --json` in MCP Adobe/Dailies after the user agrees, or use mode fast.' };
  return { success: false, tool, exitCode: job.code, error: out?.thong_bao ?? out?.loi ?? 'Dailies engine failed', stderr: job.stderrTail.slice(-6) };
}

// ---------------------------------------------------------------- JSX helpers

const LIB = `
function __seq(name,id){var s=app.project.sequences;for(var i=0;i<s.numSequences;i++){if((id&&s[i].sequenceID==id)||(name&&s[i].name==name))return s[i];}return null;}
function __T(sec){var t=new Time();t.seconds=sec;return t;}
function __walk(bin,fn){for(var i=0;i<bin.children.numItems;i++){var c=bin.children[i];if(c.type==2)__walk(c,fn);else fn(c);}}
function __byPath(path){var hit=null;var want=String(path).toLowerCase();__walk(app.project.rootItem,function(c){if(hit)return;try{if(c.getMediaPath&&String(c.getMediaPath()).toLowerCase()==want)hit=c;}catch(e){}});return hit;}
function __bin(name){var r=app.project.rootItem;for(var i=0;i<r.children.numItems;i++){var c=r.children[i];if(c.type==2&&c.name==name)return c;}return r.createBin(name);}
function __comp(c,n){for(var i=0;i<c.components.numItems;i++){if(c.components[i].displayName==n)return c.components[i];}return null;}
function __prop(comp,n){if(!comp)return null;for(var j=0;j<comp.properties.numItems;j++){if(comp.properties[j].displayName==n)return comp.properties[j];}return null;}
`;

async function jsx(bridge: PremiereProTransport, body: string, timeoutMs = 120000): Promise<any> {
  const script = `${LIB}\ntry{${body}}catch(e){return JSON.stringify({success:false,error:e.toString()+' line '+e.line});}`;
  const res = await bridge.executeScript(script, timeoutMs);
  if (typeof res === 'string') { try { return JSON.parse(res); } catch { return { success: true, raw: res }; } }
  return res;
}
const q = (v: unknown) => JSON.stringify(v ?? null);

// ---------------------------------------------------------------- handoff

export const HANDOFF_DIR = process.env.MCP_ADOBE_BRIDGE_DIR || join(homedir(), 'Library', 'Application Support', 'MCP Adobe', 'Cau noi PR AE');

export interface Handoff {
  version: 1;
  id: string;
  created: string;
  status: 'sent' | 'in_ae' | 'rendered' | 'returned';
  premiere: {
    projectPath: string | null;
    sequenceId: string;
    sequenceName: string;
    videoTrack: number;
    clipIndex: number;
    clipName: string;
    timelineStart: number;
    timelineEnd: number;
    fps: number;
    width: number;
    height: number;
  };
  source: {
    mediaPath: string;
    inPoint: number;
    outPoint: number;
    handles: number;
    speed: number;
    motion: { position: number[] | null; scale: number | null; rotation: number | null };
  };
  ae?: { project?: string | null; compId?: number; compName?: string; renderPath?: string; renderedAt?: string; handleIn?: number };
  returned?: { track: number; clipName: string; at: string };
  note?: string;
}

function handoffPath(id: string): string { return join(HANDOFF_DIR, `${id}.json`); }
export function readHandoff(id: string): Handoff | null {
  const p = id.endsWith('.json') ? id : handoffPath(id);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8')) as Handoff;
}
function writeHandoff(h: Handoff): string {
  mkdirSync(HANDOFF_DIR, { recursive: true });
  const p = handoffPath(h.id);
  writeFileSync(p, JSON.stringify(h, null, 2), 'utf8');
  return p;
}

// ---------------------------------------------------------------- schemas

const seqRef = {
  sequenceName: z.string().optional().describe('Sequence name. Default: the active sequence.'),
  sequenceId: z.string().optional().describe('Sequence ID (GUID).')
};

export function getStudioTools(existingNames: Set<string>): MCPTool[] {
  const tools: MCPTool[] = [
    {
      name: 'rough_cut_by_cues',
      description:
        'Rough-cut a folder of raw footage by the slate cues called on set ("3, 2, 1", "action", "diễn", "đi" to start; "cắt", "cut", "ok", "được rồi" to end), heard by Whisper in each file\'s own audio through Dailies, the MCP Adobe footage engine. ' +
        'One source can give many takes. Builds a NEW sequence with every take back to back, a→z by file then time, so the editor can reorder them; each take gets a sequence marker (take id, cue heard, dialogue, confidence) and low-confidence takes a red marker. Files with no cue are kept whole (unless dropNoCue). ' +
        'Analysis is cached next to the footage (.dailies/); a long first run returns status "running" — call again with the same arguments to pick up the result.',
      inputSchema: z.object({
        sourceFolder: z.string().optional().describe('Footage folder. Default: the clips kept in the project after the junk was filtered out (with the proxies attached in Premiere); with a folder, only the project clips inside it, or the whole folder when none are imported'),
        bin: z.string().optional().describe('Only the clips in this project bin'),
        allowOriginal: z.boolean().optional().describe('Clips without a proxy: read the original file instead of stopping (heavier on the machine)'),
        sequenceName: z.string().optional().describe('New sequence name (default "Rough cut <folder>")'),
        frame: z.string().optional().describe('Sequence frame: "1920x1080" (default), "9:16", "1:1", "4:5" or "<w>x<h>". The Dailies engine fits each take (4K → 50 %, other ratios fill the frame centred on faces) and the scale/position go into Motion'),
        fps: z.string().optional().describe('Sequence frame rate ("23.976", "25", "29.97"…). Default: from inspect_footage, the most common rate among normal-speed clips'),
        gapSeconds: z.number().min(0).optional().describe('Gap between takes in seconds (default 0)'),
        lowConfidence: z.number().min(0).max(1).optional().describe('Takes below this confidence get a red marker (default 0.6)'),
        dropNoCue: z.boolean().optional().describe('Leave out files with no cue (B-roll) instead of keeping them whole (default false)'),
        model: z.string().optional().describe('Whisper model (default large-v3)'),
        fast: z.boolean().optional().describe('Run the Dailies engine in fast mode instead of the quiet background mode (default true: the user is waiting)'),
        waitSeconds: z.number().min(1).max(600).optional().describe('How long to wait for the Dailies engine in this call before returning "running" (default 45)'),
        analyzeOnly: z.boolean().optional().describe('Only run the analysis and return the takes, do not touch Premiere')
      })
    },
    {
      name: 'describe_sources',
      description:
        'Describe every shot (file) in a footage folder through the Dailies engine: one-line description (in Vietnamese), shot size, setting, content labels, sharpness, exposure, shake, faces, a beauty score. mode "fast" needs no download; "deep" adds a local vision model (Qwen3.5 2B MLX) for natural sentences. ' +
        'With writeToProject, the description goes into each imported clip\'s Comment column and the quality numbers into Log Note, so they can be searched and sorted in the Project panel.',
      inputSchema: z.object({
        sourceFolder: z.string().optional().describe('Footage folder. Default: the clips kept in the project after the junk was filtered out (with the proxies attached in Premiere); with a folder, only the project clips inside it, or the whole folder when none are imported'),
        bin: z.string().optional().describe('Only the clips in this project bin'),
        allowOriginal: z.boolean().optional().describe('Clips without a proxy: read the original file instead of stopping (heavier on the machine)'),
        mode: z.enum(['fast', 'deep']).optional().describe('fast (default) or deep'),
        writeToProject: z.boolean().optional().describe('Write descriptions into the Project panel for clips already imported from this folder (default true)'),
        waitSeconds: z.number().min(1).max(600).optional().describe('How long to wait in this call before returning "running" (default 45)')
      })
    },
    {
      name: 'inspect_footage',
      description:
        'FIRST STEP before any edit: read every clip\'s properties without decoding (size after rotation and pixel aspect, frame rate and the rate it was shot at, in-camera slow motion or time-lapse, log or HDR such as S-Log3 read from the camera\'s own metadata, variable frame rate, interlacing, codec, bit depth, camera model, timecode) and recommend the sequence (delivery frame and fps if given, else the most common size and normal-speed rate) and how each clip goes in: every clip that is not the sequence size is fit to frame (4K in Full HD = 50 %), other aspect ratios fill the frame. ' +
        'Flags what needs a decision: clips whose rate does not divide the sequence rate (judder), high-frame-rate clips that can become slow motion (with the %), time-lapse clips, log footage that needs colour management or a LUT. rough_cut_by_cues, select_best_takes and score_footage run this themselves and use it (sequence fps, fit to frame), so their sequences no longer copy the first clip. Takes about 20 s for 176 clips; cached next to the footage.',
      inputSchema: z.object({
        sourceFolder: z.string().optional().describe('Footage folder. Default: the clips kept in the project'),
        bin: z.string().optional().describe('Only the clips in this project bin'),
        frame: z.string().optional().describe('Delivery frame: "1920x1080", "3840x2160", "9:16", "1:1"… Default: the most common clip size'),
        fps: z.string().optional().describe('Delivery frame rate: "23.976", "25", "29.97", "59.94"… Default: the most common rate among normal-speed clips'),
        waitSeconds: z.number().min(1).max(600).optional().describe('How long to wait in this call before returning "running" (default 60)')
      })
    },
    {
      name: 'find_shots',
      description:
        'Find shots by what is in the picture, in English or Vietnamese ("close-up of a face", "wide shot of the restaurant", "waiter in a red shirt", or "cô gái cầm menu"), through the Dailies engine (SigLIP 2, local): every second of each clip\'s proxy is compared with the words, the best stretches come back ranked with in/out and a score. ' +
        'Each hit becomes a marker on the source clip in the Project panel (open the clip in the Source Monitor to see it; searching the same words again replaces those markers). With placeOnTimeline, also builds a sequence "Tìm: <query>" with the hits in rank order. ' +
        'Uses the clips kept in the project with their proxies, like describe_sources. The first search on a folder reads the images (about 30 s for 5 minutes of footage); later searches take a few seconds.',
      inputSchema: z.object({
        query: z.string().min(1).describe('What to look for, e.g. "girl holding a menu", "close-up", "wide shot of the restaurant" (Vietnamese works too)'),
        sourceFolder: z.string().optional().describe('Footage folder. Default: the clips kept in the project (with their proxies); with a folder, only the project clips inside it, or the whole folder when none are imported'),
        bin: z.string().optional().describe('Only the clips in this project bin'),
        allowOriginal: z.boolean().optional().describe('Clips without a proxy: read the original file instead of stopping (heavier on the machine)'),
        top: z.number().int().min(1).max(50).optional().describe('How many hits (default 8)'),
        markers: z.boolean().optional().describe('Put a marker for each hit on its source clip in the project (default true)'),
        placeOnTimeline: z.boolean().optional().describe('Also build a sequence "Tìm: <query>" with the hits in rank order (default false)'),
        waitSeconds: z.number().min(1).max(600).optional().describe('How long to wait in this call before returning "running" (default 45)')
      })
    },
    {
      name: 'score_footage',
      description:
        'Score b-roll and general footage like an assistant editor and keep only the usable stretches (selects), through the Dailies engine (local): about 4 samples a second from each clip\'s proxy, sharpness on a 6x6 grid (a sharp subject on a soft background counts as sharp), exposure, camera move (pan, tilt, zoom, roll) and shake (a smooth gimbal move is not shake), flags for black, blown out, frozen, flicker and motion blur. ' +
        'Stretches above the threshold become segments with in/out, score, grade and camera move. With sequenceName, builds a new selects sequence with a marker on each segment; with exportFormats, also writes files for another editor (FCP7 XML for Premiere/Resolve, FCPXML for Final Cut, CMX3600 EDL, CSV), pointing at the original camera files with their source timecode. ' +
        'Uses the clips kept in the project with their proxies, like describe_sources. Measured: 176 clips (58 min of 4K) in about 2 minutes in fast mode; later calls with another threshold or kind reuse the scan and take seconds. For slate-called takes use select_best_takes instead.',
      inputSchema: z.object({
        sourceFolder: z.string().optional().describe('Footage folder. Default: the clips kept in the project (with their proxies); with a folder, only the project clips inside it, or the whole folder when none are imported'),
        bin: z.string().optional().describe('Only the clips in this project bin'),
        allowOriginal: z.boolean().optional().describe('Clips without a proxy: read the original file (keyframes only) instead of stopping'),
        kind: z.enum(['balanced', 'b_roll', 'static']).optional().describe('balanced (default): sharp, well exposed, steady or smoothly moving; b_roll: camera moves are not penalised when smooth (gimbal, drone); static: locked-off shots only (interview, product, architecture)'),
        threshold: z.number().min(0.05).max(0.99).optional().describe('Minimum score 0-1 (default 0.85, which matched the Cutdown app on a real shoot). Lower keeps more'),
        minSeconds: z.number().min(0.2).max(60).optional().describe('Shortest segment in seconds (default 2)'),
        bridgeSeconds: z.number().min(0).max(10).optional().describe('Join two segments when the score dips for less than this (default 2)'),
        sequenceName: z.string().optional().describe('Build a new sequence with this name holding the selects end to end, a marker on each (score, grade, camera move)'),
        order: z.enum(['file', 'score']).optional().describe('Segment order: by file name then time (default) or best score first'),
        frame: z.string().optional().describe('Selects sequence frame ("1920x1080", "3840x2160"…). Default: from inspect_footage, the most common clip size; every other clip is fit to frame'),
        fps: z.string().optional().describe('Selects sequence frame rate. Default: from inspect_footage'),
        gapSeconds: z.number().min(0).max(10).optional().describe('Gap between segments on the sequence (default 0)'),
        handles: z.number().min(0).max(5).optional().describe('Extra seconds kept before and after each segment (default 0)'),
        exportFormats: z.array(z.enum(['xml', 'fcpxml', 'edl', 'csv'])).optional().describe('Also write these files for another editor: xml (Premiere, Resolve), fcpxml (Final Cut), edl, csv'),
        exportFolder: z.string().optional().describe('Folder for the exported files (default "<source folder>/Dailies selects")'),
        fast: z.boolean().optional().describe('Use the whole machine (default true: the user is waiting); false runs in the quiet background mode'),
        waitSeconds: z.number().min(1).max(600).optional().describe('How long to wait in this call before returning "running" (default 45)')
      })
    },
    {
      name: 'send_to_after_effects',
      description:
        'Send one timeline clip to After Effects for effects work: records the clip (media file, source in/out, handles, timeline position, sequence size and fps, Motion position/scale/rotation) in a handoff JSON and returns its id. ' +
        'Then call the After Effects MCP: ae_do bridge.from_premiere { handoff: <id> } builds a matching comp (same size, fps, framing, handles marked); after the effect work, ae_do bridge.to_premiere { handoff } renders it; finally return_from_after_effects { handoff } puts the render back on the timeline.',
      inputSchema: z.object({
        ...seqRef,
        videoTrack: z.number().int().min(0).optional().describe('0-based video track (default 0 = V1)'),
        clipIndex: z.number().int().min(0).optional().describe('0-based clip index on that track; omit to use the clip under the playhead'),
        handles: z.number().min(0).max(10).optional().describe('Extra source seconds before and after the cut, for trimming later (default 1)'),
        note: z.string().optional().describe('What to do in AE, e.g. "title flies in + glow"')
      })
    },
    {
      name: 'return_from_after_effects',
      description:
        'Bring an After Effects render back to the timeline: imports the file rendered by bridge.to_premiere (or refreshes it when it was already brought back once — re-render in AE and call again), lays it on the track above the original at the same time and length (handles hidden but kept for trimming), names it "AE · <clip>", and disables the original underneath (re-enable it to compare). Nothing is deleted.',
      inputSchema: z.object({
        handoff: z.string().describe('Handoff id from send_to_after_effects'),
        targetTrack: z.number().int().min(0).optional().describe('Video track to place on (default original track + 1)'),
        disableOriginal: z.boolean().optional().describe('Disable the original clip (default true)')
      })
    },
    {
      name: 'create_aspect_versions',
      description:
        'Make square and vertical versions of a finished horizontal edit, the way an editor does it by hand: duplicates the sequence as "<name> 1x1" / "<name> 9x16" (cuts, order, tracks, audio, titles unchanged), changes the frame, and re-frames every video clip from the horizontal version as already adjusted (media `bo-cuc`: a window cut out of the horizontal frame, centred on faces when there are any, never showing black edges or anything cropped away). Only Motion Scale and Position change; Anchor Point, Rotation and Crop stay. Adjustment layers keep all their effects and are scaled to cover the new frame. Titles/graphics are left as they are and listed for a manual check.',
      inputSchema: z.object({
        ...seqRef,
        aspects: z.array(z.string()).optional().describe('Frames to make (default ["1:1", "9:16"]; also "4:5" or "<w>x<h>")'),
        replace: z.boolean().optional().describe('Rebuild a version that already exists (default false: stop and report)')
      })
    },
    {
      name: 'add_color_layer',
      description:
        'One colour layer over the whole sequence or a time range (a global look). For per-scene grading use add_scene_color_layers. Lays a colour-grading adjustment layer over the whole sequence (or a time range) on its own top track, with Lumetri Color ready to grade — the colour layer an editor puts above the cut. Uses the project\'s Adjustment Layer item, importing one from Mako\'s template when the project has none (Premiere has no scripting call that creates one). Optional Lumetri Basic values (temperature, tint, exposure, contrast, highlights, shadows, whites, blacks, saturation, vibrance) and a Lumetri preset/LUT look.',
      inputSchema: z.object({
        ...seqRef,
        start: z.number().optional().describe('Start in seconds (default 0)'),
        end: z.number().optional().describe('End in seconds (default sequence end)'),
        name: z.string().optional().describe('Clip name on the timeline (default "Màu tổng")'),
        basic: z.record(z.string(), z.number()).optional().describe('Lumetri Basic values, e.g. { exposure: 0.2, contrast: 10, saturation: 110 }')
      })
    },
    {
      name: 'mako',
      description:
        'Run a Mako (Basics Studio panel, installed) shortcut on the open sequence, on clips you select first: adjustment_layer (mode "" over the selection/sequence, "clips" one per clip, "cuts" short ones on every cut), staircase / unstaircase (spread clips onto stacked tracks and back), freeze_frame (mode "" whole selected clips, "hold" holdSeconds from the playhead), fit_frame (mode "" fit, "fill" fill the frame), nest / unnest (rebuilds Nest with effects, transitions and markers kept), clear_effects (resetMotion), quality_check (marks gaps red, offline media orange, disabled clips yellow, 1–2 frame leftovers purple; fix closes gaps; mode "clear" removes the markers), delete_empty_tracks, new_sequence, transparency_grid. ' +
        'select: "all" (every clip), "none" (leave the selection as it is) or { track, clips: [indexes] } / { from, to } in seconds on video tracks. Requires the Mako panel to have loaded once in this Premiere session.',
      inputSchema: z.object({
        ...seqRef,
        action: z.enum(['adjustment_layer', 'staircase', 'unstaircase', 'freeze_frame', 'fit_frame', 'nest', 'unnest', 'clear_effects', 'quality_check', 'delete_empty_tracks', 'new_sequence', 'transparency_grid']),
        mode: z.string().optional().describe('Action mode (see description); default ""'),
        holdSeconds: z.number().optional().describe('freeze_frame mode "hold": seconds to hold (default 2)'),
        resetMotion: z.boolean().optional().describe('clear_effects: also reset Motion and Opacity'),
        fix: z.boolean().optional().describe('quality_check: close the gaps it finds (default true)'),
        select: z.any().optional().describe('"all", "none" (default), { track, clips: [0, 2] } or { from, to } seconds')
      })
    },
    {
      name: 'add_color_matte',
      description:
        'Put a solid colour background on the timeline without Premiere\'s colour picker (which blocks scripting): white or black by default — the plate a logo sits on — or any #RRGGBB. Made at the sequence frame size, saved next to the project in "MCP mattes" (reused, never in a temp folder that could go offline), imported into a "Nền màu" bin and placed on the given track for the given span (default: the whole sequence on `track`, which is V1 when that span is free there, else a new track at the top so you can drag it under).',
      inputSchema: z.object({
        ...seqRef,
        color: z.string().optional().describe('"white" / "trắng" (default), "black" / "đen", or "#RRGGBB"'),
        start: z.number().optional().describe('Start in seconds (default 0)'),
        end: z.number().optional().describe('End in seconds (default the sequence end)'),
        track: z.number().int().min(0).optional().describe('0-based video track (default 0 = V1 if that span is free, else a new top track)'),
        name: z.string().optional().describe('Clip name (default "Nền trắng" / "Nền đen" / "Nền #hex")')
      })
    }
    ,{
      name: 'pr_guide',
      description:
        'Premiere knowledge base (folder Premiere/Kiến thức — drop .md files there, no build): which transitions exist and when to use them (Film Impact is built into Premiere 2026), which plugins/panels MCP can drive (Mako) and which are manual (Animation/Premiere Composer), export rules. Call with no topic to list topics, then with a topic name to read it. Read it before choosing transitions or plugins.',
      inputSchema: z.object({ topic: z.string().optional().describe('Topic (file name without .md); omit to list') })
    }
    ,{
      name: 'export_deliverables',
      description:
        'Export a sequence for delivery: one ProRes 422 HQ master straight from Premiere (exportAsMediaDirect with the built-in "Match Source - Apple ProRes 422 HQ" preset), then every requested deliverable from it — youtube_4k, youtube_1080, reels (1080x1920), feed_4x5, square, led (screen width/height), review (720p, watermark + timecode), master, png_alpha — with sizes, bitrates and -14 LUFS loudness from pr_guide "Xuất file". Files are named "<Client> <Video name> <Aspect> V<n>" (next free version) and logged with the measured LUFS in "Kết quả xuất.md" (export log). Export the 9x16 / 1x1 sequences for vertical and square (create_aspect_versions) — another aspect is letterboxed.',
      inputSchema: z.object({
        ...seqRef,
        presets: z.array(z.string()).describe('Deliverables to make'),
        client: z.string().describe('Client name for the file name'),
        title: z.string().describe('Video name for the file name'),
        outputDir: z.string().optional().describe('Folder (default "<project folder>/Xuất file")'),
        version: z.number().int().optional().describe('Force the version number'),
        width: z.number().int().optional().describe('led: screen width'),
        height: z.number().int().optional().describe('led: screen height'),
        watermark: z.string().optional().describe('review: watermark text'),
        waitSeconds: z.number().optional().describe('How long to wait in this call (default 40); the export keeps running — check with export_status')
      })
    },
    {
      name: 'export_status',
      description: 'Progress of an export_deliverables job: waiting for the Media Encoder master, encoding (which deliverable), done or failed, with the finished files and their measured LUFS.',
      inputSchema: z.object({ jobId: z.string(), waitSeconds: z.number().optional().describe('Wait up to this long first (default 0)') })
    }
    ,{
      name: 'add_scene_color_layers',
      description:
        'Grade per scene: one adjustment layer with Lumetri Color per SOURCE on a new top track, named "Màu <source>". Neighbouring clips from the same source share one layer; the same source used again elsewhere on the timeline gets a layer with the same name and the same Lumetri values (keep them identical with sync_color_layers after grading one); a different source always gets its own layer. Titles/adjustment layers/graphics are skipped. Optional Lumetri Basic values for all (basic) or per source file name (perSource).',
      inputSchema: z.object({
        ...seqRef,
        sourceTrack: z.number().int().min(0).optional().describe('Video track holding the footage (default 0 = V1)'),
        basic: z.record(z.string(), z.number()).optional().describe('Lumetri Basic values for every scene'),
        perSource: z.record(z.string(), z.record(z.string(), z.number())).optional().describe('{ "A001_C0661": { exposure: 0.3 } } — by file name without extension')
      })
    },
    {
      name: 'sync_color_layers',
      description:
        'Make every colour layer of the same scene identical again after grading one of them: for each "Màu <source>" name, copies ALL Lumetri Color parameters (basic, creative, curves, wheels, HSL, vignette) from the master instance to the other instances of that name. master: a clip name + index or the instance under the playhead; default the first instance of each name. Different sources are never touched by each other.',
      inputSchema: z.object({
        ...seqRef,
        name: z.string().optional().describe('Only this layer name, e.g. "Màu A001_C0661" (default every "Màu …" group)'),
        fromPlayhead: z.boolean().optional().describe('Use the instance under the playhead as the master for its group (default false: the first instance)')
      })
    }
    ,{
      name: 'create_proxies',
      description:
        'FIRST STEP of a job: make edit proxies for every video in a footage folder so Premiere (and the Dailies engine) work on light files instead of 4K. ProRes Proxy with the Mac hardware encoder (VideoToolbox, cool and fast), half resolution by default (4K → 1080p), same fps, duration and audio channels so Premiere accepts them; saved as "<folder>/Proxies/<name>_Proxy.mov", one file at a time at low priority so the machine stays cool. Existing proxies are reused. When done, attaches each proxy to its clip in the open project (Toggle Proxies in Premiere switches). Runs in the background: check with proxy_status.',
      inputSchema: z.object({
        sourceFolder: z.string().describe('Absolute footage folder'),
        size: z.enum(['1/2', '1/4']).optional().describe('Proxy resolution (default 1/2)'),
        codec: z.enum(['prores_proxy', 'h264']).optional().describe('prores_proxy (default, best for editing) or h264 (smaller)'),
        attach: z.boolean().optional().describe('Attach to clips already in the project when done (default true)'),
        waitSeconds: z.number().optional().describe('How long to wait in this call (default 20)')
      })
    },
    {
      name: 'proxy_status',
      description: 'Progress of a create_proxies job: files done, current file, attached proxies, failures.',
      inputSchema: z.object({ jobId: z.string(), waitSeconds: z.number().optional() })
    }
    ,{
      name: 'checkpoint_project',
      description: 'Save the project, then copy the .prproj into "<project> checkpoints/<project> <date time> <label>.prproj" next to it. Premiere has no undo group for scripts, so take one before any large automated change (rough cut, aspect versions, colour layers); restore by opening the copy. Lists existing checkpoints with list: true.',
      inputSchema: z.object({ label: z.string().optional().describe('Short label, e.g. "before vertical version"'), list: z.boolean().optional().describe('Only list checkpoints') })
    },
    {
      name: 'organize_project_bins',
      description: 'Tidy the Project panel the way an editor keeps it: bins "01 Footage" (video), "02 Audio" (music, VO, SFX), "03 Graphics" (images, PSD, AI, MOGRT), "04 Sequences", "05 Adjustment" (adjustment layers, mattes), "06 Proxies & renders" (AE renders, exports). Only moves items that sit loose in the root (dryRun to preview); never deletes or renames media.',
      inputSchema: z.object({ dryRun: z.boolean().optional().describe('Only report what would move'), all: z.boolean().optional().describe('Also move items already inside other bins (default false)') })
    },
    {
      name: 'qc_before_export',
      description: 'Check a sequence before delivery and report problems with their timecode: offline media, disabled clips, gaps (black frames), 1–2 frame leftover clips, clips still pointing at proxies? (reminder to toggle proxies off), red "low confidence" markers left from the rough cut, empty tracks, audio clips muted, sequence frame vs the intended delivery. Read-only; fix with mako (quality_check fix closes gaps), or by hand.',
      inputSchema: z.object({ ...seqRef, expectFrame: z.string().optional().describe('Expected frame, e.g. "1080x1920"') })
    }
    ,{
      name: 'transcribe_to_captions',
      description: 'Make captions for a cut from what the Dailies engine already heard (word timings in <source>/.dailies, written by rough_cut_by_cues or describe_sources): for every clip on the source track, the words inside its in/out are placed at its timeline position, split into lines of at most maxChars, written to "<project folder>/Phụ đề/<sequence>.srt" and added as a caption track. Spoken language is whatever was heard (Vietnamese, English…); slate calls outside the takes are not included. Edit the text in Premiere\'s Text panel afterwards.',
      inputSchema: z.object({
        ...seqRef,
        sourceTrack: z.number().int().min(0).optional().describe('Video track with the footage (default 0)'),
        maxChars: z.number().int().min(10).max(80).optional().describe('Characters per caption (default 42)'),
        addTrack: z.boolean().optional().describe('Import the SRT and create a caption track (default true)')
      })
    }
    ,{
      name: 'detect_beats',
      description: 'Find the beat of the music: tempo (BPM), every beat and the first beat of each bar. Give a file, or let it read the music already on the timeline (audio-only clips that are not named like a voiceover) and drop cyan markers "Nhịp 1" (bar 1) on each bar (markers: "beats" for every beat, "none" for no markers). Results are cached in <music folder>/.dailies. Check by ear: tempo can come out at half or double on sparse music.',
      inputSchema: z.object({
        ...seqRef,
        file: z.string().optional().describe('Music file to analyse instead of the timeline'),
        musicTrack: z.number().int().min(0).optional().describe('Audio track holding the music (default: any audio-only clip)'),
        markers: z.enum(['downbeats', 'beats', 'none']).optional().describe('Sequence markers to add (default downbeats); old "Nhịp" markers are replaced'),
        force: z.boolean().optional().describe('Re-analyse even if cached')
      })
    },
    {
      name: 'cut_to_beats',
      description: 'Re-time a cut to the music: a copy of the sequence ("<name> (theo nhịp)", i.e. "on the beat") where every clip on the video track keeps its in point and its end moves to the nearest beat (every: 1 = each beat, 2 = every other, 4 = each bar), so all cuts land on the beat. Motion (scale/position/rotation) is carried over; music and other tracks stay. The original sequence is not changed. dryRun shows the plan first.',
      inputSchema: z.object({
        ...seqRef,
        musicTrack: z.number().int().min(0).optional().describe('Audio track with the music (default: any audio-only clip)'),
        videoTrack: z.number().int().min(0).optional().describe('Video track to re-time (default 0)'),
        every: z.number().int().min(1).max(8).optional().describe('Cut on every n-th beat, counted from the bar start (default 1)'),
        minShot: z.number().min(0.1).optional().describe('Shortest shot in seconds (default 0.4)'),
        newSequenceName: z.string().optional(),
        dryRun: z.boolean().optional()
      })
    },
    {
      name: 'select_best_takes',
      description: 'Rank the takes of a footage folder from what the Dailies engine heard: ended on a cut call, cue confidence, how clearly the lines were spoken, retake calls ("otra vez", "again", "lại đi"…) in or right after the take, very short takes, later takes slightly preferred. Returns the ranking with reasons per file (groupBy "file") or overall ("none"); with sequenceName it also builds a selects sequence of the best take(s) with the score on each marker. Uses the same cache as rough_cut_by_cues. Always check the picks by eye.',
      inputSchema: z.object({
        sourceFolder: z.string().optional().describe('Footage folder. Default: the clips kept in the project after the junk was filtered out (with the proxies attached in Premiere); with a folder, only the project clips inside it, or the whole folder when none are imported'),
        bin: z.string().optional().describe('Only the clips in this project bin'),
        allowOriginal: z.boolean().optional().describe('Clips without a proxy: read the original file instead of stopping (heavier on the machine)'),
        groupBy: z.enum(['file', 'none']).optional().describe('Rank inside each file (default) or across the folder'),
        keep: z.number().int().min(1).optional().describe('Takes to keep per group (default 1)'),
        sequenceName: z.string().optional().describe('Build a selects sequence with this name'),
        frame: z.string().optional().describe('Frame for the selects sequence (default 1920x1080)'),
        fps: z.string().optional().describe('Sequence frame rate. Default: from inspect_footage'),
        gapSeconds: z.number().min(0).optional(),
        waitSeconds: z.number().optional(),
        fast: z.boolean().optional()
      })
    },
    {
      name: 'place_voiceover',
      description: 'Put a voiceover file on the timeline (at the playhead or at seconds) on the first free audio track and duck the music under it: Volume keyframes only where the voice actually speaks (silences longer than 0.35 s let the music back up), with short fades. Music = audio-only clips on other tracks, or the tracks in duckTracks. Keyframes stay editable in Effect Controls. To record a voice first, use a text-to-speech tool or skill.',
      inputSchema: z.object({
        ...seqRef,
        file: z.string().describe('Voiceover audio file'),
        at: z.number().min(0).optional().describe('Timeline seconds (default: playhead)'),
        track: z.number().int().min(0).optional().describe('Audio track for the voice (default: first free one)'),
        duckDb: z.number().max(0).optional().describe('Music change under the voice in dB (default -10)'),
        fadeSeconds: z.number().min(0).optional().describe('Duck fade (default 0.25)'),
        duckTracks: z.array(z.number().int().min(0)).optional().describe('Audio tracks to duck (default: music clips)'),
        voGainDb: z.number().optional().describe('Voice clip level in dB'),
        silenceDb: z.number().optional().describe('Silence threshold for the voice (default -35)')
      })
    },
    {
      name: 'normalize_loudness',
      description: 'Even out clip loudness on the timeline: each audio clip is measured (LUFS, only the part used) and its Volume level set so dialogue and voiceover sit at target (default -16) and music sits under the voice (musicTarget, default -26; music alone goes to target). Clips with ducking keyframes keep their shape, the whole curve is shifted. Gains are capped at +15 dB. dryRun shows the measurements first. The final mix is still normalised per platform by export_deliverables.',
      inputSchema: z.object({
        ...seqRef,
        tracks: z.array(z.number().int().min(0)).optional().describe('Audio tracks to touch (default all)'),
        target: z.number().optional().describe('Dialogue/voice target LUFS (default -16)'),
        musicTarget: z.number().optional().describe('Music under voice LUFS (default -26)'),
        musicTracks: z.array(z.number().int().min(0)).optional().describe('Force these tracks to be treated as music'),
        dialogueTracks: z.array(z.number().int().min(0)).optional().describe('Force these tracks to be treated as dialogue'),
        dryRun: z.boolean().optional()
      })
    },
    {
      name: 'review_cut',
      description: 'Look over a cut like an editor before showing it: shot count and pacing (average, shortest, longest, first shot for the hook), flash frames, shots held too long (maxShot, default 5 s), gaps, jump cuts inside the same shot, footage used twice, cuts off the music beat (when music is on the timeline), length against targetSeconds. Drops orange "Review:" markers (old ones replaced) and makes a contact sheet of one frame per shot (from proxies when present) in "<project folder>/Review/<sequence>/contact sheet.jpg".',
      inputSchema: z.object({
        ...seqRef,
        videoTrack: z.number().int().min(0).optional().describe('Video track to review (default 0)'),
        maxShot: z.number().min(0.5).optional().describe('Longest shot before it is flagged (default 5 s)'),
        targetSeconds: z.number().optional().describe('Wanted length'),
        musicTrack: z.number().int().min(0).optional(),
        checkBeats: z.boolean().optional().describe('Compare cuts with the music beat (default true)'),
        markers: z.boolean().optional().describe('Add Review markers (default true)'),
        contactSheet: z.boolean().optional().describe('Make the contact sheet (default true)')
      })
    }
    ,{
      name: 'review_unused_media',
      description: 'After delivery: find everything the job no longer uses, without changing anything. Usage is read from the timelines (nested sequences and multicam included): project items on no timeline (video, audio, stills, mattes, captions…), and on disk the unused imported files, their proxies, and media files sitting in the source folders that were never used. Delivery/render folders (Edited, Export, Xuất file, Render, Final, Bàn giao…) and the files in use with their proxies are always kept. keepSequences: only these sequences count as the job (the others are listed for removal too). Writes a report in ~/Library/Application Support/MCP Adobe/Don dep and returns a summary for the user to check. Then clean_unused_media.',
      inputSchema: z.object({
        keepSequences: z.array(z.string()).optional().describe('Sequence names that make the job (default: every sequence is kept and counts as used)'),
        jobFolder: z.string().optional().describe('Job folder: only files inside it may go to the Trash (default: the project\'s folder, or its parent when the project sits in a Project/Premiere/AE subfolder). Files from elsewhere (Soundly, music libraries) are only removed from the project.'),
        scanFolders: z.boolean().optional().describe('Also list unused media files lying in the source folders (default true)'),
        trashProxiesOfUsed: z.boolean().optional().describe('Also list proxies of the files still in use (default false: keep them for client changes)')
      })
    },
    {
      name: 'clean_unused_media',
      description: 'Act on a review_unused_media report after the user has read it: saves a checkpoint of the project, checks usage again right now (anything used since the report is skipped), removes the unused items from the Premiere project (plus bins left empty by it) and saves, then moves the unused files to the macOS Trash with Finder (Put Back works; nothing is deleted for good — the user empties the Trash). confirm must be true. Needs Finder automation permission the first time.',
      inputSchema: z.object({
        report: z.string().describe('Report path returned by review_unused_media'),
        removeFromProject: z.boolean().optional().describe('Remove the unused items from the project (default true)'),
        trashFiles: z.boolean().optional().describe('Move the unused files to the Trash (default true)'),
        confirm: z.boolean().describe('Must be true: the user has checked the report')
      })
    }
  ];
  return tools.filter((t) => !existingNames.has(t.name));
}

// ---------------------------------------------------------------- execution

export async function executeStudioTool(bridge: PremiereProTransport, name: string, args: Record<string, any>): Promise<any> {
  try {
    switch (name) {
      case 'rough_cut_by_cues': return await roughCut(bridge, args);
      case 'describe_sources': return await describeSources(bridge, args);
      case 'find_shots': return await findShots(bridge, args);
      case 'score_footage': return await scoreFootage(bridge, args);
      case 'inspect_footage': return await inspectFootage(bridge, args);
      case 'send_to_after_effects': return await sendToAe(bridge, args);
      case 'return_from_after_effects': return await returnFromAe(bridge, args);
      case 'create_aspect_versions': return await aspectVersions(bridge, args);
      case 'add_color_layer': return await addColorLayer(bridge, args);
      case 'mako': return await runMako(bridge, args);
      case 'add_color_matte': return await addColorMatte(bridge, args);
      case 'pr_guide': return prGuide(args);
      case 'export_deliverables': return await exportDeliverables(bridge, args);
      case 'export_status': return await exportStatus(args);
      case 'add_scene_color_layers': return await addSceneColorLayers(bridge, args);
      case 'sync_color_layers': return await syncColorLayers(bridge, args);
      case 'create_proxies': return await createProxies(bridge, args);
      case 'proxy_status': return await proxyStatus(args);
      case 'checkpoint_project': return await checkpointProject(bridge, args);
      case 'organize_project_bins': return await organizeBins(bridge, args);
      case 'qc_before_export': return await qcBeforeExport(bridge, args);
      case 'transcribe_to_captions': return await captions(bridge, args);
      case 'detect_beats': return await detectBeatsTool(bridge, args);
      case 'cut_to_beats': return await cutToBeats(bridge, args);
      case 'select_best_takes': return await selectBestTakes(bridge, args);
      case 'place_voiceover': return await placeVoiceover(bridge, args);
      case 'normalize_loudness': return await normalizeLoudness(bridge, args);
      case 'review_cut': return await reviewCut(bridge, args);
      case 'review_unused_media': return await reviewUnused(bridge, args);
      case 'clean_unused_media': return await cleanUnused(bridge, args);
    }
    return { success: false, error: 'unknown studio tool ' + name };
  } catch (e: any) {
    return { success: false, tool: name, error: String(e?.message || e) };
  }
}

export interface MediaTake {
  stt: number;
  id: string;
  file: string;
  ten_file: string;
  take_trong_file: number;
  vao_giay: number;
  ra_giay: number;
  do_dai_giay: number;
  khau_lenh_vao: { loai: string; chu: string } | null;
  khau_lenh_ra: { loai: string; chu: string } | null;
  ket_thuc_bang: string;
  do_tin_cay: number;
  ca_file: boolean;
  loi_thoai?: string;
  bo_cuc?: { cach: string; scale_phan_tram: number; vi_tri: { x: number; y: number }; vi_tri_chuan: { x: number; y: number } };
}

/** Timeline layout of the takes: start time on the new sequence and the marker text. Pure, for tests. */
export function layoutTakes(takes: MediaTake[], gap = 0, low = 0.6) {
  const sorted = [...takes].sort((a, b) => a.stt - b.stt);
  let t = 0;
  return sorted.map((k) => {
    const row = {
      id: k.id,
      file: k.file,
      in: k.vao_giay,
      out: k.ra_giay,
      at: Math.round(t * 1000) / 1000,
      name: `${k.ten_file.replace(/\.[^.]+$/, '')} T${k.take_trong_file}`,
      marker: k.ca_file
        ? `${k.id} · cả file (không nghe thấy khẩu lệnh)`
        : `${k.id} · vào: ${k.khau_lenh_vao?.chu ?? '?'} · ra: ${k.khau_lenh_ra?.chu ?? k.ket_thuc_bang} · tin cậy ${Math.round(k.do_tin_cay * 100)}%`,
      dialogue: k.loi_thoai ?? '',
      low: k.ca_file || k.do_tin_cay < low,
      scale: k.bo_cuc?.scale_phan_tram ?? null,
      pos: k.bo_cuc ? [k.bo_cuc.vi_tri_chuan.x, k.bo_cuc.vi_tri_chuan.y] : null
    };
    t += Math.max(0, k.ra_giay - k.vao_giay) + gap;
    return row;
  });
}

/** JSX: a new sequence with the takes laid end to end, a marker on each (shared by rough_cut_by_cues and select_best_takes). */
function takesSequenceJsx(seqName: string, files: string[], rows: ReturnType<typeof layoutTakes>, frame: { w: number; h: number } | null, gap: number, seed: string | null = null): string {
  // The sequence takes its frame rate from the clip it is created from: the seed is a clip at the recommended rate
  if (seed && !files.includes(seed)) files = [...files, seed];
  return `
var seqName=${q(seqName)};if(__seq(seqName,null))return JSON.stringify({success:false,error:'A sequence named '+seqName+' already exists — pick another sequenceName (nothing was changed).'});
var files=${q(files)};var rows=${q(rows)};
var bin=__bin(seqName);
var missing=[];for(var i=0;i<files.length;i++){if(!__byPath(files[i]))missing.push(files[i]);}
if(missing.length)app.project.importFiles(missing,true,bin,false);
var items={};for(var i=0;i<files.length;i++){var it=__byPath(files[i]);if(!it)return JSON.stringify({success:false,error:'import failed: '+files[i]});items[files[i]]=it;}
var seq=app.project.createNewSequenceFromClips(seqName,[items[${q(seed)}||rows[0].file]],bin);
if(!seq)return JSON.stringify({success:false,error:'could not create the sequence'});
var frame=${q(frame)};var frameSet=null;
if(frame){try{var st=seq.getSettings();st.videoFrameWidth=frame.w;st.videoFrameHeight=frame.h;seq.setSettings(st);frameSet=seq.frameSizeHorizontal+'x'+seq.frameSizeVertical;}catch(eS){frameSet='failed: '+eS;}}
for(var v=0;v<seq.videoTracks.numTracks;v++){var vt=seq.videoTracks[v];for(var k=vt.clips.numItems-1;k>=0;k--)vt.clips[k].remove(false,false);}
for(var a=0;a<seq.audioTracks.numTracks;a++){var at=seq.audioTracks[a];for(var k=at.clips.numItems-1;k>=0;k--)at.clips[k].remove(false,false);}
var placed=0,errors=[];var cursor=0;var gap=${q(gap)};
for(var r=0;r<rows.length;r++){var row=rows[r];var it=items[row.file];
 try{it.setInPoint(row['in'],4);it.setOutPoint(row.out,4);}catch(e1){try{it.setInPoint(row['in']);it.setOutPoint(row.out);}catch(e2){}}
 var hasVideo=true;try{hasVideo=!/\\.(wav|mp3|aif|aiff|m4a|aac|flac)$/i.test(row.file);}catch(e3){}
 var tr=hasVideo?seq.videoTracks[0]:seq.audioTracks[0];
 // Place at the real end of the previous take: Premiere snaps durations to frames,
 // so precomputed positions drift and leave hairline gaps.
 tr.overwriteClip(it,cursor);
 var got=null;for(var c=0;c<tr.clips.numItems;c++){var cl=tr.clips[c];if(Math.abs(cl.start.seconds-cursor)<0.05&&cl.projectItem&&cl.projectItem.nodeId==it.nodeId){got=cl;break;}}
 if(!got){errors.push(row.id+': not placed');continue;}
 try{got.name=row.name;}catch(e4){}
 if(row.scale!==null){var M=__comp(got,'Motion');var pS=__prop(M,'Scale');var pP=__prop(M,'Position');try{if(pS)pS.setValue(row.scale,true);if(pP&&row.pos)pP.setValue(row.pos,true);}catch(e9){errors.push(row.id+': motion '+e9);}}
 placed++;
 var m=seq.markers.createMarker(got.start.seconds);m.name=row.name;m.comments=row.marker+(row.dialogue?'\\n'+row.dialogue:'');
 try{m.end=got.end;}catch(e5){}
 cursor=got.end.seconds+gap;
 if(row.low){try{m.setColorByIndex(1);}catch(e6){}}
}
for(var f in items){try{items[f].clearInPoint();items[f].clearOutPoint();}catch(e7){}}
try{app.project.openSequence(seq.sequenceID);}catch(e8){}
return JSON.stringify({success:true,sequence:seq.name,sequenceId:seq.sequenceID,frame:frameSet,placed:placed,errors:errors});`;
}

/**
 * What the Dailies engine should look at: the clips the user kept in the project
 * (after filtering the junk) with the proxies attached in Premiere, passed as a
 * --danh-sach file; or a whole folder when nothing from it is imported.
 */
async function mediaSource(bridge: PremiereProTransport, args: Record<string, any>): Promise<{ cli: string[]; folder: string | null; clips: number } | { error: string }> {
  const folder = args.sourceFolder ? String(args.sourceFolder) : null;
  const r = await jsx(bridge, `var want=${q(folder)};var binName=${q(args.bin ?? null)};var out=[];var re=/\\.(mp4|mov|mxf|mts|m2ts|avi|mkv)$/i;var px0=/_Proxy\\.mov$/i;var skip=${q(HANDOFF_DIR.toLowerCase())};
function inBin(b){if(!binName)return app.project.rootItem;var hit=null;__walk2(app.project.rootItem,function(c){if(!hit&&c.type==2&&c.name==binName)hit=c;});return hit;}
function __walk2(bin,fn){for(var i=0;i<bin.children.numItems;i++){var c=bin.children[i];fn(c);if(c.type==2)__walk2(c,fn);}}
var root=inBin();if(!root)return JSON.stringify({success:false,error:'no bin named '+binName});
__walk2(root,function(c){if(c.type!=1)return;var p=null;try{p=String(c.getMediaPath());}catch(e){}if(!p||!re.test(p)||px0.test(p)||p.toLowerCase().indexOf(skip)===0)return;
 if(want&&p.toLowerCase().indexOf(String(want).toLowerCase())!==0)return;var px=null;try{if(c.hasProxy())px=String(c.getProxyPath());}catch(e2){}
 for(var k=0;k<out.length;k++)if(out[k].file==p)return;out.push({file:p,proxy:px});});
return JSON.stringify({success:true,clips:out});`);
  const list = (r?.success ? r.clips : []) as { file: string; proxy: string | null }[];
  const extra = args.allowOriginal ? ['--cho-phep-goc'] : [];
  if (list.length) {
    const body = JSON.stringify({ clip: list });
    const dir = join(homedir(), 'Library', 'Application Support', 'MCP Adobe', 'Danh sach clip');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${createHash('sha1').update(body).digest('hex').slice(0, 12)}.json`);
    if (!existsSync(file)) writeFileSync(file, body, 'utf8');
    const common = list.map((c) => c.file.replace(/[^/]+$/, '')).reduce((a, b) => { let i = 0; while (i < a.length && a[i] === b[i]) i++; return a.slice(0, a.lastIndexOf('/', i - 1) + 1); });
    return { cli: ['--danh-sach', file, ...extra], folder: common.replace(/\/$/, '') || folder, clips: list.length };
  }
  if (folder && existsSync(folder)) return { cli: [folder, ...extra], folder, clips: 0 };
  return { error: folder ? `folder not found: ${folder}` : (r?.success ? 'no footage in the project — import and filter the clips first, or pass sourceFolder' : String(r?.error ?? 'Premiere did not answer')) };
}

async function roughCut(bridge: PremiereProTransport, args: Record<string, any>) {
  const src = await mediaSource(bridge, args);
  if ('error' in src) return { success: false, tool: 'rough_cut_by_cues', error: src.error };
  const folder = src.folder ?? 'footage';
  const cli = ['take-khau-lenh', ...src.cli, '--json'];
  if (args.model) cli.push('--model', String(args.model));
  if (args.dropNoCue) cli.push('--bo-file-khong-lenh');
  cli.push('--khung', String(args.frame ?? '1920x1080'));
  const job = await runDailies(cli, (args.waitSeconds ?? 45) * 1000, args.fast !== false);
  const problem = dailiesProblem(job, 'rough_cut_by_cues');
  if (problem) return problem;
  const out = parseDailies(job);
  const takes = out.take as MediaTake[];
  if (!takes?.length) return { success: false, error: 'no takes found in this folder', detail: out };
  const rows = layoutTakes(takes, args.gapSeconds ?? 0, args.lowConfidence ?? 0.6);
  const summary = { files: out.so_file, takes: out.so_take, noCueFiles: (out.file_khong_co_khau_lenh ?? []).length, cache: out.file_ket_qua };
  if (args.analyzeOnly) return { success: true, ...summary, takes: rows };

  const seqName = String(args.sequenceName || `Rough cut ${basename(folder)}`);
  const files = Array.from(new Set(rows.map((r) => r.file)));
  const frame = out.khung ? { w: out.khung.rong, h: out.khung.cao } : null;
  const insp = await inspectFor(src, args.frame ?? '1920x1080', args.fps);
  const seed = insp ? seedFile(files, insp.byFile, insp ? insp.sequence.fps.tu / insp.sequence.fps.mau : 0) : null;
  const body = takesSequenceJsx(seqName, files, rows, frame, args.gapSeconds ?? 0, seed);
  const r = await jsx(bridge, body, 600000);
  return { tool: 'rough_cut_by_cues', ...r, ...summary, lowConfidence: rows.filter((x) => x.low).map((x) => x.name), inspection: inspectionNote(insp, seed) };
}

async function describeSources(bridge: PremiereProTransport, args: Record<string, any>) {
  const src = await mediaSource(bridge, args);
  if ('error' in src) return { success: false, tool: 'describe_sources', error: src.error };
  const cli = ['mo-ta-shot', ...src.cli, '--che-do', args.mode === 'deep' ? 'ky' : 'nhanh', '--json'];
  const job = await runDailies(cli, (args.waitSeconds ?? 45) * 1000, true);
  const problem = dailiesProblem(job, 'describe_sources');
  if (problem) return problem;
  const out = parseDailies(job);
  const shots = (out.shot ?? []).map((s: any) => ({
    file: s.file,
    description: s.mo_ta,
    labels: Object.fromEntries(Object.entries(s.nhan ?? {}).map(([k, v]: [string, any]) => [k, v?.nhan])),
    quality: s.chat_luong,
    note: [
      s.chat_luong?.net !== undefined && s.chat_luong.net < 20 ? 'mờ' : null,
      s.chat_luong?.rung !== undefined && s.chat_luong.rung > 12 ? 'rung' : null,
      s.chat_luong?.chay > 0.05 ? 'cháy sáng' : null,
      s.chat_luong?.den > 0.2 ? 'tối' : null
    ].filter(Boolean).join(', ')
  }));
  let written: any = null;
  if (args.writeToProject !== false) {
    const body = `
var shots=${q(shots)};var NS='http://ns.adobe.com/premierePrivateProjectMetaData/1.0/';var n=0,missing=[];
for(var i=0;i<shots.length;i++){var it=__byPath(shots[i].file);if(!it){missing.push(shots[i].file);continue;}
 try{it.setProjectMetadata(shots[i].description,[NS+'Column.PropertyText.Comment']);}catch(e1){}
 var qn=shots[i].quality||{};var log='đẹp '+(qn.diem_dep!==undefined?Math.round(qn.diem_dep*100):'?')+'%'+(shots[i].note?' · '+shots[i].note:'');
 try{it.setProjectMetadata(log,[NS+'Column.Intrinsic.LogNote']);}catch(e2){}
 n++;}
return JSON.stringify({success:true,written:n,notImported:missing.length});`;
    written = await jsx(bridge, body, 120000);
  }
  return { success: true, tool: 'describe_sources', mode: out.che_do, model: out.model, secondsPerImage: out.giay_moi_anh, shots, project: written, warnings: out.canh_bao };
}

export interface MediaHit {
  hang: number;
  file: string;
  ten_file: string;
  vao_giay: number;
  ra_giay: number;
  dinh_giay: number;
  diem: number;
}

/** Timeline rows for the hits of a search (same shape as layoutTakes, for takesSequenceJsx). Pure, for tests. */
export function layoutHits(hits: MediaHit[], query: string) {
  let t = 0;
  return [...hits].sort((a, b) => a.hang - b.hang).map((h) => {
    const row = {
      id: `#${h.hang}`,
      file: h.file,
      in: h.vao_giay,
      out: h.ra_giay,
      at: Math.round(t * 1000) / 1000,
      name: `${h.ten_file.replace(/\.[^.]+$/, '')} #${h.hang}`,
      marker: `Tìm: ${query} · #${h.hang} · khớp nhất ${h.dinh_giay}s · điểm ${h.diem}`,
      dialogue: '',
      low: false,
      scale: null as number | null,
      pos: null as number[] | null
    };
    t += Math.max(0, h.ra_giay - h.vao_giay);
    return row;
  });
}

/** Recommended sequence and per-file fit from `dailies thuoc-tinh`. */
interface Inspection {
  sequence: { rong: number; cao: number; fps: { tu: number; mau: number }; fps_ten: string; ly_do: string };
  byFile: Map<string, { scale: number | null; fps: number | null; notes: string[] }>;
  todo: string[];
  totals: any;
  cache: string;
}

function inspectionCli(src: { cli: string[] }, frame?: string, fps?: string): string[] {
  const cli = ['thuoc-tinh', ...src.cli.filter((x) => x !== '--cho-phep-goc'), '--json'];
  if (frame) cli.push('--khung', String(frame));
  if (fps) cli.push('--fps', String(fps));
  return cli;
}

function readInspection(out: any): Inspection {
  const byFile = new Map<string, { scale: number | null; fps: number | null; notes: string[] }>();
  for (const c of out.clip ?? []) byFile.set(c.file, { scale: c.xu_ly?.khung?.scale_phan_tram ?? null, fps: c.fps_so ?? null, notes: c.chu_y ?? [] });
  return { sequence: out.sequence, byFile, todo: out.viec_can_lam ?? [], totals: out.tong_hop, cache: out.file_ket_qua };
}

/** Run the property scan for a building tool; null when it cannot (the tool then falls back to the first clip). */
async function inspectFor(src: { cli: string[] }, frame?: string, fps?: string): Promise<Inspection | null> {
  const job = await runDailies(inspectionCli(src, frame, fps), 180000, true);
  if (!job.done || job.code !== 0) return null;
  const out = parseDailies(job);
  return out?.sequence ? readInspection(out) : null;
}

/** First file whose frame rate matches the recommended sequence rate, to create the sequence from. Pure, for tests. */
export function seedFile(files: string[], rates: Map<string, { fps: number | null }>, fps: number): string | null {
  return files.find((f) => { const r = rates.get(f)?.fps; return r !== null && r !== undefined && Math.abs(r - fps) < 0.01; }) ?? null;
}

function inspectionNote(insp: Inspection | null, seed: string | null) {
  if (!insp) return { ran: false, note: 'property scan unavailable: the sequence copies the first clip; run inspect_footage to see why' };
  return {
    ran: true, sequence: `${insp.sequence.rong}x${insp.sequence.cao} ${insp.sequence.fps_ten} fps (${insp.sequence.ly_do})`,
    createdFrom: seed ? basename(seed) : 'first clip (no clip at the recommended rate)', todo: insp.todo, cache: insp.cache
  };
}

async function inspectFootage(bridge: PremiereProTransport, args: Record<string, any>) {
  const src = await mediaSource(bridge, args);
  if ('error' in src) return { success: false, tool: 'inspect_footage', error: src.error };
  const job = await runDailies(inspectionCli(src, args.frame, args.fps), (args.waitSeconds ?? 60) * 1000, true);
  const problem = dailiesProblem(job, 'inspect_footage');
  if (problem) return problem;
  const out = parseDailies(job);
  const attention = (out.clip ?? []).filter((c: any) => (c.chu_y ?? []).length);
  return {
    success: true, tool: 'inspect_footage', sequence: out.sequence, totals: out.tong_hop, todo: out.viec_can_lam,
    attention: attention.slice(0, 40).map((c: any) => ({ clip: c.ten_file, size: `${c.rong_hien}x${c.cao_hien}`, fps: c.fps_so, shotAt: c.fps_quay,
      log: c.log, scale: c.xu_ly?.khung?.scale_phan_tram, notes: c.chu_y })),
    moreNeedingAttention: Math.max(0, attention.length - 40), seconds: out.giay_xu_ly, cache: out.file_ket_qua,
    next: 'Tell the user the sequence settings and the todo list before editing; ask about log colour handling and slow motion if they matter for the brief.'
  };
}

export interface DailiesSegment {
  vao_giay: number;
  ra_giay: number;
  diem_tb: number;
  diem_dinh: number;
  giay_dinh: number;
  muc: 'tot' | 'kha' | 'dat';
  may: string;
  co: string[];
}

const GRADE: Record<string, string> = { tot: 'tốt', kha: 'khá', dat: 'đạt' };
const CAMERA: Record<string, string> = {
  dung_yen: 'đứng yên', lia_trai: 'lia trái', lia_phai: 'lia phải', nghieng_len: 'nghiêng lên', nghieng_xuong: 'nghiêng xuống',
  zoom_vao: 'zoom vào', zoom_ra: 'zoom ra', xoay_trai: 'xoay trái', xoay_phai: 'xoay phải', hon_hop: 'hỗn hợp'
};

/** Selects of a cham-diem result as sequence rows (shared layout with the takes). Pure, for tests. */
export function layoutSelects(clips: { file: string; ten_file: string; thoi_luong_giay: number; doan: DailiesSegment[] }[], order: 'file' | 'score' = 'file', gap = 0, handles = 0) {
  const all = clips.flatMap((c) => c.doan.map((d, i) => ({ c, d, i })));
  if (order === 'score') all.sort((a, b) => b.d.diem_tb - a.d.diem_tb);
  let t = 0;
  return all.map(({ c, d, i }) => {
    const inS = Math.max(0, d.vao_giay - handles);
    const outS = Math.min(c.thoi_luong_giay || d.ra_giay + handles, d.ra_giay + handles);
    const row = {
      id: `${c.ten_file.replace(/\.[^.]+$/, '')}-s${i + 1}`,
      file: c.file,
      in: Math.round(inS * 1000) / 1000,
      out: Math.round(outS * 1000) / 1000,
      at: Math.round(t * 1000) / 1000,
      name: `${c.ten_file.replace(/\.[^.]+$/, '')} S${i + 1}`,
      marker: `điểm ${d.diem_tb.toFixed(2)} (đỉnh ${d.diem_dinh.toFixed(2)} ở ${d.giay_dinh.toFixed(1)} s) · ${GRADE[d.muc] ?? d.muc} · ${CAMERA[d.may] ?? d.may}${d.co.length ? ' · cờ: ' + d.co.join(', ') : ''}`,
      dialogue: '',
      low: d.muc === 'dat',
      score: d.diem_tb,
      scale: null as number | null,
      pos: null as number[] | null
    };
    t += outS - inS + gap;
    return row;
  });
}

async function scoreFootage(bridge: PremiereProTransport, args: Record<string, any>) {
  const src = await mediaSource(bridge, args);
  if ('error' in src) return { success: false, tool: 'score_footage', error: src.error };
  const kind = ({ balanced: 'can_bang', b_roll: 'b_roll', static: 'tinh' } as Record<string, string>)[args.kind ?? 'balanced'] ?? 'can_bang';
  const cli = ['cham-diem', ...src.cli, '--json', '--kieu', kind];
  if (args.threshold !== undefined) cli.push('--nguong', String(args.threshold));
  if (args.minSeconds !== undefined) cli.push('--ngan-nhat', String(args.minSeconds));
  if (args.bridgeSeconds !== undefined) cli.push('--noi-khoang', String(args.bridgeSeconds));
  const job = await runDailies(cli, (args.waitSeconds ?? 45) * 1000, args.fast !== false);
  const problem = dailiesProblem(job, 'score_footage');
  if (problem) return problem;
  const out = parseDailies(job);
  const clips = (out.clip ?? []) as any[];
  const order = args.order === 'score' ? 'score' : 'file';
  const rows = layoutSelects(clips, order, args.gapSeconds ?? 0, args.handles ?? 0);
  const result: any = {
    success: true, tool: 'score_footage', kind: args.kind ?? 'balanced', threshold: out.cai_dat?.nguong,
    clips: out.so_clip, clipsWithSelects: out.so_clip_co_doan, segments: out.so_doan,
    selectedSeconds: Math.round(rows.reduce((a, r) => a + r.out - r.in, 0) * 10) / 10,
    scannedNow: out.so_clip_quet_moi, seconds: out.giay_xu_ly, cache: out.file_ket_qua,
    best: [...rows].sort((a, b) => b.score - a.score).slice(0, 10).map((r) => ({ clip: r.name, in: r.in, out: r.out, note: r.marker })),
    noSelects: clips.filter((c) => !c.doan.length).map((c) => c.ten_file)
  };
  if (!rows.length) return { ...result, note: 'nothing reached the threshold; lower threshold or try kind b_roll' };
  if (args.sequenceName) {
    const files = Array.from(new Set(rows.map((r) => r.file)));
    const insp = await inspectFor(src, args.frame, args.fps);
    if (insp) for (const r of rows) {
      // Fit to frame: every clip not at the sequence size is scaled to it (4K in Full HD = 50 %)
      const sc = insp.byFile.get(r.file)?.scale;
      if (sc !== null && sc !== undefined && Math.abs(sc - 100) > 0.01) r.scale = sc;
    }
    const frame = insp ? { w: insp.sequence.rong, h: insp.sequence.cao } : null;
    const seed = insp ? seedFile(files, insp.byFile, insp ? insp.sequence.fps.tu / insp.sequence.fps.mau : 0) : null;
    result.sequence = await jsx(bridge, takesSequenceJsx(String(args.sequenceName), files, rows, frame, args.gapSeconds ?? 0, seed), 600000);
    result.inspection = inspectionNote(insp, seed);
  }
  if (Array.isArray(args.exportFormats) && args.exportFormats.length) {
    const xcli = ['xuat', String(out.file_ket_qua), '--json', '--dinh-dang', args.exportFormats.join(','), '--thu-tu', order,
      '--khoang', String(args.gapSeconds ?? 0), '--dem', String(args.handles ?? 0)];
    if (args.exportFolder) xcli.push('--ra', String(args.exportFolder));
    if (args.sequenceName) xcli.push('--ten', String(args.sequenceName));
    const xj = await runDailies(xcli, 120000, true);
    const xp = dailiesProblem(xj, 'score_footage');
    result.export = xp ?? { files: parseDailies(xj)?.tep };
  }
  return result;
}

async function findShots(bridge: PremiereProTransport, args: Record<string, any>) {
  const query = String(args.query ?? '').trim();
  if (!query) return { success: false, tool: 'find_shots', error: 'query is empty' };
  const src = await mediaSource(bridge, args);
  if ('error' in src) return { success: false, tool: 'find_shots', error: src.error };
  const cli = ['tim-shot', query, ...src.cli, '--top', String(args.top ?? 8), '--json'];
  const job = await runDailies(cli, (args.waitSeconds ?? 45) * 1000, true);
  const problem = dailiesProblem(job, 'find_shots');
  if (problem) {
    if (problem.missingModel) problem.hint = 'Shot search needs SigLIP 2: run `uv run dailies tai-model --json` in MCP Adobe/Dailies (about 380 MB, ask the user first).';
    return problem;
  }
  const out = parseDailies(job);
  const hits = (out.ket_qua ?? []) as MediaHit[];
  const result: any = {
    success: true, tool: 'find_shots', query, searched: src.clips || null, cache: out.file_ket_qua,
    hits: hits.map((h) => ({ rank: h.hang, file: h.file, in: h.vao_giay, out: h.ra_giay, best: h.dinh_giay, score: h.diem }))
  };
  if (!hits.length) return { ...result, note: 'nothing matched' };
  if (args.markers !== false) {
    const body = `
var hits=${q(hits)};var tag=${q(`Tìm: ${query}`)};var n=0,notImported=[];var done={};
for(var i=0;i<hits.length;i++){var h=hits[i];var it=__byPath(h.file);if(!it){notImported.push(h.file);continue;}
 var ms=it.getMarkers();if(!ms){notImported.push(h.file);continue;}
 if(!done[h.file]){var old=[];var m0=ms.getFirstMarker();while(m0){if(String(m0.name).indexOf(tag+' #')===0)old.push(m0);m0=ms.getNextMarker(m0);}
  for(var k=0;k<old.length;k++){try{ms.deleteMarker(old[k]);}catch(eD){}}done[h.file]=true;}
 var m=ms.createMarker(h.vao_giay);m.name=tag+' #'+h.hang;m.comments='khớp nhất '+h.dinh_giay+'s · điểm '+h.diem;
 try{m.end=h.ra_giay;}catch(eE){}n++;}
return JSON.stringify({success:true,markers:n,notImported:notImported});`;
    result.project = await jsx(bridge, body, 120000);
  }
  if (args.placeOnTimeline) {
    const rows = layoutHits(hits, query);
    const files = Array.from(new Set(rows.map((r) => r.file)));
    result.sequence = await jsx(bridge, takesSequenceJsx(`Tìm: ${query}`, files, rows, null, 0), 600000);
  }
  return result;
}

async function sendToAe(bridge: PremiereProTransport, args: Record<string, any>) {
  const vt = args.videoTrack ?? 0;
  const body = `
var s=(${q(args.sequenceName)}||${q(args.sequenceId)})?__seq(${q(args.sequenceName)},${q(args.sequenceId)}):app.project.activeSequence;
if(!s)return JSON.stringify({success:false,error:'sequence not found'});
var tr=s.videoTracks[${vt}];if(!tr)return JSON.stringify({success:false,error:'no video track ${vt}'});
var idx=${q(args.clipIndex)};
if(idx===null){var ph=s.getPlayerPosition().seconds;for(var i=0;i<tr.clips.numItems;i++){if(tr.clips[i].start.seconds<=ph&&tr.clips[i].end.seconds>ph){idx=i;break;}}}
if(idx===null||!tr.clips[idx])return JSON.stringify({success:false,error:'no clip at the playhead on V${vt + 1} — pass clipIndex'});
var c=tr.clips[idx];var pi=c.projectItem;var path=pi&&pi.getMediaPath?pi.getMediaPath():'';
if(!path)return JSON.stringify({success:false,error:'clip has no media file (nested sequence, graphic or synthetic item)'});
var speed=1;try{speed=c.getSpeed();}catch(e1){}
var M=__comp(c,'Motion');var pos=null,sc=null,rot=null;
try{var pp=__prop(M,'Position');if(pp)pos=pp.getValue();}catch(e2){}
try{var ps=__prop(M,'Scale');if(ps)sc=ps.getValue();}catch(e3){}
try{var pr=__prop(M,'Rotation');if(pr)rot=pr.getValue();}catch(e4){}
var fd=s.getSettings().videoFrameRate.seconds;
return JSON.stringify({success:true,projectPath:app.project.path,sequenceId:s.sequenceID,sequenceName:s.name,clipIndex:idx,clipName:c.name,
 timelineStart:c.start.seconds,timelineEnd:c.end.seconds,inPoint:c.inPoint.seconds,outPoint:c.outPoint.seconds,mediaPath:path,speed:speed,
 position:pos,scale:sc,rotation:rot,fps:fd>0?1/fd:25,width:s.frameSizeHorizontal,height:s.frameSizeVertical});`;
  const r = await jsx(bridge, body);
  if (!r?.success) return { tool: 'send_to_after_effects', ...r };
  // Only a real clip report becomes a handoff file.
  if (typeof r.mediaPath !== 'string' || !r.mediaPath || typeof r.timelineStart !== 'number' || typeof r.timelineEnd !== 'number' || typeof r.inPoint !== 'number') {
    return { success: false, tool: 'send_to_after_effects', error: 'Premiere did not report the clip (media path, in/out, timeline position)', raw: r };
  }
  const h: Handoff = {
    version: 1,
    id: `${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`,
    created: new Date().toISOString(),
    status: 'sent',
    premiere: {
      projectPath: r.projectPath || null, sequenceId: r.sequenceId, sequenceName: r.sequenceName, videoTrack: vt,
      clipIndex: r.clipIndex, clipName: r.clipName, timelineStart: r.timelineStart, timelineEnd: r.timelineEnd,
      fps: Math.round(r.fps * 1000) / 1000, width: r.width, height: r.height
    },
    source: {
      mediaPath: r.mediaPath, inPoint: r.inPoint, outPoint: r.outPoint, handles: args.handles ?? 1, speed: r.speed,
      motion: { position: Array.isArray(r.position) ? r.position : null, scale: typeof r.scale === 'number' ? r.scale : null, rotation: typeof r.rotation === 'number' ? r.rotation : null }
    },
    ...(args.note ? { note: String(args.note) } : {})
  };
  const file = writeHandoff(h);
  return {
    success: true, tool: 'send_to_after_effects', handoff: h.id, file, clip: h.premiere.clipName,
    duration: Math.round((h.premiere.timelineEnd - h.premiere.timelineStart) * 1000) / 1000,
    warnings: Math.abs(r.speed - 1) > 0.001 ? [`clip speed is ${r.speed}×: the AE comp plays the source at that speed`] : [],
    next: `After Effects MCP: ae_do bridge.from_premiere { handoff: "${h.id}" }`
  };
}

async function returnFromAe(bridge: PremiereProTransport, args: Record<string, any>) {
  const h = readHandoff(String(args.handoff));
  if (!h) return { success: false, error: `no handoff ${args.handoff} in ${HANDOFF_DIR}` };
  if (!h.ae?.renderPath || !existsSync(h.ae.renderPath)) {
    return { success: false, error: 'nothing rendered yet for this handoff', hint: `After Effects MCP: ae_do bridge.to_premiere { handoff: "${h.id}" }` };
  }
  const track = args.targetTrack ?? h.premiere.videoTrack + 1;
  const dur = h.premiere.timelineEnd - h.premiere.timelineStart;
  const handleIn = h.ae.handleIn ?? 0;
  const body = `
var s=__seq(${q(h.premiere.sequenceName)},${q(h.premiere.sequenceId)});if(!s)return JSON.stringify({success:false,error:'sequence not found'});
var path=${q(h.ae!.renderPath)};var it=__byPath(path);var refreshed=false;
if(it){try{it.refreshMedia();refreshed=true;}catch(e0){}}
else{var bin=__bin('Từ After Effects');app.project.importFiles([path],true,bin,false);it=__byPath(path);}
if(!it)return JSON.stringify({success:false,error:'import failed: '+path});
var name='AE · '+${q(h.premiere.clipName)};var at=${h.premiere.timelineStart};
while(s.videoTracks.numTracks<=${track}){app.enableQE();app.project.openSequence(s.sequenceID);qe.project.getActiveSequence().addTracks(1,s.videoTracks.numTracks,0);}
var tr=s.videoTracks[${track}];
var existing=null;for(var i=0;i<tr.clips.numItems;i++){var c=tr.clips[i];if(c.projectItem&&c.projectItem.nodeId==it.nodeId&&Math.abs(c.start.seconds-at)<0.05)existing=c;}
if(!existing){
 for(var i=0;i<tr.clips.numItems;i++){var c=tr.clips[i];if(c.start.seconds<at+${dur}-0.01&&c.end.seconds>at+0.01)return JSON.stringify({success:false,error:'V'+(${track}+1)+' already has a clip there ('+c.name+') — pass targetTrack'});}
 try{it.setInPoint(${handleIn},4);it.setOutPoint(${handleIn + dur},4);}catch(e1){try{it.setInPoint(${handleIn});it.setOutPoint(${handleIn + dur});}catch(e2){}}
 tr.overwriteClip(it,at);
 for(var i=0;i<tr.clips.numItems;i++){var c=tr.clips[i];if(c.projectItem&&c.projectItem.nodeId==it.nodeId&&Math.abs(c.start.seconds-at)<0.05)existing=c;}
 try{it.clearInPoint();it.clearOutPoint();}catch(e3){}
 if(!existing)return JSON.stringify({success:false,error:'placement could not be confirmed'});
 try{existing.name=name;}catch(e4){}
}
var orig=s.videoTracks[${h.premiere.videoTrack}];var off=null;
if(${args.disableOriginal !== false}){for(var i=0;i<orig.clips.numItems;i++){var o=orig.clips[i];if(Math.abs(o.start.seconds-at)<0.05&&o.name==${q(h.premiere.clipName)}){o.disabled=true;off=o.name;}}}
return JSON.stringify({success:true,placed:existing.name,track:${track},start:existing.start.seconds,end:existing.end.seconds,refreshed:refreshed,originalDisabled:off});`;
  const r = await jsx(bridge, body, 180000);
  if (r?.success) {
    h.status = 'returned';
    h.returned = { track, clipName: r.placed, at: new Date().toISOString() };
    writeHandoff(h);
  }
  return { tool: 'return_from_after_effects', handoff: h.id, ...r };
}

// ---------------------------------------------------------------- colour layer and aspect versions

const SEQ_PICK = (args: Record<string, any>): string =>
  `var s=(${q(args.sequenceName)}||${q(args.sequenceId)})?__seq(${q(args.sequenceName)},${q(args.sequenceId)}):app.project.activeSequence;if(!s)return JSON.stringify({success:false,error:'sequence not found'});`;

/** Mako's template project holding an adjustment layer (Mako is installed as a CEP panel). */
export const MAKO_TEMPLATE = join(homedir(), 'Library', 'Application Support', 'Adobe', 'CEP', 'extensions', 'com.basicsstudio.mako', 'templates', 'adjustment-layer.prproj');

/** JSX: the project's adjustment layer item — imported through Mako's template when there is none — or null. */
const FIND_ADJ = `function __adjPrepare(){if(typeof makoPrepareAdjustmentLayer!=='function')return false;try{makoPrepareAdjustmentLayer(${JSON.stringify(MAKO_TEMPLATE)});return true;}catch(e){return false;}}
function __adjOrMake(){var a=__adj();if(a)return a;if(__adjPrepare())a=__adj();return a;}
function __adj(){var hit=null;__walk(app.project.rootItem,function(c){if(hit)return;var a=false;try{a=c.isAdjustmentLayer&&c.isAdjustmentLayer();}catch(e){}if(a)hit=c;});return hit;}
function __isAdj(c){try{return !!(c.projectItem&&c.projectItem.isAdjustmentLayer&&c.projectItem.isAdjustmentLayer());}catch(e){return false;}}`;

const LUMETRI_NAMES: Record<string, string> = {
  temperature: 'Temperature', tint: 'Tint', saturation: 'Saturation', exposure: 'Exposure', contrast: 'Contrast',
  highlights: 'Highlights', shadows: 'Shadows', whites: 'Whites', blacks: 'Blacks', vibrance: 'Vibrance'
};

async function addColorLayer(bridge: PremiereProTransport, args: Record<string, any>) {
  for (const k of Object.keys(args.basic ?? {})) if (!LUMETRI_NAMES[k]) return { success: false, error: `unknown Lumetri control '${k}' (${Object.keys(LUMETRI_NAMES).join(', ')})` };
  const body = `${SEQ_PICK(args)}${FIND_ADJ}
var adj=__adjOrMake();if(!adj)return JSON.stringify({success:false,needsAdjustmentLayer:true,error:'No Adjustment Layer in the project and Mako could not import its template. Make one once: File → New → Adjustment Layer (any size), then call again.'});
var a=${q(args.start ?? 0)};var b=${q(args.end ?? null)};if(b===null)b=s.end/254016000000;
app.enableQE();app.project.openSequence(s.sequenceID);var qs=qe.project.getActiveSequence();
qs.addTracks(1,s.videoTracks.numTracks,0);var ti=s.videoTracks.numTracks-1;var tr=s.videoTracks[ti];
try{adj.setInPoint(0,4);adj.setOutPoint(Math.max(0.1,b-a),4);}catch(e1){}
tr.overwriteClip(adj,a);
var c=null;for(var i=0;i<tr.clips.numItems;i++)if(Math.abs(tr.clips[i].start.seconds-a)<0.05)c=tr.clips[i];
try{adj.clearInPoint();adj.clearOutPoint();}catch(e2){}
if(!c)return JSON.stringify({success:false,error:'placement could not be confirmed'});
if(Math.abs(c.end.seconds-b)>0.001){try{c.end=__T(b);}catch(e3){}}
try{c.name=${q(args.name ?? 'Màu tổng')};}catch(e4){}
var M=__comp(c,'Motion');var adjW=0,adjH=0;
try{var vi=String(adj.getProjectMetadata()).match(/VideoInfo>\\s*(\\d+)\\s*x\\s*(\\d+)/);if(vi){adjW=+vi[1];adjH=+vi[2];}}catch(e5){}
if(adjW>0){var k=Math.max(s.frameSizeHorizontal/adjW,s.frameSizeVertical/adjH)*100;var pS=__prop(M,'Scale');if(pS&&k>100.01)pS.setValue(k,true);}
var qi=null;var qt=qs.getVideoTrackAt(ti);for(var j=0;j<qt.numItems;j++){var it=qt.getItemAt(j);if(it.type!='Empty'&&Math.abs(it.start.secs-a)<0.05)qi=it;}
if(qi)qi.addVideoEffect(qe.project.getVideoEffectByName('Lumetri Color'));
var L=__comp(c,'Lumetri Color');var set={};var basic=${q(args.basic ?? {})};var names=${q(LUMETRI_NAMES)};
if(L){for(var k2 in basic){var p=__prop(L,names[k2]);if(p){try{p.setValue(basic[k2],true);set[k2]=basic[k2];}catch(e6){}}}}
return JSON.stringify({success:!!L,track:ti,clip:c.name,start:c.start.seconds,end:c.end.seconds,lumetri:!!L,set:set,adjustmentSize:adjW?adjW+'x'+adjH:null});`;
  const r = await jsx(bridge, body, 120000);
  return { tool: 'add_color_layer', ...r };
}

/** "1:1" → 1080x1080, "9:16" → 1080x1920, "4:5" → 1080x1350, "WxH" as is. */
export function aspectFrame(a: string): { w: number; h: number; label: string } {
  const m = /^(\d+)\s*[x×]\s*(\d+)$/i.exec(a.trim());
  if (m) return { w: Number(m[1]), h: Number(m[2]), label: `${m[1]}x${m[2]}` };
  const r = /^(\d+)\s*:\s*(\d+)$/.exec(a.trim());
  if (!r) throw new Error(`aspect '${a}' must be like 1:1, 9:16 or 1080x1920`);
  const rw = Number(r[1]), rh = Number(r[2]);
  const w = 1080, h = Math.round((1080 * rh) / rw / 2) * 2;
  return rw >= rh ? { w: Math.round((1080 * rw) / rh / 2) * 2, h: 1080, label: `${rw}x${rh}` } : { w, h, label: `${rw}x${rh}` };
}

async function aspectVersions(bridge: PremiereProTransport, args: Record<string, any>) {
  const aspects = (args.aspects as string[] | undefined) ?? ['1:1', '9:16'];
  let frames: ReturnType<typeof aspectFrame>[];
  try { frames = aspects.map(aspectFrame); } catch (e: any) { return { success: false, error: e.message }; }
  // 1. Read the horizontal edit.
  const read = await jsx(bridge, `${SEQ_PICK(args)}${FIND_ADJ}
var W=s.frameSizeHorizontal,H=s.frameSizeVertical;var clips=[];
for(var t=0;t<s.videoTracks.numTracks;t++){var tr=s.videoTracks[t];for(var i=0;i<tr.clips.numItems;i++){var c=tr.clips[i];var pi=c.projectItem;
 var path=null;try{path=pi&&pi.getMediaPath?String(pi.getMediaPath()):null;}catch(e){}
 var adj=__isAdj(c);var M=__comp(c,'Motion');var sc=null,pos=null,anc=null,rot=null;
 try{sc=__prop(M,'Scale').getValue();}catch(e1){}try{pos=__prop(M,'Position').getValue();}catch(e2){}try{anc=__prop(M,'Anchor Point').getValue();}catch(e3){}try{rot=__prop(M,'Rotation').getValue();}catch(e4){}
 var C=__comp(c,'Crop');var crop=null;if(C){crop={};var cn={trai:'Left',tren:'Top',phai:'Right',duoi:'Bottom'};for(var k in cn){try{crop[k]=__prop(C,cn[k]).getValue();}catch(e5){}}}
 var src=null;try{var vi=String(pi.getProjectMetadata()).match(/VideoInfo>\\s*(\\d+)\\s*x\\s*(\\d+)/);if(vi)src=[+vi[1],+vi[2]];}catch(e6){}
 clips.push({id:'V'+(t+1)+'-'+(i+1),name:c.name,file:(adj||!path)?null:path,adj:adj,vao_giay:c.inPoint.seconds,ra_giay:c.outPoint.seconds,scale:sc,pos:pos,anchor:anc,rot:rot,crop:crop,src:src});}}
return JSON.stringify({success:true,name:s.name,id:s.sequenceID,W:W,H:H,clips:clips});`);
  if (!read?.success) return { tool: 'create_aspect_versions', ...read };
  const W = read.W, H = read.H;
  // 2. The Dailies engine computes the framing.
  const clipJson = {
    khung: { rong: W, cao: H },
    clip: read.clips.map((c: any) => {
      const row: Record<string, unknown> = { id: c.id, file: c.file, vao_giay: c.vao_giay, ra_giay: c.ra_giay };
      if (!c.file) return row;
      if (typeof c.scale === 'number') row.scale_phan_tram = c.scale;
      if (Array.isArray(c.pos)) row.vi_tri = { x: c.pos[0] * W, y: c.pos[1] * H };
      if (Array.isArray(c.anchor) && c.src && (Math.abs(c.anchor[0] - 0.5) > 1e-4 || Math.abs(c.anchor[1] - 0.5) > 1e-4)) row.diem_neo = { x: c.anchor[0] * c.src[0], y: c.anchor[1] * c.src[1] };
      if (c.crop) row.crop = c.crop;
      if (typeof c.rot === 'number' && c.rot !== 0) row.xoay = c.rot;
      return row;
    })
  };
  const tmp = join(HANDOFF_DIR, '..', 'bo-cuc');
  mkdirSync(tmp, { recursive: true });
  const jf = join(tmp, `${read.id}.json`);
  writeFileSync(jf, JSON.stringify(clipJson), 'utf8');
  const job = await runDailies(['bo-cuc', jf, '--khung', frames.map((f) => `${f.w}x${f.h}`).join(','), '--json'], 300000, true);
  const problem = dailiesProblem(job, 'create_aspect_versions');
  if (problem) return problem;
  const out = parseDailies(job);
  // 3. One duplicated sequence per frame.
  const results = [];
  for (let n = 0; n < frames.length; n++) {
    const f = frames[n]!;
    const ban = (out.ban ?? []).find((b: any) => b.khung?.rong === f.w && b.khung?.cao === f.h) ?? out.ban?.[n];
    const map: Record<string, { s: number; p: [number, number] } | null> = {};
    const warn: string[] = [];
    for (const c of ban?.clip ?? []) {
      map[c.id] = c.bo_cuc ? { s: c.bo_cuc.scale_phan_tram, p: [c.bo_cuc.vi_tri_chuan.x, c.bo_cuc.vi_tri_chuan.y] } : null;
      for (const w of c.bo_cuc?.canh_bao ?? []) warn.push(`${c.id}: ${w}`);
    }
    const newName = `${read.name} ${f.label}`;
    const body = `${FIND_ADJ}
var base=__seq(null,${q(read.id)});if(!base)return JSON.stringify({success:false,error:'source sequence is gone'});
var newName=${q(newName)};var old=__seq(newName,null);
if(old&&!${args.replace === true})return JSON.stringify({success:false,error:'"'+newName+'" already exists (pass replace: true to rebuild it)'});
if(old)app.project.deleteSequence(old);
var before={};var sq=app.project.sequences;for(var i=0;i<sq.numSequences;i++)before[sq[i].sequenceID]=true;
base.clone();var s=null;sq=app.project.sequences;for(var i=0;i<sq.numSequences;i++)if(!before[sq[i].sequenceID])s=sq[i];
if(!s)return JSON.stringify({success:false,error:'clone failed'});
s.name=newName;
var st=s.getSettings();st.videoFrameWidth=${f.w};st.videoFrameHeight=${f.h};s.setSettings(st);
var map=${q(map)};var W0=${W},H0=${H};var done=0,adj=0,manual=[];
for(var t=0;t<s.videoTracks.numTracks;t++){var tr=s.videoTracks[t];for(var i=0;i<tr.clips.numItems;i++){var c=tr.clips[i];var id='V'+(t+1)+'-'+(i+1);var M=__comp(c,'Motion');
 if(__isAdj(c)){var aw=W0,ah=H0;try{var vi=String(c.projectItem.getProjectMetadata()).match(/VideoInfo>\\s*(\\d+)\\s*x\\s*(\\d+)/);if(vi){aw=+vi[1];ah=+vi[2];}}catch(e){}
  var k=Math.max(${f.w}/aw,${f.h}/ah)*100;try{__prop(M,'Scale').setValue(Math.max(100,k),true);__prop(M,'Position').setValue([0.5,0.5],true);}catch(e1){}adj++;continue;}
 var b=map[id];if(!b){manual.push(c.name);continue;}
 try{__prop(M,'Scale').setValue(b.s,true);__prop(M,'Position').setValue(b.p,true);done++;}catch(e2){manual.push(c.name+' ('+e2+')');}}}
return JSON.stringify({success:true,sequence:s.name,sequenceId:s.sequenceID,frame:s.frameSizeHorizontal+'x'+s.frameSizeVertical,reframed:done,adjustmentLayers:adj,checkByHand:manual});`;
    const r = await jsx(bridge, body, 300000);
    results.push({ ...r, warnings: warn });
  }
  return { success: results.every((r) => r.success), tool: 'create_aspect_versions', from: read.name, versions: results };
}

// ---------------------------------------------------------------- Mako shortcuts

const MAKO_CALL: Record<string, (a: Record<string, any>) => string> = {
  adjustment_layer: (a) => `makoAdjustmentLayer(${q(MAKO_TEMPLATE)}, ${q(a.mode ?? '')}, 0.5, 12, ${q(MAKO_TEMPLATE)})`,
  staircase: () => 'makoStaircase()',
  unstaircase: () => 'makoUnstaircase()',
  freeze_frame: (a) => `makoFreezeFrame(${q(a.mode ?? '')}, ${q(a.holdSeconds ?? 2)})`,
  fit_frame: (a) => `makoFitFrame(${q(a.mode ?? '')})`,
  nest: () => 'makoNest()',
  unnest: () => 'makoUnnest()',
  clear_effects: (a) => `makoClearEffects(${q(a.resetMotion === true)})`,
  quality_check: (a) => `makoQualityCheck(${q(a.mode ?? '')}, ${q(a.fix !== false)})`,
  delete_empty_tracks: () => 'makoDeleteEmptyTracks()',
  new_sequence: () => 'makoNewSequence()',
  transparency_grid: () => 'makoTransparencyGrid()',
};

async function runMako(bridge: PremiereProTransport, args: Record<string, any>) {
  const call = MAKO_CALL[String(args.action)];
  if (!call) return { success: false, error: `unknown Mako action ${args.action}` };
  const fn = call(args).split('(')[0];
  const sel = args.select ?? 'none';
  const body = `
if(typeof ${fn}!=='function')return JSON.stringify({success:false,error:'Mako is not loaded in this Premiere session — open its panel once (Window → Extensions → Mako).'});
${args.sequenceName || args.sequenceId ? `var s0=__seq(${q(args.sequenceName)},${q(args.sequenceId)});if(!s0)return JSON.stringify({success:false,error:'sequence not found'});app.project.openSequence(s0.sequenceID);` : ''}
var s=app.project.activeSequence;if(!s)return JSON.stringify({success:false,error:'no open sequence'});
var sel=${q(sel)};var picked=0;
if(sel!=='none'){
 for(var t=0;t<s.videoTracks.numTracks;t++){var tr=s.videoTracks[t];for(var i=0;i<tr.clips.numItems;i++){var c=tr.clips[i];var on=false;
  if(sel==='all')on=true;
  else if(sel&&sel.track!==undefined&&sel.clips)on=(t===sel.track)&&(function(){for(var k=0;k<sel.clips.length;k++)if(sel.clips[k]===i)return true;return false;})();
  else if(sel&&sel.from!==undefined)on=c.start.seconds<sel.to&&c.end.seconds>sel.from;
  try{c.setSelected(on,true);}catch(e){}if(on)picked++;}}
 for(var a=0;a<s.audioTracks.numTracks;a++){var at=s.audioTracks[a];for(var j=0;j<at.clips.numItems;j++){try{at.clips[j].setSelected(false,true);}catch(e2){}}}
}
var raw=${call(args)};var r=null;try{r=JSON.parse(raw);}catch(e3){r={ok:true,message:String(raw)};}
return JSON.stringify({success:r.ok!==false,action:${q(args.action)},message:r.message,selected:sel==='none'?null:picked,sequence:s.name});`;
  const r = await jsx(bridge, body, 300000);
  return { tool: 'mako', ...r };
}

// ---------------------------------------------------------------- colour matte without the picker

/** "white"/"trắng" → [255,255,255], "black"/"đen" → [0,0,0], "#RRGGBB" as is. */
export function matteColor(c: string | undefined): { rgb: [number, number, number]; label: string } {
  const v = (c ?? 'white').trim().toLowerCase();
  if (['white', 'trắng', 'trang'].includes(v)) return { rgb: [255, 255, 255], label: 'trắng' };
  if (['black', 'đen', 'den'].includes(v)) return { rgb: [0, 0, 0], label: 'đen' };
  const m = /^#?([0-9a-f]{6})$/.exec(v);
  if (!m) throw new Error(`color must be white, black or #RRGGBB (got ${c})`);
  const n = parseInt(m[1]!, 16);
  return { rgb: [(n >> 16) & 255, (n >> 8) & 255, n & 255], label: `#${m[1]!.toUpperCase()}` };
}

async function addColorMatte(bridge: PremiereProTransport, args: Record<string, any>) {
  let col: ReturnType<typeof matteColor>;
  try { col = matteColor(args.color); } catch (e: any) { return { success: false, error: e.message }; }
  const info = await jsx(bridge, `${SEQ_PICK(args)}return JSON.stringify({success:true,id:s.sequenceID,w:s.frameSizeHorizontal,h:s.frameSizeVertical,project:String(app.project.path),end:s.end/254016000000});`);
  if (!info?.success) return { tool: 'add_color_matte', ...info };
  const dir = info.project && info.project !== 'undefined' ? join(info.project.replace(/[^/\\]+$/, ''), 'MCP mattes') : join(HANDOFF_DIR, '..', 'mattes');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `Nền ${col.label.replace('#', '')} ${info.w}x${info.h}.png`);
  if (!existsSync(file)) writeFileSync(file, encodeRgbaPng(info.w, info.h, () => [col.rgb[0], col.rgb[1], col.rgb[2], 255]));
  const a = args.start ?? 0;
  const b = args.end ?? info.end;
  const name = args.name ?? `Nền ${col.label}`;
  const body = `var s=__seq(null,${q(info.id)});var path=${q(file)};var it=__byPath(path);
if(!it){app.project.importFiles([path],true,__bin('Nền màu'),false);it=__byPath(path);}
if(!it)return JSON.stringify({success:false,error:'import failed'});
var a=${a},b=${b};var want=${q(args.track ?? null)};
function free(t){var tr=s.videoTracks[t];for(var i=0;i<tr.clips.numItems;i++){var c=tr.clips[i];if(c.start.seconds<b-0.001&&c.end.seconds>a+0.001)return false;}return true;}
var ti=want;if(ti===null){ti=0;if(!free(0)){app.enableQE();app.project.openSequence(s.sequenceID);qe.project.getActiveSequence().addTracks(1,s.videoTracks.numTracks,0);ti=s.videoTracks.numTracks-1;}}
else if(ti>=s.videoTracks.numTracks||!free(ti))return JSON.stringify({success:false,error:'V'+(ti+1)+' is not free between '+a+' and '+b+' s'});
var tr=s.videoTracks[ti];tr.overwriteClip(it,a);var c=null;for(var i=0;i<tr.clips.numItems;i++)if(Math.abs(tr.clips[i].start.seconds-a)<0.05)c=tr.clips[i];
if(!c)return JSON.stringify({success:false,error:'placement could not be confirmed'});
c.end=__T(b);try{c.name=${q(name)};}catch(e){}
return JSON.stringify({success:true,track:ti,clip:c.name,start:c.start.seconds,end:c.end.seconds,file:path,note:ti===0?null:'placed on V'+(ti+1)+' — drag it below the logo if it covers it'});`;
  const r = await jsx(bridge, body, 120000);
  return { tool: 'add_color_matte', ...r };
}

// ---------------------------------------------------------------- knowledge

const GUIDE_DIR = process.env.PR_GUIDE_DIR || join(homedir(), 'Desktop', '03. Code', 'MCP Adobe', 'Premiere', 'Kiến thức');

function prGuide(args: Record<string, any>) {
  if (!existsSync(GUIDE_DIR)) return { success: false, error: `knowledge folder missing: ${GUIDE_DIR}` };
  const files = readdirSync(GUIDE_DIR).filter((f) => f.endsWith('.md'));
  if (!args.topic) {
    return {
      success: true,
      topics: files.map((f) => ({ topic: f.replace(/\.md$/, ''), summary: (readFileSync(join(GUIDE_DIR, f), 'utf8').split('\n')[0] ?? '').replace(/^#\s*/, '') }))
    };
  }
  const want = String(args.topic).toLowerCase().replace(/\.md$/, '');
  const hit = files.find((f) => f.toLowerCase().replace(/\.md$/, '') === want) ?? files.find((f) => f.toLowerCase().includes(want));
  if (!hit) return { success: false, error: `no topic '${args.topic}'`, topics: files.map((f) => f.replace(/\.md$/, '')) };
  return { success: true, topic: hit.replace(/\.md$/, ''), text: readFileSync(join(GUIDE_DIR, hit), 'utf8') };
}

// ---------------------------------------------------------------- deliverables

const PRORES_MASTER_EPR = '/Applications/Adobe Premiere Pro 2026/Adobe Premiere Pro 2026.app/Contents/Settings/EncoderPresets/ConsolidateAndTranscode/Match Source - Apple ProRes 422 HQ.epr';

async function exportDeliverables(bridge: PremiereProTransport, args: Record<string, any>) {
  const ids = (args.presets as string[]) ?? [];
  const bad = ids.filter((i) => !DELIVERABLES[i]);
  if (!ids.length || bad.length) return { success: false, error: `presets must be some of ${Object.keys(DELIVERABLES).join(', ')}${bad.length ? ` (unknown: ${bad.join(', ')})` : ''}` };
  const epr = process.env.PR_MASTER_EPR || PRORES_MASTER_EPR;
  if (!existsSync(epr)) return { success: false, error: `master preset missing: ${epr} (set PR_MASTER_EPR)` };
  // The master goes through Adobe Media Encoder so Premiere stays free; the
  // deliverables follow in the background once the file stops growing.
  const body = `${SEQ_PICK(args)}
var dir=${q(args.outputDir ?? null)};if(!dir){var pp=String(app.project.path);dir=pp.replace(/[\\/\\\\][^\\/\\\\]*$/,'')+'/Xuất file';}
var f=new Folder(dir+'/.master');if(!f.exists)f.create();
var out=f.fsName+'/'+s.name.replace(/[\\\\\\/:*?"<>|]/g,' ')+'.mov';
var old=new File(out);if(old.exists)old.remove();
var via='ame';var r=null;
try{app.encoder.launchEncoder();r=app.encoder.encodeSequence(s,out,${q(epr)},app.encoder.ENCODE_ENTIRE,1);app.encoder.startBatch();}catch(e){r=null;}
if(!r||r=='0'){via='direct';r=s.exportAsMediaDirect(out,${q(epr)},0);}
return JSON.stringify({success:true,master:out,dir:dir,via:via,result:String(r)});`;
  const m = await jsx(bridge, body, 60 * 60_000);
  if (!m?.success) return { tool: 'export_deliverables', ...m };
  const job = startExportJob(m.master, m.dir, ids, { client: String(args.client), title: String(args.title), version: args.version }, { width: args.width, height: args.height, watermark: args.watermark }, m.via === 'ame');
  const view = await waitJob(job, (args.waitSeconds ?? 40) * 1000);
  return { success: view.state !== 'failed', tool: 'export_deliverables', master: m.master, masterVia: m.via === 'ame' ? 'Adobe Media Encoder' : 'Premiere (direct)', ...view, ...(view.state === 'done' || view.state === 'failed' ? {} : { next: `export_status { jobId: "${job.id}" }` }) };
}

function exportStatus(args: Record<string, any>) {
  const j = exportJob(String(args.jobId));
  if (!j) return Promise.resolve({ success: false, error: `no export job ${args.jobId} in this session` });
  return waitJob(j, (args.waitSeconds ?? 0) * 1000).then((v) => ({ success: true, tool: 'export_status', ...v }));
}


// ---------------------------------------------------------------- per-scene colour

async function addSceneColorLayers(bridge: PremiereProTransport, args: Record<string, any>) {
  for (const k of Object.keys(args.basic ?? {})) if (!LUMETRI_NAMES[k]) return { success: false, error: `unknown Lumetri control '${k}'` };
  const body = `${SEQ_PICK(args)}${FIND_ADJ}
var adj=__adjOrMake();if(!adj)return JSON.stringify({success:false,needsAdjustmentLayer:true,error:'No Adjustment Layer in the project and Mako could not import its template.'});
var src=s.videoTracks[${args.sourceTrack ?? 0}];if(!src)return JSON.stringify({success:false,error:'no such source track'});
var fd=s.getSettings().videoFrameRate.seconds;
function base(p){var q=String(p);q=q.substring(Math.max(q.lastIndexOf('/'),q.lastIndexOf(String.fromCharCode(92)))+1);var d=q.lastIndexOf('.');return d>0?q.substring(0,d):q;}
var segs=[];
for(var i=0;i<src.clips.numItems;i++){var c=src.clips[i];if(c.disabled||__isAdj(c))continue;var p=null;try{p=c.projectItem.getMediaPath();}catch(e){}if(!p)continue;
 var key=base(p);var last=segs.length?segs[segs.length-1]:null;
 if(last&&last.key===key&&c.start.seconds-last.end<=fd*1.5)last.end=c.end.seconds;else segs.push({key:key,start:c.start.seconds,end:c.end.seconds});}
if(!segs.length)return JSON.stringify({success:false,error:'no footage clips on that track'});
app.enableQE();app.project.openSequence(s.sequenceID);var qs=qe.project.getActiveSequence();
qs.addTracks(1,s.videoTracks.numTracks,0);var ti=s.videoTracks.numTracks-1;var tr=s.videoTracks[ti];var qt=qs.getVideoTrackAt(ti);
var adjW=0,adjH=0;try{var vi=String(adj.getProjectMetadata()).match(/VideoInfo>\\s*(\\d+)\\s*x\\s*(\\d+)/);if(vi){adjW=+vi[1];adjH=+vi[2];}}catch(e0){}
var basic=${q(args.basic ?? {})};var per=${q(args.perSource ?? {})};var names=${q(LUMETRI_NAMES)};var made=[];var groups={};
for(var k=0;k<segs.length;k++){var g=segs[k];
 try{adj.setInPoint(0,4);adj.setOutPoint(Math.max(0.1,g.end-g.start),4);}catch(e1){}
 tr.overwriteClip(adj,g.start);var c2=null;for(var j=0;j<tr.clips.numItems;j++)if(Math.abs(tr.clips[j].start.seconds-g.start)<0.02)c2=tr.clips[j];
 if(!c2){made.push({scene:g.key,error:'not placed'});continue;}
 if(Math.abs(c2.end.seconds-g.end)>0.001){try{c2.end=__T(g.end);}catch(e2){}}
 c2.name='Màu '+g.key;
 if(adjW>0){var sc=Math.max(s.frameSizeHorizontal/adjW,s.frameSizeVertical/adjH)*100;if(sc>100.01){try{__prop(__comp(c2,'Motion'),'Scale').setValue(sc,true);}catch(e3){}}}
 for(var m=0;m<qt.numItems;m++){var it=qt.getItemAt(m);if(it.type!='Empty'&&Math.abs(it.start.secs-g.start)<0.02){it.addVideoEffect(qe.project.getVideoEffectByName('Lumetri Color'));break;}}
 var L=__comp(c2,'Lumetri Color');var v={};for(var a in basic)v[a]=basic[a];var ps=per[g.key]||{};for(var b in ps)v[b]=ps[b];
 if(L){for(var n in v){var pp=__prop(L,names[n]);if(pp){try{pp.setValue(v[n],true);}catch(e4){}}}}
 groups[g.key]=(groups[g.key]||0)+1;made.push({layer:c2.name,start:g.start,end:g.end,lumetri:!!L});}
try{adj.clearInPoint();adj.clearOutPoint();}catch(e5){}
return JSON.stringify({success:true,track:ti,layers:made,scenes:groups});`;
  const r = await jsx(bridge, body, 300000);
  return { tool: 'add_scene_color_layers', ...r };
}

async function syncColorLayers(bridge: PremiereProTransport, args: Record<string, any>) {
  const body = `${SEQ_PICK(args)}
var only=${q(args.name ?? null)};var usePh=${args.fromPlayhead === true};var ph=s.getPlayerPosition().seconds;
var groups={};
for(var t=0;t<s.videoTracks.numTracks;t++){var tr=s.videoTracks[t];for(var i=0;i<tr.clips.numItems;i++){var c=tr.clips[i];
 if(c.name.indexOf('Màu ')!==0)continue;if(only&&c.name!==only)continue;if(!__comp(c,'Lumetri Color'))continue;
 (groups[c.name]=groups[c.name]||[]).push(c);}}
var out=[];
for(var g in groups){var list=groups[g];if(list.length<2){out.push({layer:g,instances:1,synced:0});continue;}
 var master=list[0];if(usePh){for(var j=0;j<list.length;j++)if(list[j].start.seconds<=ph&&list[j].end.seconds>ph)master=list[j];}
 var ML=__comp(master,'Lumetri Color');var vals=[];for(var p=0;p<ML.properties.numItems;p++){var v=null;try{v=ML.properties[p].getValue();}catch(e){v=undefined;}vals.push(v);}
 var n=0,fail=0;
 for(var k=0;k<list.length;k++){if(list[k]===master)continue;var L=__comp(list[k],'Lumetri Color');
  for(var q2=0;q2<L.properties.numItems&&q2<vals.length;q2++){if(vals[q2]===undefined||vals[q2]===null)continue;try{L.properties[q2].setValue(vals[q2],true);}catch(e2){fail++;}}n++;}
 out.push({layer:g,instances:list.length,master:master.start.seconds,synced:n,skippedParams:fail});}
return JSON.stringify({success:true,groups:out});`;
  const r = await jsx(bridge, body, 300000);
  return { tool: 'sync_color_layers', ...r };
}

// ---------------------------------------------------------------- proxies

const VIDEO_EXT = /\.(mp4|mov|mxf|mts|m2ts|avi|mkv)$/i;

interface ProxyJob { id: string; state: 'running' | 'done' | 'failed'; folder: string; files: string[]; done: { file: string; proxy: string; reused: boolean; seconds: number }[]; failed: { file: string; error: string }[]; current: string | null; attached: any; started: number }
const proxyJobs = new Map<string, ProxyJob>();

/** ffmpeg arguments for one proxy. Pure, for tests. */
export function proxyArgs(input: string, output: string, size: '1/2' | '1/4', codec: 'prores_proxy' | 'h264'): string[] {
  const div = size === '1/4' ? 4 : 2;
  const v = codec === 'h264'
    ? ['-c:v', 'h264_videotoolbox', '-b:v', size === '1/4' ? '4M' : '10M', '-pix_fmt', 'yuv420p']
    : ['-c:v', 'prores_videotoolbox', '-profile:v', 'proxy'];
  return ['-y', '-hide_banner', '-loglevel', 'error', '-i', input, '-map', '0:v:0', '-map', '0:a?', '-dn',
    '-vf', `scale=trunc(iw/${div}/2)*2:trunc(ih/${div}/2)*2`, ...v, '-c:a', 'pcm_s16le', '-threads', '4', output];
}

function proxyPath(folder: string, file: string): string {
  return join(folder, 'Proxies', basename(file).replace(/\.[^.]+$/, '') + '_Proxy.mov');
}

async function createProxies(bridge: PremiereProTransport, args: Record<string, any>) {
  const folder = String(args.sourceFolder);
  if (!existsSync(folder)) return { success: false, error: `folder not found: ${folder}` };
  const files = readdirSync(folder).filter((f) => VIDEO_EXT.test(f) && !f.startsWith('.')).map((f) => join(folder, f));
  if (!files.length) return { success: false, error: 'no video files in that folder' };
  const size = (args.size ?? '1/2') as '1/2' | '1/4';
  const codec = (args.codec ?? 'prores_proxy') as 'prores_proxy' | 'h264';
  mkdirSync(join(folder, 'Proxies'), { recursive: true });
  const job: ProxyJob = { id: randomUUID().slice(0, 8), state: 'running', folder, files, done: [], failed: [], current: null, attached: null, started: Date.now() };
  proxyJobs.set(job.id, job);
  void (async () => {
    const ff = existsSync('/opt/homebrew/bin/ffmpeg') ? '/opt/homebrew/bin/ffmpeg' : existsSync(join(homedir(), '.local/bin/ffmpeg')) ? join(homedir(), '.local/bin/ffmpeg') : 'ffmpeg';
    for (const f of files) {
      const out = proxyPath(folder, f);
      if (existsSync(out)) { job.done.push({ file: f, proxy: out, reused: true, seconds: 0 }); continue; }
      job.current = basename(f);
      const t0 = Date.now();
      const tmp = out.replace(/\.mov$/, '.part.mov');
      const code = await new Promise<number>((resolve) => {
        // nice: low priority so the machine stays responsive and cooler.
        const c = spawn('nice', ['-n', '10', ff, ...proxyArgs(f, tmp, size, codec)]);
        let err = '';
        c.stderr.on('data', (d) => (err += d.toString()));
        c.on('close', (code) => { if (code) job.failed.push({ file: f, error: err.slice(-300) }); resolve(code ?? -1); });
        c.on('error', (e) => { job.failed.push({ file: f, error: String(e) }); resolve(-1); });
      });
      if (code === 0) {
        const { renameSync } = await import('node:fs');
        renameSync(tmp, out);
        job.done.push({ file: f, proxy: out, reused: false, seconds: Math.round((Date.now() - t0) / 1000) });
      }
    }
    job.current = null;
    if (args.attach !== false && job.done.length) {
      const pairs = job.done.map((d) => ({ file: d.file, proxy: d.proxy }));
      job.attached = await jsx(bridge, `var pairs=${q(pairs)};var ok=[],miss=[],err=[];
for(var i=0;i<pairs.length;i++){var it=__byPath(pairs[i].file);if(!it){miss.push(pairs[i].file);continue;}
 try{if(it.hasProxy&&it.hasProxy()){ok.push(it.name+' (already)');continue;}var r=it.attachProxy(pairs[i].proxy,0);if(r===false)err.push(it.name);else ok.push(it.name);}catch(e){err.push(it.name+': '+e);}}
return JSON.stringify({success:true,attached:ok,notInProject:miss.length,failed:err});`, 300000).catch((e: any) => ({ success: false, error: String(e) }));
    }
    job.state = job.failed.length ? 'failed' : 'done';
  })();
  return await proxyStatus({ jobId: job.id, waitSeconds: args.waitSeconds ?? 20 });
}

async function proxyStatus(args: Record<string, any>) {
  const j = proxyJobs.get(String(args.jobId));
  if (!j) return { success: false, error: `no proxy job ${args.jobId} in this session` };
  const t0 = Date.now();
  while (j.state === 'running' && Date.now() - t0 < (args.waitSeconds ?? 0) * 1000) await new Promise((r) => setTimeout(r, 1000));
  return {
    success: j.state !== 'failed', tool: 'proxy_status', jobId: j.id, state: j.state, current: j.current,
    progress: `${j.done.length + j.failed.length}/${j.files.length}`, done: j.done.map((d) => ({ file: basename(d.file), proxy: d.proxy, reused: d.reused, seconds: d.seconds })),
    failed: j.failed, attached: j.attached, elapsedSec: Math.round((Date.now() - j.started) / 1000),
    ...(j.state === 'running' ? { next: `proxy_status { jobId: "${j.id}", waitSeconds: 60 }` } : {})
  };
}

// ---------------------------------------------------------------- checkpoint, bins, QC

async function checkpointProject(bridge: PremiereProTransport, args: Record<string, any>) {
  const info = await jsx(bridge, `${args.list ? '' : 'app.project.save();'}return JSON.stringify({success:true,path:String(app.project.path)});`, 120000);
  if (!info?.success || !info.path || info.path === 'undefined') return { success: false, error: 'the project has no file yet — save it once first' };
  const proj: string = info.path;
  const dir = join(proj.replace(/[^/]+$/, ''), basename(proj, '.prproj') + ' checkpoints');
  const { copyFileSync, statSync } = await import('node:fs');
  if (args.list) {
    const items = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.prproj')).map((f) => ({ file: join(dir, f), modified: statSync(join(dir, f)).mtimeMs })).sort((a, b) => b.modified - a.modified) : [];
    return { success: true, tool: 'checkpoint_project', checkpoints: items.map((i) => i.file) };
  }
  mkdirSync(dir, { recursive: true });
  const d = new Date();
  const p2 = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
  const label = String(args.label ?? '').replace(/[\\/:*?"<>|]/g, ' ').trim();
  const dest = join(dir, `${basename(proj, '.prproj')} ${stamp}${label ? ' ' + label : ''}.prproj`);
  copyFileSync(proj, dest);
  return { success: true, tool: 'checkpoint_project', checkpoint: dest, project: proj };
}

/** Bin for a project item by its media path / kind. Pure, for tests. */
export function binFor(kind: 'sequence' | 'adjustment' | 'media', path: string): string {
  if (kind === 'sequence') return '04 Sequences';
  if (kind === 'adjustment') return '05 Adjustment';
  const p = path.toLowerCase();
  if (/[\\/](proxies|xuất file|xuat file|cau noi pr ae)[\\/]|_proxy\.|\.prores|ae · /.test(p) || /cau noi pr ae/.test(p)) return '06 Proxies & renders';
  if (/mcp mattes/.test(p)) return '05 Adjustment';
  if (/\.(wav|mp3|aif|aiff|m4a|aac|flac|ogg)$/.test(p)) return '02 Audio';
  if (/\.(png|jpe?g|tiff?|psd|ai|eps|svg|gif|mogrt|aegraphic|pdf)$/.test(p)) return '03 Graphics';
  return '01 Footage';
}

async function organizeBins(bridge: PremiereProTransport, args: Record<string, any>) {
  const list = await jsx(bridge, `var out=[];function walk(b,depth){for(var i=0;i<b.children.numItems;i++){var c=b.children[i];if(c.type==2){if(${args.all === true})walk(c,depth+1);continue;}
 var kind='media';try{if(c.isSequence&&c.isSequence())kind='sequence';}catch(e){}try{if(c.isAdjustmentLayer&&c.isAdjustmentLayer())kind='adjustment';}catch(e2){}
 var p='';try{p=String(c.getMediaPath());}catch(e3){}out.push({id:c.nodeId,name:c.name,kind:kind,path:p,bin:b===app.project.rootItem?'':b.name});}}
walk(app.project.rootItem,0);return JSON.stringify({success:true,items:out});`, 120000);
  if (!list?.success) return { tool: 'organize_project_bins', ...list };
  const moves = (list.items as any[]).map((it) => ({ ...it, to: binFor(it.kind, it.path || it.name) })).filter((it) => it.bin !== it.to);
  if (args.dryRun || !moves.length) return { success: true, tool: 'organize_project_bins', dryRun: !!args.dryRun, moves: moves.map((m) => ({ item: m.name, to: m.to })) };
  const r = await jsx(bridge, `var mv=${q(moves.map((m) => ({ id: m.id, to: m.to })))};var bins={};
function bin(n){if(bins[n])return bins[n];var r=app.project.rootItem;for(var i=0;i<r.children.numItems;i++)if(r.children[i].type==2&&r.children[i].name==n){bins[n]=r.children[i];return bins[n];}bins[n]=r.createBin(n);return bins[n];}
function find(id,b){for(var i=0;i<b.children.numItems;i++){var c=b.children[i];if(c.nodeId==id)return c;if(c.type==2){var f=find(id,c);if(f)return f;}}return null;}
var n=0,err=[];for(var k=0;k<mv.length;k++){var it=find(mv[k].id,app.project.rootItem);if(!it)continue;try{it.moveBin(bin(mv[k].to));n++;}catch(e){err.push(it.name);}}
return JSON.stringify({success:true,moved:n,failed:err});`, 120000);
  return { tool: 'organize_project_bins', ...r, moves: moves.map((m) => ({ item: m.name, to: m.to })) };
}

async function qcBeforeExport(bridge: PremiereProTransport, args: Record<string, any>) {
  const body = `${SEQ_PICK(args)}${FIND_ADJ}
var fd=s.getSettings().videoFrameRate.seconds;var issues=[];
function tc(t){var f=Math.round(t/fd),fps=Math.round(1/fd);function p(x){return (x<10?'0':'')+x;}return p(Math.floor(f/(fps*3600)))+':'+p(Math.floor(f/(fps*60))%60)+':'+p(Math.floor(f/fps)%60)+':'+p(f%fps);}
var cover=[];var end=0;
for(var t=0;t<s.videoTracks.numTracks;t++){var tr=s.videoTracks[t];
 if(!tr.clips.numItems)issues.push({kind:'empty_track',detail:'V'+(t+1)+' is empty'});
 for(var i=0;i<tr.clips.numItems;i++){var c=tr.clips[i];var a=c.start.seconds,b=c.end.seconds;if(b>end)end=b;
  if(c.disabled){issues.push({kind:'disabled',at:tc(a),detail:'V'+(t+1)+' '+c.name+' is switched off'});continue;}
  var off=false;try{off=c.projectItem&&c.projectItem.isOffline&&c.projectItem.isOffline();}catch(e){}if(off)issues.push({kind:'offline',at:tc(a),detail:c.name+' is offline'});
  if(b-a<=fd*2.5&&!__isAdj(c))issues.push({kind:'tiny_clip',at:tc(a),detail:c.name+' is '+Math.round((b-a)/fd)+' frame(s)'});
  if(!__isAdj(c))cover.push([a,b]);}}
cover.sort(function(x,y){return x[0]-y[0];});var cur=0;for(var k=0;k<cover.length;k++){if(cover[k][0]-cur>fd*0.5)issues.push({kind:'gap',at:tc(cur),detail:'black for '+Math.round((cover[k][0]-cur)/fd)+' frame(s)'});if(cover[k][1]>cur)cur=cover[k][1];}
for(var at=0;at<s.audioTracks.numTracks;at++){var atr=s.audioTracks[at];try{if(atr.isMuted&&atr.isMuted())issues.push({kind:'muted_track',detail:'A'+(at+1)+' is muted'});}catch(e){}}
var mk=s.markers.getFirstMarker();var red=0;while(mk){try{if(mk.getColorByIndex&&mk.getColorByIndex()==1)red++;}catch(e){}mk=s.markers.getNextMarker(mk);}
if(red)issues.push({kind:'review_markers',detail:red+' red marker(s) left (low-confidence takes or QC marks)'});
var frame=s.frameSizeHorizontal+'x'+s.frameSizeVertical;var want=${q(args.expectFrame ?? null)};if(want&&want!==frame)issues.push({kind:'frame',detail:'sequence is '+frame+', delivery expects '+want});
var prox=false;try{prox=app.getEnableProxies&&app.getEnableProxies()==1;}catch(e){}if(prox)issues.push({kind:'proxies_on',detail:'proxies are switched on — exports use full-res media anyway, but check the Program Monitor toggle'});
return JSON.stringify({success:true,sequence:s.name,frame:frame,duration:tc(end),issueCount:issues.length,issues:issues,${'ok'}:issues.length===0});`;
  const r = await jsx(bridge, body, 120000);
  return { tool: 'qc_before_export', ...r };
}

// ---------------------------------------------------------------- captions

interface Word { chu: string; vao: number; ra: number }
interface Sentence { vao: number; ra: number; noi_dung: string; tu?: Word[] }

/** Words of `sentences` (frames at fps) that fall in [inS, outS) source seconds, as timeline cues. Pure, for tests. */
export function cuesForClip(sentences: Sentence[], fps: number, inS: number, outS: number, startS: number, maxChars = 42): { a: number; b: number; text: string }[] {
  const words: { t0: number; t1: number; w: string }[] = [];
  for (const c of sentences) {
    const ws = c.tu?.length ? c.tu : [{ chu: c.noi_dung, vao: c.vao, ra: c.ra }];
    const before = words.length;
    for (const w of ws) {
      const t0 = w.vao / fps, t1 = Math.max(w.ra / fps, t0 + 0.05);
      if (t1 <= inS || t0 >= outS) continue;
      words.push({ t0: Math.max(t0, inS), t1: Math.min(t1, outS), w: String(w.chu).trim() });
    }
    // sentence boundary: force a break
    if (words.length > before) words[words.length - 1]!.w += '\u0000';
  }
  const cues: { a: number; b: number; text: string }[] = [];
  let cur: typeof words = [];
  const flush = () => {
    if (!cur.length) return;
    const text = cur.map((x) => x.w.replace(/\u0000/g, '')).join(' ').replace(/\s+/g, ' ').trim();
    if (text) cues.push({ a: cur[0]!.t0 - inS + startS, b: cur[cur.length - 1]!.t1 - inS + startS, text });
    cur = [];
  };
  for (const w of words) {
    const len = cur.map((x) => x.w).join(' ').length + w.w.length + 1;
    if (cur.length && (len > maxChars || w.t0 - cur[cur.length - 1]!.t1 > 1.2)) flush();
    cur.push(w);
    if (w.w.endsWith('\u0000')) flush();
  }
  flush();
  return cues;
}

export function toSrt(cues: { a: number; b: number; text: string }[]): string {
  const ts = (t: number) => {
    const ms = Math.max(0, Math.round(t * 1000));
    const p = (n: number, w = 2) => String(n).padStart(w, '0');
    return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
  };
  // At least half a second on screen, but never past the next cue's start.
  const sorted = [...cues].sort((x, y) => x.a - y.a);
  return sorted.map((c, n) => {
    const next = sorted[n + 1]?.a ?? Infinity;
    return `${n + 1}\n${ts(c.a)} --> ${ts(Math.min(Math.max(c.b, c.a + 0.5), next))}\n${c.text}\n`;
  }).join('\n');
}

async function captions(bridge: PremiereProTransport, args: Record<string, any>) {
  const read = await jsx(bridge, `${SEQ_PICK(args)}var tr=s.videoTracks[${args.sourceTrack ?? 0}];var out=[];
for(var i=0;i<tr.clips.numItems;i++){var c=tr.clips[i];if(c.disabled)continue;var p=null;try{p=String(c.projectItem.getMediaPath());}catch(e){}if(!p)continue;
 out.push({file:p,inS:c.inPoint.seconds,outS:c.outPoint.seconds,startS:c.start.seconds});}
return JSON.stringify({success:true,id:s.sequenceID,name:s.name,project:String(app.project.path),clips:out});`);
  if (!read?.success) return { tool: 'transcribe_to_captions', ...read };
  const all: { a: number; b: number; text: string }[] = [];
  const missing: string[] = [];
  const cache = new Map<string, { fps: number; sentences: Sentence[] } | null>();
  for (const c of read.clips as { file: string; inS: number; outS: number; startS: number }[]) {
    if (!cache.has(c.file)) {
      let found: { fps: number; sentences: Sentence[] } | null = null;
      const dir = join(c.file.replace(/[^/]+$/, ''), '.dailies');
      const idx = join(dir, 'take_khau_lenh.json');
      if (existsSync(idx)) {
        const take = JSON.parse(readFileSync(idx, 'utf8'));
        const hit = (take.take ?? []).concat(take.file_khong_co_khau_lenh ?? []).find((t: any) => t.file === c.file || t.ten_file === basename(c.file));
        const pf = hit ? join(dir, 'phan_tich', `${hit.media_id}.json`) : null;
        if (pf && existsSync(pf)) {
          const j = JSON.parse(readFileSync(pf, 'utf8'));
          found = { fps: j.fps.tu / j.fps.mau, sentences: j.transcript?.cau ?? [] };
        }
      }
      cache.set(c.file, found);
    }
    const t = cache.get(c.file);
    if (!t) { missing.push(basename(c.file)); continue; }
    all.push(...cuesForClip(t.sentences, t.fps, c.inS, c.outS, c.startS, args.maxChars ?? 42));
  }
  if (!all.length) return { success: false, tool: 'transcribe_to_captions', error: 'no words found for these clips', missingTranscript: missing, hint: 'run rough_cut_by_cues (or describe_sources) on the footage folder first so the Dailies engine has listened to it' };
  const dir = join(String(read.project).replace(/[^/]+$/, ''), 'Phụ đề');
  mkdirSync(dir, { recursive: true });
  const srt = join(dir, `${String(read.name).replace(/[\\/:*?"<>|]/g, ' ')}.srt`);
  writeFileSync(srt, toSrt(all), 'utf8');
  let track: any = null;
  if (args.addTrack !== false) {
    track = await jsx(bridge, `var s=__seq(null,${q(read.id)});var path=${q(srt)};var it=__byPath(path);
if(it){try{it.refreshMedia();}catch(e){}}else{app.project.importFiles([path],true,__bin('Phụ đề'),false);it=__byPath(path);}
if(!it)return JSON.stringify({success:false,error:'SRT import failed'});
var r=null;try{r=s.createCaptionTrack(it,0);}catch(e2){return JSON.stringify({success:false,error:'createCaptionTrack: '+e2});}
return JSON.stringify({success:true,result:String(r)});`);
  }
  return { success: true, tool: 'transcribe_to_captions', srt, cues: all.length, preview: all.slice(0, 5).map((c) => c.text), missingTranscript: missing, captionTrack: track };
}

// ---------------------------------------------------------------- music beats, best takes, voiceover, loudness, review

const AUDIO_EXT = /\.(wav|mp3|aif|aiff|m4a|aac|flac)$/i;
const VO_NAME = /(^|[^a-z])(vo|voice|voiceover|narration|thoai|thoại|long tieng|lồng tiếng)([^a-z]|$)/i;

const VOL = `function __level(c){var VN=['Volume','Volumen','Lautst\\u00e4rke'],LN=['Level','Nivel','Pegel','Niveau','Livello'];for(var i=0;i<c.components.numItems;i++){var k=c.components[i];var ok=false;for(var a=0;a<VN.length;a++)if(k.displayName==VN[a])ok=true;if(!ok)continue;for(var j=0;j<k.properties.numItems;j++){var p=k.properties[j];for(var b=0;b<LN.length;b++)if(p.displayName==LN[b])return p;}}return null;}
function __toDb(v){return 20*Math.log(Math.max(v,1e-6))/Math.LN10+15;}
function __fromDb(d){return Math.pow(10,(d-15)/20);}`;

interface AudioClip { track: number; index: number; file: string | null; name: string; start: number; end: number; inS: number; outS: number }

async function readAudio(bridge: PremiereProTransport, args: Record<string, any>) {
  return jsx(bridge, `${SEQ_PICK(args)}var A=[];
for(var t=0;t<s.audioTracks.numTracks;t++){var tr=s.audioTracks[t];for(var i=0;i<tr.clips.numItems;i++){var c=tr.clips[i];var p=null;try{p=String(c.projectItem.getMediaPath());}catch(e){}
 A.push({track:t,index:i,file:p,name:c.name,start:c.start.seconds,end:c.end.seconds,inS:c.inPoint.seconds,outS:c.outPoint.seconds});}}
return JSON.stringify({success:true,id:s.sequenceID,name:s.name,project:String(app.project.path),fd:s.getSettings().videoFrameRate.seconds,clips:A});`);
}

/** Music clips: audio-only media that does not look like a voiceover. */
export function pickMusic(clips: AudioClip[], track?: number): AudioClip[] {
  return clips.filter((c) => c.file && AUDIO_EXT.test(c.file) && (track === undefined || c.track === track) && !VO_NAME.test(basename(c.file)));
}

/** Beat times (source seconds) that fall inside a clip, moved to timeline seconds. Pure, for tests. */
export function timelineBeats(clip: { start: number; inS: number; outS: number }, beats: number[]): number[] {
  return beats.filter((b) => b >= clip.inS - 1e-3 && b < clip.outS).map((b) => Math.round((clip.start + b - clip.inS) * 1000) / 1000);
}

/** Every n-th beat, counted from the first downbeat so bars stay aligned. */
export function beatGrid(beats: number[], downbeats: number[], every: number): number[] {
  if (every <= 1 || !downbeats.length) return beats;
  const i0 = Math.max(0, beats.findIndex((b) => Math.abs(b - downbeats[0]!) < 1e-3));
  return beats.filter((_, i) => (((i - i0) % every) + every) % every === 0);
}

async function musicBeatsOnTimeline(bridge: PremiereProTransport, args: Record<string, any>) {
  const a = await readAudio(bridge, args);
  if (!a?.success) return { ok: false as const, error: a };
  const music = pickMusic(a.clips, args.musicTrack);
  const beats: number[] = [], downs: number[] = [];
  const files: { file: string; bpm: number; cached: boolean }[] = [];
  for (const c of music) {
    const r = await detectBeats(c.file!, !!args.force);
    if (!files.some((f) => f.file === c.file)) files.push({ file: c.file!, bpm: r.bpm, cached: r.cached });
    beats.push(...timelineBeats(c, r.beats));
    downs.push(...timelineBeats(c, r.downbeats));
  }
  const uniq = (v: number[]) => Array.from(new Set(v)).sort((x, y) => x - y);
  return { ok: true as const, seq: a, music, files, beats: uniq(beats), downbeats: uniq(downs) };
}

async function detectBeatsTool(bridge: PremiereProTransport, args: Record<string, any>) {
  if (args.file) {
    if (!existsSync(args.file)) return { success: false, error: `file not found: ${args.file}` };
    const r = await detectBeats(String(args.file), !!args.force);
    return { success: true, tool: 'detect_beats', file: r.file, bpm: r.bpm, beats: r.beats.length, downbeats: r.downbeats.length, firstBeats: r.beats.slice(0, 8), cached: r.cached };
  }
  const m = await musicBeatsOnTimeline(bridge, args);
  if (!m.ok) return { tool: 'detect_beats', ...m.error };
  if (!m.music.length) return { success: false, tool: 'detect_beats', error: 'no music clip on the timeline', hint: 'put the track on an audio track (audio-only file), pass musicTrack, or pass file' };
  const mode = args.markers ?? 'downbeats';
  let markers = 0;
  if (mode !== 'none') {
    const times = mode === 'beats' ? m.beats : m.downbeats;
    const r = await jsx(bridge, `var s=__seq(null,${q(m.seq.id)});var times=${q(times)};var bpm=${q(m.files.map((f) => f.bpm).join(' / '))};
var mk=s.markers.getFirstMarker();var old=[];while(mk){if(String(mk.name).indexOf('Nhịp')===0)old.push(mk);mk=s.markers.getNextMarker(mk);}
for(var i=0;i<old.length;i++){try{s.markers.deleteMarker(old[i]);}catch(e){}}
var vEnd=0;for(var v=0;v<s.videoTracks.numTracks;v++){var vt=s.videoTracks[v];for(var c=0;c<vt.clips.numItems;c++)if(vt.clips[c].end.seconds>vEnd)vEnd=vt.clips[c].end.seconds;}
var kept=[];for(var j0=0;j0<times.length;j0++)if(!vEnd||times[j0]<=vEnd+0.01)kept.push(times[j0]);times=kept;
for(var j=0;j<times.length;j++){var m=s.markers.createMarker(times[j]);m.name=${q(mode === 'beats' ? 'Nhịp' : 'Nhịp 1')};m.comments=bpm+' BPM';try{m.setColorByIndex(7);}catch(e){}}
return JSON.stringify({success:true,count:times.length});`, 300000);
    markers = r?.count ?? 0;
  }
  return { success: true, tool: 'detect_beats', sequence: m.seq.name, music: m.files, beats: m.beats.length, downbeats: m.downbeats.length, markers, firstBeats: m.beats.slice(0, 8) };
}

function mediaDuration(file: string): Promise<number | null> {
  return new Promise((resolve) => {
    const p = spawn(ffmpegPath(), ['-hide_banner', '-i', file]);
    let err = '';
    p.stderr.on('data', (d: Buffer) => (err += d.toString()));
    p.on('error', () => resolve(null));
    p.on('close', () => {
      const m = /Duration:\s*(\d+):(\d+):([\d.]+)/.exec(err);
      resolve(m ? +m[1]! * 3600 + +m[2]! * 60 + +m[3]! : null);
    });
  });
}

async function cutToBeats(bridge: PremiereProTransport, args: Record<string, any>) {
  const m = await musicBeatsOnTimeline(bridge, args);
  if (!m.ok) return { tool: 'cut_to_beats', ...m.error };
  if (!m.beats.length) return { success: false, tool: 'cut_to_beats', error: 'no music (or no beats) on the timeline', hint: 'place the music on an audio track first, or pass musicTrack' };
  // Cuts can only fall on frames: snap the grid first so the clips meet exactly.
  const fd = m.seq.fd as number;
  const grid = Array.from(new Set(beatGrid(m.beats, m.downbeats, args.every ?? 1).map((g) => Math.round(Math.round(g / fd) * fd * 1e6) / 1e6)));
  const vt = args.videoTrack ?? 0;
  const v = await jsx(bridge, `var s=__seq(null,${q(m.seq.id)});${FIND_ADJ}var tr=s.videoTracks[${vt}];if(!tr)return JSON.stringify({success:false,error:'no video track ${vt + 1}'});var V=[];
for(var i=0;i<tr.clips.numItems;i++){var c=tr.clips[i];if(__isAdj(c))continue;var p=null;try{p=String(c.projectItem.getMediaPath());}catch(e){}V.push({file:p,name:c.name,start:c.start.seconds,end:c.end.seconds,inS:c.inPoint.seconds,outS:c.outPoint.seconds});}
return JSON.stringify({success:true,clips:V});`);
  if (!v?.success) return { tool: 'cut_to_beats', ...v };
  const clips = (v.clips as { file: string; name: string; start: number; end: number; inS: number; outS: number }[]).sort((x, y) => x.start - y.start);
  if (!clips.length) return { success: false, tool: 'cut_to_beats', error: `V${vt + 1} has no clips` };
  const durs = new Map<string, number | null>();
  for (const c of clips) if (!durs.has(c.file)) durs.set(c.file, await mediaDuration(c.file));
  const layout = beatLayout(clips.map((c) => ({ len: c.end - c.start, maxLen: (durs.get(c.file) ?? c.outS) - c.inS })), grid, clips[0]!.start, args.minShot ?? 0.4);
  const plan = clips.map((c, i) => ({ file: c.file, name: c.name, inS: c.inS, outS: Math.round((c.inS + layout[i]!.len) * 1000) / 1000, at: layout[i]!.at, onBeat: layout[i]!.onBeat, was: Math.round((c.end - c.start) * 1000) / 1000 }));
  if (args.dryRun) return { success: true, tool: 'cut_to_beats', bpm: m.files.map((f) => f.bpm), plan };
  const newName = String(args.newSequenceName || `${m.seq.name} (theo nhịp)`);
  const r = await jsx(bridge, `var base=__seq(null,${q(m.seq.id)});${FIND_ADJ}var newName=${q(newName)};
if(__seq(newName,null))return JSON.stringify({success:false,error:'A sequence named '+newName+' already exists — pick another newSequenceName (nothing was changed).'});
var before={};var sq=app.project.sequences;for(var i=0;i<sq.numSequences;i++)before[sq[i].sequenceID]=true;
base.clone();var s=null;sq=app.project.sequences;for(var i=0;i<sq.numSequences;i++)if(!before[sq[i].sequenceID])s=sq[i];
if(!s)return JSON.stringify({success:false,error:'clone failed'});s.name=newName;
var tr=s.videoTracks[${vt}];var plan=${q(plan)};var keep=[];var ids={};var spans=[];
for(var i=0;i<tr.clips.numItems;i++){var c=tr.clips[i];if(__isAdj(c))continue;var M=__comp(c,'Motion');var mv={};
 var names=['Scale','Position','Rotation','Anchor Point'];for(var n=0;n<names.length;n++){var pp=__prop(M,names[n]);try{if(pp&&!pp.isTimeVarying())mv[names[n]]=pp.getValue();}catch(e){}}
 keep.push({it:c.projectItem,motion:mv});ids[c.projectItem.nodeId]=true;spans.push([c.start.seconds,c.end.seconds]);}
for(var i=tr.clips.numItems-1;i>=0;i--){if(!__isAdj(tr.clips[i]))tr.clips[i].remove(false,false);}
for(var a=0;a<s.audioTracks.numTracks;a++){var at=s.audioTracks[a];for(var k=at.clips.numItems-1;k>=0;k--){var ac=at.clips[k];var hit=false;try{hit=ids[ac.projectItem.nodeId];}catch(e){}
 if(!hit)continue;for(var z=0;z<spans.length;z++){if(ac.start.seconds<spans[z][1]-0.01&&ac.end.seconds>spans[z][0]+0.01){ac.remove(false,false);break;}}}}
var placed=0,errors=[];
var cursor=null;
for(var r=0;r<plan.length&&r<keep.length;r++){var row=plan[r];var it=keep[r].it;
 // place at the real end of the previous clip, end on the planned beat
 var at=cursor===null?row.at:cursor;var out=row.outS-(at-row.at);
 try{it.setInPoint(row.inS,4);it.setOutPoint(out,4);}catch(e1){}
 tr.overwriteClip(it,at);var got=null;
 for(var c2=0;c2<tr.clips.numItems;c2++){var cl=tr.clips[c2];if(Math.abs(cl.start.seconds-at)<0.05&&cl.projectItem.nodeId==it.nodeId){got=cl;break;}}
 if(!got){errors.push(row.name+': not placed');continue;}
 try{got.name=row.name;}catch(e2){}
 var M2=__comp(got,'Motion');for(var key in keep[r].motion){var p2=__prop(M2,key);try{if(p2)p2.setValue(keep[r].motion[key],true);}catch(e3){errors.push(row.name+': '+key);}}
 placed++;cursor=got.end.seconds;try{it.clearInPoint();it.clearOutPoint();}catch(e4){}}
try{app.project.openSequence(s.sequenceID);}catch(e5){}
return JSON.stringify({success:true,sequence:s.name,sequenceId:s.sequenceID,placed:placed,errors:errors});`, 600000);
  return {
    tool: 'cut_to_beats', ...r, bpm: m.files.map((f) => f.bpm), every: args.every ?? 1,
    onBeat: plan.filter((p) => p.onBeat).length, clips: plan.length,
    changes: plan.map((p) => `${p.name}: ${p.was}s → ${Math.round((p.outS - p.inS) * 1000) / 1000}s @ ${p.at}s`),
    note: 'The original sequence is untouched. Colour layers on upper tracks still follow the old cuts: run add_scene_color_layers / sync_color_layers on the new sequence.'
  };
}

// ---- best takes

const FLUB = /\b(otra vez|de nuevo|una vez m[aá]s|again|one more|sorry|perd[oó]n|esp[eé]ra(me)?|wait|hold on|l[aạ]i đi|lần nữa|xin lỗi|khoan|quay lại)\b/i;

export interface ScoredTake { id: string; score: number; reasons: string[] }

/** Score a take from what the Dailies engine heard. Higher is better; reasons say why. Pure, for tests. */
export function scoreTake(t: MediaTake & { khau_lenh_ra?: { loai?: string; chu?: string } | null; ket_thuc_bang?: string }, words: { chu: string; vao: number; ra: number; xac_suat?: number }[], fps: number): ScoredTake {
  let score = 50;
  const reasons: string[] = [];
  if (t.ca_file) { score -= 20; reasons.push('không nghe thấy khẩu lệnh, lấy cả file'); }
  if (t.ket_thuc_bang === 'khau_lenh_ra') { score += 15; reasons.push(`kết thúc bằng "${t.khau_lenh_ra?.chu ?? 'cắt'}"`); }
  else if (!t.ca_file) { score -= 5; reasons.push('không có lệnh cắt, có thể bị ngắt'); }
  score += Math.round((t.do_tin_cay ?? 0) * 10);
  const len = t.ra_giay - t.vao_giay;
  if (len < 1.5) { score -= 20; reasons.push(`quá ngắn (${len.toFixed(1)} s)`); }
  const inside = words.filter((w) => w.vao / fps >= t.vao_giay - 0.2 && w.ra / fps <= t.ra_giay + 0.2);
  const after = words.filter((w) => w.vao / fps > t.ra_giay && w.vao / fps <= t.ra_giay + 3);
  const conf = inside.filter((w) => typeof w.xac_suat === 'number').map((w) => w.xac_suat!);
  if (conf.length >= 3) {
    const mean = conf.reduce((a, b) => a + b, 0) / conf.length;
    score += Math.max(-10, Math.min(10, Math.round((mean - 0.6) * 40)));
    if (mean < 0.5) reasons.push('thoại nghe không rõ');
  }
  const text = inside.concat(after).map((w) => w.chu).join(' ');
  const flubs = text.match(new RegExp(FLUB.source, 'gi')) ?? [];
  if (flubs.length) { score -= Math.min(30, 15 * flubs.length); reasons.push(`có tiếng gọi làm lại: "${flubs.slice(0, 2).join('", "')}"`); }
  const later = Math.min(9, 3 * ((t.take_trong_file ?? 1) - 1));
  if (later) { score += later; reasons.push('take sau (diễn viên đã vào nhịp)'); }
  return { id: t.id, score: Math.max(0, Math.min(100, score)), reasons };
}

async function selectBestTakes(bridge: PremiereProTransport, args: Record<string, any>) {
  const src = await mediaSource(bridge, args);
  if ('error' in src) return { success: false, tool: 'select_best_takes', error: src.error };
  const job = await runDailies(['take-khau-lenh', ...src.cli, '--json', '--khung', String(args.frame ?? '1920x1080')], (args.waitSeconds ?? 45) * 1000, args.fast !== false);
  const problem = dailiesProblem(job, 'select_best_takes');
  if (problem) return problem;
  const out = parseDailies(job);
  const takes = (out.take ?? []) as any[];
  if (!takes.length) return { success: false, tool: 'select_best_takes', error: 'no takes found in this folder' };
  const scored = takes.map((t) => {
    const pf = join(String(out.thu_muc ?? src.folder), '.dailies', 'phan_tich', `${t.media_id}.json`);
    let words: any[] = [];
    let fps = t.fps ? t.fps.tu / t.fps.mau : 25;
    if (existsSync(pf)) {
      const j = JSON.parse(readFileSync(pf, 'utf8'));
      fps = j.fps.tu / j.fps.mau;
      words = (j.transcript?.cau ?? []).flatMap((c: any) => c.tu ?? []);
    }
    return { take: t, ...scoreTake(t, words, fps) };
  });
  const groupBy = args.groupBy ?? 'file';
  const groups = new Map<string, typeof scored>();
  for (const s of scored) {
    const k = groupBy === 'none' ? 'all' : s.take.file;
    groups.set(k, [...(groups.get(k) ?? []), s]);
  }
  const keep = args.keep ?? 1;
  const picked: typeof scored = [];
  const report = [...groups.entries()].map(([k, list]) => {
    const ranked = [...list].sort((a, b) => b.score - a.score);
    picked.push(...ranked.slice(0, keep));
    return { group: groupBy === 'none' ? 'all' : basename(k), ranking: ranked.map((r) => ({ take: `${r.take.ten_file.replace(/\.[^.]+$/, '')} T${r.take.take_trong_file}`, id: r.id, score: r.score, why: r.reasons })) };
  });
  let sequence: any = null;
  if (args.sequenceName) {
    const rows = layoutTakes(picked.map((p) => p.take) as MediaTake[], args.gapSeconds ?? 0, 0).map((r) => {
      const p = picked.find((x) => x.id === r.id)!;
      return { ...r, marker: `${r.marker} · điểm ${p.score} · ${p.reasons.join('; ')}` };
    });
    const files = Array.from(new Set(rows.map((r) => r.file)));
    const frame = out.khung ? { w: out.khung.rong, h: out.khung.cao } : null;
    const insp = await inspectFor(src, args.frame ?? '1920x1080', args.fps);
    const seed = insp ? seedFile(files, insp.byFile, insp ? insp.sequence.fps.tu / insp.sequence.fps.mau : 0) : null;
    sequence = await jsx(bridge, takesSequenceJsx(String(args.sequenceName), files, rows, frame, args.gapSeconds ?? 0, seed), 600000);
    sequence.inspection = inspectionNote(insp, seed);
  }
  return { success: true, tool: 'select_best_takes', takes: takes.length, picked: picked.map((p) => p.id), groups: report, sequence, note: 'Scores come from what was heard (cues, clarity, retake calls); always check the picks by eye.' };
}

// ---- voiceover

/** Speaking windows of a voiceover from ffmpeg silencedetect output. Pure, for tests. */
export function speechWindows(silences: { a: number; b: number }[], duration: number, mergeGap = 0.8, minLen = 0.15): { a: number; b: number }[] {
  const sorted = [...silences].sort((x, y) => x.a - y.a);
  const speech: { a: number; b: number }[] = [];
  let cur = 0;
  for (const s of sorted) {
    if (s.a > cur + 1e-3) speech.push({ a: cur, b: s.a });
    cur = Math.max(cur, s.b);
  }
  if (duration > cur + 1e-3) speech.push({ a: cur, b: duration });
  const merged: { a: number; b: number }[] = [];
  for (const w of speech.filter((w) => w.b - w.a >= minLen)) {
    const last = merged[merged.length - 1];
    if (last && w.a - last.b < mergeGap) last.b = w.b;
    else merged.push({ ...w });
  }
  return merged.map((w) => ({ a: Math.round(w.a * 1000) / 1000, b: Math.round(w.b * 1000) / 1000 }));
}

function detectSilences(file: string, noiseDb = -35, minSilence = 0.35): Promise<{ silences: { a: number; b: number }[]; duration: number | null }> {
  return new Promise((resolve) => {
    const p = spawn(ffmpegPath(), ['-hide_banner', '-nostats', '-i', file, '-vn', '-af', `silencedetect=noise=${noiseDb}dB:d=${minSilence}`, '-f', 'null', '-']);
    let err = '';
    p.stderr.on('data', (d: Buffer) => (err += d.toString()));
    p.on('error', () => resolve({ silences: [], duration: null }));
    p.on('close', () => {
      const dm = /Duration:\s*(\d+):(\d+):([\d.]+)/.exec(err);
      const duration = dm ? +dm[1]! * 3600 + +dm[2]! * 60 + +dm[3]! : null;
      const silences: { a: number; b: number }[] = [];
      let open: number | null = null;
      for (const line of err.split('\n')) {
        const s = /silence_start:\s*(-?[\d.]+)/.exec(line);
        const e = /silence_end:\s*([\d.]+)/.exec(line);
        if (s) open = Math.max(0, +s[1]!);
        if (e && open !== null) { silences.push({ a: open, b: +e[1]! }); open = null; }
      }
      if (open !== null && duration) silences.push({ a: open, b: duration });
      resolve({ silences, duration });
    });
  });
}

async function placeVoiceover(bridge: PremiereProTransport, args: Record<string, any>) {
  const file = String(args.file);
  if (!existsSync(file)) return { success: false, error: `file not found: ${file}` };
  const { silences, duration } = await detectSilences(file, args.silenceDb ?? -35);
  if (!duration) return { success: false, error: 'could not read the voiceover length' };
  const windows = speechWindows(silences, duration);
  const r = await jsx(bridge, `${SEQ_PICK(args)}${VOL}var path=${q(file)};var dur=${duration};var win=${q(windows)};var fade=${args.fadeSeconds ?? 0.25};var duck=${args.duckDb ?? -10};
var it=__byPath(path);if(!it){app.project.importFiles([path],true,__bin('Voiceover'),false);it=__byPath(path);}if(!it)return JSON.stringify({success:false,error:'import failed'});
try{it.clearInPoint();it.clearOutPoint();}catch(e){}
var at=${args.at === undefined ? 's.getPlayerPosition().seconds' : Number(args.at)};
function free(tr){for(var i=0;i<tr.clips.numItems;i++){var c=tr.clips[i];if(c.start.seconds<at+dur-0.01&&c.end.seconds>at+0.01)return false;}return true;}
var ti=${args.track === undefined ? -1 : Number(args.track)};if(ti<0){for(var t=0;t<s.audioTracks.numTracks;t++)if(free(s.audioTracks[t])){var used=s.audioTracks[t].clips.numItems>0;if(!used||ti<0){ti=t;if(!used)break;}}}
if(ti<0||!s.audioTracks[ti])return JSON.stringify({success:false,error:'no free audio track for '+dur.toFixed(1)+' s at '+at.toFixed(2)+' s',hint:'add an audio track (add_track) or pass track'});
var tr=s.audioTracks[ti];tr.overwriteClip(it,at);var vo=null;for(var i=0;i<tr.clips.numItems;i++){var c=tr.clips[i];if(Math.abs(c.start.seconds-at)<0.05){vo=c;break;}}
if(!vo)return JSON.stringify({success:false,error:'voiceover not placed'});
var gain=${args.voGainDb === undefined ? 'null' : Number(args.voGainDb)};if(gain!==null){var lv=__level(vo);if(lv)lv.setValue(__fromDb(gain),true);}
function st(c,x){return c.inPoint.seconds+(Math.max(c.start.seconds,Math.min(c.end.seconds,x))-c.start.seconds);}
var duckTracks=${q(args.duckTracks ?? null)};var ducked=[];var musicRe=/\\.(wav|mp3|aif|aiff|m4a|aac|flac)$/i;
for(var t=0;t<s.audioTracks.numTracks;t++){if(t==ti)continue;var tt=s.audioTracks[t];
 for(var i=0;i<tt.clips.numItems;i++){var c=tt.clips[i];var p='';try{p=String(c.projectItem.getMediaPath());}catch(e){}
  var want=duckTracks?(function(){for(var d=0;d<duckTracks.length;d++)if(duckTracks[d]==t)return true;return false;})():musicRe.test(p);if(!want)continue;
  var lv=__level(c);if(!lv)continue;var keys=0;
  for(var w=0;w<win.length;w++){var a=at+win[w].a,b=at+win[w].b;if(b<=c.start.seconds||a>=c.end.seconds)continue;
   var base=lv.isTimeVarying()?__toDb(lv.getValueAtTime(st(c,a-fade))):__toDb(lv.getValue());
   if(!lv.isTimeVarying())lv.setTimeVarying(true);
   var pts=[[a-fade,base],[a,base+duck],[b,base+duck],[b+fade,base]];
   for(var k=0;k<pts.length;k++){var tt2=st(c,pts[k][0]);lv.addKey(tt2);lv.setValueAtKey(tt2,__fromDb(pts[k][1]),true);keys++;}}
  if(keys)ducked.push('A'+(t+1)+' '+c.name+' ('+keys+' keys)');}}
return JSON.stringify({success:true,track:'A'+(ti+1),at:at,duration:dur,ducked:ducked});`, 180000);
  return { tool: 'place_voiceover', ...r, speech: windows.length, windows: windows.slice(0, 12), hint: r?.success && !r.ducked?.length ? 'no music clip under the voiceover to duck (pass duckTracks to pick tracks)' : undefined };
}

// ---- loudness

function measureRange(file: string, from: number, length: number): Promise<number | null> {
  return new Promise((resolve) => {
    const p = spawn(ffmpegPath(), ['-hide_banner', '-nostats', '-ss', String(Math.max(0, from)), '-t', String(Math.max(0.1, length)), '-i', file, '-vn', '-af', 'loudnorm=I=-16:TP=-1:LRA=11:print_format=json', '-f', 'null', '-']);
    let err = '';
    p.stderr.on('data', (d: Buffer) => (err += d.toString()));
    p.on('error', () => resolve(null));
    p.on('close', () => {
      const j = /\{[^{}]*"input_i"[^{}]*\}/.exec(err);
      const v = j ? Number(JSON.parse(j[0]).input_i) : NaN;
      resolve(Number.isFinite(v) ? v : null);
    });
  });
}

export type AudioRole = 'dialogue' | 'voiceover' | 'music';

/** Role of an audio clip: camera audio is dialogue, audio-only files are music unless named like a voiceover. Pure, for tests. */
export function audioRole(c: { track: number; file: string | null }, musicTracks?: number[], dialogueTracks?: number[]): AudioRole {
  if (musicTracks?.includes(c.track)) return 'music';
  if (dialogueTracks?.includes(c.track)) return 'dialogue';
  if (!c.file || !AUDIO_EXT.test(c.file)) return 'dialogue';
  return VO_NAME.test(basename(c.file)) ? 'voiceover' : 'music';
}

async function normalizeLoudness(bridge: PremiereProTransport, args: Record<string, any>) {
  const a = await readAudio(bridge, args);
  if (!a?.success) return { tool: 'normalize_loudness', ...a };
  const clips = (a.clips as AudioClip[]).filter((c) => c.file && (!args.tracks || args.tracks.includes(c.track)));
  const roles = clips.map((c) => audioRole(c, args.musicTracks, args.dialogueTracks));
  const speech = roles.some((r) => r !== 'music');
  const target = (r: AudioRole) => (r === 'music' ? (speech ? args.musicTarget ?? -26 : args.target ?? -16) : args.target ?? -16);
  const plan: { track: number; index: number; name: string; role: AudioRole; lufs: number | null; gainDb: number | null; capped?: boolean }[] = [];
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i]!;
    const lufs = await measureRange(c.file!, c.inS, c.outS - c.inS);
    let gainDb: number | null = null, capped = false;
    if (lufs !== null && lufs > -60) {
      gainDb = Math.round((target(roles[i]!) - lufs) * 10) / 10;
      if (gainDb > 15) { gainDb = 15; capped = true; }
      if (gainDb < -30) { gainDb = -30; capped = true; }
    }
    plan.push({ track: c.track, index: c.index, name: c.name, role: roles[i]!, lufs: lufs === null ? null : Math.round(lufs * 10) / 10, gainDb, ...(capped ? { capped } : {}) });
  }
  if (args.dryRun) return { success: true, tool: 'normalize_loudness', plan };
  const todo = plan.filter((p) => p.gainDb !== null);
  const r = await jsx(bridge, `var s=__seq(null,${q(a.id)});${VOL}var todo=${q(todo)};var done=0,keyed=0,errors=[];
for(var i=0;i<todo.length;i++){var p=todo[i];var c=s.audioTracks[p.track].clips[p.index];var lv=c?__level(c):null;if(!lv){errors.push(p.name+': no Volume');continue;}
 try{if(lv.isTimeVarying()){var ks=lv.getKeys();var mx=-1e9;for(var k=0;k<ks.length;k++){var d=__toDb(lv.getValueAtKey(ks[k]));if(d>mx)mx=d;}
   var delta=p.gainDb-mx;for(var k2=0;k2<ks.length;k2++){lv.setValueAtKey(ks[k2],__fromDb(__toDb(lv.getValueAtKey(ks[k2]))+delta),true);}keyed++;}
  else lv.setValue(__fromDb(p.gainDb),true);done++;}catch(e){errors.push(p.name+': '+e);}}
return JSON.stringify({success:true,set:done,keyframedClips:keyed,errors:errors});`, 180000);
  return { tool: 'normalize_loudness', ...r, targets: { dialogue: args.target ?? -16, music: speech ? args.musicTarget ?? -26 : args.target ?? -16 }, plan, note: 'Clip levels only; export_deliverables still normalises the final mix per platform.' };
}

// ---- review

interface ReviewClip { track: number; file: string | null; name: string; start: number; end: number; inS: number; outS: number; adj: boolean; disabled: boolean }

/** Edit review of one video track. Pure, for tests. */
export function reviewFindings(clips: ReviewClip[], fd: number, opts: { maxShot?: number | undefined; targetSeconds?: number | undefined; beats?: number[] | undefined } = {}) {
  const main = clips.filter((c) => !c.adj).sort((a, b) => a.start - b.start);
  const findings: { kind: string; at: number; detail: string }[] = [];
  const lens = main.map((c) => c.end - c.start);
  const maxShot = opts.maxShot ?? 5;
  let cur = main[0]?.start ?? 0;
  main.forEach((c, i) => {
    const len = c.end - c.start;
    if (c.start - cur > fd * 0.5) findings.push({ kind: 'gap', at: cur, detail: `black for ${Math.round((c.start - cur) / fd)} frame(s)` });
    cur = Math.max(cur, c.end);
    if (len <= fd * 3.5) findings.push({ kind: 'flash_frame', at: c.start, detail: `${c.name} is ${Math.round(len / fd)} frame(s)` });
    if (len > maxShot) findings.push({ kind: 'long_shot', at: c.start, detail: `${c.name} holds ${len.toFixed(1)} s (over ${maxShot} s)` });
    if (c.disabled) findings.push({ kind: 'disabled', at: c.start, detail: `${c.name} is switched off` });
    const prev = main[i - 1];
    if (prev && prev.file && prev.file === c.file) {
      const skip = c.inS - prev.outS;
      if (skip > -0.1 && skip < 2) findings.push({ kind: 'jump_cut', at: c.start, detail: `${prev.name} → ${c.name}: same shot, ${skip.toFixed(2)} s skipped` });
    }
  });
  main.forEach((c, i) => {
    for (const d of main.slice(0, i)) if (d.file && d.file === c.file && c.inS < d.outS - 0.1 && c.outS > d.inS + 0.1) {
      findings.push({ kind: 'reused_footage', at: c.start, detail: `${c.name} reuses footage already shown at ${d.start.toFixed(1)} s` });
      break;
    }
  });
  let beatStats: { cuts: number; onBeat: number; offBeat: { at: number; offFrames: number }[] } | null = null;
  if (opts.beats?.length) {
    const cuts = main.slice(1).map((c) => c.start);
    const off = cuts.map((t) => {
      const near = opts.beats!.reduce((a, b) => (Math.abs(b - t) < Math.abs(a - t) ? b : a));
      return { at: Math.round(t * 1000) / 1000, offFrames: Math.round((t - near) / fd) };
    });
    beatStats = { cuts: cuts.length, onBeat: off.filter((o) => Math.abs(o.offFrames) <= 1).length, offBeat: off.filter((o) => Math.abs(o.offFrames) > 1) };
  }
  const total = main.length ? Math.max(...main.map((c) => c.end)) - main[0]!.start : 0;
  if (opts.targetSeconds && Math.abs(total - opts.targetSeconds) > 0.5) findings.push({ kind: 'length', at: 0, detail: `cut is ${total.toFixed(1)} s, target ${opts.targetSeconds} s` });
  const avg = lens.length ? lens.reduce((a, b) => a + b, 0) / lens.length : 0;
  return {
    shots: main.length,
    total: Math.round(total * 100) / 100,
    averageShot: Math.round(avg * 100) / 100,
    shortest: lens.length ? Math.round(Math.min(...lens) * 100) / 100 : 0,
    longest: lens.length ? Math.round(Math.max(...lens) * 100) / 100 : 0,
    firstShot: lens.length ? Math.round(lens[0]! * 100) / 100 : 0,
    beats: beatStats,
    findings
  };
}

function runFfmpeg(args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn(ffmpegPath(), ['-hide_banner', '-v', 'error', '-y', ...args]);
    p.on('error', () => resolve(false));
    p.on('close', (code) => resolve(code === 0));
  });
}

async function reviewCut(bridge: PremiereProTransport, args: Record<string, any>) {
  const vt = args.videoTrack ?? 0;
  const r = await jsx(bridge, `${SEQ_PICK(args)}${FIND_ADJ}var V=[];var fd=s.getSettings().videoFrameRate.seconds;var tr=s.videoTracks[${vt}];if(!tr)return JSON.stringify({success:false,error:'no video track ${vt + 1}'});
for(var i=0;i<tr.clips.numItems;i++){var c=tr.clips[i];var p=null;try{p=String(c.projectItem.getMediaPath());}catch(e){}
 V.push({track:${vt},file:p,name:c.name,start:c.start.seconds,end:c.end.seconds,inS:c.inPoint.seconds,outS:c.outPoint.seconds,adj:__isAdj(c),disabled:!!c.disabled});}
return JSON.stringify({success:true,id:s.sequenceID,name:s.name,project:String(app.project.path),fd:fd,clips:V});`);
  if (!r?.success) return { tool: 'review_cut', ...r };
  let beats: number[] | undefined;
  if (args.checkBeats !== false) {
    try {
      const m = await musicBeatsOnTimeline(bridge, { sequenceId: r.id, musicTrack: args.musicTrack });
      if (m.ok && m.beats.length) beats = m.beats;
    } catch { /* no music analysis */ }
  }
  const review = reviewFindings(r.clips, r.fd, { maxShot: args.maxShot, targetSeconds: args.targetSeconds, beats });
  let sheet: string | null = null;
  if (args.contactSheet !== false) {
    const dir = join(String(r.project).replace(/[^/]+$/, ''), 'Review', String(r.name).replace(/[\\/:*?"<>|]/g, ' '));
    mkdirSync(dir, { recursive: true });
    const font = '/System/Library/Fonts/Supplemental/Arial Unicode.ttf';
    const main = (r.clips as ReviewClip[]).filter((c) => !c.adj && c.file).sort((a, b) => a.start - b.start);
    let n = 0;
    for (const c of main) {
      const prox = join(c.file!.replace(/[^/]+$/, ''), 'Proxies', `${basename(c.file!).replace(/\.[^.]+$/, '')}_Proxy.mov`);
      const src = existsSync(prox) ? prox : c.file!;
      const label = `${n + 1}  ${c.start.toFixed(1)}s  ${(c.end - c.start).toFixed(1)}s`;
      const vf = `scale=320:180:force_original_aspect_ratio=decrease,pad=320:180:(ow-iw)/2:(oh-ih)/2,drawtext=fontfile='${font}':text='${label}':x=8:y=8:fontsize=15:fontcolor=white:box=1:boxcolor=black@0.55`;
      if (await runFfmpeg(['-ss', String((c.inS + c.outS) / 2), '-i', src, '-frames:v', '1', '-vf', vf, '-q:v', '3', join(dir, `f_${String(++n).padStart(3, '0')}.jpg`)])) continue;
      n--;
    }
    if (n) {
      const cols = Math.min(6, n);
      const out = join(dir, 'contact sheet.jpg');
      if (await runFfmpeg(['-start_number', '1', '-i', join(dir, 'f_%03d.jpg'), '-vf', `tile=${cols}x${Math.ceil(n / cols)}:padding=4:color=black`, '-frames:v', '1', '-q:v', '3', out])) sheet = out;
    }
  }
  let markers = 0;
  if (args.markers !== false) {
    const mk = await jsx(bridge, `var s=__seq(null,${q(r.id)});var f=${q(review.findings)};
var m=s.markers.getFirstMarker();var old=[];while(m){if(String(m.name).indexOf('Review:')===0)old.push(m);m=s.markers.getNextMarker(m);}for(var i=0;i<old.length;i++){try{s.markers.deleteMarker(old[i]);}catch(e){}}
for(var j=0;j<f.length;j++){var x=s.markers.createMarker(f[j].at);x.name='Review: '+f[j].kind;x.comments=f[j].detail;try{x.setColorByIndex(3);}catch(e){}}
return JSON.stringify({success:true,count:f.length});`);
    markers = mk?.count ?? 0;
  }
  return { success: true, tool: 'review_cut', sequence: r.name, ...review, markers, contactSheet: sheet };
}

// ---------------------------------------------------------------- clean-up after delivery

/** JSX: every project item with whether a kept timeline uses it. */
const USAGE_JSX = (keep: string[] | null) => `var keep=${q(keep)};var S=app.project.sequences;var byNode={};var names=[];
for(var i=0;i<S.numSequences;i++){byNode[S[i].projectItem.nodeId]=S[i];names.push(S[i].name);}
function has(a,v){if(!a)return true;for(var i=0;i<a.length;i++)if(a[i]==v)return true;return false;}
if(keep){var miss=[];for(var k=0;k<keep.length;k++)if(!has(names,keep[k]))miss.push(keep[k]);if(miss.length)return JSON.stringify({success:false,error:'no sequence named: '+miss.join(', '),sequences:names});}
var used={},seen={};
function mark(s){if(seen[s.sequenceID])return;seen[s.sequenceID]=1;used[s.projectItem.nodeId]=1;var G=[s.videoTracks,s.audioTracks];
 for(var g=0;g<2;g++){for(var t=0;t<G[g].numTracks;t++){var tr=G[g][t];for(var c=0;c<tr.clips.numItems;c++){var pi=tr.clips[c].projectItem;if(!pi)continue;used[pi.nodeId]=1;var ns=byNode[pi.nodeId];if(ns)mark(ns);}}}}
for(var i=0;i<S.numSequences;i++)if(has(keep,S[i].name))mark(S[i]);
var items=[];function walk(b){for(var i=0;i<b.children.numItems;i++){var c=b.children[i];if(c.type==2){walk(c);continue;}
 var p=null;try{p=String(c.getMediaPath());if(!p||p=='undefined')p=null;}catch(e){}var px=null;try{if(c.hasProxy())px=String(c.getProxyPath());}catch(e2){}
 var isSeq=!!byNode[c.nodeId];items.push({id:c.nodeId,name:c.name,path:p,proxy:px,isSequence:isSeq,used:!!used[c.nodeId]});}}
walk(app.project.rootItem);`;

async function reviewUnused(bridge: PremiereProTransport, args: Record<string, any>) {
  const keep = args.keepSequences?.length ? args.keepSequences as string[] : null;
  const r = await jsx(bridge, `${USAGE_JSX(keep)}return JSON.stringify({success:true,project:String(app.project.path),items:items});`, 180000);
  if (!r?.success) return { tool: 'review_unused_media', ...r };
  const items = r.items as ProjectMediaItem[];
  const jobFolder = String(args.jobFolder ?? jobFolderFor(r.project));
  const plan = planCleanup(items, { jobFolder, trashProxiesOfUsed: !!args.trashProxiesOfUsed, scanFolders: args.scanFolders !== false });
  const trash = withSizes(plan.trash);
  const inUse = withSizes(plan.usedFiles.map((p) => ({ path: p })));
  const total = trash.reduce((a, b) => a + b.size, 0);
  const { file } = writeReport({
    app: 'premiere', project: r.project, thu_muc_job: jobFolder, giu: keep ?? ['(mọi sequence)'],
    dang_dung: inUse, xoa_khoi_project: plan.removeFromProject, dua_vao_trash: trash, tong_dung_luong: total,
    canh_bao: ['File trong thư mục nguồn có thể đang dùng ở project khác: xem danh sách trước khi dọn.']
  });
  return {
    success: true, tool: 'review_unused_media', report: file,
    project: r.project, jobFolder, keep: keep ?? 'every sequence',
    onlyRemovedFromProject: plan.removeFromProject.filter((i) => i.ly_do.includes('ngoài thư mục job')).length,
    inUse: inUse.length, removeFromProject: plan.removeFromProject.length, toTrash: trash.length, frees: humanSize(total),
    biggest: [...trash].sort((a, b) => b.size - a.size).slice(0, 20).map((t) => `${humanSize(t.size)}  ${t.path}  (${t.ly_do})`),
    projectItems: plan.removeFromProject.slice(0, 40).map((i) => `${i.name} — ${i.ly_do}`),
    next: `Show the user the list. When they agree: clean_unused_media { report: "${file}", confirm: true }`
  };
}

async function cleanUnused(bridge: PremiereProTransport, args: Record<string, any>) {
  if (!existsSync(String(args.report))) return { success: false, error: `report not found: ${args.report}` };
  const rep = JSON.parse(readFileSync(String(args.report), 'utf8')) as CleanupReport;
  if (rep.app !== 'premiere') return { success: false, error: 'this report is from After Effects — use project.clean_unused there' };
  if (args.confirm !== true) return { success: false, tool: 'clean_unused_media', error: 'confirm must be true', removeFromProject: rep.xoa_khoi_project.length, toTrash: rep.dua_vao_trash.length, frees: humanSize(rep.tong_dung_luong) };
  const keep = rep.giu[0] === '(mọi sequence)' ? null : rep.giu;
  const now = await jsx(bridge, `${USAGE_JSX(keep)}return JSON.stringify({success:true,project:String(app.project.path),items:items});`, 180000);
  if (!now?.success) return { tool: 'clean_unused_media', ...now };
  if (now.project !== rep.project) return { success: false, error: `the open project is ${now.project}, the report is for ${rep.project}` };
  const items = now.items as ProjectMediaItem[];
  const usedNow = new Set(items.filter((i) => i.used).map((i) => i.id));
  const fresh = planCleanup(items, { trashProxiesOfUsed: rep.dua_vao_trash.some((t) => t.ly_do.startsWith('proxy của file đang dùng')), scanFolders: false });
  const keepFiles = new Set(fresh.usedFiles.map((p) => p.normalize('NFC')));
  const checkpoint = await checkpointProject(bridge, { label: 'truoc khi don' });
  if (!checkpoint.success) return { tool: 'clean_unused_media', ...checkpoint };
  let removed: any = null;
  const skipped: string[] = [];
  if (args.removeFromProject !== false) {
    const ids = rep.xoa_khoi_project.filter((i) => { if (usedNow.has(i.id)) { skipped.push(`${i.name}: đã được dùng lại`); return false; } return items.some((x) => x.id === i.id); }).map((i) => i.id);
    removed = await jsx(bridge, `var ids=${q(ids)};var want={};for(var i=0;i<ids.length;i++)want[ids[i]]=1;var hits=[],parents=[];
function walk(b){for(var i=0;i<b.children.numItems;i++){var c=b.children[i];if(c.type==2)walk(c);else if(want[c.nodeId]){hits.push(c);parents.push(b);}}}
walk(app.project.rootItem);
var trashBin=app.project.rootItem.createBin('_MCP don dep');var moved=0,errors=[];
for(var h=0;h<hits.length;h++){try{hits[h].moveBin(trashBin);moved++;}catch(e){errors.push(hits[h].name+': '+e);}}
var gone=false;try{trashBin.deleteBin();gone=true;}catch(e2){errors.push('deleteBin: '+e2);}
var emptied=0;for(var k=0;k<parents.length;k++){var b=parents[k];try{if(b!==app.project.rootItem&&b.children.numItems===0){b.deleteBin();emptied++;}}catch(e3){}}
app.project.save();
return JSON.stringify({success:gone,removed:moved,emptyBinsRemoved:emptied,errors:errors});`, 300000);
  }
  let trash: any = null;
  if (args.trashFiles !== false) {
    const job = rep.thu_muc_job ?? jobFolderFor(rep.project);
    const paths = rep.dua_vao_trash.map((t) => t.path).filter((p) => {
      if (keepFiles.has(p.normalize('NFC'))) { skipped.push(`${p}: đang dùng`); return false; }
      if (!insideFolder(p, job)) { skipped.push(`${p}: ngoài thư mục job ${job}`); return false; }
      return true;
    });
    const t = await moveToTrash(paths);
    trash = { trashed: t.trashed.length, failed: t.failed, freed: humanSize(rep.dua_vao_trash.filter((x) => t.trashed.includes(x.path)).reduce((a, b) => a + b.size, 0)) };
  }
  return { success: true, tool: 'clean_unused_media', checkpoint: checkpoint.checkpoint, project: removed, trash, skipped, note: 'Files are in the Trash (Put Back restores them). Empty the Trash yourself when you are sure.' };
}
