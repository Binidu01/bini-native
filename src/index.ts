import type { Plugin } from 'vite';
import { parseSync } from 'oxc-parser';
import { readFile, writeFile, readdir } from 'fs/promises';
import { existsSync, readFileSync, readdirSync } from 'fs';
import crossSpawn from 'cross-spawn';
import path from 'path';

// We deliberately do not use child_process's `shell: true` option anywhere in
// this file. As of Node 22+, passing an args array together with
// `shell: true` is deprecated (DEP0190) precisely because Node does NOT
// escape the array entries in that mode — it just joins them into a single
// string for the shell to reparse, which reopens the same injection surface
// as a hand-built command string. `cross-spawn` resolves Windows .cmd/.bat
// shims and quotes arguments itself without handing a joined string to
// cmd.exe, so we get correct Windows behavior without shell:true.

const colors = {
  reset: "\x1b[0m", bold: "\x1b[1m", cyan: "\x1b[36m",
  green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m",
} as const;

const log = {
  info: (m: string) => console.log(`${colors.cyan}${colors.bold}[bini-native]${colors.reset} ${m}`),
  success: (m: string) => console.log(`${colors.green}${colors.bold}[bini-native]${colors.reset} ${m}`),
  warn: (m: string) => console.warn(`${colors.yellow}${colors.bold}[bini-native]${colors.reset} ${m}`),
  error: (m: string) => console.error(`${colors.red}${colors.bold}[bini-native]${colors.reset} ${m}`),
};

interface RustPluginSpec {
  crate: string;
  rustIdent: string;
  permissions: string[];
  initExpr?: string;
  desktopOnly?: boolean;
}

interface FeatureDefinition {
  id: string;
  label: string;
  rustPlugin?: RustPluginSpec;
  npmPackage?: string;
  detectPatterns?: RegExp[];
  androidPermissions?: string[];
  iosUsageDescriptions?: Record<string, string>;
  macosUsageDescriptions?: Record<string, string>;
  polyfillImports?: string[];
  polyfillBody?: (useTypeScript: boolean) => string;
  noWiringNeeded?: boolean;
  noFirstPartyPlugin?: boolean;
  dependsOn?: string[];
}

