import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { matchShortcut, parseName, marksToPlatformIds, DEFAULT_PLATFORMS } from './lib/core.mjs';
import path from './lib/path.mjs';
import { Sidebar, PhotoGrid, Inspector } from './components/Browser.jsx';
import { BatchModal, Lightbox, Toasts } from './components/Dialogs.jsx';
import { Checker } from './components/Checker.jsx';
import { Settings } from './components/Settings.jsx';

const api = window.lightbox;

/* 允许测试脚本在没有 Electron 的环境下注入 mock（见 scripts/make-preview） */
const A = api || window.lightboxMock;

/** 应用外观与动效偏好（模块级，避免闭包里重复定义） */
function applyTheme(s) {
  if (!s) return;
  if (s.theme && A?.theme?.set) A.theme.set(s.theme);
  document.documentElement.classList.toggle('reduce-motion', s.reduceMotion !== false);
}

/* 目录树节点与照片列表对齐（供 folder 级统计使用）——模块级，避免闭包引用问题 */
function hydrateTree(node, photos, byDir) {
  if (!node) return node;
  const map = byDir || groupByDir(photos);
  return {
    ...node,
    files: map.get(node.relPath) || [],
    children: (node.children || []).map((c) => hydrateTree(c, photos, map))
  };
}

/** relDir -> 照片数组（一次遍历，避免每个节点都过滤全量） */
function groupByDir(photos) {
  const map = new Map();
  for (const p of photos || []) {
    const k = p.relDir || '';
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(p);
  }
  return map;
}

