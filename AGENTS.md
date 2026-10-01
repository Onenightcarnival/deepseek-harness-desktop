# AGENTS.md

本仓库提供 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 Electron 壳、打包与分发，产出 Windows exe 与 macOS dmg。内核由 `stage-dsh.mjs` 从 npm 安装；内核行为在上游仓库维护。

## 架构

- 主进程用 Electron 内置 Node（`ELECTRON_RUN_AS_NODE=1`）spawn `dsh web --patch <覆盖层> --port 0`，从 stdout 解析就绪行 `dsh web: http://127.0.0.1:<port>/?token=…`，在 BrowserWindow 里加载该 URL。
- 关窗即杀服务进程。开启「关闭时最小化到托盘」后关窗只隐藏窗口，服务继续，退出走托盘或应用菜单。
- 全部 dsh 数据在 `~/.dsh`，与命令行版共享。

## 文件地图

| 文件 | 职责 |
|---|---|
| `main.js` | 服务进程、窗口、菜单、应用与内核更新、CLI 启动器、配置中心 IPC、托盘与系统唤醒 |
| `runtime.js` | 无 Electron 依赖的版本选择、engines 校验、配置归一化与代理函数 |
| `win-spawn-shim.js` | 子进程隐藏、隐形宿主控制台与预加载传播；启动时复制到 userData，非 Windows 为无操作 |
| `plugins/dsh-desktop-directory-picker` | 工作区系统目录选择器 |
| `plugins/dsh-desktop-activity` | 每 2 秒读取 agents/jobs，经 IPC 上报任务忙闲 |
| `proxy-forward.js` | 回环转发器、HTTP / CONNECT 与逐连接路由 |
| `plugins.html` | 插件、通用与代理三页；通用值存 userData/general.json |
| `window-chrome.js` | 标题栏、可信主 frame IPC、主题与全屏同步 |
| `preload-desktop.js` | 平台布局、菜单桥、主题探针；配置中心独占 pluginApi |
| `desktop-i18n.js` | 桌面界面中英词典与插值 |
| `splash.js` | 启动等待文案的语言同步 |
| `desktop.css` / `splash.html` | 原生按钮安全区、拖拽区与主题 / 启动页 |
| `stage-dsh.mjs` | 从 locks 安装并裁剪运行时，安装 pnpm，登记预置包 |
| `update-locks.mjs` | 内核与插件版本、依赖闭包与锁文件更新 |
| `afterPack.js` | 将 staging 复制到 resources/dsh，过滤旧 tools/uv |
| `desktop-patch.yml` | 随包分发的组合覆盖层，默认空 |
| `plugins.json` / `plugins-full.json` | minimal / full 清单；packages 激活，carry 仅加入依赖闭包 |
| `build/installer.nsh` | 安装 / 卸载进程清理、阶段提示与提取钩子 |
| `build/extract-long-paths.nsh` | 长路径解压、Robocopy 复制与失败重试 |
| `build/test-*.cjs` / `build/test-*.mjs` | 窗口、旧 uv 迁移与安装载荷回归 |
| `.github/workflows/release.yml` | 原生构建与发版 |

stage 按 DSH_FLAVOR 选择预置清单，将精确版本写入运行时的 `preset-plugins.json`（seed / carry）。`syncPresetPlugins` 每次启动同步 seed 组。

原生菜单与窗口配色跟随页面主题。`data-ds-theme-source` 同步到 `nativeTheme.themeSource`，`system` 保留系统主题监听。

## 代理链路

`proxy-forward.js` 按连接决定子进程的代理路由。

- 主进程在 `app.whenReady` 里、早于任何 spawn，起一个 127.0.0.1 随机端口的转发器。
- 所有子进程拿到同一组环境：`HTTP(S)_PROXY=http://127.0.0.1:<port>`、`NO_PROXY=127.0.0.1,localhost,::1`、`npm_config_proxy`（压过 `~/.npmrc` 的 `proxy=`）、`NODE_USE_ENV_PROXY=1`。注入前按 `PROXY_ENV_KEYS` 大小写不敏感清掉继承的代理变量。
- 三种模式在转发器内按连接决策（`routeFor`）：
  - none：一律直连。
  - manual：命中例外列表直连，否则 CONNECT 上游并注入 `Proxy-Authorization`。
  - system：Chromium `session.resolveProxy(目标URL)` 逐 URL 询问操作系统，含 PAC 与例外列表。
