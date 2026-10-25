import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseName, buildName, computeRename, marksToPlatformIds, platformIdsToMarks,
  makeBatchFolderName, formatDateCompact, isInside, resolveCollision,
  analyzeCoverage, planBatch, planUndo, isValidShortcut, matchShortcut,
  normalizeShortcut, isImageFile, sanitizeSegment, DEFAULT_PLATFORMS
} from '../src/lib/core.mjs';

test('parseName: 无标记的普通文件', () => {
  const r = parseName('DSC01234.JPG');
  assert.equal(r.base, 'DSC01234');
  assert.equal(r.ext, 'JPG');
  assert.deepEqual(r.marks, []);
});

test('parseName: 尾部单标记', () => {
  const r = parseName('DSC01234🔴.JPG');
  assert.equal(r.base, 'DSC01234');
  assert.deepEqual(r.marks, ['🔴']);
  assert.equal(r.ext, 'JPG');
});

test('parseName: 尾部双标记（顺序无关）', () => {
  assert.deepEqual(parseName('A🟢🔴.jpg').marks.sort(), ['🔴', '🟢'].sort());
  assert.deepEqual(parseName('A🔴🟢.jpg').marks.sort(), ['🔴', '🟢'].sort());
});

test('parseName: 三个标记', () => {
  const r = parseName('海边-01🔴🟢🔵.HEIC');
  assert.equal(r.base, '海边-01');
  assert.equal(r.marks.length, 3);
});

test('parseName: 兼容旧版带分隔符标记', () => {
  const r = parseName('IMG_001-🔴.jpg');
  assert.equal(r.base, 'IMG_001');
  assert.deepEqual(r.marks, ['🔴']);
});

test('parseName: 基础名本身包含 emoji 不会被误删（非平台 emoji）', () => {
  const r = parseName('旅行✈️01.jpg');
  assert.equal(r.base, '旅行✈️01');
  assert.deepEqual(r.marks, []);
});

test('parseName: 无扩展名文件', () => {
  const r = parseName('nosuffix');
  assert.equal(r.base, 'nosuffix');
  assert.equal(r.ext, '');
});

test('buildName: 标记紧贴扩展名前', () => {
  assert.equal(buildName('DSC1', ['🔴'], 'JPG'), 'DSC1🔴.JPG');
  assert.equal(buildName('DSC1', ['🔴', '🟢'], 'jpg'), 'DSC1🔴🟢.jpg');
  assert.equal(buildName('DSC1', [], 'jpg'), 'DSC1.jpg');
});

test('computeRename: 幂等性——再次计算同一目标得到相同文件名', () => {
  const a = computeRename('DSC1.jpg', ['xhs', 'moments']);
  assert.equal(a.to, 'DSC1🔴🟢.jpg');
  const b = computeRename(a.to, ['moments', 'xhs']);
  assert.equal(b.to, a.to);
  assert.equal(b.same, true);
});

test('computeRename: 顺序稳定（按平台清单顺序，不是点击顺序）', () => {
  const r1 = computeRename('A.jpg', ['bili', 'xhs']);
  const r2 = computeRename('A.jpg', ['xhs', 'bili']);
  assert.equal(r1.to, 'A🔴🔵.jpg');
  assert.equal(r2.to, 'A🔴🔵.jpg');
});

test('computeRename: 取消全部标记回到原名', () => {
  const r = computeRename('DSC1🔴🟢.jpg', []);
  assert.equal(r.to, 'DSC1.jpg');
});

test('computeRename: 保留原扩展名大小写与多段名', () => {
  const r = computeRename('2026.秋日.海边.V1.HEIC', ['xhs']);
  assert.equal(r.to, '2026.秋日.海边.V1🔴.HEIC');
  assert.equal(r.ext, 'HEIC');
});

test('computeRename: 已含标记的文件改为另一组标记', () => {
  const r = computeRename('DSC1🔴.jpg', ['bili']);
  assert.equal(r.to, 'DSC1🔵.jpg');
  assert.deepEqual(r.currentIds, ['xhs']);
  assert.deepEqual(r.nextIds, ['bili']);
});

