import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseName, findNameClashes, validatePlatforms, hasFatalPlatformIssue,
  makeNewPlatform, registerOrphanMarks, clearOrphanMarks,
  computeRename, DEFAULT_PLATFORMS, PLATFORM_COLORS
} from '../src/lib/core.mjs';

/* ---------- 孤儿标记：删掉平台后老文件仍能正确识别 ---------- */

test('孤儿标记：注销平台后，老文件上的标记仍被识别并剥离', () => {
  clearOrphanMarks();
  const platforms = DEFAULT_PLATFORMS.filter((p) => p.id !== 'xhs'); // 删掉小红书
  // 未登记孤儿标记时，「🔴」会被当成文件名的一部分
  const before = parseName('DSC1🔴.png', platforms);
  assert.equal(before.marks.length, 0, '未登记时无法识别');
  // 登记后能识别
  registerOrphanMarks(['🔴']);
  const after = parseName('DSC1🔴.png', platforms);
  assert.deepEqual(after.marks, ['🔴']);
  assert.equal(after.base, 'DSC1');
  clearOrphanMarks();
});

test('孤儿标记：改名时可把孤儿标记一并去掉', () => {
  clearOrphanMarks();
  const platforms = DEFAULT_PLATFORMS.filter((p) => p.id !== 'xhs');
  registerOrphanMarks(['🔴']);
  const r = computeRename('DSC1🔴🟢.png', ['moments'], platforms);
  assert.equal(r.to, 'DSC1🟢.png', '孤儿 🔴 应被清除，只保留当前平台');
  clearOrphanMarks();
});

test('孤儿标记：清空登记后恢复原行为', () => {
  clearOrphanMarks();
  const r = parseName('A🔴.png');
  assert.deepEqual(r.marks, ['🔴']);
  clearOrphanMarks();
});

/* ---------- 重名冲突检测 ---------- */

test('findNameClashes：不同扩展名改名后撞名不会被误报', () => {
  const photos = [{ name: 'a.jpg' }, { name: 'b.jpg' }];
  assert.equal(findNameClashes(photos, ['xhs']).length, 0);
});

test('findNameClashes：同名不同后缀互不影响', () => {
  // a.jpg 与 a.jpeg 改名后分别是 a🔴.jpg 与 a🔴.jpeg，不算冲突
  const photos = [{ name: 'a.jpg' }, { name: 'a.jpeg' }];
  assert.equal(findNameClashes(photos, ['xhs']).length, 0);
});

test('findNameClashes：真正撞名能被发现', () => {
  // 两个都叫 photo.png 但一个已在标记后状态，改到同一目标
  const photos = [{ name: 'photo.png' }, { name: 'photo.PNG' }];
  const clashes = findNameClashes(photos, ['xhs']);
  assert.equal(clashes.length, 1, '大小写不同但目标在 macOS 上相同');
  assert.equal(clashes[0].names.length, 2);
});

test('findNameClashes：单张照片永不报冲突', () => {
  assert.equal(findNameClashes([{ name: 'x.jpg' }], ['xhs']).length, 0);
});

/* ---------- 平台配置校验 ---------- */

test('validatePlatforms：默认配置无问题', () => {
  assert.equal(validatePlatforms(DEFAULT_PLATFORMS).length, 0);
});

test('validatePlatforms：emoji 重复被发现', () => {
  const list = [
    { id: 'a', name: 'A', emoji: '🔴', shortcut: '1' },
    { id: 'b', name: 'B', emoji: '🔴', shortcut: '2' }
  ];
  const issues = validatePlatforms(list);
  assert.ok(issues.some((i) => i.kind === 'emoji'));
});

test('validatePlatforms：名称为空是致命问题', () => {
  const list = [{ id: 'a', name: '  ', emoji: '🟠', shortcut: '1' }];
  const issues = validatePlatforms(list);
  assert.ok(hasFatalPlatformIssue(issues));
});

test('validatePlatforms：快捷数字重复被发现（非致命）', () => {
  const list = [
    { id: 'a', name: 'A', emoji: '🔴', shortcut: '1' },
    { id: 'b', name: 'B', emoji: '🟢', shortcut: '1' }
  ];
  const issues = validatePlatforms(list);
  const sc = issues.find((i) => i.kind === 'shortcut');
  assert.ok(sc);
  assert.equal(hasFatalPlatformIssue(issues), false, '重复快捷键不阻止保存');
});

test('makeNewPlatform：自动避开已用的 emoji / 数字键 / 颜色', () => {
  const p = makeNewPlatform(DEFAULT_PLATFORMS);
  assert.ok(!DEFAULT_PLATFORMS.some((x) => x.emoji === p.emoji), 'emoji 不重复');
  assert.ok(!DEFAULT_PLATFORMS.some((x) => x.shortcut === p.shortcut), '数字键不重复');
  assert.ok(!DEFAULT_PLATFORMS.some((x) => x.color === p.color), '颜色不重复');
  assert.ok(PLATFORM_COLORS.includes(p.color));
});

test('makeNewPlatform：空清单也能生成', () => {
  const p = makeNewPlatform([]);
  assert.ok(p.emoji && p.name && p.shortcut && p.color);
});

test('makeNewPlatform：id 唯一', () => {
  const a = makeNewPlatform(DEFAULT_PLATFORMS);
  const b = makeNewPlatform(DEFAULT_PLATFORMS);
  assert.notEqual(a.id, b.id);
});
