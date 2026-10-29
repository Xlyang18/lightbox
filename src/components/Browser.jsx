import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';


const api = window.lightbox;

/* ---------------- 缩略图组件（缓存 + 并发限流 + 改名复用） ---------------- */

/**
 * 缓存键：路径去掉「平台标记」部分。
 * 这样照片改名（加/减 🔴🟢🔵）后缩略图直接命中旧缓存，不用重新生成。
 */
const MARK_STRIP = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu;
function thumbKey(path) {
  if (!path) return '';
  const i = path.lastIndexOf('/');
  const dir = i >= 0 ? path.slice(0, i) : '';
  let name = i >= 0 ? path.slice(i + 1) : path;
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot) : '';
  const stem = dot > 0 ? name.slice(0, dot) : name;
  return `${dir}/${stem.replace(MARK_STRIP, '')}${ext}`;
}

const thumbCache = new Map();   // key -> url
const thumbInflight = new Map(); // key -> Promise
const MAX_CONCURRENT = 4;
let running = 0;
const queue = [];

function withSlot(fn) {
  return new Promise((resolve, reject) => {
    const start = () => {
      running += 1;
      fn().then(resolve, reject).finally(() => {
        running -= 1;
        const next = queue.shift();
        if (next) next();
      });
    };
    if (running < MAX_CONCURRENT) start();
    else queue.push(start);
  });
}

async function loadThumb(path) {
  const key = thumbKey(path);
  if (thumbCache.has(key)) return thumbCache.get(key);
  if (thumbInflight.has(key)) return thumbInflight.get(key);
  const job = withSlot(async () => {
    const p = await api.photo.thumb(path);
    if (p) {
      const url = `file://${encodeURI(p).replace(/#/g, '%23')}`;
      thumbCache.set(key, url);
      return url;
    }
    // 降级：直接读原文件
    const r = await api.photo.readFile(path);
    if (r?.dataUrl) {
      thumbCache.set(key, r.dataUrl);
      return r.dataUrl;
    }
    return null;
  }).finally(() => thumbInflight.delete(key));
  thumbInflight.set(key, job);
  return job;
}

const ORIGINAL_URL = (p) => `file://${encodeURI(p).replace(/#/g, '%23')}`;

export function Thumb({ path, alt, className }) {
  const [src, setSrc] = useState(() => thumbCache.get(thumbKey(path)) || null);
  // 缩略图还在排队/生成时，先直接显示原图（浏览器自带缩放），避免大图库长时间只看到占位点
  const [eager, setEager] = useState(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!path) { setEager(null); return undefined; }
    if (thumbCache.has(thumbKey(path))) { setEager(null); return undefined; }
    // 延迟 160ms 才插原图：命中缓存快的图不会闪一下原图，大图也不会白等
    const t = setTimeout(() => setEager(ORIGINAL_URL(path)), 160);
    return () => clearTimeout(t);
  }, [path]);

  useEffect(() => {
    let alive = true;
    const cached = thumbCache.get(thumbKey(path));
    if (cached) {
      setSrc(cached);
      setFailed(false);
      return () => { alive = false; };
    }
    setSrc(null);
    setFailed(false);
    loadThumb(path).then((url) => {
      if (!alive) return;
      if (url) setSrc(url);
      else setFailed(true);
    }).catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [path]);

  if (failed) {
    return (
      <div className={className}>
        <span className="placeholder">🖼</span>
      </div>
    );
  }
  const shown = src || eager;
  return (
    <div className={`${className} ${src ? 'is-ready' : ''}`}>
      {shown
        ? <img src={shown} alt={alt || ''} draggable={false} loading="lazy" decoding="async" />
        : <span className="placeholder" style={{ opacity: 0.25 }}>·</span>}
    </div>
  );
}

/* ---------------- 照片卡片 ---------------- */
/**
 * 网格可能一次渲染上千张卡片，单张卡片只在自身状态变化时才重绘。
 * 注意：回调必须来自上层 useCallback，否则 memo 失效（这里已保证）。
 */
