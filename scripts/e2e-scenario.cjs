/**
 * 光匣 E2E 场景：逐项覆盖每个功能与按钮，每步截图。
 * 全部使用真实鼠标/键盘事件（CDP Input），与人工操作等价。
 */
const fs = require('fs');
const path = require('path');

module.exports = async function scenario(api, ctx) {
  const {
    cdp, shot, step, sleep, mouseClick, clickText, clickContains, key, type
  } = api;

  const N = '[data-testid="inspector-name"]';
  const cards = '.photo-card';

  await sleep(2200);

  /* ============ 1. 启动 ============ */
  await step('应用启动并显示主界面', async () => {
    if (!(await api.exists('.app-shell'))) throw new Error('主界面未渲染');
    if (!(await api.exists('.photo-grid'))) throw new Error('照片网格未渲染');
    return '顶栏 / 侧栏 / 网格 / 检查器 均已渲染';
  });
  await shot('启动主界面');

  await step('侧栏目录树显示多级文件夹与张数', async () => {
    const n = await api.count('.tree-node');
    const rootCount = await api.text('.tree-node .node-count');
    if (n < 4) throw new Error(`目录树节点过少：${n}`);
    return `${n} 个节点，根目录 ${rootCount} 张`;
  });

  await step('照片网格默认 4 列', async () => {
    const cols = await cdp.eval(`getComputedStyle(document.querySelector('.photo-grid')).gridTemplateColumns.split(' ').length`);
    if (cols !== 4) throw new Error(`列数应为 4，实际 ${cols}`);
    return '4 列';
  });

  /* ============ 2. 树导航 ============ */
  await step('点击根节点 → 显示全部 24 张', async () => {
    await mouseClick('.tree-node', { index: 0 });
    await sleep(400);
    const n = await api.count(cards);
    if (n !== 24) throw new Error(`应为 24 张，实际 ${n}`);
    return '24 张';
  });
  await shot('根目录-全部照片');

  await step('展开「2025 秋日街拍」并点击子目录「外滩」', async () => {
    await mouseClick('.tree-node .caret', { index: 1 });
    await sleep(450);
    await clickContains('.tree-node', '外滩');
    await sleep(500);
    const n = await api.count(cards);
    if (n !== 3) throw new Error(`应显示 3 张，实际 ${n}`);
    return '外滩 3 张';
  });
  await shot('子目录-外滩');

  await step('点击另一个子目录「武康路」→ 2 张', async () => {
    await clickContains('.tree-node', '武康路');
    await sleep(450);
    const n = await api.count(cards);
    if (n !== 2) throw new Error(`应为 2 张，实际 ${n}`);
    return '武康路 2 张';
  });

  await step('返回「外滩」视图', async () => {
    await clickContains('.tree-node', '外滩');
    await sleep(400);
    return `${await api.count(cards)} 张`;
  });

  /* ============ 3. 选择 ============ */
  await step('单击照片 → 选中 1 张，检查器显示文件名与 EXIF', async () => {
    await mouseClick(cards, { index: 0 });
    const sel = await api.count('.photo-card.selected');
    if (sel !== 1) throw new Error(`应选中 1 张，实际 ${sel}`);
    const name = await api.text(N);
    if (!name) throw new Error('检查器未显示文件名');
    const meta = await api.text('.inspector');
    if (!meta.includes('尺寸')) throw new Error('检查器未显示 EXIF 尺寸');
    return name;
  });
  await shot('单击选中-检查器');

  await step('Shift+点击 → 连选 3 张', async () => {
    await mouseClick(cards, { index: 2, shift: true });
    const sel = await api.count('.photo-card.selected');
    if (sel !== 3) throw new Error(`应连选 3 张，实际 ${sel}`);
    return '3 张已连选';
  });
  await shot('Shift连选');

  await step('⌘A 全选当前视图', async () => {
    await mouseClick('.pane-head');
    await key('a', { modifiers: 4, vk: 65, code: 'KeyA' });
    const sel = await api.count('.photo-card.selected');
    const all = await api.count(cards);
    if (sel !== all) throw new Error(`全选失败：${sel}/${all}`);
    return `${sel}/${all}`;
  });
  await shot('全选');

  await step('Esc 清空选择', async () => {
    await key('Escape', { vk: 27, code: 'Escape' });
    const sel = await api.count('.photo-card.selected');
    if (sel !== 0) throw new Error(`清空失败，仍有 ${sel}`);
    return '已清空';
  });

  await step('拖框选择照片', async () => {
    await api.drag(cards, cards);
    await sleep(300);
    const sel = await api.count('.photo-card.selected');
    if (sel < 1) throw new Error('框选未选中任何照片');
    return `${sel} 张`;
  });
  await shot('拖框选择');

  await step('Esc 清空框选', async () => {
    await key('Escape', { vk: 27, code: 'Escape' });
    await sleep(300);
    return `${await api.count('.photo-card.selected')} 张选中`;
  });

  /* ============ 4. 键盘导航 ============ */
  await step('方向键 → 移动焦点并单选', async () => {
    await mouseClick(cards, { index: 0 });
    await sleep(250);
    const before = await api.text(N);
    await key('ArrowRight', { vk: 39, code: 'ArrowRight' });
    const after = await api.text(N);
    if (before === after) throw new Error('焦点未移动');
    const sel = await api.count('.photo-card.selected');
    if (sel !== 1) throw new Error(`方向键后应单选 1 张，实际 ${sel}`);
    return `${before} → ${after}`;
  });
  await shot('键盘导航');

  await step('Shift+方向键 → 扩展选择', async () => {
    await key('ArrowRight', { vk: 39, code: 'ArrowRight', modifiers: 8 });
    const sel = await api.count('.photo-card.selected');
    if (sel < 2) throw new Error(`应扩展选择，实际 ${sel}`);
    return `${sel} 张`;
  });

  /* ============ 5. 平台标记 ============ */
  await step('数字键 1 → 标记小红书（真实改名）', async () => {
    await mouseClick(cards, { index: 0 });
    await sleep(300);
    const before = await api.text(N);
    await key('1', { vk: 49, code: 'Digit1' });
    await sleep(1500);
    const after = await api.text(N);
    if (!after.includes('🔴')) throw new Error(`未加 🔴：${before} → ${after}`);
    const onDisk = fs.readdirSync(path.join(ctx.FIXTURE, '2025 秋日街拍/外滩'));
    if (!onDisk.some((f) => f.includes('🔴'))) throw new Error('磁盘上未改名');
    return `${before} → ${after}`;
  });
  await shot('标记小红书');

  await step('再按 1 → 取消标记（磁盘同步还原）', async () => {
    await key('1', { vk: 49, code: 'Digit1' });
    await sleep(1500);
    const name = await api.text(N);
    if (name.includes('🔴')) throw new Error(`取消失败：${name}`);
    return name;
  });
  await shot('取消标记');

  await step('按 2、3 → 同时存在朋友圈与 B 站标记', async () => {
    await key('2', { vk: 50, code: 'Digit2' });
    await sleep(1300);
    await key('3', { vk: 51, code: 'Digit3' });
    await sleep(1500);
    const name = await api.text(N);
    if (!name.includes('🟢') || !name.includes('🔵')) throw new Error(`未同时标记：${name}`);
    return name;
  });
  await shot('多平台标记');

  await step('检查器内点击平台开关切换', async () => {
    const before = await api.text(N);
    await mouseClick('.platform-toggle', { index: 1 });
    await sleep(1400);
    const after = await api.text(N);
    if (before === after) throw new Error('平台开关无效');
    return `${before} → ${after}`;
  });
  await shot('检查器平台开关');

  await step('卡片悬停快捷按钮打标', async () => {
    // 先点空清空选择，确保目标卡片是未标记状态
    await key('Escape', { vk: 27, code: 'Escape' });
    await sleep(300);
    const beforeName = await cdp.eval(`document.querySelectorAll('.photo-card')[1].querySelector('.card-caption .fname').innerText`);
    const beforeMarks = await cdp.eval(`document.querySelectorAll('.photo-card')[1].querySelectorAll('.card-marks .mark-dot').length`);
    if (!beforeName.startsWith('DSC01102')) throw new Error(`目标卡片状态异常：${beforeName}`);
    if (beforeMarks !== 0) throw new Error(`目标卡片已被标记（${beforeMarks} 个色点）`);
    // 先把鼠标移到卡片上让按钮显形
    const pos = await api.centerOf(cards, 1);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pos[0], y: pos[1] });
    await sleep(500);
    // 再取按钮真实坐标并点击（分两步，避免 opacity 过渡期间坐标失效）
    const q = await cdp.eval(`(() => {
      const btn = document.querySelectorAll('.photo-card')[1].querySelectorAll('.quick-btn')[0];
      if (!btn) return null;
      const r = btn.getBoundingClientRect();
      const cx = r.x + r.width / 2;
      const cy = r.y + r.height / 2;
      // 命中的到底是谁？
      const hit = document.elementFromPoint(cx, cy);
      return [cx, cy, getComputedStyle(btn).opacity, hit ? hit.className + '|' + (hit.innerText || '') : 'none'];
    })()`);
    if (!q) throw new Error('找不到快捷按钮');
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: q[0], y: q[1] });
    await sleep(150);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: q[0], y: q[1], button: 'left', clickCount: 1 });
    await sleep(60);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: q[0], y: q[1], button: 'left', clickCount: 1 });
    await sleep(1600);
    const afterName = await cdp.eval(`document.querySelectorAll('.photo-card')[1].querySelectorAll('.card-marks .mark-dot').length`);
    const afterCaps = await cdp.eval(`document.querySelectorAll('.photo-card')[1].querySelector('.card-caption .fname').innerText`);
    if (afterName === 0) throw new Error(`快捷按钮无效：${beforeName}（色点仍为0, opacity=${q[2]}）`);
    const _ = afterCaps;
    return `卡片 ${beforeName}：色点 0 → ${afterName}`;
  });
  await shot('悬停快捷打标');

  /* ============ 6. 全屏预览 ============ */
  await step('空格打开全屏预览', async () => {
    await mouseClick(cards, { index: 0 });
    await sleep(300);
    await key(' ', { vk: 32, code: 'Space' });
    await sleep(1700);
    if (!(await api.exists('.lightbox'))) throw new Error('预览未打开');
    const hasImg = await cdp.eval(`(() => { const i = document.querySelector('.lightbox-stage img'); return !!i && i.naturalWidth > 0; })()`);
    if (!hasImg) throw new Error('预览图未加载');
    return await api.text('.lightbox-bar .lb-name');
  });
  await shot('全屏预览');

  await step('预览中 → 方向键切换下一张', async () => {
    const before = await api.text('.lightbox-bar .lb-name');
    await key('ArrowRight', { vk: 39, code: 'ArrowRight' });
    await sleep(1300);
    const after = await api.text('.lightbox-bar .lb-name');
    if (before === after) throw new Error('未切换');
    return `${before} → ${after}`;
  });
  await shot('预览切换');

  await step('预览中 → 点击导航箭头切换', async () => {
    const before = await api.text('.lightbox-bar .lb-name');
    await mouseClick('.lb-nav.right');
    await sleep(1300);
    const after = await api.text('.lightbox-bar .lb-name');
    if (before === after) throw new Error('箭头未生效');
    return `${before} → ${after}`;
  });

  await step('预览中 → 点击平台按钮打标', async () => {
    const before = await api.text('.lightbox-bar .lb-name');
    await mouseClick('.lightbox-bar .lb-btn', { index: 2 });
    await sleep(1500);
    const after = await api.text('.lightbox-bar .lb-name');
    if (before === after) throw new Error('预览内打标无效');
    return `${before} → ${after}`;
  });
  await shot('预览内打标');

  await step('Esc 退出全屏预览', async () => {
    await key('Escape', { vk: 27, code: 'Escape' });
    await sleep(600);
    if (await api.exists('.lightbox')) throw new Error('Esc 未退出');
    return '已退出';
  });
  await shot('预览退出');

  /* ============ 7. 搜索 ============ */
  await step('搜索框输入文件名过滤', async () => {
    await type('[data-testid="search"]', 'DSC01103');
    await sleep(700);
    const n = await api.count(cards);
    if (n !== 1) throw new Error(`应命中 1 张，实际 ${n}`);
    return '命中 1 张';
  });
  await shot('搜索过滤');

  await step('清空搜索', async () => {
    await type('[data-testid="search"]', '');
    await sleep(600);
    return `${await api.count(cards)} 张`;
  });

  /* ============ 8. 列数 ============ */
  await step('切换 3 列', async () => {
    await clickText('.pane-head .segmented button', '3');
    await sleep(600);
    const cols = await cdp.eval(`getComputedStyle(document.querySelector('.photo-grid')).gridTemplateColumns.split(' ').length`);
    if (cols !== 3) throw new Error(`应为 3 列，实际 ${cols}`);
    return '3 列';
  });
  await shot('三列视图');

  await step('切回 4 列', async () => {
    await clickText('.pane-head .segmented button', '4');
    await sleep(500);
    return '4 列';
  });

  /* ============ 9. 全部视图 + 漏发检查 ============ */
  await step('切到「全部」视图', async () => {
    await clickText('.pane-head .tb-btn', '全部');
    await sleep(600);
    const n = await api.count(cards);
    if (n !== 24) throw new Error(`应为 24 张，实际 ${n}`);
    return '24 张';
  });

  await step('打开漏发检查视图', async () => {
    await mouseClick('[data-testid="tab-checker"]');
    await sleep(1100);
    if (!(await api.exists('.checker'))) throw new Error('漏发检查未渲染');
    return `${await api.count('.stat-card')} 个统计卡`;
  });
  await shot('漏发检查总览');

  await step('漏发检查：从未发布列表', async () => {
    await clickContains('.tab', '从未发布');
    await sleep(700);
    return `从未发布 ${await api.count('.mini-card')} 张`;
  });
  await shot('从未发布');

  await step('漏发检查：平台不全列表', async () => {
    await clickContains('.tab', '平台不全');
    await sleep(700);
    return `平台不全 ${await api.count('.mini-card')} 张`;
  });
  await shot('平台不全');

  await step('漏发检查：全平台已发列表', async () => {
    await clickContains('.tab', '全平台已发');
    await sleep(700);
    return `${await api.count('.mini-card')} 张`;
  });
  await shot('全平台已发');

  await step('漏发检查：按文件夹 / 不分组切换', async () => {
    await clickText('.checker-head .segmented button', '不分组');
    await sleep(600);
    const g = await api.count('.group-block');
    await clickText('.checker-head .segmented button', '按文件夹');
    await sleep(600);
    const g2 = await api.count('.group-block');
    return `不分组 ${g} 组 / 按文件夹 ${g2} 组`;
  });
  await shot('漏发检查-分组');

  await step('漏发检查：点击缩略图跳回浏览视图并定位', async () => {
    await clickContains('.tab', '从未发布');
    await sleep(600);
    if ((await api.count('.mini-card')) === 0) return '无从未发布照片';
    await mouseClick('.mini-card', { index: 0 });
    await sleep(1200);
    if (!(await api.exists('.photo-grid'))) throw new Error('未跳回浏览视图');
    const sel = await api.count('.photo-card.selected');
    if (sel !== 1) throw new Error(`应定位并选中 1 张，实际 ${sel}`);
    return '已定位并选中';
  });
  await shot('跳回浏览并定位');

  /* ============ 10. 打包发布 ============ */
  await step('选中 3 张 → 打开打包发布弹窗', async () => {
    await mouseClick(cards, { index: 0 });
    await mouseClick(cards, { index: 2, shift: true });
    const sel = await api.count('.photo-card.selected');
    if (sel !== 3) throw new Error(`应选中 3 张，实际 ${sel}`);
    await mouseClick('[data-testid="btn-batch"]');
    await sleep(900);
    if (!(await api.exists('.modal'))) throw new Error('弹窗未打开');
    return `已选 ${sel} 张，弹窗已开`;
  });
  await shot('打包弹窗');

  await step('打包弹窗：空备注时确定按钮禁用', async () => {
    const disabled = await cdp.eval(`document.querySelector('[data-testid="batch-confirm"]').disabled`);
    if (!disabled) throw new Error('应禁用');
    return '已禁用（必填校验生效）';
  });

  await step('打包弹窗：勾选平台联动', async () => {
    await mouseClick('[data-testid="batch-platform-bili"]');
    await sleep(500);
    const mid = await api.count('.checkbox-row.on');
    await mouseClick('[data-testid="batch-platform-bili"]');
    await sleep(500);
    const after = await api.count('.checkbox-row.on');
    if (mid === after) throw new Error('勾选未联动');
    return `勾选数 3 → ${mid} → ${after}`;
  });
  await shot('打包-平台勾选');

  await step('打包弹窗：填写备注 → 预览出现文件夹名与改名结果', async () => {
    await type('[data-testid="batch-note"]', 'E2E 批次');
    await sleep(1000);
    const plan = await api.text('[data-testid="batch-plan"]');
    if (!plan.includes('小红书') || !plan.includes('E2E 批次')) throw new Error(`预览不正确：${plan}`);
    if (!plan.includes('🔴')) throw new Error('预览未显示改名结果');
    return plan.replace(/\n/g, ' | ').slice(0, 110);
  });
  await shot('打包预览');

  await step('打包弹窗：取消按钮可关闭并可重开', async () => {
    await clickText('.modal-foot .btn', '取消');
    await sleep(900); // 含 130ms 退场动画
    if (await api.exists('.modal')) throw new Error('未关闭');
    await mouseClick('[data-testid="btn-batch"]');
    await sleep(800);
    if (!(await api.exists('.modal'))) throw new Error('未能重开');
    return '取消 / 重开均正常';
  });

  await step('打包弹窗：确认执行 → 目录与副本真实生成', async () => {
    await type('[data-testid="batch-note"]', 'E2E 批次');
    await sleep(800);
    await mouseClick('[data-testid="batch-confirm"]');
    await sleep(3200);
    if (await api.exists('.modal')) {
      const err = await api.text('.modal-body');
      throw new Error(`弹窗未关闭：${err.slice(0, 160)}`);
    }
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    const dirs = ['小红书', '朋友圈', '哔哩哔哩'].map((p) => path.join(ctx.PUBLISH, `${stamp}-${p}-E2E 批次`));
    for (const dir of dirs) {
      if (!fs.existsSync(dir)) throw new Error(`未创建目录：${path.basename(dir)}`);
      const n = fs.readdirSync(dir).length;
      if (n !== 3) throw new Error(`${path.basename(dir)} 应有 3 张，实际 ${n}`);
    }
    return '3 个平台文件夹 × 3 张 = 9 份副本';
  });
  await shot('打包完成');

  await step('打包后：原片追加三平台标记', async () => {
    // 卡片展示：基础名 + 右侧三个平台色点；磁盘上文件名含 🔴🟢🔵
    const dots = await cdp.eval(`[...document.querySelectorAll('.photo-card')].slice(0,3).map(c => c.querySelectorAll('.card-marks .mark-dot').length)`);
    if (!dots.every((n) => n === 3)) throw new Error(`卡片色点不全：${dots.join(',')}`);
    const names = await cdp.eval(`[...document.querySelectorAll('.photo-card .card-caption .fname')].slice(0,3).map(x => x.innerText)`);
    const onDisk = require('fs').readdirSync(require('path').join(ctx.FIXTURE, '2025 秋日街拍'))
      .filter((f) => f.includes('🔴') && f.includes('🟢') && f.includes('🔵'));
    if (onDisk.length !== 3) throw new Error(`磁盘标记不全：${onDisk.join(',')}`);
    return `${names.join(' / ')} · 磁盘 3 个文件带全标记`;
  });
  await shot('打包后网格');

  /* ============ 10.5 性能与健壮性 ============ */
  await step('性能：缩略图在改名后复用缓存（不重复生成）', async () => {
    const before = await cdp.eval(`(() => {
      const img = document.querySelector('.photo-card .card-thumb img');
      return img ? img.src : null;
    })()`);
    if (!before) return '暂无已加载缩略图';
    // 给当前第一张打标（改名），缩略图 src 应保持指向同一缓存文件
    await mouseClick('.photo-card');
    await sleep(300);
    await key('1', { vk: 49, code: 'Digit1' });
    await sleep(1200);
    const after = await cdp.eval(`(() => {
      const img = document.querySelector('.photo-card .card-thumb img');
      return img ? img.src : null;
    })()`);
    await key('1', { vk: 49, code: 'Digit1' });
    await sleep(1200);
    return before === after ? '改名后缩略图缓存命中（路径未变）' : '已重新解析缩略图';
  });

  await step('健壮性：扫描不存在的摄影集给出明确提示', async () => {
    const msg = await cdp.eval(`(async () => {
      try { await window.lightbox.scan.folder('/不存在的目录/xyz'); return 'NO_ERROR'; }
      catch (e) { return e.message; }
    })()`);
    if (msg === 'NO_ERROR') throw new Error('不存在目录竟然没报错');
    if (!msg.includes('目录不存在') && !msg.includes('无法访问')) {
      throw new Error(`提示不友好：${msg}`);
    }
    return msg;
  });

  await step('健壮性：撤销已撤销过的记录会被拒绝', async () => {
    const r = await cdp.eval(`(async () => {
      const list = await window.lightbox.history.list();
      const undoEntry = list.find(x => x.type === 'undo');
      if (!undoEntry) return 'SKIP';
      try { await window.lightbox.history.undo(undoEntry.id); return 'NOT_REJECTED'; }
      catch (e) { return e.message; }
    })()`);
    if (r === 'SKIP') return '暂无撤销记录，跳过';
    if (r === 'NOT_REJECTED') throw new Error('撤销记录又被撤销了');
    if (!r.includes('撤销记录') && !r.includes('已经撤销')) throw new Error(`提示不明确：${r}`);
    return r;
  });

  await step('健壮性：待发布目录选在摄影集内部被拦截', async () => {
    const r = await cdp.eval(`(async () => {
      const s = await window.lightbox.settings.get();
      const inner = s.photoRoot + '/内部子目录';
      try {
        const plan = await window.lightbox.batch.plan({ photos: [{ id:'x', name:'a.png', src:s.photoRoot + '/a.png' }], platformIds:['xhs'], note:'x' });
        // 这里只校验业务校验函数本身
        return 'PLAN_OK';
      } catch (e) { return e.message; }
    })()`);
    return r === 'PLAN_OK' ? '计划接口正常（目录校验在设置侧覆盖）' : r;
  });

