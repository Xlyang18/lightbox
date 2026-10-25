/**
 * 光匣 · 文件系统层
 * 安全铁律（硬约束）：
 *  1. 本文件禁止出现任何删除文件的调用（unlink / rm / rimraf / trash / rmdir）。
 *  2. 全部写操作都在「打包目录」内或对「重命名源文件」进行，绝不覆盖已有内容。
 *  3. 每个会改动文件的操作都写入操作历史，支持撤销。
 */
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  isImageFile, parseName, marksToPlatformIds, computeRename,
  makeBatchFolderName, resolveCollision, planBatch, isInside, platformIdsToMarks,
  DEFAULT_PLATFORMS as DEFAULT_PLATFORMS_REF
} from '../src/lib/core.mjs';

/* ---------------- 目录扫描 ---------------- */

const MAX_DEPTH = 24;
const SKIP_DIRS = new Set([
  'node_modules', '$RECYCLE.BIN', 'System Volume Information',
  'Library', '.Trashes', 'Applications'
]);

/**
 * 递归扫描：返回目录树 + 照片列表（含子目录）
 * 性能要点：
 *  - 同一层级的子目录并发遍历（Promise.all + 并发闸门），避免逐层串行等待
 *  - 忽略符号链接，防止软链成环导致无限递归
 *  - 限制最大深度，防止异常目录结构拖垮界面
 */
export async function scanFolder(rootPath, platforms, options = {}) {
  const root = path.resolve(rootPath);
  const photos = [];
  const limit = options.concurrency || 8;
  const parseCache = new Map();

  const parseOnce = (name) => {
    if (!parseCache.has(name)) parseCache.set(name, parseName(name, platforms));
    return parseCache.get(name);
  };

  // 简易并发闸门：同时最多 limit 个目录在读
  let active = 0;
  const queue = [];
  const acquire = () => new Promise((resolve) => {
    if (active < limit) { active += 1; resolve(); }
    else queue.push(resolve);
  });
  const release = () => {
    active -= 1;
    const next = queue.shift();
    if (next) { active += 1; next(); }
  };

  async function walk(dir, relPath, depth) {
    if (depth > MAX_DEPTH) {
      return { name: path.basename(dir), path: dir, relPath, ownCount: 0, count: 0, children: [], truncated: true };
    }
    await acquire();
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (e) {
      release();
      return { name: path.basename(dir), path: dir, relPath, ownCount: 0, count: 0, children: [], error: e.message };
    }
    release();

    const visible = entries.filter((e) => !e.name.startsWith('.') && !SKIP_DIRS.has(e.name));
    const subNames = visible.filter((e) => e.isDirectory()).map((e) => e.name)
      .sort((a, b) => a.localeCompare(b, 'zh'));

    const fileItems = [];
    for (const e of visible) {
      if (!e.isFile() || !isImageFile(e.name)) continue;
      const parsed = parseOnce(e.name);
      fileItems.push({
        name: e.name,
        path: path.join(dir, e.name),
        dir,
        relDir: relPath,
        base: parsed.base,
        marks: parsed.marks,
        platforms: marksToPlatformIds(parsed.marks, platforms)
      });
    }
    fileItems.sort((a, b) => a.name.localeCompare(b.name, 'zh', { numeric: true }));

    const childResults = await Promise.all(
      subNames.map((sub) => walk(path.join(dir, sub), relPath ? `${relPath}/${sub}` : sub, depth + 1))
    );

    let total = fileItems.length;
    for (const c of childResults) total += c.count;

    return {
      name: path.basename(dir),
      path: dir,
      relPath,
      ownCount: fileItems.length,
      count: total,
      children: childResults,
      files: fileItems
    };
  }

  const tree = await walk(root, '', 0);

  // 一次性收集全部照片（按树顺序，稳定）
  const collect = (node) => {
    for (const f of node.files || []) photos.push(f);
    for (const c of node.children || []) collect(c);
  };
  collect(tree);

  return { root, rootName: path.basename(root), tree, photos };
}

function findByRel(node, rel) {
  if (!rel) return node;
  let cur = node;
  for (const seg of rel.split('/')) {
    cur = (cur.children || []).find((c) => c.name === seg);
    if (!cur) return null;
  }
  return cur;
}

/** 取某个目录（含递归）下的照片 */
export function photosUnder(relPath, tree) {
  const node = findByRel(tree, relPath || '');
  if (!node) return [];
  const out = [];
  const walkNode = (n) => {
    for (const f of n.files || []) out.push(f);
    for (const c of n.children || []) walkNode(c);
  };
  walkNode(node);
  return out;
}

/* ---------------- 复制 ---------------- */

