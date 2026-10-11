import crypto from 'node:crypto';
import type http from 'node:http';

/**
 * Guarda do gateway local (auditoria de segurança 2026-10-11, C-02).
 *
 * O gateway escuta em 127.0.0.1, mas loopback não é fronteira: qualquer
 * programa do PC, outro usuário do Windows na mesma máquina (RDP, troca
 * rápida de usuário) e qualquer site aberto num navegador do caixa alcançam a
 * porta. Até a 0.6.1 nada em /api/local/* conferia quem chamava — e ali estão
 * o PIN de emergência, a sessão do dono e o espelho com os pedidos.
 *
 * Três barreiras, nesta ordem:
 *  1. Host: só 127.0.0.1/localhost na porta do gateway. Barra DNS rebinding
 *     (um domínio do atacante que resolve para 127.0.0.1 vira "mesma origem").
 *  2. Origin: escrita vinda de página de outra origem é recusada antes de
 *     qualquer coisa — inclusive antes do proxy, que reescreve o Origin para
 *     o da nuvem e apagaria a evidência.
 *  3. Sessão local: /api/local/* exige um cookie com segredo aleatório gerado
 *     a cada boot e entregue SÓ à janela do app (main.ts grava no cookie jar
 *     do Electron antes do loadURL). Navegador comum não tem esse cookie.
 */

export const LOCAL_SESSION_COOKIE = 'af_local';

/** Segredo da sessão local — novo a cada boot, nunca vai para disco. */
export function newLocalSessionSecret(): string {
  return crypto.randomBytes(32).toString('hex');
}

export function allowedHosts(port: number): Set<string> {
  return new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
}

export function allowedOrigins(port: number): Set<string> {
  return new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
}

export function hostAllowed(hostHeader: string | undefined, port: number): boolean {
  if (!hostHeader) return false;
  return allowedHosts(port).has(hostHeader.trim().toLowerCase());
}

/**
 * Sem Origin (cliente que não é navegador: o print agent C#, o app-server
 * interno buscando a JWKS) passa — esses não carregam cookie de ninguém.
 * Com Origin, só a própria. `null` (sandbox, file://) é recusado.
 */
export function originAllowed(originHeader: string | undefined, port: number): boolean {
  if (originHeader === undefined) return true;
  return allowedOrigins(port).has(originHeader.trim().toLowerCase());
}

export function readCookie(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim();
  }
  return null;
}

export function hasLocalSession(cookieHeader: string | undefined, secret: string): boolean {
  const got = readCookie(cookieHeader, LOCAL_SESSION_COOKIE);
  if (!got) return false;
  const a = Buffer.from(got);
  const b = Buffer.from(secret);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Tira o cookie da sessão local antes de repassar a requisição (nuvem ou app-server). */
export function stripLocalSessionCookie(cookieHeader: string | string[] | undefined): string | undefined {
  if (cookieHeader === undefined) return undefined;
  const joined = Array.isArray(cookieHeader) ? cookieHeader.join('; ') : cookieHeader;
  const kept = joined
    .split(';')
    .map((p) => p.trim())
    .filter((p) => p && p.split('=')[0]!.trim() !== LOCAL_SESSION_COOKIE);
  return kept.length ? kept.join('; ') : undefined;
}

/**
 * Rotas de /api/local que ficam abertas sem a sessão local:
 *  - /api/local/jwks: chave PÚBLICA do Supabase; quem busca é o app-server
 *    interno (ALINHAFOOD_JWKS_URL), sem cookie.
 * O /desktop/status (detecção pelo print agent C#) fica fora de /api/local e
 * responde só identidade e modo.
 */
export function localRouteIsPublic(url: string): boolean {
  const path = url.split('?')[0];
  return path === '/api/local/jwks';
}

export type GuardVerdict = { ok: true } | { ok: false; status: number; error: string };

export function checkRequest(
  req: Pick<http.IncomingMessage, 'headers' | 'method' | 'url'>,
  port: number,
  secret: string,
): GuardVerdict {
  if (!hostAllowed(req.headers.host, port)) {
    return { ok: false, status: 421, error: 'host_not_allowed' };
  }
  const method = (req.method ?? 'GET').toUpperCase();
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
  if (method !== 'GET' && method !== 'HEAD' && !originAllowed(origin, port)) {
    return { ok: false, status: 403, error: 'origin_not_allowed' };
  }
  const url = req.url ?? '/';
  if (url.startsWith('/api/local/') && !localRouteIsPublic(url)) {
    if (!hasLocalSession(req.headers.cookie, secret)) {
      return { ok: false, status: 401, error: 'local_session_required' };
    }
  }
  return { ok: true };
}

/**
 * Trava de tentativas do PIN. Sem ela, 4 dígitos caem em minutos. Em memória:
 * reiniciar o app zera, mas reiniciar exige estar na máquina — e a sessão
 * local já tira o PIN do alcance de quem não está na janela do app.
 */
export class PinAttemptLimiter {
  private failures = 0;
  private lockedUntil = 0;
  private readonly freeAttempts: number;
  private readonly baseLockMs: number;
  private readonly maxLockMs: number;
  private readonly now: () => number;

  constructor(freeAttempts = 5, baseLockMs = 30_000, maxLockMs = 15 * 60_000, now: () => number = Date.now) {
    this.freeAttempts = freeAttempts;
    this.baseLockMs = baseLockMs;
    this.maxLockMs = maxLockMs;
    this.now = now;
  }

  /** Segundos até poder tentar de novo; 0 = pode. */
  retryAfterSeconds(): number {
    const left = this.lockedUntil - this.now();
    return left > 0 ? Math.ceil(left / 1000) : 0;
  }

  recordFailure(): void {
    this.failures += 1;
    if (this.failures >= this.freeAttempts) {
      const exp = this.failures - this.freeAttempts;
      const lock = Math.min(this.baseLockMs * 2 ** exp, this.maxLockMs);
      this.lockedUntil = this.now() + lock;
    }
  }

  recordSuccess(): void {
    this.failures = 0;
    this.lockedUntil = 0;
  }
}

/** Só http(s) sai para o navegador do sistema — nunca file:, ms-*, etc. */
export function isSafeExternalUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

/** Imagem do cardápio: só https. */
export function isAllowedImageSource(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}
