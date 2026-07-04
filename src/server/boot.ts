import { utilityProcess, type UtilityProcess } from 'electron';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { appServerDir, type DesktopConfig } from '../config';

/**
 * Sobe o Next standalone (build da Alinhafood 01) como processo utilitário.
 * O standalone escuta apenas em 127.0.0.1:<appServerPort>; quem expõe é o gateway.
 */

export interface AppServerHandle {
  child: UtilityProcess;
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

  const child = utilityProcess.fork(serverJs, [], {
    cwd: path.dirname(serverJs),
    stdio: 'pipe',
    env: {
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

  child.stdout?.on('data', (data: Buffer) => console.log(`[app-server] ${String(data).trimEnd()}`));
  child.stderr?.on('data', (data: Buffer) => console.error(`[app-server] ${String(data).trimEnd()}`));
  child.on('exit', (code) => console.log(`[app-server] encerrou com código ${code}`));

  await waitForHttp(config.appServerPort, 30_000);
  console.log(`[app-server] pronto em http://127.0.0.1:${config.appServerPort}`);

  return {
    child,
    stop: () => {
      child.kill();
    },
  };
}
