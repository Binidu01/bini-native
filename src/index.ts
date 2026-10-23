// src/index.ts
import type { Plugin } from 'vite';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import crossSpawn from 'cross-spawn';
import path from 'path';

import {
  getSourceFacts,
  scanSourceFacts,
  isClientSourceFile,
  type SourceFacts,
} from 'bini-router';

// ─── Logging ───────────────────────────────────────────────────────────────

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

// ─── Types ─────────────────────────────────────────────────────────────────

type Platform = 'all' | 'desktop' | 'mobile';
type Permission = string | { identifier: string; allow?: unknown[]; deny?: unknown[] };
type Ts = (snippet: string) => string;

interface RustPluginSpec {
  crate: string;
  rustIdent: string;
  permissions: Permission[];
  initExpr?: string;
  platform?: Platform;
  cargoFeatures?: string[];
}

interface FeatureDefinition {
  id: string;
  label: string;
  rustPlugin?: RustPluginSpec;
  npmPackage?: string;
  detect?: (facts: SourceFacts) => boolean;
  androidPermissions?: string[];
  iosUsageDescriptions?: Record<string, string>;
  macosUsageDescriptions?: Record<string, string>;
  polyfillImports?: Array<{ name: string; from: string; as: string }>;
  polyfillBody?: (t: Ts) => string;
  windowTypes?: string[];
  noFirstPartyPlugin?: boolean;
  hint?: string;
  note?: string;
  dependsOn?: string[];
}

type PluginOptions =
  Partial<Omit<FeatureDefinition, 'id' | 'label' | 'rustPlugin' | 'npmPackage' | 'polyfillImports'>> & {
    permissions?: Permission[];
    initExpr?: string;
    platform?: Platform;
    cargoFeatures?: string[];
    polyfillImports?: Array<[string, string]>;
  };

function tauriPlugin(slug: string, label: string, o: PluginOptions = {}): FeatureDefinition {
  const { permissions, initExpr, platform, cargoFeatures, polyfillImports, ...rest } = o;
  const crate = `tauri-plugin-${slug}`;
  return {
    id: slug,
    label,
    rustPlugin: {
      crate,
      rustIdent: crate.replace(/-/g, '_'),
      permissions: permissions ?? [`${slug}:default`],
      initExpr,
      platform,
      cargoFeatures,
    },
    npmPackage: `@tauri-apps/plugin-${slug}`,
    polyfillImports: polyfillImports?.map(([name, as]) => ({ name, from: `@tauri-apps/plugin-${slug}`, as })),
    ...rest,
  };
}

// ─── Facts helpers ─────────────────────────────────────────────────────────

const GLOBAL_PREFIXES = ['', 'window.', 'globalThis.', 'self.'] as const;

function hasRef(facts: SourceFacts, ...names: string[]): boolean {
  for (const name of names)
    for (const prefix of GLOBAL_PREFIXES)
      if (facts.refs.has(prefix + name)) return true;
  return false;
}

function hasCall(facts: SourceFacts, ...names: string[]): boolean {
  for (const name of names)
    for (const prefix of GLOBAL_PREFIXES)
      if (facts.calls.has(prefix + name)) return true;
  return false;
}

function hasNew(facts: SourceFacts, ...names: string[]): boolean {
  for (const name of names)
    for (const prefix of GLOBAL_PREFIXES)
      if (facts.news.has(prefix + name)) return true;
  return false;
}

function hasJsxAttr(facts: SourceFacts, tag: string, attr: string, value?: string): boolean {
  if (value === undefined) return facts.jsxAttrs.has(`${tag}:${attr}`);
  return facts.jsxAttrs.has(`${tag}:${attr}=${value}`);
}

