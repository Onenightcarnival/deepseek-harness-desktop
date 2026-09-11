# AGENTS.md

本仓库是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）的非官方桌面打包：一个 Electron 壳，把 npm 发布版 `@deepseek-ai/dsh` 打成 Windows exe 与 macOS dmg。仓库不含上游源码，运行时由 `stage-dsh.mjs` 在构建期从 npm 拉取。上游行为在上游仓库改；这里只改壳、打包与分发。

## 架构

主进程用 Electron 内置 Node（`ELECTRON_RUN_AS_NODE=1`）spawn `dsh web --patch <覆盖层> --port 0`，从 stdout 解析就绪行 `dsh web: http://127.0.0.1:<port>/?token=…`，在 BrowserWindow 里加载该 URL。关窗即杀服务进程。所有 dsh 数据在 `~/.dsh`，与命令行版共享。

## 文件地图

```
main.js             主进程：服务拉起/守护、菜单、更新检查（应用 = GitHub Release，
                    内核 = npm registry + 应用内升级到 userData/runtimes/）、CLI 启动器
                    （dsh/pnpm/node/npx/uvx/uv 六个 shim）、配置中心 IPC（插件/MCP/技能/设置/代理）
runtime.js          纯 CJS、无 Electron 依赖：版本比较、运行时目录选择（升级版优先 + 损坏回退）、
                    engines 校验、cordis patch 托管区块编辑（upsertManagedBlock/buildMcpBlock）、
                    常用设置注册表（COMMON_SETTINGS/SETTING_GROUPS）、zip 技能包识别（collectSkills）、
                    SKILL.md frontmatter 解析（parseSkillFrontmatter）、技能详情与围栏读取
                    （skillDetail/readSkillFile）、技能启用/关闭（listSkillStore/setSkillEnabled）、
                    代理环境变量清场与注入（scrubProxyEnv/applyProxyEnv）、例外列表匹配（isBypassed）
win-spawn-shim.js   经 --require 与 NODE_OPTIONS 预载进整棵 Node 子进程树。win32 上给
                    child_process 六个入口默认补 windowsHide:true（含重建 promisify.custom）；
                    DSHDESKTOP_CONSOLE_HOST=1 时配隐形宿主控制台（setupHiddenConsole），附着后
                    子进程改为继承该控制台。非 Windows 空操作。asar 内文件普通 Node 读不到，
                    启动时拷到 userData 再注入
proxy-forward.js    进程内转发代理（无 Electron 依赖，resolveSystem 由 main.js 注入）：
                    createForwarder 起 127.0.0.1 随机端口，处理 CONNECT 隧道与明文 HTTP，
                    每条连接经 routeFor 决定直连或上游代理
plugins.html        配置中心窗口：插件 / MCP 服务器 / 技能 / 常用设置 / 代理五页。
                    MCP 为主从布局，streamable-http（地址/请求头）或 stdio（命令/参数/环境变量/
                    工作目录），stdio 的「测试」在 main.js testMcpServer 里做 initialize + tools/list
                    握手。技能页：frontmatter 卡片列表 + 详情（字段表、文件树、只读预览）。
                    常用设置页按 SETTING_GROUPS 分卡片渲染 COMMON_SETTINGS，值存
                    userData/common-settings.json，经 buildSettingsBlock 写进用户 patch 层的
                    'settings' 托管区块。加一个配置项 = 注册表加一行；新插件的第一项再加一行分组
preload-plugins.js  配置中心的 contextBridge
splash.html         启动页
stage-dsh.mjs       构建期：npm ci 从 locks/ 安装 dsh + 预置插件到 staging/<platform>-<arch>/dsh，
                    裁剪，安装 pnpm（11 线）到 dsh/tools/，从 GitHub 拉钉版 uv（sha256 校验）到
                    dsh/tools/uv/，把预置插件注册进 dsh 应用依赖清单，写 preset-plugins.json
afterPack.js        electron-builder 钩子：把 staging 运行时拷进应用 resources/dsh
desktop-patch.yml   随包分发的插件组合覆盖层（默认空）
patches/            stage 期打在预置插件上的补丁。当前一个：ssh-terminal-keepalive
                    （@linxin666/dsh-ssh 的终端会话随 React 组件卸载而断线；补丁在卸载时把
                    WebSocket + xterm 停进模块级槽位，重挂时收养；服务端零改动）。锚点是构建
                    产物里的精确字符串，失配即 throw。上游修复后删补丁与调用点
plugins.json        预置插件清单（默认空 = minimal flavor）
plugins-full.json   full flavor 清单：packages（任务看板 / better-sidebar / SSH，播种激活）与
                    carry 组（只装进闭包可解析、不激活）。stage 按 DSH_FLAVOR 选清单并把精确
                    版本写进运行时 preset-plugins.json（{seed, carry}），main.js 每次启动按 seed
                    组声明式同步（syncPresetPlugins）
build/              图标 + installer.nsh（NSIS customCheckAppRunning 覆盖）
.github/workflows/release.yml  CI 构建与发版
```

