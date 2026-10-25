import React, { createContext, useContext, useEffect, useRef, useState } from 'react';

const api = window.lightbox;
const CLOSE_MS = 130;

/** 让弹窗内部（含 footer 按钮）都能触发「带退场」的关闭 */
export const ModalCloseContext = createContext(() => {});
export const useModalClose = () => useContext(ModalCloseContext);

/** 统一退场：先加 closing 类播放淡出，再真正卸载 */
const closingRef = { current: false };

/** 统一的模态容器：进场淡入 + 退场淡出，Esc / 点遮罩关闭 */
export function Modal({ title, subtitle, children, footer, onClose, wide, tall, width, height }) {
  const [closing, setClosing] = useState(false);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const closingLocal = useRef(false);

  const requestClose = () => {
    if (closingLocal.current || !closeRef.current) return;
    closingLocal.current = true;
    setClosing(true);
    setTimeout(() => closeRef.current?.(), CLOSE_MS);
  };
  // 暴露给外部（如「保存并关闭」按钮）走同一条退场路径
  const requestCloseRef = useRef(requestClose);
  requestCloseRef.current = requestClose;

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        requestCloseRef.current();
      }
    };
    window.addEventListener('keydown', onKey, true);
    document.body.classList.add('modal-open');
    return () => {
      window.removeEventListener('keydown', onKey, true);
      document.body.classList.remove('modal-open');
    };
  }, []);

  return (
    <div
      className={`modal-mask ${closing ? 'closing' : ''}`}
      onMouseDown={(e) => { if (e.target === e.currentTarget) requestClose(); }}
    >
      <div
        className={`modal ${wide ? 'wide' : ''} ${tall ? 'tall' : ''}`}
        style={width || height ? { width: width || undefined, height: height || undefined } : undefined}
        role="dialog"
        aria-label={title}
      >
        <div className="modal-head">
          <h3>{title}</h3>
          {subtitle && <span className="sub">{subtitle}</span>}
        </div>
        <div className="modal-body">
          {/* 子组件通过 ModalCloseContext 拿到统一的「带退场」关闭方法 */}
          <ModalCloseContext.Provider value={requestClose}>
            {typeof children === 'function' ? children(requestClose) : children}
          </ModalCloseContext.Provider>
        </div>
        {footer && (
          <div className="modal-foot">
            <ModalCloseContext.Provider value={requestClose}>
              {typeof footer === 'function' ? footer(requestClose) : footer}
            </ModalCloseContext.Provider>
          </div>
        )}
      </div>
    </div>
  );
}