export default function App() {
  const [settings, setSettings] = useState(null);
  const [collection, setCollection] = useState(null); // {root, rootName, tree, photos}
  const [loading, setLoading] = useState(true);
  const [currentRel, setCurrentRel] = useState('');
  const [selection, setSelection] = useState(() => new Set());
  const [focusedId, setFocusedId] = useState(null);
  const [query, setQuery] = useState('');
  const [view, setView] = useState('browse'); // browse | checker
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [lightboxId, setLightboxId] = useState(null);
  const [batchOpen, setBatchOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState('general'); // 菜单可直达「关于 / 更新日志」
  const [history, setHistory] = useState([]);
  const [homeDir, setHomeDir] = useState(''); // 仅用于界面显示时折叠路径，不落盘
  /** 键盘 / 菜单处理器用 ref 读取最新状态（声明必须位于任何赋值之前） */
  const kbLive = useRef({});
  const menuLive = useRef({});
  const [toasts, setToasts] = useState([]);
  const [error, setError] = useState(null);

  const toast = useCallback((text, kind = '') => {
    const id = Math.random().toString(36).slice(2);
    setToasts((t) => [...t, { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 2800);
  }, []);

  /* ---------- 初始化 ---------- */
  useEffect(() => {
    (async () => {
      try {
        const s = await A.settings.get();
        setSettings(s);
        setInspectorOpen(s.inspectorOpen !== false);
        setSidebarOpen(s.sidebarOpen !== false);
        if (s.lastView === 'checker') setView('checker');
        applyTheme(s);
        if (s.photoRoot) {
          await loadCollection(s.photoRoot, s.lastFolder || '');
        }
      } catch (e) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
      try { setHistory(await A.history.list()); } catch { /* ignore */ }
      try {
        const info = await A.app.info();
        if (info?.homeDir) setHomeDir(info.homeDir);
      } catch { /* 仅影响路径展示，失败可忽略 */ }
    })();
  }, []);

  /** rel 可以是 '' | '__all__' | '子/目录'；keepSelection=true 时保留选择与焦点（静默刷新用） */
  const loadCollection = useCallback(async (root, rel = '', opts = {}) => {
    if (!root) return null;
    const { silent = false, force = false, keepSelection = false } = opts;
    if (!silent) setLoading(true);
    setError(null);
    try {
      const data = await A.scan.folder(root, { force });
      const photos = (data.photos || []).map((p, i) => ({ ...p, id: p.path || `p${i}` }));
      const tree = hydrateTree(data.tree, photos);
      setCollection({ ...data, tree, photos });
      setCurrentRel(rel || '');
      if (!keepSelection) {
        setSelection(new Set());
        setFocusedId(null);
      }
      return { ...data, tree, photos };
    } catch (e) {
      setError(e.message.replace(/^Error: /, ''));
      return null;
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  /* ---------- 当前视图照片 ---------- */
  const viewPhotos = useMemo(() => {
    if (!collection) return [];
    let list;
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      list = collection.photos.filter((p) => p.name.toLowerCase().includes(q) || p.base.toLowerCase().includes(q));
    } else if (currentRel === '__all__' || currentRel === '') {
      // 根目录 = 全部照片（含所有子目录），符合「切到根节点看全片」的直觉
      list = collection.photos;
    } else {
      // 子目录：包含自身与所有下级
      const prefix = `${currentRel}/`;
      list = collection.photos.filter((p) => p.relDir === currentRel || p.relDir.startsWith(prefix));
    }
    return list;
  }, [collection, currentRel, query]);

  /**
   * 预览序列：起点在当前视图里就用视图（与网格同序），
   * 否则退回全集（例如从漏发检查跳进来时视图还没切过去）。
   */
  const currentList = useMemo(() => {
    if (!collection) return [];
    if (lightboxId && viewPhotos.some((p) => p.id === lightboxId)) return viewPhotos;
    if (lightboxId) return collection.photos;
    return viewPhotos;
  }, [collection, viewPhotos, lightboxId]);


  const selectedPhotos = useMemo(
    () => (collection ? collection.photos.filter((p) => selection.has(p.id)) : []),
    [collection, selection]
  );

  // 焦点照片：以最新 collection 为准解析 id（改名后 id/path 会同步更新）
  const resolvedFocus = useMemo(() => {
    if (!collection) return null;
    if (focusedId) {
      const byId = collection.photos.find((p) => p.id === focusedId);
      if (byId) return byId;
    }
    if (selection.size === 1) {
      const [only] = [...selection];
      const bySel = collection.photos.find((p) => p.id === only);
      if (bySel) return bySel;
    }
    return null;
  }, [collection, focusedId, selection]);

  /* ---------- 内置发布包（选中但未落盘的批次） ---------- */
  const [batchItems, setBatchItems] = useState([]); // photo ids 顺序表

  const addToBatch = (photos) => {
    setBatchItems((prev) => {
      const set = new Set(prev);
      photos.forEach((p) => set.add(p.id));
      return [...set];
    });
    toast(`已加入发布包（${photos.length} 张）`, 'success');
  };


  /* ---------- 标记切换 ---------- */
  const togglePlatform = useCallback(async (photos, platformId) => {
    if (!photos.length || !settings) return;
    // 逻辑：当前选中集合内的文件，若全都已含该平台 -> 全部取消；否则全部加上
    const allHave = photos.every((p) => p.platforms.includes(platformId));
    // 需要重新计算：对每个文件的最终平台集合
    const items = photos.map((p) => {
      const nextIds = allHave
        ? p.platforms.filter((x) => x !== platformId)
        : [...new Set([...p.platforms, platformId])];
      return { path: p.path, name: p.name, nextIds };
    });

    try {
      // 一次 IPC 处理整组：避免「一张一次往返」，选 100 张也只有一个来回
      const res = await A.mark.applyBatch(
        items.map((it) => ({ path: it.path, name: it.name, nextIds: it.nextIds }))
      );
      const skipped = res.skipped || [];
      const errs = res.errors || [];
      const pf = settings.platforms.find((p) => p.id === platformId);
      if (errs.length) {
        toast(`改名失败 ${errs.length} 个：${errs[0].error}`, 'error');
      } else if (skipped.length) {
        toast(`${allHave ? '取消' : '标记'}「${pf?.name}」· ${photos.length - skipped.length} 张（${skipped.length} 张因重名跳过）`, 'success');
      } else {
        toast(`${allHave ? '取消' : '标记'}「${pf?.name}」· ${photos.length} 张`, 'success');
      }

      // 只认「磁盘上真的改成功」的那些：跳过/报错的文件保持原状，
      // 否则界面会显示成已标记，而磁盘上并没有改（下一次打包才会露馅）。
      const failedPaths = new Set([...(res.skipped || []), ...(res.errors || [])].map((x) => x.from));
      const donePaths = new Set((res.done || []).map((x) => x.from));
      const paths = new Set([...donePaths]);
      // 先把结果算出来，再用同一份数据更新界面（避免 updater 内外数据不一致）
      const emojiOf = (ids) => settings.platforms.filter((p) => ids.includes(p.id)).map((p) => p.emoji).join('');
      const pathMap = new Map();
      const nameOf = new Map();
      const targetOf = new Map();
      const okItems = items.filter((it) => !failedPaths.has(it.path));
      for (const it of okItems) {
        const { base, ext } = parseName(it.name, settings.platforms);
        const nextName = `${base}${emojiOf(it.nextIds)}${ext ? `.${ext}` : ''}`;
        const nextPath = `${path.dirname(it.path)}/${nextName}`;
        nameOf.set(it.path, nextName);
        pathMap.set(it.path, nextPath);
        targetOf.set(it.path, it.nextIds);
      }

      setCollection((c) => {
        if (!c) return c;
        const photos2 = c.photos.map((p) => {
          if (!paths.has(p.path)) return p;
          const nextPath = pathMap.get(p.path);
          const nextIds = targetOf.get(p.path);
          return {
            ...p,
            id: nextPath,
            name: nameOf.get(p.path),
            path: nextPath,
            platforms: nextIds,
            marks: settings.platforms.filter((x) => nextIds.includes(x.id)).map((x) => x.emoji)
          };
        });
        return { ...c, photos: photos2, tree: hydrateTree(c.tree, photos2) };
      });
      // 改名后必须刷新缩略图键（path 变了，缓存键也随之变化）
      // 选中集合与焦点以新路径为准
      if (pathMap.size) {
        setSelection((prev) => {
          const next = new Set();
          for (const id of prev) next.add(pathMap.get(id) || id);
          return next;
        });
        setFocusedId((prev) => (prev ? (pathMap.get(prev) || prev) : prev));
      }
      setHistory(await A.history.list());
    } catch (e) {
      toast(e.message.replace(/^Error: /, ''), 'error');
    }
  }, [settings, toast]);

  // 延迟绑定完成（此处 togglePlatform 已初始化，避免 TDZ 白屏）
  kbLive.current = {
    settings, viewPhotos, focusedId, selectedPhotos, resolvedFocus, batchOpen, settingsOpen,
    lightboxId, query, togglePlatform, addToBatch
  };

  /**
   * 把 rename 结果映射到渲染层状态。
   * res.renamesChanged 只包含磁盘上真的改了名的条目 —— 界面跟着它走，
   * 才不会出现「显示已改名、实际没改」或「改名失败后卡片指向不存在的文件」。
   */
  const applyRenameResult = (res) => {
    const changes = res?.renamesChanged || [];
    if (!changes.length) return;
    const map = new Map(changes.map((c) => [c.from, c.to]));
    const nextPathOf = (p) => map.get(p) || p;
    setCollection((c) => {
      if (!c) return c;
      const photos2 = c.photos.map((p) => {
        const np = map.get(p.path);
        if (!np) return p;
        return { ...p, id: np, path: np, name: path.basename(np) };
      });
      return { ...c, photos: photos2, tree: hydrateTree(c.tree, photos2) };
    });
    setSelection((prev) => {
      const next = new Set();
      for (const id of prev) next.add(nextPathOf(id));
      return next;
    });
    setFocusedId((prev) => (prev ? nextPathOf(prev) : prev));
    setLightboxId((prev) => (prev ? nextPathOf(prev) : prev));
    setBatchItems((prev) => prev.map(nextPathOf));
  };

  /* ---------- 打包执行 ---------- */
  const executeBatch = async (payload) => {
    try {
      const res = await A.batch.execute(payload);
      if (res.errors?.length) {
        toast(`完成，但有 ${res.errors.length} 条错误（${res.errors[0].error}）`, 'error');
      } else {
        toast(`已打包 ${res.folders.length} 个文件夹 · ${res.copies.length} 份副本 · 改名 ${res.renames.length} 个`, 'success');
      }
      // 以磁盘真实结果为准更新内存：成功改名的换到新路径；被跳过/回滚的保持原样。
      // 这一步先做，即便随后的重扫失败，界面也不会指向已不存在的文件。
      applyRenameResult(res);
      // 刷新集合（文件名变了）：强制重扫并保留选择，避免视口跳到顶部
      await loadCollection(collection.root, currentRel === '__all__' ? '' : currentRel,
        { silent: true, force: true, keepSelection: true });
      setBatchItems([]);
      setHistory(await A.history.list());
      return res;
    } catch (e) {
      toast(e.message.replace(/^Error: /, ''), 'error');
      throw e;
    }
  };

  const undoHistory = async (id) => {
    try {
      const res = await A.history.undo(id);
      const failed = (res.errors || []).length;
      toast(failed
        ? `已撤销 ${res.done.length} 个改名，${failed} 个未能回滚（原文件名被占用或文件已移动）`
        : `已撤销 ${res.done.length} 个改名`, failed ? 'error' : 'success');
      // 撤销成功后同样按磁盘结果同步界面（撤销 = 由新名改回旧名）
      applyRenameResult({ renamesChanged: (res.done || []).map((d) => ({ from: d.to, to: d.from })) });
      await loadCollection(collection.root, currentRel === '__all__' ? '' : currentRel,
        { silent: true, force: true, keepSelection: true });
      setHistory(await A.history.list());
    } catch (e) {
      toast(e.message.replace(/^Error: /, ''), 'error');
    }
  };

  /* ---------- 键盘 ---------- */

  /**
   * 键盘处理器：用 ref 拿到最新状态，这样监听器只挂一次，不会每次选片都重建。
   * kbLive.current 的赋值放在 togglePlatform 定义之后（避免 TDZ）。
   */

  useEffect(() => {
    const onKey = (e) => {
      const S = kbLive.current;
      if (!S.settings || S.batchOpen || S.settingsOpen || S.lightboxId) return;
      const tag = (e.target?.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea') return;
      const settings = S.settings;
      const viewPhotos = S.viewPhotos || [];
      const focusedId = S.focusedId;
      const selectedPhotos = S.selectedPhotos || [];
      const resolvedFocus = S.resolvedFocus;
      const togglePlatform = S.togglePlatform;
      const addToBatch = S.addToBatch;
      const sc = settings.shortcuts || {};

      // 起点：优先焦点，其次唯一选中项（鼠标点选后即使焦点未同步也能继续用方向键）
      let idx = viewPhotos.findIndex((p) => p.id === focusedId);
      if (idx < 0 && selectedPhotos.length === 1) idx = viewPhotos.findIndex((p) => p.id === selectedPhotos[0].id);
      const move = (delta, extendSelection) => {
        if (viewPhotos.length === 0) return;
        // 完全无起点时（既没焦点也没单选），第一次按方向键直接落到第一张，
        // 而不是「第一张 + delta」跳到第二张
        const nextIdx = idx < 0
          ? 0
          : Math.max(0, Math.min(viewPhotos.length - 1, idx + delta));
        const target = viewPhotos[nextIdx];
        setFocusedId(target.id);
        if (extendSelection) {
          setSelection((prev) => {
            const next = new Set(prev);
            if (idx >= 0) {
              const a = Math.min(idx, nextIdx);
              const b = Math.max(idx, nextIdx);
              for (let i = a; i <= b; i += 1) next.add(viewPhotos[i].id);
            } else next.add(target.id);
            return next;
          });
        } else {
          setSelection(new Set([target.id]));
        }
        requestAnimationFrame(() => {
          document.querySelector(`[data-photo-id="${CSS.escape(target.id)}"]`)?.scrollIntoView({ block: 'nearest' });
        });
      };

      if (matchShortcut(sc.next, e)) { e.preventDefault(); move(1, e.shiftKey); return; }
      if (matchShortcut(sc.prev, e)) { e.preventDefault(); move(-1, e.shiftKey); return; }
      if (matchShortcut(sc.rowNext, e)) { e.preventDefault(); move(settings.columns || 4, e.shiftKey); return; }
      if (matchShortcut(sc.rowPrev, e)) { e.preventDefault(); move(-(settings.columns || 4), e.shiftKey); return; }
      if (matchShortcut(sc.preview, e)) {
        e.preventDefault();
        const target = resolvedFocus || selectedPhotos[0] || viewPhotos[0];
        if (target) setLightboxId(target.id);
        return;
      }
      if (matchShortcut(sc.selectAll, e)) {
        e.preventDefault();
        setSelection(new Set(viewPhotos.map((p) => p.id)));
        return;
      }
      if (matchShortcut(sc.clearSelection, e)) {
        e.preventDefault();
        // Esc 分层：有搜索结果时先退出搜索，再按一次才清空选择
        if (S.query) { setQuery(''); return; }
        setSelection(new Set());
        return;
      }
      if (matchShortcut(sc.addToBatch, e)) {
        e.preventDefault();
        if (selectedPhotos.length) addToBatch(selectedPhotos);
        return;
      }
      // 平台快捷键（可在设置里改，但默认数字键）
      const active = settings.platforms.filter((p) => p.enabled !== false);
      const pfKeys = [
        ['togglePlatform1', active[0]?.id],
        ['togglePlatform2', active[1]?.id],
        ['togglePlatform3', active[2]?.id]
      ];
      // 数字键兜底：平台自带的 shortcut（与快捷键设置在未同步时仍可用）
      const direct = settings.platforms.find((p) => p.enabled !== false
        && String(p.shortcut) === e.key && !e.metaKey && !e.ctrlKey && !e.altKey);
      const targets = selectedPhotos.length ? selectedPhotos : (resolvedFocus ? [resolvedFocus] : []);
      // 先命中「快捷键设置」，再兜底「平台自带键」；只执行第一个命中项，
      // 避免快捷键冲突（例如把小红的键改成 2）导致一次按键给同一平台打两次标。
      let hitPid = null;
      for (const [key, pid] of pfKeys) {
        if (pid && matchShortcut(sc[key], e)) { hitPid = pid; break; }
      }
      if (!hitPid && direct) hitPid = direct.id;
      if (hitPid) {
        e.preventDefault();
        if (targets.length) togglePlatform(targets, hitPid);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /* 菜单事件：用 ref 读取最新上下文，监听只挂一次 */
  // 注意：switchView / openCollection 定义在本 effect 之后，不能在此处求值（会造成 TDZ 白屏）。
  // 它们的引用在各自定义处写入；这里只放已就绪的值。
  menuLive.current = { ...menuLive.current, collection, currentRel, loadCollection, toast };
  useEffect(() => {
    if (!A.menu?.onAction) return undefined;
    return A.menu.onAction((action) => {
      const M = menuLive.current;
      if (action === 'open-settings') { setSettingsTab('general'); setSettingsOpen(true); }
      else if (action === 'open-about') { setSettingsTab('about'); setSettingsOpen(true); }
      else if (action === 'open-changelog') { setSettingsTab('changelog'); setSettingsOpen(true); }
      else if (action === 'open-checker') M.switchView('checker');
      else if (action === 'open-collection') M.openCollection?.();
      else if (action === 'refresh-collection') {
        if (M.collection?.root) {
          M.loadCollection(M.collection.root, M.currentRel === '__all__' ? '' : M.currentRel, { force: true });
          M.toast('已重新扫描摄影集', 'success');
        }
      } else if (action === 'toggle-sidebar') setSidebarOpen((v) => !v);
      else if (action === 'toggle-inspector') setInspectorOpen((v) => !v);
    });
  }, []);

  /* ---------- 动作 ---------- */
  const openCollection = async () => {
    const root = await A.dialog.choosePhotoRoot();
    if (!root) return;
    const s = await A.settings.set({ photoRoot: root, lastFolder: '' });
    setSettings(s);
    await loadCollection(root, '', { force: true });
  };
  // 供菜单事件调用（避免菜单闭包拿到旧函数）
  menuLive.current.openCollection = openCollection;

  /** 切换主视图，并记住偏好（只 patch 单字段，绝不用旧快照整块写回） */
  const switchView = useCallback((next) => {
    setView(next);
    A.settings.set({ lastView: next }).catch(() => {});
  }, []);
  menuLive.current.switchView = switchView;

  /** 面板显隐一并持久化，下次启动恢复原样 */
  const toggleSidebar = () => {
    setSidebarOpen((v) => {
      const next = !v;
      A.settings.set({ sidebarOpen: next }).catch(() => {});
      return next;
    });
  };
  const toggleInspector = () => {
    setInspectorOpen((v) => {
      const next = !v;
      A.settings.set({ inspectorOpen: next }).catch(() => {});
      return next;
    });
  };

  const saveSettings = async (draft) => {
    // 以磁盘上的最新配置为基线合并草稿，防止弹窗打开期间外部改动（列数、面板开关）被冲掉
    const s = await A.settings.set(draft);
    setSettings(s);
    setInspectorOpen(s.inspectorOpen !== false);
    setSidebarOpen(s.sidebarOpen !== false);
    applyTheme(s);
    const changedRoot = s.photoRoot && s.photoRoot !== collection?.root;
    if (changedRoot) {
      const ok = await loadCollection(s.photoRoot, s.lastFolder || '');
      if (!ok) {
        toast('设置已保存，但摄影集目录无法读取', 'error');
        return;
      }
    }
    toast('设置已保存', 'success');
  };

  /**
   * 切目录只改前端视图（数据已在内存里），不再触发整盘重扫。
   * 持久化走串行队列，避免和「列数 / 面板开关」等写入互相覆盖。
   */
  const selectFolder = useCallback((rel) => {
    setCurrentRel(rel);
    setSelection(new Set());
    setFocusedId(null);
    A.settings.set({ lastFolder: rel }).catch(() => {});
  }, []);

  const jumpToPhoto = (photo) => {
    setQuery('');
    // 找到该照片所在的文件夹层级：直接用「全部照片」视图定位
    setCurrentRel('__all__');
    setView('browse');
    setSelection(new Set([photo.id]));
    setFocusedId(photo.id);
    requestAnimationFrame(() => {
      setTimeout(() => {
        document.querySelector(`[data-photo-id="${CSS.escape(photo.id)}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }, 120);
    });
  };

  /* ---------- 渲染 ---------- */
  if (!A) {
    return <div style={{ padding: 40 }}>未检测到 Electron 环境</div>;
  }

  const platforms = settings?.platforms || DEFAULT_PLATFORMS;
  const selCount = selection.size;
  const batchPhotos = collection ? collection.photos.filter((p) => batchItems.includes(p.id)) : [];

  return (
    <div className="app-shell">
      {/* 顶栏 */}
      <header className="toolbar">
        <span className="brand">光匣<small>Lightbox</small></span>
        <button className="tb-btn ghost" onClick={openCollection} data-testid="btn-open-collection">
          📁 {collection ? collection.rootName : '打开摄影集'}
        </button>
        <button
          className={`tb-btn ${sidebarOpen ? 'active' : ''}`}
          onClick={toggleSidebar}
          title="显示/隐藏侧栏（⌘⌥S）"
          data-testid="btn-toggle-sidebar"
        >
          ▤
        </button>
        <div className="search-field">
          <span style={{ color: 'var(--text-tertiary)', fontSize: 11 }}>🔍</span>
          <input
            placeholder="搜索文件名…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            data-testid="search"
          />
          {query && <button className="icon-btn" onClick={() => setQuery('')} style={{ width: 16, height: 16 }}>✕</button>}
        </div>
        <div className="spacer" />
        <div className="segmented">
          <button className={view === 'browse' ? 'on' : ''} onClick={() => switchView('browse')} data-testid="tab-browse">浏览</button>
          <button className={view === 'checker' ? 'on' : ''} onClick={() => switchView('checker')} data-testid="tab-checker">漏发检查</button>
        </div>
        <button
          className={`tb-btn ${inspectorOpen ? 'active' : ''}`}
          onClick={toggleInspector}
          title="显示/隐藏检查器（⌘⌥I）"
          data-testid="btn-toggle-inspector"
        >◫</button>
        <button className="tb-btn" onClick={() => { setSettingsTab('general'); setSettingsOpen(true); }} data-testid="btn-settings" title="设置（⌘,）">⚙︎</button>
      </header>

      <div className="body-row">
        {view === 'browse' && collection && (
          <>
            <div style={{ display: 'flex', minHeight: 0 }}>
              <Sidebar tree={collection.tree} currentRel={currentRel} onSelect={selectFolder} collapsed={!sidebarOpen} />
              <div className="main-pane">
                <div className="pane-head">
                  <strong>
                    {query ? `搜索结果「${query}」` : currentRel === '__all__' ? '全部照片' : currentRel || collection.rootName}
                  </strong>
                  <span>{viewPhotos.length} 张</span>
                  <div style={{ flex: 1 }} />
                  <div className="segmented">
                    {[3, 4, 5, 6].map((n) => (
                      <button key={n} className={(settings?.columns || 4) === n ? 'on' : ''} onClick={async () => {
                        const s = await A.settings.set({ columns: n });
                        setSettings(s);
                      }}>{n}</button>
                    ))}
                  </div>
                  <button className="tb-btn" onClick={() => selectFolder('__all__')} title="查看全部照片">全部</button>
                </div>
                <PhotoGrid
                  photos={viewPhotos}
                  selection={selection}
                  focusedId={focusedId}
                  columns={settings?.columns || 4}
                  platforms={platforms}
                  loading={loading}
                  onSelectionChange={setSelection}
                  onFocusChange={setFocusedId}
                  onQuickToggle={(photoPath, pid) => {
                    // 用最新数据解析，防止卡片闭包里持有改名前的旧状态
                    const fresh = collection.photos.find((x) => x.path === photoPath)
                      || collection.photos.find((x) => x.id === photoPath);
                    if (fresh) togglePlatform([fresh], pid);
                  }}
                  onOpenPreview={(id) => setLightboxId(id)}
                />
              </div>
              <Inspector
                photo={resolvedFocus}
                platforms={platforms}
                selectionCount={selCount}
                selectedPhotos={selectedPhotos}
                collapsed={!inspectorOpen}
                onCollapse={() => setInspectorOpen(false)}
                onTogglePlatform={(ph, pid) => togglePlatform(ph, pid)}
                onAddToBatch={addToBatch}
                onOpenPreview={(id) => setLightboxId(id)}
                onReveal={(p) => A.shell.reveal(p)}
              />
            </div>
          </>
        )}

        {view === 'browse' && !collection && (
          <div className="main-pane">
            <div className="empty-state">
              <div className="glyph">🗃</div>
              <h2>还没有打开摄影集</h2>
              <p>
                选择一个存放照片的根目录（可以有任意多级子文件夹），光匣会扫描其中的 jpg / png / heic 等图片，
                按目录树浏览、批量标记、打包归档。
              </p>
              <div style={{ display: 'flex', gap: 10 }}>
                <button className="btn primary" onClick={openCollection} data-testid="empty-open">选择摄影集目录</button>
                <button className="btn plain" onClick={() => { setSettingsTab('general'); setSettingsOpen(true); }}>先设置待发布目录</button>
              </div>
            </div>
          </div>
        )}

        {view === 'checker' && (
          collection ? (
            <Checker
              key="checker"
              photos={collection.photos}
              platforms={platforms}
              tree={collection.tree}
              history={history}
              onJumpToPhoto={jumpToPhoto}
              onOpenFolder={(rel) => { setCurrentRel(rel === '根目录' ? '' : rel); setView('browse'); }}
              onUndo={undoHistory}
            />
          ) : (
            <div className="main-pane">
              <div className="empty-state">
                <div className="glyph">🔍</div>
                <h2>先打开一个摄影集</h2>
                <p>漏发检查需要扫描照片后才能统计。</p>
                <button className="btn primary" onClick={openCollection}>选择摄影集目录</button>
              </div>
            </div>
          )
        )}
      </div>

      {/* 底栏 */}
      {view === 'browse' && collection && (
        <footer className="bottom-bar">
          <span className="stat">已选 <b>{selCount}</b> 张</span>
          {platforms.filter((p) => p.enabled !== false).map((p) => {
            const n = selectedPhotos.filter((x) => x.platforms.includes(p.id)).length;
            return (
              <span className="stat" key={p.id}>
                <span className="mark-dot sm" style={{ background: p.color }} />
                {p.name} <b>{n}</b>
              </span>
            );
          })}
          {batchItems.length > 0 && (
            <span className="stat" style={{ color: 'var(--accent)' }}>📦 发布包 <b>{batchItems.length}</b> 张</span>
          )}
          <div className="spacer" />
          <button
            className="tb-btn"
            onClick={() => setSelection(new Set(viewPhotos.map((p) => p.id)))}
            title="全选（⌘A）"
          >
            全选
          </button>
          <button
            className="tb-btn"
            disabled={selCount === 0}
            onClick={() => setSelection(new Set())}
          >
            清空
          </button>
          <button
            className="tb-btn primary"
            disabled={selCount === 0}
            onClick={() => setBatchOpen(true)}
            data-testid="btn-batch"
          >
            📦 打包发布{selCount > 0 ? `（${selCount}）` : ''}
          </button>
        </footer>
      )}

      {lightboxId && collection && (
        <Lightbox
          list={currentList}
          photos={collection.photos}
          startId={lightboxId}
          platforms={platforms}
          shortcuts={settings?.shortcuts}
          onClose={() => setLightboxId(null)}
          onTogglePlatform={(ph, pid) => togglePlatform(ph, pid)}
        />
      )}

      {batchOpen && (
        <BatchModal
          photos={selectedPhotos}
          platforms={platforms}
          publishRoot={settings?.publishRoot}
          onClose={() => setBatchOpen(false)}
          onExecute={executeBatch}
        />
      )}

      {settingsOpen && (
        <Settings
          key={`settings-${settingsTab}`}
          settings={settings}
          history={history}
          onUndo={undoHistory}
          onSave={saveSettings}
          initialTab={settingsTab}
          homeDir={homeDir}
          onClose={() => { setSettingsOpen(false); setSettingsTab('general'); }}
        />
      )}

      <Toasts items={toasts} />

      {error && (
        <div className="toast-wrap" style={{ bottom: 20 }}>
          <div className="toast error">⚠︎ {error}</div>
        </div>
      )}
    </div>
  );
}
