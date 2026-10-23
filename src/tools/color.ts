import { z } from 'zod';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import type { PremiereProTransport } from '../bridge/types.js';
import type { MCPTool } from './index.js';

const run = promisify(execFile);

/**
 * Color tools: scriptable replacement for Lumetri "Comparison View" + "Apply Match",
 * per-scene adjustment layers, and Lumetri Basic Correction get/set.
 * Frame measurements are done in Node through ffmpeg (no extra npm deps).
 */
export const colorToolNames = [
  'compare_frames',
  'measure_frame_color',
  'match_color',
  'build_scene_adjustment_layers',
  'get_lumetri_basic',
  'set_lumetri_basic'
] as const;

const seqRef = {
  sequenceName: z.string().optional().describe('Sequence name (e.g. "VIDEO A"). Either sequenceName or sequenceId.'),
  sequenceId: z.string().optional().describe('Sequence ID (GUID).')
};
const clipRef = {
  ...seqRef,
  videoTrack: z.number().int().min(0).optional().describe('0-based video track index (default 1 = V2).'),
  clipIndex: z.number().int().min(0).describe('0-based clip index on that track.')
};
const regionSchema = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() })
  .optional().describe('Normalized region (0-1) to measure, e.g. a face. Default: whole frame with skin-tone mask, falling back to midtones.');
const lumetriParams = z.object({
  temperature: z.number().optional(), tint: z.number().optional(), saturation: z.number().optional(),
  exposure: z.number().optional(), contrast: z.number().optional(), highlights: z.number().optional(),
  shadows: z.number().optional(), whites: z.number().optional(), blacks: z.number().optional(), vibrance: z.number().optional()
});

export function getColorTools(existingNames: Set<string>): MCPTool[] {
  const tools: MCPTool[] = [
    {
      name: 'compare_frames',
      description: 'Scriptable Comparison View: exports a reference frame and a target frame (same or different sequences) and writes them side by side into one image, with skin/midtone color measurements for both. Use before and after match_color.',
      inputSchema: z.object({
        ...seqRef,
        refTime: z.number().describe('Reference time in seconds.'),
        targetTime: z.number().describe('Target time in seconds.'),
        targetSequenceName: z.string().optional().describe('Optional other sequence for the target frame.'),
        outputPath: z.string().describe('Output PNG/JPG path for the side-by-side image.'),
        region: regionSchema
      })
    },
    {
      name: 'measure_frame_color',
      description: 'Exports a sequence frame and returns luma (Y) and R/G, B/G ratios of skin tones (or a given region / midtones).',
      inputSchema: z.object({ ...seqRef, time: z.number(), region: regionSchema })
    },
    {
      name: 'match_color',
      description: 'Scriptable Apply Match. Matches a target clip to a reference clip by iteratively adjusting Lumetri exposure, temperature and tint (on the clip itself or on the adjustment layer above it) until skin/midtone luma and warmth match. Returns the measurement log.',
      inputSchema: z.object({
        ...seqRef,
        videoTrack: z.number().int().min(0).optional().describe('Track holding the source clips (default 1 = V2).'),
        refClipIndex: z.number().int().min(0),
        targetClipIndex: z.number().int().min(0),
        refSequenceName: z.string().optional().describe('Optional: reference clip lives in another sequence.'),
        applyTo: z.enum(['adjustment', 'clip']).optional().describe('Where to apply the correction (default adjustment if one covers the clip, else clip).'),
        adjustmentTrack: z.number().int().min(0).optional().describe('Video track of scene adjustment layers (default 2 = V3).'),
        region: regionSchema,
        refRegion: regionSchema,
        maxIterations: z.number().int().min(1).max(6).optional(),
        matchTint: z.boolean().optional().describe('Also match green/magenta (default true).')
      })
    },
    {
      name: 'build_scene_adjustment_layers',
      description: 'Creates one adjustment layer per scene above the source track: consecutive clips from the same source share one layer, a different source/camera gets its own. Each layer gets a Lumetri with (optionally) the clip grade transferred + a base look, and is named after its source so it can be fine-tuned per scene.',
      inputSchema: z.object({
        ...seqRef,
        sourceTrack: z.number().int().min(0).optional().describe('Default 1 (V2).'),
        adjustmentTrack: z.number().int().min(0).optional().describe('Default 2 (V3). Existing items on it are replaced.'),
        adjustmentItemName: z.string().optional().describe('Project item to use (default "Adjustment Layer").'),
        skipPrefixes: z.array(z.string()).optional().describe('Clip name prefixes to leave without a layer (default ["Title"]).'),
        transferClipGrade: z.boolean().optional().describe('Move each source clip Lumetri Basic values onto its scene layer and neutralise the clip (default true).'),
        look: lumetriParams.optional().describe('Base look added on top of every scene (offsets).'),
        namePrefix: z.string().optional().describe('Layer name prefix (default "Màu ").')
      })
    },
    {
      name: 'get_lumetri_basic',
      description: 'Reads Lumetri Basic Correction values of a clip.',
      inputSchema: z.object({ ...clipRef })
    },
    {
      name: 'set_lumetri_basic',
      description: 'Sets (or offsets) Lumetri Basic Correction values of a clip; adds Lumetri if missing.',
      inputSchema: z.object({ ...clipRef, params: lumetriParams, mode: z.enum(['set', 'offset']).optional() })
    }
  ];
  return tools.filter((t) => !existingNames.has(t.name));
}

