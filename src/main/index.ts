import { app, BrowserWindow, Menu, Tray, nativeImage, net, protocol, powerSaveBlocker, dialog, Notification } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { electronApp, optimizer, is } from '@electron-toolkit/utils';
import { AppContext } from './app-context';
import { registerIpc } from './ipc';
import { resolveMediaRequest } from './media-protocol';
import { ShutdownCoordinator } from './shutdown-coordinator';
import { installNavigationGuards } from './window-security';

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

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();
app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

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
  installNavigationGuards(window.webContents);

  return window;
}

async function loadWindow(window: BrowserWindow): Promise<void> {
  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    await window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    await window.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

function updateTrayMenu(quitEnabled = true): void {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open VideoFactory', click: () => mainWindow?.show() },
    { label: 'Pause/Resume is controlled inside the app', enabled: false },
    { type: 'separator' },
    { label: quitEnabled ? 'Quit' : 'Waiting to quit safely…', enabled: quitEnabled, click: () => app.quit() }
  ]));
}

function setupTray(): void {
  const iconPath = join(process.resourcesPath, 'resources', 'icon-256.png');
  const developmentIcon = join(process.cwd(), 'resources', 'icon-256.png');
  const icon = nativeImage.createFromPath(existsSync(iconPath) ? iconPath : developmentIcon);
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip('VideoFactory Desktop');
  updateTrayMenu();
  tray.on('double-click', () => mainWindow?.show());
}

const shutdown = new ShutdownCoordinator({
  stop: async () => {
    await context?.stop();
  },
  completeQuit: () => {
    if (blockerId !== null && powerSaveBlocker.isStarted(blockerId)) {
      powerSaveBlocker.stop(blockerId);
      blockerId = null;
    }
    app.quit();
  },
  onBegin: () => updateTrayMenu(false),
  onPending: () => {
    const labels = context?.pendingOperations().map(operation => operation.label) ?? [];
    const detail = labels.length ? ` Active: ${labels.slice(0, 3).join(', ')}.` : '';
    const message = `Quit is waiting for active work to finish safely.${detail}`;
    if (Notification.isSupported()) {
      new Notification({ title: 'VideoFactory is finishing safely', body: message }).show();
    } else if (tray) {
      tray.displayBalloon({ title: 'VideoFactory is finishing safely', content: message });
    }
  },
  onError: error => {
    const message = errorMessage(error);
    console.error('VideoFactory shutdown failed:', message);
    dialog.showErrorBox(
      'VideoFactory could not quit safely',
      `Shutdown did not complete, so the application database was not closed underneath active work.\n\n${message.slice(0, 1600)}`
    );
  },
  graceMs: 30_000
});

function setupMediaProtocol(): void {
  protocol.handle('videofactory', async request => {
    if (!context || !context.acceptsOperations()) return new Response('App is not ready.', { status: 503 });
    const settings = context.settings();
    const stringLookup = (sql: string, id: string, key: string): string | null => {
      const row = context!.db.raw.prepare(sql).get(id) as Record<string, unknown> | undefined;
      return row?.[key] ? String(row[key]) : null;
    };
    const result = resolveMediaRequest(request.url, settings, {
      render: id => stringLookup('SELECT output_path FROM renders WHERE id = ?', id, 'output_path'),
      proxy: id => stringLookup('SELECT proxy_path FROM asset_files WHERE id = ?', id, 'proxy_path'),
      thumbnail: id => stringLookup('SELECT thumbnail_path FROM packaging_candidates WHERE id = ?', id, 'thumbnail_path'),
      captionManifest: id => stringLookup('SELECT manifest_path FROM renders WHERE id = ?', id, 'manifest_path')
    });
    if (result.status !== 200) return new Response(result.message, { status: result.status });
    if (result.kind === 'caption') {
      return new Response(readFileSync(result.path, 'utf8'), {
        headers: {
          'Content-Type': 'text/vtt; charset=utf-8',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }
    return net.fetch(pathToFileURL(result.path).toString());
  });
}

if (hasSingleInstanceLock) app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.kevin.videofactory');
  app.on('browser-window-created', (_event, window) => optimizer.watchWindowShortcuts(window));
  setupMediaProtocol();

  mainWindow = createWindow();
  context = new AppContext(() => mainWindow);
  context.setPowerBlockerHandler(active => {
    if (active && (blockerId === null || !powerSaveBlocker.isStarted(blockerId))) {
      blockerId = powerSaveBlocker.start('prevent-app-suspension');
    } else if (!active && blockerId !== null && powerSaveBlocker.isStarted(blockerId)) {
      powerSaveBlocker.stop(blockerId);
      blockerId = null;
    }
  });
  registerIpc(context, () => mainWindow);
  await context.start();
  setupTray();
  await loadWindow(mainWindow);

  mainWindow.on('close', event => {
    if (!shutdown.isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });
}).catch(error => {
  reportStartupFailure(error);
  app.quit();
});

app.on('before-quit', event => shutdown.handleBeforeQuit(event));

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
