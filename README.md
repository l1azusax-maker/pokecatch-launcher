# Poke'Catch 轻量 PC 启动器

一个专为 [Poke'Catch](https://pokecatch-online.netlify.app/) 网页游戏打造的轻量、低占用 PC 启动器。界面完全复刻游戏的设计语言（像素字体 Jersey、精灵球素材、深蓝黑配色）。

## 特性

- **打开即游戏**：启动后自动加载游戏，无需浏览器、无需手动输入网址。默认窗口按工作区给到舒展的 1440×900（上限）
- **无边框窗口 + 标题栏在窗口层**：标题栏不是注入到游戏页面里的一段 HTML，而是**窗口自己的一个本地页面**（`assets/shell.html`，36px 高，`-webkit-app-region: drag` 原生拖动 + 最小化/最大化/关闭按钮）。游戏跑在下面的 `WebContentsView` 里，视图边界 = 窗口内容区 − 36px
- **完全不改游戏布局**：游戏拿到的是自己的独立视口（`100vh` 就等于它那块区域），所以「为了给标题栏让位」而改游戏 CSS 的补偿全都不需要 —— `body` padding、`#app` 锁屏、`<main>` 自滚、滚动条补样式、`.pc-sticky` / `.team-mini` 吸顶偏移、`#modal-root` 下移这些**全部删除**。游戏改版（换类名、换布局）不会让启动器失效
- **加载动画**：独立透明窗口里的精灵球——照捕捉宝可梦那一下的手感，绕球心左右摇晃三下（幅度递减）再停一下，循环；球心坐标不动、只旋转，脚下有静止的投影（纯动画，无进度条）。主窗口在后台并行渲染游戏，检测到真正就绪才淡出
- **游戏风格 UI**：标题栏复用游戏素材（Jersey 字体、精灵球 SVG、`#141826` / `#1a1e2c` 深蓝黑配色）
- **内置篡改猴脚本引擎**：按固定顺序注入 3 个内置脚本（启动器设置 → 异色蛋预览 → 优化脚本），再注入用户自定义的 `.user.js`；全部走 `webContents.executeJavaScript`，共享页面的 `window.launcher`
- **脚本自动更新**：每次启动在后台（与游戏加载并行、不挡进游戏）检查一次带来源链接的脚本；更新成功且当前页面用的还是旧版本时，用启动器提示框询问「N 个脚本已更新，是否刷新？」——确认刷新、取消留给下次启动生效
- **启动器自动更新**：打包版通过 GitHub Releases 后台检查并下载新版；下载完成后可立即重启安装，也可在退出时自动安装。开发模式不会发起检查
- **导入/更新后询问刷新**：在「通用」页的启动器分区里用链接或文件导入脚本、或点「检查更新」发生实际变更时，会先收起游戏设置面板再弹提示；取消 → 面板自动回到「通用」，确认 → 直接刷新游戏页
- **F11 全屏（仅窗口聚焦时触发）**：全屏时游戏视图铺满整个窗口、标题栏隐藏，并保持 `screen-saver` 级置顶 —— **点到窗口外面（任务栏、其它窗口）也不会被盖住**（失焦时只 `moveTop()` 抬回最前，不抢键盘焦点；只有打开系统浏览器登录这种确实要给别人让位的时候才临时撤销，撤销后 1 秒一次的看门狗不会把它顶回去，重新获得焦点就恢复）；只铺满窗口所在的那块屏（含副屏/竖屏/混合缩放），不会越界。窗口最小尺寸固定为 615×480，**拖到哪块屏、拖多大都不会被自动吸附或改尺寸**。
  - **窗口切换丝滑过渡**：最大化 ⇄ 还原、全屏 ⇄ 最大化都用 `setBounds` 逐帧插值（ease-in-out cubic，约 200ms）平滑过渡，不再瞬时跳变。因为 `thickFrame:false`（见「直角窗口」）关掉了 Windows 原生的窗口动画，这里用自绘动画补回 —— 最大化目标 = 所在显示器工作区（与系统最大化矩形一致），还原目标 = 最大化前手动保存的 normal bounds（`setBounds` 改尺寸会污染 `getNormalBounds()`，所以不依赖它）。动画期间不碰 `setShape`（保持无区域矩形，避免中间帧整窗重合成导致的闪烁），动画结束再按最终几何精确落位。没有任务栏的屏（副屏、全屏工作区）上最大化矩形本就铺满整屏，最大化 ⇄ 全屏之间几何零变化、只有标题栏收起/恢复
- **设置并入游戏面板**：没有独立的设置窗口，也不单独占 Tab ——「游戏 / 油猴脚本 / 关于」三块直接追加在游戏设置面板「通用」页的原生设置下面，用游戏自己的分组标题、卡片、开关、按钮样式。按 `F12` 打开面板，**再按一次 `F12` 收起**；打开时不会自动往下滚
- **异色蛋预览（内置，可开关）**：只读本地存档 `gachamon-save-v1`，按游戏自己的判定算法（固定哈希 + 基础 1/512、异色亲本 1/16 或 1/10、果子 ×2、`shiny` 字段优先）算出培育屋里每颗蛋是否为异色，在蛋名后追加游戏原生 `.shiny-mk` 标记，并把右侧头像换成 `assets/pokemon/shiny/` 的异色图。不写存档、不改孵化计时与结果、不自动操作；设置里可一键关闭，关闭后标记与头像立即还原
- **提示框同风格**：插件（脚本）变更后的「是否刷新」提示也走游戏的设计语言（同款头部渐变 + 2px 底线 + 红框关闭键、卡片式文件名行、蓝调主按钮）；文案统一叫「插件」，数字与文字、状态点与文件名都做了垂直居中
- **第三方登录可用**：谷歌按内核指纹判定「不安全的嵌入式浏览器」，Electron 内嵌窗口即使伪装 UA / Client Hints 也会被拒。所以登录这一步交给系统浏览器完成——点登录后自动在默认浏览器打开授权页，本地回环接住 `#access_token`，再整页带回游戏自动完成登录
- **直角窗口**：不做窗口圆角，也不给窗口设区域（`setShape`）。一是带区域的窗口拿不到 DWM 的 hardware overlay / Independent Flip 直出，每帧要多经过一次整窗合成、每次改区域还要整窗重画，成本随窗口面积走；二是方角在 Win10 上本来就和系统其它窗口一致。窗口设 `thickFrame:false` 去掉 Electron 默认给无边框可缩放窗口加的那圈原生 `WS_THICKFRAME` 厚调整边框（那圈渲染器画不到、最大化/还原动画期间被系统用白色填充，就是白边的根源）；代价是失去 Windows 原生阴影和系统窗口动画 —— 阴影的缺失由深色直角窗口掩盖，动画由「窗口切换丝滑过渡」的自绘插值补回。唯一保留的裁剪是**最大化 / 全屏 + 多屏**：可缩放的无边框窗口最大化时，系统会加一圈 8px 不可见的调整边框，那圈边框会伸出屏幕落到隔壁显示器上、系统还在边框上画一条 1px 灰线 —— 这时才把窗口区域裁到客户区（单屏没有这个问题，什么都不做）。提示框也是直角不透明窗口（省掉透明窗口那层 alpha 合成）
- **单一应用标识**：启动时 `app.setAppUserModelId('com.pokecatch.launcher')`（与 `build.appId` 一致）。不设的话主进程和 Chromium 子进程会被 Windows 任务管理器当成不同应用，显示成两组 `PokeCatch`；设了之后合并成一条，任务栏图标 / 跳转列表 / Toast 归属也都正确
- **低占用优化**：单实例锁、关闭默认菜单、非登录类外链拦截、会话与缓存走默认持久化（登录态保留）。开启「最小化时保持在线」时，仅对游戏视图动态关闭后台降频；关闭该设置后恢复 Chromium 默认节流，后台 CPU / GPU 可以真正降下来。窗口不设区域（直角，DWM 能走硬件直出，见上面的「直角窗口」）
- **最小权限隔离**：游戏、标题栏、刷新提示框使用三份独立 preload；远程游戏拿不到窗口控制和提示框 API，所有 IPC 都校验调用来源，相机/麦克风/定位等系统权限默认拒绝

## 架构：标题栏在窗口层，游戏零改造

```
BrowserWindow（frame:false，尺寸含标题栏，例如 1440×936）
├─ 窗口自身页面 = assets/shell.html   ← 36px 高的标题栏（拖拽区 + 三个按钮）
└─ WebContentsView（游戏）           ← bounds = { x:0, y:36, w, h−36 }
                                     全屏时 bounds = { x:0, y:0, w, h }
```

这样游戏拿到的视口就是「窗口内容区 − 36px」，`100vh`、`position:fixed`、`position:sticky`、文档滚动条的语义与在浏览器里完全一致。**启动器只负责摆放这个视图，不往游戏页面注入任何布局或补偿样式。**

**启动器不往游戏页面注入任何布局或审美 CSS。** 游戏的排版、留白（比如 `#app` 的 `max-width:1860px`）、筛选栏折行后的样子，全部按游戏原样显示 —— 想改外观请用自己的油猴脚本。

唯一的例外是 `scripts/builtin-optimize.user.js` 里那一条**纯性能**规则（字体抗锯齿）。它不涉及布局，改版失效也只是回到游戏默认；而且设在 `html` 上靠继承生效，不用 `*` 通配符 —— 通配符会进 Chromium 的「通用失效集」，页面里任何一次 class / 属性变更都要全文档重算样式。

另外几处与游戏相关但不是布局的钩子，都属于「行为钩子」，失效时游戏仍能正常玩：

- `window.Theme.set('dark')` —— 固定深色主题
- `document.documentElement.style.colorScheme = 'dark'` —— 让原生 UI 部件（下拉、表单控件、以及未被下面皮肤覆盖的滚动条）按深色渲染。
- **滚动条皮肤**（`applyScrollbarSkin`，`webContents.insertCSS`；**用逐个列出的容器清单，不用 `*::-webkit-scrollbar`** —— 通配符会进 Chromium 的「通用失效集」，页面里任何一次 class / 属性变更都要全文档重算样式；这游戏是 DOM 密集型（战斗页一帧动几十上百个节点、开一次面板插入上千个节点），实测同一界面 94fps→120fps，「插入 300 节点并强制样式+布局」4.4ms→3.8ms）—— 游戏只给 `html / .timeline / .mp-pk / .side / .ev-board / .cr-pks / .mk-pc` 写了 `::-webkit-scrollbar`，其余 32 个可滚容器（`.modal`、`.modal > .modal-body`、`.evt-pick > #evt-pc`、`.raid-scroll`、`.ug-rk-grid`、`.gd-page` …，清单在 `main.js` 的 `SCROLLBAR_CONTAINERS`）用 Chromium 原生滚动条。这些容器**逐个列出来**：规则会被选择器索引命中，只有命中的容器付代价；也**不能**把游戏自己写过的那几个列进去 —— `insertCSS` 插在游戏样式表之后，`.side::-webkit-scrollbar` 与 `.side, .modal::-webkit-scrollbar` 的 specificity 同为 (0,1,0)，同分时后插入的胜出，会把游戏的 8px 滚动条改粗。颜色取游戏的 `--line / --bg / --line-hover`，游戏换深浅色主题时自动跟着换；以 author 级插入，只填游戏没写样式的空白。实测：合成 `.modal` 的滚动条由 gutter 22/亮度 66（原生）变为 gutter 14/滑块 33 + 轨道 24（与游戏一致），`.side` 与文档滚动条不受影响。游戏的深色主题只在几个「舞台」元素（`.evo-stage`、`.raid-hero` …）上写了 `color-scheme: dark`，`:root` 上只有 `:root[data-theme=light]{color-scheme:light}`，所以根元素的 `color-scheme` 会退回 `normal`（=浅色），没写 `::-webkit-scrollbar` 的容器就会渲染成浅色原生滚动条（带上下箭头）。实测同一元素：`normal` 时滚动条亮度 241，`dark` 时 66
- `document.hidden` / `visibilitychange` 接管 —— 最小化保持在线

## 快速开始

```bash
npm install
npm test
npm start
```

> 若安装 Electron 二进制失败（网络问题），可设置国内镜像：
> ```bash
> ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/" npm install
> ```

## 打包发布

```bash
npm run dist
```

打包产物统一输出到 `release/`（Windows 下是 NSIS 安装程序 `PokeCatch Setup <版本>.exe` + `win-unpacked/`）。该目录已在 `.gitignore` 里；历史迭代留下的 `release2`…`release53` 已合并清理，只保留最新一次构建。

### GitHub 自动发布与更新

仓库的 `.github/workflows/release.yml` 会在推送 `v*` 标签时使用 Windows runner：执行测试、构建 NSIS 安装包，并把安装包、blockmap 与 `latest.yml` 发布到 GitHub Release。标签版本必须与 `package.json` 一致，例如：

```bash
npm version 1.1.1
git push --follow-tags
```

工作流使用仓库自带的 `GITHUB_TOKEN`，无需提交个人令牌。自动更新只支持已经安装的 NSIS 版本；ZIP 便携版仍会构建，但不参与自动安装。

## 快捷键

| 按键 | 功能 |
|------|------|
| `F11` | 切换全屏（仅当前窗口聚焦时；`Esc` 退出全屏） |
| `F12` | 打开 / 关闭设置面板（打开时切到「通用」） |

> 两个键的监听同时挂在游戏视图和窗口层标题栏上：焦点偶尔会落在标题栏（刚启动、点过标题栏），这样按哪个都有反应，且不会重复触发。

## 内置脚本与自定义脚本

### 内置脚本

- `scripts/launcher-tab.user.js` —— 把「游戏 / 油猴脚本 / 关于」三块注入游戏设置面板的「通用」页（脚本导入/更新/删除、在线保持与异色蛋开关、关于），并响应 `F12` 打开/关闭
- `scripts/shiny-egg.user.js` —— 异色蛋预览（只读存档 + 固定哈希判定 + 标记/换图，设置里的开关实时生效）
- `scripts/builtin-optimize.user.js` —— 字体抗锯齿（设在 `html` 上靠继承生效，不用通配符；纯性能，不涉及布局）

> 已退役并移到 `backups/retired/`：`titlebar-inject.user.js`（把标题栏注入游戏页面 + 一大堆布局补偿）、`game-tweaks.user.js`（两条审美补丁：宽屏铺满、窄屏筛选栏收齐）。当前启动器**不往游戏页面注入任何布局或审美 CSS**。

### 自定义篡改猴脚本

**方式一（推荐）**：按 `F12` → 点「导入脚本」选择 `.user.js` 文件，支持多选导入、更新、删除。

**方式二**：直接把 `.user.js` 或 `.js` 文件放到用户数据目录：

```
%APPDATA%/pokecatch-launcher/scripts/
```

启动器会在游戏页面加载后自动注入执行（不校验 `@match`，所有脚本都会注入，请自行控制逻辑）。

**更新检测的判定规则**（设置页「检查更新」与启动自检共用）：
- 来源优先用 `scripts-meta.json` 里记录的导入 URL，没有则回落到脚本自身的 `@downloadURL` / `@updateURL`。
- 先比 `@version`：远端更高才算更新；远端更低（作者回滚）不会覆盖本地。
- 版本号相同但内容不同 → 也算更新（作者常改完忘改 `@version`）。比较前会归一化 BOM / 换行 / 行尾空白。
- 手动点「检查更新」会强制绕过 HTTP 缓存（`Cache-Control: no-cache` + 时间戳参数）。GitHub 的 raw 地址带 `max-age=300`，不绕过的话刚推上去的新版本 5 分钟内都会被缓存挡住，看起来就是「检测不到」；启动自检则允许走缓存，避免每次开程序都重下几 MB。
- 导入、更新和所有重定向都必须保持 HTTPS。GitHub Gist 的 `https://gist.githubusercontent.com/...` raw 链接正常支持；如果来源降级到明文 HTTP，会明确拒绝。
- 下载按 `Content-Length` 校验完整性，超时 90s；失败会在设置页的提示条里报出脚本名和原因（以前是静默跳过）。
- 启动检查最多并发 3 个下载，写入仍串行执行；备份每个脚本最多保留 5 份，备份目录总量最多 64MB。

## 命令行参数

| 参数 | 说明 |
|------|------|
| `--disable-gpu` | 关闭硬件加速（默认是开启的：游戏是 DOM/Canvas 密集渲染，关掉更省资源但画面更卡） |
| `--enable-gpu` | 显式确认开启硬件加速（等同默认行为；与 `--disable-gpu` 同时给时以它为准） |

环境变量（都不影响正常启动）：

| 变量 | 说明 |
|------|------|
| `PC_DEBUG=1` | 把调试日志追加写入 `%TEMP%/pc-debug.log`。其中的 `[gpu]` 一行会报 `gpu_compositing / rasterization / 2d_canvas` 的实际状态 —— 掉到 `disabled_software` 就说明这台机器上硬件加速没起来（驱动被 Chromium 拉黑、远程桌面会话、虚拟显示器抢了 DWM 输出都会这样），此时任何 CSS 优化都救不回来 |
| `PC_FPS=1` | 在游戏页左下角显示 `fps / worst 帧耗时`（只在渲染进程里跑一个 rAF 计数，正常启动不注入） |
| `PC_NO_SKIN=1` | 不注入滚动条皮肤。用来 A/B 判断「某个滚动条/滚动条闪烁是不是皮肤带来的」 |
| `PC_DISABLE_AUTO_UPDATE=1` | 禁用启动器的 GitHub Releases 自动更新检查（开发模式本来就不会检查） |


## 项目结构

```
pokecatch-launcher/
├── main.js                          # 主进程：窗口 + 游戏 WebContentsView、splash、全屏、脚本引擎、登录桥、脚本更新
├── preload.js                       # 游戏视图预加载：只暴露设置与脚本管理 API
├── preload-shell.js                 # 本地标题栏预加载：只暴露窗口按钮 API
├── preload-notice.js                # 本地刷新提示框预加载：只暴露确认/取消 API
├── lib/
│   ├── app-updater.js               # GitHub Releases 自动更新
│   ├── script-utils.js               # SemVer、脚本 URL 与文件类型校验
│   ├── script-backups.js             # 备份保留与容量限制
│   └── concurrency.js                # 有界并发工具
├── assets/
│   ├── shell.html                   # 窗口层标题栏（36px，拖拽区 + 最小化/最大化/关闭）
│   ├── splash.html                  # 加载动画窗口（透明窗口：精灵球绕球心左右摇晃 + 静止投影）
│   ├── notice.html                  # 脚本变更后的「是否刷新」提示框（固定 440×242）
│   ├── icon.png / icon.ico / icon.svg
│   ├── jersey-10.woff2 / jersey-15.woff2
├── scripts/                         # 内置注入脚本（打包时随文件一起进 app）
│   ├── launcher-tab.user.js         # 注入「通用」页的三块启动器设置（含 F12 开关）
│   ├── shiny-egg.user.js            # 异色蛋预览（只读存档，设置里可开关）
│   ├── builtin-optimize.user.js     # 内置优化脚本
│   └── README.md                    # 脚本目录说明
├── backups/                         # 游戏存档导出样本 + 退役脚本（不打包）
├── test/                            # Node 内置测试（版本、URL、并发等）
├── .github/workflows/release.yml    # 标签触发的 GitHub Release 构建
└── release/                         # 打包产物（只有最新一次构建，已 gitignore）
```

## 运行时数据（`%APPDATA%/pokecatch-launcher/`）

| 文件 | 内容 |
|------|------|
| `settings.json` | `keepActive`（最小化保持在线）、`shinyEgg`（异色蛋预览） |
| `scripts/` | 用户导入的 `.user.js` |
| `scripts-backups/` | 脚本更新、覆盖或删除前的旧版本（每个脚本最多 5 份，总量最多 64MB） |
| `scripts-meta.json` | 每个脚本的 `sourceUrl` / `version` / `updatedAt`（更新检测用） |
| `window-state.json` | 窗口几何（存的是「游戏可用高度」，不含标题栏，换版本不会越开越高）+ 是否最大化 |

> 打包版与开发版共用这个目录（asar 里的 `package.json` 没写 `productName`，`app.getName()` 取到的是包名），所以存档与登录态是同一套。

设置 `PC_DEBUG=1` 启动时，调试日志追加写入 `%TEMP%/pc-debug.log`。
