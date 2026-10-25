# 贡献指南

## 开发流程

```bash
npm install
npm run dev        # 构建前端 + 启动 Electron
npm test           # 单元 + 集成测试
npm run e2e        # 界面端到端测试（自动截图）
```

## 代码约定

### 分层

| 层 | 路径 | 职责 | 约束 |
|---|---|---|---|
| 纯逻辑 | `src/lib/core.mjs` | 命名解析、批次计划、覆盖率分析 | **不得**引入 Node/Electron API，保证可单测 |
| 文件系统 | `electron/fs-ops.mjs` | 扫描、复制、改名、历史 | **不得**出现任何删除调用 |
| 主进程 | `electron/main.mjs` | 窗口、菜单、IPC 路由 | 业务逻辑尽量下沉到上面两层 |
| 渲染进程 | `src/**` | 界面与交互 | 通过 `window.lightbox` 走 IPC，无 Node 权限 |

### 安全红线

1. **禁止删除文件**。代码里不得出现 `fs.unlink`、`fs.rm`、`rimraf`、`fs.rmdir`。测试清理也只能针对自建的临时目录。
2. **禁止覆盖已有文件**。所有写入前必须先检测目标是否存在，冲突时追加序号或跳过。
3. **改动文件必须留痕**。任何改名/复制操作都要写入 `history.jsonl`，并支持撤销。
4. **不得绕过路径校验**。待发布目录不能位于摄影集内部。

### 前端

- 使用 `styles.css` 顶部定义的 CSS 变量，不要写死颜色值。
- 组件的交互回调尽量传**标识符**（如 `photo.path`），而不是整个对象 —— 对象闭包会在数据更新后过期。
- 事件处理里读状态时，以最新 `collection` 为准重新查询。

## 测试要求

提交前必须：

1. `npm test` 全绿
2. `npm run e2e` 全绿
3. 新增功能要同时补单元测试与 E2E 步骤

E2E 必须使用 CDP 真实事件（见 `scripts/e2e.cjs` 的 `mouseClick` / `key`），**不要**用 `el.click()` —— 它在 React 受控组件上不会可靠触发更新，会给出假绿。

## 打包

```bash
npm run dist
```

必须走 npm script（它带 `--config.afterSign=scripts/after-sign.cjs`）。直接调 electron-builder 会得到 linker-signed adhoc，应用启动即静默挂起。

验证：

```bash
codesign -dv release/mac-arm64/光匣.app | grep flags   # 需要 flags=0x2(adhoc)
```

## 提交信息

```
<类型>: <简述>

类型：feat / fix / refactor / test / docs / chore
```