## 代理链路

决策点只有 `proxy-forward.js` 的进程内转发代理。主进程在 `app.whenReady` 里（早于任何 spawn）起一个 127.0.0.1 随机端口的转发器，所有子进程拿到同一组环境：`HTTP(S)_PROXY=http://127.0.0.1:<port>`、`NO_PROXY=127.0.0.1,localhost,::1`、`npm_config_proxy`（压过 `~/.npmrc` 的 proxy=）、`NODE_USE_ENV_PROXY=1`。注入前按 `PROXY_ENV_KEYS` 大小写不敏感地清掉继承的代理变量。三种模式在转发器内部按连接决策（`routeFor`）：none 一律直连；manual 命中例外列表直连、否则 CONNECT 上游并注入 `Proxy-Authorization`；system 用 Chromium 的 `session.resolveProxy(目标URL)` 逐个 URL 询问操作系统（含 PAC 与例外列表）。

性质：配置修改立即对运行中的子进程生效（`proxy:save` 仍重启 dsh 服务以刷新 TLS 相关变量）；密码不进子进程环境；例外列表只有 `isBypassed` 一套语义。

CLI shim 是持久化文件，转发器端口不是：`userData/bin/` 的 shim 里写入的 `HTTP_PROXY` 只在应用运行期间有效。应用退出时 `will-quit` 把 shim 重写为只清场不注入（直连），下次启动写回新端口；崩溃退出留下的死端口在下次启动时自愈。

配置存 `userData/proxy.json`（旧 `{enabled,url}` 形态自动迁移），密码仅在勾选「记住」时落盘。

壳窗口自身流量不走转发器：Chromium 由 `applyChromiumProxy` 按同一份配置 `setProxy`（system 模式用 Chromium 原生 `mode: 'system'`），代理认证由 `app.on('login')` 补全。主进程自己发的 HTTP（更新检查、MCP 的 http 探测）用 `electronNet.fetch` 走 Chromium；普通 `fetch` 不跟随配置，不用。

## 验证手段

无头 Linux 环境可以验证绝大部分改动。做不到的两样：真实 win/mac 安装包（`release.yml`：workflow_dispatch 只出产物，推 `v*` 标签才发 Release）与肉眼看 GUI。

按成本从低到高：

```sh
node --check main.js runtime.js preload-plugins.js   # 语法
node -e "require('./runtime.js')"                     # runtime.js 独立可加载，纯函数直接单测
node stage-dsh.mjs                                    # linux 实跑 staging（node-pty 无 linux 预编译，脚本按平台跳过该断言）
DSH_FLAVOR=full node stage-dsh.mjs                    # full flavor：预置清单可装、peer 匹配、preset-plugins.json 生成
node update-locks.mjs <dsh版本> ["插件@版本"...]    # 升级 dsh：把上一份 full 锁平移到目标版本并重写两份锁
node stage-dsh.mjs --update-locks                     # 实时解析路径，可能指数回溯，优先用上一条
node staging/linux-x64/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js \
  web --patch desktop-patch.yml --dump-config         # patch 覆盖层并入组合树
```

代理链路整条可在无头环境实跑：`runtime.js` 的纯函数直接断言；`proxy-forward.js` 注入假的 `resolveSystem` 后端到端测——起一个 origin server、一个记录请求的上游代理桩、一个 TLS origin，断言外网目标进桩、loopback 与内网名字不进桩、CONNECT 隧道能跑 TLS、上游不可达时回 502。