export function isColorTool(name: string): boolean {
  return (colorToolNames as readonly string[]).includes(name);
}

// ---------------------------------------------------------------- JSX helpers
const JSX_LIB = `
function __seq(name,id){var s=app.project.sequences;for(var i=0;i<s.numSequences;i++){if((id&&s[i].sequenceID==id)||(name&&s[i].name==name))return s[i];}return null;}
function __comp(c,n){for(var i=0;i<c.components.numItems;i++){if(c.components[i].displayName==n)return c.components[i];}return null;}
var __LUMN={temperature:'Temperature',tint:'Tint',saturation:'Saturation',exposure:'Exposure',contrast:'Contrast',highlights:'Highlights',shadows:'Shadows',whites:'Whites',blacks:'Blacks',vibrance:'Vibrance'};
function __lp(L,key){var n=__LUMN[key];for(var j=0;j<L.properties.numItems;j++){if(L.properties[j].displayName==n)return L.properties[j];}return null;}
function __tc(sec){var f=Math.round(sec*30);function p(x){return ('0'+x).slice(-2);}return p(Math.floor(f/108000))+':'+p(Math.floor(f/1800)%60)+':'+p(Math.floor(f/30)%60)+':'+p(f%30);}
function __export(seq,sec,path){app.enableQE();app.project.openSequence(seq.sequenceID);var qs=qe.project.getActiveSequence();return qs.exportFramePNG(__tc(sec),path);}
function __qeItem(seq,vi,st){app.enableQE();app.project.openSequence(seq.sequenceID);var tr=qe.project.getActiveSequence().getVideoTrackAt(vi);for(var i=0;i<tr.numItems;i++){var it=tr.getItemAt(i);if(it.type!='Empty'&&Math.abs(it.start.secs-st)<0.02)return it;}return null;}
function __ensureLum(seq,vi,c){var L=__comp(c,'Lumetri Color');if(L)return L;var q=__qeItem(seq,vi,c.start.seconds);if(!q)return null;q.addVideoEffect(qe.project.getVideoEffectByName('Lumetri Color'));return __comp(c,'Lumetri Color');}
function __readLum(L){var o={};for(var k in __LUMN){var p=__lp(L,k);if(p)o[k]=p.getValue();}return o;}
function __writeLum(L,v,offset){for(var k in v){var p=__lp(L,k);if(!p)continue;p.setValue(offset?p.getValue()+v[k]:v[k],true);}}
function __T(sec){var t=new Time();t.seconds=sec;return t;}
`;
const NEUTRAL: Record<string, number> = { temperature: 0, tint: 0, saturation: 100, exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0, vibrance: 0 };

