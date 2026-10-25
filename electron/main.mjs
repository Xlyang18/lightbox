import { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme, Menu } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  scanFolder, photosUnder, executeBatch, applyRenames, undoRenames,
  appendHistory, readHistory, ensureDir, isInside, statSafe
} from './fs-ops.mjs';
import {
  planBatch, analyzeCoverage, planUndo, DEFAULT_PLATFORMS, isImageFile, parseName,
  registerOrphanMarks, validatePlatforms, hasFatalPlatformIssue, PLATFORM_COLORS
} from '../src/lib/core.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DATA = path.join(os.homedir(), '.lightbox');
const SETTINGS_FILE = path.join(APP_DATA, 'settings.json');
const HISTORY_FILE = path.join(APP_DATA, 'history.jsonl');
const THUMB_DIR = path.join(APP_DATA, 'thumbnails');
const THUMB_MAX_FILES = 4000;      // 缓存文件数上限
const THUMB_MAX_AGE_MS = 60 * 24 * 3600 * 1000; // 60 天未访问即淘汰

let mainWindow = null;

/** ---------- 设置 ---------- */
const DEFAULT_SHORTCUTS = {
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

const DEFAULT_SETTINGS = {
  photoRoot: '',
  publishRoot: '',
  platforms: DEFAULT_PLATFORMS,
  knownMarks: DEFAULT_PLATFORMS.map((p) => p.emoji),
  shortcuts: DEFAULT_SHORTCUTS,
  columns: 4,
  inspectorOpen: true,
  sidebarOpen: true,
  theme: 'system',
  lastFolder: '',
  lastView: 'browse',
  gridGap: 'normal'
};

async function loadSettings() {
  try {
    const raw = await fs.readFile(SETTINGS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    const merged = {
      ...DEFAULT_SETTINGS,
      ...parsed,
      platforms: Array.isArray(parsed.platforms) && parsed.platforms.length ? parsed.platforms : DEFAULT_PLATFORMS,
      shortcuts: { ...DEFAULT_SHORTCUTS, ...(parsed.shortcuts || {}) }
    };
    // 已废弃标记：历史上用过、当前不在清单里的 emoji 仍要能被识别
    const known = new Set([...(merged.knownMarks || []), ...merged.platforms.map((p) => p.emoji)]);
    registerOrphanMarks([...known].filter((e) => !merged.platforms.some((p) => p.emoji === e)));
    return merged;
  } catch {
    registerOrphanMarks([]);
    return { ...DEFAULT_SETTINGS };
  }
}

async function saveSettings(patch) {
  const cur = await loadSettings();
  if (process.env.LIGHTBOX_TEST === '1') {
    console.log(`[settings:set] keys=${Object.keys(patch || {}).join(',')} columns=${patch?.columns} => ${cur.columns}->${({ ...cur, ...patch }).columns}`);
  }
  const next = { ...cur, ...patch };
  // 记录所有曾用过的标记，供后续识别「孤儿标记」
  const known = new Set([...(cur.knownMarks || []), ...(next.platforms || []).map((p) => p.emoji)]);
  next.knownMarks = [...known].filter(Boolean);
  await ensureDir(APP_DATA);
  await fs.writeFile(SETTINGS_FILE, JSON.stringify(next, null, 2), 'utf8');
  const orphans = next.knownMarks.filter((e) => !(next.platforms || []).some((p) => p.emoji === e));
  registerOrphanMarks(orphans);
  return next;
}

/** ---------- 缩略图 ---------- */
let thumbSwept = false;

async function sweepThumbs() {
  if (thumbSwept) return;
  thumbSwept = true;
  try {
    const names = await fs.readdir(THUMB_DIR);
    const stats = [];
    for (const n of names) {
      if (!n.endsWith('.jpg')) continue;
      const st = await statSafe(path.join(THUMB_DIR, n));
      if (st) stats.push({ n, atime: st.atimeMs, mtime: st.mtimeMs });
    }
    const now = Date.now();
    const stale = stats.filter((s) => now - Math.max(s.atime, s.mtime) > THUMB_MAX_AGE_MS);
    // 被淘汰的缩略图从缓存目录移除（不进垃圾桶，纯缓存可重建）
    for (const s of stale) {
      await fs.unlink(path.join(THUMB_DIR, s.n)).catch(() => {});
    }
    const keep = stale.length
      ? stats.filter((s) => !stale.includes(s))
      : stats;
    if (keep.length > THUMB_MAX_FILES) {
      keep.sort((a, b) => Math.max(a.atime, a.mtime) - Math.max(b.atime, b.mtime));
      const overflow = keep.slice(0, keep.length - THUMB_MAX_FILES);
      for (const s of overflow) {
        await fs.unlink(path.join(THUMB_DIR, s.n)).catch(() => {});
      }
    }
  } catch {
    /* 缓存清理失败不影响使用 */
  }
}

async function thumbFor(filePath) {
  const st = await statSafe(filePath);
  if (!st) return null;
  const hash = crypto.createHash('sha1')
    .update(filePath).update(String(st.size)).update(String(st.mtimeMs))
    .digest('hex');
  const out = path.join(THUMB_DIR, `${hash}.jpg`);
  if (fssync.existsSync(out)) {
    // 触碰 atime，参与 LRU 淘汰
    fs.utimes(out, new Date(), new Date()).catch(() => {});
    return out;
  }
  await ensureDir(THUMB_DIR);
  try {
    const { nativeImage } = await import('electron');
    const img = nativeImage.createThumbnailFromPath
      ? await nativeImage.createThumbnailFromPath(filePath, { width: 640, height: 640 })
      : nativeImage.createFromPath(filePath);
    if (img && !img.isEmpty()) {
      await fs.writeFile(out, img.toJPEG(85));
      return out;
    }
  } catch {
    /* 交给渲染层降级 */
  }
  return null;
}

/** ---------- 窗口 ---------- */
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1080,
    minHeight: 680,
    title: '光匣',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
    vibrancy: 'sidebar',
    visualEffectState: 'followWindow',
    backgroundColor: '#00000000',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true
    }
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });

  const devUrl = process.env.LIGHTBOX_DEV_URL;
  if (devUrl) mainWindow.loadURL(devUrl);
  else mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  return mainWindow;
}

