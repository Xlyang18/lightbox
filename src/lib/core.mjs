/**
 * 光匣 · 核心纯函数层（无 Electron / 无 IO）
 * 全部逻辑集中在此，便于单元测试与审计。
 * 安全铁律：本文件永不出现删除文件的调用。
 */

/** 支持的图片扩展名（小写，不含点） */
export const IMAGE_EXTS = new Set([
  'jpg', 'jpeg', 'png', 'heic', 'heif', 'webp', 'gif', 'bmp', 'tif', 'tiff', 'avif'
]);

/** 默认平台清单：id 稳定不变，emoji 与颜色可改 */
export const DEFAULT_PLATFORMS = [
  { id: 'xhs', name: '小红书', emoji: '🔴', color: '#FF2442', shortcut: '1', enabled: true },
  { id: 'moments', name: '朋友圈', emoji: '🟢', color: '#07C160', shortcut: '2', enabled: true },
  { id: 'bili', name: '哔哩哔哩', emoji: '🔵', color: '#00AEEC', shortcut: '3', enabled: true }
];

/** 可通过 UI 直接切换颜色 / 启用状态的平台色板（避免用户填非法色值） */
export const PLATFORM_COLORS = [
  '#FF2442', '#07C160', '#00AEEC', '#FF9F0A', '#AF52DE',
  '#FF375F', '#5AC8FA', '#FFD60A', '#8E8E93', '#30D158'
];

