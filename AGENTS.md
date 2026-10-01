# 协作规范

本仓库提供 DeepSeek Harness 的 Electron 桌面壳、Windows EXE 与 macOS DMG。内核由 `stage-dsh.mjs` 从 npm 安装；内核行为在上游仓库维护。

## 文档、注释与 UI 文案

1. **声明式**：直接陈述职责、契约、状态和行为。
2. **仅呈现设计结果**：描述当前有效的设计；省略作者动机、推导过程、方案比较和自我解释。
3. **结构清晰**：用标题划分主题，用列表呈现并列项，用表格表达对应关系；一项一个结论。

| 载体 | 内容 |
|---|---|
| 文档 | 功能、用法、配置、边界与约束；同一事实保留一个来源 |
| 代码注释 | 职责、输入输出、契约与非显然的边界；函数级用 JSDoc，不复述代码 |
| UI 文案 | 字段名称、状态、动作与必要提示；详细说明放帮助或文档，诊断细节按需展开 |

用户可见文案陈述结果，不解释动机；简短、具体，术语一致。涉及数据采集、权限或不可逆操作的必要信息在操作处呈现。

- 用户界面提供中文与英文，跟随内核页面语言；首次启动使用系统语言。
- 中英文文案字典包含相同键集，插值参数保持一致。

## 文档维护

- [README.md](README.md) 记录安装、使用、构建与发版；本文件记录架构、验证与维护约束。
- `CLAUDE.md` 仅包含 `@AGENTS.md`。
- 文档和注释随对应行为更新；删除失效说明和历史排错过程。
- 文件职责变化更新文件地图；构建与测试变化更新验证入口；用户行为变化更新 README。
- 命令说明列出依赖、平台和输入要求；中英文说明保留相同的功能、边界与约束。

## 架构

主进程使用 Electron 内置 Node，以 `ELECTRON_RUN_AS_NODE=1` 启动 dsh 服务。服务监听随机回环端口；主进程解析 stdout 就绪 URL 并加载到 BrowserWindow。

- 主进程使用无构建步骤的 CJS；独立逻辑放在 `runtime.js` 等无 Electron 依赖的模块中。
- 构建依赖为 electron、electron-builder 与 semver；应用更新使用 electron-updater。依赖声明以 `package.json` 为准。
- 数据目录、窗口关闭行为和界面入口见 [README](README.md)。

### 文件地图

| 文件 | 职责 |
|---|---|
| `main.js` | 服务进程、窗口、菜单、更新、CLI 启动器、配置中心 IPC、托盘与系统唤醒 |
| `runtime.js` | 版本选择、Node engines 校验、配置归一化与代理函数 |
| `win-spawn-shim.js` | 子进程窗口策略、隐形宿主控制台与预加载传播 |
| `plugins/dsh-desktop-directory-picker` | 工作区系统目录选择器 |
| `plugins/dsh-desktop-activity` | 每 2 秒读取 agents/jobs，经 IPC 上报忙闲 |
| `proxy-forward.js` | HTTP / CONNECT 转发与逐连接路由 |
| `plugins.html` | 配置中心界面 |
| `window-chrome.js` | 标题栏、可信主 frame IPC、主题与全屏同步 |
| `preload-desktop.js` | 平台布局、菜单桥、主题探针与配置中心 pluginApi |
| `desktop-i18n.js` | 中英文文案与插值 |
| `splash.js` | 启动页语言同步 |
| `desktop.css` / `splash.html` | 原生按钮安全区、拖拽区、主题与启动页 |
| `stage-dsh.mjs` | 安装与裁剪运行时、安装 pnpm、登记预置包 |
| `update-locks.mjs` | 更新内核、插件与依赖闭包的锁文件 |
| `afterPack.js` | 将 staging 复制到 resources/dsh，过滤 tools/uv |
| `desktop-patch.yml` | 随包分发的组合覆盖层 |
| `plugins.json` / `plugins-full.json` | minimal / full 预置清单 |
| `build/installer.nsh` | 安装与卸载的进程清理、阶段提示和提取钩子 |
| `build/extract-long-paths.nsh` | 长路径解压、Robocopy 复制与失败重试 |
| `build/test-*.cjs` / `build/test-*.mjs` | 运行时、窗口、迁移与安装载荷验证 |
| `.github/workflows/release.yml` | 原生构建与发布流程 |

### 启动与运行时

