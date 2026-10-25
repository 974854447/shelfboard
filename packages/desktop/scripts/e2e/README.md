# E2E 测试脚本

界面级验证。**替代**了原来的 `scripts/ui-shot.cjs`（1437 行单体脚本，已删除）。

## 怎么跑

```powershell
pnpm --filter @pm-studio/desktop e2e                # 开发运行时，跑全部场景
pnpm --filter @pm-studio/desktop e2e outline        # 只跑某个场景（可写多个）
pnpm --filter @pm-studio/desktop e2e --packaged     # 打好的 exe（发布前必跑）
pnpm --filter @pm-studio/desktop e2e --shots        # 每个场景额外留一张截图
pnpm --filter @pm-studio/desktop e2e --keep         # 保留沙箱目录（失败现场）
```

退出码：`0` = 没有失败（跳过不算失败）；`1` = 有失败。可以直接进 CI。

## 为什么重做

老脚本能查出问题，但**查错方向**的次数太多，成本已经超过收益：

| 老脚本的毛病 | 新做法的对策 |
|---|---|
| 固定 `sleep(6000)` 等界面 → 机器一忙就假失败（同一份产物时绿时红） | 全部改成**条件等待**（`page.waitFor` / `waitForView`），超时信息里带判据 |
| 用"元素数 0"表达失败 → 外壳在、内容空白时指向完全错误的方向 | 每条路由断言 `[data-view=…]` 挂载 + 内容节点数 + 页面标志元素 |
| 失败只给一句话，得另写脚本查原因 | 失败**自动**收集页面异常、失败请求、资源时序、主进程日志尾部与截图 |
| 断言写成 `check(ok, '失败文案')`，成功时也打印那句文案 | `assert` 的第二个参数永远是"期望成立的说法"，失败才附实际值 |
| 1437 行单体：造数据、点界面、截图、断言全混在一起 | 拆成 `harness/`（工具）+ `scenarios/`（一个页面一个文件） |
| 用合成 `el.click()` / `dispatchEvent` 点元素 → 绕开命中测试，掩盖真实交互缺陷 | 点击/悬停默认走 **CDP 真实鼠标**（需要绕过时才 `{ via: 'dom' }`） |
| 每跑一次往沙箱里塞一份同名数据 | 每次运行用随机后缀建项目，跑完即删 |

**它在第一轮就抓到一个真实缺陷**：总览的六边形点不动（`setPointerCapture` 在 `pointerdown`
里就把指针捕获了，后续 `click` 全被重定向到容器，`@click="drill(...)"` 收不到事件）。
老脚本用合成事件点元素，正好绕过了这个命中测试问题，所以一直没暴露。详见
`docs/technical-design.md` §26。

## 结构

```
scripts/e2e/
├── run.cjs                 入口：参数、启动应用、按顺序跑场景、汇总、退出码
├── harness/
│   ├── sandbox.cjs         数据沙箱闸门（必须在 .tmp 下、绝不在 %APPDATA% 下）
│   ├── cdp.cjs             极简 CDP 客户端（每请求带超时 + 收集事件）
│   ├── app.cjs             启动/连接/关闭应用；读主进程日志尾部
│   ├── page.cjs            页面原语：goto / waitFor / click / hover / type / fill / 动画落定
│   ├── api.cjs             通过内嵌服务接口造数据、选项目、改偏好、清理
│   ├── assert.cjs          断言记录（不因首个失败中断，一次跑完拿到全部失败点）
│   └── diagnose.cjs        失败现场收集
└── scenarios/
    ├── shell.cjs           外壳 + 四个页面都能真正挂载
    ├── outline.cjs         工作大纲：层级树（几何验证）、折叠/展开、增改删（含删除确认框）
    ├── overview.cjs        总览：六边形图、依赖连线、下钻、Esc 返回
    ├── logs.cjs            日志页：筛选、搜索、实时流
    ├── calendar.cjs        M2：日历（农历/节气/节假日、自定义标记、右侧面板、选中某天）
    ├── today.cjs           今日待办：打卡计时（真的在跳）、只看当前项目、四组筛选、生成工作日志（真的落盘）
    ├── recycle-bin.cjs     回收站与「运行中不许删」：移入/还原/彻底删除、运行中删除被拒（界面 + 接口）
    ├── search.cjs          M2：全局搜索 / 中文分词（结果卡片、空态）
    ├── settings.cjs        设置页：分区、环境与数据、编辑器识别、备份、功能介绍
    └── drawer.cjs          任务详情：进度条、不抢焦点、草稿不被覆盖
```

十六个场景一共 **430 条断言**（每个场景的条数会随功能增长，README 不逐一维护）：
卡片一类的改动常会同时牵动多个场景的选择器（例如 `.row` → `[data-field=…] .wb-title`），
所以改版后按 `run.cjs <场景名…>` 分步跑比直接跑全量更容易定位。

## 加一个场景（M2 就是这么用）

新建 `scenarios/<name>.cjs`：

```js
module.exports = {
  name: 'calendar',
  title: '日历视图',
  needsProject: true,        // true = 自动造一个项目并选中（包含主/子/孙任务与一条依赖）
  // pending: '等 M2 实现 #/calendar',   // 未实现时挂着，跑起来显示"跳过"

  async run({ page, assert, data, cdp }) {
    await page.goto('#/calendar', 'calendar');   // 第二步参数是页面根节点的 data-view
    assert.atLeast(await page.count('.cal-cell'), 28, '月视图格子数');
    // data.parent / data.child / data.leaf 是造好的任务，用来断言具体行为
  },
};
```

约定：

1. **页面根节点必须有 `data-view="<name>"`**。这是"路由内容真的挂载了"的唯一可靠判据
   （只看 `location.hash` 不够：外壳在、内容空白时 hash 也是对的）。
   多分支模板（例如总览的"没选项目/加载中/没任务/正常"）**每个分支都要挂**。
2. **不要写 `sleep`**。要等什么就等什么：元素出现用 `page.waitFor`，动画用 `page.animationsSettled()`。
3. **造数据走 `api`，验证走界面**。造数据失败与功能失败必须能区分开。
4. **断言要写"期望成立的说法"**，失败时框架会把实际值附上。
5. 中文相关的功能（搜索、日历）**必须用中文用例**：默认分词器对中文的处理与英文完全不同，
   只测英文等于没测（实测见 technical-design §24）。

## 数据安全

- 永远显式传 `--user-data-dir`，指向 `packages/desktop/.tmp/e2e/<运行时间>/userdata`；
- `harness/sandbox.cjs` 会**拒绝对 `%APPDATA%` 下或路径里没有 `.tmp` 的目录运行**；
- 正式数据只有一份，没有"重跑一次"的退路 —— 这条闸门不要为了图方便去掉。
