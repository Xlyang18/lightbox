/**
 * 集成测试：真实文件系统（不启动 Electron，直接测 fs-ops + core）
 * 覆盖：扫描、打包复制、改名、冲突回滚、撤销、只读保证
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  scanFolder, photosUnder, executeBatch, applyRenames, undoRenames,
  appendHistory, readHistory, resolveCollision
} from '../electron/fs-ops.mjs';
import { planBatch, planUndo, analyzeCoverage, DEFAULT_PLATFORMS, parseName } from '../src/lib/core.mjs';
import { makePNG } from '../scripts/make-fixtures.cjs';

const TMP = path.join(os.tmpdir(), `lightbox-it-${Date.now()}`);
const SRC = path.join(TMP, '照片集');
const OUT = path.join(TMP, '待发布');

function buildFixture() {
  fs.mkdirSync(path.join(SRC, 'A 组'), { recursive: true });
  fs.mkdirSync(path.join(SRC, 'A 组', '子组'), { recursive: true });
  fs.mkdirSync(path.join(SRC, 'B 组'), { recursive: true });
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(SRC, 'A 组', 'a1.png'), makePNG(40, 30, [200, 50, 50]));
  fs.writeFileSync(path.join(SRC, 'A 组', 'a2.png'), makePNG(40, 30, [50, 200, 50]));
  fs.writeFileSync(path.join(SRC, 'A 组', '子组', 'a3.png'), makePNG(40, 30, [50, 50, 200]));
  fs.writeFileSync(path.join(SRC, 'B 组', 'b1.png'), makePNG(40, 30, [200, 200, 50]));
  fs.writeFileSync(path.join(SRC, 'B 组', 'b1🔴.png'), makePNG(40, 30, [180, 60, 180]));
  fs.writeFileSync(path.join(SRC, 'A 组', 'ignore.txt'), 'x');
}

function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(dir, p)] = fs.statSync(p).size;
    }
  };
  walk(dir);
  return out;
}

test.before(() => { buildFixture(); });
test.after(() => {
  // 测试清理只针对本次 tmp 目录（生产代码不含删除逻辑）
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('scanFolder：多级目录扫描、忽略非图片与隐藏文件', async () => {
  const data = await scanFolder(SRC, DEFAULT_PLATFORMS);
  assert.equal(data.photos.length, 5);
  assert.equal(data.tree.count, 5);
  assert.equal(data.tree.children.length, 2);
  const aGroup = data.tree.children.find((c) => c.name === 'A 组');
  assert.equal(aGroup.ownCount, 2);
  assert.equal(aGroup.count, 3);
  assert.ok(!data.photos.some((p) => p.name === 'ignore.txt'));
});

test('scanFolder：带标记文件正确解析出平台', async () => {
  const data = await scanFolder(SRC, DEFAULT_PLATFORMS);
  const marked = data.photos.find((p) => p.name.startsWith('b1🔴'));
  assert.ok(marked, '应找到带标记文件');
  assert.deepEqual(marked.platforms, ['xhs']);
  assert.equal(marked.base, 'b1');
});

test('photosUnder：递归取子目录照片', async () => {
  const data = await scanFolder(SRC, DEFAULT_PLATFORMS);
  const aAll = photosUnder('A 组', data.tree);
  assert.equal(aAll.length, 3);
  const aOnly = photosUnder('A 组/子组', data.tree);
  assert.equal(aOnly.length, 1);
});

test('executeBatch：复制到每平台一个子文件夹，命名正确', async () => {
  const data = await scanFolder(SRC, DEFAULT_PLATFORMS);
  const photos = data.photos.filter((p) => p.name.startsWith('a1') || p.name.startsWith('a2'))
    .map((p) => ({ id: p.path, name: p.name, src: p.path }));
  const plan = planBatch({
    photos, platformIds: ['xhs', 'moments'], note: '集成测试批次',
    root: OUT, date: new Date(2026, 9, 25)
  });
  const res = await executeBatch({ plan, root: OUT, photos });
  assert.equal(res.errors.length, 0);
  assert.equal(res.folders.length, 2);
  const xhsDir = path.join(OUT, '20261025-小红书-集成测试批次');
  const momentsDir = path.join(OUT, '20261025-朋友圈-集成测试批次');
  assert.ok(fs.existsSync(xhsDir));
  assert.ok(fs.existsSync(momentsDir));
  assert.equal(fs.readdirSync(xhsDir).length, 2);
  assert.equal(fs.readdirSync(momentsDir).length, 2);
  // 文件名应含标记
  assert.ok(fs.readdirSync(xhsDir).some((f) => f.includes('🔴')));
});

test('executeBatch：原片被改名且文件仍存在（未删除）', async () => {
  const d = path.join(TMP, 'case-rename');
  fs.mkdirSync(d, { recursive: true });
  const f = path.join(d, 'a1.png');
  fs.writeFileSync(f, makePNG(20, 15, [1, 1, 1]));
  const photos = [{ id: f, name: 'a1.png', src: f }];
  const plan = planBatch({ photos, platformIds: ['xhs', 'moments'], note: 'x', root: path.join(TMP, 'case-rename-out'), date: new Date(2026, 9, 25) });
  await executeBatch({ plan, root: path.join(TMP, 'case-rename-out'), photos });
  const a1 = path.join(d, 'a1🔴🟢.png');
  assert.ok(fs.existsSync(a1), '原片应已改名并存在');
  const old = path.join(d, 'a1.png');
  assert.ok(!fs.existsSync(old), '旧名应已不存在');
  // 内容完好
  assert.ok(fs.statSync(a1).size > 0);
});

test('executeBatch：重复执行同一批次不覆盖已有文件（追加序号）', async () => {
  const d = path.join(TMP, 'case-dup');
  const out = path.join(TMP, 'case-dup-out');
  fs.mkdirSync(d, { recursive: true });
  const f = path.join(d, 'dup.png');
  fs.writeFileSync(f, makePNG(20, 15, [2, 2, 2]));
  const photos = [{ id: f, name: 'dup.png', src: f }];
  const mk = () => planBatch({ photos, platformIds: ['xhs'], note: '重复', root: out, date: new Date(2026, 9, 25) });
  await executeBatch({ plan: mk(), root: out, photos });
  const size1 = fs.statSync(path.join(out, '20261025-小红书-重复', fs.readdirSync(path.join(out, '20261025-小红书-重复'))[0])).size;
  const res2 = await executeBatch({ plan: mk(), root: out, photos });
  assert.equal(res2.errors.length, 0);
  const files = fs.readdirSync(path.join(out, '20261025-小红书-重复'));
  assert.equal(files.length, 2, `应新增一份而不是覆盖，实际：${files.join(',')}`);
  assert.ok(files.some((x) => x.includes('(1)')), '应出现带序号的副本');
  for (const x of files) assert.equal(fs.statSync(path.join(out, '20261025-小红书-重复', x)).size, size1);
});

test('改名冲突：目标已存在时整批回滚，原文件不受损', async () => {
  const dir = path.join(SRC, 'B 组');
  fs.writeFileSync(path.join(dir, 'conflict.png'), makePNG(10, 10, [1, 2, 3]));
  fs.writeFileSync(path.join(dir, 'conflict🔴.png'), makePNG(10, 10, [4, 5, 6]));
  const before = snapshot(dir);
  const res = await applyRenames([
    { from: path.join(dir, 'conflict.png'), to: 'conflict🔴.png' } // 目标已存在 -> 应跳过
  ]);
  assert.equal(res.done.length, 0);
  assert.equal(res.skipped.length, 1, '应记录为跳过');
  assert.equal(res.errors.length, 0, '预检跳过不算错误');
  const after = snapshot(dir);
  assert.deepEqual(after, before, '冲突时应完全不动文件');
});

test('改名健壮性：不存在/已冲突的项被跳过，其余正常完成（不连坐）', async () => {
  const dir = path.join(TMP, 'case-skip');
  fs.mkdirSync(dir, { recursive: true });
  for (const n of ['ok1.png', 'ok2.png']) fs.writeFileSync(path.join(dir, n), makePNG(10, 10, [1, 2, 3]));
  fs.writeFileSync(path.join(dir, 'taken🔵.png'), makePNG(10, 10, [9, 9, 9]));
  fs.writeFileSync(path.join(dir, 'taken.png'), makePNG(10, 10, [8, 8, 8]));
  const res = await applyRenames([
    { from: path.join(dir, 'ok1.png'), to: 'ok1🔵.png' },
    { from: path.join(dir, 'ok2.png'), to: 'ok2🔵.png' },
    { from: path.join(dir, 'missing.png'), to: 'missing🔵.png' },
    { from: path.join(dir, 'taken.png'), to: 'taken🔵.png' }
  ]);
  assert.equal(res.done.length, 2, '两个正常的应完成');
  assert.equal(res.skipped.length, 2, '两个异常的应被跳过并记录');
  assert.equal(res.errors.length, 0, '跳过不进 errors');
  assert.equal(res.rolledBack, false, '预检跳过不应触发整批回滚');
  assert.ok(fs.existsSync(path.join(dir, 'ok1🔵.png')));
  assert.ok(fs.existsSync(path.join(dir, 'ok2🔵.png')));
  assert.ok(fs.existsSync(path.join(dir, 'taken.png')), '冲突项原文件必须保留');
  assert.ok(fs.existsSync(path.join(dir, 'taken🔵.png')), '冲突项目的文件也必须保留');
});

test('撤销：改名可完整还原', async () => {
  const dir = path.join(TMP, 'case-undo');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'u1.png'), makePNG(10, 10, [7, 7, 7]));
  const res = await applyRenames([{ from: path.join(dir, 'u1.png'), to: 'u1🟢.png' }]);
  assert.equal(res.done.length, 1);
  assert.ok(fs.existsSync(path.join(dir, 'u1🟢.png')));
  const undo = planUndo({ renames: [{ from: path.join(dir, 'u1.png'), to: path.join(dir, 'u1🟢.png') }] });
  const res2 = await undoRenames(undo.renames);
  assert.equal(res2.done.length, 1);
  assert.ok(fs.existsSync(path.join(dir, 'u1.png')), '撤销后应恢复原名');
});

test('历史：追加与倒序读取', async () => {
  const hf = path.join(TMP, 'history.jsonl');
  await appendHistory(hf, { id: '1', type: 'batch', at: new Date().toISOString() });
  await appendHistory(hf, { id: '2', type: 'mark', at: new Date().toISOString() });
  const list = await readHistory(hf);
  assert.equal(list.length, 2);
  assert.equal(list[0].id, '2', '应倒序返回最新在前');
});

test('历史：坏行不影响读取', async () => {
  const hf = path.join(TMP, 'history-bad.jsonl');
  await fsp.writeFile(hf, '{bad json}\n{"id":"good","type":"mark"}\n');
  const list = await readHistory(hf);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'good');
});

test('安全：待发布目录不可位于摄影集内部（isInside 校验）', async () => {
  const { isInside } = await import('../electron/fs-ops.mjs');
  assert.equal(isInside(SRC, path.join(SRC, 'inner')), true);
  assert.equal(isInside(SRC, OUT), false);
});

test('冗余安全：批量打包 20 张 × 3 平台，副本数量精确', async () => {
  const many = path.join(TMP, '批量');
  fs.mkdirSync(many, { recursive: true });
  const photos = [];
  for (let i = 0; i < 20; i += 1) {
    const p = path.join(many, `m${String(i).padStart(2, '0')}.png`);
    fs.writeFileSync(p, makePNG(24, 18, [i * 10, 100, 150]));
    photos.push({ id: p, name: path.basename(p), src: p });
  }
  const out2 = path.join(TMP, '批量待发布');
  const plan = planBatch({
    photos, platformIds: ['xhs', 'moments', 'bili'], note: '压力批次',
    root: out2, date: new Date(2026, 9, 25)
  });
  const res = await executeBatch({ plan, root: out2, photos });
  assert.equal(res.errors.length, 0);
  assert.equal(res.copies.length, 60, `实际 copies=${res.copies.length}, errors=${JSON.stringify(res.errors.slice(0,3))}`);
  assert.equal(res.renames.length, 20);
  for (const d of ['20261025-小红书-压力批次', '20261025-朋友圈-压力批次', '20261025-哔哩哔哩-压力批次']) {
    assert.equal(fs.readdirSync(path.join(out2, d)).length, 20, `${d} 应有 20 张`);
  }
});

test('数据完整性：打包副本与原片字节一致', async () => {
  const out2 = path.join(TMP, '字节校验');
  const dir = path.join(TMP, '字节源');
  fs.mkdirSync(dir, { recursive: true });
  const src = path.join(dir, 'copy.png');
  const buf = makePNG(64, 48, [33, 66, 99]);
  fs.writeFileSync(src, buf);
  const photos = [{ id: src, name: 'copy.png', src }];
  const plan = planBatch({ photos, platformIds: ['xhs'], note: '字节', root: out2, date: new Date(2026, 9, 25) });
  await executeBatch({ plan, root: out2, photos });
  const copied = path.join(out2, '20261025-小红书-字节', 'copy🔴.png');
  assert.ok(fs.existsSync(copied));
  assert.deepEqual(fs.readFileSync(copied), buf, '副本应与原片完全一致');
});
