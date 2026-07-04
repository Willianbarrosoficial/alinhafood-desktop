import http from 'node:http';
import { Client } from 'undici';
import type { DesktopConfig } from '../config';
import type { HealthMonitor } from '../runtime/health-monitor';
import { saveAdminToken, clearAdminToken } from '../runtime/session-store';

/**
 * Gateway local — porta pública do desktop (3737).
 *
 * Fase 2 (leitura offline):
 *   /api/local/*        → status, SSE de modo, queries do espelho local
 *   /api/auth/session   → proxy + captura do access_token (autentica o sync)
 *   /api/*              → ONLINE: proxy nuvem | OFFLINE: 503 padronizado
 *   demais              → Next standalone interno (páginas, /_next, assets)
 */

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

export interface GatewayOptions {
  config: DesktopConfig;
  version: string;
  health: HealthMonitor;
  isPackaged: boolean;
  /** Info extra para o /api/local/status (última sync, contagens do espelho) */
  syncStatus?: () => Record<string, unknown>;
  /** Leitura do espelho local: nome da query → resultado (Fase 2+) */
  localQuery?: (name: string, params: URLSearchParams) => unknown | undefined;
  /** Criação de pedido offline (Fase 3) */
  localCreateOrder?: (body: unknown) =>
    | { ok: true; orderId: string; orderNumber: string }
    | { ok: false; status: number; error: string };
  /** Demais escritas offline: update-status, mark-paid... (Fase 3) */
  localWrite?: (action: string, body: unknown) =>
    | { ok: true }
    | { ok: false; status: number; error: string }
    | undefined;
  /** JWKS pública do Supabase guardada no espelho (validação ES256 offline) */
  getJwks?: () => string | null;
  /** Impressão local (Fase 3/4): agente C# consome jobs locais primeiro */
  print?: {
    expectedToken: () => string | null;
    claim: () => unknown[];
    update: (jobId: string, status: string, errorMessage?: string) => boolean;
    pendingCount: () => number;
  };
}

export interface GatewayHandle {
  server: http.Server;
  close: () => Promise<void>;
}