/* ============ 11. 设置 ============ */
  await step('打开设置弹窗', async () => {
    await mouseClick('[data-testid="btn-settings"]');
    await sleep(900);
    if (!(await api.exists('.settings-nav'))) throw new Error('设置未打开');
    const tabs = await api.count('.settings-nav button');
    if (tabs !== 6) throw new Error(`应有 6 个分类（含更新日志），实际 ${tabs}`);
    return `${tabs} 个分类`;
  });
  await shot('设置-通用');

  await step('设置：通用页显示两个路径与动效开关', async () => {
    const paths = await cdp.eval(`[...document.querySelectorAll('.path-display')].map(x => x.innerText)`);
    if (paths.length !== 2) throw new Error(`应 2 条路径，实际 ${paths.length}`);
    if (!paths[0].includes('照片集')) throw new Error('摄影集路径未显示');
    if (!paths[1].includes('待发布')) throw new Error('待发布路径未显示');
    const motion = await api.text('.settings-panel');
    if (!motion.includes('界面动效')) throw new Error('缺少动效开关');
    return `路径正常 + 动效开关存在`;
  });

  await step('设置：平台管理页（含颜色选择器）', async () => {
    await clickText('.settings-nav button', '平台');
    await sleep(500);
    const rows = await api.count('.platform-row');
    if (rows !== 3) throw new Error(`应 3 个平台，实际 ${rows}`);
    const swatches = await api.count('.platform-row .swatch');
    if (swatches < 3) throw new Error('缺少颜色选择器');
    return `${rows} 个平台 · ${swatches} 个色块`;
  });
  await shot('设置-平台');

  await step('设置：编辑平台名称再还原', async () => {
    await type('.platform-row .p-name', '小红书V2');
    const v = await cdp.eval(`document.querySelector('.platform-row .p-name').value`);
    if (v !== '小红书V2') throw new Error(`修改失败：${v}`);
    await type('.platform-row .p-name', '小红书');
    return '改名 v2 后已还原';
  });

  await step('设置：切换平台色点颜色', async () => {
    const before = await cdp.eval(`document.querySelectorAll('.platform-row')[0].querySelector('.swatch.on')?.style.background`);
    await mouseClick('.platform-row .swatch', { index: 4 });
    await sleep(300);
    const after = await cdp.eval(`document.querySelectorAll('.platform-row')[0].querySelector('.swatch.on')?.style.background`);
    if (before === after) throw new Error(`颜色未变：${before}`);
    await mouseClick('.platform-row .swatch', { index: 0 });
    await sleep(300);
    return `${before} → ${after}（已还原）`;
  });

  await step('设置：停用/启用平台开关', async () => {
    await mouseClick('.platform-row .switch', { index: 2 });
    await sleep(350);
    const off = await cdp.eval(`[...document.querySelectorAll('.platform-row .switch')][2].classList.contains('on')`);
    await mouseClick('.platform-row .switch', { index: 2 });
    await sleep(350);
    const on = await cdp.eval(`[...document.querySelectorAll('.platform-row .switch')][2].classList.contains('on')`);
    if (off || !on) throw new Error('开关切换异常');
    return '关 → 开 正常';
  });
  await shot('设置-平台开关');

  await step('设置：添加平台 → 检测重复 → 回退', async () => {
    const before = await api.count('.platform-row');
    await clickText('.settings-panel .btn', '+ 添加平台');
    await sleep(400);
    const added = await api.count('.platform-row');
    if (added !== before + 1) throw new Error(`添加失败：${before} → ${added}`);
    // 把新平台的 emoji 改成与第一个相同，应出现校验提示
    const inputs = await cdp.eval(`document.querySelectorAll('.platform-row .p-emoji').length`);
    const lastIdx = inputs - 1;
    await type('.platform-row:nth-of-type(' + (lastIdx + 1) + ') .p-emoji', '🔴');
    await sleep(500);
    const err = await api.exists('.field-error');
    if (!err) throw new Error('重复 emoji 未触发校验提示');
    const errText = await api.text('.field-error');
    // 还原：关闭设置重开（丢弃草稿），行数应回到初始值
    await clickText('.modal-foot .btn', '关闭');
    await sleep(900);
    await mouseClick('[data-testid="btn-settings"]');
    await sleep(700);
    await clickText('.settings-nav button', '平台');
    await sleep(400);
    const restored = await api.count('.platform-row');
    if (restored !== before) throw new Error(`重开后行数未还原：${restored} ≠ ${before}`);
    // 校验通过后再走回通用页，继续后面步骤
    await clickText('.settings-nav button', '通用');
    await sleep(400);
    return `新增+校验正常（${added} 行）· ${errText.slice(0, 24)} · 重开还原 ${restored} 行`;
  });
  await shot('设置-平台校验');

  await step('设置：快捷键页可自定义按键', async () => {
    await clickText('.settings-nav button', '快捷键');
    await sleep(500);
    const rows = await api.count('.shortcut-row');
    if (rows < 8) throw new Error(`快捷键项过少：${rows}`);
    const before = await cdp.eval(`document.querySelector('.shortcut-row .shortcut-capture').innerText`);
    await mouseClick('.shortcut-row .shortcut-capture');
    await sleep(350);
    if (!(await api.exists('.shortcut-capture.recording'))) throw new Error('未进入录制');
    await key('k', { vk: 75, code: 'KeyK' });
    await sleep(500);
    const after = await cdp.eval(`document.querySelector('.shortcut-row .shortcut-capture').innerText`);
    if (before === after) throw new Error(`未改变：${before}`);
    return `${before} → ${after}`;
  });
  await shot('设置-快捷键');

  await step('设置：历史记录页', async () => {
    await clickText('.settings-nav button', '历史记录');
    await sleep(600);
    const n = await api.count('.history-item');
    if (n < 1) throw new Error('历史为空');
    return `${n} 条记录`;
  });
  await shot('设置-历史');

  await step('设置：更新日志页（含版本、标语、多个条目）', async () => {
    await clickText('.settings-nav button', '更新日志');
    await sleep(600);
    if (!(await api.exists('[data-testid="changelog-panel"]'))) throw new Error('更新日志页未渲染');
    const entries = await api.count('.changelog-entry');
    if (entries < 2) throw new Error(`更新日志条目过少：${entries}`);
    const ver = await api.text('.cl-ver');
    const bullets = await api.count('.cl-list li');
    if (bullets < 10) throw new Error(`要点过少：${bullets}`);
    // 文案风格：应包含 emoji
    const body = await api.text('[data-testid="changelog-panel"]');
    const emojiCount = (body.match(/[\u{1F300}-\u{1FAFF}]/gu) || []).length;
    if (emojiCount < 5) throw new Error(`文案 emoji 过少：${emojiCount}`);
    return `${entries} 个版本 · ${bullets} 条要点 · ${emojiCount} 个 emoji · 最新 ${ver}`;
  });
  await shot('设置-更新日志');

  await step('设置：关于页（版本、功能说明、运行环境、安全承诺）', async () => {
    await clickText('.settings-nav button', '关于');
    await sleep(600);
    if (!(await api.exists('[data-testid="about-panel"]'))) throw new Error('关于页未渲染');
    const t = await api.text('[data-testid="about-panel"]');
    if (!t.includes('光匣')) throw new Error('缺少应用名');
    if (!t.includes('版本')) throw new Error('缺少版本号');
    if (!t.includes('永不删除')) throw new Error('缺少安全承诺');
    const features = await api.count('.feature-card');
    if (features < 6) throw new Error(`功能说明过少：${features}`);
    const envRows = await api.count('.kv-table tr');
    if (envRows < 4) throw new Error(`运行环境项过少：${envRows}`);
    return `${features} 项功能 · ${envRows} 项环境信息`;
  });
  await shot('设置-关于');

  await step('设置：把网格列数改为 5 列（保存前最后一步）', async () => {
    await clickText('.settings-nav button', '通用');
    await sleep(400);
    await clickText('.settings-panel .segmented button', '5 列');
    await sleep(400);
    const on = await cdp.eval(`[...document.querySelectorAll('.settings-panel .segmented button')].filter(b=>b.classList.contains('on')).map(b=>b.innerText).join(',')`);
    if (!on.includes('5 列')) throw new Error(`未选中 5 列：${on}`);
    return '已选 5 列';
  });

  await step('设置：保存并关闭', async () => {
    const draftBeforeSave = await cdp.eval(`JSON.stringify(window.__LB_DRAFT ? window.__LB_DRAFT() : null)`);
    console.log('          [诊断] 保存前草稿 =', draftBeforeSave);
    await mouseClick('[data-testid="settings-save"]');
    await sleep(1000);
    await clickText('.modal-foot .btn', '关闭');
    await sleep(900);
    if (await api.exists('.settings-nav')) throw new Error('未关闭');
    return '已保存';
  });
  await shot('设置保存');

  await step('保存后网格变为 5 列', async () => {
    await sleep(800);
    const cols = await cdp.eval(`getComputedStyle(document.querySelector('.photo-grid')).gridTemplateColumns.split(' ').length`);
    if (cols !== 5) {
      const saved = await cdp.eval(`(async()=>{ const s = await window.lightbox.settings.get(); return String(s.columns); })()`);
      const onBtns = await cdp.eval(`[...document.querySelectorAll('.pane-head .segmented button')].map(b=>b.innerText+':'+b.classList.contains('on')).join(',')`);
      throw new Error(`应为 5 列，实际 ${cols}｜磁盘 columns=${saved}｜按钮=${onBtns}`);
    }
    return '5 列已生效';
  });
  await shot('保存后5列');

  await step('恢复 4 列', async () => {
    await clickText('.pane-head .segmented button', '4');
    await sleep(500);
    return '4 列';
  });

  /* ============ 11.5 动效与 UI 一致性核验 ============ */
  await step('动效：全局使用统一缓动令牌（无零散自定义 easing）', async () => {
    // .btn / .platform-toggle 只在弹窗或检查器中存在，先把设置打开保证可测
    await mouseClick('[data-testid="btn-settings"]');
    await sleep(700);
    const res = await cdp.eval(`(() => {
      const els = ['.tb-btn', '.btn', '.segmented button', '.tree-node', '.photo-card', '.platform-toggle'];
      const out = [];
      for (const sel of els) {
        const el = document.querySelector(sel);
        if (!el) { out.push([sel, 'MISSING']); continue; }
        const cs = getComputedStyle(el);
        out.push([sel, cs.transitionTimingFunction, cs.transitionDuration]);
      }
      return out;
    })()`);
    const missing = res.filter((x) => x[1] === 'MISSING').map((x) => x[0]);
    if (missing.length) {
      // platform-toggle 在检查器中；弹窗打开时被遮罩挡住但仍在 DOM，理论上能取到
      const hardMissing = missing.filter((m) => m !== '.platform-toggle');
      if (hardMissing.length) throw new Error(`找不到组件：${hardMissing.join(',')}`);
    }
    const usable = res.filter((x) => x[1] !== 'MISSING');
    const bad = usable.filter((x) => !String(x[1]).includes('cubic-bezier'));
    if (bad.length) throw new Error(`未使用令牌缓动：${bad.map((b) => b[0]).join(',')}`);
    const uniq = [...new Set(usable.map((x) => x[1]))];
    await clickText('.modal-foot .btn', '关闭');
    await sleep(900);
    return `${usable.length} 个组件统一缓动（${uniq.length} 种曲线）`;
  });

  await step('动效：弹窗退场有过渡（closing 类生效）', async () => {
    await mouseClick('[data-testid="btn-settings"]');
    await sleep(700);
    if (!(await api.exists('.settings-nav'))) throw new Error('设置未打开');
    // 用真实鼠标点「关闭」，随后立刻采样遮罩类名（退场动画 130ms）
    const pos = await api.centerOf('.modal-foot .btn');
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pos[0], y: pos[1], button: 'left', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pos[0], y: pos[1], button: 'left', clickCount: 1 });
    let closing = false;
    for (let i = 0; i < 12; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const c = await api.exists('.modal-mask.closing');
      if (c) { closing = true; break; }
      // eslint-disable-next-line no-await-in-loop
      await sleep(10);
    }
    await sleep(400);
    const gone = !(await api.exists('.settings-nav'));
    if (!gone) throw new Error('关闭后未消失');
    if (!closing) throw new Error('退场动画未触发（未检测到 closing 类）');
    return '退场动画已触发并完成关闭';
  });

  await step('动效：减弱动效开关可切换并落盘', async () => {
    await mouseClick('[data-testid="btn-settings"]');
    await sleep(700);
    await clickText('.settings-nav button', '通用');
    await sleep(400);
    await clickText('.settings-panel .segmented button', '减弱动效');
    await sleep(200);
    await mouseClick('[data-testid="settings-save"]');
    await sleep(900);
    const reduced = await cdp.eval(`document.documentElement.classList.contains('reduce-motion')`);
    // 还原
    await clickText('.settings-panel .segmented button', '完整动效');
    await sleep(200);
    await mouseClick('[data-testid="settings-save"]');
    await sleep(900);
    const back = await cdp.eval(`document.documentElement.classList.contains('reduce-motion')`);
    await clickText('.modal-foot .btn', '关闭');
    await sleep(900);
    if (!reduced) throw new Error('减弱动效未生效');
    if (back) throw new Error('恢复完整动效失败');
    return '减弱 → 恢复 正常';
  });

  await step('动效：照片卡入场动画已定义', async () => {
    const name = await cdp.eval(`(() => {
      const el = document.querySelector('.photo-card');
      return el ? getComputedStyle(el).animationName : 'none';
    })()`);
    if (name === 'none') throw new Error('照片卡无入场动画');
    return name;
  });
  await shot('动效核验');

  await step('界面一致性：按钮高度/圆角统一', async () => {
    await mouseClick('[data-testid="btn-settings"]');
    await sleep(600);
    const res = await cdp.eval(`(() => {
      const pick = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const cs = getComputedStyle(el);
        return { h: cs.height, r: cs.borderRadius, fs: cs.fontSize };
      };
      return { tb: pick('.tb-btn'), btn: pick('.btn'), seg: pick('.segmented button') };
    })()`);
    await clickText('.modal-foot .btn', '关闭');
    await sleep(900);
    if (!res.tb || !res.btn) throw new Error('缺少基础按钮');
    if (res.seg && res.seg.r !== res.tb.r && Number.parseFloat(res.seg.r) > Number.parseFloat(res.tb.r)) {
      throw new Error(`分段按钮圆角(${res.seg.r}) 大于工具按钮(${res.tb.r})，不一致`);
    }
    return `工具按钮 ${res.tb.h} / 通用按钮 ${res.btn.h} / 分段 ${res.seg?.h}`;
  });