const CORE_FEATURES: FeatureDefinition[] = [
  { 
    id: 'opener', 
    label: 'Opener',
    detectPatterns: [/@tauri-apps\/plugin-opener/, /openUrl/],
    rustPlugin: { 
      crate: 'tauri-plugin-opener', 
      rustIdent: 'tauri_plugin_opener', 
      permissions: ['opener:default'] 
    },
    npmPackage: '@tauri-apps/plugin-opener' 
  },
  { 
    id: 'dialog', 
    label: 'Dialog',
    rustPlugin: { 
      crate: 'tauri-plugin-dialog', 
      rustIdent: 'tauri_plugin_dialog', 
      permissions: ['dialog:default'] 
    },
    npmPackage: '@tauri-apps/plugin-dialog',
    detectPatterns: [/\bshowOpenFilePicker\s*\(/, /\bshowSaveFilePicker\s*\(/],
    dependsOn: ['fs'],
    polyfillImports: ['open as biniDialogOpen', 'save as biniDialogSave'],
    polyfillBody: (useTs) => `
  if (!window.__BINI_DIALOG_POLYFILLED__) {
    window.__BINI_DIALOG_POLYFILLED__ = true;
    if (!window.showOpenFilePicker) {
      window.showOpenFilePicker = async (options${useTs ? '?: any' : ''}) => {
        try {
          const result = await biniDialogOpen({ multiple: options?.multiple ?? false });
          if (!result) return [];
          const paths = Array.isArray(result) ? result : [result];
          return paths.map((p) => ({
            kind: 'file', name: p.split('/').pop() || p,
            getFile: async () => {
              const { readFile: biniFsReadFile } = await import('@tauri-apps/plugin-fs');
              const bytes = await biniFsReadFile(p);
              return { text: async () => new TextDecoder().decode(bytes), arrayBuffer: async () => new Blob([bytes]).arrayBuffer() };
            },
          }));
        } catch (err) { console.warn('[bini-native] Failed to open file picker:', err); return []; }
      };
    }
    if (!window.showSaveFilePicker) {
      window.showSaveFilePicker = async (options${useTs ? '?: any' : ''}) => {
        try {
          const result = await biniDialogSave({ title: options?.suggestedName ?? 'Save File' });
          if (!result) return null;
          return {
            kind: 'file', name: result.split('/').pop() || result,
            createWritable: async () => ({
              write: async (chunk${useTs ? ': string | Uint8Array' : ''}) => {
                const { writeFile: biniFsWriteFile } = await import('@tauri-apps/plugin-fs');
                const data = typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk;
                await biniFsWriteFile(result, data);
              },
              close: async () => {},
            }),
          };
        } catch (err) { console.warn('[bini-native] Failed to open save picker:', err); return null; }
      };
    }
  }
` },
  { 
    id: 'fs', 
    label: 'File System',
    rustPlugin: { 
      crate: 'tauri-plugin-fs', 
      rustIdent: 'tauri_plugin_fs', 
      permissions: ['fs:default'] 
    },
    npmPackage: '@tauri-apps/plugin-fs' 
  },
  { 
    id: 'clipboard', 
    label: 'Clipboard',
    rustPlugin: { 
      crate: 'tauri-plugin-clipboard-manager', 
      rustIdent: 'tauri_plugin_clipboard_manager', 
      permissions: ['clipboard-manager:allow-read-text', 'clipboard-manager:allow-write-text'] 
    },
    npmPackage: '@tauri-apps/plugin-clipboard-manager',
    detectPatterns: [/navigator\.clipboard\.(writeText|readText)/],
    polyfillImports: ['writeText as biniClipboardWriteText', 'readText as biniClipboardReadText'],
    polyfillBody: () => `
  if (!window.__BINI_CLIPBOARD_POLYFILLED__) {
    window.__BINI_CLIPBOARD_POLYFILLED__ = true;
    if (navigator.clipboard) {
      navigator.clipboard.writeText = async (text) => {
        try { await biniClipboardWriteText(text); } catch (err) { console.warn('[bini-native] clipboard write failed:', err); throw err; }
      };
      navigator.clipboard.readText = async () => {
        try { return await biniClipboardReadText(); } catch (err) { console.warn('[bini-native] clipboard read failed:', err); throw err; }
      };
    }
  }
` },
  { 
    id: 'notification', 
    label: 'Notification',
    rustPlugin: { 
      crate: 'tauri-plugin-notification', 
      rustIdent: 'tauri_plugin_notification', 
      permissions: ['notification:default'] 
    },
    npmPackage: '@tauri-apps/plugin-notification',
    detectPatterns: [/new\s+Notification\s*\(/],
    polyfillImports: [
      'isPermissionGranted as biniIsNotificationPermissionGranted',
      'requestPermission as biniRequestNotificationPermission',
      'sendNotification as biniSendNotification',
    ],
    polyfillBody: (useTs) => `
  if (!window.__BINI_NOTIFICATION_POLYFILLED__) {
    window.__BINI_NOTIFICATION_POLYFILLED__ = true;
    class BiniNotification {
      title${useTs ? ': string' : ''} = '';
      body${useTs ? ': string' : ''} = '';
      constructor(title${useTs ? ': string' : ''}, options${useTs ? '?: NotificationOptions' : ''}) {
        this.title = title;
        this.body = options?.body ?? '';
        (async () => {
          try {
            let granted = await biniIsNotificationPermissionGranted();
            if (!granted) granted = (await biniRequestNotificationPermission()) === 'granted';
            if (granted) await biniSendNotification({ title: this.title, body: this.body });
          } catch (err) { console.warn('[bini-native] notification send failed:', err); }
        })();
      }
      close() {}
      static async requestPermission() { try { return await biniRequestNotificationPermission(); } catch { return 'denied'; } }
    }
    (BiniNotification${useTs ? ' as any' : ''}).permission = 'default';
    window.Notification = BiniNotification${useTs ? ' as any' : ''};
  }
` },
  { 
    id: 'os', 
    label: 'OS Info',
    rustPlugin: { 
      crate: 'tauri-plugin-os', 
      rustIdent: 'tauri_plugin_os', 
      permissions: ['os:default'] 
    },
    npmPackage: '@tauri-apps/plugin-os' 
  },
];

const OPTIONAL_FEATURES: FeatureDefinition[] = [
  { 
    id: 'geolocation', 
    label: 'Geolocation',
    rustPlugin: {
      crate: 'tauri-plugin-geolocation', 
      rustIdent: 'tauri_plugin_geolocation',
      permissions: [
        'geolocation:allow-check-permissions', 
        'geolocation:allow-request-permissions',
        'geolocation:allow-get-current-position', 
        'geolocation:allow-watch-position', 
        'geolocation:allow-clear-watch',
      ],
    },
    npmPackage: '@tauri-apps/plugin-geolocation',
    detectPatterns: [/navigator\.geolocation/],
    androidPermissions: ['<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION"/>'],
    iosUsageDescriptions: { NSLocationWhenInUseUsageDescription: 'This app uses your location to provide relevant features.' },
    macosUsageDescriptions: { NSLocationUsageDescription: 'This app uses your location to provide relevant features.' },
    polyfillImports: [
      'checkPermissions as biniGeoCheckPermissions', 
      'requestPermissions as biniGeoRequestPermissions',
      'getCurrentPosition as biniGeoGetCurrentPosition', 
      'watchPosition as biniGeoWatchPosition', 
      'clearWatch as biniGeoClearWatch',
    ],
    polyfillBody: (useTs) => `
  if (!window.__BINI_GEOLOCATION_POLYFILLED__) {
    window.__BINI_GEOLOCATION_POLYFILLED__ = true;
    const biniEnsureLocationPermission = async () => {
      let p = await biniGeoCheckPermissions();
      if (p.location === 'prompt' || p.location === 'prompt-with-rationale') p = await biniGeoRequestPermissions(['location']);
      return p.location === 'granted';
    };
    if (navigator.geolocation) {
      (navigator.geolocation${useTs ? ' as any' : ''}).getCurrentPosition = async (success${useTs ? ': any' : ''}, error${useTs ? ': any' : ''}) => {
        try {
          if (!(await biniEnsureLocationPermission())) { if (error) error({ code: 1, message: 'Permission denied' }); return; }
          success(await biniGeoGetCurrentPosition());
        } catch (err${useTs ? ': any' : ''}) { console.warn('[bini-native] getCurrentPosition failed:', err); if (error) error(err); }
      };
      (navigator.geolocation${useTs ? ' as any' : ''}).watchPosition = (success${useTs ? ': any' : ''}, error${useTs ? ': any' : ''}, options${useTs ? '?: any' : ''}) => {
        let watchId = -1;
        (async () => {
          try {
            if (!(await biniEnsureLocationPermission())) { if (error) error({ code: 1, message: 'Permission denied' }); return; }
            watchId = await biniGeoWatchPosition(options ?? {}, (position${useTs ? ': any' : ''}) => { if (position) success(position); });
          } catch (err${useTs ? ': any' : ''}) { console.warn('[bini-native] watchPosition failed:', err); if (error) error(err); }
        })();
        return watchId;
      };
      (navigator.geolocation${useTs ? ' as any' : ''}).clearWatch = (watchId${useTs ? ': any' : ''}) => { biniGeoClearWatch(watchId).catch((err${useTs ? ': any' : ''}) => console.warn('[bini-native] clearWatch failed:', err)); };
    }
  }
` },
  { 
    id: 'global-shortcut', 
    label: 'Global Shortcut',
    rustPlugin: {
      crate: 'tauri-plugin-global-shortcut', 
      rustIdent: 'tauri_plugin_global_shortcut',
      permissions: ['global-shortcut:allow-register', 'global-shortcut:allow-unregister', 'global-shortcut:allow-is-registered'],
      initExpr: 'tauri_plugin_global_shortcut::Builder::new().build()',
      desktopOnly: true,
    },
    npmPackage: '@tauri-apps/plugin-global-shortcut',
    detectPatterns: [/registerGlobalShortcut|window\.registerGlobalShortcut/],
    polyfillImports: ['register as biniShortcutRegister', 'unregister as biniShortcutUnregister', 'isRegistered as biniShortcutIsRegistered'],
    polyfillBody: () => `
  if (!window.__BINI_SHORTCUT_POLYFILLED__) {
    window.__BINI_SHORTCUT_POLYFILLED__ = true;
    window.registerGlobalShortcut = async (shortcut, callback) => {
      try { await biniShortcutRegister(shortcut, (event) => { if (event.state === 'Pressed') callback(); }); }
      catch (err) { console.warn('[bini-native] register shortcut failed:', err); }
    };
    window.unregisterGlobalShortcut = async (shortcut) => {
      try { await biniShortcutUnregister(shortcut); } catch (err) { console.warn('[bini-native] unregister shortcut failed:', err); }
    };
    window.isGlobalShortcutRegistered = async (shortcut) => {
      try { return await biniShortcutIsRegistered(shortcut); } catch (err) { console.warn('[bini-native] check shortcut failed:', err); return false; }
    };
  }
` },
  { 
    id: 'autostart', 
    label: 'Autostart',
    rustPlugin: {
      crate: 'tauri-plugin-autostart', 
      rustIdent: 'tauri_plugin_autostart',
      permissions: ['autostart:allow-enable', 'autostart:allow-disable', 'autostart:allow-is-enabled'],
      initExpr: 'tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None)',
      desktopOnly: true,
    },
    npmPackage: '@tauri-apps/plugin-autostart',
    detectPatterns: [/setAutoStart|isAutoStartEnabled|window\.setAutoStart/],
    polyfillImports: ['enable as biniAutostartEnable', 'disable as biniAutostartDisable', 'isEnabled as biniAutostartIsEnabled'],
    polyfillBody: () => `
  if (!window.__BINI_AUTOSTART_POLYFILLED__) {
    window.__BINI_AUTOSTART_POLYFILLED__ = true;
    window.setAutoStart = async (enabled) => {
      try { if (enabled) await biniAutostartEnable(); else await biniAutostartDisable(); }
      catch (err) { console.warn('[bini-native] set autostart failed:', err); }
    };
    window.isAutoStartEnabled = async () => {
      try { return await biniAutostartIsEnabled(); } catch (err) { console.warn('[bini-native] check autostart failed:', err); return false; }
    };
  }
` },
  { 
    id: 'store', 
    label: 'Persistent Store',
    rustPlugin: {
      crate: 'tauri-plugin-store', 
      rustIdent: 'tauri_plugin_store',
      permissions: ['store:default'],
      initExpr: 'tauri_plugin_store::Builder::default().build()',
    },
    npmPackage: '@tauri-apps/plugin-store',
    detectPatterns: [/biniStore\.(get|set|delete|clear)|window\.biniStore/],
    polyfillImports: ['load as biniStoreLoad'],
    polyfillBody: (useTs) => `
  if (!window.__BINI_STORE_POLYFILLED__) {
    window.__BINI_STORE_POLYFILLED__ = true;
    let biniStoreInstance${useTs ? ': any' : ''} = null;
    const biniGetStore = async () => { if (!biniStoreInstance) biniStoreInstance = await biniStoreLoad('bini-store.json', { autoSave: true }${useTs ? ' as any' : ''}); return biniStoreInstance; };
    window.biniStore = {
      get: async (key) => { try { return await (await biniGetStore()).get(key); } catch (err) { console.warn('[bini-native] store get failed:', err); return null; } },
      set: async (key, value) => { try { await (await biniGetStore()).set(key, value); } catch (err) { console.warn('[bini-native] store set failed:', err); } },
      delete: async (key) => { try { await (await biniGetStore()).delete(key); } catch (err) { console.warn('[bini-native] store delete failed:', err); } },
      clear: async () => { try { await (await biniGetStore()).clear(); } catch (err) { console.warn('[bini-native] store clear failed:', err); } },
    };
  }
` },
];

const ALL_FEATURES: FeatureDefinition[] = [...CORE_FEATURES, ...OPTIONAL_FEATURES];

const MANIFEST_ONLY_FEATURES: FeatureDefinition[] = [
  { 
    id: 'camera', 
    label: 'Camera',
    detectPatterns: [/getUserMedia\s*\(\s*\{[^}]*video/s],
    androidPermissions: ['<uses-permission android:name="android.permission.CAMERA"/>'],
    iosUsageDescriptions: { NSCameraUsageDescription: 'This app uses the camera to capture photos and video.' },
    macosUsageDescriptions: { NSCameraUsageDescription: 'This app uses the camera to capture photos and video.' },
    noWiringNeeded: true 
  },
  { 
    id: 'microphone', 
    label: 'Microphone',
    detectPatterns: [/getUserMedia\s*\(\s*\{[^}]*audio/s, /new\s+MediaRecorder/],
    androidPermissions: ['<uses-permission android:name="android.permission.RECORD_AUDIO"/>'],
    iosUsageDescriptions: { NSMicrophoneUsageDescription: 'This app uses the microphone to record audio.' },
    macosUsageDescriptions: { NSMicrophoneUsageDescription: 'This app uses the microphone to record audio.' },
    noWiringNeeded: true 
  },
];

const UNSUPPORTED_FEATURES: FeatureDefinition[] = [
  { id: 'bluetooth', label: 'Bluetooth', detectPatterns: [/navigator\.bluetooth/], noFirstPartyPlugin: true },
];

type PackageManager = 'bun' | 'pnpm' | 'yarn' | 'npm';

let cachedPackageManager: PackageManager | null = null;

function detectPackageManager(cwd: string): PackageManager {
  if (cachedPackageManager) return cachedPackageManager;
  const candidates: { name: PackageManager; bin: string; args: string[] }[] = [
    { name: 'bun', bin: 'bun', args: ['--version'] },
    { name: 'pnpm', bin: 'pnpm', args: ['--version'] },
    { name: 'yarn', bin: 'yarn', args: ['--version'] },
    { name: 'npm', bin: 'npm', args: ['--version'] },
  ];
  for (const c of candidates) {
    const result = crossSpawn.sync(c.bin, c.args, { stdio: 'ignore', cwd, windowsHide: true });
    if (!result.error && result.status === 0) {
      cachedPackageManager = c.name;
      return c.name;
    }
  }
  cachedPackageManager = 'npm';
  return 'npm';
}

function isValidPackageName(name: string): boolean {
  return /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i.test(name);
}

async function installPackages(cwd: string, packages: string[]): Promise<void> {
  if (packages.length === 0) return;

  const valid = packages.filter(isValidPackageName);
  const invalid = packages.filter((p) => !isValidPackageName(p));
  if (invalid.length > 0) log.warn(`Refusing to install unexpected package name(s): ${invalid.join(', ')}`);
  if (valid.length === 0) return;

  const pm = detectPackageManager(cwd);

  await new Promise<void>((resolve) => {
    // cross-spawn resolves the correct .cmd/.bat shim on Windows and quotes
    // arguments itself — no shell:true, so no unescaped concatenation.
    const child = crossSpawn(pm, ['add', ...valid], {
      cwd,
      stdio: 'ignore',
      windowsHide: true,
    });
    const timer = setTimeout(() => child.kill(), 120_000);
    const done = () => { clearTimeout(timer); resolve(); };

    child.on('error', done);
    child.on('exit', (code) => {
      if (code !== 0) log.warn(`Could not auto-install ${valid.join(', ')}. Run manually: ${pm} add ${valid.join(' ')}`);
      done();
    });
  });
}

function installPackagesSync(cwd: string, packages: string[]): void {
  if (packages.length === 0) return;

  const valid = packages.filter(isValidPackageName);
  const invalid = packages.filter((p) => !isValidPackageName(p));
  if (invalid.length > 0) log.warn(`Refusing to install unexpected package name(s): ${invalid.join(', ')}`);
  if (valid.length === 0) return;

  const pm = detectPackageManager(cwd);

  try {
    log.info(`Installing: ${valid.join(', ')}`);
    // cross-spawn.sync resolves the .cmd/.bat shim and quotes arguments
    // itself, so shell:true (and its DEP0190 unescaped-concatenation
    // behavior) is never needed here, on Windows or elsewhere.
    const result = crossSpawn.sync(pm, ['add', ...valid], {
      stdio: 'inherit',
      cwd,
      timeout: 120000,
      windowsHide: true,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`exited with code ${result.status}`);
    log.success(`Successfully installed: ${valid.join(', ')}`);
  } catch (err) {
    log.warn(`Could not auto-install ${valid.join(', ')}. Run manually: ${pm} add ${valid.join(' ')}`);
  }
}

function detectUsedFeaturesSync(projectPath: string): FeatureDefinition[] {
  const srcDir = path.join(projectPath, 'src');
  if (!existsSync(srcDir)) return [];
  
  const detectable = [...ALL_FEATURES, ...MANIFEST_ONLY_FEATURES, ...UNSUPPORTED_FEATURES];
  const matched = new Set<string>();

  function collectFilesSync(dir: string): string[] {
    const files: string[] = [];
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'src-tauri') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          files.push(...collectFilesSync(full));
        } else if (/\.(ts|tsx|js|jsx)$/.test(entry.name)) {
          files.push(full);
        }
      }
    } catch {}
    return files;
  }

  const files = collectFilesSync(srcDir);
  
  for (const file of files) {
    if (matched.size === detectable.length) break;
    
    let content: string;
    try {
      content = readFileSync(file, 'utf-8');
    } catch {
      continue;
    }

    for (const f of detectable) {
      if (matched.has(f.id)) continue;
      if (f.detectPatterns?.some((p) => p.test(content))) {
        matched.add(f.id);
      }
    }

    for (const f of detectable) {
      if (matched.has(f.id)) continue;
      if (f.npmPackage && content.includes(f.npmPackage)) {
        matched.add(f.id);
      }
    }
  }

  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const f of detectable) {
      if (!matched.has(f.id) || !f.dependsOn) continue;
      for (const dep of f.dependsOn) {
        if (!matched.has(dep)) { matched.add(dep); expanded = true; }
      }
    }
  }

  return detectable.filter((f) => matched.has(f.id));
}