- 配置修改立即对运行中的子进程生效；`proxy:save` 仍重启 dsh 服务以刷新 TLS 相关变量。密码不进子进程环境。例外列表只有 `isBypassed` 一套语义。
- 配置存 `userData/proxy.json`（旧 `{enabled,url}` 形态自动迁移），密码仅在勾选「记住」时落盘。
- CLI shim 是持久化文件，转发器端口不是：shim 里的 `HTTP_PROXY` 只在应用运行期间有效。`will-quit` 把 shim 重写为只清场不注入，下次启动写回新端口；崩溃留下的死端口下次启动自愈。
- 壳窗口自身流量不走转发器：`applyChromiumProxy` 按同一份配置 `setProxy`（system 模式用 Chromium 原生 `mode: 'system'`），代理认证由 `app.on('login')` 补全。主进程自己发的 HTTP（更新检查、MCP 的 http 探测）用 `electronNet.fetch`；普通 `fetch` 不跟随配置，不用。

## 验证手段

按改动范围运行相应检查。Windows / macOS 安装包和原生 GUI 在对应平台验收。`release.yml` 的 workflow_dispatch 生成产物，`v*` 标签发布 Release。

```sh
node --check main.js                                 # 主进程语法
node --check runtime.js
node --check window-chrome.js
node --check preload-desktop.js
node build/test-windows-execution-level.cjs          # Windows EXE 管理员权限清单
node build/test-uv-removal.cjs                       # 旧 uv 启动器迁移
node -e "require('./runtime.js')"                     # runtime.js 独立可加载，纯函数直接单测
node stage-dsh.mjs                                    # linux 实跑 staging（node-pty 无 linux 预编译，脚本按平台跳过该断言）
DSH_FLAVOR=full node stage-dsh.mjs                    # full flavor：预置清单可装、peer 匹配、preset-plugins.json 生成
node update-locks.mjs <dsh版本> ["插件@版本"...]    # 升级 dsh：把上一份 full 锁平移到目标版本并重写两份锁
node stage-dsh.mjs --update-locks                     # 实时解析路径，可能指数回溯，优先用上一条
node staging/linux-x64/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js \
  web --patch desktop-patch.yml --dump-config         # patch 覆盖层并入组合树
```

**代理链路**：`runtime.js` 的纯函数直接断言；`proxy-forward.js` 注入假 `resolveSystem` 端到端测：起一个 origin server、一个记录请求的上游代理桩、一个 TLS origin，断言外网目标进桩、loopback 与内网名字不进桩、CONNECT 隧道能跑 TLS、上游不可达时回 502。

**无头启动 dsh 服务**（`curl <ready-url>` 返回 303/200）：

- linux 先补 node-pty：`npm pack node-pty@<版本>` 解包后 `npx node-gyp rebuild --nodedir=<本地 node 目录>`，把 `pty.node` 放进 staging 的 `node-pty/prebuilds/linux-x64/`。
- 就绪行带一次性 token：先请求 token URL 换 cookie（303），再用 cookie 取首页。同一 token 只能换一次 cookie，换浏览器需重启服务。
- 预置插件挂载探针：客户端 bundle 只经组合路由下发。取首页 HTML 里 `href="/plugins/??…&rev=<hash>"` 的精确 URL 拉 bundle，断言其中含 `id: "<包名>"`。单包 `/plugins/<包名>/client.js` 与自拼组合均 404。

**Electron 部分**：

