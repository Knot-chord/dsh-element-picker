# dsh-element-ref — 设计说明

> 一个拾取入口，把「鼠标指到的界面元素 / 网页元素」变成输入框里的原生引用 chip。
> 本文是动手前的设计决策记录；实现与它一一对应。

## 1. 痛点（与 dsh-element-picker 同一处）

用文字描述屏幕上某个按钮/输入框/网页元素，慢且失真（"左边那个……第二个……"）。
把一次点击转成**精确、紧凑、可复现**的引用插进输入框，交给模型。

## 2. 需求边界

| 面 | 说明 | 通道 |
|---|---|---|
| DSH 自身界面 | 会话、设置、右侧栏、文件树……（含同源 iframe、开放 shadow root） | 渲染进程内注入 agent |
| DSH 侧栏浏览器 | 右侧栏 Browser 标签里的任意网页（Electron `<webview>`） | `webview.executeJavaScript` |
| DSH Agent 浏览器 | dsh-ego-browser 启动的 Chrome（`%LOCALAPPDATA%\ego-lite-linux\browser.json`） | CDP（宿主侧 WebSocket） |
| 外部 Edge / Chrome | 插件自己拉起或已带调试端口的浏览器 | CDP |

统一触发：**右侧栏右上角一个手动图标**（左键=开始/结束选取，右键=目标与最近引用）。
右侧栏展开时它落在右上角控制簇里（全屏/收起左侧）；收起时落在会话头部「打开右侧边栏」按钮旁 —— 同一个图标、同一个行为，两种情况都在右上角。

## 3. 核心架构：一个拾取内核，三种投递方式

```
                 ┌──────────────────────────────┐
                 │ agent.source.js（唯一拾取内核）│
                 │ 高亮 / 点选 / 选择器 / 载荷   │
                 └───────┬──────────┬───────────┘
                         │          │
   <script> 注入渲染进程   │          │  文本注入 guest / 页面
                         │          │
        client.js ───────┴──────────┴──────── host index.js ── CDP ── 浏览器标签页
             │                                              │
             └──────── 原生 chip（scoped 事件插入） ◄───────┘
```

- **一个内核**：`agent.source.js` 是唯一实现（约 300 行），三端字节级相同 → 高亮、标签、选择器、载荷永远一致，不会漂移。
- **一个载荷**：`{ v, kind, label, desc, selector, selectorAlt, page, text, frame, rect, source }`。
- **一条插入路径（带能力降级）**：按 DSH 版本提供的 API 依次尝试，绝不让「某个 API 不在」变成「什么都没发生」：

  | 顺序 | 机制 | 适用 | 说明 |
  | --- | --- | --- | --- |
  | 1 | `inputActions.insertQuote(text)` | 有引用节点的版本 | 原生引用卡；`labels` 由 shell 填充，签名是 `(text, summary)` |
  | 2 | `actx.bail(actx, 'slash/input-insert-reference', { reference, span })` | 有原生 chip 的版本 | chip 由输入框自己的 `reference-chip` 节点创建 |
  | 3 | `inputActions.insertText(block, span)` | 有文本框的版本 | 纯文本引用块（强制带标记） |
  | 4 | `navigator.clipboard.writeText(block)` | 兜底 | 复制到剪贴板并提示粘贴 |

  走 3/4 时会明确提示用了哪个通道，避免把"旧版本没有引用卡"误判成 bug。
  chip 由输入框自己的 `reference-chip` 节点创建 —— 不做原型补丁、不读构建哈希 CSS、不合成粘贴事件。

## 4. 为什么不用 dsh-element-picker 的老路（逐条对照）

