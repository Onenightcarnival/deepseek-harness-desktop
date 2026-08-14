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
GitHub Release。版本号取 `package.json` 的 `version`，发版前记得更新。
升级内置的 dsh 只需等 npm 出新版后重新打标签（或用 `DSH_VERSION` 锁定）。

## 预置 / 增删插件

dsh 一切皆插件，桌面版留了两个定制入口，改完重新打标签出包即可：

**`desktop-patch.yml`** — 插件组合覆盖层，应用启动时经 `dsh web --patch` 生效。
禁用内置插件（条目 id 用 `npx @deepseek-ai/dsh web --dump-config` 查）、
覆盖插件配置、挂载新插件都在这里写，语法见文件内注释。用户侧的
`~/.dsh/profiles/web/cordis.patch.yml` 是同样的语法，改动在它之后应用，
所以用户仍能覆盖打包默认值。

**`plugins.json`** — 要额外内置进安装包的插件 npm 包列表，例如
`{"packages": ["some-dsh-plugin@1.2.0"]}`。stage 脚本会把它们装进运行时，
并注册进内置 dsh 的依赖清单（dsh 启动时按依赖闭包把包软链进
`~/.dsh/profiles/node_modules`，插件才能从 profile 解析到——只装进
运行时目录是不够的）。装完还要在 `desktop-patch.yml` 里 insert 对应条目
才会真正挂载；带界面的双面插件要把 host 和 client-ui 两半都挂上
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

## 插件管理与命令行

- 应用启动 15 秒后会静默检查一次 GitHub Release（`package.json` 的
  `updateRepo` 指定仓库），有新版会弹窗引导下载；菜单「帮助 → 检查更新…」
  可手动检查。发新版记得同时更新 `version` 和打对应的 `v*` 标签。
- 应用会在用户数据目录的 `bin/` 下生成 `dsh` 和 `pnpm` 命令
  （菜单「帮助 → 打开命令行工具目录」可直达），两者都跑在应用内置的
  Node 上，机器上无需安装 Node/pnpm。把该目录加进 PATH 后即可使用完整
  CLI，例如 `dsh plugin --profile web add <插件包>`——声明了 `dsh.bundle`
  的插件包装完自动进组合，重启应用即生效。

## 注意

- 安装包未签名：Windows 有 SmartScreen 提示；macOS 需
  `xattr -cr "/Applications/DeepSeek Harness.app"` 或右键打开。
  要消除提示需在 electron-builder 配置里接入证书
  （Windows 代码签名证书 / Apple Developer ID + 公证）。
- 升级 Electron 时注意其内置 Node 需满足 dsh 的 engines 要求
  （目前 `^22.19.0 || >=24.0.0`；Electron 43 内置 Node 24）。
- 上游为 MIT 协议；本仓库同样以 MIT 发布，应用图标改自上游 favicon。
