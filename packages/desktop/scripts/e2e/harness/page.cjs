/**
 * 页面操作原语。
 *
 * 这一层是上一代脚本最大的教训所在：**不许用固定 sleep 等界面**。
 * 老脚本里 `sleep(6000)` 那种写法在机器空闲时刚好够、机器一忙就假失败 ——
 * 我这一轮就撞上了（同一份产物，有时全绿、有时"页面空白"、有时截图拿不到帧，
 * 全是"等得不够/等错了东西"，而不是被测代码坏了）。
 *
 * 所以这里的每条等待都是**条件等待**：轮询一个明确的判据，超时就把判据本身报出来。
 * 判据一律用"页面自己暴露的结构"，不用"猜多久之后应该好了"。
 *
 * 另外两个刻意的选择：
 * - **点击默认走真实鼠标**（`Input.dispatchMouseEvent`）：合成 `el.click()` 不走命中测试，
 *   触发不了 CSS `:hover`、触发不了依赖坐标的逻辑。需要绕过时才用 `{ via: 'dom' }`。
 * - **悬停必须先移开再移上去**：鼠标已经在元素上时再 move 到同一个点，
 *   浏览器不产生新的 hover 变化（老脚本在这里吃过一次假失败）。
 */

const { sleep } = require('./cdp.cjs');

/** 页面根节点上的 `data-view` 标记，用来确认"路由内容真的挂载了"（而不是只有外壳） */
const VIEW_ATTR = 'data-view';

