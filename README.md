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

## 注意

- 安装包未签名：Windows 有 SmartScreen 提示；macOS 需
  `xattr -cr "/Applications/DeepSeek Harness.app"` 或右键打开。
  要消除提示需在 electron-builder 配置里接入证书
  （Windows 代码签名证书 / Apple Developer ID + 公证）。
- 升级 Electron 时注意其内置 Node 需满足 dsh 的 engines 要求
  （目前 `^22.19.0 || >=24.0.0`；Electron 43 内置 Node 24）。
- 上游为 MIT 协议；本仓库同样以 MIT 发布，应用图标改自上游 favicon。