/** ---------- IPC ---------- */
function registerIpc() {
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    name: app.getName(),
    platform: process.platform,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    dataDir: APP_DATA,
    isPackaged: app.isPackaged
  }));

  ipcMain.handle('settings:get', () => loadSettings());
  ipcMain.handle('settings:set', async (_e, patch) => {
    // 平台配置校验：致命问题（空名 / 空标记）拒绝保存
    if (patch && Array.isArray(patch.platforms)) {
      const issues = validatePlatforms(patch.platforms);
      if (hasFatalPlatformIssue(issues)) {
        throw new Error(issues.find((i) => i.kind === 'name' || i.kind === 'emoji').msg);
      }
      patch = {
        ...patch,
        platforms: patch.platforms.map((p) => ({
          ...p,
          color: PLATFORM_COLORS.includes(p.color) ? p.color : '#8E8E93'
        }))
      };
    }
    return saveSettings(patch);
  });
  ipcMain.handle('settings:reset', async () => {
    await ensureDir(APP_DATA);
    await fs.writeFile(SETTINGS_FILE, JSON.stringify(DEFAULT_SETTINGS, null, 2), 'utf8');
    registerOrphanMarks([]);
    return { ...DEFAULT_SETTINGS };
  });
  ipcMain.handle('settings:revealData', () => shell.openPath(APP_DATA));

  ipcMain.handle('dialog:choosePhotoRoot', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: '选择摄影集根目录',
      properties: ['openDirectory', 'createDirectory']
    });
    if (r.canceled || !r.filePaths[0]) return null;
    return r.filePaths[0];
  });

  ipcMain.handle('dialog:choosePublishRoot', async (_e, photoRoot) => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: '选择待发布目录',
      properties: ['openDirectory', 'createDirectory']
    });
    if (r.canceled || !r.filePaths[0]) return null;
    const picked = r.filePaths[0];
    const base = photoRoot || (await loadSettings()).photoRoot;
    if (base && isInside(base, picked)) {
      throw new Error('待发布目录不能位于摄影集内部，请重新选择');
    }
    return picked;
  });

  ipcMain.handle('scan:folder', async (_e, root) => {
    if (!root) throw new Error('未指定摄影集目录');
    const settings = await loadSettings();
    const exists = await statSafe(root);
    if (!exists || !exists.isDirectory()) throw new Error(`目录不存在或无法访问：${root}`);
    return scanFolder(root, settings.platforms);
  });

  ipcMain.handle('scan:subfolder', async (_e, { root, rel }) => {
    if (!root) throw new Error('未指定摄影集目录');
    const settings = await loadSettings();
    const data = await scanFolder(root, settings.platforms);
    return photosUnder(rel, data.tree);
  });

  ipcMain.handle('photo:thumb', async (_e, filePath) => {
    if (!filePath || !isImageFile(path.basename(filePath))) return null;
    return thumbFor(filePath);
  });

  ipcMain.handle('photo:readFile', async (_e, filePath) => {
    try {
      const st = await fs.stat(filePath);
      if (st.size > 60 * 1024 * 1024) return { tooLarge: true };
      const buf = await fs.readFile(filePath);
      const ext = path.extname(filePath).slice(1).toLowerCase();
      const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
        : ext === 'png' ? 'image/png'
        : ext === 'webp' ? 'image/webp'
        : ext === 'gif' ? 'image/gif'
        : ext === 'bmp' ? 'image/bmp'
        : ext === 'avif' ? 'image/avif'
        : ext === 'heic' || ext === 'heif' ? 'image/heic'
        : ext === 'tif' || ext === 'tiff' ? 'image/tiff'
        : 'application/octet-stream';
      return { dataUrl: `data:${mime};base64,${buf.toString('base64')}`, size: st.size };
    } catch (e) {
      return { error: e.message };
    }
  });

  ipcMain.handle('photo:exif', async (_e, filePath) => {
    try {
      const { nativeImage } = await import('electron');
      const img = nativeImage.createFromPath(filePath);
      const size = img.getSize();
      const st = await fs.stat(filePath);
      return {
        width: size.width,
        height: size.height,
        size: st.size,
        mtime: st.mtime.toISOString(),
        birthtime: st.birthtime.toISOString()
      };
    } catch {
      return null;
    }
  });

  ipcMain.handle('analyze:coverage', async (_e, { photos, platforms }) => {
    return analyzeCoverage(photos, platforms || (await loadSettings()).platforms);
  });

  ipcMain.handle('batch:plan', async (_e, payload) => {
    const settings = await loadSettings();
    if (!settings.publishRoot) return { error: '请先在设置中选择待发布目录' };
    if (settings.photoRoot && isInside(settings.photoRoot, settings.publishRoot)) {
      return { error: '待发布目录不能位于摄影集内部，请重新选择' };
    }
    try {
      return planBatch({ ...payload, root: settings.publishRoot, platforms: settings.platforms });
    } catch (e) {
      // 返回结构化结果而非抛错，避免渲染层显示 "Error invoking remote method"
      return { error: e.message };
    }
  });

  ipcMain.handle('batch:execute', async (_e, payload) => {
    const settings = await loadSettings();
    if (!settings.publishRoot) throw new Error('请先在设置中选择待发布目录');
    if (settings.photoRoot && isInside(settings.photoRoot, settings.publishRoot)) {
      throw new Error('待发布目录不能位于摄影集内部，请重新选择');
    }
    const plan = planBatch({ ...payload, root: settings.publishRoot, platforms: settings.platforms });
    const result = await executeBatch({
      plan, root: settings.publishRoot, photos: payload.photos, platforms: settings.platforms
    });

    const entry = {
      id: result.historyId,
      type: 'batch',
      at: new Date().toISOString(),
      note: plan.note,
      platforms: plan.folders.map((f) => ({ id: f.platformId, name: f.platformName, folder: f.folderName })),
      folders: result.folders,
      renames: result.renames,
      copies: result.copies.map((c) => ({ path: c.path, name: c.name, platformId: c.platformId })),
      errors: result.errors,
      photoCount: payload.photos.length
    };
    await appendHistory(HISTORY_FILE, entry);
    return { ...result, entry };
  });

  /**
   * 批量标记：一次 IPC 处理整组文件，避免渲染层逐张往返。
   * items: [{ path, name, nextIds }] —— nextIds 为该文件最终应有的平台集合
   */
  ipcMain.handle('mark:applyBatch', async (_e, { items }) => {
    const settings = await loadSettings();
    const renames = [];
    for (const it of items || []) {
      if (!it?.path || !it?.name || !Array.isArray(it.nextIds)) continue;
      const marks = settings.platforms
        .filter((p) => it.nextIds.includes(p.id) && p.emoji)
        .map((p) => p.emoji);
      const { base, ext } = parseName(it.name, settings.platforms);
      const nextName = ext ? `${base}${marks.join('')}.${ext}` : `${base}${marks.join('')}`;
      renames.push({ from: it.path, to: nextName });
    }
    const res = await applyRenames(renames);
    const entry = {
      id: crypto.randomUUID(),
      type: 'mark',
      at: new Date().toISOString(),
      renames: res.done,
      errors: res.errors
    };
    if (res.done.length) await appendHistory(HISTORY_FILE, entry);
    return { ...res, entry };
  });

  ipcMain.handle('history:list', () => readHistory(HISTORY_FILE, 200));

  ipcMain.handle('history:undo', async (_e, id) => {
    const items = await readHistory(HISTORY_FILE, 500);
    const entry = items.find((x) => x.id === id);
    if (!entry) throw new Error('找不到该条历史记录');
    if (entry.type === 'undo') throw new Error('撤销记录本身不能再次撤销');
    if (items.some((x) => x.type === 'undo' && x.targetId === id)) {
      throw new Error('该操作已经撤销过了');
    }
    if (!entry.renames || entry.renames.length === 0) throw new Error('该记录不含改名操作');

    // 预检：当前磁盘状态是否还符合可撤销条件
    const missing = entry.renames.filter((r) => !fssync.existsSync(r.to));
    const occupied = entry.renames.filter((r) => {
      const back = path.join(path.dirname(r.from), path.basename(r.from));
      return fssync.existsSync(back) && r.from !== r.to;
    });
    if (missing.length === entry.renames.length) {
      throw new Error('这些文件已不在原来的名字上，无法撤销');
    }

    const plan = planUndo(entry);
    const res = await undoRenames(plan.renames);
    const undoEntry = {
      id: crypto.randomUUID(),
      type: 'undo',
      at: new Date().toISOString(),
      targetId: id,
      renames: res.done,
      errors: [...(res.errors || []), ...occupied.map((r) => ({ from: r.from, to: r.to, error: '原文件名已被占用' }))],
      partial: res.done.length > 0 && res.done.length < entry.renames.length
    };
    if (res.done.length) await appendHistory(HISTORY_FILE, undoEntry);
    return { ...res, undoEntry, missingCount: missing.length };
  });

  ipcMain.handle('shell:reveal', (_e, p) => {
    if (!p) return false;
    if (fssync.existsSync(p)) shell.showItemInFolder(p);
    else {
      const dir = path.dirname(p);
      if (fssync.existsSync(dir)) shell.openPath(dir);
    }
    return true;
  });

  ipcMain.handle('shell:openPath', async (_e, p) => {
    if (!p) return false;
    const err = await shell.openPath(p);
    return !err;
  });

  ipcMain.handle('theme:set', (_e, mode) => {
    nativeTheme.themeSource = mode === 'dark' ? 'dark' : mode === 'light' ? 'light' : 'system';
    return nativeTheme.shouldUseDarkColors;
  });

  ipcMain.handle('theme:get', () => nativeTheme.shouldUseDarkColors);

  ipcMain.handle('thumb:sweep', async () => {
    await sweepThumbs();
    return true;
  });

  ipcMain.handle('thumb:clear', async () => {
    try {
      const names = await fs.readdir(THUMB_DIR);
      for (const n of names) {
        if (n.endsWith('.jpg')) await fs.unlink(path.join(THUMB_DIR, n)).catch(() => {});
      }
    } catch { /* 目录不存在即视为已清空 */ }
    thumbSwept = false;
    return true;
  });

  ipcMain.handle('app:openExternal', (_e, url) => {
    if (/^https?:\/\//.test(url)) return shell.openExternal(url);
    return false;
  });
}