async function jsx(bridge: PremiereProTransport, body: string, timeoutMs = 120000): Promise<any> {
  const script = `${JSX_LIB}\ntry{${body}}catch(e){return JSON.stringify({success:false,error:e.toString()+' line '+e.line});}`;
  const res = await bridge.executeScript(script, timeoutMs);
  if (typeof res === 'string') { try { return JSON.parse(res); } catch { return { success: true, raw: res }; } }
  return res;
}
const q = (v: unknown) => JSON.stringify(v ?? null);

// ---------------------------------------------------------------- image metrics
function ffmpegPath(): string {
  const c = [process.env.FFMPEG_PATH, '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', join(homedir(), '.local/bin/ffmpeg'), '/usr/bin/ffmpeg'];
  for (const p of c) if (p && existsSync(p)) return p;
  return 'ffmpeg';
}
type Region = { x: number; y: number; w: number; h: number } | undefined;
export interface ColorStats { Y: number; RG: number; BG: number; warmth: number; greenMagenta: number; pixels: number; method: string; }

async function waitFile(p: string, ms = 8000) { const t = Date.now(); while (Date.now() - t < ms) { if (existsSync(p)) { await new Promise(r => setTimeout(r, 300)); return; } await new Promise(r => setTimeout(r, 200)); } throw new Error('Frame not written: ' + p); }

