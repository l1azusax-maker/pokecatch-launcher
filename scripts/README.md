# 篡改猴脚本目录

把 `.user.js` 或 `.js` 文件放到用户脚本目录，启动器会自动在游戏页面注入执行。

> 实际用户脚本目录在应用数据目录下（首次运行自动创建）：
> `%APPDATA%/pokecatch-launcher/scripts/`（Windows）

## 示例

放入任意 `.user.js` 文件，例如 `my-plugin.user.js`：

```js
// ==UserScript==
// @name         我的脚本
// @version      1.0.0
// @match        https://pokecatch-online.app/*
// ==/UserScript==
(() => {
  'use strict';
  // 你的代码
  console.log('我的脚本已运行');
})();
```

> 启动器不校验 `@match`，所有已启用的脚本都会注入到游戏页面，可在设置面板中单独启用或停用。
