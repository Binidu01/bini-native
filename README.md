<div align="center">

# bini-native

**Automatic Tauri native wiring for Bini.js.**
Import one Vite plugin and stop hand-editing `src-tauri/` for common plugins.

[![npm version](https://img.shields.io/npm/v/bini-native.svg?color=cb3837&logo=npm)](https://www.npmjs.com/package/bini-native)
[![npm downloads](https://img.shields.io/npm/dm/bini-native.svg?color=cb3837&logo=npm)](https://www.npmjs.com/package/bini-native)
[![license](https://img.shields.io/npm/l/bini-native.svg?color=blue)](./LICENSE)
[![vite](https://img.shields.io/badge/vite-%5E8.0.0-646CFF?logo=vite)](https://vitejs.dev)
[![tauri](https://img.shields.io/badge/tauri-v2-FFC131?logo=tauri)](https://v2.tauri.app)
[![types](https://img.shields.io/badge/types-included-3178C6?logo=typescript)](#)

</div>

---

## What it does

`bini-native` scans your frontend source, works out which native capabilities your app uses, and wires up the Tauri side during `tauri dev`:

- installs the matching `@tauri-apps/plugin-*` npm packages,
- adds the Rust plugin crates and registers them (via `cargo tauri add` for cross-platform plugins, and a managed block in `lib.rs` for desktop-only and mobile-only plugins),
- scaffolds `desktop.json` / `mobile.json` capability files for platform-specific plugins,
- injects runtime polyfills into your entry file, so standard web APIs (`navigator.clipboard.writeText`, `new Notification(...)`, `navigator.geolocation`, and so on) are routed to the native plugin when the app runs inside Tauri.

In a normal browser the polyfill block does nothing, because it only runs when `__TAURI_INTERNALS__` exists on `window`.

It does **not** edit `AndroidManifest.xml` or `Info.plist`, and it does not enable a `getUserMedia` camera or microphone setup. See [What it does not do](#what-it-does-not-do).

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

`biniNative()` takes no options. Source analysis is done through [`bini-router`](https://www.npmjs.com/package/bini-router) (`getSourceFacts`, `scanSourceFacts`, `isClientSourceFile`). `bini-router` `>= 2` and `vite` `^8.0.0` are **peer dependencies**, not bundled with `bini-native`. Bini.js projects already include both. npm 7+ installs missing peer dependencies automatically; pnpm and Yarn warn when one is missing.

Then run `tauri dev` as usual.

## How it works

The plugin is registered with `apply: 'serve'` and `enforce: 'pre'`, so its Vite hooks never run in `vite build`.

| Stage | When | What happens |
| --- | --- | --- |
| Pre-install | When the plugin module loads, if `process.argv` does not contain `build` and `src-tauri/` exists | Scans your source, then synchronously installs any detected npm packages that are missing. Nothing else is touched at this point. |
| Full wiring | Vite `buildStart` (once) | Reuses the scan, checks for the Tauri CLI, wires Rust plugins, scaffolds capability files, installs any still-missing npm packages, and rewrites the polyfill block in your entry file. |
| File changes | Vite `handleHotUpdate` for client source files | A debounced (400 ms), read-only re-scan of the changed files. If a feature is newly detected, it logs a notice to restart `tauri dev`. Nothing is written. |
| `tauri build` | Production build | The module-level pre-install is skipped by the `build` argument check, and no Vite hook runs. Nothing is detected, installed, or written. |

Because the wiring is written to ordinary files (`src-tauri/Cargo.toml`, `src-tauri/src/lib.rs`, capability files, `package.json`, your entry file), a later `tauri build` simply compiles what is already on disk.

**Practical implication:** run `tauri dev` at least once, and again after adding a new native API, before your first `tauri build`. On a fresh checkout where `tauri dev` has never run, `tauri build` will not wire anything for you.

If you add a new native API mid-session, `bini-native` prints a one-line notice to restart `tauri dev`. It deliberately does not rewrite `src-tauri/` while cargo might be running. It only reports newly detected features, not removed ones.

### Detection

A feature is wired only if your source uses it. There is no always-on tier. Detection reads facts collected by `bini-router`: imports, calls, references, `new` expressions, and JSX attributes.

- **Imports:** any import of `@tauri-apps/plugin-<name>` (or a subpath of it) detects that plugin, even with no matching web API call.
- **Global names:** call, reference, and `new` checks match the bare name and the `window.`, `globalThis.`, and `self.` prefixed forms.
- **Generic names:** a few plugins are detected from common function names (for example `exists`, `remove`, `stat`, `type`, `version`, `exit`). Same-named functions in your own code may therefore trigger a plugin you do not need. Remove the plugin from `src-tauri/` if that happens.

## Supported plugins

Every plugin below is also detected by a direct `@tauri-apps/plugin-<name>` import. The "Also detected by" column lists the additional triggers.

| Plugin | Also detected by | Platform | Polyfill |
| --- | --- | --- | --- |
| `opener` | `openUrl(...)`, `window.open(...)`, `<a target="_blank">` | All | Yes |
| `dialog` | `showOpenFilePicker(...)`, `showSaveFilePicker(...)` | All | Yes |
| `fs` | `readTextFile`, `writeTextFile`, `readFile`, `writeFile`, `mkdir`, `remove`, `exists`, `readDir`, `stat`, `copyFile`, `rename` calls | All | No |
| `clipboard-manager` | `navigator.clipboard.writeText` / `readText` | All | Yes |
| `notification` | `new Notification(...)`, `Notification.requestPermission` | All | Yes |
| `os` | `platform`, `version`, `arch`, `type`, `family`, `hostname`, `locale`, `eol` calls | All | No |
| `geolocation` | `navigator.geolocation` | All | Yes |
| `http` | `fetch('http(s)://…')` with a literal URL | All | Yes |
| `store` | `biniStore` | All | Yes |
| `shell` | `Command.create`, `Command.sidecar` calls | All | No |
| `process` | `exit`, `relaunch` calls | All | No |
| `sql` | `Database.load` | All | No |
| `log`, `upload`, `websocket`, `deep-link` | import only | All | No |
| `global-shortcut` | `registerGlobalShortcut` | Desktop | Yes |
| `autostart` | `setAutoStart`, `isAutoStartEnabled` | Desktop | Yes |
| `cli` | `getMatches` | Desktop | No |
| `updater`, `window-state`, `positioner` | import only | Desktop | No |
| `haptics` | `navigator.vibrate` | Mobile | Yes |
| `biometric`, `barcode-scanner`, `nfc` | import only | Mobile | No |

Each plugin maps to the crate `tauri-plugin-<name>` and the npm package `@tauri-apps/plugin-<name>`.

### Unsupported features

These are detected, logged as a warning with a hint, and not wired, because no first-party Tauri plugin exists.

| Web API | Hint |
| --- | --- |
| `navigator.bluetooth` | Look at community BLE plugins (for example `tauri-plugin-blec`). |
| `navigator.usb` | Use a custom Rust command or a community plugin. |
| `navigator.serial` | Use a custom Rust command (for example with the `serialport` crate). |
| `navigator.hid` | Use a custom Rust command or a community plugin. |
| `navigator.share` | Use a community share-sheet plugin or a custom command. |

## How Rust wiring is done

1. **All-platform plugins** are added one at a time with `cargo tauri add <name>` run inside `src-tauri/`, which handles the crate, registration, and default permissions.
2. **Desktop-only and mobile-only plugins** are added with `cargo add tauri-plugin-<name>@2 --manifest-path … --target <cfg>`:
   - desktop: `cfg(not(any(target_os = "android", target_os = "ios")))`
   - mobile: `cfg(any(target_os = "android", target_os = "ios"))`
3. **Registration for those plugins** is written into `src/lib.rs` (or `src/main.rs` if there is no `lib.rs`) inside your `.setup(|app| { … })` closure, wrapped in `#[cfg(desktop)]` or `#[cfg(mobile)]`:

   ```rust
   /* @bini-native:desktop-plugins */
   #[cfg(desktop)]
   {
       app.handle().plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None))?;
   }
   /* @bini-native:end-desktop-plugins */
   ```

   If there is no `.setup(...)`, one is inserted before `.run(tauri::generate_context!())`. The marked block is removed and regenerated on every run, so do not hand-edit inside the markers. Plugins you register yourself elsewhere in the file are not inspected, so avoid registering the same plugin twice.

Individual `tauri add` and `cargo add` calls time out after 120 s and 60 s respectively. A failure is logged as a warning and does not stop the dev server.

### Tauri CLI preflight

If any Rust plugin is needed, `bini-native` first checks `cargo tauri --version`. If the Tauri CLI is missing, it runs `cargo install tauri-cli --version ^2 --locked` (10 minute timeout). If that fails, Rust wiring is skipped, a warning is printed, and polyfills are still injected.

## Capabilities

`bini-native` never creates or edits `capabilities/default.json`. For all-platform plugins, permissions come from `cargo tauri add`.

For platform-specific plugins it scaffolds:

| File | Created when | Contents |
| --- | --- | --- |
| `capabilities/desktop.json` | Desktop-only plugins were detected and the file does not exist | `core:default` plus the plugins' permissions, for macOS, Windows, and Linux |
| `capabilities/mobile.json` | Mobile-only plugins were detected and the file does not exist | `core:default` plus the plugins' permissions, for Android and iOS |

The `windows` list is copied from `default.json` (falling back to `["main"]`). Once a file exists it is yours: it is never updated, so add permissions for plugins you detect later by hand. Review and tighten scopes before production.

## Polyfills

The entry file is the first existing file among `src/main.tsx`, `main.jsx`, `main.ts`, `main.js`, `index.tsx`, `index.jsx`, `index.ts`, and `index.js`.

On every dev start, `bini-native` removes its previous block (marker `/* @bini-native:polyfills:v2 */`) and writes a new one after your last single-line `import …;` statement (or at the top of the file if there is none). If no polyfilled feature is detected any more, the block is removed. Do not hand-edit it. With a `tsconfig.json` present, the block includes type annotations and a `declare global { interface Window { … } }` augmentation.

The block dynamically imports the plugin packages and only runs when `__TAURI_INTERNALS__` is on `window`.

| Plugin | Polyfill behaviour |
| --- | --- |
| `opener` | Intercepts `window.open` for external `http(s)`, `mailto:`, and `tel:` URLs (new tab, no window features), and clicks on external `<a href>` links (ignores `download` links and links inside buttons, inputs, or `[data-no-opener]`) |
| `dialog` | Defines `showOpenFilePicker` / `showSaveFilePicker` only if the webview does not already provide them |
| `clipboard-manager` | Replaces `navigator.clipboard.writeText` / `readText` |
| `notification` | Replaces `window.Notification`, requesting permission on first use |
| `geolocation` | Replaces `getCurrentPosition`, `watchPosition`, and `clearWatch`, with a permission check first |
| `http` | Routes `fetch` through the HTTP plugin for cross-origin `http(s)` URLs that are not localhost |
| `haptics` | Replaces `navigator.vibrate` on Android and iOS user agents only |
| `global-shortcut` | Adds `window.registerGlobalShortcut(shortcut, callback)`, `unregisterGlobalShortcut`, and `isGlobalShortcutRegistered` |
| `autostart` | Adds `window.setAutoStart(enabled)` and `window.isAutoStartEnabled()` |
| `store` | Adds `window.biniStore` with `get`, `set`, `delete`, and `clear`, backed by `bini-store.json` with auto-save |

Known limitations:

- The dialog polyfill's `getFile()` and `createWritable()` dynamically import `@tauri-apps/plugin-fs`. `bini-native` does not add the filesystem plugin for you, so use or import `fs` somewhere in your source (which wires it) before relying on file reads and writes.
- `watchPosition` returns `-1` synchronously. The real watch id is assigned asynchronously, so `clearWatch` on the returned value will not stop the watch.

## Package installs

- **Already-installed packages are skipped.** Each package is checked against `<project>/node_modules/<name>/package.json`. Only missing ones are installed. (Packages hoisted to a workspace root are not seen by this check.)
- **Package manager** is picked from the lock file: `bun.lockb`, `bun.lock`, `pnpm-lock.yaml`, `yarn.lock`, then `package-lock.json`, searched in the project directory and up to four parent workspace directories. With no lock file, `bun`, `pnpm`, `yarn`, and `npm` are probed with `--version` in that order, defaulting to `npm`.
- **Command:** `<pm> add <packages>` (regular dependencies, not dev dependencies), with a 120 s timeout. A failure prints the exact command to run by hand.
- **Names are allowlisted** (`^(@scope/)?name`, alphanumerics, `.`, `_`, `-`). Anything else is skipped with a warning.
- A fresh install prints a restart notice instead of hot-loading the new dependency.

## Manual steps

`bini-native` does not print per-plugin setup notes, so these remain your responsibility:

| Plugin | What you need to do |
| --- | --- |
| `http` | Define the allowed URL scopes in your capability file |
| `sql` | Enable a driver feature (`sqlite`, `mysql`, or `postgres`) for `tauri-plugin-sql` in `Cargo.toml`; none is enabled for you |
| `updater` | Configure `plugins.updater` (public key and endpoints) and `bundle.createUpdaterArtifacts` in `tauri.conf.json` |
| `cli` | Define arguments under `plugins.cli` in `tauri.conf.json` |
| `deep-link` | Register schemes and hosts under `plugins.deep-link` in `tauri.conf.json` |
| `nfc` | Enable the NFC capability in Xcode for iOS, and add the Android `NFC` permission yourself |
| `notification`, `geolocation`, `haptics`, `biometric` | Add the Android manifest permissions and iOS/macOS `Info.plist` usage descriptions yourself |

## What it does not do

- It does not write `AndroidManifest.xml` entries or `Info.plist` usage descriptions.
- It does not detect `getUserMedia`, and it does not configure camera or microphone permissions.
- It does not wire the filesystem plugin as a dependency of the dialog plugin.
- It does not modify existing capability files.
- It does not run during `tauri build`.

## Platform notes

- **Notifications on Windows dev builds:** unpackaged `tauri dev` builds have no Start Menu shortcut or AUMID, so Windows silently denies the permission. Run `tauri build` and install the result to test notifications properly.
- **Geolocation on Windows and Linux desktop:** Tauri's official geolocation plugin only supports Android, iOS, and macOS. It is still wired if your source uses it, but the permission request will fail on Windows and Linux.
- **Desktop-only and mobile-only plugins** are placed behind `#[cfg(...)]` and a target-conditional Cargo dependency, so Android and iOS builds compile without the desktop-only crates (and the reverse).

## Requirements

- A Tauri v2 project with `src-tauri/` for Rust wiring and package installs. Without `src-tauri/`, those steps are skipped, but polyfills for detected features are still injected into the entry file. Those polyfills import `@tauri-apps/plugin-*` packages that would not be auto-installed in that case.
- An entry file in `src/` (see [Polyfills](#polyfills)).
- `vite` `^8.0.0` (peer dependency).
- `bini-router` `>= 2` (peer dependency).
- `cargo` on your `PATH`.
- `tauri dev` run at least once before `tauri build` on a fresh checkout.

The package is `"type": "module"` and ships ESM (`dist/index.js`) and CommonJS (`dist/index.cjs`) builds with bundled TypeScript types (`dist/index.d.ts`).

## CI / production builds

Because wiring is dev-only and persistent, a pipeline that only runs `tauri build` builds whatever is committed. Two options:

- **Commit the wiring.** Run `tauri dev` locally, review the changes, and commit `package.json` and your lock file, `src-tauri/Cargo.toml` and `Cargo.lock`, `src-tauri/src/lib.rs`, the capability files, and the polyfill block in your entry file.
- **Run a short-lived `tauri dev` in CI first**, then stop it once wiring finishes and run `tauri build`. Slower, but keeps generated files out of version control.

## Security

`bini-native` runs during `tauri dev` and spawns package-manager and cargo processes, so:

- **No shell string interpolation.** Every subprocess goes through [`cross-spawn`](https://www.npmjs.com/package/cross-spawn) with an argument array and never `shell: true`, so no shell re-parses a joined string.
- **Package manager from your lock file,** with `PATH` probing only as a fallback.
- **Nothing already installed is reinstalled.**
- **Package names are allowlisted** before reaching the package manager.
- **Path guards.** Writes to `src-tauri/src/lib.rs` / `main.rs` and to your entry file go through a check that refuses paths outside their root. `Cargo.toml` is edited by `cargo`, and capability files are only created inside `src-tauri/capabilities/`.
- **Child processes are cleaned up.** Active async installs are killed on exit, `SIGINT`, and `SIGTERM`.
- **It can install tooling.** If the Tauri CLI is missing, it runs `cargo install tauri-cli`, as described in [Tauri CLI preflight](#tauri-cli-preflight).
- **Nothing runs in production builds.** Build never executes the plugin's subprocess, install, or file-writing code.

- **Small dependency footprint.** The only runtime dependency is `cross-spawn` (pure JavaScript, MIT). `vite` and `bini-router` are peer dependencies. Source parsing happens inside `bini-router`, so `bini-native` has no parser or native bindings of its own. Build tooling (`tsup`, `typescript`, type packages) is in `devDependencies` and is not installed for consumers.

If you run supply-chain scanning in CI, scan the packed tarball (`npm pack --dry-run` lists what ships: `dist`, the README, and the license) rather than the whole repository.

## FAQ

**Does this touch my code every time I save?**
No. Saving a file only triggers a debounced, read-only detection pass that may log a restart notice. Files are written at dev startup: the polyfill block in your entry file, plus the `src-tauri/` wiring.

**Does `tauri build` re-check or re-wire anything?**
No. See [How it works](#how-it-works) and [CI / production builds](#ci--production-builds).

**Will it reinstall packages every time I run `tauri dev`?**
No. Packages already present in `node_modules` are skipped. See [Package installs](#package-installs).

**What if I've already hand-edited `lib.rs`?**
`bini-native` only manages the block between its own `@bini-native:*-plugins` markers (desktop-only and mobile-only plugins). All-platform plugins are added by `cargo tauri add`. It does not look for equivalent registrations you wrote yourself, so remove duplicates by hand if a plugin ends up registered twice.

**Does "detected" mean I have to call the web API directly?**
No. A direct import from the plugin's npm package counts too. For example, `import { readFile } from '@tauri-apps/plugin-fs'` wires the filesystem plugin.

**Can I use this without Bini.js?**
It is a Vite plugin, but it relies on `bini-router` (a peer dependency, `>= 2`) for source analysis, so that package must be installed even in a non-Bini.js project. Beyond that it expects a conventional Vite + Tauri layout.

## Contributing

Issues and PRs welcome. Please include your OS, Tauri version, and, if relevant, the exact code that was not detected or wired correctly.

## License

MIT © [Bini.js](https://bini.js.org)
