import { app } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { appServerDir, type DesktopConfig } from '../config';

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

export async function startAppServer(config: DesktopConfig): Promise<AppServerHandle> {
  const serverJs = findServerJs(appServerDir());
  if (!serverJs) {
    throw new Error(
      `Build do app não encontrado em ${appServerDir()}. Rode "npm run build:app" primeiro.`,
    );
  }

  // Roda o standalone como Node PURO (o binário do Electron com
  // ELECTRON_RUN_AS_NODE vira um Node comum — técnica do VS Code).
  // Não usar utilityProcess.fork: no Windows ele falha ao abrir portas
  // ("listen UNKNOWN errno -4094") — visto no primeiro teste em campo.
  const child = spawn(process.execPath, [serverJs], {
    cwd: path.dirname(serverJs),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: {
      // HERDA o ambiente do sistema — obrigatório: no Windows, sem SystemRoot
      // e afins o Winsock nem inicializa ("listen UNKNOWN errno -4094", visto
      // em campo). As nossas variáveis entram por cima.
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      NODE_ENV: 'production',
      PORT: String(config.appServerPort),
      HOSTNAME: '127.0.0.1',
      // Runtime desktop — usado pelos seams das fases 2+ na Alinhafood 01
      ALINHAFOOD_RUNTIME: 'desktop',
      // Middleware valida sessão ES256 com a JWKS do espelho local (funciona
      // no apagão; o gateway serve o cache em /api/local/jwks)
      ALINHAFOOD_JWKS_URL: `http://127.0.0.1:${config.gatewayPort}/api/local/jwks`,
      // Envs públicas exigidas pelo middleware (verifyAdminJwt slow-path) e páginas.
      // NUNCA adicionar SERVICE_ROLE/JWT_SECRET aqui — veto arquitetural.
      NEXT_PUBLIC_SUPABASE_URL: config.supabaseUrl,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: config.supabaseAnonKey,
      NEXT_PUBLIC_APP_URL: config.cloudUrl,
      ADMIN_PATH_SECRET: config.adminPathSecret,
      NEXT_PUBLIC_ADMIN_PATH_SECRET: config.adminPathSecret,
    },
  });

  child.stdout?.on('data', (data: Buffer) => pushLog(`[out] ${String(data)}`));
  child.stderr?.on('data', (data: Buffer) => pushLog(`[err] ${String(data)}`));
  child.on('error', (err) => pushLog(`[app-server] falha ao iniciar processo: ${err.message}`));
  child.on('exit', (code) => pushLog(`[app-server] encerrou com código ${code}`));

  try {
    await waitForHttp(config.appServerPort, 60_000);
  } catch (err) {
    // Surface o motivo real do crash (útil no primeiro boot em Windows)
    const tail = recentLog.slice(-12).join('\n');
    throw new Error(`${(err as Error).message}\n\nÚltimas mensagens do servidor:\n${tail || '(sem saída)'}`);
  }
  console.log(`[app-server] pronto em http://127.0.0.1:${config.appServerPort}`);

  return {
    child,
    stop: () => {
      child.kill();
    },
  };
}