function createPage(cdp, options = {}) {
  const defaultTimeout = options.timeoutMs ?? 20000;
  const interval = options.intervalMs ?? 120;

  async function evaluate(expression, evalOptions) {
    return cdp.evaluate(expression, evalOptions);
  }

  async function json(expression, evalOptions) {
    return cdp.json(expression, evalOptions);
  }

  /**
   * 轮询直到表达式返回真值。
   *
   * 失败时抛出的错误里带上**判据本身**与最后一次的实际值 ——
   * "等待超时"这句话没有信息量，"等待 [data-view=calendar] 出现，实际 hash=#/workbench、DOM 里没有该元素"
   * 才能直接指向问题。
   */
  async function waitFor(expression, { label, timeoutMs = defaultTimeout } = {}) {
    const deadline = Date.now() + timeoutMs;
    let last;
    let lastError = null;
    while (Date.now() < deadline) {
      try {
        last = await evaluate(expression);
        if (last) return last;
      } catch (error) {
        lastError = error; // 页面正在切换时求值可能瞬时失败，不算致命，继续轮询
      }
      await sleep(interval);
    }
    const detail = lastError ? `（最后一次求值出错：${lastError.message}）` : `（最后一次结果：${JSON.stringify(last)}）`;
    throw new Error(`等待超时：${label ?? expression}${detail}`);
  }

  /**
   * 等**有限时长**的动画播完 —— 比"再睡 500ms"靠谱得多。
   *
   * 刻意跳过 `iterations: Infinity` 的动画：总览那个自转的图盘是无限动画，
   * 等它等于永远等不到，会把每个动作都拖成超时。
   * 判据写成"没有在跑的有限动画"。
   */
  async function animationsSettled({ timeoutMs = 6000 } = {}) {
    await waitFor(
      `document.getAnimations().every((a) => {
        const timing = a.effect && a.effect.getTiming ? a.effect.getTiming() : {};
        return timing.iterations === Infinity || a.playState !== 'running';
      })`,
      { label: '页面上的有限动画都播完', timeoutMs },
    );
  }

  async function box(selector) {
    return json(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return 'null';
        const r = el.getBoundingClientRect();
        return JSON.stringify({ x: r.x, y: r.y, width: r.width, height: r.height,
          cx: r.x + r.width / 2, cy: r.y + r.height / 2, visible: r.width > 0 && r.height > 0 }); })()`,
    );
  }

  async function count(selector) {
    return evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).length`);
  }

  async function exists(selector) {
    return evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`);
  }

  async function text(selector) {
    return evaluate(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)});
        return el ? (el.textContent || '').replace(/\\s+/g, ' ').trim() : null; })()`,
    );
  }

  async function attr(selector, name) {
    return evaluate(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? el.getAttribute(${JSON.stringify(name)}) : null; })()`,
    );
  }

  /** 真实鼠标移动（先移开再移上去，确保产生 hover 变化） */
  async function hover(selector) {
    const target = await box(selector);
    if (!target || !target.visible) throw new Error(`悬停失败：${selector} 不存在或不可见`);

    await sendMouse('mouseMoved', 4, 4);
    await sleep(60);
    await sendMouse('mouseMoved', target.cx, target.cy);
    // 一次没生效就再移一次（老脚本同样处理过：偶发第一次不触发）
    await sleep(120);
    await sendMouse('mouseMoved', target.cx + 1, target.cy + 1);
    await sleep(120);
  }

  async function click(selector, { via = 'mouse', settle = true } = {}) {
    if (via === 'dom') {
      const ok = await evaluate(
        `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`,
      );
      if (!ok) throw new Error(`点击失败：${selector} 不存在`);
      return;
    }

    /*
     * 点击前先等有限动画落定，再**把目标滚进视野**。
     *
     * 工作台的进层动画会让卡片"从锚卡位置飞出来"，动画途中卡片的位置一直在变 ——
     * 此时按坐标点下去会打空（表现成"点了没反应"，而实际是点在了半路上）。
     * 这是上一代脚本用 `sleep(1800)` 硬扛的问题，这里按动画状态等。
     *
     * 滚动这一条是设置页那次踩到的：页面很长，目标按钮在视口外时
     * `getBoundingClientRect()` 给的是屏幕外的坐标，CDP 照样"点"下去 ——
     * 结果是**静默点空**（没有报错、没有事件），排查时只能靠猜。
     * 所以这里先 `scrollIntoView`，点完再核对坐标确实在视口内。
     */
    if (settle) await animationsSettled({ timeoutMs: 4000 }).catch(() => undefined);

    const viewport = await json('(() => JSON.stringify({ w: innerWidth, h: innerHeight }))()');
    const inViewport = (b) =>
      Boolean(b) && b.visible && b.cx >= 0 && b.cy >= 0 && b.cx <= viewport.w && b.cy <= viewport.h;

    let target = await box(selector);

    /*
     * 光看"在不在窗口里"还不够：**可滚动祖先会把元素裁掉**。
     *
     * 这是新建项目向导变高之后踩到的真事：向导内容区有了自己的滚动条（`overflow-y: auto`），
     * 某个复选框虽然"窗口坐标在视口内"，实际被内容区裁在可视范围之外 ——
     * 按坐标点下去落在容器的裁剪区上，**静默点空**：没有报错，只是那一勾没生效，
     * 后面报出来的是"安装没被跳过"这种离现场很远的症状。
     * 所以这里把"被祖先裁掉"也算作不可点，走同一条 scrollIntoView 的路。
     */
    const clippedByAncestor = async () =>
      evaluate(
        `(() => { const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return true;
          const r = el.getBoundingClientRect();
          const cx = r.x + r.width / 2;
          const cy = r.y + r.height / 2;
          for (let p = el.parentElement; p; p = p.parentElement) {
            const style = getComputedStyle(p);
            const scrollable = /(auto|scroll|hidden)/.test(style.overflowY) || /(auto|scroll|hidden)/.test(style.overflowX);
            if (!scrollable) continue;
            const pr = p.getBoundingClientRect();
            if (pr.height === 0 || pr.width === 0) continue;
            if (cx < pr.left || cx > pr.right || cy < pr.top || cy > pr.bottom) return true;
          }
          return false; })()`,
      );

    if (inViewport(target) && (await clippedByAncestor())) {
      await evaluate(
        `(() => { const el = document.querySelector(${JSON.stringify(selector)});
          if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center', inline: 'nearest' });
          return 1; })()`,
      );
      await sleep(150);
      target = await box(selector);
    }
    if (!target || !target.visible) throw new Error(`点击失败：${selector} 不存在或不可见`);

    /*
     * **只在目标确实在视口外时才滚动**。
     *
     * 一上来就无条件 `scrollIntoView` 会踩到另一个坑：对**浮层里的元素**（例如下拉选项）
     * 滚动会让 Naive 认为"用户滚走了"从而关掉浮层 —— 于是标记好的选项瞬间不可见，
     * 报出来是"元素不存在或不可见"，方向完全错了（实测：日志页的级别下拉就栽在这）。
     * 目标本来就在视野里时，什么都不做才是最安全的。
     */
    if (!inViewport(target)) {
      await evaluate(
        `(() => { const el = document.querySelector(${JSON.stringify(selector)});
          if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center', inline: 'nearest' });
          return 1; })()`,
      );
      await sleep(150);
      target = await box(selector);
      if (!target || !target.visible || !inViewport(target)) {
        throw new Error(
          `点击失败：${selector} 滚动后仍不可点（中心 ${target ? `${Math.round(target.cx)},${Math.round(target.cy)}` : '未知'}，` +
            `视口 ${viewport.w}×${viewport.h}）—— 按坐标点会静默点空，所以直接报错`,
        );
      }
    }

    /*
     * 先移上去、**再量一次**，最后才按下。
     *
     * 这条是被"悬停才出现的控件"教出来的：工作台卡片右侧的「详情」入口平时
     * `opacity: 0` + `translateX(100%)` 藏在卡片外，鼠标没移上去之前量到的位置是**滑动前的**，
     * 照着那个坐标点就打在卡片边缘上（现象是"点了没反应"）。真人操作本来就是
     * "移过去 → 看到按钮 → 再点"，这里照做：移入 → 等一下 → 重新量 → 点。
     */
    await sendMouse('mouseMoved', target.cx, target.cy);
    /*
     * 悬停往往会**触发一段过渡**（卡片右侧的「详情」入口是 `opacity 0 → 1` +
     * `translateX(100%) → 0`）。过渡没播完就量坐标，量到的是滑动途中的位置 ——
     * 点下去可能落在底下的卡片本体上（现象是"想开详情、结果进了下一层"）。
     *
     * 只靠 `animationsSettled()` 还不够：过渡可能在前一次采样之前就结束了，
     * 采样本身也可能刚好落在动画的某一帧上。所以这里直接盯**最终的不变量**：
     * 元素的包围盒连续两次采样不再变化，才算"停下来了"。
     */
    await animationsSettled({ timeoutMs: 2000 }).catch(() => undefined);
    let stable = target;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await sleep(100);
      const now = await box(selector);
      if (!now || !now.visible) break;
      stable = now;
      if (Math.abs(now.cx - target.cx) < 0.5 && Math.abs(now.cy - target.cy) < 0.5) break;
      target = now;
    }
    target = stable;

    await sendMouse('mouseMoved', target.cx, target.cy);
    await sendMouse('mousePressed', target.cx, target.cy, { button: 'left', clickCount: 1 });
    await sendMouse('mouseReleased', target.cx, target.cy, { button: 'left', clickCount: 1 });
  }

  async function sendMouse(type, x, y, extra = {}) {
    await cdp.send('Input.dispatchMouseEvent', { type, x, y, ...extra });
  }

  /** 聚焦后插入文本：比 `input.value = x` 更接近真人输入（会触发框架的输入事件链） */
  async function type(selector, value) {
    await click(selector);
    await cdp.send('Input.insertText', { text: value });
    await sleep(120);
  }

  /**
   * **覆盖式**填入（先清空再写），用于框里已经有内容的输入框（就地重命名那种）。
   *
   * 不能拿 `type()` 代替：`Input.insertText` 是"在光标处插入"，
   * 对已有内容的输入框会变成**追加** —— 之前就在端口号上踩过一次，
   * 填 "8000" 得到 "80008123"（框里原本是 8123），而报错信息只会说"端口不对"。
   *
   * 必须走原生 setter 再派发 `input` 事件：Vue 的 `v-model` 监听的是事件，
   * 直接赋值 `el.value = x` 不会让框架知道值变了（界面看着变了、状态还是旧的）。
   */
  async function fill(selector, value) {
    const ok = await json(
      `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return JSON.stringify(false);
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) setter.call(el, ${JSON.stringify(value)});
        else el.value = ${JSON.stringify(value)};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.focus();
        return JSON.stringify(true);
      })()`,
    );
    if (!ok) throw new Error(`填入失败：找不到 ${selector}`);
    await sleep(100);
  }

  async function press(key) {
    const map = { Enter: { windowsVirtualKeyCode: 13, key: 'Enter' }, Escape: { windowsVirtualKeyCode: 27, key: 'Escape' } };
    const extra = map[key] ?? { key };
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...extra });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...extra });
  }

  /**
   * 切路由并**确认页面真的挂载了**。
   *
   * 两步判据缺一不可：
   *   1. `location.hash` 是目标值 —— 否则导航压根没发生；
   *   2. `[data-view="<name>"]` 且尺寸非零 —— 否则就是"外壳在、路由内容空白"，
   *      这正是我在打包版上撞到过的表象（当时老脚本把它报成"0 张卡片"，指向完全错误的方向）。
   */
  async function goto(hash, view, { timeoutMs = 25000 } = {}) {
    await evaluate(`location.hash = ${JSON.stringify(hash)}`);
    await waitFor(
      `location.hash === ${JSON.stringify(hash)} && (() => { const el = document.querySelector('[${VIEW_ATTR}="${view}"]');
        if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; })()`,
      { label: `路由 ${hash} 的内容挂载完成（[${VIEW_ATTR}=${view}] 出现且有尺寸）`, timeoutMs },
    );
    await animationsSettled({ timeoutMs: 6000 }).catch(() => undefined);
  }

  /** 重载并等到应用重新可用（首帧 + 外壳挂上） */
  async function reload({ timeoutMs = 30000 } = {}) {
    await evaluate('location.reload()');
    await waitFor('Boolean(window.pmStudio) && Boolean(document.querySelector(".n-layout"))', {
      label: '重载后应用外壳重新挂上',
      timeoutMs,
    });
    await sleep(300);
  }

  async function screenshot(file, clip) {
    return cdp.screenshot(file, clip);
  }

  /**
   * 当前**可见**的下拉选项文本。
   *
   * 两条都是踩出来的：
   * 1. Naive 把关掉的菜单留在 DOM 里，不过滤可见性会把别组下拉的选项一起收进来
   *    （曾经出现过"断言看着通过、其实校验的是另一个菜单"）；
   * 2. 选项外面还套着虚拟列表容器，所以不能靠 `:nth-child` / `:last-child` 定位 ——
   *    那些选择器未必命中任何元素，报出来却是"元素不存在"，方向完全错了。
   */
  async function visibleOptionTexts() {
    return json(
      `(() => JSON.stringify([...document.querySelectorAll('.n-base-select-option')]
        .filter((el) => el.offsetParent !== null)
        .map((el) => (el.textContent || '').trim())))()`,
    );
  }

  /**
   * 选中第 index 个可见选项（-1 = 最后一个），返回它的文本。
   *
   * **量完立刻点**，中间不做别的事：浮层是会消失的，而通用 `click()` 为了等悬停动画、
   * 检查视口、确认元素停稳，要来回好几趟（每趟上百毫秒）—— 对普通元素没问题，
   * 对"随时可能被关掉的下拉选项"就是隐患（实测偶发"选项不存在或不可见"）。
   * 所以这里一次求值拿到坐标，紧接着就派发鼠标事件。
   */
  async function pickOption(index, selector = '.n-base-select-option') {
    const position = index < 0 ? 'list.length - 1' : String(index);
    const target = await json(
      `(() => { const list = [...document.querySelectorAll(${JSON.stringify(selector)})].filter((el) => el.offsetParent !== null);
        const el = list[${position}];
        if (!el) return JSON.stringify(null);
        const r = el.getBoundingClientRect();
        return JSON.stringify({ label: (el.textContent || '').trim(), cx: r.x + r.width / 2, cy: r.y + r.height / 2 }); })()`,
    );
    if (!target) {
      throw new Error(`选下拉选项失败：${selector} 的可见选项里没有第 ${index} 个`);
    }

    await sendMouse('mouseMoved', target.cx, target.cy);
    await sendMouse('mousePressed', target.cx, target.cy, { button: 'left', clickCount: 1 });
    await sendMouse('mouseReleased', target.cx, target.cy, { button: 'left', clickCount: 1 });
    return target.label;
  }

  /**
   * 选一个 **Naive `NDropdown` 菜单**里的选项（工作大纲节点上的状态标签就是它）。
   *
   * 为什么不能复用 `pickOption`：两者渲染出来的 DOM 完全不同 ——
   * `NSelect` 的选项是 `.n-base-select-option`，而 `NDropdown` 是 `.n-dropdown-option`。
   * 拿错选择器的表现是**"选项里没有第 N 个"**，看着像菜单没打开，实际上是找错了元素
   * （这条是实跑时踩出来的，不是推测）。
   */
  async function pickMenuOption(index) {
    return pickOption(index, '.n-dropdown-option');
  }

  return {
    evaluate, json, waitFor, animationsSettled,
    box, count, exists, text, attr,
    hover, click, type, fill, press, sendMouse,
    goto, reload, screenshot,
    options: visibleOptionTexts, pickOption, pickMenuOption,
  };
}

module.exports = { createPage, VIEW_ATTR };