- `node build/test-window-chrome.cjs`：隔离 userData 的真实 Electron 检查，覆盖配置桥来源隔离、深浅主题、三页控件、Windows 原生菜单与按钮安全区域、缩放和全屏；截图写 `staging/window-chrome-test/`。测试会短暂显示窗口以验证原生全屏事件。可用 `DSHDESKTOP_TEST_ELECTRON` 指定本机 Electron 可执行文件；同时设置 `DSHDESKTOP_TEST_RUNTIME`（含 node_modules 的 dsh 目录）和 `DSHDESKTOP_TEST_HOME`（必须位于 staging 内的隔离 profile）时额外启动真实内核检查主界面。macOS 的原生按钮与 vibrancy 需在 Mac 上运行验收，Windows 只能验证 macOS 布局与选项。

- 冒烟：`xvfb-run electron <仓库目录> --no-sandbox`，看 dsh 子进程起来、就绪端口可 curl、日志无 Uncaught。
- 配置中心页面：Playwright `addInitScript` 注入假 `window.pluginApi` 后打开 `plugins.html` 截图；或 `--remote-debugging-port` 启动后 `connectOverCDP` 操作真实页面（不要 `browser.close()`，会关掉 Electron）。
- 窗口关闭行为：用 python-xlib 给窗口发 `WM_DELETE_WINDOW` ClientMessage。`xdotool windowclose` 是 XDestroyWindow，渲染进程的 `window.close()` 不经过 BrowserWindow 的 close 事件，两者都测不到 preventDefault 路径。
- 托盘图标在 Xvfb 里看不到，只能验证代码路径不抛错。

**NSIS 编译**：使用 `-WX`，警告即错误。Linux 编译需要 Wine 64 位与 32 位支持；安装行为以 Windows 原生载荷回归为准。

**Windows 安装载荷回归**：`node build/test-installer-copy.mjs <makensis.exe> <NSIS插件目录> <7za.exe> [<完整载荷.7z> <win-unpacked目录>]`。使用生产提取宏，在隔离目录验证长路径文件的 SHA256、首次安装、覆盖安装、保留额外文件、占用失败和解除占用后重试。附加完整载荷时，逐文件验证真实应用的首次与覆盖安装内容。只写 `staging/installer-copy-test-*` 和临时复制日志，不写注册表 / 快捷方式。

## 运行与构建约束

### 启动与运行时

- **Node 模式**：启动 dsh 必须传入 `--expose-internals`，供 cordis 加载器解析 Node 内部模块。
- **Electron 版本**：精确锁定 `44.0.0`。升级前核对 `node-addon-require-builtin` 的 V8 指纹表与内核 Node engines；0.2.0 线支持 43.0.0 / 44.0.0 / 45.0.0-alpha.6。
- **应用内更新（Windows）走 electron-updater 的 GitHub provider**，对着 `updateRepo` 的 Release。
  - `build.publish` 配成 github 后，`--publish never` 也会在 dist 写更新信息文件；发布流程把 `*.yml`（排除 builder-debug.yml）一并上传。
  - `nsis.differentialPackage: false`：更新下载整包，不产出 `.exe.blockmap`。
  - 两种 flavor 分频道：minimal 走默认 `latest.yml`；full 用 `-c.publish.channel=full` 写 `full.yml`，并以 `-c.extraMetadata.flavor=full` 把 flavor 记进包内 package.json，运行时据此设 `autoUpdater.channel`。设 channel 会把 allowDowngrade 置 true，之后显式关掉。
  - 安装包未签名：electron-updater 未配 `publisherName` 时跳过签名校验。
  - `quitAndInstall(true, true)` 以 `/S --updated --force-run` 运行新安装包，走 installer.nsh 的 isUpdated 路径（不弹「正在运行」确认）。
  - macOS 未签名，更新入口打开下载页。
- **工作区目录选择器走壳的系统对话框**（全平台）。`pickerPatchArgs` 停用 directory-picker-auto，挂 `plugins/dsh-desktop-directory-picker`（host，`native` 能力）+ dsh 自带的 `@deepseek-ai/dsh-client-ui-directory-picker-native`（client-ui）。dsh 服务以 `stdio[3]='ipc'` 启动，插件把 pick 请求经 `process.send` 发给壳，壳用 `dialog.showOpenDialog` 在主窗口上开对话框后回传路径；取消回 null；调用方 abort 时插件发 cancel，壳丢弃结果。
  - 目录选择器的 host 与 client-ui 必须成对挂载。