function fetchesRemoteUrl(facts: SourceFacts): boolean {
  for (const prefix of GLOBAL_PREFIXES) {
    const args = facts.calls.get(prefix + 'fetch');
    if (args?.some((a) => /^https?:\/\//.test(a))) return true;
  }
  return false;
}

function importsPackage(facts: SourceFacts, pkg: string): boolean {
  for (const imp of facts.imports) if (imp === pkg || imp.startsWith(pkg + '/')) return true;
  return false;
}

// ─── Feature catalogue ─────────────────────────────────────────────────────

const PLUGIN_FEATURES: FeatureDefinition[] = [
  tauriPlugin('opener', 'Opener', {
    detect: (f) =>
      importsPackage(f, '@tauri-apps/plugin-opener') ||
      hasCall(f, 'openUrl') ||
      f.calls.has('window.open') ||
      hasJsxAttr(f, 'a', 'target', '_blank') ||
      f.props.has('target=_blank'),
    polyfillImports: [['openUrl', 'biniOpenUrl']],
    windowTypes: ['__BINI_OPENER_POLYFILLED__?: boolean;'],
    polyfillBody: (t) => `
    if (!window.__BINI_OPENER_POLYFILLED__) {
      window.__BINI_OPENER_POLYFILLED__ = true;
      const biniIsExternalUrl = (href${t(': string')}) => {
        try {
          const u = new URL(href, window.location.href);
          if (u.protocol === 'mailto:' || u.protocol === 'tel:') return true;
          return (u.protocol === 'http:' || u.protocol === 'https:') && u.origin !== window.location.origin;
        } catch { return false; }
      };
      const biniOpenExternal = (href${t(': string')}) => {
        biniOpenUrl(href).catch((err${t(': any')}) => console.warn('[bini-native] openUrl failed:', err));
      };
      const biniOrigOpen = window.open.bind(window);
      (window${t(' as any')}).open = (url${t('?: any')}, target${t('?: any')}, ...rest${t(': any[]')}) => {
        const href = url == null ? '' : String(url);
        const isNewTab = target === '_blank' || target == null;
        const hasFeatures = typeof rest[0] === 'string' && rest[0].length > 0;
        if (href && isNewTab && !hasFeatures && biniIsExternalUrl(href)) {
          biniOpenExternal(href);
          return null;
        }
        return (biniOrigOpen${t(' as any')})(url, target, ...rest);
      };
      document.addEventListener('click', (e${t(': MouseEvent')}) => {
        if (e.defaultPrevented || e.button !== 0) return;
        const target = e.target${t(' as HTMLElement | null')};
        const a = target?.closest?.('a[href]')${t(' as HTMLAnchorElement | null')};
        if (!a || a.hasAttribute('download') || !biniIsExternalUrl(a.href)) return;
        const interactive = target?.closest?.('button, input, select, textarea, [role="button"], [data-no-opener]');
        if (interactive && interactive !== a) return;
        e.preventDefault();
        biniOpenExternal(a.href);
      });
    }`,
  }),

  tauriPlugin('dialog', 'Dialog', {
    detect: (f) =>
      importsPackage(f, '@tauri-apps/plugin-dialog') ||
      hasCall(f, 'showOpenFilePicker', 'showSaveFilePicker'),
    polyfillImports: [
      ['open', 'biniDialogOpen'],
      ['save', 'biniDialogSave'],
    ],
    windowTypes: [
      '__BINI_DIALOG_POLYFILLED__?: boolean;',
      'showOpenFilePicker?: (options?: any) => Promise<any[]>;',
      'showSaveFilePicker?: (options?: any) => Promise<any>;',
    ],
    polyfillBody: (t) => `
    if (!window.__BINI_DIALOG_POLYFILLED__) {
      window.__BINI_DIALOG_POLYFILLED__ = true;
      if (!window.showOpenFilePicker) {
        window.showOpenFilePicker = async (options${t('?: any')}) => {
          try {
            const result = await biniDialogOpen({ multiple: options?.multiple ?? false });
            if (!result) return [];
            const paths = Array.isArray(result) ? result : [result];
            return paths.map((p${t(': string')}) => ({
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
        window.showSaveFilePicker = async (options${t('?: any')}) => {
          try {
            const result = await biniDialogSave({ title: options?.suggestedName ?? 'Save File' });
            if (!result) return null;
            return {
              kind: 'file', name: result.split('/').pop() || result,
              createWritable: async () => ({
                write: async (chunk${t(': string | Uint8Array')}) => {
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
    }`,
  }),

  tauriPlugin('fs', 'File System', {
    detect: (f) =>
      importsPackage(f, '@tauri-apps/plugin-fs') ||
      hasCall(f, 'readTextFile', 'writeTextFile', 'readFile', 'writeFile', 'mkdir', 'remove', 'exists', 'readDir', 'stat', 'copyFile', 'rename'),
  }),

  tauriPlugin('clipboard-manager', 'Clipboard', {
    permissions: ['clipboard-manager:allow-read-text', 'clipboard-manager:allow-write-text'],
    detect: (f) =>
      importsPackage(f, '@tauri-apps/plugin-clipboard-manager') ||
      hasRef(f, 'navigator.clipboard.writeText', 'navigator.clipboard.readText'),
    polyfillImports: [
      ['writeText', 'biniClipboardWriteText'],
      ['readText', 'biniClipboardReadText'],
    ],
    windowTypes: ['__BINI_CLIPBOARD_POLYFILLED__?: boolean;'],
    polyfillBody: (t) => `
    if (!window.__BINI_CLIPBOARD_POLYFILLED__) {
      window.__BINI_CLIPBOARD_POLYFILLED__ = true;
      if (navigator.clipboard) {
        navigator.clipboard.writeText = async (text${t(': string')}) => {
          try { await biniClipboardWriteText(text); } catch (err) { console.warn('[bini-native] clipboard write failed:', err); throw err; }
        };
        navigator.clipboard.readText = async () => {
          try { return await biniClipboardReadText(); } catch (err) { console.warn('[bini-native] clipboard read failed:', err); throw err; }
        };
      }
    }`,
  }),

  tauriPlugin('notification', 'Notification', {
    detect: (f) =>
      importsPackage(f, '@tauri-apps/plugin-notification') ||
      hasNew(f, 'Notification') ||
      hasRef(f, 'Notification.requestPermission'),
    androidPermissions: ['<uses-permission android:name="android.permission.POST_NOTIFICATIONS"/>'],
    polyfillImports: [
      ['isPermissionGranted', 'biniIsNotificationPermissionGranted'],
      ['requestPermission', 'biniRequestNotificationPermission'],
      ['sendNotification', 'biniSendNotification'],
    ],
    windowTypes: ['__BINI_NOTIFICATION_POLYFILLED__?: boolean;'],
    polyfillBody: (t) => `
    if (!window.__BINI_NOTIFICATION_POLYFILLED__) {
      window.__BINI_NOTIFICATION_POLYFILLED__ = true;
      class BiniNotification {
        title${t(': string')} = '';
        body${t(': string')} = '';
        constructor(title${t(': string')}, options${t('?: NotificationOptions')}) {
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
      (BiniNotification${t(' as any')}).permission = 'default';
      window.Notification = BiniNotification${t(' as any')};
    }`,
  }),

  tauriPlugin('os', 'OS Info', {
    detect: (f) =>
      importsPackage(f, '@tauri-apps/plugin-os') ||
      hasCall(f, 'platform', 'version', 'arch', 'type', 'family', 'hostname', 'locale', 'eol'),
  }),

  tauriPlugin('geolocation', 'Geolocation', {
    permissions: [
      'geolocation:allow-check-permissions',
      'geolocation:allow-request-permissions',
      'geolocation:allow-get-current-position',
      'geolocation:allow-watch-position',
      'geolocation:allow-clear-watch',
    ],
    detect: (f) =>
      importsPackage(f, '@tauri-apps/plugin-geolocation') ||
      hasRef(f, 'navigator.geolocation'),
    androidPermissions: [
      '<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION"/>',
      '<uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION"/>',
    ],
    iosUsageDescriptions: { NSLocationWhenInUseUsageDescription: 'This app uses your location to provide relevant features.' },
    macosUsageDescriptions: { NSLocationUsageDescription: 'This app uses your location to provide relevant features.' },
    polyfillImports: [
      ['checkPermissions', 'biniGeoCheckPermissions'],
      ['requestPermissions', 'biniGeoRequestPermissions'],
      ['getCurrentPosition', 'biniGeoGetCurrentPosition'],
      ['watchPosition', 'biniGeoWatchPosition'],
      ['clearWatch', 'biniGeoClearWatch'],
    ],
    windowTypes: ['__BINI_GEOLOCATION_POLYFILLED__?: boolean;'],
    polyfillBody: (t) => `
    if (!window.__BINI_GEOLOCATION_POLYFILLED__) {
      window.__BINI_GEOLOCATION_POLYFILLED__ = true;
      const biniEnsureLocationPermission = async () => {
        let p = await biniGeoCheckPermissions();
        if (p.location === 'prompt' || p.location === 'prompt-with-rationale') p = await biniGeoRequestPermissions(['location']);
        return p.location === 'granted';
      };
      if (navigator.geolocation) {
        (navigator.geolocation${t(' as any')}).getCurrentPosition = async (success${t(': any')}, error${t(': any')}) => {
          try {
            if (!(await biniEnsureLocationPermission())) { if (error) error({ code: 1, message: 'Permission denied' }); return; }
            success(await biniGeoGetCurrentPosition());
          } catch (err${t(': any')}) { console.warn('[bini-native] getCurrentPosition failed:', err); if (error) error(err); }
        };
        (navigator.geolocation${t(' as any')}).watchPosition = (success${t(': any')}, error${t(': any')}, options${t('?: any')}) => {
          let watchId = -1;
          (async () => {
            try {
              if (!(await biniEnsureLocationPermission())) { if (error) error({ code: 1, message: 'Permission denied' }); return; }
              watchId = await biniGeoWatchPosition(options ?? {}, (position${t(': any')}) => { if (position) success(position); });
            } catch (err${t(': any')}) { console.warn('[bini-native] watchPosition failed:', err); if (error) error(err); }
          })();
          return watchId;
        };
        (navigator.geolocation${t(' as any')}).clearWatch = (watchId${t(': any')}) => { biniGeoClearWatch(watchId).catch((err${t(': any')}) => console.warn('[bini-native] clearWatch failed:', err)); };
      }
    }`,
  }),

  tauriPlugin('http', 'HTTP Client', {
    permissions: [{
      identifier: 'http:default',
      allow: [{ url: 'https://*' }, { url: 'https://*:*' }, { url: 'http://*' }, { url: 'http://*:*' }],
    }],
    detect: (f) =>
      importsPackage(f, '@tauri-apps/plugin-http') ||
      fetchesRemoteUrl(f),
    note: 'http: the scaffolded capability allows every http(s) URL. Tighten the scope in capabilities/default.json for production.',
    polyfillImports: [['fetch', 'biniHttpFetch']],
    windowTypes: ['__BINI_HTTP_POLYFILLED__?: boolean;'],
    polyfillBody: (t) => `
    if (!window.__BINI_HTTP_POLYFILLED__) {
      window.__BINI_HTTP_POLYFILLED__ = true;
      const biniNativeFetch = window.fetch.bind(window);
      const biniIsRemote = (input${t(': any')}) => {
        try {
          const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
          const u = new URL(raw, window.location.href);
          if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
          const h = u.hostname;
          if (h === 'localhost' || h.endsWith('.localhost') || h === '127.0.0.1' || h === '[::1]' || h === '::1') return false;
          return u.origin !== window.location.origin;
        } catch { return false; }
      };
      window.fetch = ((input${t(': any')}, init${t('?: any')}) =>
        biniIsRemote(input) ? biniHttpFetch(input, init) : biniNativeFetch(input, init))${t(' as typeof fetch')};
    }`,
  }),

  tauriPlugin('haptics', 'Haptics', {
    platform: 'mobile',
    permissions: [
      'haptics:allow-vibrate',
      'haptics:allow-impact-feedback',
      'haptics:allow-notification-feedback',
      'haptics:allow-selection-feedback',
    ],
    detect: (f) =>
      importsPackage(f, '@tauri-apps/plugin-haptics') ||
      hasCall(f, 'navigator.vibrate'),
    androidPermissions: ['<uses-permission android:name="android.permission.VIBRATE"/>'],
    polyfillImports: [['vibrate', 'biniHapticsVibrate']],
    windowTypes: ['__BINI_HAPTICS_POLYFILLED__?: boolean;'],
    polyfillBody: (t) => `
    if (!window.__BINI_HAPTICS_POLYFILLED__ && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)) {
      window.__BINI_HAPTICS_POLYFILLED__ = true;
      (navigator${t(' as any')}).vibrate = (pattern${t(': number | number[]')}) => {
        const ms = Array.isArray(pattern)
          ? pattern.reduce((sum, v, i) => (i % 2 === 0 ? sum + v : sum), 0)
          : Number(pattern);
        if (ms > 0) biniHapticsVibrate(ms).catch((err${t(': any')}) => console.warn('[bini-native] vibrate failed:', err));
        return true;
      };
    }`,
  }),

  tauriPlugin('global-shortcut', 'Global Shortcut', {
    platform: 'desktop',
    permissions: ['global-shortcut:allow-register', 'global-shortcut:allow-unregister', 'global-shortcut:allow-is-registered'],
    initExpr: 'tauri_plugin_global_shortcut::Builder::new().build()',
    detect: (f) =>
      importsPackage(f, '@tauri-apps/plugin-global-shortcut') ||
      hasRef(f, 'registerGlobalShortcut'),
    polyfillImports: [
      ['register', 'biniShortcutRegister'],
      ['unregister', 'biniShortcutUnregister'],
      ['isRegistered', 'biniShortcutIsRegistered'],
    ],
    windowTypes: [
      '__BINI_SHORTCUT_POLYFILLED__?: boolean;',
      'registerGlobalShortcut?: (shortcut: string, callback: () => void) => Promise<void>;',
      'unregisterGlobalShortcut?: (shortcut: string) => Promise<void>;',
      'isGlobalShortcutRegistered?: (shortcut: string) => Promise<boolean>;',
    ],
    polyfillBody: (t) => `
    if (!window.__BINI_SHORTCUT_POLYFILLED__) {
      window.__BINI_SHORTCUT_POLYFILLED__ = true;
      window.registerGlobalShortcut = async (shortcut${t(': string')}, callback${t(': () => void')}) => {
        try { await biniShortcutRegister(shortcut, (event${t(': any')}) => { if (event.state === 'Pressed') callback(); }); }
        catch (err) { console.warn('[bini-native] register shortcut failed:', err); }
      };
      window.unregisterGlobalShortcut = async (shortcut${t(': string')}) => {
        try { await biniShortcutUnregister(shortcut); } catch (err) { console.warn('[bini-native] unregister shortcut failed:', err); }
      };
      window.isGlobalShortcutRegistered = async (shortcut${t(': string')}) => {
        try { return await biniShortcutIsRegistered(shortcut); } catch (err) { console.warn('[bini-native] check shortcut failed:', err); return false; }
      };
    }`,
  }),

  tauriPlugin('autostart', 'Autostart', {
    platform: 'desktop',
    permissions: ['autostart:allow-enable', 'autostart:allow-disable', 'autostart:allow-is-enabled'],
    initExpr: 'tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None)',
    detect: (f) =>
      importsPackage(f, '@tauri-apps/plugin-autostart') ||
      hasRef(f, 'setAutoStart', 'isAutoStartEnabled'),
    polyfillImports: [
      ['enable', 'biniAutostartEnable'],
      ['disable', 'biniAutostartDisable'],
      ['isEnabled', 'biniAutostartIsEnabled'],
    ],
    windowTypes: [
      '__BINI_AUTOSTART_POLYFILLED__?: boolean;',
      'setAutoStart?: (enabled: boolean) => Promise<void>;',
      'isAutoStartEnabled?: () => Promise<boolean>;',
    ],
    polyfillBody: (t) => `
    if (!window.__BINI_AUTOSTART_POLYFILLED__) {
      window.__BINI_AUTOSTART_POLYFILLED__ = true;
      window.setAutoStart = async (enabled${t(': boolean')}) => {
        try { if (enabled) await biniAutostartEnable(); else await biniAutostartDisable(); }
        catch (err) { console.warn('[bini-native] set autostart failed:', err); }
      };
      window.isAutoStartEnabled = async () => {
        try { return await biniAutostartIsEnabled(); } catch (err) { console.warn('[bini-native] check autostart failed:', err); return false; }
      };
    }`,
  }),

  tauriPlugin('updater', 'Updater', {
    platform: 'desktop',
    initExpr: 'tauri_plugin_updater::Builder::new().build()',
    detect: (f) => importsPackage(f, '@tauri-apps/plugin-updater'),
    note: 'updater: also needs "plugins.updater" (pubkey + endpoints) and "bundle.createUpdaterArtifacts" in tauri.conf.json.',
  }),
  tauriPlugin('window-state', 'Window State', {
    platform: 'desktop',
    initExpr: 'tauri_plugin_window_state::Builder::default().build()',
    detect: (f) => importsPackage(f, '@tauri-apps/plugin-window-state'),
  }),
  tauriPlugin('positioner', 'Positioner', {
    platform: 'desktop',
    detect: (f) => importsPackage(f, '@tauri-apps/plugin-positioner'),
  }),
  tauriPlugin('cli', 'CLI Arguments', {
    platform: 'desktop',
    detect: (f) =>
      importsPackage(f, '@tauri-apps/plugin-cli') ||
      hasRef(f, 'getMatches'),
    note: 'cli: define arguments under "plugins.cli" in tauri.conf.json.',
  }),

  tauriPlugin('biometric', 'Biometric', {
    platform: 'mobile',
    androidPermissions: ['<uses-permission android:name="android.permission.USE_BIOMETRIC"/>'],
    iosUsageDescriptions: { NSFaceIDUsageDescription: 'This app uses Face ID to authenticate you.' },
    detect: (f) => importsPackage(f, '@tauri-apps/plugin-biometric'),
  }),
  tauriPlugin('barcode-scanner', 'Barcode Scanner', {
    platform: 'mobile',
    detect: (f) => importsPackage(f, '@tauri-apps/plugin-barcode-scanner'),
  }),
  tauriPlugin('nfc', 'NFC', {
    platform: 'mobile',
    androidPermissions: ['<uses-permission android:name="android.permission.NFC"/>'],
    detect: (f) => importsPackage(f, '@tauri-apps/plugin-nfc'),
    note: 'nfc: iOS also needs the NFC entitlement/capability enabled in Xcode.',
  }),

  tauriPlugin('shell', 'Shell', {
    detect: (f) =>
      importsPackage(f, '@tauri-apps/plugin-shell') ||
      hasCall(f, 'Command.create', 'Command.sidecar'),
  }),
  tauriPlugin('process', 'Process', {
    detect: (f) =>
      importsPackage(f, '@tauri-apps/plugin-process') ||
      hasCall(f, 'exit', 'relaunch'),
  }),
  tauriPlugin('log', 'Logging', {
    initExpr: 'tauri_plugin_log::Builder::new().build()',
    detect: (f) => importsPackage(f, '@tauri-apps/plugin-log'),
  }),
  tauriPlugin('sql', 'SQL', {
    permissions: ['sql:default', 'sql:allow-execute'],
    initExpr: 'tauri_plugin_sql::Builder::default().build()',
    cargoFeatures: ['sqlite'],
    detect: (f) =>
      importsPackage(f, '@tauri-apps/plugin-sql') ||
      hasCall(f, 'Database.load'),
    note: 'sql: enabled the "sqlite" driver in Cargo.toml. Switch the feature to "mysql" or "postgres" if you need those.',
  }),
  tauriPlugin('upload', 'Upload / Download', {
    detect: (f) => importsPackage(f, '@tauri-apps/plugin-upload'),
  }),
  tauriPlugin('websocket', 'WebSocket', {
    detect: (f) => importsPackage(f, '@tauri-apps/plugin-websocket'),
  }),
  tauriPlugin('deep-link', 'Deep Link', {
    detect: (f) => importsPackage(f, '@tauri-apps/plugin-deep-link'),
    note: 'deep-link: register your schemes/hosts under "plugins.deep-link" in tauri.conf.json.',
  }),
  tauriPlugin('store', 'Persistent Store', {
    initExpr: 'tauri_plugin_store::Builder::default().build()',
    detect: (f) =>
      importsPackage(f, '@tauri-apps/plugin-store') ||
      hasRef(f, 'biniStore'),
    polyfillImports: [['load', 'biniStoreLoad']],
    windowTypes: [
      '__BINI_STORE_POLYFILLED__?: boolean;',
      `biniStore?: {
      get: (key: string) => Promise<any>;
      set: (key: string, value: any) => Promise<void>;
      delete: (key: string) => Promise<void>;
      clear: () => Promise<void>;
    };`,
    ],
    polyfillBody: (t) => `
    if (!window.__BINI_STORE_POLYFILLED__) {
      window.__BINI_STORE_POLYFILLED__ = true;
      let biniStoreInstance${t(': any')} = null;
      const biniGetStore = async () => { if (!biniStoreInstance) biniStoreInstance = await biniStoreLoad('bini-store.json', { autoSave: true }${t(' as any')}); return biniStoreInstance; };
      window.biniStore = {
        get: async (key${t(': string')}) => { try { return await (await biniGetStore()).get(key); } catch (err) { console.warn('[bini-native] store get failed:', err); return null; } },
        set: async (key${t(': string')}, value${t(': any')}) => { try { await (await biniGetStore()).set(key, value); } catch (err) { console.warn('[bini-native] store set failed:', err); } },
        delete: async (key${t(': string')}) => { try { await (await biniGetStore()).delete(key); } catch (err) { console.warn('[bini-native] store delete failed:', err); } },
        clear: async () => { try { await (await biniGetStore()).clear(); } catch (err) { console.warn('[bini-native] store clear failed:', err); } },
      };
    }`,
  }),
];

const UNSUPPORTED_FEATURES: FeatureDefinition[] = [
  { id: 'bluetooth', label: 'Web Bluetooth', detect: (f) => hasRef(f, 'navigator.bluetooth'), noFirstPartyPlugin: true, hint: 'Look at community BLE plugins (e.g. tauri-plugin-blec).' },
  { id: 'usb', label: 'WebUSB', detect: (f) => hasRef(f, 'navigator.usb'), noFirstPartyPlugin: true, hint: 'Use a custom Rust command or a community plugin.' },
  { id: 'serial', label: 'Web Serial', detect: (f) => hasRef(f, 'navigator.serial'), noFirstPartyPlugin: true, hint: 'Use a custom Rust command (e.g. with the serialport crate).' },
  { id: 'hid', label: 'WebHID', detect: (f) => hasRef(f, 'navigator.hid'), noFirstPartyPlugin: true, hint: 'Use a custom Rust command or a community plugin.' },
  { id: 'share', label: 'Web Share', detect: (f) => hasCall(f, 'navigator.share'), noFirstPartyPlugin: true, hint: 'Use a community share-sheet plugin or a custom command.' },
];

const DETECTABLE: FeatureDefinition[] = [...PLUGIN_FEATURES, ...UNSUPPORTED_FEATURES];

// ─── Package manager detection ─────────────────────────────────────────────

type PackageManager = 'bun' | 'pnpm' | 'yarn' | 'npm';
let cachedPackageManager: PackageManager | null = null;

const LOCK_FILES: { file: string; pm: PackageManager }[] = [
  { file: 'bun.lockb', pm: 'bun' },
  { file: 'bun.lock', pm: 'bun' },
  { file: 'pnpm-lock.yaml', pm: 'pnpm' },
  { file: 'yarn.lock', pm: 'yarn' },
  { file: 'package-lock.json', pm: 'npm' },
];

const MAX_WORKSPACE_WALK = 5;

function findLockFileUpwards(startDir: string): PackageManager | null {
  let dir = startDir;
  for (let i = 0; i < MAX_WORKSPACE_WALK; i++) {
    for (const { file, pm } of LOCK_FILES) if (existsSync(path.join(dir, file))) return pm;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    if (!existsSync(path.join(parent, 'package.json'))) break;
    dir = parent;
  }
  return null;
}

function detectPackageManager(cwd: string): PackageManager {
  if (cachedPackageManager) return cachedPackageManager;
  const fromLock = findLockFileUpwards(cwd);
  if (fromLock) return (cachedPackageManager = fromLock);
  const candidates: { name: PackageManager; bin: string; args: string[] }[] = [
    { name: 'bun', bin: 'bun', args: ['--version'] },
    { name: 'pnpm', bin: 'pnpm', args: ['--version'] },
    { name: 'yarn', bin: 'yarn', args: ['--version'] },
    { name: 'npm', bin: 'npm', args: ['--version'] },
  ];
  for (const c of candidates) {
    const result = crossSpawn.sync(c.bin, c.args, { stdio: 'ignore', cwd, windowsHide: true });
    if (!result.error && result.status === 0) return (cachedPackageManager = c.name);
  }
  return (cachedPackageManager = 'npm');
}

function isValidPackageName(name: string): boolean {
  return /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i.test(name);
}

function isPackageInstalled(cwd: string, name: string): boolean {
  try { return existsSync(path.join(cwd, 'node_modules', name, 'package.json')); } catch { return false; }
}

function pickInstallable(cwd: string, packages: string[]): string[] {
  const valid = packages.filter(isValidPackageName);
  const invalid = packages.filter((p) => !isValidPackageName(p));
  if (invalid.length > 0) log.warn(`Refusing to install unexpected package name(s): ${invalid.join(', ')}`);
  return valid.filter((p) => !isPackageInstalled(cwd, p));
}

const activeInstalls = new Set<ReturnType<typeof crossSpawn>>();
let installCleanupRegistered = false;

function registerInstallCleanup(): void {
  if (installCleanupRegistered) return;
  installCleanupRegistered = true;
  const killActive = () => { for (const c of activeInstalls) { try { c.kill(); } catch {} } };
  process.once('exit', killActive);
  process.once('SIGINT', () => { killActive(); process.exit(130); });
  process.once('SIGTERM', () => { killActive(); process.exit(143); });
}

async function installPackages(cwd: string, packages: string[]): Promise<void> {
  const toInstall = pickInstallable(cwd, packages);
  if (toInstall.length === 0) return;
  const pm = detectPackageManager(cwd);
  registerInstallCleanup();
  await new Promise<void>((resolve) => {
    const child = crossSpawn(pm, ['add', ...toInstall], { cwd, stdio: 'ignore', windowsHide: true });
    activeInstalls.add(child);
    const timer = setTimeout(() => child.kill(), 120_000);
    const done = () => { clearTimeout(timer); activeInstalls.delete(child); resolve(); };
    child.on('error', done);
    child.on('exit', (code) => {
      if (code !== 0) log.warn(`Could not auto-install ${toInstall.join(', ')}. Run manually: ${pm} add ${toInstall.join(' ')}`);
      else log.success(`Installed: ${toInstall.join(', ')}. Restart 'tauri dev' to pick it up.`);
      done();
    });
  });
}

function installPackagesSync(cwd: string, packages: string[]): void {
  const toInstall = pickInstallable(cwd, packages);
  if (toInstall.length === 0) return;
  const pm = detectPackageManager(cwd);
  try {
    log.info(`Installing: ${toInstall.join(', ')}`);
    const result = crossSpawn.sync(pm, ['add', ...toInstall], { stdio: 'inherit', cwd, timeout: 120000, windowsHide: true });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`exited with code ${result.status}`);
    log.success(`Successfully installed: ${toInstall.join(', ')}`);
  } catch {
    log.warn(`Could not auto-install ${toInstall.join(', ')}. Run manually: ${pm} add ${toInstall.join(' ')}`);
  }
}

// ─── Feature index ─────────────────────────────────────────────────────────

const fileIndex = new Map<string, Set<string>>();
let scanned = false;

function indexFacts(file: string, facts: SourceFacts): void {
  const ids = new Set<string>();
  for (const f of DETECTABLE) {
    if (f.detect?.(facts)) ids.add(f.id);
  }
  fileIndex.set(file, ids);
}

function resolveFeatures(): FeatureDefinition[] {
  const matched = new Set<string>();
  for (const ids of fileIndex.values()) for (const id of ids) matched.add(id);

  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const f of DETECTABLE) {
      if (!matched.has(f.id) || !f.dependsOn) continue;
      for (const dep of f.dependsOn) if (!matched.has(dep)) { matched.add(dep); expanded = true; }
    }
  }
  return DETECTABLE.filter((f) => matched.has(f.id));
}

