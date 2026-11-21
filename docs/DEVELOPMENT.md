# 开发与验证

面向贡献者；用户安装、配置与使用请看 [README](../README.md)。

## 本地检查

```sh
node scripts/test.mjs          # 纯逻辑 + 内核/扩展同源 + 提示语不进输入框（300+ 断言）
node scripts/check-pack.mjs    # 发布纯净性：包里只有运行时文件，且与已载入的那份逐字节一致
```

## 共享沙箱

沙箱（隔离 `DSH_HOME`，放在 `D:\dsh_data\sandbox\compat\versions\0.2.2-rc.5\dsh-home\`）：

```powershell
node scripts/compat.ps1           # 在共享沙箱里验证两个边界版本（缓存 DSH 的 lib/bin.js 直跑 + 插件 link: 安装，秒级）
node scripts/verify-sandbox.mjs   # 共享沙箱体检（profile + 两个版本，14 项）
node scripts/compat-web.mjs 0.2.2-rc.3   # 浏览器级：起 dsh web + 无头 Edge 验客户端与图标
node scripts/state.mjs            # 开发版 / 载入版 / 沙箱一次看全
```

沙箱里插件用 `link:` 安装（不是副本）；DSH 用缓存包里的 `lib/bin.js` 直接运行（不联网）。共享沙箱只留两个**边界版本**：

- `0.2.0-rc.2`：0.2.x 起点，用来探下限，**不承诺支持**；
- `0.2.1-rc.5`：`insertQuote` 出现前最后一个版本；
- `0.2.2-rc.4`：升级前基线；
- `0.2.2-rc.5`：当前桌面端，最新 `next`。

当前桌面端 `0.2.2-rc.5` 用真机验证，同时保留在沙箱。

