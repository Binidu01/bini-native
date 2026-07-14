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

**Baseline plugins** — opener, dialog, filesystem, clipboard, notifications, OS info — are wired unconditionally on every run, since almost every desktop app ends up needing them.

**Optional plugins** are wired only when detected in your source, via a combined regex + AST import scan:

- `navigator.geolocation` → geolocation plugin + Android/iOS/macOS location permissions
- `registerGlobalShortcut(...)` → global-shortcut plugin
- `setAutoStart(...)` → autostart plugin
- `window.biniStore` → persistent key-value store plugin
- `getUserMedia({ video: true })` / `{ audio: true }` → camera/microphone platform permissions (no plugin needed — Tauri's webview supports these natively)

If you add a new API mid-session, `bini-native` detects it and prints a one-line notice to restart `tauri dev` — it deliberately does **not** rewrite `src-tauri/` files while cargo might be running, to avoid write races.

## Supported plugins

| Feature | Web API you write | Rust crate | Tier |
|---|---|---|---|
| Opener | `@tauri-apps/plugin-opener` | `tauri-plugin-opener` | Baseline |
| Dialog | `showOpenFilePicker` / `showSaveFilePicker` polyfill | `tauri-plugin-dialog` | Baseline |
| Filesystem | `@tauri-apps/plugin-fs` | `tauri-plugin-fs` | Baseline |
| Clipboard | `navigator.clipboard.writeText` / `readText` | `tauri-plugin-clipboard-manager` | Baseline |
| Notifications | `new Notification(...)` | `tauri-plugin-notification` | Baseline |
| OS info | `@tauri-apps/plugin-os` | `tauri-plugin-os` | Baseline |
| Geolocation | `navigator.geolocation.*` | `tauri-plugin-geolocation` | Optional |
| Global shortcut | `registerGlobalShortcut(...)` | `tauri-plugin-global-shortcut` | Optional |
| Autostart | `setAutoStart(...)` | `tauri-plugin-autostart` | Optional |
| Persistent store | `window.biniStore.*` | `tauri-plugin-store` | Optional |
| Camera / microphone | `getUserMedia(...)` | *(none — native webview support)* | Manifest-only |
| Bluetooth | `navigator.bluetooth` | *(no first-party plugin exists)* | Unsupported — logged, not wired |

## Platform notes

A couple of things are Tauri/OS limitations, not bugs in this plugin:

- **Notifications on Windows dev builds** — unpackaged `tauri dev` builds have no Start Menu shortcut / AUMID, so Windows silently denies the permission with no prompt at all. Run `tauri build` and install the result to test notifications properly.
- **Geolocation on Windows/Linux desktop** — Tauri's official geolocation plugin only supports Android, iOS, and macOS. It's still wired automatically if your source uses it (since the same code path may also target mobile), but the permission request will always fail on Windows/Linux desktop.

## Requirements

- A Tauri v2 project (`src-tauri/` present) — on projects without one, `bini-native` no-ops entirely, so it's safe to include in web-only builds too
- A `src/main.tsx` / `main.jsx` / `main.ts` / `main.js` entry file, where runtime polyfills get injected
- Vite 8

## FAQ

**Does this touch my code every time I save?**
No. File watching only triggers a cheap, read-only feature-detection scan (debounced) that logs a restart notice if something new shows up — it never rewrites `src-tauri/` mid-session.

**What if I've already hand-edited `lib.rs`?**
`bini-native` checks the actual registered `.plugin(...)` call for each crate. If it's already correct, it's left untouched. If it's missing or malformed, it's inserted or corrected in place.

**Can I use this without Bini.js?**
Yes — it's a plain Vite plugin with no Bini.js-specific dependency. It expects a conventional Vite + Tauri project layout, nothing more.

## Contributing

Issues and PRs welcome. Please include your OS, Tauri version, and (if relevant) the exact web API call that didn't get detected or wired correctly.

## License

MIT © [Bini](https://github.com/rbini)