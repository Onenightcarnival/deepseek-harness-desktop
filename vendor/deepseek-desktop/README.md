# Official desktop browser sources

Source: [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness/tree/5badb15009ae1756c3afe0ae0cef1faafc290ccc/apps/desktop/src), commit `5badb15009ae1756c3afe0ae0cef1faafc290ccc`. License: [MIT](LICENSE).

| Source | Runtime responsibility |
|---|---|
| `browser-guests.ts` | Guest leases, workspace partitions, navigation and permission policy |
| `preload-browser.ts` | Lease-scoped browser IPC bridge |
| `keyboard.ts`, `keybindings.ts` | Native keyboard routing and device-local shortcut persistence |
| `preload-app.ts` | Browser, keyboard and shortcut preload API sections |
| `ipc.ts` | Browser and shortcut channel names |

`src/` contains unmodified upstream files. `node build/sync-official-browser.cjs` generates committed CommonJS files, channel names, and the marked region in `preload-desktop.js`. `--check` verifies generated output without writing. Generation requires Node.js 22.19 or newer and no additional dependencies.

Adaptations are confined to the generator and shell adapters:

- TypeScript becomes CommonJS; type-only imports are removed.
- IPC authentication uses the current owned main frame and local dsh origin.
- Keyboard snapshot publication uses the same origin check instead of `dsh-app://app/`.
- Keyboard protocol and atomic writes resolve from the active dsh runtime.
- The sandbox preload contains the browser, keyboard and shortcut API sections; other official product APIs are excluded.

Browser UI and navigation controllers come from the installed `@deepseek-ai/dsh-client-ui-sidebar-browser` package. User behavior is documented in the root [README](../../README.md#浏览器).
