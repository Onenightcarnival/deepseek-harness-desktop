# AGENTS.md

本仓库是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）的非官方桌面打包：Electron 壳 + npm 发布版 `@deepseek-ai/dsh`，产出 Windows exe 与 macOS dmg。仓库不含上游源码，`stage-dsh.mjs` 在构建期从 npm 拉取运行时。上游行为在上游仓库改，这里只改壳、打包与分发。

## 架构

- 主进程用 Electron 内置 Node（`ELECTRON_RUN_AS_NODE=1`）spawn `dsh web --patch <覆盖层> --port 0`，从 stdout 解析就绪行 `dsh web: http://127.0.0.1:<port>/?token=…`，在 BrowserWindow 里加载该 URL。
- 关窗即杀服务进程。开启「关闭时最小化到托盘」后关窗只隐藏窗口，服务继续，退出走托盘或应用菜单。
- 全部 dsh 数据在 `~/.dsh`，与命令行版共享。

## 文件地图

```
main.js             主进程：服务拉起/守护、菜单、更新检查（应用 = GitHub Release，
                    内核 = npm registry + 应用内升级到 userData/runtimes/）、CLI 启动器
                    （dsh/pnpm/node/npx/uvx/uv 六个 shim）、配置中心 IPC（MCP/技能/内置插件/
                    通用/代理）、通用配置的执行（托盘、隐藏到托盘、登录项、powerSaveBlocker）、
                    启动失败自愈（applyBootErrorFix）与旧版预置插件的一次性退场（retireManagedPresets）
runtime.js          纯 CJS、无 Electron 依赖：版本比较、运行时目录选择（升级版优先 + 损坏回退）、
                    engines 校验、cordis patch 托管区块编辑（upsertManagedBlock/buildMcpBlock）、
                    常用设置注册表（COMMON_SETTINGS/SETTING_GROUPS）、通用配置归一化
                    （normalizeGeneralSettings/hideToTrayEffective）、zip 技能包识别（collectSkills）、
                    SKILL.md frontmatter 解析（parseSkillFrontmatter）、技能详情与围栏读取
                    （skillDetail/readSkillFile）、技能启用/关闭（listSkillStore/setSkillEnabled）、
                    代理环境变量清场与注入（scrubProxyEnv/applyProxyEnv）、例外列表匹配（isBypassed）
win-spawn-shim.js   经 --require 与 NODE_OPTIONS 预载进整棵 Node 子进程树。win32 上给
                    child_process 六个入口默认补 windowsHide:true（含重建 promisify.custom）；
                    DSHDESKTOP_CONSOLE_HOST=1 时配隐形宿主控制台（setupHiddenConsole），附着后
                    子进程改为继承该控制台。非 Windows 空操作。asar 内文件普通 Node 读不到，
                    启动时拷到 userData 再注入
plugins/            壳自带的 dsh 插件包：dsh-desktop-directory-picker（工作区目录选择走壳的
                    系统对话框）；dsh-desktop-activity（每 2 s 读 agents/jobs 服务，忙闲变化时
                    经 IPC 发 `dsh-desktop:activity`，供「运行任务时保持系统唤醒」）
proxy-forward.js    进程内转发代理（无 Electron 依赖，resolveSystem 由 main.js 注入）：
                    createForwarder 起 127.0.0.1 随机端口，处理 CONNECT 隧道与明文 HTTP，
                    每条连接经 routeFor 决定直连或上游代理
plugins.html        配置中心窗口：MCP 服务器 / 技能 / 内置插件 / 通用 / 代理五页。
                    MCP 为主从布局，streamable-http（地址/请求头）或 stdio（命令/参数/环境变量/
                    工作目录），stdio 的「测试」在 main.js testMcpServer 里做 initialize + tools/list
                    握手。技能页：frontmatter 卡片列表 + 详情（字段表、文件树、只读预览）。
                    内置插件页按 SETTING_GROUPS 分卡片渲染 COMMON_SETTINGS，值存
                    userData/common-settings.json，经 buildSettingsBlock 写进用户 patch 层的
                    'settings' 托管区块。加一个配置项 = 注册表加一行；新插件的第一项再加一行分组。
                    通用页五个开关（G_ITEMS），值存 userData/general.json，切换即保存并由主进程
                    applyGeneralSettings 立即应用
preload-plugins.js  配置中心的 contextBridge
splash.html         启动页
stage-dsh.mjs       构建期：npm ci 从 locks/package-lock.json 安装 dsh 到 staging/<platform>-<arch>/dsh，
                    拷入 plugins/ 并登记进 dsh 应用依赖清单，裁剪运行时不读的文件，安装 pnpm
                    （11 线）到 dsh/tools/，从 GitHub 拉钉版 uv（sha256 校验）到 dsh/tools/uv/
afterPack.js        electron-builder 钩子：把 staging 运行时拷进应用 resources/dsh
desktop-patch.yml   随包分发的插件组合覆盖层（默认空）
locks/package-lock.json  内置 dsh 的锁；只含 @deepseek-ai/dsh 一个根依赖
build/              图标 + installer.nsh（NSIS customCheckAppRunning 覆盖）
.github/workflows/release.yml  CI 构建与发版
```