test('marksToPlatformIds / platformIdsToMarks 互逆', () => {
  const ids = ['moments', 'bili'];
  const marks = platformIdsToMarks(ids);
  assert.deepEqual(marksToPlatformIds(marks), ['moments', 'bili']);
});

test('formatDateCompact: 本地时区 YYYYMMDD', () => {
  const d = new Date(2026, 9, 25, 23, 59, 0);
  assert.equal(formatDateCompact(d), '20261025');
  const d2 = new Date(2026, 0, 1, 0, 0, 0);
  assert.equal(formatDateCompact(d2), '20260101');
});

test('makeBatchFolderName: 时间-平台-备注', () => {
  const d = new Date(2026, 9, 25);
  assert.equal(makeBatchFolderName(d, '小红书', '秋日街拍'), '20261025-小红书-秋日街拍');
});

test('makeBatchFolderName: 非法字符被替换，首尾空白裁剪', () => {
  const d = new Date(2026, 9, 25);
  const n = makeBatchFolderName(d, '小红书', '  秋日/街拍: 第1组?  ');
  assert.equal(n, '20261025-小红书-秋日_街拍_ 第1组_');
  assert.ok(!n.includes('/'));
});

test('makeBatchFolderName: 空备注给占位', () => {
  const d = new Date(2026, 9, 25);
  assert.equal(makeBatchFolderName(d, '小红书', '   '), '20261025-小红书-未命名批次');
});

test('sanitizeSegment: 保留中文与常见标点', () => {
  assert.equal(sanitizeSegment('秋日 · 街拍（一）'), '秋日 · 街拍（一）');
});

test('isInside: 自身与子路径都算内部', () => {
  assert.equal(isInside('/a/b', '/a/b'), true);
  assert.equal(isInside('/a/b', '/a/b/c'), true);
  assert.equal(isInside('/a/b', '/a/bc'), false);
  assert.equal(isInside('/a/b', '/a'), false);
  assert.equal(isInside('/a/b/', '/a/b/c'), true);
});

test('isInside: 空值安全', () => {
  assert.equal(isInside('', '/a'), false);
  assert.equal(isInside('/a', ''), false);
  assert.equal(isInside(null, null), false);
});

test('resolveCollision: 无冲突返回原名', () => {
  assert.equal(resolveCollision('a.jpg', ['b.jpg']), 'a.jpg');
});

test('resolveCollision: 冲突追加序号', () => {
  assert.equal(resolveCollision('a.jpg', ['a.jpg']), 'a (1).jpg');
  assert.equal(resolveCollision('a.jpg', ['a.jpg', 'a (1).jpg']), 'a (2).jpg');
});

test('resolveCollision: 大小写不敏感（macOS 默认文件系统）', () => {
  assert.equal(resolveCollision('A.JPG', ['a.jpg']), 'A (1).JPG');
});

test('resolveCollision: 无扩展名', () => {
  assert.equal(resolveCollision('noext', ['noext']), 'noext (1)');
});

test('analyzeCoverage: 三分类正确', () => {
  const photos = [
    { id: '1', name: 'a.jpg', platforms: [] },
    { id: '2', name: 'b.jpg', platforms: ['xhs'] },
    { id: '3', name: 'c.jpg', platforms: ['xhs', 'moments', 'bili'] },
    { id: '4', name: 'd.jpg', platforms: ['xhs', 'bili'] }
  ];
  const r = analyzeCoverage(photos);
  assert.equal(r.never.length, 1);
  assert.equal(r.missing.length, 2);
  assert.equal(r.complete.length, 1);
  assert.deepEqual(r.missing.find((x) => x.name === 'b.jpg').lack, ['moments', 'bili']);
  assert.equal(r.byPlatform.xhs, 3);
  assert.equal(r.byPlatform.moments, 1);
  assert.equal(r.byPlatform.bili, 2);
  assert.equal(r.coverageRate, 25);
});