完整无头启动 dsh 服务（`curl <ready-url>` 返回 303/200）需先给 linux 补 node-pty：`npm pack node-pty@<版本>` 解包后 `npx node-gyp rebuild --nodedir=<本地 node 目录>`，把 `pty.node` 放进 staging 的 `node-pty/prebuilds/linux-x64/`。0.1.2-rc.1 起就绪行带一次性 token：先请求 token URL 换 cookie（303），再用 cookie 取首页；客户端 bundle 只经组合路由下发，取首页 HTML 里 `href="/plugins/??…&rev=<hash>"` 的精确 URL 拉 bundle，断言其中含 `id: "<包名>"`。同一个 token 只能换一次 cookie，换浏览器需重启服务。

`main.js` 里依赖 Electron API 的部分至少跑 `xvfb-run electron <仓库目录> --no-sandbox` 冒烟：dsh 子进程起来、就绪端口可 curl、日志无 Uncaught。配置中心页面可在 Playwright 里用 `addInitScript` 注入假 `window.pluginApi` 后打开 `plugins.html` 截图。

NSIS 安装器可在 Linux 全流程实跑：`apt install wine64`，`WINEARCH=win64 WINEPREFIX=<新目录> wineboot -i`，Xvfb 当显示。wine 的 powershell 桩对一切命令返回 0，可复现 FIND_PROCESS 误报；移走 prefix 里的 powershell.exe 切换到 tasklist 分支。

## 约束与已知行为

改动前通读。每条只记录事实与结论。

### 启动与运行时

- Electron-as-node 跑 dsh 必须加 `--expose-internals`：cordis 加载器依赖 Node internals 做模块解析，缺失时 HMR 相关加载随机失败。
- Windows 目录选择器固定为 browse 组合（`pickerPatchArgs`）：dsh 原生 Win32 弹窗靠子进程重新 spawn `process.execPath`，打包后的 Electron 环境起不来。dsh 的交互插件是 host + client-ui 成对的，patch 只挂一半时界面不出现。
- `--patch` 启动参数层在用户 profile 配置层之后应用，desktop-patch.yml 里的条目用户无法覆盖。
- dsh launcher 只解析 argv 开头属于自己的旗标（`--profile`/`--patch`），遇到第一个陌生 token 就把剩余交给应用层。`--no-open`/`--port` 等应用旗标必须放在全部 patch 参数之后。
- rc8 起 `dsh web` 默认打开系统浏览器，壳必须传 `--no-open`。
- 0.1.2-rc.1 起就绪行带一次性 token，裸 origin 回 401，`/api` 受浏览器信任围栏保护。READY_RE 捕获整条 URL（含 query）并原样 loadURL；每次启动 token 不同。CLI 形态为 `dsh --profile web`，子命令形态 `dsh web` 仍接受。
- 升级 Electron 前确认内置 Node 满足 dsh 的 engines（当前 `^22.19 || >=24`）；`runtime.js` 的 `satisfiesNode` 在应用内内核升级前做同样检查，失败自动隔离回退（`.broken-` 目录后缀）。
- 应用内内核升级只允许同版本线（`releaseLine`：去掉预发布标签的 major.minor.patch）。第三方插件按线适配，跨线组合无法启动；跨线时静默检查不打扰，手动检查引导下载新安装包。
- 新内核会把 `~/.dsh/.credentials.yaml` 的 version 迁移为数字，旧内核要求字符串，降级方向拒绝启动。applyBootErrorFix 先把数字加引号（留 .bak），再失败则整体隔离（.broken-*）。该自愈只覆盖带此逻辑的版本。

### 预置插件

