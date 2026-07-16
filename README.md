<div align="center">

# bini-native

**Automatic Tauri native wiring for Bini.js.**
Import one Vite plugin. Never touch `src-tauri/` by hand again.

[![npm version](https://img.shields.io/npm/v/bini-native.svg?color=cb3837&logo=npm)](https://www.npmjs.com/package/bini-native)
[![npm downloads](https://img.shields.io/npm/dm/bini-native.svg?color=cb3837&logo=npm)](https://www.npmjs.com/package/bini-native)
[![license](https://img.shields.io/npm/l/bini-native.svg?color=blue)](./LICENSE)
[![vite](https://img.shields.io/badge/vite-%5E8.0.0-646CFF?logo=vite)](https://vitejs.dev)
[![tauri](https://img.shields.io/badge/tauri-v2-FFC131?logo=tauri)](https://v2.tauri.app)
[![types](https://img.shields.io/badge/types-included-3178C6?logo=typescript)](#)

</div>

---

## What it does

`bini-native` watches your frontend source, works out which native capabilities your app actually uses, and wires up the Tauri side automatically — Rust plugin registration, `Cargo.toml` dependencies, capability permissions, Android manifest entries, and iOS/macOS `Info.plist` usage descriptions. You import a Vite plugin once. That's the entire setup.

No CLI commands to memorize. No manual `src-tauri/src/lib.rs` edits. No forgetting a permission and getting a silent, unexplained failure. Complexity stays invisible; you write normal web APIs (`navigator.geolocation`, `new Notification(...)`, `navigator.clipboard.writeText(...)`) and they work identically in the browser and inside the native shell.

## Installation

```bash
pnpm add -D bini-native
# or
npm install -D bini-native
# or
yarn add -D bini-native
```

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { biniNative } from 'bini-native';

export default defineConfig({
  plugins: [react(), biniNative()],
});
```

That's it. Run `tauri dev` or `tauri build` as usual.

## How it works

`bini-native` runs in two passes, both timed to happen **before** cargo ever touches your Rust code — so there's no race between the plugin and the Tauri CLI:

| Mode | When wiring runs | Why it's safe |
|---|---|---|
| `tauri dev` | Before the Vite dev server's port opens | Tauri's CLI waits for that port before starting `cargo build`, so wiring always finishes first |
| `tauri build` | At Vite's `buildStart` | `tauri build` runs `vite build` to completion before invoking cargo at all |

There's no "always wired regardless of use" tier. Every plugin — including the everyday ones like dialog and clipboard — is wired only if your source actually uses it, via a combined regex + AST import scan:

- `showOpenFilePicker(...)` / `showSaveFilePicker(...)` → dialog plugin (which pulls in the filesystem plugin automatically — see below)
- `navigator.clipboard.writeText` / `readText` → clipboard plugin
- `new Notification(...)` → notification plugin
- `navigator.geolocation.*` → geolocation plugin + Android/iOS/macOS location permissions
- `registerGlobalShortcut(...)` → global-shortcut plugin (desktop-only, see [Platform notes](#platform-notes))
- `setAutoStart(...)` → autostart plugin (desktop-only, see [Platform notes](#platform-notes))
- `window.biniStore.*` → persistent key-value store plugin
- `getUserMedia({ video: true })` / `{ audio: true }` → camera/microphone platform permissions (no plugin needed — Tauri's webview supports these natively)
- Any direct `import ... from '@tauri-apps/plugin-*'` → that plugin, even without a matching Web API call

**One dependency link exists on purpose:** the dialog polyfill's synthetic file handle (`getFile()`, `createWritable()`) dynamically imports the filesystem plugin internally, even though your own code never touches it directly. So a project that only calls `showOpenFilePicker()` still gets the filesystem plugin wired — otherwise the picker would compile fine and then fail at runtime the first time someone tries to read the picked file.

One thing stays unconditional regardless of what's detected: Tauri's core capability (`core:default` — window operations, events, app metadata) is always ensured in `capabilities/default.json`, even on a project with zero plugin usage, since it's foundational to any Tauri app rather than tied to a specific plugin.

If you add a new API mid-session, `bini-native` detects it and prints a one-line notice to restart `tauri dev` — it deliberately does **not** rewrite `src-tauri/` files while cargo might be running, to avoid write races.

## Supported plugins

| Feature | Web API you write | Rust crate | Platform |
|---|---|---|---|
| Opener | `@tauri-apps/plugin-opener` | `tauri-plugin-opener` | All |
| Dialog | `showOpenFilePicker` / `showSaveFilePicker` polyfill | `tauri-plugin-dialog` | All *(auto-pulls in Filesystem)* |
| Filesystem | `@tauri-apps/plugin-fs` | `tauri-plugin-fs` | All |
| Clipboard | `navigator.clipboard.writeText` / `readText` | `tauri-plugin-clipboard-manager` | All |
| Notifications | `new Notification(...)` | `tauri-plugin-notification` | All |
| OS info | `@tauri-apps/plugin-os` | `tauri-plugin-os` | All |
| Geolocation | `navigator.geolocation.*` | `tauri-plugin-geolocation` | Android, iOS, macOS *(wired if detected, but the permission always fails on Windows/Linux — see [Platform notes](#platform-notes))* |
| Global shortcut | `registerGlobalShortcut(...)` | `tauri-plugin-global-shortcut` | **Desktop only** |
| Autostart | `setAutoStart(...)` | `tauri-plugin-autostart` | **Desktop only** |
| Persistent store | `window.biniStore.*` | `tauri-plugin-store` | All |
| Camera / microphone | `getUserMedia(...)` | *(none — native webview support)* | All |
| Bluetooth | `navigator.bluetooth` | *(no first-party plugin exists)* | Unsupported — logged, not wired |

"Desktop only" plugins are handled specially, not just wired the same way as everything else: their Cargo dependency is placed under a target-conditional section (`[target."cfg(not(any(target_os = "android", target_os = "ios")))".dependencies]`) rather than plain `[dependencies]`, and their registration is wrapped in `#[cfg(desktop)]` inside `.setup()` rather than chained onto the builder. Their Rust crates genuinely don't expose the relevant APIs when compiled for Android/iOS — chaining them the normal way would fail to compile on mobile builds.

## Platform notes

A couple of things are Tauri/OS limitations, not bugs in this plugin:

- **Notifications on Windows dev builds** — unpackaged `tauri dev` builds have no Start Menu shortcut / AUMID, so Windows silently denies the permission with no prompt at all. Run `tauri build` and install the result to test notifications properly.
- **Geolocation on Windows/Linux desktop** — Tauri's official geolocation plugin only supports Android, iOS, and macOS. It's still wired automatically if your source uses it (since the same code path may also target mobile), but the permission request will always fail on Windows/Linux desktop.
- **Autostart and global shortcuts don't exist on mobile** — these two plugins are Tauri desktop-only by design (there's no "launch at startup" or "global keyboard shortcut" concept on Android/iOS). If your source uses them, they're still wired, but only inside a `#[cfg(desktop)]` block and a target-conditional Cargo dependency — so an Android or iOS build compiles cleanly and simply doesn't include that code, rather than failing to compile.

## Requirements

- A Tauri v2 project (`src-tauri/` present) — on projects without one, `bini-native` no-ops entirely, so it's safe to include in web-only builds too
- A `src/main.tsx` / `main.jsx` / `main.ts` / `main.js` entry file, where runtime polyfills get injected
- Vite 8

## FAQ

**Does this touch my code every time I save?**
No. File watching only triggers a cheap, read-only feature-detection scan (debounced) that logs a restart notice if something new shows up — it never rewrites `src-tauri/` mid-session.

**What if I've already hand-edited `lib.rs`?**
`bini-native` checks the actual registered `.plugin(...)` call for each crate. If it's already correct, it's left untouched. If it's missing, it's inserted. If it's present but wrong — wrong call form, or a desktop-only plugin chained where it shouldn't be — it's corrected in place rather than left broken.

**Does "detected" mean I have to call the Web API directly?**
No — a direct `import` from the plugin's npm package counts too, not just the polyfilled Web API. So `import { readFile } from '@tauri-apps/plugin-fs'` wires the filesystem plugin even without touching a browser API at all.

**Can I use this without Bini.js?**
Yes — it's a plain Vite plugin with no Bini.js-specific dependency. It expects a conventional Vite + Tauri project layout, nothing more.

## Contributing

Issues and PRs welcome. Please include your OS, Tauri version, and (if relevant) the exact web API call that didn't get detected or wired correctly.

## License

MIT © [Bini](https://github.com/rbini)