test('analyzeCoverage: 空数组不崩', () => {
  const r = analyzeCoverage([]);
  assert.equal(r.total, 0);
  assert.equal(r.coverageRate, 0);
  assert.equal(r.never.length, 0);
});

test('analyzeCoverage: 忽略已禁用的平台', () => {
  const platforms = DEFAULT_PLATFORMS.map((p) => ({ ...p }));
  platforms[2].enabled = false;
  const photos = [{ id: '1', name: 'a.jpg', platforms: ['xhs', 'moments'] }];
  const r = analyzeCoverage(photos, platforms);
  assert.equal(r.complete.length, 1);
  assert.equal(r.activePlatforms.length, 2);
});

test('analyzeCoverage: 未知平台 id 被忽略且不视为已发', () => {
  const photos = [{ id: '1', name: 'a.jpg', platforms: ['ghost'] }];
  const r = analyzeCoverage(photos);
  assert.equal(r.never.length, 1);
});

test('planBatch: 生成每平台一个文件夹 + 每文件一份副本', () => {
  const photos = [
    { id: '1', name: 'a.jpg', src: '/src/a.jpg' },
    { id: '2', name: 'b.jpg', src: '/src/b.jpg' }
  ];
  const plan = planBatch({
    photos, platformIds: ['xhs', 'moments'], note: '秋日',
    root: '/out', date: new Date(2026, 9, 25)
  });
  assert.equal(plan.folders.length, 2);
  assert.equal(plan.folders[0].folderName, '20261025-小红书-秋日');
  assert.equal(plan.copies.length, 4);
  assert.equal(plan.copies.filter((c) => c.folderName.includes('朋友圈')).length, 2);
});

test('planBatch: 原片改名只做一次（不随平台重复）', () => {
  const photos = [{ id: '1', name: 'a.jpg', src: '/src/a.jpg' }];
  const plan = planBatch({
    photos, platformIds: ['xhs', 'moments', 'bili'], note: 'x',
    root: '/out', date: new Date(2026, 9, 25)
  });
  assert.equal(plan.renames.length, 1);
  assert.equal(plan.renames[0].to, 'a🔴🟢🔵.jpg');
});

test('planBatch: 缺参数抛错', () => {
  assert.throws(() => planBatch({ photos: [], platformIds: ['xhs'], note: 'x', root: '/o' }), /未选择任何照片/);
  assert.throws(() => planBatch({ photos: [{ id: '1', name: 'a.jpg' }], platformIds: [], note: 'x', root: '/o' }), /未选择任何平台/);
  assert.throws(() => planBatch({ photos: [{ id: '1', name: 'a.jpg' }], platformIds: ['xhs'], note: '  ', root: '/o' }), /备注必填/);
  assert.throws(() => planBatch({ photos: [{ id: '1', name: 'a.jpg' }], platformIds: ['xhs'], note: 'x', root: '' }), /待发布目录/);
});

test('planBatch: 副本使用改名后的文件名，源路径指向原片', () => {
  const photos = [{ id: '1', name: 'a.jpg', src: '/src/a.jpg' }];
  const plan = planBatch({ photos, platformIds: ['xhs'], note: 'x', root: '/o', date: new Date(2026, 9, 25) });
  assert.equal(plan.copies[0].fileName, 'a🔴.jpg');
  assert.equal(plan.copies[0].src, '/src/a.jpg');
});

test('planUndo: 反向映射', () => {
  const p = planUndo({ renames: [{ from: 'a.jpg', to: 'a🔴.jpg' }] });
  assert.deepEqual(p.renames, [{ from: 'a🔴.jpg', to: 'a.jpg' }]);
});

test('planUndo: from===to 的项被跳过', () => {
  const p = planUndo({ renames: [{ from: 'a.jpg', to: 'a.jpg' }] });
  assert.equal(p.renames.length, 0);
});

test('planUndo: 空值安全', () => {
  assert.deepEqual(planUndo(null).renames, []);
  assert.deepEqual(planUndo({}).renames, []);
});

