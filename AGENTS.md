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
plugins.html        配置中心窗口（左侧导航三页：插件 / MCP 服务器 / 技能；MCP 为主从
                    布局，表单仅暴露 streamable-http——validateMcpServer 与 buildMcpBlock
                    仍接受 stdio 以兼容旧存量条目）
preload-plugins.js  配置中心的 contextBridge
splash.html         启动等待页
stage-dsh.mjs       构建期：npm 安装 dsh + plugins.json 预置插件到 staging/<platform>-<arch>/dsh，
                    裁剪，安装 pnpm 到 dsh/tools/，把预置插件注册进 dsh 应用依赖清单
afterPack.js        electron-builder 钩子：把 staging 运行时拷进应用 resources/dsh
desktop-patch.yml   随包分发的插件组合覆盖层（默认空）
plugins.json        要预置进安装包的插件 npm 包列表（默认空 = minimal flavor）
plugins-full.json   full flavor 的预置清单（dsh-web-ui 精选：任务看板/Git 图谱/
                    右侧面板/宠物/皮肤中心+十款皮肤/SSH）；stage 按 DSH_FLAVOR 选清单并把各包
                    精确版本写进运行时的 preset-plugins.json，main.js 启动时据此
                    做一次性 profile 播种
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
- **预置插件"注册进内置 dsh 依赖"只解决可解析，激活是另一回事**。注册（stage-dsh.mjs 已做）让 dsh 启动时按"应用依赖闭包"把包软链到 `~/.dsh/profiles/node_modules`；但 bundle 的激活以 profile 清单为准——必须出现在 `~/.dsh/profiles/web/package.json` 的 dependencies + `dsh.profile.bundles` 里（main.js 的 seedPresetPlugins 按运行时 preset-plugins.json 做一次性播种，userData 的 seeded-presets.json 标记防止把用户删掉的包塞回去）。播种是可逆的且每个 flavor 都要跑：full→minimal 覆盖安装后，profile 里的预置 bundle 对新运行时不可解析，dsh 直接拒绝启动（"cannot resolve profile bundle"）——seedPresetPlugins 每次启动把"自己播过、现已不可解析"的条目撤出 profile 并清标记（换回 full 会重新播种）；只在包对当前运行时可解析时才播种。应用内内核升级后的运行时也要带上预置包并重新注册，否则播种过的 profile 解析不到（installCoreRuntime 已做）。
- **profile 自己 node_modules 里的残缺包会遮蔽闭包软链并炸掉启动**。`dsh plugin remove` 的残留目录可能保留 package.json/LICENSE 但丢失代码，Node 解析优先命中它，报 "Cannot find package …"，整个 dsh 起不来。判断"包是否完好"要分场景：作为加载器条目 import 需要 JS 入口文件存在（pkgUsableAt）；作为 bundle/依赖只需清单及其声明的产物齐全——元 bundle 包（如 dsh-skins）没有 main 是正常的，用入口文件标准会误判（pkgIntactAt）。seedPresetPlugins 每次启动对预置包做残缺清理。
- **加载器持久化的条目也会引用已消失的包并炸掉启动**。皮肤中心等功能在运行时把选中的包 pnpm 装进 profile 并把条目写进 `~/.dsh/profiles/web/cordis.yml`；换 flavor 或本地安装损坏后该包解析不到，dsh 报 ERR_MODULE_NOT_FOUND 拒绝启动。不能安全地改用户配置——healUnresolvableEntries 的做法是给解析不到的条目在 profile node_modules 放一个无操作占位包（带 `.dsh-desktop-stub` 标记），当前运行时能提供真包时占位自动退位（按标记扫描，不依赖配置引用——dsh 会规范化重写 cordis.yml 丢弃条目，孤儿占位必须靠标记找到），真实重装会直接覆盖它。**主动扫描注定不完备**（dsh 持久化条目的位置/格式不可枚举，flow 风格 YAML 就躲得过正则），所以另有反应式兜底 applyBootErrorFix：启动失败时按报错文本识别 Cannot find package / cannot resolve profile bundle，做占位/软链/撤 bundle 后自动重试（最多 6 次，加载器一次只报一处）。还有一类冲突：**预置 bundle 的 insert id 与用户旧配置里的条目重复**（如用户曾用皮肤中心装过某皮肤，后来该皮肤成了预置），报 duplicate loader entry id——处理是撤我方 bundle 但保留播种标记（永不再播），用户自己的条目借运行时闭包里携带的包继续生效。报错信息才是权威来源。
- **electron-builder 的 extraResources 默认排除 node_modules**，运行时必须走 afterPack 钩子复制，别改回 extraResources。
- **本仓库若被放进 pnpm workspace（如上游 fork 的子目录）**，electron-builder 会向上探测 workspace 根并错误改用 pnpm 收集依赖——必须把本目录拷到仓库外构建（独立仓库布局无此问题）。
- **CLI 启动器是 dsh / pnpm / node 三件套**，缺一不可：pnpm 生命周期脚本会裸调 `node`，用户机器上没有 Node.js。pnpm 本体只随**内置**运行时分发（`dsh/tools/`），应用内升级的运行时没有 tools 目录，取 pnpm 路径必须锚定 `bundledDshDir()`。
- **pnpm 两道门禁**：allowBuilds（构建脚本审批——配置中心**有意不代为放行**，这是安全边界，只提示走命令行）；minimumReleaseAge（新发布版本冷却期——裸装包名可能**静默降级**到远古版本，表现为"装上了但没效果"，显式带版本号可豁免）。
- **MCP 的 GUI 配置写入 `~/.dsh/profiles/web/cordis.patch.yml` 的标记托管区块**（`# >>> dsh-desktop mcp >>>`），因为该文件被 dsh 热加载、dsh-mcp-client 支持配置热替换——保存即生效不用重启。只改标记区块、保留用户手写条目；文件默认内容是 flow 空列表 `[]`，与块列表条目不能共存，upsertManagedBlock 已处理（含单测）。已知余波：移除条目时经 `pnpm dlx` 包装启动的旧 MCP 服务器进程可能残留到应用退出。
- **Windows 覆盖安装靠 build/installer.nsh 的 customCheckAppRunning**。默认 NSIS 关闭逻辑在 PowerShell 不可用时只按进程名杀主程序，漏掉安装目录里 dsh 拉起的 conpty 代理（OpenConsole.exe / winpty-agent.exe），文件被锁导致 "app cannot be closed"。自定义宏用 `taskkill /F /T` 树杀 + 路径扫尾。注意：定义了 customCheckAppRunning 后模板会跳过自带的 `Var pid` 与 getProcessInfo include，必须自备（编译期 warning 即失败，本地 `electron-builder --win` 能在 Linux 上验证 NSIS 编译）。
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