| 老路 | 问题 | 本插件做法 |
|---|---|---|
| PowerShell 常驻 + 全局热键 + UIA 读外部窗口 | 进程常驻、热键冲突、需要 `--remote-debugging-port` 手工启动、UIA 树会 stale | 全部删除：没有热键、没有子进程、没有 UIA |
| 直接 `Chip.importJSON` + `editor._selection.insertNodes` 造 chip | 绕过输入框的 span 校验/撤销/草稿持久化；`decorate` 原型补丁 + 从 `style[data-plugin-css]` 抠哈希类名，构建一变就碎 | 走 scoped 事件，输入框自己造节点；不改任何原型 |
| 自己造 chip 外观（`glyphFor`） | 视觉上与原生不一致，靠哈希类名伪装 | `appearance: undefined` → 原生 `@` 标记 chip，零样式破解 |
| 每次点击开一条 CDP 连接，只认 `windowTitle` 匹配 | 多标签会挂错页；新标签不生效 | 浏览器级单个 WS + `Target.setAutoAttach`，按 target 精确归属，新标签自动接管 |
| 侧栏 webview 150ms 轮询注入 agent | 可以，但 agent 与 DSH 内的实现是两份 | 同一份 agent，同一个 `read()` 协议 |
| 引用文本塞 context/内容定位/文本区间…… | token 膨胀 | 硬上限 + 空字段省略，典型一条 3 行 |
| **在 `pointerup` 里直接收尾** | 收尾会立刻解绑监听器，而浏览器紧接着派发 `click`——那一下会漏给页面，点导航行就会跳走（本机实测踩到并修复） | `pointerup` 只计算载荷，`setTimeout(0)` 落到下一个任务再收尾，紧跟的 `click` 仍被 capture 监听吞掉 |
| 只认「有 aria/文本」的元素 | 点到纯容器（整屏遮罩、wrapper）时标签退化成 `div`，引用毫无信息量 | 标签依次取 aria-label → 自身文本 → alt/title → 子树文本 → `tag.class`；并附 `位置:` 记录最近两层带标签的祖先 |
| **把框架元素当成普通元素** | 悬停整屏 `<iframe>` 时把整个面板框成一个蓝框、标签写着 `iframe`，既没用又吵（用户实测提出） | `IFRAME`/`FRAME` 一律不参与高亮与拾取：同源框架由它自己的实例接管（`frame` 链记录路径），跨源框架本来就不可读 |
| 只在 arm 时弹一句会消失的提示 | 分屏时点另一侧窗口毫无反应，用户不知道"哪些窗口现在算数" | arm 后底部常驻一条「可选区域：…」横条，直到退出选取；未连接外部浏览器时明确写出两条启动方式 |
| 悬停高亮只在 `pointermove` 里画 | 指针移出窗口/切到别的应用/镜像预览转发停止后没有事件，蓝框**留在原地**，看起来像"明明在别的窗口操作，DSH 却在高亮"（用户两次实测提出） | 高亮 = 有焦点的文档里、由活着的指针产生的投影：离开窗口 / `pointerout`（relatedTarget 为空或来自另一个文档）/ 失焦 / 页面隐藏 / 元素被移除 / 5s 无指针活动，任一立即清空；未获焦的文档（镜像预览转发进来的移动）根本不画 |
| 发送后引用块只剩多行文本 | 模型文本里是块，气泡里也就是块，读起来像一堵墙 | 用 DSH 的 `userText` 规则 + `conversation.user.text.node` 渲染器把它读回 chip；读写共用同一张 `BLOCK` 词表（`formatReference` 写、`parseUserBlock` 读、正则由词表生成），不可能漂移 |

## 5. 兼容与降级（每一级都明确告知用户，不假装可用）

- 宿主半边不可用：客户端仍能拾 DSH 与侧栏网页（agent 由宿主路由提供；取不到时提示"宿主插件未启用"）。
  > 取舍：agent 只有一份（宿主提供），避免两份实现漂移；代价是宿主路由是 agent 的唯一来源。
- Edge：`auto`（先探已开调试端口 → 再探插件托管的实例 → 都没有则提示"右键图标启动"）。
  启动有两条路，都从右键菜单进：
  - **独立窗口**：插件自己的 profile（`$DSH_HOME/element-ref/edge-profile`），随机端口，不碰真实数据、不需要退出浏览器；
  - **本机配置**：用用户真实的 `User Data` 以固定 9222 端口启动，登录态都在，但**必须先完全退出**该浏览器（`SingletonLock`/`lockfile` 预检，否则直接拒绝并说明）。