export const PhotoCard = React.memo(function PhotoCard({
  photo, selected, focused, platforms, onClick, onQuickToggle, onOpenPreview
}) {
  return (
    <div
      className={`photo-card ${selected ? 'selected' : ''} ${focused ? 'focused' : ''}`}
      data-photo-id={photo.id}
      onClick={(e) => onClick(e, photo)}
      onDoubleClick={() => onOpenPreview?.(photo.id)}
      title={photo.name}
      tabIndex={-1}
      role="option"
      aria-selected={selected}
    >
      <Thumb path={photo.path} alt={photo.name} className="card-thumb" />
      <div className="card-check">✓</div>
      <div className="card-marks">
        {photo.platforms.map((id) => {
          const p = platforms.find((x) => x.id === id);
          if (!p) return null;
          return <span key={id} className="mark-dot" style={{ background: p.color }} title={p.name} />;
        })}
      </div>
      {onQuickToggle && (
        <div className="card-quick">
          {platforms.filter((p) => p.enabled !== false).map((p) => (
            <button
              key={p.id}
              className={`quick-btn ${photo.platforms.includes(p.id) ? 'on' : ''}`}
              style={photo.platforms.includes(p.id) ? { background: p.color } : undefined}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                // 传路径而非对象：上层按最新 collection 重新解析，避免拿到改名前的旧对象
                onQuickToggle(photo.path, p.id);
              }}
              title={`${photo.platforms.includes(p.id) ? '取消' : '标记'} ${p.name}（${p.shortcut}）`}
            >
              {p.shortcut}
            </button>
          ))}
        </div>
      )}
      <div className="card-caption">
        {/* 文件名只显示基础名 + 扩展名，标记交给右侧色点表达，避免 emoji 与点状标记重复堆叠 */}
        <span className="fname" title={photo.name}>
          {photo.base}
          <span className="fname-ext">{photo.ext ? `.${photo.ext}` : ''}</span>
        </span>
        <span className="cap-marks" title={photo.platforms
          .map((id) => platforms.find((p) => p.id === id)?.name)
          .filter(Boolean).join(' · ') || '未发布'}
        >
          {photo.platforms.length > 0
            ? platforms.filter((p) => photo.platforms.includes(p.id)).map((p) => (
              <span key={p.id} className="mark-dot sm" style={{ background: p.color }} />
            ))
            : <span className="unpublished">未发</span>}
        </span>
      </div>
    </div>
  );
});

/* ---------------- 文件夹树 ---------------- */
function TreeNode({ node, depth, currentRel, expanded, onToggle, onSelect }) {
  const isOpen = expanded.has(node.relPath);
  const hasChildren = node.children && node.children.length > 0;
  return (
    <div>
      <div
        className={`tree-node ${currentRel === node.relPath ? 'selected' : ''}`}
        style={{ paddingLeft: 6 + depth * 13 }}
        onClick={() => onSelect(node.relPath)}
        onDoubleClick={() => hasChildren && onToggle(node.relPath)}
        title={node.relPath || node.name}
      >
        <span
          className={`caret ${isOpen ? 'open' : ''}`}
          style={{ visibility: hasChildren ? 'visible' : 'hidden' }}
          onClick={(e) => { e.stopPropagation(); onToggle(node.relPath); }}
        >
          ▶
        </span>
        <span className="node-name">{depth === 0 ? `📁 ${node.name}` : node.name}</span>
        <span className="node-count">{node.count}</span>
      </div>
      {isOpen && hasChildren && node.children.map((c) => (
        <TreeNode
          key={c.relPath}
          node={c}
          depth={depth + 1}
          currentRel={currentRel}
          expanded={expanded}
          onToggle={onToggle}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

export function Sidebar({ tree, currentRel, onSelect, collapsed }) {
  // 首次进入默认展开根节点与它的第一层子目录：多级目录一眼可见，不用先点开再找
  const [expanded, setExpanded] = useState(() => new Set(['']));
  useEffect(() => {
    if (!tree?.children?.length) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      next.add('');
      for (const c of tree.children) next.add(c.relPath);
      return next;
    });
  }, [tree?.relPath, tree?.children?.length]);
  const toggle = useCallback((rel) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(rel)) next.delete(rel);
      else next.add(rel);
      return next;
    });
  }, []);
  useEffect(() => {
    // 自动展开当前目录的祖先链
    if (!currentRel) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      next.add('');
      const segs = currentRel.split('/');
      let acc = '';
      for (const s of segs) {
        acc = acc ? `${acc}/${s}` : s;
        next.add(acc);
      }
      return next;
    });
  }, [currentRel]);

  if (collapsed) return null;
  return (
    <aside className="sidebar">
      <div className="side-header">
        <span>摄影集</span>
        <span style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 400 }}>{tree?.count ?? 0} 张</span>
      </div>
      <div className="tree">
        {tree && (
          <TreeNode
            node={tree}
            depth={0}
            currentRel={currentRel}
            expanded={expanded}
            onToggle={toggle}
            onSelect={onSelect}
          />
        )}
      </div>
    </aside>
  );
}

