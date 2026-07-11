import { app } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { appServerDir, type DesktopConfig } from '../config';
import { findBindablePort } from './ports';

/** Últimas linhas do app-server, para diagnosticar falha de boot no Windows. */
const recentLog: string[] = [];
function pushLog(line: string): void {
  const clean = line.trimEnd();
  if (!clean) return;
  recentLog.push(clean);
  if (recentLog.length > 40) recentLog.shift();
  try {
    const dir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'app-server.log'), `${clean}\n`);
  } catch {
    /* log é best-effort */
  }
}

/**
 * Sobe o Next standalone (build da Alinhafood 01) como processo utilitário.
 * O standalone escuta apenas em 127.0.0.1:<appServerPort>; quem expõe é o gateway.
 */

export interface AppServerHandle {
  child: ChildProcess;
  stop: () => void;
}

/** O standalone pode nidificar server.js num subdiretório (outputFileTracingRoot). */
export function findServerJs(dir: string): string | null {
  const direct = path.join(dir, 'server.js');
  if (fs.existsSync(direct)) return direct;
  if (!fs.existsSync(dir)) return null;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name === '.next') continue;
    const nested = findServerJs(path.join(dir, entry.name));
    if (nested) return nested;
  }
  return null;
}

function waitForHttp(port: number, timeoutMs: number): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 2_000 }, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', retry);
      req.on('timeout', () => {
        req.destroy();
        retry();
      });
    };
    const retry = () => {
      if (Date.now() - started > timeoutMs) {
        reject(new Error(`Servidor local não respondeu na porta ${port} em ${timeoutMs}ms`));
        return;
      }
      setTimeout(attempt, 300);
    };
    attempt();
  });
}

function spawnAppServer(serverJs: string, port: number, config: DesktopConfig): ChildProcess {
  // Roda o standalone como Node PURO (o binário do Electron com
  // ELECTRON_RUN_AS_NODE vira um Node comum — técnica do VS Code).
  return spawn(process.execPath, [serverJs], {
    cwd: path.dirname(serverJs),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: {
      // HERDA o ambiente do sistema — obrigatório: no Windows, sem SystemRoot
      // e afins o Winsock nem inicializa ("listen UNKNOWN errno -4094").
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      NODE_ENV: 'production',
      PORT: String(port),
      HOSTNAME: '127.0.0.1',
      ALINHAFOOD_RUNTIME: 'desktop',
      ALINHAFOOD_JWKS_URL: `http://127.0.0.1:${config.gatewayPort}/api/local/jwks`,
      // NUNCA adicionar SERVICE_ROLE/JWT_SECRET aqui — veto arquitetural.
      NEXT_PUBLIC_SUPABASE_URL: config.supabaseUrl,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: config.supabaseAnonKey,
      NEXT_PUBLIC_APP_URL: config.cloudUrl,
      ADMIN_PATH_SECRET: config.adminPathSecret,
      NEXT_PUBLIC_ADMIN_PATH_SECRET: config.adminPathSecret,
    },
  });
}

/** Sobe o processo numa porta e resolve quando responde; rejeita se morrer. */
function launchOnce(serverJs: string, port: number, config: DesktopConfig): Promise<ChildProcess> {
  const child = spawnAppServer(serverJs, port, config);
  child.stdout?.on('data', (d: Buffer) => pushLog(`[out] ${String(d)}`));
  child.stderr?.on('data', (d: Buffer) => pushLog(`[err] ${String(d)}`));
  child.on('error', (err) => pushLog(`[app-server] falha ao iniciar processo: ${err.message}`));

  return new Promise((resolve, reject) => {
    let settled = false;
    const onExit = (code: number | null) => {
      pushLog(`[app-server] encerrou com código ${code}`);
      if (!settled) {
        settled = true;
        reject(new Error(`o processo encerrou com código ${code} durante o arranque`));
      }
    };
    child.on('exit', onExit);
    waitForHttp(port, 45_000)
      .then(() => {
        if (!settled) {
          settled = true;
          child.removeListener('exit', onExit);
          child.on('exit', (code) => pushLog(`[app-server] encerrou com código ${code}`));
          resolve(child);
        }
      })
      .catch((err) => {
        if (!settled) {
          settled = true;
          try {
            child.kill();
          } catch {
            /* já morto */
          }
          reject(err);
        }
      });
  });
}

export async function startAppServer(config: DesktopConfig): Promise<AppServerHandle> {
  const serverJs = findServerJs(appServerDir());
  if (!serverJs) {
    throw new Error(
      `Build do app não encontrado em ${appServerDir()}. Rode "npm run build:app" primeiro.`,
    );
  }

  // Tenta a porta escolhida; se o processo morrer no arranque (ex.: a porta caiu
  // numa faixa reservada do Windows entre o teste e o uso), pega outra livre e
  // repete — até 4 tentativas. `config.appServerPort` fica com a porta final,
  // que o gateway usa para o proxy.
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    const port = attempt === 0
      ? config.appServerPort
      : await findBindablePort([config.appServerPort + attempt, 0]);
    try {
      const child = await launchOnce(serverJs, port, config);
      config.appServerPort = port;
      console.log(`[app-server] pronto em http://127.0.0.1:${port}`);
      return { child, stop: () => child.kill() };
    } catch (err) {
      lastErr = err as Error;
      console.error(`[app-server] tentativa na porta ${port} falhou: ${lastErr.message}`);
    }
  }

  const tail = recentLog.slice(-12).join('\n');
  throw new Error(
    `Servidor local não subiu após várias tentativas: ${lastErr?.message ?? 'desconhecido'}\n\n` +
      `Últimas mensagens do servidor:\n${tail || '(sem saída)'}`,
  );
}
