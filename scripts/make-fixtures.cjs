/**
 * 生成测试用照片集（多级目录 + 合成彩色照片）
 * 用法：node scripts/make-fixtures.cjs [目标目录]
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/** 生成一个 PNG（纯色 + 简单条纹），宽度/高度可调 */
function makePNG(w, h, rgb, stripe) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y += 1) {
    const rowStart = y * (w * 3 + 1);
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < w; x += 1) {
      const inStripe = stripe && Math.floor((x + y) / 40) % 2 === 0;
      const c = inStripe ? 255 - rgb[0] : rgb[0];
      const idx = rowStart + 1 + x * 3;
      raw[idx] = inStripe ? 255 - rgb[0] : rgb[0];
      raw[idx + 1] = inStripe ? rgb[1] : Math.max(0, rgb[1] - 40);
      raw[idx + 2] = inStripe ? rgb[2] : Math.max(0, rgb[2] - 80);
    }
  }
  const idat = zlib.deflateSync(raw, { level: 9 });

  const crcTable = [];
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
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
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

const palette = [
  [220, 90, 70], [70, 130, 200], [90, 180, 120], [200, 160, 60],
  [150, 90, 190], [60, 170, 180], [210, 120, 160], [120, 120, 200]
];

function build(root) {
  fs.mkdirSync(root, { recursive: true });
  const spec = {
    '2025 秋日街拍': [
      'DSC01001.png', 'DSC01002.png', 'DSC01003.png', 'DSC01004.png'
    ],
    '2025 秋日街拍/外滩': ['DSC01101.png', 'DSC01102.png', 'DSC01103.png'],
    '2025 秋日街拍/武康路': ['DSC01201.png', 'DSC01202.png'],
    '2026 春天 婚礼': ['IMG_2001.png', 'IMG_2002.png', 'IMG_2003.png'],
    '2026 春天 婚礼/仪式': ['IMG_2101.png', 'IMG_2102.png'],
    '2026 春天 婚礼/晚宴': ['IMG_2201.png', 'IMG_2202.png', 'IMG_2203.png'],
    '杂项': ['随手拍01.png', '随手拍02.png', '随手拍03.png', '随手拍04.png', '随手拍05.png']
  };
  // 已带标记的示例文件
  const marked = [
    ['2025 秋日街拍', 'DSC01005🔴.png'],
    ['2026 春天 婚礼', 'IMG_2004🔴🟢.png']
  ];
  // 非图片文件，验证被过滤
  const junk = [
    ['2025 秋日街拍', 'README.txt'],
    ['杂项', 'notes.md']
  ];

  let n = 0;
  for (const [dir, files] of Object.entries(spec)) {
    const abs = path.join(root, dir);
    fs.mkdirSync(abs, { recursive: true });
    for (const f of files) {
      const c = palette[n % palette.length];
      fs.writeFileSync(path.join(abs, f), makePNG(360, 270, c, n % 3 === 0));
      n += 1;
    }
  }
  for (const [dir, f] of marked) {
    const c = palette[(n += 1) % palette.length];
    fs.writeFileSync(path.join(root, dir, f), makePNG(360, 270, c, true));
  }
  for (const [dir, f] of junk) {
    fs.writeFileSync(path.join(root, dir, f), 'not an image\n');
  }
  // 隐藏文件也应被忽略
  fs.writeFileSync(path.join(root, '.DS_Store'), 'ignored');
  return root;
}

if (require.main === module) {
  const target = process.argv[2] || path.join(process.env.HOME, '.lightbox-test', '照片集');
  build(target);
  const count = fs.readdirSync(target, { recursive: true }).filter((f) => f.endsWith('.png')).length;
  console.log(`测试照片集已生成：${target}`);
  console.log(`PNG 数量：${count}`);
}
module.exports = { build, makePNG };