- 跨源 iframe：CDP 端通过 `Target.setAutoAttach` 接管 OOPIF，能真正拾到里面的元素（`框架:` 记录 URL）；
  webview / 渲染进程内只能拾到 `<iframe>` 元素本身（诚实标注）。
- 侧栏浏览器：只有**桌面端**是 `<webview>`（可注入）；用浏览器打开 Web GUI 时它是跨源 iframe，取不到内部 DOM，这一面在 Web 版不提供。
- closed shadow root：不可达（标注为"取不到"），open 的用 `>>>` 链表达。
- 页面在选取期间导航：`Page.addScriptToEvaluateOnNewDocument` 保证新文档重新装上 agent；载荷里的 `page` 是点击当时的 URL。

## 6. 稳定性措施

- 拾取会话有 TTL（默认 120s）、单例、可被新会话替换；`ctx.effect` 卸载时关闭全部 socket。
- 每条 CDP 命令独立超时，单个浏览器/标签失败只降级它自己，不炸整个 arm。
- 浏览器 socket 断开 / 进程退出 → 会话自动结束，客户端收到 `ended` 并复位图标。
- 客户端所有监听都在 `ctx.effect` 里装/卸；DOM 图标用 MutationObserver（200ms 合并）重挂，不使用固定轮询。
- 同一时刻只有一个活动拾取会话（第二个窗口 arm 会接管，第一个收到 `ended` 提示）。
- 插入前校验 span 的 `draftRev`（输入框自己的 CAS），插入失败只提示、不双写。

## 7. Token 策略：引用块要说清「是什么、在哪、什么内容」

模型**读不到** DSH 的 DOM，所以给它的不能只是一条 CSS 路径。引用块要同时干三件事：
**让我看内容**（摘录/表格行列）、**让我按它重找**（页面+标签页+选择器/语义定位+备选）、**让我知道它是什么**（角色+状态+区域+近邻）。

同一份词表写/读，按来源分两种形态：

**首行标记只在 chip 态出现**：引用态（`referenceStyle: quote`）的输入框已经渲染了引号卡片，再写一遍 `[引用元素]` 是重复；
纯文本/剪贴板降级路径会强制补上标记，让文字块仍可被识别。

界面元素（DSH 自身）：

```
[引用元素] 打开右侧边栏 (button)
位置: 顶部栏
可定位: role=button[name="打开右侧边栏"]

[引用元素] 全局面板 (navigation)
内容: 插件 / 自动化任务 / 免费搜索 / 更多
```

网页元素（CDP / 扩展）：

```
[引用元素] 提交订单 (button)
页面: https://shop.example/cart
位置: 购物车 › 结算
选择器: form#cart > button.btn-primary
附近: 取消 / 继续购物
```

- 头行 = 名称 + 角色 + **状态**（`aria-expanded=false` / `checked=true` / `disabled`）：知道它现在是什么。
- `位置` = 最近 4 层带标签的祖先（aria-label / 标题 / landmark，landmark 用人话如「顶部栏」而不是 `banner`）。
- `可定位` / `选择器`：界面元素给语义定位（模型不能对 DSH 跑 CSS），网页给 CSS（模型能在页面上复跑）；位置型选择器（`:nth-of-type`）额外给 `备选`。
- `标签页` / `页面`：网页引用带上标签页标题和 URL，模型可以据此切到正确的标签页再找。
- `摘录` = 元素可见文本（≤240 字），回答「帮我看看这个写了什么」；与 `内容`（子项标签）重复时只留一份。
- `表格` = `列: 数量 · 行: 张三 / 30 / 北京`，单元格自己说清在哪一列、这一行还有什么。
- `附近` = 同级里能读到的名字（"撤销 / 重做 / 剪切" 立刻说明这是什么菜单）；`内容` = 容器里装了什么。
- 自己的浮层、图标、菜单一律排除在上下文之外；图标按钮的 tooltip 不进 `内容`（它是动作，不是区块）。
- 硬上限：label 56 / 区域 90 / 定位 90 / 邻近 80 / 内容 90 / 摘录 240 / 表格 140，整块 ≤ 700 字符。
- **分级 + 预算**：所有字段都采集，按 `textDetail`（`compact` / `standard` / `full`）决定下限，再按信息价值顺序装进 `textBudget` 字符预算；装不下的行**整行丢弃**（从最不重要的开始），关键行（头行、框架）永远保留。实测同一元素：

  ```
  compact  (63 字符)            standard (71)                 full (112)
  [引用元素] 打开右侧边栏 (button)  [引用元素] 打开右侧边栏 (button)   [引用元素] 打开右侧边栏 (button)
  位置: 顶部栏                   位置: 顶部栏                    位置: 顶部栏
  可定位: role=button[…]        可定位: role=button[…]         可定位: role=button[…]
                                序号: 1/2                     序号: 1/2
                                                              属性: type=button
                                                              坐标: 961,11,28,28 · 28x28
  ```

  数据都采到了，花多少 token 由这一个旋钮决定；`full` 里的 `属性/组件/坐标` 只在需要「找到源码/像素兜底」时才值得打开。

