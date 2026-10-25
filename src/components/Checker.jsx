import React, { useEffect, useMemo, useState } from 'react';
import { analyzeCoverage } from '../lib/core.mjs';
import { Thumb, formatSize, fmtDate } from './Browser.jsx';

const api = window.lightbox;

export function Checker({ photos, platforms, tree, onJumpToPhoto, onOpenFolder, history, onUndo }) {
  const [tab, setTab] = useState('never');
  const [groupBy, setGroupBy] = useState('folder');

  const cov = useMemo(() => analyzeCoverage(photos, platforms), [photos, platforms]);

  const groups = (list) => {
    if (groupBy === 'none') return [{ key: '全部', items: list }];
    const map = new Map();
    for (const p of list) {
      const k = p.relDir || '根目录';
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(p);
    }
    return [...map.entries()]
      .sort((a, b) => a[0].localeCompare(b[0], 'zh'))
      .map(([key, items]) => ({ key, items }));
  };

  const listFor = tab === 'never' ? cov.never : tab === 'missing' ? cov.missing : cov.complete;

  return (
    <div className="checker">
      <div className="checker-head">
        <h2>漏发检查</h2>
        <span style={{ color: 'var(--text-tertiary)', fontSize: 12 }}>
          共 {cov.total} 张 · 全平台覆盖 {cov.coverageRate}%
        </span>
        <div style={{ flex: 1 }} />
        <div className="segmented">
          <button className={groupBy === 'folder' ? 'on' : ''} onClick={() => setGroupBy('folder')}>按文件夹</button>
          <button className={groupBy === 'none' ? 'on' : ''} onClick={() => setGroupBy('none')}>不分组</button>
        </div>
      </div>

      <div className="checker-body">
        <div className="stat-cards">
          <div className="stat-card">
            <div className="k">🟠 从未发布</div>
            <div className="v">{cov.never.length}<small>张</small></div>
          </div>
          <div className="stat-card">
            <div className="k">🟡 平台不全</div>
            <div className="v">{cov.missing.length}<small>张</small></div>
          </div>
          <div className="stat-card">
            <div className="k">✅ 全平台已发</div>
            <div className="v">{cov.complete.length}<small>张</small></div>
          </div>
          <div className="stat-card">
            <div className="k">📊 合计</div>
            <div className="v">{cov.total}<small>张</small></div>
          </div>
        </div>

        <div className="stat-cards" style={{ gridTemplateColumns: `repeat(${Math.max(1, cov.activePlatforms.length)}, 1fr)` }}>
          {cov.activePlatforms.map((p) => (
            <div className="stat-card" key={p.id}>
              <div className="k"><span className="mark-dot sm" style={{ background: p.color }} />{p.name} 已发</div>
              <div className="v">{cov.byPlatform[p.id]}<small>张 · 缺 {cov.missingCount[p.id]}</small></div>
            </div>
          ))}
        </div>

        <div className="tab-row" style={{ padding: 0, borderBottom: 'none', marginBottom: 12 }}>
          <button className={`tab ${tab === 'never' ? 'on' : ''}`} onClick={() => setTab('never')}>
            从未发布<span className="badge">{cov.never.length}</span>
          </button>
          <button className={`tab ${tab === 'missing' ? 'on' : ''}`} onClick={() => setTab('missing')}>
            平台不全<span className="badge">{cov.missing.length}</span>
          </button>
          <button className={`tab ${tab === 'complete' ? 'on' : ''}`} onClick={() => setTab('complete')}>
            全平台已发<span className="badge">{cov.complete.length}</span>
          </button>
        </div>

        {listFor.length === 0 ? (
          <div style={{ color: 'var(--text-tertiary)', fontSize: 12, padding: '26px 0', textAlign: 'center' }}>
            {tab === 'never' ? '🎉 没有漏发的照片，全部至少发过一个平台' : tab === 'missing' ? '🎉 所有照片都发齐了全部平台' : '暂无全平台已发的照片'}
          </div>
        ) : (
          groups(listFor).map((g) => (
            <div className="group-block" key={g.key}>
              <div className="group-title">
                📁 {g.key} <span className="cnt">({g.items.length})</span>
                <button className="btn plain sm" style={{ marginLeft: 6 }} onClick={() => onOpenFolder(g.key)}>前往该文件夹</button>
              </div>
              <div className="mini-grid">
                {g.items.map((p) => (
                  <div className="mini-card" key={p.id} onClick={() => onJumpToPhoto(p)} title={p.name}>
                    <Thumb path={p.path} alt={p.name} className="thumb" />
                    <div className="cap">
                      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.base}</span>
                      {p.platforms.map((id) => {
                        const pf = platforms.find((x) => x.id === id);
                        return pf ? <span key={id} className="mark-dot sm" style={{ background: pf.color }} /> : null;
                      })}
                      {p.lack && p.lack.map((id) => {
                        const pf = platforms.find((x) => x.id === id);
                        return pf ? (
                          <span key={id} className="mark-dot sm" style={{ background: 'transparent', borderColor: pf.color, borderStyle: 'dashed' }} title={`缺 ${pf.name}`} />
                        ) : null;
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))
        )}

        <div className="group-title" style={{ marginTop: 26 }}>🕘 操作历史（可撤销）</div>
        {history.length === 0 ? (
          <div style={{ color: 'var(--text-tertiary)', fontSize: 12 }}>还没有操作记录。打包发布或标记后会自动记在这里。</div>
        ) : (
          history.slice(0, 30).map((h) => (
            <div className="history-item" key={h.id}>
              <div className="h-head">
                <span className="h-title">
                  {h.type === 'batch' ? '📦 打包发布' : h.type === 'mark' ? '🏷 标记' : '↩︎ 撤销'}
                  {h.note ? ` · ${h.note}` : ''}
                </span>
                <span className="h-time">{fmtDate(h.at)}</span>
              </div>
              <div className="h-detail">
                {h.type === 'batch' && (
                  <>
                    {h.platforms?.map((p) => <span key={p.id} className="tag" style={{ marginRight: 5 }}>{p.name} → {p.folder}</span>)}
                    <div>改名 {h.renames?.length || 0} 个文件 · 复制 {(h.copies?.length || 0)} 份</div>
                  </>
                )}
                {h.type === 'mark' && <div>改名 {h.renames?.length || 0} 个文件</div>}
                {h.type === 'undo' && <div>恢复 {h.renames?.length || 0} 个文件</div>}
                {h.errors?.length > 0 && <div className="tag warn" style={{ marginTop: 4 }}>⚠︎ {h.errors.length} 条错误</div>}
              </div>
              {h.type !== 'undo' && (h.renames?.length || 0) > 0 && (
                <button className="btn plain sm" style={{ marginTop: 6 }} onClick={() => onUndo(h.id)}>撤销这次改名</button>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