/** 文件名非法字符 */
export const MARK_SAFE_CHARS = /[/\\:*?"<>|\x00-\x1f]/g;

export function extOf(name) {
  const i = name.lastIndexOf('.');
  if (i <= 0) return '';
  return name.slice(i + 1);
}

/** 小写扩展名（用于判断类型） */
export function extLower(name) {
  return extOf(name).toLowerCase();
}

export function baseOf(name) {
  const i = name.lastIndexOf('.');
  if (i <= 0) return name;
  return name.slice(0, i);
}

export function isImageFile(name) {
  return IMAGE_EXTS.has(extLower(name));
}

/**
 * 「孤儿标记」集合：历史上被平台用过、但现在已不在平台清单里的 emoji。
 * 由于解析函数是纯函数，这里用模块级集合登记，扫描时由调用方注入。
 * 这样用户删除某个平台后，老文件上的标记仍能被正确识别并去除，
 * 而不是被当成文件名的一部分永久粘连。
 */
const ORPHAN_MARKS = new Set();

export function registerOrphanMarks(emojis) {
  for (const e of emojis || []) {
    if (typeof e === 'string' && e.trim()) ORPHAN_MARKS.add(e.trim());
  }
}

export function getOrphanMarks() {
  return [...ORPHAN_MARKS];
}

export function clearOrphanMarks() {
  ORPHAN_MARKS.clear();
}

/** 汇总「所有应识别的标记」：当前平台 + 孤儿标记 */
function allMarks(platforms) {
  const set = new Set();
  for (const p of platforms || []) {
    if (p && p.emoji && p.emoji.trim()) set.add(p.emoji.trim());
  }
  for (const e of ORPHAN_MARKS) set.add(e);
  return [...set];
}

/**
 * 拆解文件名中的「基础名 + 已有标记 + 扩展名」
 * 标记定义：出现在扩展名之前、位于文件名尾部的连续平台 emoji。
 * 例：DSC0123🔴🟢.JPG -> { base:'DSC0123', marks:['🔴','🟢'], ext:'JPG' }
 * 同时兼容旧版带分隔符写法（IMG_001-🔴.jpg）。
 */
export function parseName(fileName, platforms = DEFAULT_PLATFORMS) {
  const ext = extOf(fileName);
  let stem = isImageFile(fileName) || ext ? baseOf(fileName) : fileName;
  const emojiList = allMarks(platforms);
  const marks = [];
  let changed = true;
  while (changed) {
    changed = false;
    // 去掉尾部分隔符（含 __ - _ . 空格）
    const trimmed = stem.replace(/[_\-.·\s]+$/u, '');
    if (trimmed !== stem) {
      stem = trimmed;
      changed = true;
    }
    for (const em of emojiList) {
      if (stem.endsWith(em)) {
        marks.unshift(em);
        stem = stem.slice(0, stem.length - em.length);
        changed = true;
        break;
      }
    }
  }
  return { base: stem, marks, ext };
}

/** 依据标记列表生成新文件名（标记紧贴扩展名前，原始扩展名大小写保留） */
export function buildName(base, marks, ext) {
  const uniq = dedupe(marks);
  const suffix = uniq.join('');
  return ext ? `${base}${suffix}.${ext}` : `${base}${suffix}`;
}

export function dedupe(list) {
  const seen = new Set();
  const out = [];
  for (const x of list) {
    if (!seen.has(x)) {
      seen.add(x);
      out.push(x);
    }
  }
  return out;
}

/** emoji 归一：去掉变体选择符 FE0F 与零宽连接符后的可比形态 */
export function normalizeEmoji(s) {
  return String(s || '').replace(/[\uFE0F\u200D]/g, '');
}

/** 由平台 emoji 数组求平台 id 数组（有序、去重） */
export function marksToPlatformIds(marks, platforms = DEFAULT_PLATFORMS) {
  const ids = [];
  for (const m of marks) {
    const key = normalizeEmoji(m);
    const p = platforms.find((x) => normalizeEmoji(x.emoji) === key);
    if (p && !ids.includes(p.id)) ids.push(p.id);
  }
  return ids;
}

/** 由平台 id 数组求有序 emoji 数组（按平台清单顺序，保证幂等） */
export function platformIdsToMarks(ids, platforms = DEFAULT_PLATFORMS) {
  return platforms.filter((p) => ids.includes(p.id)).map((p) => p.emoji);
}

/**
 * 计算改名：当前文件名 + 目标平台 id 数组 -> 新文件名
 * 幂等：对已具备全部标记的文件再次计算，返回 same:true
 */
export function computeRename(fileName, targetPlatformIds, platforms = DEFAULT_PLATFORMS) {
  const parsed = parseName(fileName, platforms);
  const currentIds = marksToPlatformIds(parsed.marks, platforms);
  const nextMarks = platformIdsToMarks(targetPlatformIds, platforms);
  const nextName = buildName(parsed.base, nextMarks, parsed.ext);
  const nextIds = dedupe(targetPlatformIds).filter((id) => platforms.some((p) => p.id === id));
  return {
    from: fileName,
    to: nextName,
    base: parsed.base,
    ext: parsed.ext,
    currentIds,
    nextIds,
    same: nextName === fileName,
    // 丢失的平台（改名后检查器才会暴露部分失败的真实结果用）
    lostIds: currentIds.filter((id) => !nextIds.includes(id))
  };
}

/**
 * 批次子文件夹命名：{YYYYMMDD}-{平台名}-{备注}
 * 分隔符统一为 '-'，非法字符替换为 '_'，备注去首尾空白
 */
export function sanitizeSegment(s) {
  return String(s ?? '').replace(MARK_SAFE_CHARS, '_').replace(/\s+/g, ' ').trim();
}

export function makeBatchFolderName(date, platformName, note) {
  const d = formatDateCompact(date);
  const p = sanitizeSegment(platformName) || '未命名平台';
  const n = sanitizeSegment(note) || '未命名批次';
  return `${d}-${p}-${n}`;
}

/** Date -> YYYYMMDD（本地时区，非 UTC，避免跨日错位） */
export function formatDateCompact(date = new Date()) {
  const dt = date instanceof Date ? date : new Date(date);
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const d = String(dt.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

/** Date -> YYYY-MM-DD HH:mm（日志用） */
export function formatDateTime(date = new Date()) {
  const dt = date instanceof Date ? date : new Date(date);
  const pad = (n) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())} ${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
}

/**
 * 判断目标路径是否位于源目录内部（含相等）——用于防止自我覆盖
 */
export function isInside(parent, child) {
  if (!parent || !child) return false;
  const norm = (p) => p.replace(/\/+$/, '');
  const a = norm(parent);
  const b = norm(child);
  return b === a || b.startsWith(a + '/');
}

/**
 * 冲突检测：目标目录已存在同名文件时，追加 (1)(2)…
 * taken: 该目录下已存在的文件名集合（大小写不敏感比较，符合 macOS 默认文件系统）
 */
export function resolveCollision(name, taken) {
  const lower = new Set([...taken].map((t) => t.toLowerCase()));
  if (!lower.has(name.toLowerCase())) return name;
  const ext = extOf(name);
  const base = ext ? baseOf(name) : name;
  let i = 1;
  // 上限保护，避免死循环
  while (i < 10000) {
    const candidate = ext ? `${base} (${i}).${ext}` : `${base} (${i})`;
    if (!lower.has(candidate.toLowerCase())) return candidate;
    i += 1;
  }
  throw new Error('无法生成不冲突的文件名');
}

/**
 * 漏发分析
 * photos: [{ id, name, platforms: string[] , path }]
 * 返回 { never, missing, complete, byPlatform, missingCount, total, coverageRate }
 */
export function analyzeCoverage(photos, platforms = DEFAULT_PLATFORMS) {
  const active = platforms.filter((p) => p.enabled !== false);
  const never = [];
  const missing = [];
  const complete = [];
  const byPlatform = Object.fromEntries(active.map((p) => [p.id, 0]));
  const missingCount = Object.fromEntries(active.map((p) => [p.id, 0]));
  const activeIds = active.map((p) => p.id);

  for (const ph of photos) {
    const has = dedupe(ph.platforms || []).filter((id) => activeIds.includes(id));
    for (const id of has) byPlatform[id] += 1;
    const lack = activeIds.filter((id) => !has.includes(id));
    if (has.length === 0) {
      never.push(ph);
      for (const id of lack) missingCount[id] += 1;
    } else if (lack.length > 0) {
      missing.push({ ...ph, lack });
      for (const id of lack) missingCount[id] += 1;
    } else {
      complete.push(ph);
    }
  }
  const total = photos.length;
  const coverageRate = total === 0 ? 0 : Math.round((complete.length / total) * 1000) / 10;
  return { never, missing, complete, byPlatform, missingCount, total, coverageRate, activePlatforms: active };
}

/**
 * 重名检测：同一批次里，不同源文件经改名后目标名相同会互相覆盖。
 * photos: [{ name }]（当前实际文件名）
 * 返回 [{ to, names: [原文件名...] }]
 */
export function findNameClashes(photos, platformIds, platforms = DEFAULT_PLATFORMS) {
  const plans = (photos || []).map((ph) => computeRename(ph.name, platformIds, platforms));
  // 本批次里会被腾空的原始文件名（这些名字执行时必然消失，不算占位冲突）
  const vacated = new Set(plans.filter((r) => !r.same).map((r) => r.from.toLowerCase()));
  const byTarget = new Map();
  for (const r of plans) {
    const key = r.to.toLowerCase();
    if (!byTarget.has(key)) byTarget.set(key, { to: r.to, names: [] });
    byTarget.get(key).names.push(r.from);
  }
  return [...byTarget.values()].filter((x) => {
    // 目标名与本批次中「别的」即将改名的文件原同名：执行时会先腾位，不互相覆盖
    const originSurvives = x.names.some((n) => n.toLowerCase() === x.to.toLowerCase());
    const blockedByVacated = !originSurvives && vacated.has(x.to.toLowerCase());
    if (blockedByVacated) return false;
    return x.names.length > 1;
  });
}

/**
 * 批次执行计划：预演将产生的文件夹与文件（不落盘）
 * photos: [{ id, name, src }]
 */
export function planBatch({ photos, platformIds, note, root, date = new Date(), platforms = DEFAULT_PLATFORMS }) {
  const chosen = platforms.filter((p) => platformIds.includes(p.id) && p.enabled !== false);
  if (chosen.length === 0) throw new Error('未选择任何平台');
  if (!photos || photos.length === 0) throw new Error('未选择任何照片');
  if (!note || !String(note).trim()) throw new Error('备注必填');
  if (!root) throw new Error('未设置待发布目录');

  const folders = chosen.map((p) => ({
    platformId: p.id,
    platformName: p.name,
    folderName: makeBatchFolderName(date, p.name, note),
    count: photos.length
  }));

  // 改名计划：原片追加所选平台标记
  const renames = photos.map((ph) => computeRename(ph.name, platformIds, platforms));

  // 复制计划：复制的文件沿用「改名后」的名字，便于与原片对应
  const srcByName = new Map(photos.map((p) => [p.name, p.src || p.path]));
  const copies = [];
  for (const f of folders) {
    for (const r of renames) {
      const src = srcByName.get(r.from);
      if (!src) continue; // 没有来源路径的条目不入计划，避免执行期空指针
      copies.push({
        platformId: f.platformId,
        folderName: f.folderName,
        fileName: r.to,
        src
      });
    }
  }
  return {
    folders,
    renames,
    copies,
    note: String(note).trim(),
    clashes: findNameClashes(photos, platformIds, platforms)
  };
}

/**
 * 撤销计划：把一批改名回滚
 * historyEntry: { renames: [{from, to}] }
 */
export function planUndo(historyEntry) {
  const renames = (historyEntry?.renames || []).filter((r) => r.from !== r.to);
  return { renames: renames.map((r) => ({ from: r.to, to: r.from })) };
}

/** 校验快捷键表达式是否可用（单键或 ⌘/⇧/⌥/⌃ 组合） */
export function isValidShortcut(expr) {
  if (typeof expr !== 'string' || !expr.trim()) return false;
  const parts = expr.split('+').map((s) => s.trim());
  const mods = ['⌘', 'Cmd', 'Command', '⇧', 'Shift', '⌥', 'Alt', 'Option', '⌃', 'Ctrl', 'Control'];
  if (parts.length > 4) return false;
  const body = parts.filter((p) => !mods.includes(p));
  if (body.length !== 1) return false;
  const key = body[0];
  if (!key) return false;
  if (key.length === 1) return true;
  return ['Space', 'Enter', 'Escape', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Backspace', 'Delete'].includes(key);
}

/** 快捷键归一化：⌘→cmd 等，便于匹配键盘事件 */
export function normalizeShortcut(expr) {
  if (!expr) return null;
  const map = {
    '⌘': 'cmd', Cmd: 'cmd', Command: 'cmd', Meta: 'cmd',
    '⇧': 'shift', Shift: 'shift',
    '⌥': 'alt', Alt: 'alt', Option: 'alt',
    '⌃': 'ctrl', Ctrl: 'ctrl', Control: 'ctrl'
  };
  const parts = expr.split('+').map((s) => s.trim()).filter(Boolean);
  const out = { cmd: false, shift: false, alt: false, ctrl: false, key: null };
  for (const p of parts) {
    if (map[p]) out[map[p]] = true;
    else out.key = p;
  }
  return out.key ? out : null;
}

/**
 * 按键归一化：
 *  - Backspace / Delete 在部分键盘布局下 event.key 是「⌫」或「Delete」
 *  - 中文输入法或 Ctrl 组合下英文字母会变成控制字符，需要回落到 e.code
 * 保证「设置里录什么，运行时就能匹配到什么」。
 */
export function normalizeKeyName(rawKey, code) {
  if (rawKey === ' ') return 'Space';
  if (rawKey === '⌫' || rawKey === 'Backspace') return 'Backspace';
  if (rawKey === 'Del' || rawKey === 'ForwardDelete') return 'Delete';
  // 控制字符（Ctrl+A、输入法合成）→ 用物理键位还原字母
  if (rawKey && rawKey.length === 1 && rawKey.charCodeAt(0) < 32 && typeof code === 'string') {
    const m = /^Key([A-Z])$/.exec(code);
    if (m) return m[1];
    const d = /^Digit(\d)$/.exec(code);
    if (d) return d[1];
  }
  if (typeof rawKey === 'string' && rawKey.length === 1) return rawKey.toUpperCase();
  return rawKey;
}

/** 把键盘事件转换为 {cmd,shift,alt,ctrl,key}，与 normalizeShortcut 对比 */
export function eventToCombo(e) {
  return {
    cmd: !!e.metaKey,
    shift: !!e.shiftKey,
    alt: !!e.altKey,
    ctrl: !!e.ctrlKey,
    key: normalizeKeyName(e.key, e.code)
  };
}

export function matchShortcut(expr, e) {
  const norm = normalizeShortcut(expr);
  if (!norm) return false;
  const combo = eventToCombo(e);
  const a = { ...norm, key: norm.key.length === 1 ? norm.key.toUpperCase() : norm.key };
  if (a.cmd !== combo.cmd || a.alt !== combo.alt || a.ctrl !== combo.ctrl || a.key !== combo.key) return false;
  // Shift 只在快捷键本身声明了 Shift 时才要求按下；
  // 声明里没有 Shift 时，按住 Shift 也应命中（用于扩展选择等修饰用法）
  if (a.shift && !combo.shift) return false;
  return true;
}

/**
 * 校验平台配置，返回问题列表（供设置页即时提示）
 * 检查：emoji 重复、名称为空、快捷键重复、颜色缺失
 */
export function validatePlatforms(platforms) {
  const issues = [];
  const list = platforms || [];
  const emojiMap = new Map();
  const keyMap = new Map();
  if (list.length > 9) {
    issues.push({ index: 0, kind: 'count', msg: '平台数量最多 9 个（快捷数字键 1-9）' });
  }
  list.forEach((p, i) => {
    const name = String(p.name || '').trim();
    const emoji = String(p.emoji || '').trim();
    if (!name) issues.push({ index: i, kind: 'name', msg: '平台名称不能为空' });
    if (!emoji) issues.push({ index: i, kind: 'emoji', msg: '标记 emoji 不能为空' });
    // emoji 会写进文件名：禁止路径分隔符与非法字符
    if (emoji && MARK_SAFE_CHARS.test(emoji)) {
      MARK_SAFE_CHARS.lastIndex = 0;
      issues.push({ index: i, kind: 'emoji', msg: `标记「${emoji}」含文件名非法字符` });
    }
    // 文件名里的标记必须是短字符（emoji 或 1-3 个字符），否则极易误删正常文件名
    if (emoji && [...emoji].length > 4) {
      issues.push({ index: i, kind: 'emoji', msg: `标记「${emoji}」过长（最多 4 个字符）` });
    }
    const ekey = normalizeEmoji(emoji);
    if (emoji && emojiMap.has(ekey)) {
      issues.push({ index: i, kind: 'emoji', msg: `标记「${emoji}」与「${list[emojiMap.get(ekey)].name}」重复` });
    } else if (emoji) {
      emojiMap.set(ekey, i);
    }
    const sc = String(p.shortcut || '').trim();
    if (sc && keyMap.has(sc)) {
      issues.push({ index: i, kind: 'shortcut', msg: `快捷数字「${sc}」与「${list[keyMap.get(sc)].name}」重复` });
    } else if (sc) {
      keyMap.set(sc, i);
    }
  });
  return issues;
}

/** 默认快捷键（与主进程 DEFAULT_SHORTCUTS 保持一致，供设置页「恢复默认」使用） */
export const DEFAULT_SHORTCUTS = {
  next: 'ArrowRight',
  prev: 'ArrowLeft',
  rowNext: 'ArrowDown',
  rowPrev: 'ArrowUp',
  preview: 'Space',
  selectAll: '⌘+A',
  clearSelection: 'Escape',
  addToBatch: 'Enter',
  togglePlatform1: '1',
  togglePlatform2: '2',
  togglePlatform3: '3',
  openChecker: '⌘+L',
  openSettings: '⌘+,'
};

/** 平台配置是否有致命问题（有则不允许保存） */
export function hasFatalPlatformIssue(issues) {
  return (issues || []).some((x) => x.kind === 'name' || x.kind === 'emoji' || x.kind === 'count');
}

/** 生成默认的新平台对象（自动挑未占用的颜色与数字键） */
let platformSeq = 0;
export function makeNewPlatform(existing) {
  const list = existing || [];
  const usedEmoji = new Set(list.map((p) => p.emoji));
  const usedKey = new Set(list.map((p) => p.shortcut));
  const usedColor = new Set(list.map((p) => p.color));
  const emojiCandidates = ['🟣', '🟠', '🟡', '🟤', '⚫️', '⚪️', '🟥', '🟦'];
  const emoji = emojiCandidates.find((e) => !usedEmoji.has(e)) || '🟣';
  let key = '1';
  for (let i = 1; i <= 9; i += 1) {
    if (!usedKey.has(String(i))) { key = String(i); break; }
  }
  const color = PLATFORM_COLORS.find((c) => !usedColor.has(c)) || '#AF52DE';
  // id 必须唯一：同一毫秒内连续调用时，仅靠时间戳会撞
  platformSeq += 1;
  const id = `custom_${Date.now().toString(36)}_${platformSeq}_${Math.random().toString(36).slice(2, 6)}`;
  return {
    id,
    name: '新平台',
    emoji,
    color,
    shortcut: key,
    enabled: true
  };
}