/* ---------------- 照片网格（含框选、Shift 连选） ---------------- */
export function PhotoGrid({
  photos, selection, focusedId, columns, platforms,
  onSelectionChange, onFocusChange, onQuickToggle, onOpenPreview, loading
}) {
  const wrapRef = useRef(null);
  const [marquee, setMarquee] = useState(null);
  const lastClickIdx = useRef(null);
  const dragState = useRef(null);

  const gridStyle = useMemo(() => ({
    gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`
  }), [columns]);

  // 用 ref 持有「最新值」，让卡片回调函数引用长期稳定（配合 React.memo 避免全网格重绘）
  const live = useRef({});
  live.current = { photos, selection, onSelectionChange, onFocusChange, onQuickToggle, onOpenPreview };

  const handleClick = useCallback((e, photo) => {
    const L = live.current;
    const list = L.photos || [];
    const sel = L.selection || new Set();
    const idx = list.findIndex((p) => p.id === photo.id);
    const isMeta = e.metaKey || e.ctrlKey;
    const isShift = e.shiftKey;
    const anchor = lastClickIdx.current;

    if (isShift && anchor != null && idx >= 0) {
      const a = Math.min(anchor, idx);
      const b = Math.max(anchor, idx);
      const next = new Set(isMeta ? [...sel] : []);
      for (let i = a; i <= b; i += 1) next.add(list[i].id);
      L.onSelectionChange(next);
    } else if (isMeta) {
      const next = new Set(sel);
      if (next.has(photo.id)) next.delete(photo.id);
      else next.add(photo.id);
      L.onSelectionChange(next);
      lastClickIdx.current = idx;
    } else {
      L.onSelectionChange(new Set([photo.id]));
      lastClickIdx.current = idx;
    }
    L.onFocusChange(photo.id);
  }, []);

  const openPreview = useCallback((id) => live.current.onOpenPreview?.(id), []);

  /* 拖框实时高亮：拖动中就把命中的卡片标成临时选中（视觉跟随手感） */
  const markLive = (m, additive, baseSel) => {
    const wrap = wrapRef.current;
    if (!wrap || !m) return;
    const x1 = Math.min(m.x1, m.x2);
    const x2 = Math.max(m.x1, m.x2);
    const y1 = Math.min(m.y1, m.y2);
    const y2 = Math.max(m.y1, m.y2);
    const rect = wrap.getBoundingClientRect();
    const hits = new Set();
    wrap.querySelectorAll('.photo-card').forEach((n) => {
      const r = n.getBoundingClientRect();
      const nx1 = r.left - rect.left + wrap.scrollLeft;
      const ny1 = r.top - rect.top + wrap.scrollTop;
      const nx2 = nx1 + r.width;
      const ny2 = ny1 + r.height;
      const hit = !(nx2 < x1 || nx1 > x2 || ny2 < y1 || ny1 > y2);
      n.classList.toggle('marquee-hit', hit);
      if (hit && n.dataset.photoId) hits.add(n.dataset.photoId);
    });
    if (additive && baseSel) baseSel.forEach((id) => hits.add(id));
    return hits;
  };

  const clearLive = () => {
    if (!wrapRef.current) return;
    wrapRef.current.querySelectorAll('.photo-card.marquee-hit')
      .forEach((n) => n.classList.remove('marquee-hit'));
  };

  const onGridMouseDown = (e) => {
    // 只在空白区域（非卡片）开始框选；右键不触发
    if (e.button !== 0 || e.target.closest('.photo-card')) return;
    const rect = wrapRef.current.getBoundingClientRect();
    const start = {
      x: e.clientX - rect.left + wrapRef.current.scrollLeft,
      y: e.clientY - rect.top + wrapRef.current.scrollTop
    };
    dragState.current = { start, baseSel: new Set(selection), additive: e.metaKey || e.shiftKey };
    setMarquee({ x1: start.x, y1: start.y, x2: start.x, y2: start.y });
  };

  // 拖框：用一个稳定的 latest ref 记住最新矩形，避免每次 mousemove 都重建监听、也避免松手时拿到旧值
  const marqueeRef = useRef(null);
  marqueeRef.current = marquee;
  const dragging = marquee !== null;

  useEffect(() => {
    if (!dragging) return undefined;
    let raf = 0;
    const onMove = (e) => {
      if (!dragState.current || !wrapRef.current) return;
      const rect = wrapRef.current.getBoundingClientRect();
      const cur = {
        x: e.clientX - rect.left + wrapRef.current.scrollLeft,
        y: e.clientY - rect.top + wrapRef.current.scrollTop
      };
      const m = { ...marqueeRef.current, x2: cur.x, y2: cur.y };
      marqueeRef.current = m;
      // 合并到下一帧：拖动时只按帧更新，长图库也不掉帧
      if (!raf) {
        raf = requestAnimationFrame(() => {
          raf = 0;
          const cur2 = marqueeRef.current;
          if (!cur2) return;
          setMarquee(cur2);
          const st = dragState.current;
          if (st && (Math.abs(cur2.x2 - cur2.x1) >= 3 || Math.abs(cur2.y2 - cur2.y1) >= 3)) {
            markLive(cur2, st.additive, st.baseSel);
          }
        });
      }
    };
    const onUp = () => {
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      const m = marqueeRef.current;
      const st = dragState.current;
      // 零面积（只是点了一下空白）不算框选：视为「取消全部选择」
      const isClick = m && Math.abs(m.x2 - m.x1) < 3 && Math.abs(m.y2 - m.y1) < 3;
      clearLive();
      if (isClick) {
        if (!st?.additive) live.current.onSelectionChange(new Set());
      } else if (st && m) {
        const hits = markLive(m, st.additive, st.baseSel) || new Set();
        if (st.additive && st.baseSel) st.baseSel.forEach((id) => hits.add(id));
        live.current.onSelectionChange(hits);
      }
      clearLive();
      dragState.current = null;
      marqueeRef.current = null;
      setMarquee(null);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [dragging]);

  const mStyle = marquee ? {
    left: Math.min(marquee.x1, marquee.x2),
    top: Math.min(marquee.y1, marquee.y2),
    width: Math.abs(marquee.x2 - marquee.x1),
    height: Math.abs(marquee.y2 - marquee.y1)
  } : null;

  const skeleton = loading && photos.length === 0;

  return (
    <div className="grid-scroll" ref={wrapRef} onMouseDown={onGridMouseDown}>
      {loading && <div className="loading-bar" />}
      {skeleton ? (
        <div className="skeleton-grid" style={gridStyle}>
          {Array.from({ length: Math.max(8, columns * 3) }).map((_, i) => (
            <div className="skeleton-card" key={i} />
          ))}
        </div>
      ) : photos.length === 0 && !loading ? (
        <div className="empty-state" style={{ height: '100%' }}>
          <div className="glyph">🗂</div>
          <h2>这里没有照片</h2>
          <p>换一个文件夹，或者检查该目录下是否有 jpg / png / heic 等图片文件。</p>
        </div>
      ) : (
        <div className="photo-grid" style={gridStyle} role="listbox" aria-multiselectable="true">
          {photos.map((p) => (
            <PhotoCard
              key={p.id}
              photo={p}
              selected={selection.has(p.id)}
              focused={focusedId === p.id}
              platforms={platforms}
              onClick={handleClick}
              onQuickToggle={onQuickToggle}
              onOpenPreview={openPreview}
            />
          ))}
        </div>
      )}
      {mStyle && <div className="marquee" style={mStyle} />}
    </div>
  );
}

/* ---------------- 检查器 ---------------- */
/* 检查器：photo 为选中照片，fallback 为选择集大小 >1 时的批量信息 */
export function Inspector({ photo, platforms, onTogglePlatform, selectionCount, selectedPhotos, collapsed, onCollapse, onAddToBatch, onOpenPreview, onReveal }) {
  const [exif, setExif] = useState(null);
  useEffect(() => {
    let alive = true;
    // 切换照片时先清空，避免上一张的尺寸/体积短暂挂在下一张名下
    setExif(null);
    if (!photo) return () => { alive = false; };
    api.photo.exif(photo.path).then((x) => { if (alive) setExif(x); }).catch(() => {});
    return () => { alive = false; };
  }, [photo?.path]);

  if (collapsed) return null;
  return (
    <aside className="inspector">
      <div className="insp-head">
        <span>检查器</span>
        <button className="icon-btn" onClick={onCollapse} title="隐藏检查器">⟩</button>
      </div>
      {photo ? (
        <div className="insp-preview">
          <Thumb path={photo.path} alt={photo.name} className="insp-preview-inner" />
        </div>
      ) : (
        <div className="insp-preview">
          <div className="empty">未选中照片</div>
        </div>
      )}
      {photo && (
        <div className="insp-section" style={{ paddingTop: 10, paddingBottom: 10 }}>
          <div className="fname-full" data-testid="inspector-name">{photo.name}</div>
        </div>
      )}
      {!photo && selectionCount > 1 && (
        <div className="insp-section">
          <div className="insp-label">批量选择</div>
          <div style={{ fontSize: 12, lineHeight: 1.8, color: 'var(--text-secondary)' }}>
            已选 <b style={{ color: 'var(--text)' }}>{selectionCount}</b> 张照片
          </div>
          <div style={{ marginTop: 10 }}>
            {platforms.filter((p) => p.enabled !== false).map((p) => {
              const n = (selectedPhotos || []).filter((x) => x.platforms.includes(p.id)).length;
              return (
                <div className="meta-row" key={p.id}>
                  <span><span className="mark-dot sm" style={{ background: p.color, marginRight: 5 }} />{p.name}</span>
                  <span>{n} / {selectionCount}</span>
                </div>
              );
            })}
          </div>
          <button className="btn plain sm" style={{ marginTop: 10 }} onClick={() => onAddToBatch(selectedPhotos || [])}>
            全部加入发布包
          </button>
        </div>
      )}
      {!photo && selectionCount <= 1 ? (
        <div className="insp-section" style={{ color: 'var(--text-tertiary)', fontSize: 12, lineHeight: 1.7 }}>
          未选中照片。点击网格中的照片查看详情，或框选多张后批量操作。
        </div>
      ) : (photo ? (
        <>
          <div className="insp-section">
            <div className="insp-label">文件</div>
            <div style={{ marginTop: 4 }}>
              {exif && (
                <>
                  <div className="meta-row"><span>尺寸</span><span>{exif.width} × {exif.height}</span></div>
                  <div className="meta-row"><span>体积</span><span>{formatSize(exif.size)}</span></div>
                  <div className="meta-row"><span>修改时间</span><span>{fmtDate(exif.mtime)}</span></div>
                </>
              )}
              <div className="meta-row"><span>所在目录</span><span style={{ maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis' }}>{photo.relDir || '根目录'}</span></div>
            </div>
          </div>
          <div className="insp-section">
            <div className="insp-label">发布平台（点击切换）</div>
            {platforms.filter((p) => p.enabled !== false).map((p) => {
              const on = photo.platforms.includes(p.id);
              return (
                <button
                  key={p.id}
                  className={`platform-toggle ${on ? 'on' : ''}`}
                  onClick={() => onTogglePlatform([photo], p.id)}
                >
                  <span className="pf-mark">{on ? '✓' : '○'}</span>
                  <span className="mark-dot sm" style={{ background: p.color }} />
                  <span className="pf-name">{p.name}</span>
                  <span className="pf-key">{p.shortcut}</span>
                </button>
              );
            })}
          </div>
          <div className="insp-section" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn plain sm" onClick={() => onOpenPreview(photo.id)}>全屏预览</button>
            <button className="btn plain sm" onClick={() => onReveal(photo.path)}>在 Finder 中显示</button>
            <button className="btn plain sm" onClick={() => onAddToBatch([photo])}>
              加入发布包
            </button>
          </div>
        </>
      ) : null)}
      <div style={{ flex: 1 }} />
      <div className="insp-section" style={{ borderTop: '1px solid var(--border)', fontSize: 11, color: 'var(--text-tertiary)', lineHeight: 1.8 }}>
        <div>已选 <b style={{ color: 'var(--text)' }}>{selectionCount}</b> 张</div>
        <div style={{ marginTop: 4 }}>快捷键可在 设置 → 快捷键 中自定义</div>
      </div>
    </aside>
  );
}

function formatSize(bytes) {
  if (!bytes) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function fmtDate(iso) {
  try {
    const d = new Date(iso);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch { return '—'; }
}

export { formatSize, fmtDate };