- 注册进内置 dsh 依赖只解决可解析；激活以 profile 清单为准，必须出现在 `~/.dsh/profiles/web/package.json` 的 dependencies 与 `dsh.profile.bundles` 里。激活由 `syncPresetPlugins` 每次启动声明式同步：profile 的预置部分刷成与运行时 preset-plugins.json 一致，版本也是声明的一部分，旧版本残留拷贝一并清退。userData/managed-presets.json 只记录当前托管名单，不碰用户自装插件。预置在配置中心移除后下次启动恢复；退出预置用 minimal 版。不可解析的名字自动跳过。应用内升级的运行时同样带预置包并重新注册（installCoreRuntime）。
- profile 自己 node_modules 里的残缺包会遮蔽闭包软链并阻断启动。判断包是否完好分场景：作为加载器条目需要 JS 入口存在（pkgUsableAt）；作为 bundle/依赖只需清单与声明产物齐全（pkgIntactAt，元 bundle 包没有 main 属正常）。syncPresetPlugins 每次启动对预置包做残缺清理。
- 加载器持久化的条目引用已消失的包会阻断启动。healUnresolvableEntries 给解析不到的条目放一个无操作占位包（带 `.dsh-desktop-stub` 标记），真包可用时占位退位，真实重装直接覆盖。主动扫描不完备，另有反应式兜底 applyBootErrorFix：启动失败时按报错文本识别 Cannot find package / cannot resolve profile bundle，做占位/软链/撤 bundle 后重试（最多 6 次）。
- 配置文件损坏时的自愈：第三方写入器可能把块条目追加在 flow 空列表 `[]` 之后，dsh 报 "failed to parse overlay" 或 "must be a top-level YAML array"（空文件解析为 null 同样命中；主目录层 `~/.dsh/cordis.patch.yml` 也在检查范围）。先剔除孤立 `[]` 行保住用户条目（留 .bak），修不好再整文件隔离（.broken-*）；隔离的是 MCP 托管区块所在文件时，从 userData 的 mcp-servers.json 重建。
- 互斥型插件族（皮肤）只能 carry 不能 seed：全部播种会同时注入多套皮肤，且 insert id 与用户旧装条目冲突。seed 清单已不含的名字每次启动撤活。
- 预置 bundle 的 insert id 与用户旧配置条目重复时报 duplicate loader entry id：撤我方 bundle 并写入 preset-exclusions.json，仅对当前应用版本生效，下一个版本自动重试。菜单「插件 → 重新同步预置插件…」清排除记录立即重试。
- 补丁打在应用闭包的拷贝上；profile 里同版本的真实拷贝（用户手动 pnpm 装过同版本）会遮蔽它。
- 验证预置插件在真机挂载：见上文组合路由探针；单包 `/plugins/<包名>/client.js` 与自拼组合均 404。

### 依赖与锁

- staging 用 `npm ci --force` 从 `locks/<flavor>.package-lock.json` 安装，不做实时 npm 解析：dsh 的依赖图会让 arborist 的 peer 回溯指数爆炸（mac runner 2GB 堆 OOM，linux 10 分钟不出结果）。`--force` 跳过 npm ci 的 peer 复验；锁本身是决策记录，兼容性由 staging 冒烟验证。锁根依赖与插件清单不一致时 stage 报错。
- 升级 dsh 用 `update-locks.mjs`：把上一份 full 锁按 lockstep 平移到目标版本（重刷 resolved/integrity、递归补齐新引用的包、放宽 npm ci 不过的 peer 区间、报告形状漂移）。插件增删换同样走它：移除的子树按解析语义剪枝；新增包按引用方 semver 区间取版本；可选 peer 不递归拉入，但树里已有名字不满足可选 peer 区间时 npm ci 同样报 Invalid，pass 3 的放宽对可选 peer 一并生效。跨线升级的三个必要环节：pass 2b 非 lockstep 支撑包按引用方区间交集取最高版（rc.1 把 cordis peer 提到 ^4.0.2）；pass 2c 区间不可调和时嵌套私有拷贝（compression 要 debug ^2.6）；剪枝在这些 pass 之前先跑一遍且不沿可选 peer 走。better-locale 走 plugins-full.json 的 carry 组显式钉版。`--legacy-peer-deps` 会跳过 peer 自动安装、锁缺 118 个核心包，不可用。
- pnpm 必须钉在 11 线：pnpm 12 起 npm 包是占位脚本，postinstall 才下载原生二进制，`--ignore-scripts` 安装后没有可执行文件。main.js 的 pnpmEntry() 接受 cjs/mjs 任一入口，stage 装完断言入口存在。pnpm 本体只随内置运行时分发（`dsh/tools/`），升级版运行时没有 tools 目录，取 pnpm 路径锚定 `bundledDshDir()`。
- pnpm 11.22 起 `minimum-release-age` 默认 1440 分钟：add 路径自动写 minimumReleaseAgeExclude，remove 路径直接失败（ERR_PNPM_RESOLUTION_POLICY_VIOLATIONS_UNHANDLED），内核升级同样受影响。env 与内置 pnpmrc 对该键不生效，唯一通道是子命令前的 `--config.minimum-release-age=0`，注入点为 userData/bin 的 pnpm shim 与 installCoreRuntime 的直接 spawn。严格模式复现：`--config.minimum-release-age-strict=true` 装一个 24h 内发布的包。
- pnpm 的 peer 自动安装会让预置了 better-sidebar 的干净安装装任何新插件都报 ERR_PNPM_NO_MATCHING_VERSION：多个依赖方对同名 peer 做区间交集时丢掉预发布限定（`^0.1.0-rc.8 ∩ *` → `>=0.1.0 <0.2.0`），dsh 核心只发预发布版。pnpm shim 与 installCoreRuntime 追加 `--config.auto-install-peers=false`（peer 由应用闭包在运行期提供）。容器复现需把 profile workspace yaml 的 `autoInstallPeers` 改为 true。
- pnpm 两道门禁：allowBuilds（构建脚本审批，配置中心不代为放行，提示走命令行）；minimumReleaseAge（裸装包名可能静默降级到旧版本，显式带版本号可豁免）。
- uv 默认用自带根证书，在 TLS 拦截型代理后表现为"解码响应体超时"。启动器默认 `UV_NATIVE_TLS=1` 走系统证书库。Python 解释器首次运行从 GitHub 下载到 userData/uv/python，国内用户设 `UV_PYTHON_INSTALL_MIRROR`（启动器的 `if not defined` 语义保证用户值优先）。