function getRustPlugins(features: FeatureDefinition[]): RustPluginSpec[] {
  const result: RustPluginSpec[] = [];
  for (const f of features) {
    if (f.rustPlugin) result.push(f.rustPlugin);
  }
  return result;
}

// Defense-in-depth: every patch* function below writes only to paths derived
// from a fixed `tauriDir`/`projectPath` root via static path.join segments,
// but this guard protects against any future refactor that threads in a
// dynamic segment, by refusing to write outside the intended root.
function assertPathInside(root: string, target: string): void {
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Refusing to write outside of project root: ${target}`);
  }
}

const DESKTOP_TARGET_HEADER = '[target."cfg(not(any(target_os = "android", target_os = "ios")))".dependencies]';
const DESKTOP_TARGET_HEADER_RE = /\[target\."cfg\(not\(any\(target_os = "android", target_os = "ios"\)\)\)"\.dependencies\]/;

async function patchCargoToml(tauriDir: string, features: FeatureDefinition[]): Promise<void> {
  const cargoPath = path.join(tauriDir, 'Cargo.toml');
  assertPathInside(tauriDir, cargoPath);
  if (!existsSync(cargoPath)) return;
  
  const plugins = getRustPlugins(features);
  if (plugins.length === 0) return;

  const crossPlatform = plugins.filter((p) => !p.desktopOnly);
  const desktopOnly = plugins.filter((p) => p.desktopOnly);

  try {
    let content = await readFile(cargoPath, 'utf-8');
    let changed = false;

    // Ensure [dependencies] section exists
    if (!content.includes('[dependencies]')) {
      content += '\n[dependencies]\n';
      changed = true;
    }

    // Add cross-platform dependencies
    for (const { crate } of crossPlatform) {
      const depPattern = new RegExp(`^${crate}\\s*=`, 'm');
      if (!depPattern.test(content)) {
        log.info(`Adding ${crate} to Cargo.toml`);
        const depsMatch = content.match(/\[dependencies\][ \t]*\r?\n/);
        if (depsMatch) {
          const insertPos = depsMatch.index! + depsMatch[0].length;
          content = content.slice(0, insertPos) + `${crate} = "2"\n` + content.slice(insertPos);
          changed = true;
        }
      }
    }

    // Handle desktop-only dependencies
    for (const { crate } of desktopOnly) {
      if (!new RegExp(`^${crate}\\s*=`, 'm').test(content)) {
        if (content.includes(DESKTOP_TARGET_HEADER)) {
          content = content.replace(
            DESKTOP_TARGET_HEADER_RE,
            `${DESKTOP_TARGET_HEADER}\n${crate} = "2"`
          );
        } else {
          content = `${content.trimEnd()}\n\n${DESKTOP_TARGET_HEADER}\n${crate} = "2"\n`;
        }
        changed = true;
      }
    }

    if (changed) {
      await writeFile(cargoPath, content);
      log.success(`Updated Cargo.toml`);
    }
  } catch (err) {
    log.warn(`Could not patch Cargo.toml: ${(err as Error).message}`);
  }
}

async function patchLibRs(tauriDir: string, features: FeatureDefinition[]): Promise<void> {
  const candidates = [
    path.join(tauriDir, 'src', 'lib.rs'),
    path.join(tauriDir, 'src', 'main.rs'),
  ];
  candidates.forEach((p) => assertPathInside(tauriDir, p));
  
  const targetPath = candidates.find((p) => existsSync(p));
  if (!targetPath) {
    log.warn(`Could not find lib.rs or main.rs in ${path.join(tauriDir, 'src')}`);
    return;
  }

  const allPlugins = getRustPlugins(features);
  if (allPlugins.length === 0) return;

  const crossPlatform = allPlugins.filter((p) => !p.desktopOnly);

  try {
    let content = await readFile(targetPath, 'utf-8');
    let changed = false;

    // Find the tauri::Builder::default() line
    const builderMatch = content.match(/tauri::Builder::default\(\)/);
    if (!builderMatch) {
      log.warn(`Could not find tauri::Builder::default() in ${path.basename(targetPath)}`);
      return;
    }

    // Add cross-platform plugins
    for (const plugin of crossPlatform) {
      const correctCall = `.plugin(${plugin.initExpr ?? `${plugin.rustIdent}::init()`})`;
      
      if (!content.includes(plugin.rustIdent)) {
        log.info(`Adding ${plugin.crate} to ${path.basename(targetPath)}`);
        
        // Find insertion point
        const runMatch = content.match(/\.run\(tauri::generate_context!\(\)\)/);
        const setupMatch = content.match(/\.setup\(/);
        
        let insertPos: number;
        if (runMatch) {
          insertPos = runMatch.index!;
        } else if (setupMatch) {
          insertPos = setupMatch.index!;
        } else {
          const builderEnd = builderMatch.index! + builderMatch[0].length;
          const endOfLine = content.indexOf('\n', builderEnd);
          insertPos = endOfLine + 1;
        }
        
        content = content.slice(0, insertPos) + `    ${correctCall}\n` + content.slice(insertPos);
        changed = true;
      }
    }

    if (changed) {
      await writeFile(targetPath, content);
      log.success(`Updated ${path.basename(targetPath)}`);
    }

    // Handle desktop-only plugins
    const desktopOnly = allPlugins.filter((p) => p.desktopOnly);
    if (desktopOnly.length > 0) {
      await patchDesktopOnlyPlugins(targetPath, desktopOnly);
    }
  } catch (err) {
    log.warn(`Could not patch ${path.basename(targetPath)}: ${(err as Error).message}`);
  }
}

function findMatchingBrace(content: string, openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < content.length; i++) {
    if (content[i] === '{') depth++;
    else if (content[i] === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

const DESKTOP_BLOCK_START = '/* @bini-native:desktop-plugins */';
const DESKTOP_BLOCK_END = '/* @bini-native:end-desktop-plugins */';

async function patchDesktopOnlyPlugins(targetPath: string, plugins: RustPluginSpec[]): Promise<void> {
  if (plugins.length === 0) return;
  let content = await readFile(targetPath, 'utf-8');

  let setupMatch = content.match(/\.setup\(\s*\|app\|\s*\{/);

  if (!setupMatch || setupMatch.index === undefined) {
    const runMatch = content.match(/\.run\(tauri::generate_context!\(\)\)/);
    if (!runMatch || runMatch.index === undefined) {
      log.warn(`Could not find .setup() or .run() in ${path.basename(targetPath)}; skipping desktop-only plugin wiring.`);
      return;
    }
    content = content.slice(0, runMatch.index) + `.setup(|app| {\n      Ok(())\n    })\n    ` + content.slice(runMatch.index);
    setupMatch = content.match(/\.setup\(\s*\|app\|\s*\{/)!;
  }

  const openBraceIndex = content.indexOf('{', setupMatch.index!);
  const closeBraceIndex = findMatchingBrace(content, openBraceIndex);
  if (closeBraceIndex === -1) {
    log.warn(`Could not parse the .setup() block in ${path.basename(targetPath)}`);
    return;
  }

  let body = content.slice(openBraceIndex + 1, closeBraceIndex);

  const startIdx = body.indexOf(DESKTOP_BLOCK_START);
  if (startIdx !== -1) {
    const endIdx = body.indexOf(DESKTOP_BLOCK_END);
    body = endIdx !== -1 ? body.slice(0, startIdx) + body.slice(endIdx + DESKTOP_BLOCK_END.length) : body;
  }

  const registrations = plugins
    .map((p) => `        app.handle().plugin(${p.initExpr ?? `${p.rustIdent}::init()`})?;`)
    .join('\n');
  const block = `\n      ${DESKTOP_BLOCK_START}\n      #[cfg(desktop)]\n      {\n${registrations}\n      }\n      ${DESKTOP_BLOCK_END}\n`;

  const okIndex = body.lastIndexOf('Ok(())');
  body = okIndex === -1 ? body + block : body.slice(0, okIndex) + block + '      ' + body.slice(okIndex);

  content = content.slice(0, openBraceIndex + 1) + body + content.slice(closeBraceIndex);
  await writeFile(targetPath, content);
}

