/** 渲染进程用的最小路径工具（不能直接引 node:path） */
export function dirname(p) {
  if (typeof p !== 'string') return '';
  const i = p.lastIndexOf('/');
  if (i <= 0) return i === 0 ? '/' : '';
  return p.slice(0, i);
}

export function basename(p) {
  if (typeof p !== 'string') return '';
  const i = p.lastIndexOf('/');
  return i === -1 ? p : p.slice(i + 1);
}

export function join(...parts) {
  return parts.filter(Boolean).join('/').replace(/\/{2,}/g, '/');
}

export default { dirname, basename, join };
