# Poke'Catch PC 启动器

轻量的 Windows 桌面启动器，直接运行 [Poke'Catch](https://pokecatch-online.netlify.app/)。

## 功能

- 独立游戏窗口与自绘标题栏
- 全屏、窗口状态记忆和多显示器支持
- 游戏风格加载动画与设置界面
- 第三方登录支持
- 自定义用户脚本导入、管理和自动更新
- 异色蛋预览与基础性能优化
- 通过 GitHub Releases 自动更新启动器

## 使用

安装并启动后会直接进入游戏。

| 快捷键 | 功能 |
| --- | --- |
| `F11` | 切换全屏，`Esc` 退出全屏 |
| `F12` | 打开或关闭启动器设置 |

自定义脚本可以在设置中导入，也可以放入：

```text
%APPDATA%/pokecatch-launcher/scripts/
```

仅支持 `.js` 和 `.user.js`，在线导入与更新需要使用 HTTPS。

## 开发

需要 Node.js 和 npm。

```bash
npm install
npm test
npm start
```

构建 Windows 安装包：

```bash
npm run dist
```

产物输出到 `release/`。

## 发布

推送与 `package.json` 版本一致的 `v*` 标签后，GitHub Actions 会构建并发布安装包：

```bash
npm version patch
git push --follow-tags
```

已安装的正式版会通过 GitHub Releases 检查更新。

## 数据目录

设置、登录状态、窗口状态和用户脚本保存在：

```text
%APPDATA%/pokecatch-launcher/
```

卸载或升级启动器不会主动删除这些数据。

## 许可证

MIT