/** 打包发布弹窗 */
export function BatchModal({ photos, platforms, publishRoot, onClose, onExecute }) {
  const enabledPlatforms = platforms.filter((p) => p.enabled !== false);
  const [selectedPlatforms, setSelectedPlatforms] = useState(() => enabledPlatforms.map((p) => p.id));
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [plan, setPlan] = useState(null);
  const [error, setError] = useState(null);
  const noteRef = useRef(null);

  useEffect(() => { noteRef.current?.focus(); }, []);

  useEffect(() => {
    let alive = true;
    const run = async () => {
      setError(null);
      try {
        const p = await api.batch.plan({
          photos: photos.map((x) => ({ id: x.id, name: x.name, src: x.path })),
          platformIds: selectedPlatforms,
          note
        });
        if (!alive) return;
        if (p && p.error) {
          setPlan(null);
          setError(p.error.includes('备注必填') ? null : p.error);
        } else {
          setPlan(p);
        }
      } catch (e) {
        if (alive) {
          setPlan(null);
          setError(String(e.message || e));
        }
      }
    };
    const t = setTimeout(run, 60); // 轻微防抖，连续输入时不重复请求
    return () => { alive = false; clearTimeout(t); };
  }, [selectedPlatforms, note, photos]);

  const togglePlatform = (id) => {
    setSelectedPlatforms((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const hasClash = (plan?.clashes?.length || 0) > 0;
  const canRun = plan && selectedPlatforms.length > 0 && note.trim().length > 0 && !busy && !hasClash;

  const run = async () => {
    if (!canRun) return;
    setBusy(true);
    try {
      const res = await onExecute({
        photos: photos.map((x) => ({ id: x.id, name: x.name, src: x.path })),
        platformIds: selectedPlatforms,
        note
      });
      setBusy(false);
      if (res) onClose();
    } catch (e) {
      setError(String(e.message || e));
      setBusy(false);
    }
  };

  return (
    <Modal
      title="打包发布"
      subtitle={`${photos.length} 张照片`}
      onClose={busy ? undefined : onClose}
      footer={(closeWithAnim) => (
        <>
          <button className="btn plain" onClick={closeWithAnim} disabled={busy} data-testid="batch-cancel">取消</button>
          <button className="btn primary" onClick={run} disabled={!canRun} data-testid="batch-confirm">
            {busy ? '执行中…' : '确认执行'}
          </button>
        </>
      )}
    >
      <div className="field">
        <label className="field-label">发布到哪些平台<span className="req">*</span></label>
        {enabledPlatforms.map((p) => {
          const on = selectedPlatforms.includes(p.id);
          return (
            <button
              key={p.id}
              className={`checkbox-row ${on ? 'on' : ''}`}
              onClick={() => togglePlatform(p.id)}
              data-testid={`batch-platform-${p.id}`}
            >
              <span className="box">✓</span>
              <span className="mark-dot sm" style={{ background: p.color }} />
              <span style={{ flex: 1, textAlign: 'left' }}>{p.name}</span>
              <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{photos.length} 张</span>
            </button>
          );
        })}
      </div>

      <div className="field">
        <label className="field-label">备注<span className="req">*</span></label>
        <input
          ref={noteRef}
          className={`text-input ${note.length > 0 && !note.trim() ? 'invalid' : ''}`}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="例如：秋日街拍"
          maxLength={60}
          data-testid="batch-note"
        />
      </div>

      <div className="field">
        <label className="field-label">将生成</label>
        <div className="plan-box" data-testid="batch-plan">
          {error ? (
            <div style={{ color: 'var(--danger)' }}>⚠︎ {error}</div>
          ) : !plan ? (
            <div style={{ color: 'var(--text-tertiary)' }}>填写必填项后显示预览…</div>
          ) : (
            <>
              {plan.folders.map((f) => (
                <div className="folder-line" key={f.folderName}>
                  <span>📁</span>
                  <span>{f.folderName}</span>
                  <span style={{ color: 'var(--text-tertiary)', marginLeft: 'auto' }}>{f.count} 张</span>
                </div>
              ))}
              <div className="plan-note">目标：{publishRoot}</div>
              <div className="plan-note">
                原片追加标记：
                {photos.slice(0, 2).map((p) => {
                  const r = plan.renames.find((x) => x.from === p.name);
                  return (
                    <span key={p.id} style={{ display: 'block', fontFamily: '"SF Mono", monospace', fontSize: 11 }}>
                      {p.name} → {r ? r.to : p.name}
                    </span>
                  );
                })}
                {photos.length > 2 && <span>…共 {photos.length} 个文件</span>}
              </div>
            </>
          )}
        </div>

        {hasClash && (
          <div className="warn-line" style={{ background: 'rgba(255,59,48,0.09)', borderColor: 'rgba(255,59,48,0.35)' }}>
            <span>🚨</span>
            <span>
              有 {plan.clashes.length} 组文件改完名后会重名，继续执行会互相覆盖。
              请先取消勾选其中一组，或分批打包。
              {plan.clashes.slice(0, 2).map((c) => (
                <span className="clash-line" key={c.to} style={{ marginTop: 4 }}>
                  {c.names.join('  /  ')} → {c.to}
                </span>
              ))}
            </span>
          </div>
        )}

        <div className="warn-line">
          <span>🔒</span>
          <span>
            只会<b>复制</b>文件到待发布目录并给原片重命名，不会删除任何文件。
            如果重命名遇到同名文件，会跳过该文件而不是覆盖。
          </span>
        </div>
      </div>
    </Modal>
  );
}

/** 全屏预览 */
export function Lightbox({ photos, startId, platforms, onClose, onTogglePlatform }) {
  const [idx, setIdx] = useState(() => Math.max(0, photos.findIndex((p) => p.id === startId)));
  const [src, setSrc] = useState(null);
  const [err, setErr] = useState(null);
  const [zoom, setZoom] = useState(1);
  const [closing, setClosing] = useState(false);

  const cur = photos[idx];

  const requestClose = () => {
    if (closing) return;
    setClosing(true);
    setTimeout(() => onClose(), CLOSE_MS);
  };

  useEffect(() => {
    let alive = true;
    setSrc(null);
    setErr(null);
    setZoom(1);
    if (!cur) return;
    api.photo.readFile(cur.path).then((r) => {
      if (!alive) return;
      if (r?.dataUrl) setSrc(r.dataUrl);
      else setErr(r?.tooLarge ? '文件过大（>60MB），无法内嵌预览' : (r?.error || '无法读取图片'));
    });
    return () => { alive = false; };
  }, [cur?.path]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') requestClose();
      else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') setIdx((i) => Math.min(photos.length - 1, i + 1));
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') setIdx((i) => Math.max(0, i - 1));
      else {
        const pf = platforms.find((p) => p.shortcut === e.key && p.enabled !== false);
        if (pf && cur) onTogglePlatform([cur], pf.id);
      }
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [photos.length, cur, platforms, onTogglePlatform, closing]);

  if (!cur) return null;
  return (
    <div className={`lightbox ${closing ? 'closing' : ''}`} onClick={(e) => { if (e.target.classList.contains('lightbox-stage')) requestClose(); }}>
      <div className="lightbox-stage">
        {src ? (
          <img
            src={src}
            alt={cur.name}
            style={{ transform: `scale(${zoom})`, cursor: zoom > 1 ? 'zoom-out' : 'zoom-in' }}
            onClick={() => setZoom((z) => (z === 1 ? 2 : 1))}
          />
        ) : (
          <div style={{ color: 'rgba(255,255,255,0.7)', fontSize: 13 }}>{err || '加载中…'}</div>
        )}
        <button className="lb-nav left" onClick={() => setIdx((i) => Math.max(0, i - 1))}>‹</button>
        <button className="lb-nav right" onClick={() => setIdx((i) => Math.min(photos.length - 1, i + 1))}>›</button>
      </div>
      <div className="lightbox-bar">
        <span className="lb-name">{cur.name}</span>
        <span style={{ opacity: 0.5 }}>{idx + 1} / {photos.length}</span>
        <div style={{ flex: 1 }} />
        {platforms.filter((p) => p.enabled !== false).map((p) => (
          <button
            key={p.id}
            className={`lb-btn ${cur.platforms.includes(p.id) ? 'on' : ''}`}
            style={cur.platforms.includes(p.id) ? { background: p.color } : undefined}
            onClick={() => onTogglePlatform([cur], p.id)}
          >
            {p.shortcut} · {p.name}
          </button>
        ))}
        <button className="lb-btn" onClick={requestClose}>关闭（Esc）</button>
      </div>
    </div>
  );
}

/** toast */
export function Toasts({ items }) {
  return (
    <div className="toast-wrap">
      {items.map((t) => (
        <div key={t.id} className={`toast ${t.kind || ''}`}>{t.text}</div>
      ))}
    </div>
  );
}