test('isValidShortcut: 合法与非法', () => {
  assert.equal(isValidShortcut('ArrowLeft'), true);
  assert.equal(isValidShortcut('Space'), true);
  assert.equal(isValidShortcut('1'), true);
  assert.equal(isValidShortcut('⌘+A'), true);
  assert.equal(isValidShortcut('⌘+Shift+P'), true);
  assert.equal(isValidShortcut(''), false);
  assert.equal(isValidShortcut('⌘+'), false);
  assert.equal(isValidShortcut('ab'), false);
  assert.equal(isValidShortcut('⌘+A+B'), false);
  assert.equal(isValidShortcut(null), false);
});

test('normalizeShortcut: 修饰键归一', () => {
  assert.deepEqual(normalizeShortcut('⌘+A'), { cmd: true, shift: false, alt: false, ctrl: false, key: 'A' });
  assert.deepEqual(normalizeShortcut('Shift+Space'), { cmd: false, shift: true, alt: false, ctrl: false, key: 'Space' });
  assert.equal(normalizeShortcut(''), null);
});

test('matchShortcut: 事件匹配', () => {
  assert.equal(matchShortcut('ArrowLeft', { key: 'ArrowLeft', metaKey: false, shiftKey: false, altKey: false, ctrlKey: false }), true);
  assert.equal(matchShortcut('ArrowLeft', { key: 'ArrowLeft', metaKey: true, shiftKey: false, altKey: false, ctrlKey: false }), false);
  // 未声明 Shift 的快捷键，按住 Shift 也应命中（扩展选择）
  assert.equal(matchShortcut('ArrowLeft', { key: 'ArrowLeft', metaKey: false, shiftKey: true, altKey: false, ctrlKey: false }), true);
  // 声明了 Shift 的快捷键，未按时不应命中
  assert.equal(matchShortcut('Shift+ArrowLeft', { key: 'ArrowLeft', metaKey: false, shiftKey: false, altKey: false, ctrlKey: false }), false);
  assert.equal(matchShortcut('Shift+ArrowLeft', { key: 'ArrowLeft', metaKey: false, shiftKey: true, altKey: false, ctrlKey: false }), true);
  assert.equal(matchShortcut('⌘+A', { key: 'a', metaKey: true, shiftKey: false, altKey: false, ctrlKey: false }), true);
  assert.equal(matchShortcut('Space', { key: ' ', metaKey: false, shiftKey: false, altKey: false, ctrlKey: false }), true);
  assert.equal(matchShortcut('1', { key: '1', metaKey: false, shiftKey: false, altKey: false, ctrlKey: false }), true);
});

test('isImageFile: 大小写与常见格式', () => {
  assert.equal(isImageFile('a.JPG'), true);
  assert.equal(isImageFile('a.jpeg'), true);
  assert.equal(isImageFile('a.HEIC'), true);
  assert.equal(isImageFile('a.mp4'), false);
  assert.equal(isImageFile('a.txt'), false);
  assert.equal(isImageFile('noext'), false);
});

test('压力测试: 1000 次改名幂等', () => {
  for (let i = 0; i < 1000; i += 1) {
    const name = `IMG_${i}.JPG`;
    const a = computeRename(name, ['xhs', 'bili']);
    const b = computeRename(a.to, ['bili', 'xhs']);
    assert.equal(a.to, b.to, `幂等失败于 ${name}`);
    assert.ok(a.to.endsWith('🔴🔵.JPG'));
  }
});

test('压力测试: 1000 个文件漏发统计正确', () => {
  const photos = [];
  for (let i = 0; i < 1000; i += 1) {
    const platforms = i % 3 === 0 ? [] : i % 3 === 1 ? ['xhs'] : ['xhs', 'moments', 'bili'];
    photos.push({ id: String(i), name: `p${i}.jpg`, platforms });
  }
  const r = analyzeCoverage(photos);
  assert.equal(r.total, 1000);
  assert.equal(r.never.length + r.missing.length + r.complete.length, 1000);
  assert.equal(r.never.length, 334);
});
