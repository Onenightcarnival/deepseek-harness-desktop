# DeepSeek Harness Desktop

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）的非官方桌面安装包，提供 Windows exe 与 macOS dmg。仓库只包含 Electron 壳与 CI 配置；构建时安装 npm 发布版 `@deepseek-ai/dsh`。

应用用内置 Node 在本机随机端口启动 `dsh web`，窗口加载 Web UI，关窗即停服务。数据与配置位于用户目录 `.dsh`，与命令行版通用。

## 文件

- `main.js` — 主进程：启动与守护 dsh 服务、窗口与菜单、更新检查、配置中心、CLI 启动器。Windows 上通过 `--patch` 覆盖层把目录选择器固定为 browse 组合。
- `splash.html` — 启动页。
- `stage-dsh.mjs` — 把 `@deepseek-ai/dsh` 安装进 `staging/<platform>-<arch>/dsh` 并裁剪，再放入内置 pnpm（11 线）与 uv（钉版、sha256 校验）。
- `afterPack.js` — electron-builder 钩子，把 staging 运行时拷进应用 resources。
- `build/` — 图标与 NSIS 安装脚本。

## 本地构建

```sh
node stage-dsh.mjs        # DSH_VERSION=x.y.z 锁定版本
npm install
npx electron-builder --win --x64    # Windows
npx electron-builder --mac --arm64  # macOS
```

产物在 `dist/`。开发调试：staging 后 `npm start`。

## 发版

推送标签即触发 `.github/workflows/release.yml`：

```sh
git tag v0.1.0
git push origin v0.1.0
```

Windows 与 macOS runner 各自原生构建，产物与 SHA256SUMS.txt 一起发布到 GitHub Release。版本号以标签为准，CI 把 `vX.Y.Z` 写入 `package.json` 后构建。

内置 dsh 版本以 `locks/` 下的锁文件为准，构建用 `npm ci` 从锁安装。升级内置 dsh：`node update-locks.mjs <dsh版本> ["插件@版本"...]` 重新生成锁，跑一遍 staging 后提交打标签。改动预置插件清单同样需要重新生成锁。