## 代理链路

决策点只有一个：`proxy-forward.js` 的进程内转发代理。

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

无头 Linux 能验证绝大部分改动。做不到的两样：真实 win/mac 安装包（`release.yml`：workflow_dispatch 只出产物，推 `v*` 标签才发 Release）与肉眼看 GUI。

按成本从低到高：

```sh
node --check main.js runtime.js preload-plugins.js   # 语法
node -e "require('./runtime.js')"                     # runtime.js 独立可加载，纯函数直接单测
node stage-dsh.mjs                                    # linux 实跑 staging（node-pty 无 linux 预编译，脚本按平台跳过该断言）
DSH_VERSION=<版本> node stage-dsh.mjs --update-locks  # 升级 dsh：实时解析后写回 locks/package-lock.json（只有 dsh 一个根依赖，分钟级）
node staging/linux-x64/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js \
  web --patch desktop-patch.yml --dump-config         # patch 覆盖层并入组合树
```

**代理链路**：`runtime.js` 的纯函数直接断言；`proxy-forward.js` 注入假 `resolveSystem` 端到端测：起一个 origin server、一个记录请求的上游代理桩、一个 TLS origin，断言外网目标进桩、loopback 与内网名字不进桩、CONNECT 隧道能跑 TLS、上游不可达时回 502。

**无头启动 dsh 服务**（`curl <ready-url>` 返回 303/200）：

- linux 先补 node-pty：`npm pack node-pty@<版本>` 解包后 `npx node-gyp rebuild --nodedir=<本地 node 目录>`，把 `pty.node` 放进 staging 的 `node-pty/prebuilds/linux-x64/`。
- 就绪行带一次性 token：先请求 token URL 换 cookie（303），再用 cookie 取首页。同一 token 只能换一次 cookie，换浏览器需重启服务。
- 插件挂载探针：客户端 bundle 只经组合路由下发。取首页 HTML 里 `href="/plugins/??…&rev=<hash>"` 的精确 URL 拉 bundle，断言其中含 `id: "<包名>"`。单包 `/plugins/<包名>/client.js` 与自拼组合均 404。

**Electron 部分**：

- 冒烟：`xvfb-run electron <仓库目录> --no-sandbox`，看 dsh 子进程起来、就绪端口可 curl、日志无 Uncaught。
- 配置中心页面：Playwright `addInitScript` 注入假 `window.pluginApi` 后打开 `plugins.html` 截图；或 `--remote-debugging-port` 启动后 `connectOverCDP` 操作真实页面（不要 `browser.close()`，会关掉 Electron）。
- 窗口关闭行为：用 python-xlib 给窗口发 `WM_DELETE_WINDOW` ClientMessage。`xdotool windowclose` 是 XDestroyWindow，渲染进程的 `window.close()` 不经过 BrowserWindow 的 close 事件，两者都测不到 preventDefault 路径。
- 托盘图标在 Xvfb 里看不到，只能验证代码路径不抛错。

