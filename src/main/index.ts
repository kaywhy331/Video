import { app, BrowserWindow, Menu, Tray, nativeImage, net, protocol, powerSaveBlocker, dialog } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { electronApp, optimizer, is } from '@electron-toolkit/utils';
import { AppContext } from './app-context';
import { registerIpc } from './ipc';

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'videofactory',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      bypassCSP: false
    }
  }
]);

let mainWindow: BrowserWindow | null = null;
let context: AppContext | null = null;
let tray: Tray | null = null;
let blockerId: number | null = null;
let isQuitting = false;

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.stack ?? error.message;
  return typeof error === 'string' ? error : JSON.stringify(error, null, 2);
}

function reportStartupFailure(error: unknown): void {
  const message = errorMessage(error);
  let logPath = 'unavailable';
  try {
    const logDirectory = join(app.getPath('userData'), 'logs');
    mkdirSync(logDirectory, { recursive: true });
    logPath = join(logDirectory, 'startup-error.log');
    appendFileSync(
      logPath,
      `\n[${new Date().toISOString()}] VideoFactory startup failure\n${message}\n`,
      'utf8'
    );
  } catch (logError) {
    console.error('Could not write startup log:', logError);
  }

  console.error(message);
  dialog.showErrorBox(
    'VideoFactory could not start',
    `The application encountered a startup error.\n\n${message.slice(0, 1600)}\n\nStartup log: ${logPath}`
  );
}

function preloadPath(): string {
  return join(__dirname, '../preload/index.js');
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1500,
    height: 940,
    minWidth: 1100,
    minHeight: 720,
    show: false,
    backgroundColor: '#090b0f',
    title: 'VideoFactory Desktop',
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: true
    }
  });

  window.on('ready-to-show', () => window.show());
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());

  return window;
}

async function loadWindow(window: BrowserWindow): Promise<void> {
  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    await window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    await window.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

function setupTray(): void {
  const iconPath = join(process.resourcesPath, 'resources', 'icon-256.png');
  const developmentIcon = join(process.cwd(), 'resources', 'icon-256.png');
  const icon = nativeImage.createFromPath(existsSync(iconPath) ? iconPath : developmentIcon);
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip('VideoFactory Desktop');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open VideoFactory', click: () => mainWindow?.show() },
    { label: 'Pause/Resume is controlled inside the app', enabled: false },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() }
  ]));
  tray.on('double-click', () => mainWindow?.show());
}

function setupMediaProtocol(): void {
  protocol.handle('videofactory', async request => {
    if (!context) return new Response('App is not ready.', { status: 503 });
    const url = new URL(request.url);
    const type = url.hostname;
    const id = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
    let path: string | null = null;
    if (type === 'render') {
      const row = context.db.raw.prepare('SELECT output_path FROM renders WHERE id = ?').get(id) as
        | { output_path: string | null }
        | undefined;
      path = row?.output_path ?? null;
    } else if (type === 'proxy') {
      const row = context.db.raw.prepare('SELECT proxy_path FROM asset_files WHERE id = ?').get(id) as
        | { proxy_path: string | null }
        | undefined;
      path = row?.proxy_path ?? null;
    } else if (type === 'thumbnail') {
      const row = context.db.raw.prepare('SELECT thumbnail_path FROM packaging_candidates WHERE id = ?').get(id) as
        | { thumbnail_path: string | null }
        | undefined;
      path = row?.thumbnail_path ?? null;
    }
    if (!path || !existsSync(path)) return new Response('Media not found.', { status: 404 });
    return net.fetch(pathToFileURL(path).toString());
  });
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.kevin.videofactory');
  app.on('browser-window-created', (_event, window) => optimizer.watchWindowShortcuts(window));
  setupMediaProtocol();

  mainWindow = createWindow();
  context = new AppContext(() => mainWindow);
  registerIpc(context, () => mainWindow);
  await context.start();
  setupTray();
  await loadWindow(mainWindow);

  mainWindow.on('close', event => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });
}).catch(error => {
  reportStartupFailure(error);
  app.quit();
});

app.on('before-quit', () => {
  isQuitting = true;
  if (blockerId !== null && powerSaveBlocker.isStarted(blockerId)) {
    powerSaveBlocker.stop(blockerId);
  }
  void context?.stop();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    mainWindow = createWindow();
    void loadWindow(mainWindow);
  } else {
    mainWindow?.show();
  }
});

// The tray keeps the single-user production service alive when its window is hidden.
app.on('window-all-closed', () => undefined);
