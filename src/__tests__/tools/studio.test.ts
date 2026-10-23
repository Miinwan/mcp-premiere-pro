import { layoutTakes, getStudioTools, isStudioTool } from '../../tools/studio.js';

const take = (stt: number, file: string, n: number, vao: number, ra: number, tin = 0.9, ca = false) => ({
  stt, id: `m-${file}-t0${n}`, file: `/src/${file}`, ten_file: file, take_trong_file: n,
  vao_giay: vao, ra_giay: ra, do_dai_giay: ra - vao,
  khau_lenh_vao: ca ? null : { loai: 'dem_nguoc+dien', chu: '3, 2, 1, diễn.' },
  khau_lenh_ra: ca ? null : { loai: 'cat', chu: 'Cắt.' },
  ket_thuc_bang: ca ? 'het_file' : 'khau_lenh_ra', do_tin_cay: ca ? 0 : tin, ca_file: ca, loi_thoai: 'Xin chào'
});

describe('studio tools', () => {
  it('registers the four tools', () => {
    const names = getStudioTools(new Set()).map((t) => t.name);
    expect(names).toEqual(['rough_cut_by_cues', 'describe_sources', 'send_to_after_effects', 'return_from_after_effects', 'create_aspect_versions', 'add_color_layer', 'mako', 'add_color_matte', 'pr_guide', 'export_deliverables', 'export_status', 'add_scene_color_layers', 'sync_color_layers', 'create_proxies', 'proxy_status', 'checkpoint_project', 'organize_project_bins', 'qc_before_export', 'transcribe_to_captions', 'detect_beats', 'cut_to_beats', 'select_best_takes', 'place_voiceover', 'normalize_loudness', 'review_cut']);
    expect(isStudioTool('rough_cut_by_cues')).toBe(true);
    expect(getStudioTools(new Set(['describe_sources'])).map((t) => t.name)).not.toContain('describe_sources');
  });

  it('lays takes back to back in media engine order with markers', () => {
    const rows = layoutTakes([take(2, 'A010.mp4', 2, 20, 24), take(1, 'A010.mp4', 1, 2.169, 6.657), take(3, 'B001.mp4', 1, 0, 4, 0, true)], 0.5);
    expect(rows.map((r) => r.name)).toEqual(['A010 T1', 'A010 T2', 'B001 T1']);
    expect(rows[0].at).toBe(0);
    expect(rows[1].at).toBeCloseTo(4.488 + 0.5, 3);
    expect(rows[2].at).toBeCloseTo(4.488 + 0.5 + 4 + 0.5, 3);
    expect(rows[0].marker).toContain('3, 2, 1, diễn.');
    expect(rows[2].marker).toContain('cả file');
    expect(rows[2].low).toBe(true);
  });

  it('carries media engine framing into Motion values', () => {
    const t = { ...take(1, 'A.mp4', 1, 0, 2), bo_cuc: { cach: 'vua_khung', scale_phan_tram: 50, vi_tri: { x: 960, y: 540 }, vi_tri_chuan: { x: 0.5, y: 0.5 } } };
    const [row] = layoutTakes([t]);
    expect(row.scale).toBe(50);
    expect(row.pos).toEqual([0.5, 0.5]);
    expect(layoutTakes([take(1, 'B.mp4', 1, 0, 2)])[0].scale).toBeNull();
  });

  it('flags low-confidence takes', () => {
    const rows = layoutTakes([take(1, 'A.mp4', 1, 0, 2, 0.5), take(2, 'A.mp4', 2, 3, 5, 0.8)], 0, 0.6);
    expect(rows.map((r) => r.low)).toEqual([true, false]);
  });
});

describe('aspect frames', () => {
  it('maps ratios to 1080-based frames', () => {
    const { aspectFrame } = require('../../tools/studio.js');
    expect(aspectFrame('1:1')).toMatchObject({ w: 1080, h: 1080, label: '1x1' });
    expect(aspectFrame('9:16')).toMatchObject({ w: 1080, h: 1920, label: '9x16' });
    expect(aspectFrame('4:5')).toMatchObject({ w: 1080, h: 1350 });
    expect(aspectFrame('1440x2560')).toMatchObject({ w: 1440, h: 2560 });
    expect(() => aspectFrame('vuông')).toThrow();
  });
});

describe('colour matte', () => {
  it('reads white, black and hex in Vietnamese or English', () => {
    const { matteColor } = require('../../tools/studio.js');
    expect(matteColor(undefined).rgb).toEqual([255, 255, 255]);
    expect(matteColor('đen')).toEqual({ rgb: [0, 0, 0], label: 'đen' });
    expect(matteColor('#B6006B').rgb).toEqual([182, 0, 107]);
    expect(() => matteColor('hồng')).toThrow();
  });
});

describe('proxies', () => {
  it('hardware ProRes Proxy at half size, audio kept', () => {
    const { proxyArgs } = require('../../tools/studio.js');
    const a = proxyArgs('in.mp4', 'out.mov', '1/2', 'prores_proxy').join(' ');
    expect(a).toContain('prores_videotoolbox -profile:v proxy');
    expect(a).toContain('scale=trunc(iw/2/2)*2:trunc(ih/2/2)*2');
    expect(a).toContain('-map 0:a?');
    expect(proxyArgs('i', 'o', '1/4', 'h264').join(' ')).toContain('h264_videotoolbox');
  });
});