- **`plugins/<name>` 是壳自带的 dsh 插件包**（纯 JS，不打包）。stage 把它们拷进运行时 node_modules 并登记进 dsh 应用清单（与预置同一解析路径）；打包后放 extraResources 的 `plugins/`，`ensureDesktopPlugins` 在每次启动前和内核升级后把当前拷贝写进活动运行时。不进 profile，不进 preset-plugins.json。
- **`--patch` 层在用户 profile 配置层之后应用**，desktop-patch.yml 里的条目用户无法覆盖。
- **dsh launcher 只解析 argv 开头属于自己的旗标**（`--profile`/`--patch`），遇到第一个陌生 token 就把剩余交给应用层。`--no-open`/`--port` 等应用旗标必须放在全部 patch 参数之后。
- **壳必须传 `--no-open`**：rc8 起 `dsh web` 默认打开系统浏览器。
- **就绪行带一次性 token**（0.1.2-rc.1 起）：裸 origin 回 401，`/api` 受浏览器信任围栏保护。READY_RE 捕获整条 URL（含 query）并原样 loadURL；每次启动 token 不同。CLI 形态为 `dsh --profile web`，子命令形态 `dsh web` 仍接受。
- **每次 loadURL 前清掉 `127.0.0.1` 下全部 `dsh-auth-*` cookie**（`loadWebUi`）。dsh 每个服务实例下发一个名字随机的 `dsh-auth-<随机>` cookie（30 天过期），cookie 按 host 不按端口隔离，每次启动多留一个且全部随请求发出；约 65 个时 Cookie 头近 16 KB，加上 2.8 KB 的首屏组合 bundle URL 超过 Node 的请求头上限，服务回 431，界面报 "Failed to load plugins … bundle script … failed to load"。短 URL 的请求正常，curl 与外部浏览器不复现。排查壳窗口内的请求：`--remote-debugging-port=<端口>` 启动后走 CDP。
- **单实例**：`app.whenReady` 开头检查 `hasInstanceLock`，仅持锁进程启动 dsh。第二次启动经 `second-instance` 调用 `showMainWindow`。
- **隐藏到托盘只在 `BrowserWindow` 的 `close` 事件里 `preventDefault` + `hide()`**；`before-quit` 置 `quitting` 后放行。
  - 隐藏的窗口仍算存活窗口，`window-all-closed` 不触发；服务意外退出时先 `showMainWindow` 再弹对话框。
  - Windows / Linux 上隐藏窗口只能靠托盘找回（`hideToTrayEffective` 要求托盘开着），macOS 靠 Dock（`activate`）。
  - 托盘图标从 asar 内 `build/icon.png` 缩成 16/32 两档。
- **窗口 chrome 使用独立的 `data-desktop-platform` 视觉标记**：内核的 `data-platform` 会启用官方原生键盘桥，Web 壳不能设置。Windows 使用 `data-windows-titlebar`、`data-fullscreen`、`data-window-drag`、`data-shell-overlay` 与 `--dsw-*` 配色 token；macOS 标题栏独立预留 48px，frame 前三列依次为侧栏 / 主内容 / 右栏，不匹配编译类名。Windows 拖拽区使用 `env(titlebar-area-width)` 避开原生按钮；隐藏原生菜单栏但保留 Menu 及快捷键。共享 preload 只对受管窗口主 frame、精确本地文件或当前内核来源启用；`pluginApi` 仅在配置中心本地页暴露。
- **「运行任务时保持系统唤醒」的忙闲信号来自 `plugins/dsh-desktop-activity`**：轮询 `ctx.get('agents').list()`（`status === 'running'`、`inbox.nextTurn/nextStep` 非空）与 `ctx.get('jobs').list(agent)`（running / stopping），与上游 desktop-host 更新前排空任务的判据相同；`agent.status` 由 dsh-agent-loop 的 Agent 提供（0.1.5-rc.2 起）。壳侧 `powerSaveBlocker.start('prevent-app-suspension')` 只在选项开且忙时持有，服务退出即释放。
- **升级 Electron 前确认内置 Node 满足 dsh 的 engines**（当前 `^22.19 || >=24`）且命中上面的指纹表。`runtime.js` 的 `satisfiesNode` 在应用内内核升级前做同样检查，失败自动隔离回退（`.broken-` 目录后缀）。
- **应用内内核升级只允许同版本线**（`releaseLine`：去掉预发布标签的 major.minor.patch）。跨线版本通过新安装包分发；手动检查引导下载。
- **内核降级方向拒绝启动**：新内核把 `~/.dsh/.credentials.yaml` 的 version 迁移为数字，旧内核要求字符串。applyBootErrorFix 先把数字加引号（留 .bak），再失败则整体隔离（.broken-*）。该自愈只覆盖带此逻辑的版本。