## 8. 配置（`cordis.patch.yml` → `config`）

```yaml
config:
  enabled: true
  agentBrowser: true          # 接管 dsh-ego-browser 启动的 Chrome
  edge: auto                  # auto | off
  edgeExecutable: ''          # 留空自动探测 Edge → Chrome → Brave
  edgeProfileDir: ''          # 留空用 $DSH_HOME/element-ref/edge-profile
  attachPorts: [9222, 9223]   # 已带调试端口的浏览器
  sessionTtlMs: 120000
  maxTargets: 12
```

## 9. 已知限制（写入插件详情页）

- 右侧栏收起时图标不在（它属于右侧栏顶栏）；展开右侧栏即可。
- closed shadow root、webview 内的跨源 iframe 只能拾到外层元素。
- 插件托管的 Edge 是独立 profile（首次需要登录一次）；要用真实 profile 需先完全退出 Edge，再把 `edge` 配成 `managed` 并指定 `edgeProfileDir`。
- chip 在会话记录里显示为多行引用块（不是原生 `@文件` 那种单行），因为交付给模型的正是这段块。

## 10. 文件

```
dsh-element-ref/
  package.json           清单（dsh.bundle / dsh.client / exports / files）
  cordis.patch.yml       插入宿主行
  index.js               宿主：配置、路由、拾取会话
  cdp.js                 CDP 客户端（原生 WebSocket，无依赖）
  browsers.js            浏览器发现 / Edge 启动
  agent.source.js        拾取内核（三端唯一实现，按静态脚本被读取与下发）
  client.js              浏览器半边：图标、菜单、三端联动、原生 chip 插入
  locale/{en,zh}.json    显示元数据
  icon.svg               插件图标
  docs/DESIGN.md         本文
  README.md              使用说明
  scripts/test.mjs       纯逻辑测试（Node 下跑 client 工厂）
  scripts/smoke.mjs      对着运行中的 DSH 跑端到端契约（宿主路由 + CDP + 抓取 + 回闪）
```

## 8. 三条注入通道 + 一条扩展桥（为什么是这个结构）

痛点有两层：**「看到元素却描述不出来」**（表达成本），以及 **「我自动化找不到时没法指给你」**（协作成本）。两者都要求「点一下就把元素交出去」，而交付对象必须是用户**正在看的那块界面**——所以不是选一个浏览器，而是每条界面各有一条注入通道，共用同一个内核：

| 通道 | 注入方式 | 为什么不能用别的 |
| --- | --- | --- |
| DSH 渲染进程 | 客户端直接 `new Function(source)` | 同进程，最直接 |
| 侧栏 `<webview>` | `executeJavaScript` 进 guest | 跨进程隔离，只能由宿主注入 |
| 侧栏同源 `<iframe>` | 顶层 agent 的 `bindFrames` 覆盖 | 同源，事件可达 |
| Agent 浏览器 / 外部实例 | CDP `Runtime.evaluate` | 端口在，最稳 |
| **用户自己开着的浏览器** | **配套扩展**：`chrome.scripting` 注入 MAIN world | 已运行的浏览器无法事后开调试端口（Chrome 136+ 更是默认禁止），扩展是唯一合法入口 |