describe('bins', () => {
  it('sorts items into editor bins', () => {
    const { binFor } = require('../../tools/studio.js');
    expect(binFor('media', '/x/A001.MP4')).toBe('01 Footage');
    expect(binFor('media', '/x/nhac.wav')).toBe('02 Audio');
    expect(binFor('media', '/x/logo.png')).toBe('03 Graphics');
    expect(binFor('sequence', '')).toBe('04 Sequences');
    expect(binFor('adjustment', '')).toBe('05 Adjustment');
    expect(binFor('media', '/x/Proxies/A001_Proxy.mov')).toBe('06 Proxies & renders');
  });
});

describe('captions', () => {
  it('keeps only words inside the take, shifted to the timeline', () => {
    const { cuesForClip, toSrt } = require('../../tools/studio.js');
    const s = [{ vao: 0, ra: 24, noi_dung: 'tres dos uno acción', tu: [{ chu: 'acción', vao: 20, ra: 24 }] },
      { vao: 48, ra: 96, noi_dung: 'Welcome to our kitchen', tu: [{ chu: 'Welcome', vao: 48, ra: 60 }, { chu: 'to', vao: 60, ra: 66 }, { chu: 'our', vao: 66, ra: 72 }, { chu: 'kitchen', vao: 72, ra: 96 }] }];
    const cues = cuesForClip(s, 24, 1.5, 10, 100);
    expect(cues).toHaveLength(1);
    expect(cues[0].text).toBe('Welcome to our kitchen');
    expect(cues[0].a).toBeCloseTo(100 + 2 - 1.5);
    expect(toSrt(cues)).toMatch(/^1\n00:01:40,500 --> /);
  });
});

describe('phase 6 helpers', () => {
  const st = require('../../tools/studio.js');
  const bt = require('../../tools/beats.js');

  it('finds 120 BPM on a synthetic click track', () => {
    const sr = 11025, x = new Float32Array(sr * 20);
    for (let b = 0; b < 40; b++) for (let i = 0; i < 300; i++) x[Math.round(b * 0.5 * sr) + i] = Math.sin(i * 0.6) * (1 - i / 300);
    const r = bt.analyseSignal(x, sr);
    expect(Math.abs(r.bpm - 120)).toBeLessThan(2);
    expect(r.beats.length).toBeGreaterThan(35);
  });

  it('snaps cuts to the beat grid without running past the media', () => {
    const grid = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4];
    const l = bt.beatLayout([{ len: 1.2, maxLen: 10 }, { len: 0.9, maxLen: 0.95 }], grid, 0);
    expect(l[0]).toEqual({ at: 0, len: 1, onBeat: true });
    expect(l[1].at).toBe(1);
    expect(l[1].len).toBeLessThanOrEqual(0.95);
  });

  it('keeps every n-th beat from the bar start', () => {
    expect(st.beatGrid([0, 1, 2, 3, 4, 5, 6], [1, 5], 2)).toEqual([1, 3, 5]);
  });

  it('maps beats into a clip on the timeline', () => {
    expect(st.timelineBeats({ start: 10, inS: 2, outS: 4 }, [1, 2, 3, 4])).toEqual([10, 11]);
  });

  it('prefers a clean take over one with a retake call', () => {
    const base = { id: 'a', file: 'f', ten_file: 'f.mp4', take_trong_file: 1, vao_giay: 0, ra_giay: 5, do_tin_cay: 0.8, ca_file: false, ket_thuc_bang: 'khau_lenh_ra', khau_lenh_ra: { chu: 'corte' } };
    const clean = st.scoreTake(base, [{ chu: 'hello', vao: 24, ra: 30, xac_suat: 0.9 }], 24);
    const flub = st.scoreTake({ ...base, id: 'b' }, [{ chu: 'otra vez', vao: 48, ra: 60, xac_suat: 0.9 }], 24);
    expect(clean.score).toBeGreaterThan(flub.score);
    expect(flub.reasons.join(' ')).toMatch(/làm lại/);
  });

  it('turns silences into speaking windows', () => {
    expect(st.speechWindows([{ a: 0, b: 0.5 }, { a: 2, b: 2.3 }, { a: 4, b: 6 }], 8)).toEqual([{ a: 0.5, b: 4 }, { a: 6, b: 8 }]);
  });

  it('classifies audio roles', () => {
    expect(st.audioRole({ track: 0, file: '/a/cam.MP4' })).toBe('dialogue');
    expect(st.audioRole({ track: 1, file: '/a/song.mp3' })).toBe('music');
    expect(st.audioRole({ track: 2, file: '/a/VO take 1.wav' })).toBe('voiceover');
  });

  it('flags flash frames, jump cuts and off-beat cuts', () => {
    const fd = 1 / 24;
    const c = (name: string, file: string, start: number, end: number, inS: number) => ({ track: 0, file, name, start, end, inS, outS: inS + end - start, adj: false, disabled: false });
    const r = st.reviewFindings([c('A', 'x', 0, 2, 0), c('B', 'x', 2, 2.1, 2.5), c('C', 'y', 2.1, 9, 0)], fd, { beats: [0, 2, 4] });
    const kinds = r.findings.map((f: any) => f.kind);
    expect(kinds).toEqual(expect.arrayContaining(['flash_frame', 'jump_cut', 'long_shot']));
    expect(r.beats.offBeat.length).toBe(1);
  });
});
