# dsh-element-ref

DeepSeek Harness 插件：**点一下，就能引用一个元素**——DSH 自己的界面、侧栏网页、Agent 浏览器、你自己的 Edge/Chrome，四个面共用一个拾取内核。

![DSH](https://img.shields.io/badge/DSH-%3E%3D0.2.1--rc.1%20%3C0.3.0-blue)
![tests](https://img.shields.io/badge/tests-passing-green)
![pack](https://img.shields.io/badge/pack-22%20files%20%2F%20110%20KB-brightgreen)
![deps](https://img.shields.io/badge/dependencies-0-brightgreen)
![license](https://img.shields.io/badge/license-MIT-lightgrey)

> 上游：[dsh-element-picker](https://www.npmjs.com/package/dsh-element-picker)（作者 **sakikoTGW**，MIT）。本实现是同一问题域的独立重写，上游先行，credit 归他；详见 [NOTICE](NOTICE)。

## 痛点

描述界面元素很费劲："右边那个蓝色的按钮""标题下面第二行""就是你刚点的那个"。

模型读不到你屏幕上的 DOM，所以这种描述它只能猜；你想让它**重找**那个元素，更是无从下手。

## 它怎么解决

一个侧栏图标 + 一次点击，把"这个元素是什么、在哪、怎么再找到"变成一段结构化引用：

- 引用直接进输入框（默认是 DSH 原生引用卡），紧跟在你正在写的话后面；
- 四个面共用**同一个内核**（`agent.source.js`），所以高亮、名字、选择器永远一致；
- 插入失败绝不静默：要么降级到下一通道，要么弹出「引用失败：原因」。

它**不猜**：取不到的名字就如实留空（图片没有 `alt` 就是没有名字），把信息放进单独字段，而不是从别处借一个塞进来。

## 它不管什么

- **不做**：页面内容的抓取与总结、自动化点击、选择器调试器。它只负责"把点的这个元素描述清楚"。
- **管不到**：`closed` shadow root 内部；跨源 iframe 内部（只能引用到框架本身）；既没装扩展、也没有调试端口的外部浏览器（这条通道必须先有入口，见安装）。
- **不常驻**：浏览器扩展只在选取期间把内核注入当前标签页，结束即撤离；不抓页面内容、不后台驻留。

## 给谁用

- 想让 agent 精确改动**你自己界面上**的某个元素，而不是听你形容；
- 需要事后能复现"我指的是哪一个"（选择器 / 语义定位 / 截图坐标都在）；
- 同时用 DSH 界面、侧栏网页和外部浏览器，希望一处学会、处处可用。

## 安装

```sh
# GitHub
dsh plugin --profile desktop add github:Knot-chord/dsh-element-ref
dsh plugin --profile desktop add "github:Knot-chord/dsh-element-ref#v0.1.0"   # 锁版本

# npm（发布后）
dsh plugin --profile desktop add dsh-element-ref
dsh plugin --profile desktop add dsh-element-ref@0.1.0                         # 锁版本
```

装完重载 profile 或重启 DSH，插件列表出现 `element-ref` 即可。

### 外部浏览器：必须先给它一个入口，否则这条通道不存在

其他三条通道（DSH 界面 / 侧栏网页 / Agent 浏览器）不需要任何准备。但只要你想在**你自己的 Edge/Chrome 窗口**里拾取，就必须先二选一——**没有第三种**：

| 方案 | 做法 | 代价 |
| --- | --- | --- |
| **A. 装扩展（推荐）** | 右键侧栏图标 →「扩展安装」复制 `extension/` 目录；Edge 打开 `edge://extensions` → 开「开发人员模式」→「加载解压缩的扩展」 | 一次安装，之后任何标签页都能拾；不干扰日常窗口 |
| **B. 让插件开独立窗口** | 右键图标 →「点一下开独立窗口」 | 不用装扩展；但要单独登录一次，和日常浏览器是两个实例 |

补充说明：插件也会自动附着**本来就带 `--remote-debugging-port` 启动**的浏览器（`attachPorts`，默认 9222/9223）。你平时直接打开的 Edge 没有调试端口，所以它接管不了。

**不做 A 也不做 B 时**：右键菜单显示「外部浏览器未连接」，选取横条里也会写同一句提示。**这不是 bug，是这条通道没有入口。**

### 装完先验四件事

| # | 做法 | 期望 |
|---|---|---|
| 1 | 点侧栏图标的引用按钮 | 底部出现「可选区域：DSH / 侧栏网页 / …」横条 |
| 2 | 在 DSH 界面里点一个元素 | 输入框出现引用卡，光标在卡片之后 |
| 3 | 按 `Esc` | 拾取结束，横条消失 |
| 4 | 先按上面 A 或 B 准备好外部浏览器，再在浏览器里点一个元素 | 引用进输入框；没准备时菜单会明确写「外部浏览器未连接」 |

侧栏浏览器里拾时，蓝框应稳定跟住元素（滚动也跟着）；离开侧栏网页框应立即消失。

## 原理 · [跳过，直接看配置 ↓](#配置)

不关心实现可以跳过本节。

### 四个面，一个内核

| 面 | 内核怎么进去 | 前置条件 |
|---|---|---|
| DSH 自己的界面 | 客户端把内核注入本页 | 无 |
| 侧栏网页（桌面端 `<webview>`） | `executeJavaScript` 注入 guest | 桌面端（Web 版这里是跨源 iframe） |
| Agent 浏览器（dsh-ego-browser） | CDP 注入 + 每次上下文重建后重挂 | ego 浏览器在跑 |
| 你自己的 Edge/Chrome | 扩展注入当前标签页（仅选取期间） | 装了扩展，或插件替你开一个带调试端口的窗口 |

### 一次点击的六层

```
L0 目标  指针下真正该被点的元素（跳过矢量内部、跳过大容器）
L1 身份  名字（AccName 顺序）+ 角色 + 状态；取不到就是「选择器」，不编造
L2 位置  结构区域 + 设备像素坐标（与截图一一对应）
L3 内容  摘录 / 内容 / 附近 / 序号 / 表格行列
L4 重找  唯一性校验过的选择器（网页）或 role/name 定位（DSH 界面）
L5 预算  按价值装进字符预算，弱名字时内容不裁
```

### 引用块长什么样

引用态（默认 `referenceStyle: quote`）首行没有标记——输入框已经是引用卡：

```
提交订单 (button)
页面: https://shop.example/cart
位置: 购物车 › 结算 · 画面 10,20 · 120x32 · 视口 1256x808
选择器: form#cart > button.btn-primary
附近: 取消 / 继续购物
```

图片这类本身没有名字的元素，会如实留空并把上下文放进独立字段：

```
img (img)
所在: 【回放】BLG 3-1 GEN获S16总冠军！
资源: https://i0.hdslb.com/bfs/banner/…png
选择器: div:nth-of-type(2) > div.carousel-area > … > img
```

chip 态（`referenceStyle: chip`）才带 `[引用元素]` 首行标记。

### 插入：一条链，四个通道

按当前 DSH 版本提供的 API 依次尝试，**通道怎么变，进输入框的都只是引用块**：

| 顺序 | 机制 | 适用 |
|---|---|---|
| 1 | 原生引用卡 `inputActions.insertQuote(text)` | 0.2.2-rc.1+ |
| 2 | 原生 chip `slash/input-insert-reference` | 更早的版本 |
| 3 | 纯文本 `inputActions.insertText(block, span)` | 有文本框即可 |
| 4 | 剪贴板兜底 | 以上都不可用时复制并提示粘贴 |

走 3/4 时**只用 toast 说明**（"已以纯文本引用""已复制"），提示文字不会写进输入框——它不该占你的 token。

## 配置

在 profile 的 `cordis.patch.yml` 里覆盖 `element-ref` 行。

| 字段 | 作用 | 默认 |
|---|---|---|
| `enabled` | 插件总开关 | `true` |
| `referenceStyle` | 进输入框的形态：`quote`（原生引用卡）/ `chip`（自定义 chip） | `quote` |
| `textDetail` | 引用块详细度：`compact` / `standard` / `full` | `standard` |
| `textBudget` | 引用块字符预算（模型要为此付费） | `520` |
| `agentBrowser` | 接管 dsh-ego-browser 启动的浏览器 | `true` |
| `edge` | 外部浏览器策略：`auto` / `off` | `auto` |
| `edgeExecutable` | 指定 Edge 路径 | `''`（自动找） |
| `edgeProfileDir` | 用指定 profile 启动（需先完全退出 Edge） | `''` |
| `attachPorts` | 附着已开调试端口的浏览器 | `[9222, 9223]` |
| `maxTargets` | 一次最多接管几个标签页 | `12` |
| `sessionTtlMs` | 拾取会话超时 | `120000` |
| `extension` | 启用扩展桥接（回环端口） | `true` |
| `extensionPort` | 扩展轮询的固定端口 | `45917` |

> [!IMPORTANT]
> 改完配置要**重载插件行**（关掉再打开）或重启，热更新的只有客户端模块，不上配置。

## 兼容性

- **声明**：`dsh.engines.dsh = ">=0.2.1-rc.1 <0.3.0-0"`，Node `>=20`，零运行时依赖。
- **实测**：

| 区间 | 等级 | 依据 |
|---|---|---|
| 0.2.2-rc.1 .. 0.2.2-rc.3 | **推荐**（完整：原生引用卡） | rc.3 浏览器级 + 真机长期使用；rc.1/rc.2 mount |
| 0.2.1-rc.1 .. 0.2.1-rc.5 | **兼容**（无引用卡，自动降级为 chip / 纯文本） | 5 个 rc 逐版 mount；rc.5 浏览器级 |
| 0.2.0.x | 不保证 | 仅 mount，未纳入 `engines` |

功能分界点是 `insertQuote`，它在 **0.2.2-rc.1** 才出现。所以 0.2.1 上引用走第二条路，属于设计内降级。

- 扩展：`minimum_chrome_version = "120"`（`chrome.alarms` 的 0.5 分钟周期需要），本机 Edge 157 实测。
- 版本之间确实变过东西：0.2.2-rc.2 调过浮层定位接口、工具错误分类与 Session 批量追加。本插件不使用这些接口；升级 DSH 后先跑一遍「装完先验三件事」。

设计与验证细节见 [docs/DESIGN.md](docs/DESIGN.md)。

## token 预算

- **无常驻提示词、不新增工具**：插件不往系统提示里加任何内容，模型侧成本只有你主动插入的引用块。
- 引用块默认 ≤ **520 字符**（`textBudget`），`standard` 档典型 200–260 字符；超预算按价值从低到高整行丢弃，不截断关键行。
- 降级/失败提示只走 toast，**不进对话、不进输入框**。

## 局限

- `closed` shadow root 读不到；`open` 的用 `>>>` 链表达。
- 侧栏网页只在桌面端是 `<webview>`（可注入）；用浏览器打开 Web GUI 时它是跨源 iframe，取不到内部 DOM。
- 外部浏览器必须有调试端口或装了扩展；已经启动且没有调试端口的进程无法事后接管。
- 同一时刻只允许一个拾取会话：第二个窗口开始拾取会接管，第一个收到提示。
- 站点没有可访问名（无 `aria-label`、无 `title`、无文本）的纯图标控件，只能给出选择器 + 序号。

## 变更

### 0.1.0 首个公开版本

- 四个面共用同一拾取内核（DSH 界面 / 侧栏网页 / Agent 浏览器 / 外部 Edge）
- 六层信息提取（目标 → 身份 → 位置 → 内容 → 重找 → 预算）
- 插入四通道降级（引用卡 → chip → 纯文本 → 剪贴板），失败必提示
- 原生引用卡与自定义 chip 两种形态
- 浏览器扩展：回环桥接 + 内核哈希校验 + 保活
- 失败可诊断：页面内 `lastError`、客户端 `/element-ref/diag`、扩展上报版本与内核哈希

## 开发与验证

```sh
node scripts/test.mjs          # 纯逻辑 + 内核/扩展同源 + 提示语不进输入框（300+ 断言）
node scripts/check-pack.mjs    # 发布纯净性：包里只有运行时文件，且与已载入的那份逐字节一致
```

沙箱（隔离 `DSH_HOME`，放在 `D:\Deepseek Hardness\dsh-workspace\compat\element-ref\`）：

```powershell
node scripts/compat.ps1           # 在共享沙箱里验证两个代表版本（本地 bin + link: 安装，秒级）
node scripts/verify-sandbox.mjs   # 共享沙箱体检（profile + 两个版本，14 项）
node scripts/compat-web.mjs 0.2.2-rc.3   # 浏览器级：起 dsh web + 无头 Edge 验客户端与图标
node scripts/state.mjs            # 三个地方一次看全：开发版 / 载入版 / 沙箱
```

沙箱里插件用 `link:` 安装（不是副本），安装用本地 `lib/bin.js`（不联网）；共享沙箱里只留两个代表版本（0.2.0-rc.2、0.2.1-rc.5）。

## License

MIT。



