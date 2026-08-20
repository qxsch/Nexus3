import { app, BrowserWindow, Menu, dialog, ipcMain, powerSaveBlocker, session, shell } from 'electron';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DesktopStore } from './settings.js';
import { LayoutManager, PRESETS, isPanelUrl } from './layout.js';

const HERE = dirname(fileURLToPath(import.meta.url));

// Packaged: main/ sits at the asar root beside index.html and src/. Dev: repo/desktop/main/.
const APP_ROOT = app.isPackaged ? resolve(HERE, '..') : resolve(HERE, '../..');
const HOST = '127.0.0.1';

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  // Decks accept any pasted stream or remote file URL, so media and fetch stay open.
  'media-src * blob: data:',
  'connect-src * blob: data:',
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'self'",
  "form-action 'none'"
].join('; ');

const loadAppModule = (rel) => import(pathToFileURL(join(APP_ROOT, rel)).href);

let store = null;
let layout = null;
let panels = [];
let server = null;
let options = null;
let origin = '';
let win = null;
let sleepBlocker = 0;
let quitting = false;

function iconPath() {
  for (const candidate of [join(APP_ROOT, 'icon.png'), join(HERE, '../build/icon.png')]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function panelWindowOptions(url) {
  const meta = panels.find((p) => p.id === isPanelUrl(url));
  const saved = meta ? store.get().windows?.[meta.id] : null;
  return {
    // A freshly detached panel opens at the smallest size that shows all of it.
    width: saved?.width ?? meta?.minWidth ?? 900,
    height: saved?.height ?? meta?.minHeight ?? 700,
    minWidth: meta?.minWidth ?? 320,
    minHeight: meta?.minHeight ?? 240,
    useContentSize: true,
    backgroundColor: '#070b16',
    icon: iconPath(),
    webPreferences: {
      preload: join(HERE, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false
    }
  };
}

function cliArgs() {
  return process.argv.slice(app.isPackaged ? 1 : 2);
}

async function bootServer(musicRoot) {
  if (server) {
    await server.close();
    server = null;
  }
  const { parseOptions, ensureDirs } = await loadAppModule('src/server/options.js');
  const { startServer } = await loadAppModule('src/server/app.js');

  const settings = store.get();
  options = parseOptions(cliArgs(), {
    dataRoot: app.getPath('userData'),
    musicRoot: musicRoot ?? settings.musicRoot ?? app.getPath('music'),
    configFile: 'config.json',
    scan: settings.scan,
    watch: settings.watch,
    host: HOST,
    port: 0
  });
  ensureDirs(options);

  server = await startServer(options);
  store.attach(server.config, panels.map((p) => p.id));
  origin = `http://${HOST}:${server.port}`;
  return options;
}

async function changeMusicFolder() {
  const picked = await dialog.showOpenDialog(win ?? undefined, {
    title: 'Select your music folder',
    defaultPath: options?.musicRoot,
    properties: ['openDirectory']
  });
  if (picked.canceled || !picked.filePaths[0]) return null;

  layout.closeAll();
  store.patch({ musicRoot: picked.filePaths[0] });
  try {
    await bootServer(picked.filePaths[0]);
    win?.loadURL(origin);
  } catch (err) {
    dialog.showErrorBox('Could not open that folder', err.message);
    return null;
  }
  return picked.filePaths[0];
}

function rescan(mode = 'auto') {
  server?.library.startScan(mode === 'full' ? 'full' : 'auto');
  return server?.library.status ?? null;
}

function buildMenu() {
  const state = store.get();
  const detached = layout.detached;
  const template = [
    {
      label: '&File',
      submenu: [
        { label: 'Change music folder…', click: () => changeMusicFolder() },
        { label: 'Rescan library', click: () => rescan('auto') },
        { label: 'Full rescan', click: () => rescan('full') },
        { type: 'separator' },
        { label: 'Open music folder', click: () => options && shell.openPath(options.musicRoot) },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: '&View',
      submenu: [
        {
          label: 'Layout',
          submenu: [
            {
              label: 'Single window',
              type: 'radio',
              checked: state.layout !== 'multi',
              click: () => layout.setLayout('single')
            },
            {
              label: 'Multi window',
              type: 'radio',
              checked: state.layout === 'multi',
              click: () => layout.setLayout('multi')
            },
            { type: 'separator' },
            {
              label: 'Presets',
              submenu: Object.entries(PRESETS).map(([key, preset]) => ({
                label: preset.label,
                click: () => layout.applyPreset(key)
              }))
            }
          ]
        },
        {
          label: 'Windows',
          submenu: [
            ...panels.map((p) => ({
              label: p.title,
              type: 'checkbox',
              checked: detached.includes(p.id),
              click: (item) => layout.togglePanel(p.id, item.checked)
            })),
            { type: 'separator' },
            {
              label: 'Always on top',
              type: 'checkbox',
              checked: !!state.alwaysOnTop,
              click: (item) => layout.setAlwaysOnTop(item.checked)
            },
            { label: 'Reset window layout', click: () => layout.reset() }
          ]
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: '&Help',
      submenu: [
        { label: 'Project page', click: () => shell.openExternal('https://github.com/qxsch/Nexus3') },
        {
          label: 'About',
          click: () =>
            dialog.showMessageBox(win ?? undefined, {
              type: 'info',
              title: 'NEXUS-3',
              message: `NEXUS-3 ${app.getVersion()}`,
              detail: [
                `Electron ${process.versions.electron} · Chromium ${process.versions.chrome} · Node ${process.versions.node}`,
                '',
                `Library   ${options?.musicRoot ?? '-'}`,
                `Index     ${options?.dbFile ?? '-'}`,
                `Settings  ${options?.configFile ?? '-'}`,
                `Serving   ${origin}`
              ].join('\n')
            })
        }
      ]
    }
  ];

  if (process.platform === 'darwin') {
    template.unshift({ role: 'appMenu' });
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  const bounds = store.get().windows?.console ?? {};
  win = new BrowserWindow({
    width: bounds.width ?? 1480,
    height: bounds.height ?? 940,
    x: bounds.x,
    y: bounds.y,
    minWidth: 1180,
    minHeight: 780,
    show: false,
    backgroundColor: '#070b16',
    icon: iconPath(),
    webPreferences: {
      preload: join(HERE, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      // Waveforms, meters and the sync PLL must keep running when the window is hidden.
      backgroundThrottling: false
    }
  });

  if (bounds.maximized) win.maximize();
  win.once('ready-to-show', () => win.show());

  win.on('close', () => {
    // The console owns the audio engine, so it takes the panel windows with it.
    layout.closeAll();
  });
  win.on('closed', () => {
    win = null;
  });

  if (store.get().alwaysOnTop) win.setAlwaysOnTop(true);
  layout.setConsole(win);
  win.loadURL(origin);
}

function hardenSession() {
  const s = session.defaultSession;

  s.webRequest.onHeadersReceived((details, callback) => {
    if (!origin || !details.url.startsWith(origin)) return callback({});
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [CSP],
        // Cross-origin isolation, so panel windows can share a SharedArrayBuffer.
        // Only the desktop app sets these; plain `npm start` is unaffected.
        'Cross-Origin-Opener-Policy': ['same-origin'],
        'Cross-Origin-Embedder-Policy': ['credentialless'],
        'Cross-Origin-Resource-Policy': ['same-origin']
      }
    });
  });

  // The device-naming step needs a microphone grant to reveal output device labels.
  const audio = new Set(['media', 'audioCapture', 'speaker-selection']);
  s.setPermissionRequestHandler((_wc, permission, callback) => callback(audio.has(permission)));
  s.setPermissionCheckHandler((_wc, permission, requestOrigin) =>
    audio.has(permission) && Boolean(origin) && requestOrigin?.startsWith(origin)
  );
}

app.setAppUserModelId('ch.qxs.nexus3');
// Panel windows must keep drawing meters and waveforms even when another window covers them.
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
// A desktop app is its own user gesture: start the audio engine without the booth prompt.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      // Panel windows must be opened by the renderer so they stay in the same agent
      // cluster as the console window, which is what makes SharedArrayBuffer work.
      if (origin && url.startsWith(origin)) {
        return { action: 'allow', overrideBrowserWindowOptions: panelWindowOptions(url) };
      }
      if (/^https?:/i.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    contents.on('did-create-window', (child, details) => {
      const id = isPanelUrl(details.url);
      const meta = panels.find((p) => p.id === id);
      if (meta) layout.adopt(child, id, meta.title);
      else child.close();
    });
    contents.on('will-navigate', (event, url) => {
      if (origin && url.startsWith(origin)) return;
      event.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    });
    contents.on('will-attach-webview', (event) => event.preventDefault());
  });

  ipcMain.handle('nexus:info', () => ({
    version: app.getVersion(),
    musicRoot: options?.musicRoot ?? null,
    dbFile: options?.dbFile ?? null,
    origin
  }));
  ipcMain.handle('nexus:pick-music-folder', () => changeMusicFolder());
  ipcMain.handle('nexus:rescan', (_event, mode) => rescan(mode));
  ipcMain.on('nexus:fit-window', (event, size) => {
    const child = BrowserWindow.fromWebContents(event.sender);
    if (child) layout?.fitWindow(child, size);
  });

  app.whenReady().then(async () => {
    try {
      const { PANELS } = await loadAppModule('src/desktop/panels.js');
      panels = PANELS;

      const { parseOptions } = await loadAppModule('src/server/options.js');
      const probe = parseOptions(cliArgs(), {
        dataRoot: app.getPath('userData'),
        configFile: 'config.json'
      });
      store = new DesktopStore(probe.configFile, panels.map((p) => p.id));
      layout = new LayoutManager({ store, panels, onChanged: () => buildMenu() });

      await bootServer();
    } catch (err) {
      dialog.showErrorBox('NEXUS-3 could not start', String(err?.stack ?? err));
      app.exit(1);
      return;
    }

    hardenSession();
    buildMenu();
    sleepBlocker = powerSaveBlocker.start('prevent-display-sleep');
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', (event) => {
    if (quitting) return;
    quitting = true;
    event.preventDefault();
    if (powerSaveBlocker.isStarted(sleepBlocker)) powerSaveBlocker.stop(sleepBlocker);
    Promise.resolve(server?.close())
      .catch(() => {})
      .finally(() => app.exit(0));
  });
}
