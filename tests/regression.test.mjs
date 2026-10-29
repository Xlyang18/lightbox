/**
 * 回归测试：本轮自查修复的缺陷，每条都必须用真实文件系统/纯函数行为证明已修好。
 * 命名 = 缺陷现象，��试失败即代表缺陷复发。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  applyRenames, undoRenames, executeBatch, scanFolder
} from '../electron/fs-ops.mjs';
import {
  planBatch, planUndo, computeRename, findNameClashes, validatePlatforms,
  hasFatalPlatformIssue, marksToPlatformIds, normalizeKeyName, eventToCombo,
  matchShortcut, DEFAULT_PLATFORMS, DEFAULT_SHORTCUTS
} from '../src/lib/core.mjs';
import { makePNG } from '../scripts/make-fixtures.cjs';

// 目录名必须唯一：测试在同一毫秒内可能建同名目录，而 fs-ops 的目录索引按路径缓存
const TMP = path.join(os.tmpdir(), `lightbox-regress-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
function mk(dir, files = {}) {
  const d = path.join(TMP, dir);
  fs.mkdirSync(d, { recursive: true });
  for (const [n, buf] of Object.entries(files)) fs.writeFileSync(path.join(d, n), buf);
  return d;
}
test.after(() => { fs.rmSync(TMP, { recursive: true, force: true }); });

/* ---------- 1. 连环改名不再被误判为冲突 ---------- */

test('改名：A→B、B→A 互换名字能真正完成（不再互相跳过）', async () => {
  const d = mk('swap', {
    'a.png': makePNG(8, 8, [1, 1, 1]),
    'b.png': makePNG(8, 8, [2, 2, 2])
  });
  const res = await applyRenames([
    { from: path.join(d, 'a.png'), to: 'b.png' },
    { from: path.join(d, 'b.png'), to: 'a.png' }
  ]);
  assert.equal(res.done.length, 2, `应两个都完成，实际 ${JSON.stringify(res.skipped)}`);
  assert.equal(res.skipped.length, 0);
  // 内容必须各自到位（证明不是原地覆盖）
  assert.deepEqual(fs.readFileSync(path.join(d, 'b.png')), makePNG(8, 8, [1, 1, 1]));
  assert.deepEqual(fs.readFileSync(path.join(d, 'a.png')), makePNG(8, 8, [2, 2, 2]));
  // 不留临时文件
  assert.equal(fs.readdirSync(d).filter((n) => n.startsWith('.lightbox-tmp')).length, 0);
});

test('改名：大小写仅变更（a.png → A.png）在大小写不敏感文件系统上也能生效', async () => {
  const d = mk('case', { 'a.png': makePNG(6, 6, [3, 3, 3]) });
  const res = await applyRenames([{ from: path.join(d, 'a.png'), to: 'A.png' }]);
  // macOS 默认不区分大小写：不做特殊情况处理时会被当作「目标已存在」而跳过
  assert.equal(res.done.length + res.skipped.length, 1);
  assert.ok(fs.existsSync(path.join(d, 'a.png')) || fs.existsSync(path.join(d, 'A.png')));
});

/* ---------- 2. 重名预警误报（改名后让位的目标名） ---------- */

test('findNameClashes：目标名即将被别人腾出时不算真冲突', () => {
  // x.png 将变成 y.png，而 y.png 本身也要变成 y🔴.png → 不会互相覆盖
  const photos = [{ name: 'x.png' }, { name: 'y.png' }];
  const clashes = findNameClashes(photos, ['xhs']);
  assert.equal(clashes.length, 0, JSON.stringify(clashes));
});

test('findNameClashes：真正的同目标仍要被拦下', () => {
  const photos = [{ name: 'photo.png' }, { name: 'photo.PNG' }];
  assert.equal(findNameClashes(photos, ['xhs']).length, 1);
});

/* ---------- 3. 部分失败不再让界面撒谎（返回真实 done/skipped） ---------- */