**NSIS 安装器**（Linux 全流程）：

- 环境：`dpkg --add-architecture i386 && apt install wine64 wine32:i386`（安装器是 32 位 exe），`WINEARCH=win64 WINEPREFIX=<新目录> wineboot -i`，Xvfb 当显示，`xdotool key Return` 翻页，`import -window root` 截图。
- 无 wine 打包：electron-builder 用 wine 跑一次安装器生成卸载器；把 NsisTarget.js 里 `wineVm.exec` 临时换成写空文件，两遍 makensis 照常编译。脚本是 `-WX`，警告即错误。
- win32-x64 的 staging 只需一个占位 package.json 即可过 afterPack。
- FIND_PROCESS 误报复现：wine 的 powershell 桩对一切命令返回 0；移走 prefix 里的 powershell.exe 切到 tasklist 分支。

## 约束与已知行为

改动前通读。每条一个结论，后接触发条件。

### 启动与运行时

- **Electron-as-node 跑 dsh 必须加 `--expose-internals`**。cordis 加载器依赖 Node internals 做模块解析，缺失时 HMR 相关加载随机失败。
- **Electron 版本钉在内核 `node-addon-require-builtin` 的指纹表上**（0.1.7 线：43.0.0 / 44.0.0 / 45.0.0-alpha.6，按 Electron 内置 V8 的精确版本放行；devDependencies 用精确版本 `44.0.0`）。补丁版本（43.4.0，V8 15.0.245.28）启动即 `unsupported Electron runtime fingerprint`，dsh 服务起不来。升级内核线时先查新内核该包的指纹表（`strings prebuilt/*.node | grep electron`）再选 Electron。
- **应用内更新（Windows）走 electron-updater 的 GitHub provider**，对着 `updateRepo` 的 Release。
  - `build.publish` 配成 github 后，`--publish never` 也会在 dist 写更新信息文件；发布流程把 `*.yml`（排除 builder-debug.yml）一并上传。
  - `nsis.differentialPackage: false`：不产出 `.exe.blockmap`，更新整包下载。差分靠对 GitHub 的 Range 请求，经镜像不稳定。
  - 安装包未签名：electron-updater 未配 `publisherName` 时跳过签名校验。
  - `quitAndInstall(true, true)` 以 `/S --updated --force-run` 运行新安装包，走 installer.nsh 的 isUpdated 路径（不弹「正在运行」确认）。
  - macOS 未签名，Squirrel.Mac 拒绝，保持下载页流程。
- **工作区目录选择器走壳的系统对话框**（全平台）。`pickerPatchArgs` 停用 directory-picker-auto，挂 `plugins/dsh-desktop-directory-picker`（host，`native` 能力）+ dsh 自带的 `@deepseek-ai/dsh-client-ui-directory-picker-native`（client-ui）。dsh 服务以 `stdio[3]='ipc'` 启动，插件把 pick 请求经 `process.send` 发给壳，壳用 `dialog.showOpenDialog` 在主窗口上开对话框后回传路径；取消回 null；调用方 abort 时插件发 cancel，壳丢弃结果。
  - dsh 自带的 native 后端不用：Windows 上它用 koffi 子进程重新 spawn `process.execPath` 开 Win32 对话框，打包后的 Electron 环境起不来；Linux 依赖 zenity/kdialog。
  - dsh 的交互插件是 host + client-ui 成对的，patch 只挂一半时界面不出现。
