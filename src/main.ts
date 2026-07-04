import { app, BrowserWindow, dialog, shell } from 'electron';
import path from 'node:path';
import { loadConfig } from './config';
import { startAppServer, type AppServerHandle } from './server/boot';
import { startGateway, type GatewayHandle } from './server/gateway';

let appServer: AppServerHandle | null = null;
let gateway: GatewayHandle | null = null;
let mainWindow: BrowserWindow | null = null;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

function createWindow(localOrigin: string) {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1024,
    minHeight: 700,
    autoHideMenuBar: true,
    backgroundColor: '#F5F6F8',
    title: 'Alinhafood',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Links externos (WhatsApp, dashboards, etc.) abrem no navegador padrão
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(localOrigin)) {
      void shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  void mainWindow.loadURL(`${localOrigin}/login`);
}

async function setupAutoUpdater() {
  if (!app.isPackaged) return;
  const { autoUpdater } = await import('electron-updater');
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  const check = () => autoUpdater.checkForUpdatesAndNotify().catch((err) => {
    console.error('[updater] falha ao checar atualização:', err.message);
  });
  void check();
  setInterval(check, 6 * 60 * 60 * 1000);
}

async function boot() {
  try {
    const config = loadConfig();
    appServer = await startAppServer(config);
    gateway = await startGateway({ config, version: app.getVersion() });
    const localOrigin = `http://127.0.0.1:${config.gatewayPort}`;
    createWindow(localOrigin);
    void setupAutoUpdater();
  } catch (err) {
    dialog.showErrorBox(
      'Alinhafood — erro ao iniciar',
      (err as Error).message ?? 'Erro desconhecido ao iniciar o servidor local.',
    );
    app.quit();
  }
}

app.whenReady().then(boot);

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && gateway) {
    createWindow(`http://127.0.0.1:${loadConfig().gatewayPort}`);
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  appServer?.stop();
  void gateway?.close();
});