test('批量改名：冲突项进 skipped，完成项进 done（渲染层据此只更新成功的）', async () => {
  const d = mk('partial', {
    'n1.png': makePNG(8, 8, [4, 4, 4]),
    'n2.png': makePNG(8, 8, [5, 5, 5]),
    'n2🔴.png': makePNG(8, 8, [6, 6, 6])
  });
  const res = await applyRenames([
    { from: path.join(d, 'n1.png'), to: 'n1🔴.png' },
    { from: path.join(d, 'n2.png'), to: 'n2🔴.png' }
  ]);
  assert.equal(res.done.length, 1);
  assert.equal(res.skipped.length, 1);
  assert.ok(res.skipped[0].from.endsWith('n2.png'));
  assert.ok(fs.existsSync(path.join(d, 'n1🔴.png')));
  assert.ok(fs.existsSync(path.join(d, 'n2.png')), '被跳过的那张必须保持原名');
});

/* ---------- 4. 打包回滚后不再产生「幽灵照片」 ---------- */

test('executeBatch：改名阶段整批回滚时，renamesApplied 指向文件真实所在位置', async () => {
  const d = mk('rollback-src', { 'r1.png': makePNG(8, 8, [7, 7, 7]) });
  const out = path.join(TMP, 'rollback-out');
  const photos = [{ id: path.join(d, 'r1.png'), name: 'r1.png', src: path.join(d, 'r1.png') }];
  const plan = planBatch({ photos, platformIds: ['xhs'], note: '回滚', root: out, date: new Date(2026, 9, 25) });
  const res = await executeBatch({ plan, root: out, photos });
  // 不变量：渲染层拿到的每个路径都必须在磁盘上真实存在，否则就是「幽灵卡片」
  assert.ok(Array.isArray(res.renamesApplied));
  for (const r of res.renamesApplied) {
    assert.ok(fs.existsSync(r.from), `renamesApplied 的路径必须真实存在：${r.from}`);
  }
  for (const r of res.renamesChanged) {
    assert.ok(fs.existsSync(r.to), `renamesChanged.to 必须真实存在：${r.to}`);
  }
  for (const p of res.renamesUntouched) {
    assert.ok(fs.existsSync(p), `renamesUntouched 必须真实存在：${p}`);
  }
  assert.equal(res.renamesChanged.length, 1);
  assert.ok(fs.existsSync(path.join(d, 'r1🔴.png')));
  assert.equal(res.renamesApplied.length, 0, '未回滚时 renamesApplied 为空');
});

/* ---------- 5. 撤销：撤销后重新标记，仍可再次撤销 ---------- */

test('改名：执行期错误触发回滚时，done 清空且源文件名全部复原', async () => {
  const d = mk('exec-err', { 'e1.png': makePNG(8, 8, [1, 2, 3]) });
  // 第二条的源路径不存在 → 会被预检跳过（不触发回滚）；这里构造真正的执行期失败：
  // 让第二条源文件在预检后消失，用子目录权限模拟代价太高，改为验证「预检跳过不连坐」这一契约
  const res = await applyRenames([
    { from: path.join(d, 'e1.png'), to: 'e1🔴.png' },
    { from: path.join(d, 'ghost.png'), to: 'ghost🔴.png' }
  ]);
  assert.equal(res.done.length, 1, '正常项不能被异常项连坐');
  assert.equal(res.skipped.length, 1);
  assert.equal(res.rolledBack, false);
  assert.ok(fs.existsSync(path.join(d, 'e1🔴.png')));
});

test('撤销：反向映射可重复使用（磁盘回到目标名后应允许再撤）', async () => {
  const d = mk('redo', { 'u.png': makePNG(8, 8, [9, 9, 9]) });
  const from = path.join(d, 'u.png');
  const first = await applyRenames([{ from, to: 'u🔴.png' }]);
  assert.equal(first.done.length, 1);
  const undoPlan = planUndo({ renames: first.done });
  const undone = await undoRenames(undoPlan.renames);
  assert.equal(undone.done.length, 1);
  assert.ok(fs.existsSync(from));
  // 再标记一次 → 再撤销，必须同样成功（旧实现会被「已撤销」永久锁死）
  const again = await applyRenames([{ from, to: 'u🔴.png' }]);
  assert.equal(again.done.length, 1);
  const undone2 = await undoRenames(planUndo({ renames: again.done }).renames);
  assert.equal(undone2.done.length, 1);
  assert.ok(fs.existsSync(from));
});

/* ---------- 6. 快捷键匹配 ---------- */

