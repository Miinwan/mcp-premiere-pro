import { z } from 'zod';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { PremiereProTransport } from '../bridge/types.js';
import type { MCPTool } from './index.js';
import { encodeRgbaPng } from './expanded.js';
import { exportJob, PRESETS as DELIVERABLES, startExportJob, waitJob } from './deliverables.js';

/**
 * Studio tools (Minwan): rough cut from slate cues and shot descriptions via
 * the MCP Adobe media engine (`media` CLI in MCP Adobe/Media, JSON contract v1
 * in Media/README.md), and a round trip to After Effects
 * through a handoff JSON that the After Effects MCP reads and writes
 * (bridge.from_premiere / bridge.to_premiere). Nothing is destructive: the
 * rough cut goes into a NEW sequence, and an AE render is laid on the track
 * above the original, which is only disabled.
 */
export const studioToolNames = [
  'rough_cut_by_cues',
  'describe_sources',
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
  'qc_before_export'
] as const;

export function isStudioTool(name: string): boolean {
  return (studioToolNames as readonly string[]).includes(name);
}

// ---------------------------------------------------------------- media CLI

const MEDIA_DIR = process.env.MEDIA_DIR || join(homedir(), 'Desktop', '03. Code', 'MCP Adobe', 'Media');
function uvPath(): string {
  for (const p of [process.env.UV_PATH, join(homedir(), '.local/bin/uv'), '/opt/homebrew/bin/uv', '/usr/local/bin/uv']) {
    if (p && existsSync(p)) return p;
  }
  return 'uv';
}

interface MediaJob {
  key: string;
  args: string[];
  started: number;
  done: boolean;
  code: number | null;
  stdout: string;
  stderrTail: string[];
  waiters: Array<() => void>;
}
const jobs = new Map<string, MediaJob>();