/** ---------- 菜单 ---------- */
function buildMenu() {
  const send = (action) => () => mainWindow?.webContents.send('menu:action', action);
  const template = [
    {
      label: '光匣',
      submenu: [
        { role: 'about', label: '关于光匣' },
        { type: 'separator' },
        { label: '偏好设置…', accelerator: 'CmdOrCtrl+,', click: send('open-settings') },
        { type: 'separator' },
        { role: 'hide', label: '隐藏光匣' },
        { role: 'hideOthers', label: '隐藏其他' },
        { role: 'unhide', label: '显示全部' },
        { type: 'separator' },
        { role: 'quit', label: '退出光匣' }
      ]
    },
    {
      label: '文件',
      submenu: [
        { label: '打开摄影集…', accelerator: 'CmdOrCtrl+O', click: send('open-collection') },
        { label: '刷新摄影集', accelerator: 'CmdOrCtrl+R', click: send('refresh-collection') },
        { type: 'separator' },
        { label: '漏发检查', accelerator: 'CmdOrCtrl+L', click: send('open-checker') },
        { type: 'separator' },
        { role: 'close', label: '关闭窗口' }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' }
      ]
    },
    {
      label: '显示',
      submenu: [
        { label: '切换侧栏', accelerator: 'CmdOrCtrl+Alt+S', click: send('toggle-sidebar') },
        { label: '切换检查器', accelerator: 'CmdOrCtrl+Alt+I', click: send('toggle-inspector') },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '进入全屏幕' },
        { role: 'toggleDevTools', label: '开发者工具' }
      ]
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'zoom', label: '缩放' },
        { role: 'front', label: '前置全部窗口' }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(async () => {
  await ensureDir(APP_DATA);
  await ensureDir(THUMB_DIR);
  if (process.env.LIGHTBOX_TEST === '1' && process.env.LIGHTBOX_TEST_SETTINGS) {
    try {
      const preset = JSON.parse(process.env.LIGHTBOX_TEST_SETTINGS);
      const cur = await loadSettings();
      await saveSettings({ ...cur, ...preset });
    } catch (e) {
      console.warn('测试设置注入失败：', e.message);
    }
  }
  registerIpc();
  buildMenu();
  createWindow();
  // 后台整理缩略图缓存，不阻塞首屏
  setTimeout(() => { sweepThumbs().catch(() => {}); }, 4000);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
