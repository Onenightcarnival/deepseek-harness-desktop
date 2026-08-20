# DeepSeek Harness Desktop（非官方打包）

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）的
桌面安装包：Windows exe 和 macOS dmg。本仓库只包含打包用的 Electron 壳和
CI 配置，不包含上游源码——构建时直接安装 npm 发布版 `@deepseek-ai/dsh`。

应用启动时用 Electron 内置 Node（加 `--expose-internals`）在本机
127.0.0.1 的随机端口拉起 `dsh web`，窗口加载 Web UI，关窗即停服务。
数据与配置在用户目录 `.dsh` 下，与命令行版通用。

## 文件说明

- `main.js` — Electron 主进程：拉起/守护 dsh 服务、解析就绪行、窗口与菜单、
  外链转系统浏览器、退出清理。Windows 上通过 `--patch` 覆盖层把目录选择器
  固定为 browse 组合（原生 Win32 弹窗的子进程在 Electron 打包环境下起不来）。
- `splash.html` — 启动等待页。
- `stage-dsh.mjs` — 把 `@deepseek-ai/dsh` 安装进 `staging/<platform>-<arch>/dsh`
  并裁剪（node-pty 只留本平台预编译、去掉 sharp wasm 回退、删 sourcemap/pdb）。
- `afterPack.js` — electron-builder 钩子，把 staging 的运行时拷进应用 resources。
  （不用 extraResources 是因为它默认排除 node_modules。）
- `build/` — 图标（由上游仓库的 favicon.svg 生成）。

## 本地构建

```sh
node stage-dsh.mjs        # 需要时用 DSH_VERSION=x.y.z 锁版本
npm install
npx electron-builder --win --x64    # Windows 上
npx electron-builder --mac --arm64  # macOS 上
```

产物在 `dist/`。开发调试：staging 后直接 `npm start`。

## CI 发版

推送标签即触发 `.github/workflows/release.yml`：

```sh
git tag v0.1.0
git push origin v0.1.0
```

Windows/macOS runner 各自原生构建，产物连同 SHA256SUMS.txt 发布到
GitHub Release。**版本号以标签为准**：CI 会把 `vX.Y.Z` 写进
`package.json` 再构建，发版只需打标签，无需手动改文件（仓库里的
`version` 字段仅作为手动触发构建时的默认值）。

**内置 dsh 的版本以 `locks/` 下的锁文件为准**（构建用 `npm ci` 从锁
安装：确定、快、跨平台一份锁通吃；实时解析 dsh 的依赖图在 npm 侧
偶发指数级回溯，CI 上直接 OOM）。升级内置 dsh：本地跑
`node stage-dsh.mjs --update-locks` 和
`DSH_FLAVOR=full node stage-dsh.mjs --update-locks`
重新生成两份锁，提交后打标签。改了预置插件清单同样要重新生成 full 锁。