async function patchCapabilities(tauriDir: string, features: FeatureDefinition[]): Promise<void> {
  const capsPath = path.join(tauriDir, 'capabilities', 'default.json');
  assertPathInside(tauriDir, capsPath);
  if (!existsSync(capsPath)) return;

  const required = ['core:default'];
  for (const plugin of getRustPlugins(features)) {
    required.push(...plugin.permissions);
  }

  try {
    const raw = await readFile(capsPath, 'utf-8');
    const caps = JSON.parse(raw);
    caps.permissions = Array.isArray(caps.permissions) ? caps.permissions : [];
    const existingPermissions = new Set<string>(caps.permissions);
    let changed = false;
    for (const perm of required) {
      if (!existingPermissions.has(perm)) {
        caps.permissions.push(perm);
        existingPermissions.add(perm);
        changed = true;
      }
    }
    if (changed) await writeFile(capsPath, JSON.stringify(caps, null, 2) + '\n');
  } catch (err) {
    log.warn(`Could not patch capabilities/default.json: ${(err as Error).message}`);
  }
}

async function patchAndroidManifest(tauriDir: string, features: FeatureDefinition[]): Promise<void> {
  const manifestPath = path.join(tauriDir, 'gen', 'android', 'app', 'src', 'main', 'AndroidManifest.xml');
  assertPathInside(tauriDir, manifestPath);
  const permissions = features.flatMap((f) => f.androidPermissions ?? []);
  if (permissions.length === 0 || !existsSync(manifestPath)) return;

  try {
    let content = await readFile(manifestPath, 'utf-8');
    let changed = false;
    for (const perm of permissions) {
      const name = perm.match(/android:name="([^"]+)"/)?.[1];
      if (name && content.includes(name)) continue;
      content = content.replace(/(<manifest[^>]*>\s*\n)/, `$1    ${perm}\n`);
      changed = true;
    }
    if (changed) await writeFile(manifestPath, content);
  } catch (err) {
    log.warn(`Could not patch AndroidManifest.xml: ${(err as Error).message}`);
  }
}

