import type { Plugin } from 'vite';
import { parseSync } from 'oxc-parser';
import { readFile, writeFile, readdir } from 'fs/promises';
import { existsSync, readFileSync } from 'fs';
import { execSync } from 'child_process';
import path from 'path';

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
  /** Overrides the default `<rustIdent>::init()` call form. */
  initExpr?: string;
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
}

const BASELINE_FEATURES: FeatureDefinition[] = [
  { id: 'opener', label: 'Opener',
    rustPlugin: { crate: 'tauri-plugin-opener', rustIdent: 'tauri_plugin_opener', permissions: ['opener:default'] },
    npmPackage: '@tauri-apps/plugin-opener' },
  { id: 'dialog', label: 'Dialog',
    rustPlugin: { crate: 'tauri-plugin-dialog', rustIdent: 'tauri_plugin_dialog', permissions: ['dialog:default'] },
    npmPackage: '@tauri-apps/plugin-dialog',
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
  { id: 'fs', label: 'File System',
    rustPlugin: { crate: 'tauri-plugin-fs', rustIdent: 'tauri_plugin_fs', permissions: ['fs:default'] },
    npmPackage: '@tauri-apps/plugin-fs' },
  { id: 'clipboard', label: 'Clipboard',
    rustPlugin: { crate: 'tauri-plugin-clipboard-manager', rustIdent: 'tauri_plugin_clipboard_manager', permissions: ['clipboard-manager:allow-read-text', 'clipboard-manager:allow-write-text'] },
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
  { id: 'notification', label: 'Notification',
    rustPlugin: { crate: 'tauri-plugin-notification', rustIdent: 'tauri_plugin_notification', permissions: ['notification:default'] },
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
  { id: 'os', label: 'OS Info',
    rustPlugin: { crate: 'tauri-plugin-os', rustIdent: 'tauri_plugin_os', permissions: ['os:default'] },
    npmPackage: '@tauri-apps/plugin-os' },
];

const OPTIONAL_FEATURES: FeatureDefinition[] = [
  { id: 'geolocation', label: 'Geolocation',
    rustPlugin: {
      crate: 'tauri-plugin-geolocation', rustIdent: 'tauri_plugin_geolocation',
      permissions: [
        'geolocation:allow-check-permissions', 'geolocation:allow-request-permissions',
        'geolocation:allow-get-current-position', 'geolocation:allow-watch-position', 'geolocation:allow-clear-watch',
      ],
    },
    npmPackage: '@tauri-apps/plugin-geolocation',
    detectPatterns: [/navigator\.geolocation/],
    androidPermissions: ['<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION"/>'],
    iosUsageDescriptions: { NSLocationWhenInUseUsageDescription: 'This app uses your location to provide relevant features.' },
    macosUsageDescriptions: { NSLocationUsageDescription: 'This app uses your location to provide relevant features.' },
    polyfillImports: [
      'checkPermissions as biniGeoCheckPermissions', 'requestPermissions as biniGeoRequestPermissions',
      'getCurrentPosition as biniGeoGetCurrentPosition', 'watchPosition as biniGeoWatchPosition', 'clearWatch as biniGeoClearWatch',
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
  { id: 'global-shortcut', label: 'Global Shortcut',
    rustPlugin: {
      crate: 'tauri-plugin-global-shortcut', rustIdent: 'tauri_plugin_global_shortcut',
      permissions: ['global-shortcut:allow-register', 'global-shortcut:allow-unregister', 'global-shortcut:allow-is-registered'],
      initExpr: 'tauri_plugin_global_shortcut::Builder::new().build()',
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
  { id: 'autostart', label: 'Autostart',
    rustPlugin: {
      crate: 'tauri-plugin-autostart', rustIdent: 'tauri_plugin_autostart',
      permissions: ['autostart:allow-enable', 'autostart:allow-disable', 'autostart:allow-is-enabled'],
      initExpr: 'tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None)',
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
  { id: 'store', label: 'Persistent Store',
    rustPlugin: {
      crate: 'tauri-plugin-store', rustIdent: 'tauri_plugin_store',
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

const MANIFEST_ONLY_FEATURES: FeatureDefinition[] = [
  { id: 'camera', label: 'Camera',
    detectPatterns: [/getUserMedia\s*\(\s*\{[^}]*video/s],
    androidPermissions: ['<uses-permission android:name="android.permission.CAMERA"/>'],
    iosUsageDescriptions: { NSCameraUsageDescription: 'This app uses the camera to capture photos and video.' },
    macosUsageDescriptions: { NSCameraUsageDescription: 'This app uses the camera to capture photos and video.' },
    noWiringNeeded: true },
  { id: 'microphone', label: 'Microphone',
    detectPatterns: [/getUserMedia\s*\(\s*\{[^}]*audio/s, /new\s+MediaRecorder/],
    androidPermissions: ['<uses-permission android:name="android.permission.RECORD_AUDIO"/>'],
    iosUsageDescriptions: { NSMicrophoneUsageDescription: 'This app uses the microphone to record audio.' },
    macosUsageDescriptions: { NSMicrophoneUsageDescription: 'This app uses the microphone to record audio.' },
    noWiringNeeded: true },
];

const UNSUPPORTED_FEATURES: FeatureDefinition[] = [
  { id: 'bluetooth', label: 'Bluetooth', detectPatterns: [/navigator\.bluetooth/], noFirstPartyPlugin: true },
];

type PackageManager = 'bun' | 'pnpm' | 'yarn' | 'npm';

let cachedPackageManager: PackageManager | null = null;

function detectPackageManager(cwd: string): PackageManager {
  if (cachedPackageManager) return cachedPackageManager;
  const candidates: { name: PackageManager; command: string }[] = [
    { name: 'bun', command: 'bun --version' }, { name: 'pnpm', command: 'pnpm --version' },
    { name: 'yarn', command: 'yarn --version' }, { name: 'npm', command: 'npm --version' },
  ];
  for (const c of candidates) {
    try { execSync(c.command, { stdio: 'ignore', cwd }); cachedPackageManager = c.name; return c.name; } catch { continue; }
  }
  cachedPackageManager = 'npm';
  return 'npm';
}

function installPackages(cwd: string, packages: string[]): void {
  if (packages.length === 0) return;
  const pm = detectPackageManager(cwd);
  const cmd = `${pm} add ${packages.join(' ')}`;
  try {
    execSync(cmd, { cwd, stdio: 'ignore', shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh', timeout: 120_000 });
  } catch {
    log.warn(`Could not auto-install ${packages.join(', ')}. Run manually: ${cmd}`);
  }
}

async function patchCargoToml(tauriDir: string, features: FeatureDefinition[]): Promise<void> {
  const cargoPath = path.join(tauriDir, 'Cargo.toml');
  if (!existsSync(cargoPath)) return;
  const plugins = features.filter((f) => f.rustPlugin).map((f) => f.rustPlugin!);
  if (plugins.length === 0) return;

  try {
    let content = await readFile(cargoPath, 'utf-8');
    let changed = false;
    if (!/\[dependencies\]/.test(content)) return;
    for (const { crate } of plugins) {
      if (new RegExp(`^${crate}\\s*=`, 'm').test(content)) continue;
      content = content.replace(/(\[dependencies\]\s*\n)/, `$1${crate} = "2"\n`);
      changed = true;
    }
    if (changed) await writeFile(cargoPath, content);
  } catch (err) {
    log.warn(`Could not patch Cargo.toml: ${(err as Error).message}`);
  }
}

async function patchLibRs(tauriDir: string, features: FeatureDefinition[]): Promise<void> {
  const candidates = [
    path.join(tauriDir, 'src', 'lib.rs'),
    path.join(tauriDir, 'src', 'main.rs'),
  ];
  const targetPath = candidates.find((p) => existsSync(p) && /tauri::Builder::default\(\)/.test(readFileSync(p, 'utf-8')));

  if (!targetPath) {
    log.warn(`Could not find tauri::Builder::default() in lib.rs or main.rs under ${path.join(tauriDir, 'src')}. Register plugins manually.`);
    return;
  }

  const plugins = features.filter((f) => f.rustPlugin).map((f) => f.rustPlugin!);
  if (plugins.length === 0) return;

  try {
    let content = await readFile(targetPath, 'utf-8');
    let changed = false;

    const anchorRe = /(tauri::Builder::default\(\)[ \t]*\r?\n(?:[ \t]*\.plugin\([^\n]*\)[ \t]*\r?\n)*)/;

    for (const plugin of plugins) {
      const correctCall = `.plugin(${plugin.initExpr ?? `${plugin.rustIdent}::init()`})`;
      const existingLineRe = new RegExp(`^([ \\t]*)\\.plugin\\(${plugin.rustIdent}::[^\\n]*\\)[ \\t]*\\r?\\n`, 'm');
      const existing = content.match(existingLineRe);

      if (existing) {
        if (!existing[0].includes(correctCall)) {
          const indent = existing[1] ?? '        ';
          content = content.replace(existingLineRe, `${indent}${correctCall}\n`);
          changed = true;
          log.info(`Corrected malformed plugin registration for ${plugin.crate} in ${path.basename(targetPath)}.`);
        }
        continue;
      }

      if (!anchorRe.test(content)) break;
      content = content.replace(anchorRe, `$1        ${correctCall}\n`);
      changed = true;
    }

    if (changed) await writeFile(targetPath, content);
  } catch (err) {
    log.warn(`Could not patch ${path.basename(targetPath)}: ${(err as Error).message}`);
  }
}

async function patchCapabilities(tauriDir: string, features: FeatureDefinition[]): Promise<void> {
  const capsPath = path.join(tauriDir, 'capabilities', 'default.json');
  if (!existsSync(capsPath)) return;
  const required = ['core:default', ...features.filter((f) => f.rustPlugin).flatMap((f) => f.rustPlugin!.permissions)];
  if (required.length === 0) return;

  try {
    const raw = await readFile(capsPath, 'utf-8');
    const caps = JSON.parse(raw);
    caps.permissions = Array.isArray(caps.permissions) ? caps.permissions : [];
    let changed = false;
    for (const perm of required) {
      if (!caps.permissions.includes(perm)) { caps.permissions.push(perm); changed = true; }
    }
    if (changed) await writeFile(capsPath, JSON.stringify(caps, null, 2) + '\n');
  } catch (err) {
    log.warn(`Could not patch capabilities/default.json: ${(err as Error).message}`);
  }
}

async function patchAndroidManifest(tauriDir: string, features: FeatureDefinition[]): Promise<void> {
  const manifestPath = path.join(tauriDir, 'gen', 'android', 'app', 'src', 'main', 'AndroidManifest.xml');
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
  await patchPlist(path.join(tauriDir, 'gen', 'apple', 'Sources', 'Info.plist'), ios);
  await patchPlist(path.join(tauriDir, 'Info.plist'), macos);
}

const SCANNABLE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx']);

async function collectSourceFiles(dir: string, out: string[] = []): Promise<string[]> {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    if (['node_modules', 'dist', 'src-tauri'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await collectSourceFiles(full, out);
    else if (SCANNABLE_EXT.has(path.extname(entry.name))) out.push(full);
  }
  return out;
}

function nodeToString(node: any): string {
  if (!node || typeof node !== 'object') return '';
  if (node.type === 'Identifier') return node.name || '';
  if (node.type === 'MemberExpression') {
    const obj = nodeToString(node.object);
    const prop = nodeToString(node.property);
    return obj ? `${obj}.${prop}` : prop;
  }
  if (node.type === 'ImportDeclaration') return node.source?.value || '';
  return '';
}

function walkAstForImports(node: any, foundSpecifiers: Set<string>, depth = 0): void {
  if (!node || typeof node !== 'object' || depth > 200) return;
  if (node.type === 'ImportDeclaration') {
    const src = nodeToString(node);
    if (src) foundSpecifiers.add(src);
  }
  for (const key of Object.keys(node)) {
    if (key === 'parent') continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const item of value) if (item && typeof item === 'object') walkAstForImports(item, foundSpecifiers, depth + 1);
    } else if (value && typeof value === 'object') {
      walkAstForImports(value, foundSpecifiers, depth + 1);
    }
  }
}

async function detectUsedFeatures(projectPath: string): Promise<FeatureDefinition[]> {
  const srcDir = path.join(projectPath, 'src');
  const files = await collectSourceFiles(srcDir);
  const detectable = [...OPTIONAL_FEATURES, ...MANIFEST_ONLY_FEATURES, ...UNSUPPORTED_FEATURES];
  const matched = new Set<string>();

  for (const file of files) {
    if (matched.size === detectable.length) break;
    let content = '';
    try { content = await readFile(file, 'utf-8'); } catch { continue; }

    for (const f of detectable) {
      if (matched.has(f.id)) continue;
      if (f.detectPatterns?.some((p) => p.test(content))) matched.add(f.id);
    }

    try {
      const result = parseSync(content, { sourceType: 'module', sourceFilename: file } as any);
      const imports = new Set<string>();
      walkAstForImports(result.program, imports);
      for (const f of detectable) {
        if (matched.has(f.id)) continue;
        if (f.npmPackage && [...imports].some((i) => i.includes(f.npmPackage!))) matched.add(f.id);
      }
    } catch {
      // regex pass above already covers this file
    }
  }

  return detectable.filter((f) => matched.has(f.id));
}

async function wireFeatures(projectPath: string, features: FeatureDefinition[]): Promise<void> {
  const tauriDir = path.join(projectPath, 'src-tauri');
  if (!existsSync(tauriDir)) return;

  for (const f of features.filter((f) => f.noFirstPartyPlugin)) {
    log.warn(`"${f.id}" detected — no official Tauri plugin exists for this. Skipping automatic wiring.`);
  }
  for (const f of features.filter((f) => f.noWiringNeeded)) {
    log.info(`"${f.id}" detected — no plugin needed (native getUserMedia works in Tauri's webview); wiring platform permission only.`);
  }

  const npmPackages = features.map((f) => f.npmPackage).filter((p): p is string => !!p);
  if (npmPackages.length > 0) installPackages(projectPath, npmPackages);

  const withRustPlugin = features.filter((f) => f.rustPlugin);
  if (withRustPlugin.length > 0) {
    await patchCargoToml(tauriDir, withRustPlugin);
    await patchLibRs(tauriDir, withRustPlugin);
    await patchCapabilities(tauriDir, withRustPlugin);
  }

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

    const importLines = active
      .filter((f) => f.polyfillImports && f.npmPackage)
      .map((f) => `import { ${f.polyfillImports!.join(', ')} } from '${f.npmPackage}';`)
      .join('\n');
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

  if (isFirstRun) log.info('Wiring baseline plugins (opener, dialog, fs, clipboard, notification, os)...');
  await wireFeatures(projectPath, BASELINE_FEATURES);

  const detected = await detectUsedFeatures(projectPath);
  const detectedIds = new Set(detected.map((f) => f.id));

  if (detected.length > 0) {
    if (isFirstRun) log.info(`Detected: ${detected.map((f) => f.label).join(', ')}`);
    await wireFeatures(projectPath, detected);
  }

  const baselinePolyfillable = BASELINE_FEATURES.filter((f) => f.polyfillBody);
  await injectPolyfills(projectPath, [...baselinePolyfillable, ...detected]);
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
    }).catch(() => {});
  }, 400);
}

export function biniNative(): Plugin {
  let wired = false;

  return {
    name: 'bini-native',

    configureServer(_server) {
      return async () => {
        if (wired) return;
        wired = true;
        await runFullWiring(process.cwd(), true);
      };
    },

    async buildStart() {
      if (wired) return;
      wired = true;
      await runFullWiring(process.cwd(), true);
    },

    handleHotUpdate({ file }) {
      if (file.includes(`${path.sep}src${path.sep}`) && /\.(tsx?|jsx?)$/.test(file)) {
        checkForNewFeaturesOnChange(process.cwd());
      }
    },
  };
}