- **`plugins/<name>` 是壳自带的 dsh 插件包**（纯 JS，不打包）。stage 把它们拷进运行时 node_modules 并登记进 dsh 应用清单；打包后放 extraResources 的 `plugins/`，`ensureDesktopPlugins` 在每次启动前和内核升级后把当前拷贝写进活动运行时。不进 profile。
- **`--patch` 层在用户 profile 配置层之后应用**，desktop-patch.yml 里的条目用户无法覆盖。
- **dsh launcher 只解析 argv 开头属于自己的旗标**（`--profile`/`--patch`），遇到第一个陌生 token 就把剩余交给应用层。`--no-open`/`--port` 等应用旗标必须放在全部 patch 参数之后。
- **壳必须传 `--no-open`**：rc8 起 `dsh web` 默认打开系统浏览器。
- **就绪行带一次性 token**（0.1.2-rc.1 起）：裸 origin 回 401，`/api` 受浏览器信任围栏保护。READY_RE 捕获整条 URL（含 query）并原样 loadURL；每次启动 token 不同。CLI 形态为 `dsh --profile web`，子命令形态 `dsh web` 仍接受。
- **每次 loadURL 前清掉 `127.0.0.1` 下全部 `dsh-auth-*` cookie**（`loadWebUi`）。dsh 每个服务实例下发一个名字随机的 `dsh-auth-<随机>` cookie（30 天过期），cookie 按 host 不按端口隔离，每次启动多留一个且全部随请求发出；约 65 个时 Cookie 头近 16 KB，加上 2.8 KB 的首屏组合 bundle URL 超过 Node 的请求头上限，服务回 431，界面报 "Failed to load plugins … bundle script … failed to load"。短 URL 的请求正常，curl 与外部浏览器不复现。排查壳窗口内的请求：`--remote-debugging-port=<端口>` 启动后走 CDP。
- **`app.whenReady` 处理函数开头按 `hasInstanceLock` 返回**。单实例锁失败后 `app.quit()` 是异步的，`ready` 仍在落败进程里触发，不检查锁会 spawn 一个随即失去父进程的 dsh 服务（孤儿占端口、占内存）。第二次启动在获胜进程里触发 `second-instance` → `showMainWindow`，即托盘模式下双击图标找回窗口的路径。
- **隐藏到托盘只在 `BrowserWindow` 的 `close` 事件里 `preventDefault` + `hide()`**；`before-quit` 置 `quitting` 后放行。
  - 隐藏的窗口仍算存活窗口，`window-all-closed` 不触发；服务意外退出时先 `showMainWindow` 再弹对话框。
  - Windows / Linux 上隐藏窗口只能靠托盘找回（`hideToTrayEffective` 要求托盘开着），macOS 靠 Dock（`activate`）。
  - 托盘图标从 asar 内 `build/icon.png` 缩成 16/32 两档。
- **「运行任务时保持系统唤醒」的忙闲信号来自 `plugins/dsh-desktop-activity`**：轮询 `ctx.get('agents').list()`（`status === 'running'`、`inbox.nextTurn/nextStep` 非空）与 `ctx.get('jobs').list(agent)`（running / stopping），与上游 desktop-host 更新前排空任务的判据相同；`agent.status` 由 dsh-agent-loop 的 Agent 提供（0.1.5-rc.2 起）。壳侧 `powerSaveBlocker.start('prevent-app-suspension')` 只在选项开且忙时持有，服务退出即释放。
- **升级 Electron 前确认内置 Node 满足 dsh 的 engines**（当前 `^22.19 || >=24`）且命中上面的指纹表。`runtime.js` 的 `satisfiesNode` 在应用内内核升级前做同样检查，失败自动隔离回退（`.broken-` 目录后缀）。
- **应用内内核升级只允许同版本线**（`releaseLine`：去掉预发布标签的 major.minor.patch）。第三方插件按线适配，跨线组合无法启动；Electron 指纹表也按线变化。跨线时静默检查不打扰，手动检查引导下载新安装包。
- **内核降级方向拒绝启动**：新内核把 `~/.dsh/.credentials.yaml` 的 version 迁移为数字，旧内核要求字符串。applyBootErrorFix 先把数字加引号（留 .bak），再失败则整体隔离（.broken-*）。该自愈只覆盖带此逻辑的版本。