async function patchPlist(plistPath: string, descriptions: Record<string, string>): Promise<void> {
  if (Object.keys(descriptions).length === 0 || !existsSync(plistPath)) return;
  try {
    let content = await readFile(plistPath, 'utf-8');
    let changed = false;
    for (const [key, value] of Object.entries(descriptions)) {
      if (content.includes(`<key>${key}</key>`)) continue;
      content = content.replace(/(<dict>\s*\n)/, `$1\t<key>${key}</key>\n\t<string>${value}</string>\n`);
      changed = true;
    }
    if (changed) await writeFile(plistPath, content);
  } catch (err) {
    log.warn(`Could not patch ${plistPath}: ${(err as Error).message}`);
  }
}

async function patchIosAndMacosPlists(tauriDir: string, features: FeatureDefinition[]): Promise<void> {
  const ios = features.reduce((acc, f) => ({ ...acc, ...(f.iosUsageDescriptions ?? {}) }), {} as Record<string, string>);
  const macos = features.reduce((acc, f) => ({ ...acc, ...(f.macosUsageDescriptions ?? {}) }), {} as Record<string, string>);
  const iosPath = path.join(tauriDir, 'gen', 'apple', 'Sources', 'Info.plist');
  const macosPath = path.join(tauriDir, 'Info.plist');
  assertPathInside(tauriDir, iosPath);
  assertPathInside(tauriDir, macosPath);
  await patchPlist(iosPath, ios);
  await patchPlist(macosPath, macos);
}

