# DeepSeek Harness Desktop

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）的非官方桌面安装包，提供 Windows exe 与 macOS dmg。仓库只含 Electron 壳与 CI 配置，构建时安装 npm 发布版 `@deepseek-ai/dsh`。

应用用内置 Node 在本机随机端口启动 `dsh web`，窗口加载 Web UI，关窗即停服务。数据与配置在用户目录 `.dsh`，与命令行版通用。

## 安装包

每个平台一个安装包，只含官方 dsh（当前 0.1.7 线）。插件在 dsh 界面左栏的「插件」页安装：输入包名、GitHub 地址或本地目录，或点「添加插件」对话框里的安装源切换镜像。

安装包未签名：Windows 有 SmartScreen 提示；macOS 需 `xattr -cr "/Applications/DeepSeek Harness.app"` 或右键打开。

从带 `-full` 后缀的旧版本升级：旧版预置的三个插件（任务看板、SSH、dsh-better-sidebar）不再随包分发，首次启动时从配置中移除；需要的话按下表重新安装。

## 推荐插件

| 包名 | 用途 |
|---|---|
| `@onenightcarnival/dsh-toolkit` | [dsh-toolkit](https://github.com/Onenightcarnival/dsh-toolkit)：关系数据库工作台、S3 对象存储浏览器、OpenTelemetry 上报、浏览器桥（配 Chrome 扩展） |
| `@linxin666/dsh-client-ui-task-board` | 任务看板：看板列、cron 定时、每次运行新开会话、子任务级联 |
| `@linxin666/dsh-ssh` | SSH 运维：多主机管理、Web 终端、SFTP、端口转发、`ssh_*` 工具 |
| `dsh-better-sidebar` | 侧边栏工作台：可编辑的代码编辑器、Git 面板、实时 diff、侧边对话 |

插件版本线与内核一致（0.1.7 线装标 `>=0.1.7` 的版本）；内核升级后在插件页重装或更新。

## 更新

菜单「帮助」两项，启动时不自动检查：

- **检查应用更新…**：查询 GitHub Release（`package.json` 的 `updateRepo`）。Windows 可选「后台下载」，完成后提示「立即重启」，重启即完成安装；选「稍后」则在下次退出应用时安装。更新整包下载。元数据是 Release 里的 `latest.yml`。macOS 版未签名，跳转下载页。
- **检查内核更新…**：查询 npm 上的 `@deepseek-ai/dsh`，一键升级到用户数据目录的 `runtimes/<版本>/`，重启生效；升级失败自动回退到内置版本。只在同一版本线内升级（如 0.1.7-rc.1 → rc.2），跨线需下载新安装包。「帮助」菜单第一项显示当前内核版本。

## 配置中心

菜单「插件 → 配置中心…」，五页（插件的安装、移除在 dsh 界面的「插件」页）：

- **MCP 服务器**：列表加详情。远程服务（streamable-http：地址与请求头）或本机命令（stdio：命令、参数、环境变量、工作目录）。`npx` 走内置 pnpm 的 `pnpm dlx`，`uvx` 走随包分发的 uv，首次运行下载依赖或 Python 解释器到应用数据目录；国内网络在环境变量里设 `UV_PYTHON_INSTALL_MIRROR`。「测试连接」完成 MCP 握手并显示工具数。配置写入用户配置层的托管区块，保存即生效。
- **技能**：安装 zip 技能包（单技能或多技能合集）。列表按 SKILL.md 的 frontmatter 展示名称、版本、描述与调用面，每项有启用开关和删除。点名称进详情：全部 frontmatter 字段、源文件树、只读预览（文本限 256 KB）、打开目录。关闭的技能移到应用数据目录的 `disabled-skills/`（不在 `~/.dsh` 内），再打开即移回。安装、删除、开关即时生效。
- **内置插件**：dsh 内置插件的常用配置项，按插件分卡片：goal 目标模式的轮数上限、上下文自动压缩开关与触发阈值。保存即生效，留空恢复默认。其他配置项编辑 `~/.dsh/profiles/web/cordis.patch.yml`。
- **通用**：桌面程序自身的五个开关，默认全部关闭，切换即生效：
  - 开机自动启动（系统登录项）。
  - 启动时最小化到托盘。
  - 显示托盘图标。托盘菜单：打开主窗口、配置中心、退出；macOS 为菜单栏图标。
  - 关闭时最小化到托盘。关闭主窗口只隐藏窗口，dsh 服务与运行中的任务继续；托盘菜单或应用菜单的「退出」才停止服务；双击应用图标或托盘图标重新打开窗口。
  - 运行任务时保持系统唤醒。有 agent 在运行、有排队输入或有作业在执行期间阻止系统休眠。

  Windows / Linux 上「启动时 / 关闭时最小化到托盘」需同时开启托盘图标，否则关闭即退出。
- **代理**：不使用代理 / 使用系统代理 / 手动配置。三种模式都由应用控制，子进程继承的 `HTTP_PROXY` 等变量先被清除。系统代理按目标地址逐个读取系统设置，支持 PAC 与例外列表。手动配置支持主机名、端口、例外列表（`corp.com`、`*.corp.com`、`10.*`、`<local>`）、身份验证（密码可选记住）、TLS 选项（系统证书库、导入 CA、不校验证书）。对 dsh 服务的全部网络请求生效，本机地址始终直连。「测试连通」显示目标地址走直连还是哪台代理。保存后自动重启 dsh 服务。

菜单「插件」另有一项：

- **打开命令行窗口**：打开终端（Windows 为 cmd，macOS 为 Terminal），`dsh`、`pnpm`、`node`、`npx`、`uvx`、`uv` 已在 PATH 上，运行在应用内置的 Node 上。长期使用可把用户数据目录下的 `bin/` 加进 PATH。命令行同样遵循配置中心的代理设置。

## 本地构建

```sh
node stage-dsh.mjs        # DSH_VERSION=x.y.z 锁定版本
npm install
npx electron-builder --win --x64    # Windows
npx electron-builder --mac --arm64  # macOS
```

产物在 `dist/`。开发调试：staging 后 `npm start`。Electron 钉在 `44.0.0`：dsh 0.1.7 的 `node-addon-require-builtin` 按 Electron 的 V8 指纹放行（43.0.0 / 44.0.0 / 45.0.0-alpha.6），补丁版本（如 43.4.0）启动即失败。

### 文件

- `main.js` — 主进程：dsh 服务的启动与守护、窗口与菜单、更新、配置中心、CLI 启动器。工作区目录选择通过 `--patch` 覆盖层换成壳自带的插件（`plugins/`），弹系统目录对话框。
- `splash.html` — 启动页。
- `stage-dsh.mjs` — 按 `locks/package-lock.json` 把 `@deepseek-ai/dsh` 安装进 `staging/<platform>-<arch>/dsh` 并裁剪，再放入内置 pnpm（11 线）与 uv（钉版、sha256 校验）。
- `afterPack.js` — electron-builder 钩子，把 staging 运行时拷进应用 resources。
- `build/` — 图标与 NSIS 安装脚本。

### 插件组合覆盖层

`desktop-patch.yml`：随包分发的插件组合覆盖层，启动时经 `dsh web --patch` 生效：禁用内置插件（条目 id 用 `npx @deepseek-ai/dsh web --dump-config` 查）、覆盖插件配置、挂载壳自带的 `plugins/` 插件，语法见文件内注释。用户侧的 `~/.dsh/profiles/web/cordis.patch.yml` 语法相同，在其后应用。

## 发版

推送标签即触发 `.github/workflows/release.yml`：

```sh
git tag v0.1.0
git push origin v0.1.0
```

- Windows 与 macOS runner 各自原生构建，产物与 SHA256SUMS.txt 一起发布到 GitHub Release。版本号以标签为准，CI 把 `vX.Y.Z` 写入 `package.json` 后构建。
- 内置 dsh 版本以 `locks/package-lock.json` 为准，构建用 `npm ci` 从锁安装。升级内置 dsh：`DSH_VERSION=<版本> node stage-dsh.mjs --update-locks` 重新解析并写回锁，跑一遍 staging 后提交打标签。

## 协议

上游为 MIT 协议；本仓库同样以 MIT 发布，应用图标改自上游 favicon。

参与开发请先读 [AGENTS.md](AGENTS.md)。
