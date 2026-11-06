# 选取协议（providers / outputs）

插件不含"硬编码的取元素方式"。一次选取被拆成两段：

```
屏幕上下文 ──► provider 解析 ──► pick ──► output 投递 ──► 输入框 / 剪贴板 / 你的程序
```

两段都是有序注册表，**都可以由用户自己加**。

## 目录

```
$DSH_HOME/element-picker/
  providers/*.mjs     # 解析协议：这个坐标/窗口该读成什么
  outputs/*.mjs       # 投递协议：读出来送哪里
```

改完文件不需要重启：`POST /element-picker/os/protocols/reload`，或直接把插件开关切一下。

## Provider

```js
export default {
  id: 'my-provider',          // 唯一
  label: '我的协议',
  priority: 50,               // 越大越先尝试
  match(ctx) { return true }, // 便宜的前置判断
  async pick(ctx) {
    // 返回 pick，或 null（"不是我的，交给下一个"）
    return {
      kind: 'element',        // element | url | file
      label: '按钮 · 保存',
      text: '保存',            // 可选
      selector: '#save',      // 可选（网页/DOM）
      page: 'https://…',      // 可选
      resource: 'https://…',  // 可选（图片/链接地址）
      path: 'C:\\a\\b.png',   // 可选（文件类）
      window: 'notepad — 文档.txt',
      controlType: 'Button', automationId: 'saveBtn', className: 'Button',
      bounds: { x, y, w, h },
      meta: { 任意: '你想带的信息' },
    }
  },
}
```

`ctx`：

```js
{
  point: { x: 900, y: 600 },                       // 物理像素
  window: { class: 'Chrome_WidgetWin_1', title: '…', processId: 123, processName: 'msedge' },
  hotkey: 'Ctrl+Alt+P',
}
```

## Output

```js
export default {
  id: 'copy-markdown',
  label: '复制为 Markdown',
  priority: 20,
  accept(pick) { return pick.kind === 'element' },
  async deliver(pick) { /* 想送哪送哪：剪贴板、HTTP、写文件… */ },
}
```

内置 output：

| id | 行为 |
|---|---|
| `composer` | 插进 DSH 输入框，成为引用 chip（默认） |
| `clipboard` | 把引用文本写进剪贴板 |

## 配置

`dsh-element-picker` 的插件 config：

```yaml
config:
  hotkey: 'Ctrl+Alt+P'
  inputs: ['browser-cdp', 'uia']      # 只用这些 provider（省略=全部，按 priority）
  outputs: ['composer']               # 只用这些 output
```

## 内置 provider

| id | 什么时候用它 |
|---|---|
| `browser-cdp` | 窗口类名是 `Chrome_WidgetWin_*`（Edge/Chrome/Electron），且浏览器带 `--remote-debugging-port`。把这一选交给标签页，读回真实 DOM：`选择器 / 页面 / 文本` |
| `desktop-wallpaper` | 点在桌面（`Progman`/`WorkerW`/explorer 空标题）上。不把桌面当"元素"，而是读注册表里的壁纸文件路径，得到 `kind: 'file'` |
| `uia` | 其余情况：Windows UI Automation 读光标下的控件（原生程序能读到按钮/输入框/列表项） |

## 例子

`$DSH_HOME/element-picker/providers/wallpaper-engine.mjs.example`
`$DSH_HOME/element-picker/outputs/clipboard-markdown.mjs.example`

去掉 `.example` 后缀即生效。它们演示了两件用户常提的事：**不把桌面当元素而是读壁纸图片**、**选完不进 DSH 而是进剪贴板**。

## 诊断

```
GET  /element-picker/os/protocols          # 当前注册了什么、有没有加载错误
POST /element-picker/os/protocols/reload   # 重新扫描用户目录
POST /element-picker/os/resolve            # {point, window} → 谁解析、谁投递
GET  /element-picker/os/cdp/status         # 浏览器调试端口是否可用
```
