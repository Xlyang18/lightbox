import React, { useEffect, useState } from 'react';
import { APP_NAME, APP_NAME_EN, CHANGELOG, FEATURES } from '../lib/changelog.mjs';

const api = window.lightbox;

/** 极简行内 Markdown：只处理 **粗体** 与 `代码`，够用且不引依赖 */
function RichText({ text }) {
  const parts = String(text).split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean);
  return (
    <>
      {parts.map((p, i) => {
        if (p.startsWith('**') && p.endsWith('**')) return <b key={i}>{p.slice(2, -2)}</b>;
        if (p.startsWith('`') && p.endsWith('`')) {
          return (
            <code key={i} style={{
              fontFamily: '"SF Mono", ui-monospace, monospace',
              fontSize: '0.94em',
              background: 'var(--hover)',
              padding: '1px 4px',
              borderRadius: 3
            }}
            >
              {p.slice(1, -1)}
            </code>
          );
        }
        return <span key={i}>{p}</span>;
      })}
    </>
  );
}

/** 关于页：软件信息 + 功能说明 */
export function AboutPanel({ settings }) {
  const [info, setInfo] = useState(null);

  useEffect(() => {
    let alive = true;
    api?.app?.info?.().then((x) => { if (alive) setInfo(x); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  return (
    <div data-testid="about-panel">
      <div className="about-hero">
        <div className="about-logo">
          <svg viewBox="0 0 100 100" width="68" height="68" aria-hidden="true">
            <defs>
              <linearGradient id="abg" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stopColor="#3d4149" />
                <stop offset="100%" stopColor="#1a1c22" />
              </linearGradient>
            </defs>
            <rect width="100" height="100" rx="22" fill="url(#abg)" />
            <rect x="22" y="34" width="46" height="32" rx="4" fill="#8f9db5" opacity="0.55" transform="rotate(-9 45 50)" />
            <rect x="20" y="38" width="56" height="34" rx="4" fill="#e8eef8" transform="rotate(-3 48 55)" />
            <circle cx="40" cy="52" r="9" fill="#ffd98a" opacity="0.85" />
            <circle cx="70" cy="42" r="4.5" fill="#ff3b30" />
            <circle cx="79" cy="42" r="4.5" fill="#34c759" />
            <circle cx="88" cy="42" r="4.5" fill="#00aeec" />
          </svg>
        </div>
        <div className="about-meta">
          <h2>{APP_NAME} <span style={{ fontSize: 13, fontWeight: 400, color: 'var(--text-tertiary)' }}>{APP_NAME_EN}</span></h2>
          <div className="ver">版本 {info?.version || '1.2.0'}{info?.isPackaged ? '' : ' · 开发版'}</div>
          <div className="tagline">
            摄影集发布台账 —— 拍完修好的照片，不再忘记发；
            发了小红书，也不会漏掉朋友圈和 B 站。
          </div>
        </div>
      </div>

      <div className="section-title">功能一览</div>
      {FEATURES.map((f) => (
        <div className="feature-card" key={f.title}>
          <span className="f-icon">{f.icon}</span>
          <div className="f-body">
            <div className="f-title">{f.title}</div>
            <div className="f-desc">{f.desc}</div>
          </div>
        </div>
      ))}

      <div className="section-title">运行环境</div>
      <table className="kv-table">
        <tbody>
          <tr><td>应用版本</td><td>{info?.version || '—'}</td></tr>
          <tr><td>Electron</td><td>{info?.electron || '—'}</td></tr>
          <tr><td>Chromium</td><td>{info?.chrome || '—'}</td></tr>
          <tr><td>Node.js</td><td>{info?.node || '—'}</td></tr>
          <tr><td>数据目录</td><td>{info?.dataDir || '~/.lightbox'}</td></tr>
          <tr><td>摄影集目录</td><td>{settings?.photoRoot || '未设置'}</td></tr>
          <tr><td>待发布目录</td><td>{settings?.publishRoot || '未设置'}</td></tr>
        </tbody>
      </table>

      <div className="section-title">数据安全承诺</div>
      <div style={{
        padding: '12px 14px',
        background: 'var(--bg)',
        borderRadius: 10,
        border: '1px solid var(--border)',
        fontSize: 11.5,
        lineHeight: 1.95,
        color: 'var(--text-secondary)'
      }}
      >
        🔒 <b style={{ color: 'var(--text)' }}>光匣永不删除任何照片。</b><br />
        · 打包只做复制，原片留在原地<br />
        · 改名先查重，冲突即跳过，绝不覆盖<br />
        · 批量操作中途出错会自动回滚<br />
        · 每一次改名与打包都写入可撤销的历史<br />
        · 源码中不存在任何删除文件的调用
      </div>
    </div>
  );
}

/** 更新日志页 */
export function ChangelogPanel() {
  return (
    <div data-testid="changelog-panel">
      <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginBottom: 16, lineHeight: 1.7 }}>
        这里记录着光匣每一次的成长 🐣 有新功能、有修过的坑，也有一点小小的骄傲。
      </div>
      {CHANGELOG.map((entry) => (
        <div className={`changelog-entry ${entry.latest ? 'latest' : ''}`} key={entry.version}>
          <div className="cl-head">
            <span className="cl-ver">v{entry.version}</span>
            <span className="cl-date">{entry.date}</span>
            {entry.badges?.map((b) => (
              <span className={`cl-badge ${entry.latest ? 'new' : ''}`} key={b}>{b}</span>
            ))}
          </div>
          <div className="cl-title">{entry.title}</div>
          {entry.sections.map((s) => (
            <div className="cl-section" key={s.tag}>
              <div className="cl-tag">{s.tag}</div>
              <ul className="cl-list">
                {s.items.map((it, i) => (
                  <li key={i}><RichText text={it} /></li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