const SCANNABLE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx']);
const IGNORED_DIRS = new Set(['node_modules', 'dist', 'src-tauri']);

async function collectSourceFiles(dir: string, out: string[] = []): Promise<string[]> {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await collectSourceFiles(full, out);
    else if (SCANNABLE_EXT.has(path.extname(entry.name))) out.push(full);
  }
  return out;
}

function collectTopLevelImports(program: any): Set<string> {
  const imports = new Set<string>();
  const body = Array.isArray(program?.body) ? program.body : [];
  for (const stmt of body) {
    if (stmt?.type === 'ImportDeclaration' && typeof stmt.source?.value === 'string') {
      imports.add(stmt.source.value);
    }
  }
  return imports;
}

async function detectUsedFeatures(projectPath: string): Promise<FeatureDefinition[]> {
  const srcDir = path.join(projectPath, 'src');
  const files = await collectSourceFiles(srcDir);
  const detectable = [...ALL_FEATURES, ...MANIFEST_ONLY_FEATURES, ...UNSUPPORTED_FEATURES];
  const matched = new Set<string>();

  const fileContents = await Promise.all(
    files.map(async (file): Promise<readonly [string, string | null]> => {
      try { return [file, await readFile(file, 'utf-8')]; }
      catch { return [file, null]; }
    })
  );

  for (const [file, content] of fileContents) {
    if (matched.size === detectable.length) break;
    if (content === null) continue;

    // Check detect patterns
    for (const f of detectable) {
      if (matched.has(f.id)) continue;
      if (f.detectPatterns?.some((p) => p.test(content))) {
        matched.add(f.id);
      }
    }

    // Check npm packages
    for (const f of detectable) {
      if (matched.has(f.id)) continue;
      if (f.npmPackage && content.includes(f.npmPackage)) {
        matched.add(f.id);
        continue;
      }
    }

    // Parse imports
    try {
      const result = parseSync(content, { sourceType: 'module', sourceFilename: file } as any);
      const imports = collectTopLevelImports(result.program);
      for (const f of detectable) {
        if (matched.has(f.id)) continue;
        if (f.npmPackage && [...imports].some((i) => i.includes(f.npmPackage!))) {
          matched.add(f.id);
        }
      }
    } catch {
      // Already checked via content.includes above
    }
  }

  // Handle dependencies
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const f of detectable) {
      if (!matched.has(f.id) || !f.dependsOn) continue;
      for (const dep of f.dependsOn) {
        if (!matched.has(dep)) { matched.add(dep); expanded = true; }
      }
    }
  }

  return detectable.filter((f) => matched.has(f.id));
}