function scanProject(projectPath: string): void {
  if (scanned) return;
  fileIndex.clear();
  for (const [file, f] of scanSourceFacts(projectPath)) indexFacts(file, f);
  scanned = true;
}

function getRustPlugins(features: FeatureDefinition[]): RustPluginSpec[] {
  const result: RustPluginSpec[] = [];
  for (const f of features) if (f.rustPlugin) result.push(f.rustPlugin);
  return result;
}

function byPlatform(plugins: RustPluginSpec[], platform: Platform): RustPluginSpec[] {
  return plugins.filter((p) => (p.platform ?? 'all') === platform);
}

function assertPathInside(root: string, target: string): void {
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Refusing to write outside of project root: ${target}`);
  }
}

// ─── Tauri CLI preflight ───────────────────────────────────────────────────

let tauriCliChecked: boolean | null = null;

function ensureTauriCli(cwd: string): boolean {
  if (tauriCliChecked !== null) return tauriCliChecked;

  const probe = crossSpawn.sync('cargo', ['tauri', '--version'], { cwd, stdio: 'ignore', windowsHide: true });
  if (!probe.error && probe.status === 0) return (tauriCliChecked = true);

  log.warn('Tauri CLI (cargo-tauri) not found. Installing it now…');
  log.info('This may take a few minutes while Rust compiles the CLI.');

  const install = crossSpawn.sync(
    'cargo',
    ['install', 'tauri-cli', '--version', '^2', '--locked'],
    { cwd, stdio: 'inherit', timeout: 600_000, windowsHide: true },
  );
  if (install.error || install.status !== 0) {
    log.error('Auto-install of tauri-cli failed. Install manually:\n    cargo install tauri-cli --version "^2" --locked');
    return (tauriCliChecked = false);
  }
  const verify = crossSpawn.sync('cargo', ['tauri', '--version'], { cwd, stdio: 'ignore', windowsHide: true });
  if (verify.error || verify.status !== 0) {
    log.error('tauri-cli installed but `cargo tauri` still fails. Check that ~/.cargo/bin is on PATH.');
    return (tauriCliChecked = false);
  }
  log.success('Tauri CLI installed successfully.');
  return (tauriCliChecked = true);
}

// ─── Rust wiring ───────────────────────────────────────────────────────────

function runTauriCli(args: string[], cwd: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const child = crossSpawn('cargo', ['tauri', ...args], { cwd, stdio: 'pipe', windowsHide: true });
    let stderr = '';
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
    const timer = setTimeout(() => child.kill(), 120_000);
    child.on('error', () => { clearTimeout(timer); resolve(false); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve(true);
      if (stderr.includes('already') || stderr.includes('not found') || stderr.includes('does not exist')) return resolve(true);
      log.warn(`tauri ${args.join(' ')} exited with ${code}. ${stderr.trim()}`);
      resolve(false);
    });
  });
}

async function addTauriPlugin(tauriDir: string, plugin: RustPluginSpec): Promise<boolean> {
  const slug = plugin.crate.replace(/^tauri-plugin-/, '');
  log.info(`Adding ${plugin.crate} via tauri add`);
  return runTauriCli(['add', slug], tauriDir);
}

function addCargoDependencyTargeted(tauriDir: string, plugin: RustPluginSpec): Promise<boolean> {
  const cargoPath = path.join(tauriDir, 'Cargo.toml');
  if (!existsSync(cargoPath)) return Promise.resolve(false);
  const args: string[] = ['add', `${plugin.crate}@2`, '--manifest-path', cargoPath];
  if (plugin.platform === 'desktop') args.push('--target', 'cfg(not(any(target_os = "android", target_os = "ios")))');
  else if (plugin.platform === 'mobile') args.push('--target', 'cfg(any(target_os = "android", target_os = "ios"))');
  if (plugin.cargoFeatures?.length) args.push('--features', plugin.cargoFeatures.join(','));

  return new Promise<boolean>((resolve) => {
    const child = crossSpawn('cargo', args, { cwd: tauriDir, stdio: 'pipe', windowsHide: true });
    let stderr = '';
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
    const timer = setTimeout(() => child.kill(), 60_000);
    child.on('error', () => { clearTimeout(timer); resolve(false); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve(true);
      if (stderr.includes('already exists') || stderr.includes('updating')) return resolve(true);
      log.warn(`cargo add ${plugin.crate} exited with ${code}. ${stderr.trim()}`);
      resolve(false);
    });
  });
}

const pluginCall = (p: RustPluginSpec) => `.plugin(${p.initExpr ?? `${p.rustIdent}::init()`})`;

function findMatchingBrace(content: string, openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < content.length; i++) {
    if (content[i] === '{') depth++;
    else if (content[i] === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

const PLATFORM_BLOCKS = {
  desktop: { start: '/* @bini-native:desktop-plugins */', end: '/* @bini-native:end-desktop-plugins */', cfg: '#[cfg(desktop)]' },
  mobile: { start: '/* @bini-native:mobile-plugins */', end: '/* @bini-native:end-mobile-plugins */', cfg: '#[cfg(mobile)]' },
} as const;

async function patchLibRsTargeted(tauriDir: string, plugins: RustPluginSpec[], platform: 'desktop' | 'mobile'): Promise<void> {
  if (plugins.length === 0) return;
  const candidates = [path.join(tauriDir, 'src', 'lib.rs'), path.join(tauriDir, 'src', 'main.rs')];
  const targetPath = candidates.find((p) => existsSync(p));
  if (!targetPath) return;

  assertPathInside(tauriDir, targetPath);

  const { start, end, cfg } = PLATFORM_BLOCKS[platform];
  let content = await readFile(targetPath, 'utf-8');

  const setupRe = /\.setup\(\s*(?:move\s*)?\|\s*(\w+)\s*(?::[^|]*)?\|\s*\{/;
  let setupMatch = content.match(setupRe);
  if (!setupMatch) {
    const runMatch = content.match(/\.run\(tauri::generate_context!\(\)\)/);
    if (!runMatch || runMatch.index === undefined) return;
    const lineStart = content.lastIndexOf('\n', runMatch.index) + 1;
    const lead = content.slice(lineStart, runMatch.index);
    const indent = lead.trim() === '' ? lead : '    ';
    content = content.slice(0, runMatch.index) + `.setup(|app| {\n${indent}  Ok(())\n${indent}})\n${indent}` + content.slice(runMatch.index);
    setupMatch = content.match(setupRe)!;
  }

  const appVar = setupMatch[1];
  const openBraceIndex = setupMatch.index! + setupMatch[0].length - 1;
  const closeBraceIndex = findMatchingBrace(content, openBraceIndex);
  if (closeBraceIndex === -1) return;

  let body = content.slice(openBraceIndex + 1, closeBraceIndex);
  const startIdx = body.indexOf(start);
  if (startIdx !== -1) {
    const endIdx = body.indexOf(end);
    if (endIdx !== -1) {
      const lineStart = body.lastIndexOf('\n', startIdx);
      let cut = endIdx + end.length;
      const tail = body.slice(cut).match(/^\r?\n[ \t]*/);
      if (tail) cut += tail[0].length;
      body = body.slice(0, lineStart === -1 ? startIdx : lineStart) + body.slice(cut);
    }
  }

  const registrations = plugins.map((p) => `        ${appVar}.handle()${pluginCall(p)}?;`).join('\n');
  const block = `\n      ${start}\n      ${cfg}\n      {\n${registrations}\n      }\n      ${end}\n`;
  const okIndex = body.lastIndexOf('Ok(())');
  body = okIndex === -1 ? body + block : body.slice(0, okIndex) + block + '      ' + body.slice(okIndex);
  content = content.slice(0, openBraceIndex + 1) + body + content.slice(closeBraceIndex);
  await writeFile(targetPath, content);
}

async function wireRustPlugins(tauriDir: string, features: FeatureDefinition[]): Promise<void> {
  const allPlugins = getRustPlugins(features);
  for (const plugin of byPlatform(allPlugins, 'all')) await addTauriPlugin(tauriDir, plugin);
  for (const plugin of [...byPlatform(allPlugins, 'desktop'), ...byPlatform(allPlugins, 'mobile')]) {
    await addCargoDependencyTargeted(tauriDir, plugin);
  }
  await patchLibRsTargeted(tauriDir, byPlatform(allPlugins, 'desktop'), 'desktop');
  await patchLibRsTargeted(tauriDir, byPlatform(allPlugins, 'mobile'), 'mobile');
}

// ─── Capability scaffolding (user-owned after first write) ─────────────────

const permissionId = (p: Permission) => (typeof p === 'string' ? p : p.identifier);

async function scaffoldCapabilityFile(
  filePath: string,
  suggested: Permission[],
  create?: { identifier: string; platforms: string[]; schema: string },
  windows: string[] = ['main'],
): Promise<void> {
  if (existsSync(filePath)) return;
  if (!create) return;

  const permissions: Permission[] = ['core:default'];
  const seen = new Set<string>(['core:default']);
  for (const perm of suggested) {
    const id = permissionId(perm);
    if (seen.has(id)) continue;
    seen.add(id);
    permissions.push(perm);
  }

  const caps = {
    $schema: `../gen/schemas/${create.schema}`,
    identifier: create.identifier,
    description:
      'Generated by bini-native. Review and scope permissions (HTTP URLs, fs paths, ' +
      'global-shortcut allowlists) before production — this file is now owned by you.',
    windows,
    platforms: create.platforms,
    permissions,
  };

  assertPathInside(path.dirname(filePath), filePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(caps, null, 2) + '\n');
}

async function patchCapabilities(tauriDir: string, features: FeatureDefinition[]): Promise<void> {
  const capsDir = path.join(tauriDir, 'capabilities');
  const plugins = getRustPlugins(features);
  const all: Permission[] = [...byPlatform(plugins, 'all').flatMap((p) => p.permissions)];
  const desktop = byPlatform(plugins, 'desktop').flatMap((p) => p.permissions);
  const mobile = byPlatform(plugins, 'mobile').flatMap((p) => p.permissions);

  try {
    const defaultPath = path.join(capsDir, 'default.json');
    const existedBefore = existsSync(defaultPath);
    await scaffoldCapabilityFile(defaultPath, all);

    let windows = ['main'];
    try {
      const def = JSON.parse(await readFile(defaultPath, 'utf-8'));
      if (Array.isArray(def.windows) && def.windows.length > 0) windows = def.windows;
    } catch {}

    if (desktop.length > 0 && !existsSync(path.join(capsDir, 'desktop.json'))) {
      await scaffoldCapabilityFile(
        path.join(capsDir, 'desktop.json'),
        desktop,
        { identifier: 'desktop-capability', platforms: ['macOS', 'windows', 'linux'], schema: 'desktop-schema.json' },
        windows,
      );
    }
    if (mobile.length > 0 && !existsSync(path.join(capsDir, 'mobile.json'))) {
      await scaffoldCapabilityFile(
        path.join(capsDir, 'mobile.json'),
        mobile,
        { identifier: 'mobile-capability', platforms: ['android', 'iOS'], schema: 'mobile-schema.json' },
        windows,
      );
    }

    if (!existedBefore && (all.length + desktop.length + mobile.length) > 0) {
      log.info(
        'Capability files scaffolded under src-tauri/capabilities/. ' +
        'Review and tighten scopes (http URLs, fs paths, shortcuts) before production.',
      );
    }
  } catch (err) {
    log.warn(`Could not scaffold capabilities: ${(err as Error).message}`);
  }
}

async function wireFeatures(projectPath: string, features: FeatureDefinition[]): Promise<void> {
  const tauriDir = path.join(projectPath, 'src-tauri');
  if (!existsSync(tauriDir)) return;

  for (const f of features.filter((f) => f.noFirstPartyPlugin)) {
    log.warn(`"${f.id}" detected - no official Tauri plugin exists.${f.hint ? ` ${f.hint}` : ''}`);
  }

  const npmPackages = [...new Set(features.flatMap((f) => (f.npmPackage ? [f.npmPackage] : [])))];
  const allPlugins = getRustPlugins(features);

  await Promise.all([
    npmPackages.length > 0 ? installPackages(projectPath, npmPackages) : null,
    allPlugins.length > 0 ? wireRustPlugins(tauriDir, features) : null,
    patchCapabilities(tauriDir, features),
  ]);
}

// ─── Polyfill injection ────────────────────────────────────────────────────

const INJECTION_MARKER = '/* @bini-native:polyfills:v2 */';
const END_MARKER = '// --- End Bini Native: Runtime Polyfills -------------------------------';
const POLYFILL_START_RE = /@bini-native:polyfills(?::v\d+)?\s*\*\//;
const POLYFILL_END_PREFIX = 'End Bini Native: Runtime Polyfills';

function stripExistingPolyfillBlock(content: string): string {
  let out = content;
  for (;;) {
    const s = POLYFILL_START_RE.exec(out);
    if (!s) break;
    const lineStart = out.lastIndexOf('\n', s.index);
    const start = lineStart === -1 ? s.index : lineStart;
    const e = out.indexOf(POLYFILL_END_PREFIX, start);
    if (e === -1) break;
    const lineEnd = out.indexOf('\n', e);
    const end = lineEnd === -1 ? out.length : lineEnd + 1;
    out = out.slice(0, start) + out.slice(end);
  }
  return out;
}

function detectUseTypeScript(projectPath: string): boolean {
  return existsSync(path.join(projectPath, 'tsconfig.json'));
}

const ENTRY_CANDIDATES = ['main.tsx', 'main.jsx', 'main.ts', 'main.js', 'index.tsx', 'index.jsx', 'index.ts', 'index.js'];

async function injectPolyfills(projectPath: string, features: FeatureDefinition[]): Promise<void> {
  const mainFile = ENTRY_CANDIDATES.map((f) => path.join(projectPath, 'src', f)).find((p) => existsSync(p));
  if (!mainFile) return;
  assertPathInside(projectPath, mainFile);

  const active = features.filter((f) => f.polyfillBody);
  const useTypeScript = detectUseTypeScript(projectPath);
  const t: Ts = (snippet) => (useTypeScript ? snippet : '');

  try {
    const original = await readFile(mainFile, 'utf-8');
    let content = original;
    if (POLYFILL_START_RE.test(content)) content = stripExistingPolyfillBlock(content);

    if (active.length > 0) {
      const withImports = active.filter((f) => f.polyfillImports && f.npmPackage);

      const modVar = (f: FeatureDefinition): string =>
        'biniMod_' + f.id.replace(/[^a-zA-Z0-9_]/g, '_');

      const importList = withImports
        .map((f) => `    import(${JSON.stringify(f.npmPackage!)}),`)
        .join('\n');

      const tupleVars = withImports.map((f) => modVar(f));
      const tupleDestructure = tupleVars.length > 0
        ? `    const [${tupleVars.join(', ')}] = modules;\n`
        : '';

      const destructureLines = withImports
        .map((f) => {
          const pairs = f.polyfillImports!
            .map(({ name, as }) => `${name}: ${as}`)
            .join(', ');
          return `    const { ${pairs} } = ${modVar(f)};`;
        })
        .join('\n');

      const bodyBlocks = active.map((f) => f.polyfillBody!(t)).join('\n');
      const windowMembers = active.flatMap((f) => f.windowTypes ?? []);

      const windowAugmentation =
        useTypeScript && windowMembers.length > 0
          ? `// @bini-native:window-types\n/* eslint-disable */\ndeclare global {\n  interface Window {\n${windowMembers.map((m) => `    ${m}`).join('\n')}\n  }\n}\n/* eslint-enable */\n// @bini-native:end-window-types\n`
          : '';

      const block = `
${INJECTION_MARKER}
// --- Bini Native: Runtime Polyfills ----------------------------------
// Generated by bini-native - do not hand-edit, this block is regenerated
// automatically on every tauri dev/build.
${windowAugmentation}
if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
  Promise.all([
${importList}
  ]).then((modules) => {
${tupleDestructure}${destructureLines}

${bodyBlocks}
  }).catch((err${t(': any')}) => console.warn('[bini-native] polyfill init failed:', err));
}
${END_MARKER}
`;

      const imports = [...content.matchAll(/^import\s+.*?;$/gm)];
      if (imports.length > 0) {
        const last = imports[imports.length - 1];
        const at = last.index! + last[0].length;
        content = content.slice(0, at) + block + content.slice(at);
      } else content = block + content;
    }

    if (content !== original) {
      await writeFile(mainFile, content);
      log.success(`Updated ${path.basename(mainFile)}${active.length > 0 ? '' : ' (polyfills removed)'}`);
    }
  } catch (err) {
    log.warn(`Could not inject polyfills: ${(err as Error).message}`);
  }
}

