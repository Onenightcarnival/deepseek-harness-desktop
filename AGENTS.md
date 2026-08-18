# AGENTS.md

本仓库是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）的**非官方桌面打包**：一个 Electron 壳，把 npm 发布版 `@deepseek-ai/dsh` 打成 Windows exe 和 macOS dmg。仓库里没有上游源码——运行时在构建时由 `stage-dsh.mjs` 从 npm 拉取。改上游行为请去上游仓库；这里只改"壳、打包、分发"。

## 架构一句话

主进程用 Electron 内置 Node（`ELECTRON_RUN_AS_NODE=1`）spawn `dsh web --patch <覆盖层> --port 0`，从 stdout 解析就绪行 `dsh web: http://127.0.0.1:<port>`，然后在 BrowserWindow 里加载该 URL。关窗即杀服务进程。所有 dsh 数据在用户目录 `~/.dsh` 下，与命令行版共享。

## 文件地图

```
main.js             主进程全部逻辑：服务拉起/守护、菜单、更新检查（应用=GitHub Release，
                    内核=npm registry + 应用内升级到 userData/runtimes/）、CLI 启动器生成
                    （dsh/pnpm/node 三个 shim）、配置中心 IPC（插件/MCP/技能）
runtime.js          纯 CJS、无 Electron 依赖：版本比较、运行时目录选择（升级版优先+损坏回退）、
                    engines 粗校验、cordis patch 托管区块编辑（upsertManagedBlock/buildMcpBlock）、
                    zip 技能包内容识别（collectSkills）—— 刻意抽出来以便普通 node 直接单测
plugins.html        配置中心窗口（左侧导航四页：插件 / MCP 服务器 / 技能 / 代理；MCP 为
                    主从布局，表单仅暴露 streamable-http——validateMcpServer 与
                    buildMcpBlock 仍接受 stdio 以兼容旧存量条目。代理页为 PyCharm 式
                    （模式单选/主机+端口/例外/认证，密码仅在勾选记住时落盘，否则
                    只存本次运行内存），写 userData/proxy.json（旧 {enabled,url}
                    形态自动迁移），经 runtime.js 的 buildProxyEnv（含单测）注入
                    标准 HTTP(S)_PROXY/NO_PROXY + NODE_USE_ENV_PROXY 到所有子进程
                    spawn 点；本机地址强制在 NO_PROXY 里，否则界面与本地 MCP 会被
                    代理劫持——已实测外网走 CONNECT、localhost 直连）
preload-plugins.js  配置中心的 contextBridge
splash.html         启动等待页
stage-dsh.mjs       构建期：npm 安装 dsh + plugins.json 预置插件到 staging/<platform>-<arch>/dsh，
                    裁剪，安装 pnpm 到 dsh/tools/，把预置插件注册进 dsh 应用依赖清单
afterPack.js        electron-builder 钩子：把 staging 运行时拷进应用 resources/dsh
desktop-patch.yml   随包分发的插件组合覆盖层（默认空）
plugins.json        要预置进安装包的插件 npm 包列表（默认空 = minimal flavor）
plugins-full.json   full flavor 的预置清单：packages（任务看板/better-sidebar 工作台/
                    SSH 三件生产力套件，播种激活；better-sidebar 自带 Git 面板，
                    故不再单独预置 git-graph）；另支持 carry 组（只装进闭包可解析、
                    不激活，当前为空）。stage 按 DSH_FLAVOR 选清单并把精确版本写进
                    运行时 preset-plugins.json（{seed, carry}），main.js 每次启动按
                    seed 组做声明式同步（syncPresetPlugins）
build/              图标 + installer.nsh（NSIS customCheckAppRunning 覆盖：安装前
                    树杀应用进程 + 按路径扫尾，见坑清单）；.github/workflows/release.yml  CI 构建与发版
```

## Agent 工作环境与验证手段

**你（agent）大概率在无 GUI 的 Linux 环境里工作，而这个项目的绝大部分改动恰好都能在这种环境里验证。** 打不出来的只有两样：真实的 win/mac 安装包（CI 的 `release.yml` 负责，手动触发 workflow_dispatch 只出产物不发版，推 `v*` 标签才发 Release）和"肉眼看 GUI"（交给用户装包验证）。

无头环境可用的验证手段，按成本从低到高：