### 预置插件

- **注册进内置 dsh 依赖只解决可解析，激活以 profile 清单为准**：必须出现在 `~/.dsh/profiles/web/package.json` 的 dependencies 与 `dsh.profile.bundles` 里。
  - `syncPresetPlugins` 每次启动声明式同步：profile 的预置部分刷成与运行时 preset-plugins.json 一致，版本也是声明的一部分，旧版本残留拷贝一并清退。
  - userData/managed-presets.json 只记录当前托管名单，不碰用户自装插件。
  - 预置在配置中心移除后下次启动恢复；退出预置用 minimal 版。不可解析的名字自动跳过。
  - 应用内升级的运行时同样带预置包并重新注册（installCoreRuntime）。
- **profile 自己 node_modules 里的残缺包会遮蔽闭包软链并阻断启动**。包是否完好分场景：作为加载器条目需要 JS 入口存在（pkgUsableAt）；作为 bundle/依赖只需清单与声明产物齐全（pkgIntactAt，元 bundle 包没有入口属正常）。入口按 `main`、再按 `exports["."]`（字符串或 default/import/require/node 条件）识别（pkgEntryOf）；只有 `exports` 的包同样算完好。syncPresetPlugins 每次启动对预置包做残缺清理。
- **加载器持久化的条目引用已消失的包会阻断启动**。healUnresolvableEntries 给解析不到的条目放一个无操作占位包（带 `.dsh-desktop-stub` 标记），真包可用时占位退位，真实重装直接覆盖。两处占位（主动扫描与 applyBootErrorFix）都不覆盖 pkgIntactAt 为真的包：占位包没有 `dsh.bundle.patch`，内核插件管理器会把它标成「没有声明组合包」。主动扫描不完备，反应式兜底 applyBootErrorFix：启动失败时按报错文本识别 Cannot find package / cannot resolve profile bundle，做占位/软链/撤 bundle 后重试（最多 6 次）。
- **配置文件损坏的自愈**：第三方写入器可能把块条目追加在 flow 空列表 `[]` 之后，dsh 报 "failed to parse overlay" 或 "must be a top-level YAML array"（空文件解析为 null 同样命中；主目录层 `~/.dsh/cordis.patch.yml` 也在检查范围）。先剔除孤立 `[]` 行保住用户条目（留 .bak），修不好再整文件隔离（.broken-*）。
- **互斥型插件族（皮肤）只能 carry 不能 seed**：全部播种会同时注入多套皮肤，且 insert id 与用户旧装条目冲突。seed 清单已不含的名字每次启动撤活。
- **duplicate loader entry id**：预置 bundle 的 insert id 与用户旧配置条目重复时撤我方 bundle 并写入 preset-exclusions.json，仅对当前应用版本生效，下一个版本自动重试。菜单「插件 → 重新同步预置插件…」清排除记录立即重试。
- **SSH 0.4.4 原生维护可重新连接的终端会话**：卸载视图走 detach，主动断开走 close；桌面构建直接分发原包。

### 依赖与锁