扩展桥的设计约束，逐条对应「不破坏用户浏览器」：

- **只在选取期间存在**：扩展轮询 `127.0.0.1:<extensionPort>/state`，`armed=true` 才注入；会话结束（或宿主消失）立刻撤离，不常驻读页面。
- **只碰前台标签页**（每个窗口的 active tab），不是所有标签页；注入的是同一个 `agent.js`，所以高亮/选择器/载荷与其它三端**完全一致**。
- **不碰登录态**：不读 cookie、不改 header，用用户已有会话。
- **回环风控**：只绑 `127.0.0.1`；`Access-Control-Allow-Origin` 只回给 `chrome-extension://` 来源，网页读不到；`/pick` 必须带上本次会话 token，过期会话直接 409。
- **单点真相**：`extension/agent.js` 是 `agent.source.js` 的逐字节副本，`scripts/test.mjs` 断言一致，杜绝「扩展一套行为、应用另一套」。

## 9. 内置浏览器（侧栏 webview）：为什么「看着武装了却没反应」

侧栏浏览器在桌面版是 `Electron <webview data-sidebar-browser-frame="webview">`，页面跑在独立进程，只能由宿主用 `executeJavaScript` 注入。三个坑叠在一起时的表现就是：**DSH 自己的元素能点、内置浏览器点不动，而横条还写着「侧栏网页」**。

1. `armGuests` 在注入**静默失败**后仍然把 view 记进 `state.guests`，`pollGuests` 便认为它已武装、不再重试；
2. agent 源码按页面缓存，宿主换了内核后页面还在注入**旧文本**；
3. 「已武装」的判据是 `guestBuild === agentBuild`，而 `agentBuild` 来自异步 `/status`，为空时判据恒假。

现在的做法：arm 前先 `refreshStatus()`；注入时带 `window.__dshRefBuild`；**回读 guest 的 build 才算成功**；未成功的每 1.2s 重试（不是每 180ms 强灌 40KB）；读取一律走 `JSON.stringify` 字符串（结构化克隆失败会让整条 promise reject，表现和「没装上」一模一样）；并挂 `dom-ready / did-finish-load / did-navigate` 在加载完成后补注入。

诊断：客户端把「找到几个 webview、属性、合成探针、guest 里的 build/version、事件计数 `seen`、最近报错」POST 到 `/element-ref/diag`，`/status.diagnostics` 直接可读。`seen: {move,down,up}` 三个计数是判断「页面没给事件」「点击被拦」还是「describe 抛错」的最便宜证据。

## 10. 信息提取的六层：从一次点击到一条引用

一次点击只有一条数据流：**指针 → 目标 → 身份 → 位置 → 内容 → 重找 → 预算**。每一层只依赖上一层的结果，每层都定义「取不到时降级到哪里」，所以任何一处失败都不会让整条引用变成噪音。

| 层 | 职责 | 入口函数 | 取不到时 |
| --- | --- | --- | --- |
| L0 目标 | 指针下**真正该被点**的元素 | `eventTarget` → `meaningfulTarget` | 保留最深处节点 |
| L1 身份 | 它叫什么、是什么、什么状态 | `humanLabel` → `roleOf` → `stateOf` | 退化为选择器描述，并打 `labelKind: selector` |
| L2 位置 | 它在页面结构的哪一块 | `regionOf` → `viewportMetrics`/`boxOf` | 只给画面坐标 |
| L3 内容 | 它说了什么、装着什么 | `excerptOf` / `contentOf` / `tableContextOf` / `nearbyOf` / `indexOf` | 该行不输出 |
| L4 重找 | 怎么再找到它 | `selectorWithShadow` / `locatorOf` / `contextOf` | 只给页面 + 文本 |
| L5 预算 | 花多少 token | client 的 `formatReference`（按 `order`/`minRank` 装预算） | 按价值从低到高整行丢弃 |

