# DeepSeek Harness Desktop

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的非官方桌面安装包，支持 Windows 与 macOS。当前内置内核：`0.2.0-rc.2`。

应用在本机随机端口运行 dsh Web UI。数据与配置位于 `~/.dsh`，与命令行版共享。默认关窗退出；开启托盘模式后，关窗保留服务与任务。

## 安装包

| 版本 | 内容 |
|---|---|
| 常规版 | 官方 dsh 与桌面壳 |
| full 版（文件名含 `-full`） | 常规版 + 任务看板、SSH、better-sidebar |

任务看板与 SSH 来自 [dsh-web](https://github.com/zhu1090093659/dsh-web)。SSH 支持终端会话分离与重连。[better-sidebar](https://www.npmjs.com/package/dsh-better-sidebar) 提供文件管理、编辑预览、内嵌浏览器、终端、Git 与后台任务。

两种版本共享数据，可互相覆盖安装。full 预置插件每次启动同步，手动移除后会恢复；常规版不启用这些预置。

| 平台 | 安装说明 |
|---|---|
| Windows | 未签名，可能显示 SmartScreen 提示；支持长路径与复制重试，错误日志为 `%TEMP%\\dsh-install-copy.log` |
| macOS | 未签名，使用右键打开或 `xattr -cr "/Applications/DeepSeek Harness.app"` |

Windows 桌面程序默认请求管理员权限，由系统 UAC 确认。内核和本地工具继承启动权限。

## 窗口与菜单

主窗口与配置中心使用一体化标题栏，并同步深浅主题；启动前跟随系统主题。菜单和配置窗口跟随主界面的中英文选择，首次启动使用系统语言。

| 平台 | 标题栏与入口 |
|---|---|
| Windows | 原生窗口按钮；「应用 / 编辑」菜单；配置中心位于「应用 → 配置中心…」（Ctrl+,） |
| macOS | 原生红黄绿按钮、系统菜单；顶部拖拽区与侧栏同色；「插件 → 配置中心…」 |
| Linux 开发环境 | 「插件 → 配置中心…」 |

## 启动

启动页显示应用标识与等待状态。

## 更新

更新由「帮助」菜单手动触发，第一项显示当前内核版本。

| 操作 | 来源 | 生效方式 |
|---|---|---|
| 检查应用更新 | GitHub Release | Windows 后台下载整包，立即重启或下次退出时安装；macOS 打开下载页 |
| 检查内核更新 | npm `@deepseek-ai/dsh` | 安装到用户数据目录 `runtimes/<版本>/`，重启生效；失败回退内置版本 |

内核仅支持同一版本线内升级，例如 `0.2.0-rc.1 → 0.2.0-rc.2`。跨版本线使用新安装包。

## 配置中心

| 页面 | 功能 |
|---|---|
| 插件 | 按 npm 包名、Git 来源、本地目录或 .tgz 安装；移除插件；重启生效 |
| 通用 | 启动、托盘与系统唤醒设置 |
| 代理 | 无代理、系统代理或手动代理；测试连接与 TLS 配置 |

目录安装采用软链。构建脚本审批在「插件 → 打开命令行窗口」中完成。

插件操作结果直接显示，命令输出位于可展开的「诊断详情」。

技能管理由 toolkit 配置中心插件提供，入口为主侧栏「技能」。桌面壳向插件传递旧停用目录，原有技能继续可用。

### 通用

所有选项默认关闭，切换即时生效。

| 选项 | 行为 |
|---|---|
| 开机自动启动 | 注册系统登录项 |
| 显示托盘图标 | 提供主窗口、配置中心与退出入口；macOS 显示菜单栏图标 |
| 启动时最小化到托盘 | 隐藏启动窗口 |
| 关闭时最小化到托盘 | 保留服务与任务；通过菜单退出，双击应用或托盘图标恢复窗口 |
| 运行任务时保持系统唤醒 | Agent 运行、输入排队或作业执行期间阻止系统休眠 |

Windows / Linux 的隐藏窗口选项依赖托盘图标。

### 代理

系统代理按目标地址读取 PAC 与例外列表。手动代理支持主机、端口、认证和例外列表（`corp.com`、`*.corp.com`、`10.*`、`<local>`）。

TLS 选项包含系统证书库、自定义 CA 和关闭证书校验。密码可选择记住，勾选后以明文保存在本机。模型、插件安装、内核升级与 MCP 共用代理，本机地址直连。保存后重启服务。

### 插件菜单

| 操作 | 行为 |
|---|---|
| 重新同步预置插件 | 清除当前版本的冲突排除记录，重启并恢复预置 |
| 打开命令行窗口 | 打开终端，PATH 包含应用的 dsh / pnpm / node / npx；沿用代理设置 |

长期使用 CLI 可将用户数据目录的 `bin/` 加入 PATH。

### Python MCP 环境

安装 `@onenightcarnival/dsh-toolkit` 或 `@onenightcarnival/dsh-config-center` 后，在「设置 → 环境依赖」安装专属 uv 环境。桌面安装包不捆绑 uv/uvx。

安装完成后，当前 profile 中的裸 `uv` / `uvx` 命令转为专属路径；显式自定义路径保持不变。首次使用需联网下载 Python 与依赖。

## 本地构建

构建使用精确版本 Electron `44.0.0`，产物位于 `dist/`。

```sh
node stage-dsh.mjs
npm install
npx electron-builder --win --x64
npx electron-builder --mac --arm64
```

设置 `DSH_FLAVOR=full` 选择 full 清单。开发调试在 staging 后运行 `npm start`。架构、文件职责和验证入口见 [AGENTS.md](AGENTS.md)。

### 预置插件

| 文件 | 内容 |
|---|---|
| `plugins.json` / `plugins-<flavor>.json` | 预置包与版本；stage 按 DSH_FLAVOR 选择 |
| `desktop-patch.yml` | 禁用、覆盖或挂载组合条目；通过 `--patch` 在用户 profile 层之后应用 |
| `locks/` | 各 flavor 的完整安装锁 |

带 `dsh.bundle` 的包可直接登记到清单。其他插件通过 patch 的 insert 挂载；带界面的插件须成对挂载 host 与 client-ui。插件版本必须匹配内核版本线。

用户插件通过 `dsh plugin` 管理；用户覆盖层为 `~/.dsh/profiles/web/cordis.patch.yml`。

## 发版

1. 修改预置或内核后，运行 `node update-locks.mjs <dsh版本> ["插件@版本"...]` 更新锁。
2. 运行 staging 与相应验证，提交改动。
3. 推送与发布版本对应的 `vX.Y.Z` 标签。

`.github/workflows/release.yml` 在 Windows 与 macOS runner 原生构建。版本号取自标签，产物与 SHA256SUMS.txt 发布到 GitHub Release。应用更新元数据为常规版的 `latest.yml` 与 full 版的 `full.yml`。

## 协议

MIT。应用图标改自上游 favicon。