| 项目 | 约束 |
|---|---|
| staging | `npm ci --force` 从 `locks/<flavor>.package-lock.json` 安装；锁根依赖必须匹配插件清单 |
| 锁更新 | `update-locks.mjs` 更新内核与插件，重刷 resolved/integrity，补齐新依赖并报告形状漂移 |
| 平台依赖 | 保留 os / cpu / libc；仅经可选依赖可达的子树标记 optional |
| 版本解析 | 非 lockstep 包按引用方区间交集选版；冲突区间使用嵌套私有副本；剪枝不沿可选 peer 扩展 |
| 可选 peer | 不递归安装；已存在的同名包仍参与区间校验与锁文件修正 |
| better-locale | 由 full 清单的 carry 组显式钉版 |
| pnpm | 固定 11 线，入口允许 cjs/mjs；始终从 `bundledDshDir()/tools` 读取 |
| pnpm 参数 | shim 与 installCoreRuntime 均在子命令前传 `--config.minimum-release-age=0`、`--config.auto-install-peers=false` |
| 构建审批 | allowBuilds 由用户在命令行处理，配置中心不自动放行 |
| Python MCP | toolkit 配置中心管理；desktop 不下载或捆绑 uv/uvx，不生成其启动器 |
| 旧 uv 迁移 | 仅清理应用 bin 中带旧缓存变量与 tools/uv 路径的生成文件；保留自定义启动器与缓存，afterPack 过滤旧 staging 载荷 |

锁更新使用项目 semver 开发依赖和系统临时目录，支持 Windows / macOS / Linux。注册表请求包含超时、重试与进度输出。锁闭包包含自动安装的 peer，禁止使用 `--legacy-peer-deps`。

内核的 `@deepseek-ai/dsh-http-proxy` 在启动时读取标准代理环境变量，Node fetch 经壳转发器出站，回环地址直连。

### Windows

- Windows EXE 的 `requestedExecutionLevel` 固定为 `requireAdministrator`，由 electron-builder 写入清单；系统 UAC 处理提权。macOS 配置独立。

#### 子进程

| 项目 | 约束 |
|---|---|
| 环境变量 | PATH 与代理变量按大小写不敏感查找和修改；`npm_config_proxy` 显式覆盖用户 npmrc |
| 控制台窗口 | 用户打开终端时使用 UTF-8 `.cmd` 与 `shell.openPath`；首行后执行 `chcp 65001` |
| shim | 经 `--require` 与 NODE_OPTIONS 预载；child_process 六个入口默认隐藏窗口，exec/execFile 重建 promisify.custom；ConPTY 不受影响 |
| 预加载传播 | 以 process.execPath 和 argv 数组启动的子进程附加 `--require <shim>`；argv 以 `--` 开头时除外 |
| 隐形控制台 | 服务设置 `DSHDESKTOP_CONSOLE_HOST=1`，通过 CREATE_NO_WINDOW 的 cmd 与 AttachConsole 建立宿主控制台；已有真实终端时保留原控制台 |
| 控制台继承 | 附着后子进程继承控制台；CLI 场景保持 windowsHide 默认；`DSHDESKTOP_INHERIT_CONSOLE=0` 关闭继承策略 |
| 控制变量 | 使用 `DSHDESKTOP_*` 前缀；内核会清除子进程的 `DSH_*` 变量 |
| 诊断 | `userData/console-debug.log` 记录附着路径与 GetLastError：6 为目标无控制台，5 为本进程已有控制台 |

koffi 从活动 dsh 运行时闭包解析。受限令牌下的沙箱进程共享宿主控制台。

#### 运行时裁剪

| 文件 | 处理 |
|---|---|
| sourcemap、.pdb、*.d.ts | 删除 |
| 第三方包 README / CHANGELOG | 删除；保留 @deepseek-ai 与插件包 README |
| 第三方包顶层 test / docs / examples / .github | 删除，仅限 package.json 同级 |
| 其他 Markdown、嵌套同名目录 | 保留，包含 SKILL.md 等运行时资源 |