| 项目 | 契约 |
|---|---|
| Node 模式 | 传入 `--expose-internals`，允许 cordis 加载器解析 Node 内部模块 |
| Electron 升级 | 内置 Node 须满足 dsh 的 engines，V8 版本须命中 node-addon-require-builtin 指纹表 |
| 参数顺序 | launcher 参数 `--profile` / `--patch` 位于应用参数 `--no-open` / `--port` 之前 |
| 浏览器启动 | 必须传 `--no-open` |
| 就绪 URL | READY_RE 捕获完整 URL，含一次性 token；loadURL 原样使用 |
| Cookie | `loadWebUi` 在每次加载前清理 127.0.0.1 下的全部 `dsh-auth-*` cookie；cookie 按 host 隔离 |
| 单实例 | 仅持有 hasInstanceLock 的进程启动服务；second-instance 恢复主窗口 |
| 退出 | before-quit 设置 quitting；close 事件按托盘设置隐藏或关闭窗口 |
| 服务意外退出 | 先恢复主窗口，再显示错误 |
| 内核回退 | 升级内核未通过 Node 校验或启动失败时隔离至 `.broken-*`，回退内置版本 |
| 系统唤醒 | agents running、inbox.nextTurn/nextStep 非空或 jobs running/stopping 时视为忙；选项开启且忙时持有 prevent-app-suspension，服务退出即释放 |

### 窗口与 IPC

- `data-desktop-platform` 标识桌面布局；不得设置会启用官方原生键盘桥的 `data-platform`。
- Windows 使用 `data-windows-titlebar`、`data-fullscreen`、`data-window-drag`、`data-shell-overlay` 和 `--dsw-*` 配色 token；拖拽区使用 `env(titlebar-area-width)`。
- Windows 隐藏原生菜单栏，保留 Menu 与快捷键。
- macOS 标题栏预留 48px，拖拽区与侧栏使用同一不透明底色；frame 前三列为侧栏、主内容和右栏，布局选择器不匹配编译类名。
- `data-ds-theme-source` 同步到 `nativeTheme.themeSource`；system 保留系统主题监听。
- 共享 preload 仅启用于受管窗口主 frame、精确本地文件或当前内核来源；pluginApi 仅暴露给配置中心本地页。
- 目录选择器 host 与 client-ui 成对挂载，替换 directory-picker-auto；经 `stdio[3]='ipc'` 请求主进程打开系统目录对话框，取消返回 null，abort 后丢弃结果。

### 代理链路

转发器在 `app.whenReady` 中、首次 spawn 前启动，监听 127.0.0.1 随机端口。

| 边界 | 行为 |
|---|---|
| 子进程环境 | 按大小写不敏感方式清理 PROXY_ENV_KEYS，再写入 HTTP(S)_PROXY、NO_PROXY、npm_config_proxy 和 NODE_USE_ENV_PROXY=1 |
| npm 配置 | npm_config_proxy 覆盖用户 npmrc 的 proxy |
| 回环地址 | NO_PROXY 包含 127.0.0.1、localhost、::1 |
| none | 直连 |
| manual | 命中 isBypassed 例外列表时直连，否则 CONNECT 上游并注入 Proxy-Authorization |
| system | 按目标 URL 调用 Chromium session.resolveProxy，包含 PAC 与系统例外列表 |
| 配置更新 | 每次连接读取路由配置；proxy:save 重启服务并刷新 TLS 环境 |
| 配置存储 | userData/proxy.json；支持旧 enabled/url 格式迁移；密码不传入子进程环境 |
| CLI shim | 启动时写入转发器端口；will-quit 改为仅清理代理变量；异常退出后的端口在下次启动更新 |
| Chromium | applyChromiumProxy 调用 setProxy，app login 事件提供代理认证 |
| 主进程 HTTP | 使用 electronNet.fetch，遵循 Chromium 代理配置 |

### 预置插件与启动恢复

- stage 将预置清单的精确版本写入 preset-plugins.json；seed 激活，carry 仅加入依赖闭包，互斥皮肤属于 carry。
- 预置包登记为 dsh 应用依赖；激活条目同时写入 profile 的 dependencies 和 dsh.profile.bundles。
- syncPresetPlugins 每次启动同步 seed 名单和版本，跳过不可解析或当前版本排除的包；managed-presets.json 记录托管名单，用户自行安装的插件不在同步范围内。
- profile 内预置包的残缺或版本不匹配副本在同步时清理；已移出 seed 的托管条目撤活。
- installCoreRuntime 为升级内核安装并登记同一组预置包。
- 桌面自带 `plugins/<name>` 是纯 JS 包；stage 和 ensureDesktopPlugins 将其复制到活动运行时并登记为应用依赖，不写入 profile 或 preset-plugins.json。
- `--patch` 在用户 profile 层之后应用，用户配置不能覆盖 desktop-patch.yml。