### 插件与 profile

- **壳不预置任何第三方插件**；安装、移除、启停走 dsh 0.1.7 自带的插件页（`ui-plugin-manager`，底层是 profile 里的 pnpm）。推荐清单只写在 README。
- **0.1.7 起 profile 不再持有 dsh 自身的拷贝**：`~/.dsh/profiles/web/package.json` 只列用户装的插件与 bundles，dsh 包一律从运行时闭包解析。壳对 profile 的写入只剩托管区块（MCP / settings）与一次性退场。
- **旧 full 版的预置在首次启动时退场**（`retireManagedPresets`）：按 userData/managed-presets.json 的名单从 profile 的 dependencies 与 bundles 删除，再删记录文件（managed-presets / preset-exclusions / seeded-presets）。没有记录文件即不动 profile。
- **加载器条目引用已消失的包会阻断启动**，反应式兜底 applyBootErrorFix：启动失败时按报错文本识别 Cannot find package / cannot resolve profile bundle，链接运行时拷贝、放无操作占位包（带 `.dsh-desktop-stub` 标记）或撤 bundle 后重试（最多 6 次）。
- **配置文件损坏的自愈**：第三方写入器可能把块条目追加在 flow 空列表 `[]` 之后，dsh 报 "failed to parse overlay" 或 "must be a top-level YAML array"（空文件解析为 null 同样命中；主目录层 `~/.dsh/cordis.patch.yml` 也在检查范围）。先剔除孤立 `[]` 行保住用户条目（留 .bak），修不好再整文件隔离（.broken-*）；隔离的是 MCP 托管区块所在文件时，从 userData 的 mcp-servers.json 重建。

### 依赖与锁

- **staging 用 `npm ci --force` 从 `locks/package-lock.json` 安装，不做实时 npm 解析**。`--force` 跳过 npm ci 的 peer 复验；锁是决策记录，兼容性由 staging 冒烟验证。锁只有 `@deepseek-ai/dsh` 一个根依赖，实时解析（`--update-locks`）分钟级完成；带第三方插件一起解析会让 arborist 的 peer 回溯指数爆炸，这也是壳不预置插件的工程理由之一。
- **内核自带 `@deepseek-ai/dsh-http-proxy`**（0.1.5-rc.2 起）：启动时读一次标准代理环境变量并作用于 Node fetch，loopback 目标直连。壳注入的 `HTTP(S)_PROXY=http://127.0.0.1:<转发器端口>` 由它直接消费，行为与 `NODE_USE_ENV_PROXY=1` 一致。
- **pnpm 钉在 11 线**：pnpm 12 起 npm 包是占位脚本，postinstall 才下载原生二进制，`--ignore-scripts` 安装后没有可执行文件。main.js 的 pnpmEntry() 接受 cjs/mjs 任一入口，stage 装完断言入口存在。pnpm 只随内置运行时分发（`dsh/tools/`），升级版运行时没有 tools 目录，取 pnpm 路径锚定 `bundledDshDir()`。
- **pnpm 子命令前带 `--config.minimum-release-age=0`**（注入点：userData/bin 的 pnpm shim 与 installCoreRuntime 的直接 spawn）。pnpm 11.22 起 `minimum-release-age` 默认 1440 分钟：add 路径自动写 minimumReleaseAgeExclude，remove 路径直接失败（ERR_PNPM_RESOLUTION_POLICY_VIOLATIONS_UNHANDLED），内核升级同样受影响。env 与内置 pnpmrc 对该键不生效。严格模式复现：`--config.minimum-release-age-strict=true` 装一个 24h 内发布的包。
- **pnpm 子命令前带 `--config.auto-install-peers=false`**（同两个注入点；peer 由应用闭包在运行期提供）。peer 自动安装对同名 peer 做区间交集时丢掉预发布限定（`^0.1.0-rc.8 ∩ *` → `>=0.1.0 <0.2.0`），dsh 核心只发预发布版，装过 better-sidebar 之类带 dsh peer 的插件后再装任何新插件都报 ERR_PNPM_NO_MATCHING_VERSION。容器复现需把 profile workspace yaml 的 `autoInstallPeers` 改为 true。
- **pnpm 两道门禁**：allowBuilds（构建脚本审批，配置中心不代为放行，提示走命令行）；minimumReleaseAge（裸装包名可能静默降级到旧版本，显式带版本号可豁免）。
- **启动器默认 `UV_NATIVE_TLS=1`** 走系统证书库。uv 自带根证书在 TLS 拦截型代理后表现为"解码响应体超时"。Python 解释器首次运行从 GitHub 下载到 userData/uv/python，国内用户设 `UV_PYTHON_INSTALL_MIRROR`（启动器 `if not defined` 语义，用户值优先）。