// ─── Orchestrator ──────────────────────────────────────────────────────────

let lastDetectedIds = new Set<string>();

async function runFullWiring(projectPath: string, isFirstRun: boolean): Promise<void> {
  const tauriDir = path.join(projectPath, 'src-tauri');
  scanProject(projectPath);
  const detected = resolveFeatures();
  lastDetectedIds = new Set(detected.map((f) => f.id));
  const polyfilled = detected.filter((f) => f.polyfillBody);

  if (!existsSync(tauriDir)) {
    await injectPolyfills(projectPath, polyfilled);
    return;
  }

  if (isFirstRun) {
    if (detected.length > 0) log.info(`Detected: ${detected.map((f) => f.label).join(', ')}`);
    else log.info('No native feature usage detected in source - nothing to wire.');
  }

  const hasRustPlugins = detected.some((f) => f.rustPlugin);
  const cliReady = hasRustPlugins ? ensureTauriCli(projectPath) : true;

  await Promise.all([
    cliReady && hasRustPlugins ? wireFeatures(projectPath, detected) : null,
    injectPolyfills(projectPath, polyfilled),
  ]);

  if (!cliReady && hasRustPlugins) {
    log.warn('Rust plugin wiring skipped because Tauri CLI is unavailable. Polyfills were still injected.');
  }

  if (isFirstRun) log.success('Native wiring complete.');
}

