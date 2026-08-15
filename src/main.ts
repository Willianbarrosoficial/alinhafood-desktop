import { app, BrowserWindow, Menu, Tray, dialog, nativeImage, shell } from 'electron';
import path from 'node:path';
import { loadConfig } from './config';
import { startAppServer, type AppServerHandle } from './server/boot';
import { startGateway, type GatewayHandle } from './server/gateway';
import { findBindablePort } from './server/ports';
import { HealthMonitor } from './runtime/health-monitor';
import { PullEngine } from './sync/pull';
import { getDb, readMirrorTable, getMeta, setMeta } from './data/db';
import { serveImage, localImageUrl, syncImages } from './data/image-cache';
import { backupIfDue, backupBeforeUpdate } from './data/backup';
import { startHelper, stopHelper, helperStatus, configureHelper, helperInternalToken } from './print/agent-helper';
import { classifyPrinters } from './print/printer-utils';
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
  agentScopeByToken,
  claimLocalPrintJobs,
  updateLocalPrintJob,
  pendingLocalPrintJobs,
  createTestPrintJob,
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
let tray: Tray | null = null;

/** Liga o "iniciar com o Windows" por padrão na 1ª execução (depois o usuário
 *  controla pela bandeja — não re-liga se ele desligar). */
function ensureAutostartDefault() {
  if (process.platform !== 'win32' || !app.isPackaged) return;
  if (getMeta('autostart_configured')) return;
  app.setLoginItemSettings({ openAtLogin: true });
  setMeta('autostart_configured', '1');
}

function buildTrayMenu(localOrigin: string) {
  const openAtLogin =
    process.platform === 'win32' ? app.getLoginItemSettings().openAtLogin : false;
  return Menu.buildFromTemplate([
    {
      label: 'Abrir Alinhafood',
      click: () => {
        if (mainWindow) {
          if (mainWindow.isMinimized()) mainWindow.restore();
          mainWindow.show();
          mainWindow.focus();
        } else {
          createWindow(localOrigin);
        }
      },
    },
    { type: 'separator' },
    {
      label: 'Iniciar com o Windows',
      type: 'checkbox',
      checked: openAtLogin,
      visible: process.platform === 'win32',
      click: (item) => {
        app.setLoginItemSettings({ openAtLogin: item.checked });
      },
    },
    { type: 'separator' },
    { label: `Versão ${app.getVersion()}`, enabled: false },
    { label: 'Sair', click: () => app.quit() },
  ]);
}

function setupTray(localOrigin: string) {
  if (tray) return;
  const iconPath = path.join(__dirname, '..', 'resources', 'icon.ico');
  const image = nativeImage.createFromPath(iconPath);
  tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);
  tray.setToolTip('Alinhafood');
  tray.setContextMenu(buildTrayMenu(localOrigin));
  tray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    } else {
      createWindow(localOrigin);
    }
  });
}

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

// Estado da atualização baixada — exposto ao gateway para a faixa
// "Reiniciar para atualizar" (padrão VS Code/Claude), com a versão.
let pendingUpdate: { version: string } | null = null;
let installUpdateFn: (() => void) | null = null;

async function setupAutoUpdater() {
  if (!app.isPackaged) return;
  const { autoUpdater } = await import('electron-updater');
  autoUpdater.autoDownload = true;
  // NÃO instala sozinho no quit: mostra "Reiniciar para atualizar" e deixa o
  // usuário aplicar quando quiser (o UAC aparece uma vez, no clique dele).
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.on('update-downloaded', (info) => {
    void backupBeforeUpdate();
    pendingUpdate = { version: info.version };
    if (tray) tray.setToolTip(`Alinhafood — atualização ${info.version} pronta`);
    console.log(`[updater] atualização ${info.version} baixada — aguardando reinício`);
  });
  installUpdateFn = () => {
    void backupBeforeUpdate();
    autoUpdater.quitAndInstall(false, true);
  };
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

    // Resolve portas REALMENTE bindáveis antes de subir nada. No Windows,
    // Hyper-V/WSL/Docker reservam faixas de portas por boot; sem isto o
    // servidor interno falhava intermitentemente com "listen UNKNOWN -4094".
    // Gateway tenta 3737 primeiro (o print agent embutido espera essa porta);
    // o app-server interno pode ser qualquer porta livre.
    config.gatewayPort = await findBindablePort([config.gatewayPort, 3737, 3838, 3939, 4040]);
    config.appServerPort = await findBindablePort([
      config.appServerPort,
      3738,
      3739,
      3740,
      4141,
    ]);
    console.log(`[boot] portas: gateway=${config.gatewayPort} app-server=${config.appServerPort}`);

    health = new HealthMonitor(config);
    pull = new PullEngine(config, health);

    appServer = await startAppServer(config);
    gateway = await startGateway({
      config,
      version: app.getVersion(),
      health,
      isPackaged: app.isPackaged,
      syncStatus: () => ({ ...pull!.status() }),
      update: {
        pending: () => pendingUpdate,
        install: () => installUpdateFn?.(),
      },
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
        // Helper autentica com o token INTERNO; a nuvem é acessada com o token
        // de nuvem do restaurante ATUAL (expectedAgentToken lê do espelho).
        expectedToken: helperInternalToken,
        cloudToken: expectedAgentToken,
        // Tokens por computador (print_agents), espelhados pelo sync/pull —
        // sem isto o gateway rejeitava qualquer token da seção "Computadores".
        agentScope: agentScopeByToken,
        claim: claimLocalPrintJobs,
        update: updateLocalPrintJob,
        pendingCount: pendingLocalPrintJobs,
      },
      printerSetup: {
        state: async () => {
          const raw = mainWindow ? await mainWindow.webContents.getPrintersAsync() : [];
          const printers = classifyPrinters(
            raw.map((p) => ({
              name: p.name,
              displayName: p.displayName,
              description: p.description,
              isDefault: p.isDefault,
            })),
          );
          return { ...helperStatus(), printers };
        },
        save: (body) =>
          configureHelper(
            { printerName: body.printer_name, paperWidth: body.paper_width },
            config,
          ),
        test: createTestPrintJob,
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
    ensureAutostartDefault();
    setupTray(localOrigin);
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