### Windows

- **给子进程改 PATH 必须大小写不敏感找键**（`prependEnvPath`）：`{...process.env}` 展开出的真实键通常是 `Path`，再赋值 `PATH` 造出重复键，子进程实际生效的 PATH 可能只剩新加目录。
- **代理变量清场同样大小写不敏感**：展开出的真实键常是 `Http_Proxy`。`~/.npmrc` 的 `proxy=` 只能靠显式 `npm_config_proxy` 压过。
- **系统代理是按 URL 逐次求值的函数**：把某一个地址的 `resolveProxy` 结果当全局 `HTTP_PROXY` 会丢掉 PAC 与例外列表，内网不通。
- **例外匹配收在 `isBypassed` 一处，`NO_PROXY` 只留 loopback**：`NO_PROXY` 通配符语义各家不同（undici / npm / git / Python 对 `*.corp.com`、`10.*`、CIDR 解释不同）。
- **开新控制台窗口：写 `.cmd` 批处理再 `shell.openPath`**。`spawn('cmd.exe', …, { detached: true })` 不行：libuv 把 detached 映射为 `DETACHED_PROCESS`，cmd 不分配控制台。批处理存 UTF-8 且首行后紧跟 `chcp 65001`。
- **`win-spawn-shim.js` 经 `--require` 与 NODE_OPTIONS 预载，给 child_process 全家默认补 windowsHide**。GUI 进程树里不带 `windowsHide:true` 的控制台子进程（pwsh/cmd/git）会闪窗。exec/execFile 的 `promisify.custom` 必须在包装函数上重建。node-pty（ConPTY）不走 child_process，不受影响。
- **dsh 服务进程配隐形宿主控制台**（setupHiddenConsole，`DSHDESKTOP_CONSOLE_HOST=1`）：spawn 一个 CREATE_NO_WINDOW 的 cmd，AttachConsole 后杀掉它（控制台在还有进程附着时存活）。已附着真实终端时不介入。koffi 从 dsh 运行时闭包解析。
  - 触发：dsh-sandbox-windows-acl 用 koffi 直接调 CreateProcessAsUserW 起 pwsh，windowsHide 治不了；受限令牌下 CREATE_NO_WINDOW 的子进程以 STATUS_DLL_INIT_FAILED (0xC0000142) 退出，语义是共享宿主控制台。
  - AllocConsole 闪窗，Win11 可能开 Windows Terminal 标签，不用。
