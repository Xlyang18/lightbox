/**
 * 光匣 E2E 测试驱动
 * 启动真实 Electron（远程调试端口），用 CDP「真实鼠标/键盘事件」驱动界面，逐步截图。
 *
 * 关键点：必须用 Input.dispatchMouseEvent，而不是 JS 的 el.click()——
 * 后者在 React 受控组件里不会可靠触发状态更新。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const SHOT_DIR = path.join(ROOT, 'screenshots');
const PORT = 9333;
const FIXTURE = path.join(os.homedir(), '.lightbox-test', '照片集');
const PUBLISH = path.join(os.homedir(), '.lightbox-test', '待发布');

fs.mkdirSync(SHOT_DIR, { recursive: true });

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function getJSON(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.ready = new Promise((res, rej) => {
      this.ws.onopen = () => res();
      this.ws.onerror = (e) => rej(e);
    });
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    };
  }
  send(method, params = {}) {
    this.id += 1;
    const id = this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', {
      expression: expr,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true
    });
    if (r.exceptionDetails) {
      throw new Error(`JS 执行异常: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
    }
    return r.result.value;
  }
  close() { this.ws.close(); }
}

async function waitForPort(timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const targets = await getJSON(`http://127.0.0.1:${PORT}/json/list`);
      const page = targets.find((t) => t.type === 'page' && !t.url.startsWith('devtools'));
      if (page) return page;
    } catch { /* not ready */ }
    await sleep(300);
  }
  throw new Error('等待调试端口超时');
}