每个平台两种安装包：常规版只含官方 dsh；文件名带 `-full` 的版本预置三个插件——任务看板、SSH 远程连接（[dsh-web](https://github.com/zhu1090093659/dsh-web)）与 [dsh-better-sidebar](https://www.npmjs.com/package/dsh-better-sidebar) 工作台（文件管理、编辑预览、内嵌浏览器、终端、Git 面板、后台任务）。SSH 插件带一个桌面版补丁：终端会话在切换面板或会话后保持连接。预置插件每次启动同步进用户配置层，在配置中心移除后下次启动会恢复；不需要预置请使用常规版。两种版本共享 `~/.dsh` 数据，可互相覆盖安装。

## 预置与增删插件

`desktop-patch.yml` 是随包分发的插件组合覆盖层，应用启动时经 `dsh web --patch` 生效：禁用内置插件（条目 id 用 `npx @deepseek-ai/dsh web --dump-config` 查）、覆盖插件配置、挂载新插件，语法见文件内注释。用户侧的 `~/.dsh/profiles/web/cordis.patch.yml` 语法相同，在其后应用。

`plugins.json` / `plugins-<flavor>.json` 是预置进安装包的插件清单，例如 `{"packages": ["some-dsh-plugin@1.2.0"]}`；stage 脚本按 `DSH_FLAVOR` 选清单（默认 `plugins.json`，`DSH_FLAVOR=full` 读 `plugins-full.json`）。声明了 `dsh.bundle` 的插件包写入清单即可；不带 bundle 的插件在 `desktop-patch.yml` 里 insert 挂载条目，带界面的插件需把 host 与 client-ui 两半都挂上。

插件版本需与内置 dsh 版本匹配。不重新打包时，用户也可以编辑 `~/.dsh/profiles/web/cordis.patch.yml`，或用 `dsh plugin` 命令安装。

## 更新

- **应用更新**：启动后检查 GitHub Release（`package.json` 的 `updateRepo`），有新版时提示下载；菜单「帮助 → 检查应用更新…」手动检查。
- **内核更新**：启动后检查 npm 上的 `@deepseek-ai/dsh`，可一键升级到用户数据目录的 `runtimes/<版本>/`，重启生效；升级失败自动回退到内置版本。只在同一版本线内升级（如 0.1.2-rc.1 → rc.2），跨线需下载新安装包。菜单「帮助 → 检查内核更新…」手动检查，「帮助」菜单第一项显示当前内核版本。

## 配置中心与命令行

菜单「插件 → 配置中心…」分五页：

- **插件**：按 npm 包名或来源安装、移除；「从目录安装」以软链方式装开发中的插件，「从 .tgz 安装」装 `npm pack` 打出的包。
- **MCP 服务器**：列表加详情。远程服务（streamable-http：地址与请求头）或本机命令（stdio：命令、参数、环境变量、工作目录）。`npx` 走内置 pnpm 的 `pnpm dlx`，`uvx` 走随包分发的 uv，首次运行下载依赖或 Python 解释器到应用数据目录；国内网络可在环境变量里设 `UV_PYTHON_INSTALL_MIRROR`。「测试连接」完成 MCP 握手并显示工具数。配置写入用户配置层的托管区块，保存即生效。
- **技能**：安装 zip 技能包（单技能或多技能合集）。列表按 SKILL.md 的 frontmatter 展示名称、版本、描述与调用面；每项有启用开关和删除。点名称进详情：全部 frontmatter 字段、源文件树、只读预览（文本限 256 KB）、打开目录。关闭的技能移入 `~/.dsh/skills/.disabled/`，再打开即移回。安装、删除、开关即时生效。
- **常用设置**：内置插件的常用配置项，按插件分卡片：goal 目标模式的轮数上限、上下文自动压缩开关与触发阈值。保存即生效，留空恢复默认。其他配置项可编辑 `~/.dsh/profiles/web/cordis.patch.yml`。
- **代理**：不使用代理 / 使用系统代理 / 手动配置。三种模式都由应用控制，子进程继承的 `HTTP_PROXY` 等变量先被清除。系统代理按目标地址逐个读取系统设置，支持 PAC 与例外列表。手动配置支持主机名、端口、例外列表（`corp.com`、`*.corp.com`、`10.*`、`<local>`）、身份验证（密码可选记住）、TLS 选项（系统证书库、导入 CA、不校验证书）。对 dsh 服务的全部网络请求生效；本机地址始终直连。「测试连通」显示目标地址走直连还是哪台代理。保存后自动重启 dsh 服务。

菜单「插件 → 重新同步预置插件…」清除本版本的冲突排除记录并重启，强制恢复全部预置插件。

菜单「插件 → 打开命令行窗口」打开终端（Windows 为 cmd，macOS 为 Terminal），`dsh`、`pnpm`、`node`、`npx`、`uvx`、`uv` 已在 PATH 上，运行在应用内置的 Node 上。长期使用可把用户数据目录下的 `bin/` 加进 PATH。命令行同样遵循配置中心的代理设置。需要执行构建脚本的插件不在图形界面放行，按 dsh 提示在命令行窗口处理。

## 说明

- 安装包未签名：Windows 有 SmartScreen 提示；macOS 需 `xattr -cr "/Applications/DeepSeek Harness.app"` 或右键打开。
- 升级 Electron 时需满足 dsh 的 engines 要求（当前 `^22.19.0 || >=24.0.0`；Electron 43 内置 Node 24）。
- 上游为 MIT 协议；本仓库同样以 MIT 发布，应用图标改自上游 favicon。

参与开发请先读 [AGENTS.md](AGENTS.md)。