裁剪后验证 GUI 流程、全部 `@deepseek-ai/*` 入口加载与相对 import 完整性。安装载荷使用 7z。

#### 安装器

| 阶段 | 契约 |
|---|---|
| 关闭进程 | 非更新路径命中进程时确认一次；按已知名称与限定路径清理进程树，有限次数后进入提取 |
| 旧卸载器 | 用户开始安装后预运行；失败时清理旧注册项与载荷 |
| 解压 | 替换 `extractUsing7za` 宏；Nsis7z 输出目录使用 `\\?\` 扩展路径 |
| 复制 | Robocopy `/E`；返回码 0–7 成功，8 及以上或启动失败进入重试 / 取消 |
| 文件保留 | 保留目标目录额外文件，禁止 `/MIR` |
| 静默失败 | 返回非零退出码 |
| 日志 | `%TEMP%\dsh-install-copy.log`；存活进程诊断写入桌面 `dsh-install-debug.txt` |
| 明细 | customShowDetails 启用 SetDetailsPrint both 与 InstFiles 列表（1016）；customDetail 按 $LANGUAGE 输出中文或英文 |
| 钩子 | customCheckAppRunning：解压前；customFiles_x64：复制后；customInstall：安装完成 |

FIND_PROCESS 仅用于运行确认，不作为安装退出条件。真实文件占用由提取与复制阶段的重试处理。Windows 验证须包含超过 260 字符的实际安装路径。

### 其他

- **electron-builder 的 extraResources 默认排除 node_modules**，运行时必须走 afterPack 钩子复制。
- **本仓库不能放进 pnpm workspace**（如上游 fork 的子目录）：electron-builder 向上探测 workspace 根并错误改用 pnpm 收集依赖。须拷到仓库外构建。
- **CLI 启动器 dsh / pnpm / node 三件套缺一不可**（pnpm 生命周期脚本裸调 `node`），外加给 stdio MCP 用的 npx。
- **技能管理**：toolkit 配置中心插件负责安装、启停、删除和预览；主进程通过 `DSHDESKTOP_DISABLED_SKILLS` 传入 `userData/disabled-skills/`，供插件兼容读取旧停用技能。

## 文档维护

文档随代码同一次提交更新。

- README 记录安装、使用、构建与发版；AGENTS.md 记录架构、验证与维护约束。同一事实保留一个来源。
- CLAUDE.md 只有一行 `@AGENTS.md`，内容改 AGENTS.md。
- 文件职责变化更新文件地图；构建与测试变化更新验证入口；用户行为变化更新 README。
- 约束清单保留当前有效的契约与触发条件，删除历史排错过程及失效条目。
- 文档改完自检：README 的命令逐条可执行；AGENTS.md 验证一节的命令在干净 checkout 上能跑通。

## 风格约束

文档、代码注释与 UI 文案遵循以下规范：

1. **声明式**：直接陈述职责、契约、状态和行为。
2. **仅呈现设计结果**：描述当前有效的设计；省略作者动机、推导过程、方案比较和自我解释。
3. **结构清晰**：用标题划分主题，用列表呈现并列项，用表格表达对应关系；一项一个结论。

| 载体 | 内容 |
|---|---|
| 文档 | 功能、用法、配置、边界与约束；同一事实保留一个来源 |
| 代码注释 | 职责、输入输出、契约与非显然的边界；函数级用 JSDoc，不复述代码 |
| UI 文案 | 字段名称、状态、动作与必要提示；详细说明放帮助或文档，诊断细节按需展开 |

用户可见文案陈述结果，不解释动机；简短、具体，术语一致。涉及数据采集、权限或不可逆操作的必要信息在操作处呈现。

- 主进程是无构建步骤的 CJS，构建依赖为 electron、electron-builder 与 semver（devDependencies），不引入打包器、框架或运行时依赖。能写成纯函数的逻辑放 `runtime.js` 这类无 Electron 依赖的模块。
- 用户界面文案提供中文与英文，跟随内核页面语言。
- 发版：推 `v*` 标签；锁定内核版本用 stage 步骤的 `DSH_VERSION` 环境变量。