- **shim 对以本进程 `process.execPath` 启动且带 argv 数组的子进程在 argv 前插入 `--require <shim>`**（withPreload，覆盖 spawn / spawnSync / execFile / execFileSync）。dsh 的 subprocess 服务（Glob / Grep 起 ripgrep，`dsh-subprocess-local` 的 Win32 Job runner）给 runner 自己的环境删掉一切 `NODE_*` 变量，NODE_OPTIONS 到不了 runner；runner 是 GUI 子系统的 Electron 进程，不继承控制台，它经 CreateProcessW 起的 rg 会开一个可见窗口。argv 首项为 `--` 的单文件运行时不插。`--require` 是 Node 选项，不改变子进程的 process.argv。
- **有隐形宿主控制台时，子进程改为继承控制台而非 CREATE_NO_WINDOW**（shim 的 hostConsole 策略）：`windowsHide:true` 的子进程没有控制台，它再起的控制台程序会得到新的可见窗口（`uvx` MCP 服务器为 uv → python 两级，MCP SDK 硬编码 windowsHide:true）。无隐形控制台（CLI 场景）时维持 windowsHide 默认。逃生口 `DSHDESKTOP_INHERIT_CONSOLE=0`。
- **控制变量用 `DSHDESKTOP_*` 前缀，不能用 `DSH_`**：dsh 的 subprocess 服务给每个子进程做环境清洗，除敏感名（KEY/PASSWORD/SECRET/TOKEN）外删除一切 `DSH_` 开头的变量；`NODE_OPTIONS` 不在清洗名单。诊断日志 userData/console-debug.log 记录每个进程的附着路径与 GetLastError（6 = 目标进程无控制台，5 = 自己已有控制台）。
- **安装耗时由文件数决定**：NSIS 模板把 7z 解到临时目录再 CopyFiles 进 $INSTDIR，每个文件落盘两次并各被 Defender 扫一次。stage 的裁剪把运行时从约 2.1 万个文件减到约 1.1 万（307 MB → 190 MB）。
  - 裁掉：sourcemap / .pdb；全部 `*.d.ts`（dsh 的服务/类型查询走 typert 运行时反射，不读声明文件）；第三方包的 README / CHANGELOG 类 prose；第三方包**顶层**的 test / docs / examples / .github 目录（只在 package.json 同级，嵌套同名目录可能是运行时模块：yaml 的 dist/doc/）。
  - 保留：@deepseek-ai 与插件包的 README；其他一切 .md（agent-preset 的 SKILL.md、skill-badge 资源是运行时读的）。
  - 验证：`node stage-dsh.mjs` 后起服务走 GUI 流程，再用脚本 import 全部 `@deepseek-ai/*` 入口查 Cannot find module，并扫描所有 js 的相对 import 是否指向已删文件。
  - `nsis.useZip` 省掉 CopyFiles 那一遍，同一运行时的安装包从 106 MB 涨到 177 MB，不用。
- **安装进度明细由 `build/installer.nsh` 的 customShowDetails 打开**：stock 模板 `ShowInstDetails nevershow` + `SetDetailsPrint none`，InstFiles 页只剩进度条。安装 / 卸载段开头 `SetDetailsPrint both` 并 `ShowWindow` 明细列表（MUI InstFiles 页控件 id：1016 列表、1027 "显示细节"按钮），之后 DetailPrint 同时写状态行与列表；各阶段用 customDetail 宏按 `$LANGUAGE`（2052 中文，其余英文）打一行。
  - 不用 LangString：任一内置语言缺定义即警告，`-WX` 下编译失败。
  - 可挂钩的位置：customCheckAppRunning（解压前）、customFiles_x64（拷贝进 $INSTDIR 之后、保存安装包副本 / 写卸载器 / 注册表 / 快捷方式之前）、customInstall（全部完成后）。
- **electron-builder 的 FIND_PROCESS 会误报，不作为拦截安装的门条件**：PowerShell 可用时它把任何路径在 $INSTDIR 下的进程都算命中（wine 的 powershell 桩对一切命令返回 0；用户装到宽泛目录时无关进程同样命中）。误报后弹 "app cannot be closed" 并退出非零，覆盖安装死在旧卸载器重试上。
  - 现行设计（build/installer.nsh customCheckAppRunning）：命中且非更新路径时只弹一次「正在运行」确认；清扫无条件执行、按已知进程名收窄（taskkill 树杀 + 按名杀 + 限定 OpenConsole/winpty-agent/应用 exe 的路径扫），几轮后直接放行（真锁文件由解包阶段自带重试兜底），放行前把安装目录下存活进程落盘到桌面 dsh-install-debug.txt。
  - 同一宏尾部预跑旧版卸载器（用户点了安装之后，不在 onInit），非零退出时删注册表键 + 清旧载荷绕过。