export async function measureImage(path: string, region?: Region): Promise<ColorStats> {
  const W = 320, H = 180;
  const { stdout } = await run(ffmpegPath(), ['-v', 'error', '-i', path, '-vf', `scale=${W}:${H}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }) as unknown as { stdout: Buffer };
  const x0 = region ? Math.floor(region.x * W) : 0, y0 = region ? Math.floor(region.y * H) : 0;
  const x1 = region ? Math.ceil((region.x + region.w) * W) : W, y1 = region ? Math.ceil((region.y + region.h) * H) : H;
  const acc = (pred: (r: number, g: number, b: number, Y: number, cb: number, cr: number) => boolean) => {
    let n = 0, sr = 0, sg = 0, sb = 0, sy = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const i = (y * W + x) * 3; const r = stdout[i]!, g = stdout[i + 1]!, b = stdout[i + 2]!;
      const Y = 0.299 * r + 0.587 * g + 0.114 * b, cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b, cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
      if (pred(r, g, b, Y, cb, cr)) { n++; sr += r; sg += g; sb += b; sy += 0.2126 * r + 0.7152 * g + 0.0722 * b; }
    }
    return { n, sr, sg, sb, sy };
  };
  let method = region ? 'region' : 'skin';
  let a = region ? acc((_r, _g, _b, Y) => Y > 15 && Y < 245) : acc((r, g, _b, Y, cb, cr) => cb > 85 && cb < 125 && cr > 138 && cr < 170 && Y > 50 && Y < 235 && r - g < 70);
  const total = (x1 - x0) * (y1 - y0);
  if (!region && a.n < total * 0.005) { method = 'midtones'; a = acc((_r, _g, _b, Y) => Y > 40 && Y < 200); }
  const R = a.sr / Math.max(a.n, 1), G = a.sg / Math.max(a.n, 1), B = a.sb / Math.max(a.n, 1);
  return { Y: a.sy / Math.max(a.n, 1), RG: R / Math.max(G, 1), BG: B / Math.max(G, 1), warmth: Math.log(R / Math.max(B, 1)), greenMagenta: Math.log(G) - (Math.log(R) + Math.log(B)) / 2, pixels: a.n, method };
}

async function exportAndMeasure(bridge: PremiereProTransport, seq: { name?: string; id?: string }, time: number, region: Region, tag: string) {
  const base = join(tmpdir(), `mcp_color_${tag}_${Date.now()}`);
  const r = await jsx(bridge, `var s=__seq(${q(seq.name)},${q(seq.id)});if(!s)return JSON.stringify({success:false,error:'sequence not found'});var ok=__export(s,${time},${q(base)});return JSON.stringify({success:!!ok});`);
  if (!r?.success) throw new Error('export failed: ' + JSON.stringify(r));
  const file = base + '.png'; await waitFile(file);
  return { file, stats: await measureImage(file, region) };
}

// ---------------------------------------------------------------- executor
export async function executeColorTool(bridge: PremiereProTransport, name: string, args: Record<string, any>): Promise<any> {
  try {
    const seq = { name: args.sequenceName, id: args.sequenceId };
    switch (name) {
      case 'measure_frame_color': {
        const m = await exportAndMeasure(bridge, seq, Number(args.time), args.region, 'm');
        return { success: true, tool: name, data: { ...m.stats, frame: m.file } };
      }
      case 'compare_frames': {
        const a = await exportAndMeasure(bridge, seq, Number(args.refTime), args.region, 'ref');
        const tseq = args.targetSequenceName ? { name: args.targetSequenceName } : seq;
        const b = await exportAndMeasure(bridge, tseq, Number(args.targetTime), args.region, 'tgt');
        const out = String(args.outputPath);
        await run(ffmpegPath(), ['-v', 'error', '-y', '-i', a.file, '-i', b.file, '-filter_complex', '[0]scale=960:-1[l];[1]scale=960:-1[r];[l][r]hstack=inputs=2', '-frames:v', '1', out]);
        const d = { dExposureStops: Math.log2(a.stats.Y / Math.max(b.stats.Y, 1)), dWarmth: a.stats.warmth - b.stats.warmth, dGreenMagenta: a.stats.greenMagenta - b.stats.greenMagenta };
        return { success: true, tool: name, data: { outputPath: out, reference: a.stats, target: b.stats, difference: d } };
      }
      case 'get_lumetri_basic': {
        const vt = args.videoTrack ?? 1;
        const r = await jsx(bridge, `var s=__seq(${q(seq.name)},${q(seq.id)});var c=s.videoTracks[${vt}].clips[${Number(args.clipIndex)}];var L=__comp(c,'Lumetri Color');return JSON.stringify({success:true,clip:c.name,start:c.start.seconds,hasLumetri:!!L,values:L?__readLum(L):null});`);
        return { tool: name, ...r };
      }
      case 'set_lumetri_basic': {
        const vt = args.videoTrack ?? 1;
        const r = await jsx(bridge, `var s=__seq(${q(seq.name)},${q(seq.id)});var c=s.videoTracks[${vt}].clips[${Number(args.clipIndex)}];var L=__ensureLum(s,${vt},c);if(!L)return JSON.stringify({success:false,error:'cannot add Lumetri'});__writeLum(L,${q(args.params || {})},${args.mode === 'offset'});return JSON.stringify({success:true,clip:c.name,values:__readLum(L)});`);
        return { tool: name, ...r };
      }
      case 'build_scene_adjustment_layers': return await buildSceneLayers(bridge, seq, args);
      case 'match_color': return await matchColor(bridge, seq, args);
    }
    return { success: false, error: 'unknown color tool ' + name };
  } catch (e: any) {
    return { success: false, tool: name, error: String(e?.message || e) };
  }
}

async function buildSceneLayers(bridge: PremiereProTransport, seq: { name?: string; id?: string }, args: Record<string, any>) {
  const st = args.sourceTrack ?? 1, at = args.adjustmentTrack ?? 2;
  const body = `
var s=__seq(${q(seq.name)},${q(seq.id)});if(!s)return JSON.stringify({success:false,error:'sequence not found'});
var adjName=${q(args.adjustmentItemName || 'Adjustment Layer')};
function find(it){for(var i=0;i<it.children.numItems;i++){var c=it.children[i];if(c.name==adjName&&c.type!=2)return c;if(c.type==2){var r=find(c);if(r)return r;}}return null;}
var adj=find(app.project.rootItem);if(!adj)return JSON.stringify({success:false,error:'No project item named '+adjName+' (create one with add_adjustment_layer first)'});
var skip=${q(args.skipPrefixes || ['Title'])};var transfer=${args.transferClipGrade === false ? 'false' : 'true'};var look=${q(args.look || {})};var prefix=${q(args.namePrefix ?? 'Màu ')};var NEU=${q(NEUTRAL)};
var src=s.videoTracks[${st}],dst=s.videoTracks[${at}];
for(var k=dst.clips.numItems-1;k>=0;k--)dst.clips[k].remove(false,false);
var scenes=[];
for(var k=0;k<src.clips.numItems;k++){var c=src.clips[k];var sk=false;for(var j=0;j<skip.length;j++)if(c.name.indexOf(skip[j])==0)sk=true;if(sk)continue;
 var L=__comp(c,'Lumetri Color');var v=L?__readLum(L):{};
 var last=scenes.length?scenes[scenes.length-1]:null;
 if(last&&last.name==c.name&&Math.abs(last.end-c.start.seconds)<0.02){last.end=c.end.seconds;last.clips.push(k);}
 else scenes.push({name:c.name,start:c.start.seconds,end:c.end.seconds,grade:v,clips:[k]});}
var out=[];
for(var i=0;i<scenes.length;i++){var sc=scenes[i];dst.overwriteClip(adj,sc.start);var a=null;for(var k=0;k<dst.clips.numItems;k++)if(Math.abs(dst.clips[k].start.seconds-sc.start)<0.02)a=dst.clips[k];
 if(!a){out.push({scene:sc.name,error:'place failed'});continue;}
 a.end=__T(sc.end);try{a.name=prefix+sc.name.replace(/\\.[^.]+$/,'');}catch(e){}
 var AL=__ensureLum(s,${at},a);var g={};for(var key in NEU){var base=transfer&&sc.grade[key]!==undefined?sc.grade[key]:NEU[key];g[key]=base+(look[key]||0);}
 __writeLum(AL,g,false);
 if(transfer){for(var j=0;j<sc.clips.length;j++){var cc=src.clips[sc.clips[j]];var CL=__comp(cc,'Lumetri Color');if(CL)__writeLum(CL,NEU,false);}}
 out.push({scene:a.name,start:sc.start,end:sc.end,clips:sc.clips.length,grade:g});}
return JSON.stringify({success:true,scenes:out});`;
  const r = await jsx(bridge, body, 180000);
  return { tool: 'build_scene_adjustment_layers', ...r };
}

async function matchColor(bridge: PremiereProTransport, seq: { name?: string; id?: string }, args: Record<string, any>) {
  const vt = args.videoTrack ?? 1, at = args.adjustmentTrack ?? 2;
  const refSeq = args.refSequenceName ? { name: args.refSequenceName } : seq;
  const info = async (s: { name?: string; id?: string }, idx: number) => jsx(bridge, `var s=__seq(${q(s.name)},${q(s.id)});var c=s.videoTracks[${vt}].clips[${idx}];return JSON.stringify({success:true,name:c.name,start:c.start.seconds,end:c.end.seconds});`);
  const ref = await info(refSeq, Number(args.refClipIndex));
  const tgt = await info(seq, Number(args.targetClipIndex));
  if (!ref?.success || !tgt?.success) return { success: false, error: 'clip lookup failed', ref, tgt };
  const tRef = (ref.start + ref.end) / 2, tTgt = (tgt.start + tgt.end) / 2;
  // locate holder: adjustment covering target mid (if requested/available) or clip
  const holder = await jsx(bridge, `var s=__seq(${q(seq.name)},${q(seq.id)});var mode=${q(args.applyTo || 'auto')};var mid=${tTgt};var h=null,ti=${vt},ci=${Number(args.targetClipIndex)};
if(mode!='clip'&&s.videoTracks.numTracks>${at}){var d=s.videoTracks[${at}];for(var k=0;k<d.clips.numItems;k++){var a=d.clips[k];if(a.start.seconds<=mid&&a.end.seconds>=mid){ti=${at};ci=k;h=a;}}}
if(!h)h=s.videoTracks[${vt}].clips[${Number(args.targetClipIndex)}];var L=__ensureLum(s,ti,h);return JSON.stringify({success:!!L,track:ti,index:ci,name:h.name,values:L?__readLum(L):null});`);
  if (!holder?.success) return { success: false, error: 'could not prepare Lumetri on target', holder };
  const setOff = (d: Record<string, number>) => jsx(bridge, `var s=__seq(${q(seq.name)},${q(seq.id)});var c=s.videoTracks[${holder.track}].clips[${holder.index}];var L=__comp(c,'Lumetri Color');__writeLum(L,${q(d)},true);return JSON.stringify({success:true,values:__readLum(L)});`);
  const refM = (await exportAndMeasure(bridge, refSeq, tRef, args.refRegion || args.region, 'ref')).stats;
  const log: any[] = [];
  let gExp = 2.5, gTemp = 0.0106, gTint = 0.008; // initial gains (stops per log2 ratio, warmth per unit, gm per unit)
  const maxIt = args.maxIterations ?? 4; const doTint = args.matchTint !== false;
  for (let it = 0; it < maxIt; it++) {
    const m = (await exportAndMeasure(bridge, seq, tTgt, args.region, 'tgt' + it)).stats;
    const dY = Math.log2(refM.Y / Math.max(m.Y, 1)), dW = refM.warmth - m.warmth, dG = refM.greenMagenta - m.greenMagenta;
    log.push({ iteration: it, target: m, dExposureStops: +dY.toFixed(3), dWarmth: +dW.toFixed(3), dGreenMagenta: +dG.toFixed(3) });
    if (Math.abs(dY) < 0.04 && Math.abs(dW) < 0.02 && (!doTint || Math.abs(dG) < 0.02)) break;
    if (it === maxIt - 1) break;
    const sExp = Math.max(-1, Math.min(1, dY * gExp));
    const sTemp = Math.max(-30, Math.min(30, -dW / gTemp));
    const sTint = doTint ? Math.max(-25, Math.min(25, -dG / gTint)) : 0;
    const step: Record<string, number> = { exposure: sExp, temperature: sTemp };
    if (doTint) step.tint = sTint;
    await setOff(step);
    // adapt gains from response on next measurement
    const m2 = (await exportAndMeasure(bridge, seq, tTgt, args.region, 'chk' + it)).stats;
    const rY = Math.log2(m2.Y / Math.max(m.Y, 1)); if (Math.abs(sExp) > 0.02 && Math.abs(rY) > 0.005) gExp = Math.max(0.5, Math.min(8, sExp / rY));
    const rW = m2.warmth - m.warmth; if (Math.abs(sTemp) > 0.5 && Math.abs(rW) > 0.002) gTemp = Math.max(0.002, Math.min(0.05, Math.abs(rW / sTemp)));
    if (doTint && Math.abs(sTint) > 0.5) { const rG = m2.greenMagenta - m.greenMagenta; if (Math.abs(rG) > 0.002) gTint = Math.max(0.002, Math.min(0.05, Math.abs(rG / sTint))); }
  }
  const final = await jsx(bridge, `var s=__seq(${q(seq.name)},${q(seq.id)});var c=s.videoTracks[${holder.track}].clips[${holder.index}];return JSON.stringify({success:true,name:c.name,values:__readLum(__comp(c,'Lumetri Color'))});`);
  return { success: true, tool: 'match_color', data: { reference: { clip: ref.name, time: tRef, stats: refM }, target: { clip: tgt.name, time: tTgt }, appliedOn: holder.track === vt ? 'clip' : 'adjustment', holder: final, log } };
}