async function wireFeatures(projectPath: string, features: FeatureDefinition[]): Promise<void> {
  const tauriDir = path.join(projectPath, 'src-tauri');
  if (!existsSync(tauriDir)) return;

  for (const f of features.filter((f) => f.noFirstPartyPlugin)) {
    log.warn(`"${f.id}" detected — no official Tauri plugin exists. Skipping automatic wiring.`);
  }
  for (const f of features.filter((f) => f.noWiringNeeded)) {
    log.info(`"${f.id}" detected — no plugin needed; wiring platform permissions only.`);
  }

  const npmPackages: string[] = [];
  for (const f of features) {
    if (f.npmPackage) npmPackages.push(f.npmPackage);
  }
  if (npmPackages.length > 0) await installPackages(projectPath, npmPackages);

  const withRustPlugin = features.filter((f) => f.rustPlugin);
  if (withRustPlugin.length > 0) {
    await patchCargoToml(tauriDir, withRustPlugin);
    await patchLibRs(tauriDir, withRustPlugin);
  }
  await patchCapabilities(tauriDir, withRustPlugin);

  const withManifest = features.filter((f) => f.androidPermissions || f.iosUsageDescriptions || f.macosUsageDescriptions);
  if (withManifest.length > 0) {
    await patchAndroidManifest(tauriDir, withManifest);
    await patchIosAndMacosPlists(tauriDir, withManifest);
  }
}

const INJECTION_MARKER = '/* @bini-native:polyfills:v1 */';
const END_MARKER = '// ─── End Bini Native: Runtime Polyfills ───────────────────────────────';

function stripExistingPolyfillBlock(content: string): string {
  const start = content.indexOf('\n' + INJECTION_MARKER);
  if (start === -1) return content;
  const end = content.indexOf(END_MARKER, start);
  if (end === -1) return content;
  return content.slice(0, start) + content.slice(end + END_MARKER.length + 1);
}

function detectUseTypeScript(projectPath: string): boolean {
  return existsSync(path.join(projectPath, 'tsconfig.json'));
}