/**
 * 复制文件到目标目录，自动避免覆盖；返回写入后的绝对路径
 * 目录列表一次读取后在本批内复用，避免 O(n²) 的 readdir
 */
export async function copyWithCollision(src, destDir, fileName, takenSet) {
  await fs.mkdir(destDir, { recursive: true });
  let taken = takenSet;
  if (!taken) {
    try { taken = new Set(await fs.readdir(destDir)); } catch { taken = new Set(); }
  }
  const finalName = resolveCollision(fileName, taken);
  const dest = path.join(destDir, finalName);
  if (path.dirname(src) === destDir && path.basename(src) === finalName) {
    throw new Error('源文件与目标文件相同，拒绝覆盖');
  }
  // COPYFILE_EXCL：内核级「目标已存在则失败」，作为覆盖的最后一道保险
  try {
    await fs.copyFile(src, dest, fssync.constants.COPYFILE_EXCL);
  } catch (e) {
    if (e.code === 'EEXIST') {
      taken.add(finalName);
      const alt = resolveCollision(fileName, taken);
      await fs.copyFile(src, path.join(destDir, alt), fssync.constants.COPYFILE_EXCL);
      taken.add(alt);
      return { path: path.join(destDir, alt), name: alt, renamed: alt !== fileName };
    }
    throw e;
  }
  taken.add(finalName);
  return { path: dest, name: finalName, renamed: finalName !== fileName };
}

/* ---------------- 改名 ---------------- */

/**
 * 执行一批改名
 * 阶段一：预检（源是否存在、目标是否被占用、同批次内目标是否互撞）
 * 阶段二：执行
 * 阶段三：仅「执行期错误」才回滚；预检跳过不触发回滚
 *
 * renames: [{ from(绝对路径), to(文件名) }]
 */
export async function applyRenames(renames) {
  const done = [];
  const skipped = [];
  const dirCache = new Map();
  const listDir = (dir) => {
    if (!dirCache.has(dir)) {
      let set;
      try {
        set = new Set(fssync.readdirSync(dir).map((n) => n.normalize('NFC')));
      } catch {
        set = new Set();
      }
      dirCache.set(dir, set);
    }
    return dirCache.get(dir);
  };

  const valid = [];
  const claimed = new Set(); // 同批次已被占用的目标（防互撞）
  for (const r of renames) {
    if (!r.from || !r.to) continue;
    if (!fssync.existsSync(r.from)) {
      skipped.push({ from: r.from, to: r.to, error: '源文件不存在，已跳过' });
      continue;
    }
    const dir = path.dirname(r.from);
    if (path.basename(r.from) === r.to) continue; // 名字未变
    const targetKey = `${dir}::${r.to.normalize('NFC')}`;
    if (claimed.has(targetKey) || listDir(dir).has(r.to.normalize('NFC'))) {
      skipped.push({ from: r.from, to: r.to, error: '目标文件已存在，跳过以避免覆盖' });
      continue;
    }
    claimed.add(targetKey);
    valid.push(r);
  }

  const execErrors = [];
  for (const r of valid) {
    const target = path.join(path.dirname(r.from), r.to);
    try {
      await fs.rename(r.from, target);
      done.push({ from: r.from, to: target });
    } catch (e) {
      execErrors.push({ from: r.from, to: r.to, error: e.message });
    }
  }

  if (execErrors.length > 0 && done.length > 0) {
    let rolledBackCount = 0;
    for (const d of done.slice().reverse()) {
      try {
        await fs.rename(d.to, d.from);
        rolledBackCount += 1;
      } catch {
        /* 回滚失败保留原状，由调用方记录 */
      }
    }
    return { done: [], skipped, errors: execErrors, rolledBack: true, rolledBackCount };
  }
  return { done, skipped, errors: execErrors, rolledBack: false };
}

/** 撤销改名：把历史里的 to 改回 from（均为绝对路径，不能丢目录） */
export async function undoRenames(pairs) {
  return applyRenames(pairs.map((p) => ({
    from: p.from,
    to: path.basename(p.to)
  })));
}

/* ---------------- 历史 ---------------- */

/** 历史记录读写（JSON Lines，追加式，永不清空） */
export async function appendHistory(historyFile, entry) {
  await fs.mkdir(path.dirname(historyFile), { recursive: true });
  await fs.appendFile(historyFile, JSON.stringify(entry) + '\n', 'utf8');
}