| 检查或触发条件 | 行为 |
|---|---|
| pkgEntryOf | 先取 main，再取 exports["."] 字符串或 default/import/require/node 条件 |
| pkgUsableAt | 加载器条目必须具有可用 JS 入口 |
| pkgIntactAt | 清单及声明产物齐全；元 bundle 可无 JS 入口 |
| 条目包缺失 | healUnresolvableEntries 写入带 `.dsh-desktop-stub` 的无操作占位；真实包可用时移除占位；不得覆盖完整包 |
| Cannot find package / cannot resolve profile bundle | applyBootErrorFix 执行占位、软链或撤销 bundle，启动最多重试 6 次 |
| overlay 解析失败 | 检查用户 dsh 目录内的报错文件，含主目录覆盖层；孤立 `[]` 与块条目并存时备份后删除 `[]`，仍失败时隔离为 `.broken-*` |
| credentials version 类型不匹配 | 数字 version 备份后改为字符串；仍失败时隔离凭证文件 |
| duplicate loader entry id | 撤销冲突的预置 bundle，写入仅对当前应用版本生效的 preset-exclusions.json；新版本重新尝试 |

### 更新发布契约

| 项目 | 契约 |
|---|---|
| GitHub 来源 | electron-updater 使用 package.json 的 updateRepo |
| 更新元数据 | build.publish 为 github；发布上传产物 `*.yml`，排除 builder-debug.yml |
| Windows 载荷 | nsis.differentialPackage=false，下载整包 |
| flavor | minimal 使用 latest.yml；full 通过 publish.channel=full 与 extraMetadata.flavor=full 生成 full.yml |
| 降级 | 设置 autoUpdater.channel 后显式关闭 allowDowngrade |
| 签名 | 未配置 publisherName 时 electron-updater 跳过签名校验 |
| 安装 | quitAndInstall(true, true) 使用 `/S --updated --force-run`，进入 isUpdated 路径 |