### 其他

- **electron-builder 的 extraResources 默认排除 node_modules**，运行时必须走 afterPack 钩子复制。
- **本仓库不能放进 pnpm workspace**（如上游 fork 的子目录）：electron-builder 向上探测 workspace 根并错误改用 pnpm 收集依赖。须拷到仓库外构建。
- **CLI 启动器 dsh / pnpm / node 三件套缺一不可**（pnpm 生命周期脚本裸调 `node`），外加给 stdio MCP 用的 npx / uvx / uv。
- **常用设置只能覆盖 web 组合树里的条目**；agent 预设（config/agent-presets/*.yml）不经过 cordis.patch.yml。compaction-basic 在 web 组合里默认 `disabled: true`，「上下文自动压缩」项走注册表的 `kind: 'enable'`，与同条目的 config 键合并成一个覆盖条目。
- **MCP 的 GUI 配置写入 `~/.dsh/profiles/web/cordis.patch.yml` 的标记托管区块**（`# >>> dsh-desktop mcp >>>`），dsh 热加载、dsh-mcp-client 支持配置热替换，保存即生效。只改标记区块，保留用户手写条目；文件默认内容是 flow 空列表 `[]`，与块列表不能共存，upsertManagedBlock 已处理。移除条目时经 `pnpm dlx` 启动的旧 MCP 进程可能残留到应用退出。
- **技能启用/关闭是目录搬移**：dsh 的文件系统 provider 只扫根目录顶层，没有按名禁用的配置。关闭 = 移到 `userData/disabled-skills/`（不在 `~/.dsh` 与任何扫描根之内），目录监视 2 秒内生效。同名在两边同时存在时拒绝搬移。旧位置 `~/.dsh/skills/.disabled/` 与 `~/.dsh/disabled_skills/` 在首次列表时自动迁移。有 shell 的 agent 仍可全盘搜索到任何目录；该位置只保证不进入 dsh 的目录树。

## 文档维护

文档随代码同一次提交更新。

- 一个事实只放一处。README 面向用户与发版者：装什么、怎么用、怎么发版。AGENTS.md 面向下一个 agent 或贡献者：架构、验证手段、约束。两边不互相复述。
- CLAUDE.md 只有一行 `@AGENTS.md`，内容改 AGENTS.md。
- 加/删/改源文件或其职责 → 文件地图；新的构建/验证方式 → 验证手段（附可直接执行的命令）；解决了非显然的问题 → 约束清单加一条（一句话结论 + 触发条件；上游修复或依赖升级后失效的条目删除）；用户可见行为变化 → README 对应小节。
- 约束清单只收会再次遇到的：一次性环境故障、已被代码防御且有注释的不收。
- 文档改完自检：README 的命令逐条可执行；AGENTS.md 验证一节的命令在干净 checkout 上能跑通。

## 风格约束

- 文档与注释只写设计结果：是什么、契约是什么、哪条事实约束了它。不写推导过程、被否决的方案、版本演进、「因为…所以…」。触发条件与踩坑记录归约束清单，不重复进代码注释。
- 结构一眼可读：约束条目以加粗结论开头，细节用子项；README 每个功能一条；代码里函数级用 JSDoc 写契约，行内注释只标非显然的事实。
- 主进程是无构建步骤的 CJS，唯二依赖 electron 与 electron-builder（devDependencies），不引入打包器、框架或运行时依赖。能写成纯函数的逻辑放 `runtime.js` 这类无 Electron 依赖的模块。
- 用户可见文案用中文，陈述结果，不解释动机。
- 发版：推 `v*` 标签；锁定内核版本用 stage 步骤的 `DSH_VERSION` 环境变量。
