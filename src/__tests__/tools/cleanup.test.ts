import { jobFolderFor, planCleanup, sequencePattern, KEEP_DIR } from '../../tools/cleanup.js';

describe('project clean-up plan', () => {
  const items = [
    { id: '1', name: 'A.mp4', path: '/job/Source/A.mp4', proxy: '/job/Source/Proxies/A_Proxy.mov', used: true, isSequence: false },
    { id: '2', name: 'B.mp4', path: '/job/Source/B.mp4', proxy: '/job/Source/Proxies/B_Proxy.mov', used: false, isSequence: false },
    { id: '3', name: 'song.mp3', path: '/job/Music/song.mp3', proxy: null, used: false, isSequence: false },
    { id: '4', name: 'Black matte', path: null, proxy: null, used: false, isSequence: false },
    { id: '5', name: 'Final 16x9', path: null, proxy: null, used: true, isSequence: true },
    { id: '6', name: 'frame_0001.png', path: '/job/Seq/frame_0001.png', proxy: null, used: true, isSequence: false }
  ];
  const disk: Record<string, string[]> = {
    '/job/Source': ['A.mp4', 'B.mp4', 'C.mp4', 'notes.txt', '.DS_Store'],
    '/job/Source/Proxies': ['A_Proxy.mov', 'B_Proxy.mov', 'C_Proxy.mov'],
    '/job/Music': ['song.mp3', 'other.wav'],
    '/job/Seq': ['frame_0001.png', 'frame_0002.png', 'cover.png']
  };
  const plan = planCleanup(items, { listDir: (d) => disk[d] ?? [] });
  const trash = plan.trash.map((t) => t.path);

  it('keeps files in use and their proxies', () => {
    expect(trash).not.toContain('/job/Source/A.mp4');
    expect(trash).not.toContain('/job/Source/Proxies/A_Proxy.mov');
  });
  it('lists unused imports, their proxies and never-used media in the source folders', () => {
    expect(trash).toEqual(expect.arrayContaining(['/job/Source/B.mp4', '/job/Source/Proxies/B_Proxy.mov', '/job/Source/C.mp4', '/job/Source/Proxies/C_Proxy.mov', '/job/Music/song.mp3', '/job/Music/other.wav', '/job/Seq/cover.png']));
  });
  it('never lists non-media files or the rest of an image sequence in use', () => {
    expect(trash).not.toContain('/job/Source/notes.txt');
    expect(trash).not.toContain('/job/Seq/frame_0002.png');
  });
  it('removes unused items from the project, including mattes', () => {
    expect(plan.removeFromProject.map((i) => i.id).sort()).toEqual(['2', '3', '4']);
  });
  it('only trashes files inside the job folder; the rest is just removed from the project', () => {
    const lib = [...items, { id: '7', name: 'whoosh.wav', path: '/Users/me/Soundly/whoosh.wav', proxy: null, used: false, isSequence: false }];
    const p = planCleanup(lib, { jobFolder: '/job', listDir: (d) => (d === '/Users/me/Soundly' ? ['whoosh.wav', 'boom.wav'] : disk[d] ?? []) });
    const t = p.trash.map((x) => x.path);
    expect(t.some((x) => x.startsWith('/Users/me/Soundly'))).toBe(false);
    expect(t).toContain('/job/Source/B.mp4');
    expect(p.removeFromProject.find((i) => i.id === '7')!.ly_do).toMatch(/ngoài thư mục job/);
    expect(jobFolderFor('/job/Project/Edit v3.prproj')).toBe('/job');
    expect(jobFolderFor('/job/Edit v3.prproj')).toBe('/job');
  });

  it('protects delivery folders', () => {
    expect(KEEP_DIR.test('/job/Edited/final.mp4')).toBe(true);
    expect(KEEP_DIR.test('/job/Xuất file/a.mp4')).toBe(true);
    expect(KEEP_DIR.test('/job/Source/a.mp4')).toBe(false);
    expect(sequencePattern('/a/shot_0012.exr')!.test('shot_0999.exr')).toBe(true);
  });
});
