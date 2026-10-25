import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  isValidShortcut, DEFAULT_PLATFORMS, PLATFORM_COLORS,
  validatePlatforms, hasFatalPlatformIssue, makeNewPlatform
} from '../lib/core.mjs';
import { AboutPanel, ChangelogPanel } from './About.jsx';
import { Modal, useModalClose } from './Dialogs.jsx';

const api = window.lightbox;

const SHORTCUT_LABELS = {
  next: '下一张',
  prev: '上一张',
  rowNext: '下一行（按当前列数）',
  rowPrev: '上一行（按当前列数）',
  preview: '全屏预览',
  selectAll: '全选当前视图',
  clearSelection: '清空选择',
  addToBatch: '选中项加入发布包',
  togglePlatform1: '切换平台 1 标记',
  togglePlatform2: '切换平台 2 标记',
  togglePlatform3: '切换平台 3 标记',
  openChecker: '打开漏发检查',
  openSettings: '打开设置'
};

const TABS = [
  ['general', '通用'],
  ['platforms', '平台'],
  ['shortcuts', '快捷键'],
  ['history', '历史记录'],
  ['changelog', '更新日志'],
  ['about', '关于']
];

function ShortcutCapture({ value, onChange }) {
  const [recording, setRecording] = useState(false);

  useEffect(() => {
    if (!recording) return;
    const onKey = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const mods = [];
      if (e.metaKey) mods.push('⌘');
      if (e.shiftKey) mods.push('Shift');
      if (e.altKey) mods.push('⌥');
      if (e.ctrlKey) mods.push('⌃');
      let key = e.key;
      if (['Meta', 'Shift', 'Alt', 'Control'].includes(key)) return;
      if (key === ' ') key = 'Space';
      if (key === 'Escape' && mods.length === 0) { setRecording(false); return; }
      if (key.length === 1) key = key.toUpperCase();
      const expr = [...mods, key].join('+');
      if (isValidShortcut(expr)) {
        onChange(expr);
        setRecording(false);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [recording, onChange]);

  return (
    <button
      className={`shortcut-capture ${recording ? 'recording' : ''}`}
      onClick={() => setRecording(true)}
      onBlur={() => setRecording(false)}
      title="点击后按下想要的组合键"
    >
      {recording ? '请按下按键…' : (value || '未设置')}
    </button>
  );
}

/** 深拷贝草稿：草稿绝不能与外部 settings 共享 platforms / shortcuts 等嵌套引用 */
function cloneSettings(s) {
  if (!s) return s;
  return {
    ...s,
    platforms: (s.platforms || []).map((p) => ({ ...p })),
    shortcuts: { ...(s.shortcuts || {}) }
  };
}

export function Settings({ settings, onSave, onClose, history, onUndo, initialTab = 'general' }) {
  const [tab, setTab] = useState(initialTab);
  const [draft, setDraft] = useState(() => cloneSettings(settings));
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [busy, setBusy] = useState(false);

  // 只在「外部保存值真正变化」时重置草稿。
  // 父组件每次渲染可能传入新对象引用，直接依赖 [settings] 会冲掉未保存的草稿；
  // 但也不能把整个 settings 序列化（会随照片规模线性变慢），只比对保存值的指纹。
  const saveFingerprint = useRef(null);
  const computeFingerprint = (s) => [
    s?.photoRoot, s?.publishRoot, s?.columns, s?.theme, s?.reduceMotion,
    JSON.stringify(s?.platforms || []), JSON.stringify(s?.shortcuts || {})
  ].join('|');
  useEffect(() => {
    const fp = computeFingerprint(settings);
    if (saveFingerprint.current === fp) return;
    saveFingerprint.current = fp;
    setDraft(cloneSettings(settings));
  }, [settings]);

  const update = (patch) => setDraft((d) => ({ ...d, ...patch }));

  // 诊断钩子：E2E 可读取当前草稿关键值，定位「改了又被打回」的问题
  useEffect(() => {
    window.__LB_DRAFT = () => ({ columns: draft.columns, theme: draft.theme, platforms: draft.platforms?.length });
  }, [draft]);

  const platforms = draft.platforms || DEFAULT_PLATFORMS;
  const issues = useMemo(() => validatePlatforms(platforms), [platforms]);
  const fatal = hasFatalPlatformIssue(issues);

  const save = async () => {
    if (fatal) {
      const msg = issues.find((i) => i.kind === 'name' || i.kind === 'emoji')?.msg || '平台配置有误';
      setSaveError(`无法保存：${msg}（请到「平台」页修正）`);
      setTab('platforms');
      return;
    }
    // 快捷键冲突也提示但不阻止保存
    const dupKeys = issues.filter((i) => i.kind === 'shortcut');
    if (dupKeys.length) {
      setSaveError(`提示：${dupKeys[0].msg}，请到「平台」页检查`);
    }
    setBusy(true);
    setSaveError(null);
    try {
      await onSave(draft);
      setSaved(true);
      setTimeout(() => setSaved(false), 1600);
    } catch (e) {
      setSaveError(String(e.message || e));
    } finally {
      setBusy(false);
    }
  };

  const choosePhoto = async () => {
    const p = await api.dialog.choosePhotoRoot();
    if (p) update({ photoRoot: p });
  };
  const choosePublish = async () => {
    try {
      const p = await api.dialog.choosePublishRoot(draft.photoRoot);
      if (p) update({ publishRoot: p });
    } catch (e) {
      setSaveError(String(e.message || e));
    }
  };

  const setPlatformField = (i, patch) => {
    update({ platforms: platforms.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
  };

  return (
    <Modal
      title="设置"
      subtitle={saveError ? `⚠︎ ${saveError}` : saved ? '✅ 已保存' : '修改后点右下角保存'}
      onClose={onClose}
      width={660}
      height="min(600px, calc(100vh - 80px))"
      footer={(closeWithAnim) => (
        <>
          <span style={{ flex: 1 }} />
          <button className="btn plain" onClick={closeWithAnim}>关闭</button>
          <button className="btn primary" onClick={save} disabled={busy} data-testid="settings-save">
            {busy ? '保存中…' : '保存'}
          </button>
        </>
      )}
    >
      <div className="settings-layout" data-testid="settings-modal">
        <div className="settings-nav">
          {TABS.map(([k, label]) => (
            <button
              key={k}
              className={tab === k ? 'on' : ''}
              onClick={() => setTab(k)}
              data-testid={`settings-tab-${k}`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="settings-panel">
          {tab === 'general' && (
            <>
              <div className="field">
                <label className="field-label">摄影集根目录</label>
                <div className="path-row">
                  <div className={`path-display ${draft.photoRoot ? 'set' : ''}`} title={draft.photoRoot}>
                    {draft.photoRoot || '未选择'}
                  </div>
                  <button className="btn plain" onClick={choosePhoto}>选择…</button>
                </div>
              </div>

              <div className="field">
                <label className="field-label">待发布目录（打包目标）</label>
                <div className="path-row">
                  <div className={`path-display ${draft.publishRoot ? 'set' : ''}`} title={draft.publishRoot}>
                    {draft.publishRoot || '未选择'}
                  </div>
                  <button className="btn plain" onClick={choosePublish}>选择…</button>
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 6, lineHeight: 1.6 }}>
                  打包时会在此目录下创建「日期-平台-备注」子文件夹并复制照片。不能选择摄影集内部的目录。
                </div>
              </div>

              <div className="field">
                <label className="field-label">网格列数</label>
                <div className="segmented">
                  {[3, 4, 5, 6].map((n) => (
                    <button key={n} className={draft.columns === n ? 'on' : ''} onClick={() => update({ columns: n })}>
                      {n} 列
                    </button>
                  ))}
                </div>
              </div>

              <div className="field">
                <label className="field-label">外观</label>
                <div className="segmented">
                  {[['system', '跟随系统'], ['light', '浅色'], ['dark', '深色']].map(([k, label]) => (
                    <button key={k} className={draft.theme === k ? 'on' : ''} onClick={() => update({ theme: k })}>
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="field">
                <label className="field-label">界面动效</label>
                <div className="segmented">
                  {[[true, '完整动效'], [false, '减弱动效']].map(([v, label]) => (
                    <button
                      key={String(v)}
                      className={(draft.reduceMotion !== false) === !v ? 'on' : ''}
                      onClick={() => update({ reduceMotion: !v })}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 6, lineHeight: 1.6 }}>
                  减弱动效会关掉过渡与入场动画，适合喜欢瞬时反应或使用录屏的场景。
                </div>
              </div>

              <div className="field">
                <label className="field-label">数据目录</label>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button className="btn plain" onClick={() => api.settings.revealData()}>在 Finder 中打开 ~/.lightbox</button>
                  <button className="btn plain" onClick={async () => {
                    await api.thumb.clear();
                    setSaved(true);
                    setTimeout(() => setSaved(false), 1400);
                  }}
                  >
                    清空缩略图缓存
                  </button>
                </div>
              </div>
            </>
          )}

          {tab === 'platforms' && (
            <>
              <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginBottom: 12, lineHeight: 1.7 }}>
                平台会对应到原片文件名尾部的 emoji 标记。改动只影响之后的标记，不会重命名已有文件。
                删除平台后，老文件上的标记仍会被识别，下次改名时自动清除。
              </div>
              {platforms.map((p, i) => {
                const rowIssues = issues.filter((x) => x.index === i);
                return (
                  <div className={`platform-row ${rowIssues.length ? 'invalid' : ''}`} key={p.id}>
                    <input
                      className="p-emoji"
                      value={p.emoji}
                      maxLength={4}
                      title="标记 emoji"
                      onChange={(e) => setPlatformField(i, { emoji: e.target.value })}
                    />
                    <input
                      className="p-name"
                      value={p.name}
                      title="平台名称"
                      onChange={(e) => setPlatformField(i, { name: e.target.value })}
                    />
                    <div className="color-swatches">
                      {PLATFORM_COLORS.slice(0, 6).map((c) => (
                        <button
                          key={c}
                          className={`swatch ${p.color === c ? 'on' : ''}`}
                          style={{ background: c }}
                          title={`色点颜色 ${c}`}
                          onClick={() => setPlatformField(i, { color: c })}
                        />
                      ))}
                    </div>
                    <input
                      className="p-name"
                      style={{ flex: '0 0 46px', textAlign: 'center' }}
                      value={p.shortcut}
                      maxLength={1}
                      title="快捷数字键"
                      onChange={(e) => setPlatformField(i, { shortcut: e.target.value })}
                    />
                    <button
                      className={`switch ${p.enabled !== false ? 'on' : ''}`}
                      onClick={() => setPlatformField(i, { enabled: p.enabled === false })}
                      title={p.enabled !== false ? '已启用' : '已停用'}
                    />
                  </div>
                );
              })}
              {issues.length > 0 && (
                <div className="field-error" style={{ marginTop: 8 }}>
                  ⚠︎ {issues.map((x) => `第${x.index + 1}行：${x.msg}`).join('；')}
                </div>
              )}
              <div style={{ marginTop: 14, display: 'flex', gap: 8 }}>
                <button
                  className="btn plain"
                  onClick={() => update({ platforms: [...platforms, makeNewPlatform(platforms)] })}
                >
                  + 添加平台
                </button>
                <button className="btn plain" onClick={() => update({ platforms: DEFAULT_PLATFORMS })}>
                  恢复默认三个平台
                </button>
              </div>
            </>
          )}

          {tab === 'shortcuts' && (
            <>
              <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginBottom: 12, lineHeight: 1.7 }}>
                点击右侧按钮后按下想要的组合键即可。按 Esc 取消录入。
              </div>
              {Object.entries(SHORTCUT_LABELS).map(([k, label]) => (
                <div className="shortcut-row" key={k}>
                  <span className="s-label">{label}</span>
                  <ShortcutCapture
                    value={draft.shortcuts?.[k]}
                    onChange={(expr) => update({ shortcuts: { ...draft.shortcuts, [k]: expr } })}
                  />
                </div>
              ))}
              <button
                className="btn plain"
                style={{ marginTop: 14 }}
                onClick={() => update({ shortcuts: { ...settings.shortcuts } })}
              >
                恢复默认快捷键
              </button>
            </>
          )}

          {tab === 'history' && (
            <>
              <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginBottom: 10 }}>
                共 {history.length} 条记录，完整日志位于 ~/.lightbox/history.jsonl
              </div>
              {history.length === 0 && (
                <div style={{ color: 'var(--text-tertiary)', fontSize: 12 }}>还没有操作记录。</div>
              )}
              {history.slice(0, 40).map((h) => (
                <div className="history-item" key={h.id}>
                  <div className="h-head">
                    <span className="h-title">
                      {h.type === 'batch' ? '📦 打包发布' : h.type === 'mark' ? '🏷 标记' : '↩︎ 撤销'}
                      {h.note ? ` · ${h.note}` : ''}
                    </span>
                    <span className="h-time">{new Date(h.at).toLocaleString('zh-CN')}</span>
                  </div>
                  <div className="h-detail">
                    改名 {h.renames?.length || 0} 个 · 复制 {h.copies?.length || 0} 份
                    {h.errors?.length > 0 && <span className="tag warn" style={{ marginLeft: 6 }}>⚠︎ {h.errors.length} 条错误</span>}
                  </div>
                  {h.type !== 'undo' && (h.renames?.length || 0) > 0 && onUndo && (
                    <button className="btn plain sm" style={{ marginTop: 6 }} onClick={() => onUndo(h.id)}>
                      撤销这次改名
                    </button>
                  )}
                </div>
              ))}
            </>
          )}

          {tab === 'changelog' && <ChangelogPanel />}
          {tab === 'about' && <AboutPanel settings={draft} />}
        </div>
      </div>
    </Modal>
  );
}