function readBody(req: http.IncomingMessage, limit = 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function startGateway(options: GatewayOptions): Promise<GatewayHandle> {
  const { config, version, health } = options;
  const cloud = new URL(config.cloudUrl);
  const cloudClient = new Client(cloud.origin, { bodyTimeout: 0, headersTimeout: 30_000 });
  const appServerClient = new Client(`http://127.0.0.1:${config.appServerPort}`, {
    bodyTimeout: 0,
    headersTimeout: 30_000,
  });

  const localOrigin = `http://127.0.0.1:${config.gatewayPort}`;
  const sseClients = new Set<http.ServerResponse>();

  health.on('change', (mode: string) => {
    for (const res of sseClients) {
      res.write(`event: mode\ndata: ${JSON.stringify({ mode })}\n\n`);
    }
  });

  function collectRequestHeaders(req: http.IncomingMessage, targetHost: string, rewriteOrigin: boolean) {
    const headers: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined || HOP_BY_HOP.has(name)) continue;
      headers[name] = value;
    }
    headers['host'] = targetHost;
    if (rewriteOrigin) {
      if (headers['origin']) headers['origin'] = cloud.origin;
      if (typeof headers['referer'] === 'string') {
        headers['referer'] = headers['referer'].replace(localOrigin, cloud.origin);
      }
      headers['x-alinhafood-desktop'] = version;
    }
    return headers;
  }

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

  function offlineResponse(res: http.ServerResponse) {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        error: 'offline_unavailable',
        message: 'Sem conexão com o servidor Alinhafood. Operando em modo offline.',
      }),
    );
  }

  async function proxy(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    client: Client,
    targetHost: string,
    isCloud: boolean,
    bufferedBody?: Buffer,
  ) {
    try {
      const upstream = await client.request({
        path: req.url ?? '/',
        method: (req.method ?? 'GET') as 'GET',
        headers: collectRequestHeaders(req, targetHost, isCloud),
        body:
          bufferedBody ??
          (req.method === 'GET' || req.method === 'HEAD' ? undefined : req),
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
      return upstream.statusCode;
    } catch (err) {
      if (res.headersSent) {
        res.destroy();
        return null;
      }
      if (isCloud) {
        offlineResponse(res);
      } else {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'app_server_unavailable', message: 'Servidor local não respondeu.' }));
      }
      console.error(`[gateway] proxy ${isCloud ? 'cloud' : 'local'} ${req.method} ${req.url}:`, (err as Error).message);
      return null;
    }
  }

  /** Proxy do login/logout capturando o token p/ autenticar o sync engine. */
  async function handleAuthSession(req: http.IncomingMessage, res: http.ServerResponse) {
    const body = await readBody(req).catch(() => Buffer.alloc(0));
    const status = await proxy(req, res, cloudClient, cloud.host, true, body);
    if (status !== null && status < 300) {
      if (req.method === 'POST') {
        try {
          const parsed = JSON.parse(body.toString('utf8')) as { access_token?: string };
          if (parsed.access_token) {
            saveAdminToken(parsed.access_token);
            console.log('[gateway] sessão admin capturada para o sync');
          }
        } catch {
          /* body não-JSON — ignora */
        }
      } else if (req.method === 'DELETE') {
        clearAdminToken();
        console.log('[gateway] sessão admin limpa');
      }
    }
  }

  function handleLocal(req: http.IncomingMessage, res: http.ServerResponse, url: string) {
    if (url === '/api/local/jwks') {
      const jwks = options.getJwks?.();
      if (!jwks) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'jwks_not_synced' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(jwks);
      return;
    }

    if (url === '/api/local/status' || url === '/desktop/status') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          app: 'alinhafood-desktop',
          version,
          ...health.status(),
          sync: options.syncStatus?.() ?? null,
        }),
      );
      return;
    }

    if (url === '/api/local/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write(`event: mode\ndata: ${JSON.stringify({ mode: health.status().mode })}\n\n`);
      sseClients.add(res);
      const keepalive = setInterval(() => res.write(': ping\n\n'), 25_000);
      req.on('close', () => {
        clearInterval(keepalive);
        sseClients.delete(res);
      });
      return;
    }

    // Simulação de queda para QA — só em modo dev, nunca no app empacotado
    if (!options.isPackaged && url.startsWith('/api/local/dev/mode/')) {
      const target = url.split('/').pop();
      health.force(target === 'offline' ? 'offline' : target === 'online' ? 'online' : null);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ forced: target }));
      return;
    }

    const queryMatch = url.match(/^\/api\/local\/query\/([\w-]+)(?:\?(.*))?$/);
    if (queryMatch && options.localQuery) {
      const result = options.localQuery(queryMatch[1]!, new URLSearchParams(queryMatch[2] ?? ''));
      if (result === undefined) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'unknown_local_query' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  }

  async function handleLocalOrder(req: http.IncomingMessage, res: http.ServerResponse) {
    if (!options.localCreateOrder) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
      return;
    }
    try {
      const body = JSON.parse((await readBody(req)).toString('utf8')) as unknown;
      const result = options.localCreateOrder(body);
      if (result.ok) {
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ order_id: result.orderId, order_number: result.orderNumber, offline: true }));
      } else {
        res.writeHead(result.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: result.error }));
      }
    } catch (err) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: `body inválido: ${(err as Error).message}` }));
    }
  }

  async function handleLocalWrite(req: http.IncomingMessage, res: http.ServerResponse, action: string) {
    try {
      const body = JSON.parse((await readBody(req)).toString('utf8')) as unknown;
      const result = options.localWrite?.(action, body);
      if (!result) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'unknown_local_action' }));
        return;
      }
      if (result.ok) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, offline: true }));
      } else {
        res.writeHead(result.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: result.error }));
      }
    } catch (err) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: `body inválido: ${(err as Error).message}` }));
    }
  }

  const server = http.createServer((req, res) => {
    const url = req.url ?? '/';

    if (url === '/api/local/orders' && req.method === 'POST') {
      void handleLocalOrder(req, res);
      return;
    }

    const writeMatch = url.match(/^\/api\/local\/write\/([\w-]+)$/);
    if (writeMatch && req.method === 'POST') {
      void handleLocalWrite(req, res, writeMatch[1]!);
      return;
    }

    // Print agent: jobs locais têm prioridade; sem locais e online → nuvem.
    // O agente C# não sabe a diferença — mesmo contrato nos dois caminhos.
    if (url.startsWith('/api/print/jobs') && options.print) {
      const auth = req.headers.authorization ?? '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
      const expected = options.print.expectedToken();

      if (req.method === 'GET' && url === '/api/print/jobs') {
        if (!token || !expected || token !== expected) {
          // Token não confere localmente — deixa a nuvem decidir quando online
          if (health.isOnline()) {
            void proxy(req, res, cloudClient, cloud.host, true);
          } else {
            res.writeHead(401, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'Token inválido' }));
          }
          return;
        }
        if (options.print.pendingCount() > 0 || !health.isOnline()) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ jobs: options.print.claim() }));
          return;
        }
        void proxy(req, res, cloudClient, cloud.host, true);
        return;
      }

      const patchMatch = url.match(/^\/api\/print\/jobs\/([\w-]+)$/);
      if (patchMatch && req.method === 'PATCH' && token && expected && token === expected) {
        void (async () => {
          try {
            const body = JSON.parse((await readBody(req)).toString('utf8')) as {
              status?: string;
              error_message?: string;
            };
            const isLocal = options.print!.update(patchMatch[1]!, body.status ?? 'failed', body.error_message);
            if (isLocal) {
              res.writeHead(200, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ ok: true }));
            } else if (health.isOnline()) {
              await proxy(req, res, cloudClient, cloud.host, true, Buffer.from(JSON.stringify(body)));
            } else {
              res.writeHead(404, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ error: 'job não encontrado' }));
            }
          } catch {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'body inválido' }));
          }
        })();
        return;
      }
    }

    if (url.startsWith('/api/local/') || url === '/desktop/status') {
      handleLocal(req, res, url);
      return;
    }

    if (url.startsWith('/api/auth/session')) {
      void handleAuthSession(req, res);
      return;
    }

    if (url.startsWith('/api/')) {
      // Curto-circuito: nuvem marcada como fora → falha rápida com contrato
      // padronizado (Fase 3 troca isto pelos handlers offline por rota).
      if (!health.isOnline()) {
        offlineResponse(res);
        return;
      }
      void proxy(req, res, cloudClient, cloud.host, true);
      return;
    }

    void proxy(req, res, appServerClient, `127.0.0.1:${config.appServerPort}`, false);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    // Fase 2: somente a máquina local. Fase 4 muda para 0.0.0.0 (LAN).
    server.listen(config.gatewayPort, '127.0.0.1', () => {
      server.removeListener('error', reject);
      console.log(`[gateway] escutando em ${localOrigin} → nuvem ${cloud.origin}`);
      resolve({
        server,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
            void cloudClient.close();
            void appServerClient.close();
          }),
      });
    });
  });
}