```sh
node --check main.js runtime.js preload-plugins.js   # 语法
node -e "require('./runtime.js')"                     # runtime.js 可独立加载，纯函数可直接写单测
node stage-dsh.mjs                                    # linux 上实跑 staging（node-pty 无 linux 预编译
                                                      #   是预期的，脚本已按平台跳过该断言）
DSH_FLAVOR=full node stage-dsh.mjs                    # full flavor：验证预置插件清单能装、
                                                      #   peer 与内置 dsh 匹配、preset-plugins.json 生成
node staging/linux-x64/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js \
  web --patch desktop-patch.yml --dump-config         # 验证 patch 覆盖层能正确并入组合树
```

要完整无头启动 dsh 服务（验证到 `curl <ready-url>` 返回 200）需先给 linux 补 node-pty：`npm pack node-pty@<版本>` 解包后 `npx node-gyp rebuild --nodedir=<本地 node 目录>`，把 `pty.node` 放进 staging 的 `node-pty/prebuilds/linux-x64/`。MCP patch 生成器、allowBuilds 输出解析这类纯逻辑，从 `main.js` 里按函数名正则抽出源码 `eval` 后即可断言（`runtime.js` 的做法是更好的归宿——新增纯逻辑优先放进无 Electron 依赖的模块）。

改 `main.js` 里依赖 Electron API 的部分时，至少跑 `xvfb-run electron <仓库目录> --no-sandbox` 冒烟：确认 dsh 子进程起来、就绪端口可 curl、日志无 Uncaught。

## 踩过的坑（改动前必读）

