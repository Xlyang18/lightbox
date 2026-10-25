/**
 * 生成 光匣 图标（1024×1024 PNG）
 * 设计：深空底色 + 斜向光柱 + 白热发光点 + 三张倾斜照片卡（象征摄影集与批次）
 * 纯代码绘制，Apple 风格圆角与柔和阴影。
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 1024;
const PAD = 84;

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => t * t * (3 - 2 * t);

/** 圆角矩形有符号距离（正=在内部） */
function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  const inside = Math.min(Math.max(qx, qy), 0);
  return -(outside + inside - r);
}

/** 点是否在旋转矩形内（返回有符号距离） */
function sdRotRect(px, py, cx, cy, hw, hh, angle, r) {
  const ca = Math.cos(-angle);
  const sa = Math.sin(-angle);
  const dx = px - cx;
  const dy = py - cy;
  const rx = dx * ca - dy * sa;
  const ry = dx * sa + dy * ca;
  return sdRoundRect(rx, ry, 0, 0, hw, hh, r);
}

/** 抗锯齿覆盖率 */
function cover(sd) {
  return clamp(sd + 0.5, 0, 1);
}

function over(base, color, alpha) {
  const a = clamp(alpha, 0, 1);
  const outA = a + base[3] / 255 * (1 - a);
  if (outA <= 0) return [0, 0, 0, 0];
  const mix = (i) => (color[i] * a + base[i] * (base[3] / 255) * (1 - a)) / outA;
  return [mix(0), mix(1), mix(2), outA * 255];
}

function pixelAt(x, y) {
  let c = [0, 0, 0, 0];

  // ---- 底层圆角方块 ----
  const plate = sdRoundRect(x, y, SIZE / 2, SIZE / 2, SIZE / 2 - PAD, SIZE / 2 - PAD, 190);
  const plateA = cover(plate);
  if (plateA <= 0) return [0, 0, 0, 0];

  // 底色：深蓝灰，左上偏亮
  const t = (x * 0.5 + y * 0.5) / SIZE;
  let bg = [lerp(64, 18, smooth(clamp(t * 1.15, 0, 1))),
    lerp(68, 21, smooth(clamp(t * 1.15, 0, 1))),
    lerp(80, 30, smooth(clamp(t * 1.15, 0, 1)))];

  // 斜向光柱：从左上打入
  const beamX = 250 + (y - 200) * 0.42;
  const beamW = 190;
  const beam = Math.exp(-(((x - beamX) / beamW) ** 2));
  const beamMask = clamp((y - PAD) / 520, 0, 1);
  bg = bg.map((v) => lerp(v, 255, beam * 0.30 * (1 - beamMask * 0.55)));

  // 底部微光晕（照片照亮底框）
  const glow = Math.exp(-(((x - 512) / 300) ** 2 + ((y - 560) / 240) ** 2));
  bg = bg.map((v, i) => lerp(v, [255, 240, 200][i], glow * 0.10));

  c = [bg[0], bg[1], bg[2], plateA * 255];

  // ---- 三张倾斜的照片卡（从后往前） ----
  const cards = [
    { cx: 512, cy: 560, hw: 250, hh: 168, ang: -0.30, tint: [96, 128, 176], alpha: 0.55 },
    { cx: 512, cy: 574, hw: 262, hh: 176, ang: -0.15, tint: [150, 168, 208], alpha: 0.72 },
    { cx: 512, cy: 590, hw: 274, hh: 184, ang: 0.0, tint: [246, 248, 252], alpha: 1.0 }
  ];

  for (const card of cards) {
    const sd = sdRotRect(x, y, card.cx, card.cy, card.hw, card.hh, card.ang, 18);
    const a = cover(sd) * card.alpha;
    if (a > 0) {
      // 卡面渐变（左上亮）
      const g = clamp(((x - (card.cx - card.hw)) / (card.hw * 2)) * 0.5 + ((y - (card.cy - card.hh)) / (card.hh * 2)) * 0.5, 0, 1);
      const col = card.tint.map((v, i) => lerp(v, [255, 255, 255][i], 0.18 * (1 - g)));
      c = over(c, col, a * 0.96);
    }
    // 卡片边缘高光
    if (sd > -2 && sd < 1.5) {
      c = over(c, [255, 255, 255], cover(sd) * 0.22 * card.alpha);
    }
  }

  // ---- 最前卡片上的「光斑」----
  const spotR = 74;
  const dSpot = Math.hypot(x - 430, y - 540);
  if (dSpot < spotR) {
    const a = (1 - dSpot / spotR) ** 2;
    c = over(c, [255, 226, 150], a * 0.95);
  }
  // 光斑外圈柔光
  const dGlow = Math.hypot(x - 430, y - 540);
  if (dGlow < spotR * 2.6) {
    const a = (1 - dGlow / (spotR * 2.6)) ** 3;
    c = over(c, [255, 214, 120], a * 0.35);
  }

  // ---- 右上角三色圆点：与 app 内「平台标记色点」呼应 ----
  const dots = [
    { x: 742, y: 452, col: [255, 59, 48] },
    { x: 782, y: 452, col: [52, 199, 89] },
    { x: 822, y: 452, col: [0, 174, 236] }
  ];
  for (const d of dots) {
    const dd = Math.hypot(x - d.x, y - d.y);
    // 白色描边
    if (dd < 26) c = over(c, [255, 255, 255], cover(26 - dd) * 0.95);
    if (dd < 21) c = over(c, d.col, cover(21 - dd));
  }

  // 整体圆角遮蔽
  c[3] = Math.min(c[3], plateA * 255);
  return c;
}

function build() {
  const SS = 3;
  const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
  for (let y = 0; y < SIZE; y += 1) {
    const rowStart = y * (SIZE * 4 + 1);
    raw[rowStart] = 0;
    for (let x = 0; x < SIZE; x += 1) {
      let r = 0; let g = 0; let b = 0; let a = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;
          const p = pixelAt(px, py);
          const al = p[3] / 255;
          r += p[0] * al; g += p[1] * al; b += p[2] * al; a += p[3];
        }
      }
      const n = SS * SS;
      const idx = rowStart + 1 + x * 4;
      const aa = a / n / 255;
      raw[idx] = Math.round(aa > 0 ? r / n / aa : 0);
      raw[idx + 1] = Math.round(aa > 0 ? g / n / aa : 0);
      raw[idx + 2] = Math.round(aa > 0 ? b / n / aa : 0);
      raw[idx + 3] = Math.round(a / n);
    }
  }

  const crcTable = [];
  for (let n = 0; n < 256; n += 1) {
    let cc = n;
    for (let k = 0; k < 8; k += 1) cc = cc & 1 ? 0xedb88320 ^ (cc >>> 1) : cc >>> 1;
    crcTable[n] = cc >>> 0;
  }
  const crc32 = (buf) => {
    let cc = 0xffffffff;
    for (const byte of buf) cc = crcTable[(cc ^ byte) & 0xff] ^ (cc >>> 8);
    return (cc ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const t = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

const out = process.argv[2] || path.join(__dirname, '..', 'build', 'icon-1024.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, build());
console.log(`图标已生成：${out}`);