用户更新入口、平台行为与内核版本线限制见 [README 的更新说明](README.md#更新)。

## 构建约束

| 项目 | 约束 |
|---|---|
| staging | npm ci --force 使用 locks/<flavor>.package-lock.json；锁根依赖须匹配插件清单 |
| 锁更新 | 更新 resolved/integrity、依赖闭包并报告依赖结构变化 |
| 平台依赖 | 保留 os/cpu/libc；仅由可选依赖可达的子树标记 optional |
| 版本解析 | 非 lockstep 包按引用区间交集选版；冲突区间使用嵌套私有副本 |
| peer | 闭包包含自动安装的 peer；不递归安装可选 peer，但校验已存在的同名包；禁止 --legacy-peer-deps |
| 注册表请求 | 包含超时、重试与进度输出；临时文件使用系统临时目录 |
| better-locale | full 清单 carry 组显式固定版本 |
| pnpm | 固定 11 线，接受 cjs/mjs 入口，从 bundledDshDir()/tools 读取 |
| pnpm 参数 | shim 和 installCoreRuntime 在子命令前传 --config.minimum-release-age=0、--config.auto-install-peers=false |
| CLI | 分发 dsh、pnpm、node、npx 启动器 |
| 打包 | afterPack 复制运行时 node_modules；仓库位于 pnpm workspace 外 |
| Python MCP | toolkit 配置中心管理 uv/uvx；桌面不下载、捆绑或生成其启动器 |
| uv 迁移 | 仅清理应用 bin 中同时包含旧缓存变量和 tools/uv 路径的生成文件；保留自定义启动器和缓存 |
| 技能 | DSHDESKTOP_DISABLED_SKILLS 传入 userData/disabled-skills/，供 toolkit 读取旧停用技能 |

### 运行时裁剪

| 文件 | 处理 |
|---|---|
| sourcemap、.pdb、*.d.ts / *.d.mts / *.d.cts | 删除 |
| 第三方包 README / CHANGELOG 等包说明 | 删除；保留 @deepseek-ai 与插件包说明 |
| 第三方包顶层 test / docs / examples / .github | 仅处理 package.json 同级目录 |
| 其他 Markdown、嵌套同名目录与 LICENSE | 保留，含 SKILL.md 等运行时资源 |

裁剪后验证 GUI 流程、全部 @deepseek-ai/* 入口加载与相对 import 完整性。安装载荷使用 7z。

### Windows 子进程

| 项目 | 约束 |
|---|---|
| EXE 清单 | requestedExecutionLevel=requireAdministrator，由 electron-builder 写入；macOS 配置独立 |
| 环境 | PATH 与代理变量按大小写不敏感查找和修改 |
| 用户终端 | UTF-8 .cmd 经 shell.openPath 打开；首行后执行 chcp 65001 |
| shim | 经 --require 与 NODE_OPTIONS 预载；覆盖 child_process 六个入口及 exec/execFile 的 promisify.custom；ConPTY 不受影响 |
| 预加载传播 | process.execPath 与 argv 数组启动的子进程附加 --require；argv 以 -- 开头时除外 |
| 控制台 | DSHDESKTOP_CONSOLE_HOST=1 通过 CREATE_NO_WINDOW 的 cmd 与 AttachConsole 建立隐形控制台；保留已有真实控制台 |
| 继承 | 附着后非 detached 子进程继承控制台；DSHDESKTOP_INHERIT_CONSOLE=0 关闭继承策略 |
| 控制变量 | 使用 DSHDESKTOP_* 前缀；内核会清理 DSH_* |
| koffi | 从活动 dsh 运行时闭包解析；受限令牌沙箱共享宿主控制台 |
| 诊断 | userData/console-debug.log 记录附着路径与 Win32 错误码；6：目标无控制台，5：本进程已有控制台 |

### Windows 安装器

| 阶段 | 契约 |
|---|---|
| 关闭进程 | 非更新路径命中进程时确认一次；按已知名称和限定路径清理进程树，重试次数有限 |
| 旧卸载器 | 用户开始安装后预运行；失败时清理旧注册项和载荷 |
| 解压 | extractUsing7za 使用 Nsis7z，输出目录带 `\\?\` 前缀 |
| 复制 | Robocopy /E；返回码 0–7 成功，8 及以上或启动失败进入重试 / 取消 |
| 文件保留 | 保留目标目录额外文件；禁止 /MIR |
| 静默失败 | 返回非零退出码 |
| 日志 | 复制日志路径见 README；存活进程诊断写入桌面 dsh-install-debug.txt |
| 明细 | customShowDetails 启用 SetDetailsPrint both 与 InstFiles 列表（1016）；customDetail 按 $LANGUAGE 输出中英文 |
| 钩子 | customCheckAppRunning：解压前；customFiles_x64：复制后；customInstall：安装完成 |

FIND_PROCESS 仅用于运行确认；文件占用由提取和复制阶段的重试处理。

## 验证

按改动范围运行对应检查。安装、staging 和发版命令见 README。

### 本地检查

仓库根目录命令：

```sh
node --check main.js
node --check runtime.js
node --check window-chrome.js
node --check preload-desktop.js
node build/test-server-output.cjs
node build/test-windows-execution-level.cjs
node build/test-uv-removal.cjs
node -e "require('./runtime.js')"
```

### 服务与代理

- staging 后运行该平台目录下的 dsh CLI，以 `web --patch desktop-patch.yml --dump-config` 验证组合树。
- 无头启动服务后，使用就绪 token URL 换取 cookie（303），再携带 cookie 请求首页（200）；token 仅可兑换一次。
- 客户端 bundle 使用首页 HTML 中 `/plugins/??…&rev=<hash>` 的精确 URL；验证其中的插件 id。单包路径和自行拼接的组合 URL 不受支持。
- Linux 无头启动依赖 node-pty 本机构建；将编译得到的 pty.node 放入 staging 的 node-pty/prebuilds/linux-x64/。Linux staging 不校验该预编译文件。
- 代理测试注入 resolveSystem，使用 HTTP origin、记录请求的上游代理和 TLS origin；验证外网路由、回环和内网直连、CONNECT TLS 及上游不可达时的 502。

### Electron

- `node build/test-window-chrome.cjs` 使用 staging 内的隔离 userData，覆盖 IPC 来源隔离、主题、配置控件、原生菜单、按钮安全区、缩放与全屏；截图位于 staging/window-chrome-test/。全屏检查会短暂显示窗口。
- `DSHDESKTOP_TEST_ELECTRON` 指定 Electron；同时设置 DSHDESKTOP_TEST_RUNTIME（含 node_modules）和 DSHDESKTOP_TEST_HOME（staging 内隔离 profile）时验证真实内核。
- macOS 原生按钮与标题栏配色 在 macOS 验证；Windows 检查其布局与选项。
- Linux 冒烟可用 `xvfb-run electron <仓库目录> --no-sandbox`；验收服务就绪、HTTP 可访问和无 Uncaught 日志。
- 页面检查通过 Playwright 注入 pluginApi 或 CDP 连接；CDP 检查结束时断开连接，调用 browser.close() 会关闭 Electron。
- Linux 关闭窗口检查发送 WM_DELETE_WINDOW ClientMessage；XDestroyWindow 和渲染进程 window.close() 不覆盖 BrowserWindow close 的 preventDefault 路径。
- Xvfb 仅检查托盘代码路径；图标显示须在原生桌面验证。

### 安装器

- NSIS 使用 `-WX` 编译；Linux 编译需要 Wine 64 位与 32 位支持。
- Windows 执行 `node build/test-installer-copy.mjs <makensis.exe> <NSIS插件目录> <7za.exe> [<完整载荷.7z> <win-unpacked目录>]`。
- 验证超过 260 字符的路径、SHA256、首次与覆盖安装、额外文件保留、占用失败与解除占用后的重试。
- 附加完整载荷时逐文件检查真实应用；测试仅写 staging/installer-copy-test-* 和临时日志，不写注册表或快捷方式。