// ─── HMR guard ─────────────────────────────────────────────────────────────

let pendingFeatureCheck: ReturnType<typeof setTimeout> | null = null;
const pendingFiles = new Set<string>();

function checkForNewFeaturesOnChange(file: string): void {
  pendingFiles.add(file);
  if (pendingFeatureCheck) clearTimeout(pendingFeatureCheck);
  pendingFeatureCheck = setTimeout(() => {
    pendingFeatureCheck = null;
    const files = [...pendingFiles];
    pendingFiles.clear();
    try {
      for (const f of files) {
        if (!existsSync(f)) { fileIndex.delete(f); continue; }
        const facts = getSourceFacts(f);
        if (facts === null) continue;
        indexFacts(f, facts);
      }
      const detected = resolveFeatures();
      const newOnes = detected.filter((f) => !lastDetectedIds.has(f.id));
      lastDetectedIds = new Set(detected.map((f) => f.id));
      if (newOnes.length > 0) {
        log.warn(`New native feature usage detected (${newOnes.map((f) => f.label).join(', ')}). Restart 'tauri dev' to wire it in.`);
      }
    } catch (err) {
      log.warn(`Feature detection failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, 400);
}

// ─── Pre-install (runs before Vite boots, same process) ────────────────────

const isDevCommand = !process.argv.includes('build');
const preInstallProjectPath = process.cwd();
const preInstallTauriDir = path.join(preInstallProjectPath, 'src-tauri');

if (isDevCommand && existsSync(preInstallTauriDir)) {
  try {
    scanProject(preInstallProjectPath);
    const detected = resolveFeatures();
    const npmPackages = [...new Set(detected.flatMap((f) => (f.npmPackage ? [f.npmPackage] : [])))];
    if (npmPackages.length > 0) installPackagesSync(preInstallProjectPath, npmPackages);
  } catch {
    scanned = false;
  }
}

// ─── Vite plugin ───────────────────────────────────────────────────────────

export function biniNative(): Plugin {
  let wired = false;
  return {
    name: 'bini-native',
    enforce: 'pre',
    apply: 'serve',
    async buildStart() {
      if (wired) return;
      wired = true;
      await runFullWiring(process.cwd(), true);
    },
    handleHotUpdate({ file }) {
      if (isClientSourceFile(process.cwd(), file)) {
        checkForNewFeaturesOnChange(file);
      }
    },
    buildEnd() {
      if (pendingFeatureCheck) { clearTimeout(pendingFeatureCheck); pendingFeatureCheck = null; }
      pendingFiles.clear();
    },
  };
}