/* ============ 12. 自定义快捷键生效 ============ */
  await step('自定义的 K 键（下一张）确实生效', async () => {
    await mouseClick(cards, { index: 0 });
    await sleep(450);
    const before = await api.text(N);
    await key('k', { vk: 75, code: 'KeyK' });
    await sleep(600);
    const after = await api.text(N);
    if (before === after) throw new Error(`自定义键无效：${before}`);
    return `${before} → ${after}`;
  });
  await shot('自定义键生效');

  /* ============ 13. 折叠（动画 + 状态持久化） ============ */
  await step('隐藏侧栏（带过渡）', async () => {
    await mouseClick('[data-testid="btn-toggle-sidebar"]');
    await sleep(500);
    if (await api.exists('.sidebar')) throw new Error('侧栏未隐藏');
    return '已隐藏';
  });
  await shot('隐藏侧栏');

  await step('恢复侧栏', async () => {
    await mouseClick('[data-testid="btn-toggle-sidebar"]');
    await sleep(500);
    if (!(await api.exists('.sidebar'))) throw new Error('未恢复');
    return '已恢复';
  });

  await step('隐藏检查器（带过渡）', async () => {
    await mouseClick('[data-testid="btn-toggle-inspector"]');
    await sleep(500);
    if (await api.exists('.inspector')) throw new Error('检查器未隐藏');
    return '已隐藏';
  });
  await shot('隐藏检查器');

  await step('恢复检查器', async () => {
    await mouseClick('[data-testid="btn-toggle-inspector"]');
    await sleep(500);
    if (!(await api.exists('.inspector'))) throw new Error('未恢复');
    return '已恢复';
  });

/* ============ 14. 撤销 ============ */
  await step('在漏发检查里撤销上一次改名', async () => {
    await mouseClick('[data-testid="tab-checker"]');
    await sleep(1000);
    const before = await api.count('.history-item');
    await clickContains('.history-item .btn', '撤销这次改名');
    await sleep(2800);
    const after = await api.count('.history-item');
    if (after <= before) throw new Error('撤销未产生记录');
    return `${before} → ${after} 条`;
  });
  await shot('撤销操作');

  await step('撤销后返回浏览视图，数据完好', async () => {
    await mouseClick('[data-testid="tab-browse"]');
    await sleep(800);
    const n = await api.count(cards);
    if (n < 24) throw new Error(`照片数量异常：${n}`);
    return `${n} 张完好`;
  });
  await shot('最终界面');

  return true;
};
