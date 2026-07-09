import { app, BrowserWindow, dialog, shell } from 'electron';
import path from 'node:path';
import { loadConfig } from './config';
import { startAppServer, type AppServerHandle } from './server/boot';
import { startGateway, type GatewayHandle } from './server/gateway';
import { HealthMonitor } from './runtime/health-monitor';
import { PullEngine } from './sync/pull';
import { getDb, readMirrorTable, getMeta } from './data/db';
import { serveImage, localImageUrl, syncImages } from './data/image-cache';
import { backupIfDue, backupBeforeUpdate } from './data/backup';
import { startHelper, stopHelper, helperStatus, configureHelper } from './print/agent-helper';
import {
  createLocalOrder,
  listTableActiveOrders,
  listMesaActiveOrders,
  listOrdersFeed,
  updateLocalOrderStatus,
  markLocalOrdersPaid,
  type CreateLocalOrderBody,
} from './data/orders-local';
import {
  expectedAgentToken,
  claimLocalPrintJobs,
  updateLocalPrintJob,
  pendingLocalPrintJobs,
} from './data/print-local';
import { localAuthState, setupPin, verifyPin, storedSessionToken, adminRedirectPath, sessionSnapshot } from './runtime/local-auth';
import { saveSessionSnapshot } from './runtime/session-store';

type MirrorRow = Record<string, unknown>;
const byNumber = (key: string) => (rows: MirrorRow[]) =>
  [...rows].sort((a, b) => Number(a[key] ?? 0) - Number(b[key] ?? 0));

/** Tabelas do espelho expostas em /api/local/query/<nome>, com a mesma
 *  ordenação das queries originais do web (supabase-queries.ts). */
const MIRROR_QUERIES: Record<string, (rows: MirrorRow[]) => MirrorRow[]> = {
  products: (rows) =>
    [...rows].sort(
      (a, b) =>
        Number(a.sort_order ?? 0) - Number(b.sort_order ?? 0) ||
        String(a.name ?? '').localeCompare(String(b.name ?? '')),
    ),
  categories: byNumber('sort_order'),
  tables: byNumber('number'),
  store_settings: (rows) => rows,
  restaurants: (rows) => rows,
};

/** Aponta as imagens do cardápio pro cache local do gateway (offline mostra fotos). */
function rewriteImages(name: string, rows: MirrorRow[], gatewayPort: number): MirrorRow[] {
  const rewrite = (v: unknown) =>
    typeof v === 'string' && /^https?:\/\//.test(v) ? localImageUrl(v, gatewayPort) : v;
  if (name === 'products') {
    return rows.map((r) => ({ ...r, image_url: rewrite(r.image_url) }));
  }
  if (name === 'store_settings') {
    return rows.map((r) => ({ ...r, logo_url: rewrite(r.logo_url), cover_url: rewrite(r.cover_url) }));
  }
  return rows;
}

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
  // Snapshot de segurança antes de aplicar uma atualização (rollback possível)
  autoUpdater.on('update-downloaded', () => {
    void backupBeforeUpdate();
  });
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
      localWrite: (action, body) => {
        if (action === 'update-status') {
          return updateLocalOrderStatus(body as Parameters<typeof updateLocalOrderStatus>[0]);
        }
        if (action === 'mark-paid') {
          return markLocalOrdersPaid(body as Parameters<typeof markLocalOrdersPaid>[0]);
        }
        return undefined;
      },
      localQuery: (name, params) => {
        if (name === 'orders-feed') return listOrdersFeed();
        if (name === 'mesa-active-orders') return listMesaActiveOrders();
        if (name === 'table-active-orders') {
          const table = Number(params.get('table_number'));
          if (!Number.isFinite(table)) return [];
          return listTableActiveOrders(table);
        }
        const sorter = MIRROR_QUERIES[name];
        if (!sorter) return undefined; // tabela fora da whitelist → 404
        return rewriteImages(name, sorter(readMirrorTable(name)), config.gatewayPort);
      },
      localCreateOrder: (body) => createLocalOrder(body as CreateLocalOrderBody),
      getJwks: () => getMeta('jwks'),
      serveImage,
      localAuth: {
        state: localAuthState,
        setupPin,
        verifyPin,
        storedToken: storedSessionToken,
        redirectPath: () => adminRedirectPath(config.adminPathSecret),
        saveSnapshot: saveSessionSnapshot,
        snapshot: sessionSnapshot,
      },
      print: {
        expectedToken: expectedAgentToken,
        claim: claimLocalPrintJobs,
        update: updateLocalPrintJob,
        pendingCount: pendingLocalPrintJobs,
      },
      printerSetup: {
        state: async () => {
          const printers = mainWindow
            ? (await mainWindow.webContents.getPrintersAsync()).map((p) => ({
                name: p.name,
                displayName: p.displayName,
                isDefault: p.isDefault ?? false,
              }))
            : [];
          return { ...helperStatus(), printers };
        },
        save: (body) =>
          configureHelper({ printerName: body.printer_name, paperWidth: body.paper_width }),
      },
    });

    health.start();
    pull.start();
    // Cacheia as imagens do cardápio já no boot (espelho da sessão anterior),
    // independente de login — assim ficam prontas antes de qualquer apagão.
    void syncImages();
    // Backup diário do banco local (rotativo)
    void backupIfDue();
    // Print agent embutido: sobe se já houver impressora configurada (win32)
    startHelper();

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
  stopHelper();
  appServer?.stop();
  void gateway?.close();
});