/** Start (or join) a media run; resolves when it ends or after waitMs, whichever comes first. */
async function runMedia(args: string[], waitMs: number, fast: boolean): Promise<MediaJob> {
  const key = args.join('\u0000');
  let job = jobs.get(key);
  if (!job || (job.done && job.code !== 0)) {
    const j: MediaJob = { key, args, started: Date.now(), done: false, code: null, stdout: '', stderrTail: [], waiters: [] };
    const child = spawn(uvPath(), ['run', 'media', ...args], {
      cwd: MEDIA_DIR,
      env: { ...process.env, ...(fast ? { MEDIA_CHE_DO: 'nhanh' } : {}) }
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

function parseMedia(job: MediaJob): any {
  try { return JSON.parse(job.stdout); } catch { return null; }
}

/** Shared handling of exit codes 1/3/4 and "still running". Returns null when the JSON is usable. */
function mediaProblem(job: MediaJob, tool: string): any | null {
  if (!job.done) {
    return {
      success: true, tool, status: 'running',
      elapsedSec: Math.round((Date.now() - job.started) / 1000),
      progress: job.stderrTail.slice(-3),
      next: `Call ${tool} again with the same arguments to wait for the result (results are cached next to the footage, nothing restarts).`
    };
  }
  const out = parseMedia(job);
  if (job.code === 0 && out) return null;
  if (job.code === 3) return { success: false, tool, needsConfirmation: true, question: out?.cau_hoi ?? out, hint: 'Ask anh Quang first: the media engine needs his OK (usually a download).' };
  if (job.code === 4) return { success: false, tool, missingModel: true, detail: out, hint: 'The deep mode model is not installed: run `uv run media cai-mo-ta --model 2b --json` in MCP Adobe/Media after anh agrees, or use mode fast.' };
  return { success: false, tool, exitCode: job.code, error: out?.thong_bao ?? out?.loi ?? 'media engine failed', stderr: job.stderrTail.slice(-6) };
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
        'Rough-cut a folder of raw footage by the slate cues anh calls on set ("3, 2, 1", "action", "diễn", "đi" to start; "cắt", "cut", "ok", "được rồi" to end), heard by Whisper in each file\'s own audio through the MCP Adobe media engine. ' +
        'One source can give many takes. Builds a NEW sequence with every take back to back, a→z by file then time, so anh reorders them himself; each take gets a sequence marker (take id, cue heard, dialogue, confidence) and low-confidence takes a red marker. Files with no cue are kept whole (unless dropNoCue). ' +
        'Analysis is cached next to the footage (.media/); a long first run returns status "running" — call again with the same arguments to pick up the result.',
      inputSchema: z.object({
        sourceFolder: z.string().describe('Absolute path of the footage folder'),
        sequenceName: z.string().optional().describe('New sequence name (default "Rough cut <folder>")'),
        frame: z.string().optional().describe('Sequence frame: "1920x1080" (default), "9:16", "1:1", "4:5" or "<w>x<h>". The media engine fits each take (4K → 50 %, other ratios fill the frame centred on faces) and the scale/position go into Motion'),
        gapSeconds: z.number().min(0).optional().describe('Gap between takes in seconds (default 0)'),
        lowConfidence: z.number().min(0).max(1).optional().describe('Takes below this confidence get a red marker (default 0.6)'),
        dropNoCue: z.boolean().optional().describe('Leave out files with no cue (B-roll) instead of keeping them whole (default false)'),
        model: z.string().optional().describe('Whisper model (default large-v3)'),
        fast: z.boolean().optional().describe('Run the media engine in fast mode instead of the quiet background mode (default true: anh is waiting)'),
        waitSeconds: z.number().min(1).max(600).optional().describe('How long to wait for the media engine in this call before returning "running" (default 45)'),
        analyzeOnly: z.boolean().optional().describe('Only run the analysis and return the takes, do not touch Premiere')
      })
    },
    {
      name: 'describe_sources',
      description:
        'Describe every shot (file) in a footage folder through the media engine: Vietnamese one-line description, shot size, setting, content labels, sharpness, exposure, shake, faces, a beauty score. mode "fast" needs no download; "deep" adds a local vision model (Qwen3.5 2B MLX) for natural sentences. ' +
        'With writeToProject, the description goes into each imported clip\'s Comment column and the quality numbers into Log Note, so anh can search and sort in the Project panel.',
      inputSchema: z.object({
        sourceFolder: z.string().describe('Absolute path of the footage folder'),
        mode: z.enum(['fast', 'deep']).optional().describe('fast (default) or deep'),
        writeToProject: z.boolean().optional().describe('Write descriptions into the Project panel for clips already imported from this folder (default true)'),
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
        note: z.string().optional().describe('What to do in AE, e.g. "chữ tiêu đề bay vào + glow"')
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
        'Make square and vertical versions of a finished horizontal edit, the way anh does it by hand: duplicates the sequence as "<name> 1x1" / "<name> 9x16" (cuts, order, tracks, audio, titles unchanged), changes the frame, and re-frames every video clip from the horizontal version anh already adjusted (media `bo-cuc`: a window cut out of the horizontal frame, centred on faces when there are any, never showing black edges or anything anh cropped away). Only Motion Scale and Position change; Anchor Point, Rotation and Crop stay. Adjustment layers keep all their effects and are scaled to cover the new frame. Titles/graphics are left as they are and listed for a manual check.',
      inputSchema: z.object({
        ...seqRef,
        aspects: z.array(z.string()).optional().describe('Frames to make (default ["1:1", "9:16"]; also "4:5" or "<w>x<h>")'),
        replace: z.boolean().optional().describe('Rebuild a version that already exists (default false: stop and report)')
      })
    },
    {
      name: 'add_color_layer',
      description:
        'One colour layer over the whole sequence or a time range (a global look). For grading, anh works per scene: use add_scene_color_layers. Lays a colour-grading adjustment layer over the whole sequence (or a time range) on its own top track, with Lumetri Color ready to grade — the "layer edit màu" anh puts above the cut. Uses the project\'s Adjustment Layer item, importing one from Mako\'s template when the project has none (Premiere has no scripting call that creates one). Optional Lumetri Basic values (temperature, tint, exposure, contrast, highlights, shadows, whites, blacks, saturation, vibrance) and a Lumetri preset/LUT look.',
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
        'Put a solid colour background on the timeline without Premiere\'s colour picker (which blocks scripting): white or black by default — the plate a logo sits on — or any #RRGGBB. Made at the sequence frame size, saved next to the project in "MCP mattes" (reused, never in a temp folder that could go offline), imported into a "Nền màu" bin and placed on the given track for the given span (default: the whole sequence on a new bottom-most free track below the clips? no — on `track`, default V1 when it is free there, else a new track at the top so you can drag it under).',
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
        'Export a sequence for delivery: one ProRes 422 HQ master straight from Premiere (exportAsMediaDirect with the built-in "Match Source - Apple ProRes 422 HQ" preset), then every requested deliverable from it — youtube_4k, youtube_1080, reels (1080x1920), feed_4x5, square, led (screen width/height), review (720p, watermark + timecode), master, png_alpha — with sizes, bitrates and -14 LUFS loudness from pr_guide "Xuất file". Files are named "<Khách> <Tên video> <Tỉ lệ> V<n>" (next free version) and logged with the measured LUFS in "Kết quả xuất.md". Export the 9x16 / 1x1 sequences for vertical and square (create_aspect_versions) — another aspect is letterboxed.',
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
        'Grade per scene the way anh does: one adjustment layer with Lumetri Color per SOURCE on a new top track, named "Màu <source>". Neighbouring clips from the same source share one layer; the same source used again elsewhere on the timeline gets a layer with the same name and the same Lumetri values (keep them identical with sync_color_layers after grading one); a different source always gets its own layer. Titles/adjustment layers/graphics are skipped. Optional Lumetri Basic values for all (basic) or per source file name (perSource).',
      inputSchema: z.object({
        ...seqRef,
        sourceTrack: z.number().int().min(0).optional().describe('Video track holding the footage (default 0 = V1)'),
        basic: z.record(z.string(), z.number()).optional().describe('Lumetri Basic values for every scene'),
        perSource: z.record(z.string(), z.record(z.string(), z.number())).optional().describe('{ "FS_C0661": { exposure: 0.3 } } — by file name without extension')
      })
    },
    {
      name: 'sync_color_layers',
      description:
        'Make every colour layer of the same scene identical again after grading one of them: for each "Màu <source>" name, copies ALL Lumetri Color parameters (basic, creative, curves, wheels, HSL, vignette) from the master instance to the other instances of that name. master: a clip name + index or the instance under the playhead; default the first instance of each name. Different sources are never touched by each other.',
      inputSchema: z.object({
        ...seqRef,
        name: z.string().optional().describe('Only this layer name, e.g. "Màu FS_C0661" (default every "Màu …" group)'),
        fromPlayhead: z.boolean().optional().describe('Use the instance under the playhead as the master for its group (default false: the first instance)')
      })
    }
    ,{
      name: 'create_proxies',
      description:
        'FIRST STEP of a job: make edit proxies for every video in a footage folder so Premiere (and the media engine) work on light files instead of 4K. ProRes Proxy with the Mac hardware encoder (VideoToolbox, cool and fast), half resolution by default (4K → 1080p), same fps, duration and audio channels so Premiere accepts them; saved as "<folder>/Proxies/<name>_Proxy.mov", one file at a time at low priority so the machine stays cool. Existing proxies are reused. When done, attaches each proxy to its clip in the open project (Toggle Proxies in Premiere switches). Runs in the background: check with proxy_status.',
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
      inputSchema: z.object({ label: z.string().optional().describe('Short label, e.g. "truoc lam ban doc"'), list: z.boolean().optional().describe('Only list checkpoints') })
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
  ];
  return tools.filter((t) => !existingNames.has(t.name));
}

// ---------------------------------------------------------------- execution

export async function executeStudioTool(bridge: PremiereProTransport, name: string, args: Record<string, any>): Promise<any> {
  try {
    switch (name) {
      case 'rough_cut_by_cues': return await roughCut(bridge, args);
      case 'describe_sources': return await describeSources(bridge, args);
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

async function roughCut(bridge: PremiereProTransport, args: Record<string, any>) {
  const folder = String(args.sourceFolder);
  if (!existsSync(folder)) return { success: false, error: `folder not found: ${folder}` };
  const cli = ['take-khau-lenh', folder, '--json'];
  if (args.model) cli.push('--model', String(args.model));
  if (args.dropNoCue) cli.push('--bo-file-khong-lenh');
  cli.push('--khung', String(args.frame ?? '1920x1080'));
  const job = await runMedia(cli, (args.waitSeconds ?? 45) * 1000, args.fast !== false);
  const problem = mediaProblem(job, 'rough_cut_by_cues');
  if (problem) return problem;
  const out = parseMedia(job);
  const takes = out.take as MediaTake[];
  if (!takes?.length) return { success: false, error: 'no takes found in this folder', detail: out };
  const rows = layoutTakes(takes, args.gapSeconds ?? 0, args.lowConfidence ?? 0.6);
  const summary = { files: out.so_file, takes: out.so_take, noCueFiles: (out.file_khong_co_khau_lenh ?? []).length, cache: out.file_ket_qua };
  if (args.analyzeOnly) return { success: true, ...summary, takes: rows };

  const seqName = String(args.sequenceName || `Rough cut ${basename(folder)}`);
  const files = Array.from(new Set(rows.map((r) => r.file)));
  const frame = out.khung ? { w: out.khung.rong, h: out.khung.cao } : null;
  const body = `
var seqName=${q(seqName)};if(__seq(seqName,null))return JSON.stringify({success:false,error:'A sequence named '+seqName+' already exists — pick another sequenceName (nothing was changed).'});
var files=${q(files)};var rows=${q(rows)};
var bin=__bin(seqName);
var missing=[];for(var i=0;i<files.length;i++){if(!__byPath(files[i]))missing.push(files[i]);}
if(missing.length)app.project.importFiles(missing,true,bin,false);
var items={};for(var i=0;i<files.length;i++){var it=__byPath(files[i]);if(!it)return JSON.stringify({success:false,error:'import failed: '+files[i]});items[files[i]]=it;}
var seq=app.project.createNewSequenceFromClips(seqName,[items[rows[0].file]],bin);
if(!seq)return JSON.stringify({success:false,error:'could not create the sequence'});
var frame=${q(frame)};var frameSet=null;
if(frame){try{var st=seq.getSettings();st.videoFrameWidth=frame.w;st.videoFrameHeight=frame.h;seq.setSettings(st);frameSet=seq.frameSizeHorizontal+'x'+seq.frameSizeVertical;}catch(eS){frameSet='failed: '+eS;}}
for(var v=0;v<seq.videoTracks.numTracks;v++){var vt=seq.videoTracks[v];for(var k=vt.clips.numItems-1;k>=0;k--)vt.clips[k].remove(false,false);}
for(var a=0;a<seq.audioTracks.numTracks;a++){var at=seq.audioTracks[a];for(var k=at.clips.numItems-1;k>=0;k--)at.clips[k].remove(false,false);}
var placed=0,errors=[];var cursor=0;var gap=${q(args.gapSeconds ?? 0)};
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
  const r = await jsx(bridge, body, 600000);
  return { tool: 'rough_cut_by_cues', ...r, ...summary, lowConfidence: rows.filter((x) => x.low).map((x) => x.name) };
}

async function describeSources(bridge: PremiereProTransport, args: Record<string, any>) {
  const folder = String(args.sourceFolder);
  if (!existsSync(folder)) return { success: false, error: `folder not found: ${folder}` };
  const cli = ['mo-ta-shot', folder, '--che-do', args.mode === 'deep' ? 'ky' : 'nhanh', '--json'];
  const job = await runMedia(cli, (args.waitSeconds ?? 45) * 1000, true);
  const problem = mediaProblem(job, 'describe_sources');
  if (problem) return problem;
  const out = parseMedia(job);
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
  // 2. The media engine computes the framing.
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
  const job = await runMedia(['bo-cuc', jf, '--khung', frames.map((f) => `${f.w}x${f.h}`).join(','), '--json'], 300000, true);
  const problem = mediaProblem(job, 'create_aspect_versions');
  if (problem) return problem;
  const out = parseMedia(job);
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