async function main() {
  const env = { ...process.env, LIGHTBOX_TEST: '1' };
  if (!env.LIGHTBOX_TEST_SETTINGS) {
    env.LIGHTBOX_TEST_SETTINGS = JSON.stringify({ photoRoot: FIXTURE, publishRoot: PUBLISH });
  }
  const electronBin = path.join(ROOT, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron');
  const child = spawn(electronBin, [ROOT, `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d.toString(); });
  child.stderr.on('data', (d) => { log += d.toString(); });

  const page = await waitForPort(30000);
  const cdp = new CDP(page.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send('Page.enable');

  const results = [];
  let shotNo = 0;
  const shot = async (name) => {
    shotNo += 1;
    const n = String(shotNo).padStart(2, '0');
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(SHOT_DIR, `${n}-${name}.png`);
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    return path.basename(file);
  };

  const step = async (label, fn) => {
    try {
      const r = await fn();
      results.push({ label, ok: true, note: r || '' });
      console.log(`  ✔ ${label}${r ? ` — ${r}` : ''}`);
      return r;
    } catch (e) {
      results.push({ label, ok: false, note: e.message });
      console.log(`  ✖ ${label} — ${e.message}`);
      throw e;
    }
  };

  /** 中心坐标（CSS 像素，相对视口） */
  const centerOf = async (sel, index = 0) => cdp.eval(`(() => {
    const els = document.querySelectorAll(${JSON.stringify(sel)});
    const el = els[${index}];
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return [r.x + r.width / 2, r.y + r.height / 2];
  })()`);

  /** 真实鼠标点击（可选 shift/meta） */
  const mouseClick = async (sel, { index = 0, shift = false, meta = false, delay = 400 } = {}) => {
    const pos = await centerOf(sel, index);
    if (!pos) throw new Error(`找不到元素：${sel}[${index}]`);
    const modifiers = (shift ? 8 : 0) | (meta ? 4 : 0);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pos[0], y: pos[1], modifiers });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pos[0], y: pos[1], button: 'left', clickCount: 1, modifiers });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pos[0], y: pos[1], button: 'left', clickCount: 1, modifiers });
    await sleep(delay);
    return pos;
  };

  /** 用文本找按钮并点击 */
  const clickText = async (buttonSel, text, opts = {}) => {
    const idx = await cdp.eval(`(() => {
      const els = [...document.querySelectorAll(${JSON.stringify(buttonSel)})];
      return els.findIndex(e => e.innerText.trim() === ${JSON.stringify(text)});
    })()`);
    if (idx < 0) throw new Error(`找不到按钮：${buttonSel} 文本「${text}」`);
    return mouseClick(buttonSel, { ...opts, index: idx });
  };

  /** 用包含文本找按钮并点击 */
  const clickContains = async (buttonSel, text, opts = {}) => {
    const idx = await cdp.eval(`(() => {
      const els = [...document.querySelectorAll(${JSON.stringify(buttonSel)})];
      return els.findIndex(e => e.innerText.includes(${JSON.stringify(text)}));
    })()`);
    if (idx < 0) throw new Error(`找不到按钮：${buttonSel} 含「${text}」`);
    return mouseClick(buttonSel, { ...opts, index: idx });
  };

  const api = {
    cdp, shot, step, results, sleep,
    mouseClick, clickText, clickContains, centerOf,
    // 向后兼容场景脚本里的 click()
    click: async (sel) => mouseClick(sel),
    exists: async (sel) => cdp.eval(`!!document.querySelector(${JSON.stringify(sel)})`),
    text: async (sel) => cdp.eval(`(document.querySelector(${JSON.stringify(sel)})?.innerText || '')`),
    count: async (sel) => cdp.eval(`document.querySelectorAll(${JSON.stringify(sel)}).length`),
    type: async (sel, value) => {
      // 先真实点进输入框，再用键盘输入，保证 React 收到真实事件
      await mouseClick(sel, { delay: 150 });
      await cdp.eval(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); el.select && el.select(); })()`);
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
      await sleep(80);
      if (value) await cdp.send('Input.insertText', { text: value });
      await sleep(350);
    },
    key: async (key, opts = {}) => {
      const vk = opts.vk || (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
      const base = {
        key,
        code: opts.code || (key.length === 1 ? `Key${key.toUpperCase()}` : key),
        windowsVirtualKeyCode: vk,
        nativeVirtualKeyCode: vk,
        modifiers: opts.modifiers || 0
      };
      // modifiers: 1=Alt 2=Ctrl 4=Meta 8=Shift
      // macOS 上 Command 组合需要 commands 才会被识别
      const withCmds = (opts.modifiers || 0) & 4 ? { ...base, commands: [] } : base;
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...withCmds });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...withCmds });
      await sleep(300);
    },
    drag: async (fromSel, toSel) => {
      const a = await centerOf(fromSel, 0);
      const b = await centerOf(toSel, 0);
      const canvas = await cdp.eval(`(() => { const r = document.querySelector('.grid-scroll').getBoundingClientRect(); return [r.x + 8, r.y + 8]; })()`);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: canvas[0], y: canvas[1] });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: canvas[0], y: canvas[1], button: 'left', clickCount: 1 });
      await sleep(80);
      const steps = 12;
      for (let i = 1; i <= steps; i += 1) {
        await cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: canvas[0] + ((b[0] + 60 - canvas[0]) * i) / steps,
          y: canvas[1] + ((b[1] + 60 - canvas[1]) * i) / steps,
          button: 'left'
        });
        await sleep(35);
      }
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b[0] + 60, y: b[1] + 60, button: 'left', clickCount: 1 });
      await sleep(400);
      return { from: a, to: b };
    }
  };

  const scenario = require('./e2e-scenario.cjs');
  let fatal = null;
  try {
    await scenario(api, { FIXTURE, PUBLISH, ROOT });
  } catch (e) {
    fatal = e;
    await shot('FATAL-error').catch(() => {});
  }

  fs.writeFileSync(path.join(SHOT_DIR, 'results.json'), JSON.stringify({ results, fatal: fatal?.message, log: log.slice(-4000) }, null, 2));
  cdp.close();
  child.kill('SIGTERM');
  await sleep(600);
  try { child.kill('SIGKILL'); } catch { /* ignore */ }
  console.log(fatal ? `\n测试中断：${fatal.message}` : `\n全部 ${results.length} 个步骤完成，${results.filter((r) => !r.ok).length} 个失败`);
  process.exit(fatal ? 1 : 0);
}

main().catch((e) => {
  console.error('E2E 启动失败：', e);
  process.exit(2);
});