- **Electron-as-node 跑 dsh 必须加 `--expose-internals`**。cordis 加载器靠 Node internals 做模块解析；纯 node 下能容忍缺失，Electron 下不加会在启动时随机炸 HMR 相关加载。
- **Windows 目录选择器钉死为 browse 组合**（main.js 的 `pickerPatchArgs`）。dsh 原生 Win32 弹窗靠子进程重新 spawn `process.execPath`，在打包后的 Electron 环境下起不来。dsh 的交互插件是"host + client-ui 成对"的——patch 里只挂一半界面不会出现，这个错犯过一次。
- **`--patch` 启动参数层在用户 profile 配置层之后应用**，desktop-patch.yml 里写死的条目用户无法覆盖，保持克制。
- **预置插件"注册进内置 dsh 依赖"只解决可解析，激活是另一回事**。注册（stage-dsh.mjs 已做）让 dsh 启动时按"应用依赖闭包"把包软链到 `~/.dsh/profiles/node_modules`；但 bundle 的激活以 profile 清单为准——必须出现在 `~/.dsh/profiles/web/package.json` 的 dependencies + `dsh.profile.bundles` 里。激活由 main.js 的 syncPresetPlugins **声明式同步**：每次启动（所有 flavor 都跑）把 profile 的预置部分刷成与运行时 preset-plugins.json 完全一致——增量播种+粘滞标记的老方案在"用户删过/冲突让过/版本换过"的组合下事故不断（git-graph 曾因此永久消失），已废弃。userData/managed-presets.json 只记录"当前由我们管理的名单"（换 flavor 时知道该删谁，绝不碰用户自装插件；旧 seeded-presets.json 自动迁移）；预置在配置中心移除后下次启动会同步回来（**有意为之**，退出预置请用 minimal 版）；不可解析的名字自动跳过（full→minimal 覆盖安装因此天然自洽，不会再触发 "cannot resolve profile bundle" 拒启）。应用内内核升级后的运行时也要带上预置包并重新注册，否则播种过的 profile 解析不到（installCoreRuntime 已做）。
- **profile 自己 node_modules 里的残缺包会遮蔽闭包软链并炸掉启动**。`dsh plugin remove` 的残留目录可能保留 package.json/LICENSE 但丢失代码，Node 解析优先命中它，报 "Cannot find package …"，整个 dsh 起不来。判断"包是否完好"要分场景：作为加载器条目 import 需要 JS 入口文件存在（pkgUsableAt）；作为 bundle/依赖只需清单及其声明的产物齐全——元 bundle 包（如 dsh-skins）没有 main 是正常的，用入口文件标准会误判（pkgIntactAt）。syncPresetPlugins 每次启动对预置包做残缺清理。
- **加载器持久化的条目也会引用已消失的包并炸掉启动**。皮肤中心等功能在运行时把选中的包 pnpm 装进 profile 并把条目写进 `~/.dsh/profiles/web/cordis.yml`；换 flavor 或本地安装损坏后该包解析不到，dsh 报 ERR_MODULE_NOT_FOUND 拒绝启动。不能安全地改用户配置——healUnresolvableEntries 的做法是给解析不到的条目在 profile node_modules 放一个无操作占位包（带 `.dsh-desktop-stub` 标记），当前运行时能提供真包时占位自动退位（按标记扫描，不依赖配置引用——dsh 会规范化重写 cordis.yml 丢弃条目，孤儿占位必须靠标记找到），真实重装会直接覆盖它。**主动扫描注定不完备**（dsh 持久化条目的位置/格式不可枚举，flow 风格 YAML 就躲得过正则），所以另有反应式兜底 applyBootErrorFix：启动失败时按报错文本识别 Cannot find package / cannot resolve profile bundle，做占位/软链/撤 bundle 后自动重试（最多 6 次，加载器一次只报一处）。**配置文件本身也会坏**：第三方插件的配置写入器可能把块条目追加在默认的 flow 空列表 `[]` 之后（非法 YAML，我们的 MCP 写入器专门处理过这个坑），dsh 报 "failed to parse overlay <路径>" 或 "<路径> must be a top-level YAML array"（顶层类型错，空文件解析为 null 同样命中；主目录层 `~/.dsh/cordis.patch.yml` 也在检查范围）拒绝启动——自愈先尝试剔除孤立 `[]` 行保住用户条目（留 .bak），修不好再整文件改名隔离（.broken-*），若隔离的是 MCP 托管区块所在的 profile patch，则从 userData 的 mcp-servers.json 重建托管区块，MCP 配置不丢。**互斥型插件族（皮肤）只能 carry 不能 seed**：十款皮肤全部播种激活会同时注入十套皮肤（上游靠皮肤中心保证同时只启用一款），且每款的 insert id 都会与用户旧装皮肤条目撞车，冲突数超过自愈重试上限直接起不来——皮肤属于 carry 组：随包可解析、激活权留给皮肤中心；播种标记里"当前 seed 清单已不含"的名字每次启动被撤活（旧版误播的皮肤由此自愈）。还有一类冲突：**预置 bundle 的 insert id 与用户旧配置里的条目重复**（如用户曾用皮肤中心装过某皮肤，后来该皮肤成了预置），报 duplicate loader entry id——处理是撤我方 bundle 并写入 preset-exclusions.json（**仅对当前应用版本生效**）：用户自己的条目借闭包携带的包继续生效，而 dsh 重写配置丢掉用户条目后，下一个安装版本会自动重试恢复预置——排除绝不能做成永久粘滞（曾让 git-graph 两头落空永久消失）。菜单「插件 → 重新同步预置插件…」清排除记录立即重试。报错信息才是权威来源。
- **electron-builder 的 extraResources 默认排除 node_modules**，运行时必须走 afterPack 钩子复制，别改回 extraResources。
- **本仓库若被放进 pnpm workspace（如上游 fork 的子目录）**，electron-builder 会向上探测 workspace 根并错误改用 pnpm 收集依赖——必须把本目录拷到仓库外构建（独立仓库布局无此问题）。
- **给子进程改 PATH 必须大小写不敏感地找键**（runtime.js 的 prependEnvPath，含单测）。Windows 上 `{...process.env}` 展开出的真实键通常是 `Path`，再赋值 `PATH` 会造出重复键，子进程实际生效的 PATH 可能只剩新加的目录——dsh 服务进程曾因此丢掉整个系统 PATH，git 等外部命令全部 ENOENT，表现为 git-graph/aionui-panel 在 Windows 上静默失效而 mac 正常（magic 的 `process.env` 本身大小写不敏感，展开后的普通对象不是）。
- **CLI 启动器是 dsh / pnpm / node 三件套**，缺一不可：pnpm 生命周期脚本会裸调 `node`，用户机器上没有 Node.js。pnpm 本体只随**内置**运行时分发（`dsh/tools/`），应用内升级的运行时没有 tools 目录，取 pnpm 路径必须锚定 `bundledDshDir()`。
- **pnpm 两道门禁**：allowBuilds（构建脚本审批——配置中心**有意不代为放行**，这是安全边界，只提示走命令行）；minimumReleaseAge（新发布版本冷却期——裸装包名可能**静默降级**到远古版本，表现为"装上了但没效果"，显式带版本号可豁免）。
- **MCP 的 GUI 配置写入 `~/.dsh/profiles/web/cordis.patch.yml` 的标记托管区块**（`# >>> dsh-desktop mcp >>>`），因为该文件被 dsh 热加载、dsh-mcp-client 支持配置热替换——保存即生效不用重启。只改标记区块、保留用户手写条目；文件默认内容是 flow 空列表 `[]`，与块列表条目不能共存，upsertManagedBlock 已处理（含单测）。已知余波：移除条目时经 `pnpm dlx` 包装启动的旧 MCP 服务器进程可能残留到应用退出。
- **electron-builder 的 FIND_PROCESS 会误报，绝不能用它作为拦截安装的门条件**。PowerShell 可用时它根本不按进程名查，而是"任何路径在 $INSTDIR 下的进程"都算命中：wine 的 powershell 桩对一切命令返回 0（恒判定"在运行"），用户装到宽泛的自定义目录时该目录下无关进程同样命中。旧版宏在误报时重试后弹 "app cannot be closed" 并 Quit——安装器和（更糟的）静默运行的旧版卸载器都会因此退出非零，覆盖安装死在 installUtil 的卸载重试上，弹的还是同一句误导文案（appCannotBeClosed 有三个来源：进程检查/解包失败/旧卸载器非零退出）。现行设计（build/installer.nsh）：清扫无条件执行、按已知进程名收窄（taskkill 树杀 + 无过滤按名杀 + 限定 OpenConsole/winpty-agent/应用 exe 的路径扫），几轮后无论检测结果如何**直接放行**（真锁文件由解包阶段自带的重试兜底），放行前把安装目录下存活进程落盘到桌面 dsh-install-debug.txt；customInit 预跑旧版卸载器，非零退出时删注册表键+清旧载荷绕过它（在野的旧安装都带会误报自杀的卸载器）。
- **NSIS 安装器可以在 Linux 上全流程实跑验证**：需要 `apt install wine64` + `WINEARCH=win64 WINEPREFIX=<新目录> wineboot -i`（默认 prefix 是 win32，装 64 位包会弹 "64-bit Windows is required"），跑安装器要挂 Xvfb 当显示。wine 的 powershell 桩天然制造 FIND_PROCESS 误报，正好用来复现该类故障；把 prefix 里 WindowsPowerShell/v1.0/powershell.exe 移走可切换到 tasklist 分支。定位安装器中止点用 preInit/customInit/customInstall 钩子写标记文件二分。
- **Windows 上开新控制台窗口不能用 `spawn('cmd.exe', …, { detached: true })`**：libuv 把 detached 映射为 `DETACHED_PROCESS`，cmd 不会分配控制台，表现为"点了没反应"。写 `.cmd` 批处理文件再 `shell.openPath`（ShellExecute）才可靠出窗口；批处理按控制台代码页解析，含中文需文件存 UTF-8 且首行后紧跟 `chcp 65001`。
- **升级 Electron 版本前**确认其内置 Node 满足 dsh 的 engines（当前 `^22.19 || >=24`）；`runtime.js` 的 `satisfiesNode` 在应用内内核升级前也做同样检查，升级失败有自动隔离回退（`.broken-` 目录后缀）。