async function injectPolyfills(projectPath: string, features: FeatureDefinition[]): Promise<void> {
  const mainFile = ['main.tsx', 'main.jsx', 'main.ts', 'main.js']
    .map((f) => path.join(projectPath, 'src', f))
    .find((p) => existsSync(p));
  if (!mainFile) return;

  const active = features.filter((f) => f.polyfillBody);
  const useTypeScript = detectUseTypeScript(projectPath);

  try {
    let content = await readFile(mainFile, 'utf-8');
    if (content.includes(INJECTION_MARKER)) content = stripExistingPolyfillBlock(content);
    if (active.length === 0) {
      await writeFile(mainFile, content);
      return;
    }

    const importLineParts: string[] = [];
    for (const f of active) {
      if (f.polyfillImports && f.npmPackage) {
        importLineParts.push(`import { ${f.polyfillImports.join(', ')} } from '${f.npmPackage}';`);
      }
    }
    const importLines = importLineParts.join('\n');
    const bodyBlocks = active.map((f) => f.polyfillBody!(useTypeScript)).join('\n');

    const windowAugmentation = useTypeScript ? `
declare global {
  interface Window {
    __BINI_DIALOG_POLYFILLED__?: boolean;
    showOpenFilePicker?: (options?: any) => Promise<any[]>;
    showSaveFilePicker?: (options?: any) => Promise<any>;
    __BINI_CLIPBOARD_POLYFILLED__?: boolean;
    __BINI_NOTIFICATION_POLYFILLED__?: boolean;
    __BINI_GEOLOCATION_POLYFILLED__?: boolean;
    __BINI_SHORTCUT_POLYFILLED__?: boolean;
    registerGlobalShortcut?: (shortcut: string, callback: () => void) => Promise<void>;
    unregisterGlobalShortcut?: (shortcut: string) => Promise<void>;
    isGlobalShortcutRegistered?: (shortcut: string) => Promise<boolean>;
    __BINI_AUTOSTART_POLYFILLED__?: boolean;
    setAutoStart?: (enabled: boolean) => Promise<void>;
    isAutoStartEnabled?: () => Promise<boolean>;
    __BINI_STORE_POLYFILLED__?: boolean;
    biniStore?: {
      get: (key: string) => Promise<any>;
      set: (key: string, value: any) => Promise<void>;
      delete: (key: string) => Promise<void>;
      clear: () => Promise<void>;
    };
  }
}
` : '';

    const block = `
${INJECTION_MARKER}
// ─── Bini Native: Runtime Polyfills ───────────────────────────────────
// Generated by bini-native — do not hand-edit, this block is regenerated
// automatically on every tauri dev/build.
${importLines}
${windowAugmentation}
(function () {
  const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
  if (!isTauri) return;
${bodyBlocks}
})();
${END_MARKER}
`;

    const imports = content.match(/(import\s+.*?;)/g);
    if (imports && imports.length > 0) {
      const last = imports[imports.length - 1];
      content = content.replace(last, `${last}\n${block}`);
    } else {
      content = `${block}\n${content}`;
    }

    await writeFile(mainFile, content);
  } catch (err) {
    log.warn(`Could not inject polyfills: ${(err as Error).message}`);
  }
}

let lastDetectedIds = new Set<string>();

async function runFullWiring(projectPath: string, isFirstRun: boolean): Promise<void> {
  const tauriDir = path.join(projectPath, 'src-tauri');
  if (!existsSync(tauriDir)) return;

  const detected = await detectUsedFeatures(projectPath);
  const detectedIds = new Set(detected.map((f) => f.id));

  if (detected.length > 0) {
    if (isFirstRun) log.info(`Detected: ${detected.map((f) => f.label).join(', ')}`);
    await wireFeatures(projectPath, detected);
  } else {
    await wireFeatures(projectPath, []);
    if (isFirstRun) log.info('No native feature usage detected in source — nothing to wire.');
  }

  await injectPolyfills(projectPath, detected.filter((f) => f.polyfillBody));
  lastDetectedIds = detectedIds;

  if (isFirstRun) log.success('Native wiring complete.');
}

let pendingFeatureCheck: ReturnType<typeof setTimeout> | null = null;

function checkForNewFeaturesOnChange(projectPath: string): void {
  if (pendingFeatureCheck) clearTimeout(pendingFeatureCheck);
  pendingFeatureCheck = setTimeout(() => {
    pendingFeatureCheck = null;
    detectUsedFeatures(projectPath).then((detected) => {
      const ids = new Set(detected.map((f) => f.id));
      const changed = ids.size !== lastDetectedIds.size || [...ids].some((id) => !lastDetectedIds.has(id));
      if (changed) {
        const newOnes = detected.filter((f) => !lastDetectedIds.has(f.id));
        if (newOnes.length > 0) {
          log.warn(`New native feature usage detected (${newOnes.map((f) => f.label).join(', ')}). Restart 'tauri dev' to wire it in.`);
        }
      }
    }).catch((err) => {
      log.warn(`Feature detection failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }, 400);
}

// ============================================================
// PRE-INSTALLATION - Runs synchronously at module load
// This happens BEFORE Vite starts, and only for the dev/serve command.
// vite.config (and therefore this module) is evaluated for `build` too,
// but there's no Vite hook available yet at this point in module load, so
// we check the CLI invocation directly and skip entirely for `build`.
// ============================================================
const isDevCommand = !process.argv.includes('build');
const projectPath = process.cwd();
const tauriDir = path.join(projectPath, 'src-tauri');

if (isDevCommand && existsSync(tauriDir)) {
  try {
    const detected = detectUsedFeaturesSync(projectPath);
    const npmPackages = detected
      .filter(f => f.npmPackage)
      .map(f => f.npmPackage!)
      .filter((p, i, arr) => arr.indexOf(p) === i);

    if (npmPackages.length > 0) {
      installPackagesSync(projectPath, npmPackages);
    }
  } catch (err) {
    // Silently fail - async version will retry
  }
}

// ============================================================
// PLUGIN EXPORT
// ============================================================
export function biniNative(): Plugin {
  let wired = false;

  return {
    name: 'bini-native',
    enforce: 'pre',
    // Only run this plugin's hooks for `vite dev`/`tauri dev`. During a
    // `build`, Vite skips every hook below entirely — no install, no
    // Cargo.toml/lib.rs/capabilities patching, no polyfill injection.
    apply: 'serve',

    async buildStart() {
      if (wired) return;
      wired = true;
      
      const projectPath = process.cwd();
      const tauriDir = path.join(projectPath, 'src-tauri');
      
      if (existsSync(tauriDir)) {
        await runFullWiring(projectPath, true);
      }
    },

    handleHotUpdate({ file }) {
      if (file.includes(`${path.sep}src${path.sep}`) && /\.(tsx?|jsx?)$/.test(file)) {
        checkForNewFeaturesOnChange(process.cwd());
      }
    },

    buildEnd() {
      if (pendingFeatureCheck) {
        clearTimeout(pendingFeatureCheck);
        pendingFeatureCheck = null;
      }
    },
  };
}