### L0 目标解析：点击语义
- 取 `composedPath()[0]`（Shadow DOM 里是真实内层节点）；
- 向上最多 6 层找"有意义"的元素（交互标签、role、aria-label/data-testid/name、contenteditable）；
- **跳过矢量内部**（`svg/path/use/circle…`）：点图标 = 点它所在的控件；
- **跳过比视口大 1.5 倍的盒子**：那是滚动容器，不是点击目标。

### L1 身份：名字的降级链（顺序即优先级）
1. `aria-label`
2. 自身直接文本，且是"标题样"的（≤40 字、无 URL、无 `›`、不像代码、**只有一个子节点带文字**）
3. `alt` / `title` / `placeholder`
4. `primaryTextOf`：内部标题/链接/按钮（叶子优先），否则 **第一个有文字的直属子节点**（跳过 `15小时`、日期这类元信息）
5. **控件的名字**：向上 3 层找 `button/a/label/[role=button]` 的 `aria-label`/`title`
6. **卡片的名字**：`closest('a[href]')` 的 title/aria-label → 向上 6 层找标题/内层链接/`title` 属性
7. `describeTarget`（`tag#id.class`）—— 此时 `labelKind='selector'`
8. 纯图标瓦片 → `「div 图标」`

同时给出 `role`（显式 role 或标签映射）与 `state`（`aria-expanded/pressed/checked/selected/disabled`、`disabled`、`readonly`、输入 `type/checked/value`、链接 `href`）。

### L2 位置：语义优先，几何兜底
- `regionOf` 向上 9 层，最多 4 段：`aria-label` > 子标题 > landmark（翻译成人话：顶部栏/导航/侧栏/主区域…）；
- **只由 landmark 组成的区域不输出**（"列表"这种词没有信息量）；
- `box` = 元素盒子换算到**设备像素、相对可见视口**：`(rect - visualViewport.offset) × dpr × scale`，滚动不进公式；`viewport` 同单位；`scale` 仅 full 档。

### L3 内容：只读用户看得见的字
- `excerpt`：先找第一个像正文的块（`p/h*/li/blockquote/figcaption/td`，≥24 字），找不到才取整棵子树；统一做**重复折叠**（`A A A` → `A ×3`）；上限 240；
- `content`：只在容器上给（导航/菜单/列表/表格/对话框/区域/表单/工具栏，或 ≥3 子节点且自身无文字），取前 5 个标签，向下穿透包装层；
- `nearby`：≤3 个同级名字，每个 ≤20 字、总长 ≤48，过滤代码样文本与操作提示（`请/按/拖动/使用…`）；
- `index`：同标签兄弟 ≥2 时给 `n/m`；
- `table`：`td/th` 给列头 + 整行值；
- 文本抽取一律跳过 `SCRIPT/STYLE/NOSCRIPT/TEMPLATE/SVG`、**隐藏子树**（`aria-hidden=true` / `hidden` / 内联 `display:none`）、图标字体私用区字符与控制字符。

### L4 重找：两条互补的定位
- 网页：`selector`（唯一性校验过的 CSS 路径，shadow 边界用 `>>>`）+ 页面 URL + 标签页标题 + 框架链；位置型选择器在 full 档附 `备选`；
- DSH 界面：`locator = role=<role>[name="<解析出的名字>"]` —— 用名字而不是自身文本，否则树节点只能是 `role=treeitem`。

### L5 预算：按价值装，不截断关键行
候选行带 `order`（信息价值）与 `minRank`（详细度下限），按 order 依次装入 `textBudget`，装不下就整行跳过；头行与 `框架` 永不留失；**名字弱（`labelKind=selector`）时 `内容`/`摘录` 提到任何档位都输出**——因为名字不可读时，内容就是唯一的身份。

### 不变量（违反即 bug）
1. 名字必须可读，否则必须用内容顶上；
2. `位置` 至少含一个"名字"来源，否则只给坐标，不输出 `列表` 这类空词；
3. 目标永不是矢量内部、永不是比视口大 1.5 倍的容器；
4. 文本只取用户可见的，块边界要有分隔，重复要折叠；
5. 选择器必须唯一，否则给备选或更长路径；
6. 坐标必须是设备像素、视口相对（与截图一一对应）；
7. 预算只裁"低价值行"，不裁"唯一身份"。