### Windows

- 给子进程改 PATH 必须大小写不敏感地找键（`prependEnvPath`）：`{...process.env}` 展开出的真实键通常是 `Path`，再赋值 `PATH` 造出重复键，子进程实际生效的 PATH 可能只剩新加目录。
- 代理配置清场后重写，删除同样大小写不敏感：Windows 上展开出的真实键常是 `Http_Proxy`。`~/.npmrc` 的 `proxy=` 只能靠显式 `npm_config_proxy` 压过。
- 系统代理是按 URL 逐次求值的函数：把某一个地址的 `resolveProxy` 结果当全局 `HTTP_PROXY` 会丢掉 PAC 与例外列表，内网不通。
- `NO_PROXY` 通配符语义各家不同（undici / npm / git / Python 对 `*.corp.com`、`10.*`、CIDR 解释不同），例外匹配收在 `isBypassed` 一处，`NO_PROXY` 只留 loopback。
- 开新控制台窗口不能用 `spawn('cmd.exe', …, { detached: true })`：libuv 把 detached 映射为 `DETACHED_PROCESS`，cmd 不分配控制台。写 `.cmd` 批处理再 `shell.openPath`；批处理存 UTF-8 且首行后紧跟 `chcp 65001`。
- GUI 进程树里不带 `windowsHide:true` 的控制台子进程（pwsh/cmd/git）会闪窗。`win-spawn-shim.js` 经 `--require` 与 NODE_OPTIONS 预载，给 child_process 全家默认补 windowsHide（exec/execFile 的 `promisify.custom` 必须在包装函数上重建）。node-pty（ConPTY）不走 child_process，不受影响。
- windowsHide 治不了沙箱 pwsh：dsh-sandbox-windows-acl 用 koffi 直接调 CreateProcessAsUserW 起 pwsh，受限令牌下 CREATE_NO_WINDOW 的子进程以 STATUS_DLL_INIT_FAILED (0xC0000142) 退出，语义是共享宿主控制台。setupHiddenConsole（DSHDESKTOP_CONSOLE_HOST=1）给 dsh 服务进程配隐形宿主控制台：spawn 一个 CREATE_NO_WINDOW 的 cmd，AttachConsole 后杀掉它（控制台在还有进程附着时存活）。不用 AllocConsole（闪窗，Win11 可能开 Windows Terminal 标签）。已附着真实终端时不介入。koffi 从 dsh 运行时闭包解析。
- 有隐形宿主控制台时，子进程改为继承控制台而非 CREATE_NO_WINDOW（shim 的 hostConsole 策略）：`windowsHide:true` 的子进程没有控制台，它再起的控制台程序会得到新的可见窗口（`uvx` MCP 服务器为 uv → python 两级，MCP SDK 硬编码 windowsHide:true）。无隐形控制台（CLI 场景）时维持 windowsHide 默认。逃生口 `DSHDESKTOP_INHERIT_CONSOLE=0`。
- 控制变量不能用 `DSH_` 前缀：dsh 的 subprocess 服务给每个子进程做环境清洗，除敏感名（KEY/PASSWORD/SECRET/TOKEN）外删除一切 `DSH_` 开头的变量。现名 `DSHDESKTOP_*`；`NODE_OPTIONS` 不在清洗名单。诊断日志 userData/console-debug.log 记录每个进程的附着路径与 GetLastError（6 = 目标进程无控制台，5 = 自己已有控制台）。
- electron-builder 的 FIND_PROCESS 会误报，不能作为拦截安装的门条件：PowerShell 可用时它把任何路径在 $INSTDIR 下的进程都算命中（wine 的 powershell 桩对一切命令返回 0；用户装到宽泛目录时无关进程同样命中）。误报后弹 "app cannot be closed" 并退出非零，覆盖安装死在旧卸载器重试上。现行设计（build/installer.nsh）：清扫无条件执行、按已知进程名收窄（taskkill 树杀 + 按名杀 + 限定 OpenConsole/winpty-agent/应用 exe 的路径扫），几轮后直接放行（真锁文件由解包阶段自带重试兜底），放行前把安装目录下存活进程落盘到桌面 dsh-install-debug.txt；customInit 预跑旧版卸载器，非零退出时删注册表键 + 清旧载荷绕过。