## 维护本文档与 README

文档随代码同一次提交更新，不单独攒。分工与写法：

- **一个事实只放一处。** README 面向用户和发版者：装什么、怎么用、怎么发版。AGENTS.md 面向下一个（无本次对话记忆的）agent 或贡献者：架构一句话、文件地图、验证手段、坑。两边不互相复述，需要时用链接。
- **CLAUDE.md 永远不直接编辑**——它只有一行 `@AGENTS.md`（Claude Code 的 import 语法，加载时内联），改内容一律改 AGENTS.md。
- 什么改动触发更新哪里：加/删/改**源文件或其职责** → 文件地图；引入**新的构建/验证方式** → 验证手段一节（附可直接复制的命令）；调试中**踩到并解决了非显然的问题** → 坑清单加一条（格式：一句话结论加粗 + 一两句为什么，能复现的写触发条件；修上游或依赖升级后失效的条目要删除，过期的坑比没有坑更糟）；**用户可见行为变化**（菜单、窗口、安装流程、发版方式）→ README 对应小节。
- 坑清单只收"下次会再踩"的：一次性的环境故障、已被代码防御住且有注释的，不收。判断标准是"这条如果当初就在，能省多少排查时间"。
- 文档写完跑一遍自检：README 里的命令逐条可复制执行；AGENTS.md 验证一节的命令在干净 checkout 上真实跑通（这本身就是无头环境能做的验证）。

## 风格约束

主进程是无构建步骤的平凡 CJS，唯二依赖 electron 和 electron-builder（devDependencies），保持这样——不引入打包器、框架或运行时依赖。凡是能写成纯函数的逻辑放 `runtime.js` 这类无 Electron 依赖的模块。用户可见文案用中文。发版：改 `package.json` 的 `version` → 推 `v*` 标签；锁定内核版本用 stage 步骤的 `DSH_VERSION` 环境变量。
