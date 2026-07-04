import http from 'node:http';
import { Client } from 'undici';
import type { DesktopConfig } from '../config';

/**
 * Gateway local — porta pública do desktop (3737).
 *
 * Fase 1 (modo proxy-total):
 *   /api/*  → proxy reverso para a nuvem (cookies reescritos para a origem local)
 *   demais  → Next standalone interno (páginas, /_next, assets)
 *
 * Fases 2-3 vão inserir aqui o roteamento offline (handlers SQLite) por rota.
 */

/** Headers hop-by-hop que nunca são repassados em proxies (RFC 9110 §7.6.1) */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
]);

interface GatewayOptions {
  config: DesktopConfig;
  version: string;
}

export interface GatewayHandle {
  server: http.Server;
  close: () => Promise<void>;
}

export function startGateway(options: GatewayOptions): Promise<GatewayHandle> {
  const { config, version } = options;
  const cloud = new URL(config.cloudUrl);
  const cloudClient = new Client(cloud.origin, {
    // SSE e respostas longas: sem timeout de corpo
    bodyTimeout: 0,
    headersTimeout: 30_000,
  });
  const appServerClient = new Client(`http://127.0.0.1:${config.appServerPort}`, {
    bodyTimeout: 0,
    headersTimeout: 30_000,
  });

  const localOrigin = `http://127.0.0.1:${config.gatewayPort}`;

  function collectRequestHeaders(req: http.IncomingMessage, targetHost: string, rewriteOrigin: boolean) {
    const headers: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined || HOP_BY_HOP.has(name)) continue;
      headers[name] = value;
    }
    headers['host'] = targetHost;
    if (rewriteOrigin) {
      // POSTs same-origin do app chegam com Origin/Referer locais; a nuvem
      // valida como se fosse o site — reescrevemos para a origem da nuvem.
      if (headers['origin']) headers['origin'] = cloud.origin;
      if (typeof headers['referer'] === 'string') {
        headers['referer'] = headers['referer'].replace(localOrigin, cloud.origin);
      }
      headers['x-alinhafood-desktop'] = version;
    }
    return headers;
  }

  /** Set-Cookie da nuvem precisa "grudar" na origem local: remove Domain e Secure. */
  function rewriteSetCookie(cookies: string[]): string[] {
    return cookies.map((cookie) =>
      cookie
        .split(';')
        .map((part) => part.trim())
        .filter((part) => {
          const key = part.split('=')[0]!.trim().toLowerCase();
          return key !== 'domain' && key !== 'secure';
        })
        .join('; '),
    );
  }

  async function proxy(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    client: Client,
    targetHost: string,
    isCloud: boolean,
  ) {
    try {
      const upstream = await client.request({
        path: req.url ?? '/',
        method: (req.method ?? 'GET') as 'GET',
        headers: collectRequestHeaders(req, targetHost, isCloud),
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : req,
      });

      const outHeaders: Record<string, string | string[]> = {};
      for (const [name, value] of Object.entries(upstream.headers)) {
        if (value === undefined || HOP_BY_HOP.has(name)) continue;
        if (isCloud && name === 'set-cookie') {
          outHeaders[name] = rewriteSetCookie(Array.isArray(value) ? value : [String(value)]);
          continue;
        }
        if (isCloud && name === 'location' && typeof value === 'string') {
          outHeaders[name] = value.replace(cloud.origin, localOrigin);
          continue;
        }
        outHeaders[name] = value as string | string[];
      }

      res.writeHead(upstream.statusCode, outHeaders);
      upstream.body.pipe(res);
      upstream.body.on('error', () => res.destroy());
    } catch (err) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      // Nuvem inacessível — contrato padronizado que a UI aprenderá a tratar
      // (Fase 2+: aqui entra o fallback para os handlers offline locais).
      res.writeHead(isCloud ? 503 : 502, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify(
          isCloud
            ? { error: 'offline_unavailable', message: 'Sem conexão com o servidor Alinhafood.' }
            : { error: 'app_server_unavailable', message: 'Servidor local não respondeu.' },
        ),
      );
      console.error(`[gateway] proxy ${isCloud ? 'cloud' : 'local'} ${req.method} ${req.url}:`, (err as Error).message);
    }
  }

  const server = http.createServer((req, res) => {
    const url = req.url ?? '/';

    if (url === '/desktop/status') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ app: 'alinhafood-desktop', version, mode: 'online-proxy' }));
      return;
    }

    if (url.startsWith('/api/')) {
      void proxy(req, res, cloudClient, cloud.host, true);
      return;
    }

    void proxy(req, res, appServerClient, `127.0.0.1:${config.appServerPort}`, false);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    // Fase 1: somente a máquina local. Fase 4 muda para 0.0.0.0 (LAN).
    server.listen(config.gatewayPort, '127.0.0.1', () => {
      server.removeListener('error', reject);
      console.log(`[gateway] escutando em ${localOrigin} → nuvem ${cloud.origin}`);
      resolve({
        server,
        close: () =>
          new Promise<void>((res2) => {
            server.close(() => res2());
            void cloudClient.close();
            void appServerClient.close();
          }),
      });
    });
  });
}
