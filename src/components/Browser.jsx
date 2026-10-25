import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { matchShortcut } from '../lib/core.mjs';

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

export function Thumb({ path, alt, className }) {
  const [src, setSrc] = useState(() => thumbCache.get(thumbKey(path)) || null);
  const [failed, setFailed] = useState(false);

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
  return (
    <div className={className}>
      {src
        ? <img src={src} alt={alt || ''} draggable={false} loading="lazy" />
        : <span className="placeholder" style={{ opacity: 0.25 }}>·</span>}
    </div>
  );
}

/* ---------------- 照片卡片 ---------------- */
export function PhotoCard({
  photo, selected, focused, platforms, columns, onClick, onQuickToggle, density
}) {
  const clickTimer = useRef(null);
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
}

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
  const [expanded, setExpanded] = useState(() => new Set(['']));
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

  const handleClick = (e, photo) => {
    const idx = photos.findIndex((p) => p.id === photo.id);
    const isMeta = e.metaKey || e.ctrlKey;
    const isShift = e.shiftKey;

    if (isShift && lastClickIdx.current != null) {
      const a = Math.min(lastClickIdx.current, idx);
      const b = Math.max(lastClickIdx.current, idx);
      const range = photos.slice(a, b + 1).map((p) => p.id);
      const next = new Set(isMeta ? [...selection] : []);
      range.forEach((id) => next.add(id));
      onSelectionChange(next);
    } else if (isMeta) {
      const next = new Set(selection);
      if (next.has(photo.id)) next.delete(photo.id);
      else next.add(photo.id);
      onSelectionChange(next);
      lastClickIdx.current = idx;
    } else {
      onSelectionChange(new Set([photo.id]));
      lastClickIdx.current = idx;
    }
    onFocusChange(photo.id);
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

  useEffect(() => {
    if (!marquee) return;
    const onMove = (e) => {
      if (!dragState.current) return;
      const rect = wrapRef.current.getBoundingClientRect();
      const cur = {
        x: e.clientX - rect.left + wrapRef.current.scrollLeft,
        y: e.clientY - rect.top + wrapRef.current.scrollTop
      };
      setMarquee((m) => (m ? { ...m, x2: cur.x, y2: cur.y } : m));
    };
    const onUp = () => {
      const m = marquee;
      // 零面积（只是点了一下空白）不算框选：视为「取消全部选择」
      const isClick = m && Math.abs(m.x2 - m.x1) < 3 && Math.abs(m.y2 - m.y1) < 3;
      if (isClick) {
        if (!dragState.current?.additive) onSelectionChange(new Set());
        dragState.current = null;
        setMarquee(null);
        return;
      }
      if (dragState.current && m) {
        const x1 = Math.min(m.x1, m.x2);
        const x2 = Math.max(m.x1, m.x2);
        const y1 = Math.min(m.y1, m.y2);
        const y2 = Math.max(m.y1, m.y2);
        const rect = wrapRef.current.getBoundingClientRect();
        const base = dragState.current.additive ? new Set(dragState.current.baseSel) : new Set();
        const nodes = wrapRef.current.querySelectorAll('.photo-card');
        nodes.forEach((n) => {
          const r = n.getBoundingClientRect();
          const nx1 = r.left - rect.left + wrapRef.current.scrollLeft;
          const ny1 = r.top - rect.top + wrapRef.current.scrollTop;
          const nx2 = nx1 + r.width;
          const ny2 = ny1 + r.height;
          const hit = !(nx2 < x1 || nx1 > x2 || ny2 < y1 || ny1 > y2);
          if (hit && n.dataset.photoId) base.add(n.dataset.photoId);
        });
        onSelectionChange(base);
      }
      dragState.current = null;
      setMarquee(null);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [marquee, onSelectionChange]);

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
              columns={columns}
              onClick={handleClick}
              onQuickToggle={onQuickToggle}
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
    if (!photo) { setExif(null); return; }
    api.photo.exif(photo.path).then((x) => { if (alive) setExif(x); });
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