每个平台出两种安装包（CI matrix 的 flavor 维度）：**常规版**只含官方
dsh；文件名带 **`-full`** 的版本额外预置
三个生产力插件：任务看板、SSH 远程连接
（[dsh-web-ui](https://github.com/zhu1090093659/dsh-web-ui)）与
[dsh-better-sidebar](https://www.npmjs.com/package/dsh-better-sidebar)
工作台（文件管理、编辑预览、内嵌浏览器、真实终端、Git 面板、
后台任务），
每次启动自动同步进用户配置层——预置插件视为版本自带能力，
在配置中心移除后下次启动会同步回来；不想要预置请使用常规版。
皮肤和宠物类插件暂不预置（上游尚不稳定），需要的用户可自行安装。两种版本共享 `~/.dsh`
数据，可互相覆盖安装切换：换到常规版时预置插件自动停用，换回
full 版自动恢复。

## 预置 / 增删插件

dsh 一切皆插件，桌面版留了两个定制入口，改完重新打标签出包即可：

**`desktop-patch.yml`** — 插件组合覆盖层，应用启动时经 `dsh web --patch` 生效。
禁用内置插件（条目 id 用 `npx @deepseek-ai/dsh web --dump-config` 查）、
覆盖插件配置、挂载新插件都在这里写，语法见文件内注释。用户侧的
`~/.dsh/profiles/web/cordis.patch.yml` 是同样的语法，改动在它之后应用，
所以用户仍能覆盖打包默认值。

**`plugins.json` / `plugins-<flavor>.json`** — 要预置进安装包的插件
npm 包列表，例如 `{"packages": ["some-dsh-plugin@1.2.0"]}`；stage 脚本
按 `DSH_FLAVOR` 环境变量选清单（默认 `plugins.json`，
`DSH_FLAVOR=full` 读 `plugins-full.json`，CI 两种都构建）。声明了
`dsh.bundle` 的插件包走这条路即可：stage 脚本把它装进运行时并注册进
内置 dsh 的依赖清单，应用首次启动把它写进用户 profile 的 bundles
自动挂载。不带 bundle 的散装插件才需要在 `desktop-patch.yml` 里
insert 挂载条目；带界面的双面插件要把 host 和 client-ui 两半都挂上
（参考 main.js 里目录选择器的写法）。

注意选与内置 dsh 版本匹配的插件版本：peer 依赖指向旧版 dsh 的插件包
会让 npm 安装极慢且运行时也不兼容。不重新打包的话，用户也可以自己编辑
`~/.dsh/profiles/web/cordis.patch.yml`，或用 `dsh plugin` 命令
（需要 pnpm）往自己的 profile 里装插件。

## 更新机制

- **应用更新**（Electron 壳 + 安装包）：启动后静默检查 GitHub Release
  （`package.json` 的 `updateRepo`），有新版弹窗引导下载安装包；
  菜单「帮助 → 检查应用更新…」可手动查。
- **内核更新**（dsh 本体）：启动后静默检查 npm 上的 `@deepseek-ai/dsh`，
  发现新版可一键"下载并升级"——用内置 pnpm 装到用户数据目录的
  `runtimes/<版本>/`，重启应用生效，无需重装应用；新内核启动失败会自动
  隔离并回退到内置版本。菜单「帮助 → 检查内核更新…」可手动查，
  「帮助」菜单第一项显示当前生效的内核版本。

## 配置中心与命令行

- 菜单「插件 → 配置中心…」左侧导航分四页：**插件**（按 npm 包名/来源
  安装、移除，装到用户配置层；也可安装本地插件——「从目录安装」以软链
  方式装开发中的插件，改代码后重启生效，插件自身依赖需先在其目录里
  `pnpm install`；「从 .tgz 安装」装 `npm pack` 打出的成品包）、**MCP 服务器**（左列表 + 右详情的
  主从布局：列表显示每台服务器与启用状态、测试结果指示灯，详情页
  编辑名称、地址、请求头，含启用开关与「测试连接」；目前仅支持
  streamable-http 一种传输方式。配置写入用户配置层的标记托管区块，
  保存即热生效无需重启，不碰用户手写条目）、**技能**（安装 zip 技能
  包——单技能或多技能合集均可，列表删除、打开目录，装删即时生效无需
  重启；目录固定为 dsh 约定的 `~/.dsh/skills`）、**常用设置**（内置
  插件的精选配置项，当前含 goal 目标模式的轮数上限
  defaultMaxGoalRounds（上游默认 256）；写入用户配置层的托管区块，
  保存即生效，留空保存恢复 dsh 默认。没收录的配置项仍可手动编辑
  `~/.dsh/profiles/web/cordis.patch.yml` 按条目 id 覆盖）、**代理**（PyCharm
  风格三种模式：不使用代理 / 使用系统代理 / 手动配置。三种模式都由
  应用自己说了算——子进程从操作系统继承来的 `HTTP_PROXY` 等变量会先
  被清掉，所以「不使用代理」是真的全程直连，不会被公司镜像预置的环境
  变量劫持；「使用系统代理」按目标地址逐个询问系统设置（支持 PAC 与
  例外列表），内网直连、外网走代理，与浏览器行为一致。手动配置填
  主机名与端口、不代理的主机列表（支持 `corp.com`、`*.corp.com`、`10.*`、
  `<local>`）、可选身份验证（用户名/密码，可选记住——不记住则密码仅
  保存在本次运行中）、TLS 选项（默认信任系统证书库；可导入代理的 CA
  证书；兜底的"不校验证书"开关，用于公司代理做 TLS 拦截的场景）。
  对 dsh 服务及其全部网络请求生效——模型 API、插件安装、内核升级、
  MCP 连接、命令行窗口里的 dsh/pnpm；本机地址始终直连。「测试连通」
  可自填测试地址（默认 npm registry），内网地址和外网地址各测一次就能
  确认两边同时可用，结果里会显示这个地址是直连还是走了哪台代理。保存后
  自动原地重启 dsh 服务即时生效（窗口短暂回到加载页），无需重启应用）。
- 菜单「插件 → 重新同步预置插件…」清除本版本的冲突排除记录并
  重启，强制把预置插件全部挂载回来（预置与用户旧配置条目撞 id 时
  会被自动排除到下个版本重试，这个入口用于立即重试）。
- 菜单「插件 → 打开命令行窗口」直接弹出一个终端（Windows 为 cmd，
  macOS 为 Terminal），其中 `dsh`、`pnpm`、`node` 已在 PATH 上、
  跑在应用内置的 Node 上，机器无需安装 Node/pnpm。想在自己的终端里
  长期使用，可把用户数据目录下的 `bin/` 加进 PATH。命令行同样遵循
  配置中心的代理设置——应用运行时走应用的代理决策，应用关闭后直连。需要执行构建脚本
  的插件（GitHub 源码分发、触发 pnpm allowBuilds 门禁）不在图形界面
  代为放行——按 dsh 报错提示在命令行窗口里自行处理，这是有意的安全
  边界。

## 注意

- 安装包未签名：Windows 有 SmartScreen 提示；macOS 需
  `xattr -cr "/Applications/DeepSeek Harness.app"` 或右键打开。
  要消除提示需在 electron-builder 配置里接入证书
  （Windows 代码签名证书 / Apple Developer ID + 公证）。
- 升级 Electron 时注意其内置 Node 需满足 dsh 的 engines 要求
  （目前 `^22.19.0 || >=24.0.0`；Electron 43 内置 Node 24）。
- 上游为 MIT 协议；本仓库同样以 MIT 发布，应用图标改自上游 favicon。

参与开发（人或 agent）请先读 [AGENTS.md](AGENTS.md)：架构、无头环境下的验证手段、踩坑清单都在那里。