### 其他

- electron-builder 的 extraResources 默认排除 node_modules，运行时必须走 afterPack 钩子复制。
- 本仓库若放进 pnpm workspace（如上游 fork 的子目录），electron-builder 会向上探测 workspace 根并错误改用 pnpm 收集依赖；须拷到仓库外构建。
- CLI 启动器 dsh / pnpm / node 三件套缺一不可（pnpm 生命周期脚本裸调 `node`），外加给 stdio MCP 用的 npx / uvx / uv。
- 常用设置只能覆盖 web 组合树里的条目；agent 预设（config/agent-presets/*.yml）不经过 cordis.patch.yml。compaction-basic 在 web 组合里默认 `disabled: true`，「上下文自动压缩」项走注册表的 `kind: 'enable'`，与同条目的 config 键合并成一个覆盖条目。
- MCP 的 GUI 配置写入 `~/.dsh/profiles/web/cordis.patch.yml` 的标记托管区块（`# >>> dsh-desktop mcp >>>`），dsh 热加载、dsh-mcp-client 支持配置热替换，保存即生效。只改标记区块，保留用户手写条目；文件默认内容是 flow 空列表 `[]`，与块列表不能共存，upsertManagedBlock 已处理。移除条目时经 `pnpm dlx` 启动的旧 MCP 进程可能残留到应用退出。
- 技能启用/关闭是目录搬移：dsh 的文件系统 provider 只扫根目录顶层，没有按名禁用的配置；关闭 = 移入 `~/.dsh/disabled_skills/`（技能根目录的同级，不在任何扫描根之内，agent 列技能目录也看不到），目录监视 2 秒内生效。同名在两边同时存在时拒绝搬移。旧位置 `~/.dsh/skills/.disabled/` 在首次列表时自动迁移。
- CLI 启动器里的转发器端口只在应用运行期间有效；应用关闭后 shim 的清场部分仍有效，代理部分不再有效。

## 文档维护

文档随代码同一次提交更新。

- 一个事实只放一处。README 面向用户与发版者：装什么、怎么用、怎么发版。AGENTS.md 面向下一个 agent 或贡献者：架构、验证手段、约束。两边不互相复述。
- CLAUDE.md 只有一行 `@AGENTS.md`，内容改 AGENTS.md。
- 加/删/改源文件或其职责 → 文件地图；新的构建/验证方式 → 验证手段（附可直接执行的命令）；解决了非显然的问题 → 约束清单加一条（一句话结论 + 触发条件；上游修复或依赖升级后失效的条目删除）；用户可见行为变化 → README 对应小节。
- 约束清单只收会再次遇到的：一次性环境故障、已被代码防御且有注释的不收。
- 文档改完自检：README 的命令逐条可执行；AGENTS.md 验证一节的命令在干净 checkout 上能跑通。

## 风格约束

主进程是无构建步骤的 CJS，唯二依赖 electron 与 electron-builder（devDependencies），不引入打包器、框架或运行时依赖。能写成纯函数的逻辑放 `runtime.js` 这类无 Electron 依赖的模块。用户可见文案用中文，陈述结果，不解释动机。发版：推 `v*` 标签；锁定内核版本用 stage 步骤的 `DSH_VERSION` 环境变量。
