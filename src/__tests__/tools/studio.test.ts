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
    expect(names).toEqual(['rough_cut_by_cues', 'describe_sources', 'send_to_after_effects', 'return_from_after_effects', 'create_aspect_versions', 'add_color_layer', 'mako', 'add_color_matte', 'pr_guide', 'export_deliverables', 'export_status', 'add_scene_color_layers', 'sync_color_layers', 'create_proxies', 'proxy_status']);
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