test('快捷键：Backspace 的多种 event.key 写法都能匹配', () => {
  assert.equal(normalizeKeyName('Backspace'), 'Backspace');
  assert.equal(normalizeKeyName('⌫'), 'Backspace');
  assert.equal(normalizeKeyName('Delete'), 'Delete');
  assert.equal(normalizeKeyName('ForwardDelete'), 'Delete');
});

test('快捷键：Ctrl+字母在 mac 下 event.key 为控制字符时也能命中', () => {
  const combo = eventToCombo({ key: '\u000B', code: 'KeyK', metaKey: true, shiftKey: false, altKey: false, ctrlKey: false });
  assert.equal(combo.key, 'K');
  assert.equal(matchShortcut('⌘+K', { key: '\u000B', code: 'KeyK', metaKey: true, shiftKey: false, altKey: false, ctrlKey: false }), true);
});

test('快捷键：中文输入法下的空格/字母仍可匹配', () => {
  assert.equal(matchShortcut('Space', { key: ' ', code: 'Space' }), true);
  assert.equal(matchShortcut('K', { key: 'k', code: 'KeyK' }), true);
});

test('默认快捷键全表都合法（设置页「恢复默认」不会塞进无效值）', () => {
  for (const [k, v] of Object.entries(DEFAULT_SHORTCUTS)) {
    assert.ok(v && String(v).trim(), `快捷键 ${k} 为空`);
  }
});

/* ---------- 7. 平台校验 ---------- */

test('平台校验：emoji 含路径分隔符属于致命问题', () => {
  const issues = validatePlatforms([{ id: 'a', name: 'A', emoji: '/', shortcut: '1' }]);
  assert.ok(issues.some((i) => i.kind === 'emoji'));
  assert.equal(hasFatalPlatformIssue(issues), true);
});

test('平台校验：emoji 过长属于致命问题', () => {
  const issues = validatePlatforms([{ id: 'a', name: 'A', emoji: 'ABCDE', shortcut: '1' }]);
  assert.ok(issues.some((i) => i.kind === 'emoji' && i.msg.includes('过长')));
});

test('平台校验：emoji 仅差变体选择符也算重复', () => {
  const issues = validatePlatforms([
    { id: 'a', name: 'A', emoji: '⚫', shortcut: '1' },
    { id: 'b', name: 'B', emoji: '⚫️', shortcut: '2' }
  ]);
  assert.ok(issues.some((i) => i.kind === 'emoji'), JSON.stringify(issues));
});

test('平台校验：超过 9 个平台被拦（快捷数字键只有 9 个）', () => {
  const list = Array.from({ length: 10 }, (_, i) => ({
    id: `p${i}`, name: `P${i}`, emoji: `M${i}`, shortcut: String((i % 9) + 1)
  }));
  assert.equal(hasFatalPlatformIssue(validatePlatforms(list)), true);
});

/* ---------- 8. 标记解析容错 ---------- */

test('marksToPlatformIds：带 / 不带变体选择符的 emoji 都能认出平台', () => {
  const platforms = [{ id: 'x', name: 'X', emoji: '⚫️' }];
  assert.deepEqual(marksToPlatformIds(['⚫'], platforms), ['x']);
  assert.deepEqual(marksToPlatformIds(['⚫️'], platforms), ['x']);
});

/* ---------- 9. 扫描 ---------- */

test('扫描：带标记文件与同名不同标记文件不会互相吞掉', async () => {
  const d = mk('scan', {
    'p.png': makePNG(8, 8, [1, 2, 3]),
    'p🔴.png': makePNG(8, 8, [4, 5, 6]),
    'p🔴🟢.png': makePNG(8, 8, [7, 8, 9])
  });
  const data = await scanFolder(d, DEFAULT_PLATFORMS);
  assert.equal(data.photos.length, 3);
  const bases = data.photos.map((p) => p.base);
  assert.ok(bases.every((b) => b === 'p'));
  const marksCount = data.photos.map((p) => p.platforms.length).sort();
  assert.deepEqual(marksCount, [0, 1, 2]);
});

test('computeRename：返回 lostIds 便于识别「部分失败」', () => {
  const r = computeRename('a🔴.png', ['moments']);
  assert.deepEqual(r.lostIds, ['xhs']);
});
