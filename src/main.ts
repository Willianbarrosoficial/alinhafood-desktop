import { app, BrowserWindow, dialog, shell } from 'electron';
import path from 'node:path';
import { loadConfig } from './config';
import { startAppServer, type AppServerHandle } from './server/boot';
import { startGateway, type GatewayHandle } from './server/gateway';
import { HealthMonitor } from './runtime/health-monitor';
import { PullEngine } from './sync/pull';
import { getDb, readMirrorTable } from './data/db';

let appServer: AppServerHandle | null = null;
let gateway: GatewayHandle | null = null;
let mainWindow: BrowserWindow | null = null;
let health: HealthMonitor | null = null;
let pull: PullEngine | null = null;

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
    icon: path.join(__dirname, '..', 'resources', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

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
    getDb(); // abre/migra o SQLite local cedo — falha aqui deve abortar o boot

    health = new HealthMonitor(config);
    pull = new PullEngine(config, health);

    appServer = await startAppServer(config);
    gateway = await startGateway({
      config,
      version: app.getVersion(),
      health,
      isPackaged: app.isPackaged,
      syncStatus: () => ({ ...pull!.status() }),
      localQuery: (name) => {
        // Fase 2: leitura crua do espelho por tabela (a Fase 3 traz queries nomeadas)
        if (name === 'mirror') return undefined; // reservado
        const known = readMirrorTable(name);
        return known.length > 0 ? known : known; // sempre responde (pode ser [])
      },
    });

    health.start();
    pull.start();

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
  health?.stop();
  pull?.stop();
  appServer?.stop();
  void gateway?.close();
});