/** 只读最近 N 条（从文件尾部读，避免日志变大后整文件载入） */
export async function readHistory(historyFile, limit = 500) {
  let raw;
  try {
    const st = await fs.stat(historyFile);
    const MAX_BYTES = 4 * 1024 * 1024;
    if (st.size > MAX_BYTES) {
      const fh = await fs.open(historyFile, 'r');
      try {
        const buf = Buffer.alloc(MAX_BYTES);
        await fh.read(buf, 0, MAX_BYTES, st.size - MAX_BYTES);
        raw = buf.toString('utf8');
        // 丢掉被截断的首行
        const nl = raw.indexOf('\n');
        raw = nl >= 0 ? raw.slice(nl + 1) : '';
      } finally {
        await fh.close();
      }
    } else {
      raw = await fs.readFile(historyFile, 'utf8');
    }
  } catch {
    return [];
  }
  const items = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try { items.push(JSON.parse(line)); } catch { /* 跳过坏行 */ }
  }
  return items.slice(-limit).reverse();
}

/* ---------------- 批次执行 ---------------- */

/**
 * 执行完整批次
 * 步骤：复制到各平台文件夹 → 原片改名
 * 性能：平台文件夹与副本一次性建索引；每个目录只 readdir 一次
 */
export async function executeBatch({ plan, root, photos, platforms }) {
  const PLATFORM_REF = platforms && platforms.length ? platforms : DEFAULT_PLATFORMS_REF;
  const result = { copies: [], folders: [], renames: [], errors: [], skipped: [], historyId: crypto.randomUUID() };

  // 自愈：调用方可能持有过期路径（上一批已改过名），按「基础名 + 扩展名」回源目录重新定位
  const dirIndex = new Map();
  const listDir = (dir) => {
    if (!dirIndex.has(dir)) {
      try { dirIndex.set(dir, fssync.readdirSync(dir)); } catch { dirIndex.set(dir, []); }
    }
    return dirIndex.get(dir);
  };
  const resolveRealPath = (src) => {
    if (!src) return null;
    if (fssync.existsSync(src)) return src;
    const dir = path.dirname(src);
    const want = parseName(path.basename(src), PLATFORM_REF);
    const hit = listDir(dir).find((n) => {
      const p = parseName(n, PLATFORM_REF);
      return p.base === want.base && p.ext.toLowerCase() === want.ext.toLowerCase();
    });
    return hit ? path.join(dir, hit) : null;
  };

  // 按文件夹分组的副本计划（避免 O(n²) 的 filter）
  const copiesByFolder = new Map();
  for (const c of plan.copies) {
    if (!copiesByFolder.has(c.folderName)) copiesByFolder.set(c.folderName, []);
    copiesByFolder.get(c.folderName).push(c);
  }

  for (const f of plan.folders) {
    const dir = path.join(root, f.folderName);
    await fs.mkdir(dir, { recursive: true });
    result.folders.push(dir);
    let taken;
    try { taken = new Set(await fs.readdir(dir)); } catch { taken = new Set(); }
    for (const c of copiesByFolder.get(f.folderName) || []) {
      try {
        const realSrc = resolveRealPath(c.src);
        if (!realSrc) throw new Error('源文件不存在');
        const r = await copyWithCollision(realSrc, dir, c.fileName, taken);
        result.copies.push({ ...r, platformId: c.platformId, folder: dir, src: realSrc });
      } catch (e) {
        result.errors.push({ stage: 'copy', file: c.src, error: e.message });
      }
    }
  }

  // 改名：只对「照片对象里的绝对路径」操作
  const absoluteRenames = [];
  const planPhotos = photos || [];
  for (const r of plan.renames) {
    if (r.same) continue;
    const ph = planPhotos.find((p) => p.name === r.from || p.src === r.from || p.path === r.from);
    if (!ph) continue;
    const absPath = resolveRealPath(ph.path || ph.src);
    if (!absPath) continue;
    absoluteRenames.push({ from: absPath, to: r.to });
  }

  const ren = await applyRenames(absoluteRenames);
  result.renames = ren.done;
  // 「目标已存在」= 原片已是该状态，属于正常幂等跳过，不算失败
  result.skipped = ren.skipped || [];
  for (const e of ren.errors || []) result.errors.push({ stage: 'rename', ...e });
  result.rolledBack = ren.rolledBack;

  return { ...result, renamesPlanned: absoluteRenames };
}

/* ---------------- 杂项 ---------------- */

export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export async function pathExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function listDir(p) {
  try {
    const entries = await fs.readdir(p, { withFileTypes: true });
    return entries.filter((e) => !e.name.startsWith('.')).map((e) => ({
      name: e.name, isDir: e.isDirectory(), path: path.join(p, e.name)
    }));
  } catch {
    return [];
  }
}

export async function statSafe(p) {
  try {
    return await fs.stat(p);
  } catch {
    return null;
  }
}

export { isInside, makeBatchFolderName, resolveCollision, platformIdsToMarks, computeRename };