### 已知缺口（诚实记录）
- 隐藏文本只识别 `aria-hidden`/`hidden`/内联 `display:none`，**CSS 类隐藏（如 `.sr-only`）识别不到**——要准确就得对每个节点 `getComputedStyle`，代价过高；
- 复杂表格（`rowspan/colspan`）不解析，只按同 `tr` 取列；
- 跨源 iframe 内元素不可达（浏览器沙箱），只能引用 iframe 本身；
- 纯图标按钮若自身与控件都没有 `aria-label/title`，仍会退化成选择器（此时内容/摘录顶上）。

## 11. 跨版本适配（0.2.1-rc.1 .. 0.2.2-rc.3）

两个原则：

1. **能力探测，不猜版本号**：客户端只用「这个 API 存在吗」来决定走哪条路（见 §3 的插入降级链），
   所以同一个 client.js 在所有支持的版本上都能工作，不需要按版本分支。
2. **宿主侧不引入版本相关代码**：插件只注册一次 `cordis.patch.yml` 行、一个 HTTP 路由组、一个客户端入口；
   版本差异全部被上面的降级链和黄雀式 feature detect 吃掉。

支持的版本写在 `package.json` 的 `dsh.engines.dsh`：`>=0.2.1-rc.1 <0.3.0-0`（下限是实测能装能挂的最低版本；0.2.1 与 0.2.2 全 rc 逐版 PASS）。
功能分界：`insertQuote`（原生引用卡）由 0.2.2-rc.1 引入；0.2.1 及更早自动降级为 chip/纯文本，并在提示里说明用了哪条通道。

验证用 `scripts/compat.ps1` + `scripts/verify-sandbox.mjs`（沙箱完整性）+ `scripts/compat-web.mjs`（浏览器级）：在 `D:\dsh_data\sandbox\compat`（可用 `DSH_REF_COMPAT` 覆盖）的共享沙箱里，优先用已缓存 DSH 的 `lib/bin.js` 直跑，缓存缺失时回退到 `npx`；逐个版本装本插件、生成配置，输出矩阵。

```powershell
pwsh -File scripts/compat.ps1                              # 默认四个版本：0.2.0-rc.2 / 0.2.1-rc.5 / 0.2.2-rc.4 / 0.2.2-rc.5
pwsh -File scripts/compat.ps1 -Versions 0.2.0-rc.2         # 探更低的版本
pwsh -File scripts/compat.ps1 -Fresh                       # 重建沙盒
```

headless 沙盒里没有浏览器，所以客户端行为（引用卡、chip）由 §3 的降级链保证；
compat 矩阵验证的是「宿主能装、能挂、配置能生成、插件行出现」。

**浏览器扩展的版本面**：只针对本机的 Edge（Chromium 152 / MV3）；
`extension/` 里不包含任何按版本分支的逻辑，`agent.js` 与 `agent.source.js` 由测试强制同源。

### 三个地方，三个用途

| 地方 | 路径 | 用途 |
| --- | --- | --- |
| 开发版 | 本仓库 | 改代码、跑测试、`npm pack` |
| 载入版 | `DSH 根目录/dsh-workspace/plugins/element-ref/` | DSH 真正加载的那份；只含 `files` 里的 22 个运行时文件，由 `scripts/sync-installed.mjs --apply` 从开发版同步，desktop profile 以 junction 指向它 |
| 沙箱 | `DSH 根目录/dsh-workspace/compat/` | 兼容性测试；复用现有的 `dsh-home`（profile `compat`）与 `npm-cache`，不按版本新建目录 |

关系：`开发版 --sync-installed--> 载入版 --profile link--> DSH 加载`；`开发版 --compat.ps1(link 安装)--> 沙箱`。
`scripts/check-pack.mjs` 同时核对「包内文件齐全」与「开发版 == 载入版逐字节一致」；`scripts/state.mjs` 一次打印三处现状。

