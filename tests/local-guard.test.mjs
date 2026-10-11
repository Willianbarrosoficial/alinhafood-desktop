// Testes da guarda do gateway local (auditoria 2026-10-11, C-02).
// Rodar: npm test  (node --experimental-strip-types --test tests/)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LOCAL_SESSION_COOKIE,
  checkRequest,
  hasLocalSession,
  isAllowedImageSource,
  isSafeExternalUrl,
  newLocalSessionSecret,
  PinAttemptLimiter,
  stripLocalSessionCookie,
} from '../src/server/local-guard.ts';

const PORT = 3737;
const SECRET = newLocalSessionSecret();
const cookie = `outro=1; ${LOCAL_SESSION_COOKIE}=${SECRET}`;

function req(url, { method = 'GET', host = `127.0.0.1:${PORT}`, origin, cookie: c } = {}) {
  const headers = { host };
  if (origin !== undefined) headers.origin = origin;
  if (c !== undefined) headers.cookie = c;
  return { url, method, headers };
}

test('segredo novo a cada boot, 64 hex', () => {
  const a = newLocalSessionSecret();
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, newLocalSessionSecret());
});

test('Host de fora (DNS rebinding) é recusado em qualquer rota', () => {
  for (const url of ['/', '/api/local/status', '/api/admin/orders', '/desktop/status']) {
    const v = checkRequest(req(url, { host: `evil.example:${PORT}`, cookie }), PORT, SECRET);
    assert.equal(v.ok, false);
    assert.equal(v.status, 421);
  }
  assert.equal(checkRequest({ url: '/', method: 'GET', headers: {} }, PORT, SECRET).ok, false);
  assert.equal(checkRequest(req('/', { host: '127.0.0.1:9999' }), PORT, SECRET).ok, false);
});

test('localhost e 127.0.0.1 na porta certa passam', () => {
  assert.equal(checkRequest(req('/login'), PORT, SECRET).ok, true);
  assert.equal(checkRequest(req('/login', { host: `localhost:${PORT}` }), PORT, SECRET).ok, true);
});

test('/api/local/* sem a sessão local é 401', () => {
  for (const url of [
    '/api/local/auth/setup-pin',
    '/api/local/auth/pin-login',
    '/api/local/auth/state',
    '/api/local/query/orders-feed',
    '/api/local/write/mark-paid',
    '/api/local/orders',
    '/api/local/image?u=https://x/y.svg',
    '/api/local/update/install',
    '/api/local/status',
    '/api/local/events',
  ]) {
    const v = checkRequest(req(url), PORT, SECRET);
    assert.equal(v.ok, false, url);
    assert.equal(v.status, 401, url);
    const errado = checkRequest(req(url, { cookie: `${LOCAL_SESSION_COOKIE}=${'0'.repeat(64)}` }), PORT, SECRET);
    assert.equal(errado.ok, false, url);
  }
});

test('/api/local/* com a sessão local passa', () => {
  assert.equal(checkRequest(req('/api/local/query/products', { cookie }), PORT, SECRET).ok, true);
  assert.equal(
    checkRequest(req('/api/local/auth/pin-login', { method: 'POST', origin: `http://127.0.0.1:${PORT}`, cookie }), PORT, SECRET).ok,
    true,
  );
});

test('JWKS (chave pública, lida pelo app-server sem cookie) e /desktop/status ficam abertos', () => {
  assert.equal(checkRequest(req('/api/local/jwks'), PORT, SECRET).ok, true);
  assert.equal(checkRequest(req('/desktop/status'), PORT, SECRET).ok, true);
});

test('escrita de outra origem é recusada mesmo com a sessão, inclusive no proxy da nuvem', () => {
  for (const url of ['/api/local/auth/setup-pin', '/api/auth/session', '/api/admin/orders']) {
    const v = checkRequest(req(url, { method: 'POST', origin: 'https://evil.example', cookie }), PORT, SECRET);
    assert.equal(v.ok, false, url);
    assert.equal(v.status, 403, url);
  }
  const nulo = checkRequest(req('/api/auth/session', { method: 'POST', origin: 'null' }), PORT, SECRET);
  assert.equal(nulo.ok, false);
});

test('/api/auth/session exige a sessão local (grava e apaga a sessão do sync e do PIN)', () => {
  for (const [url, method] of [
    ['/api/auth/session', 'POST'],
    ['/api/auth/session', 'DELETE'],
    ['/api/auth/session', 'GET'],
    ['/api/auth/session?x=1', 'POST'],
  ]) {
    const sem = checkRequest(req(url, { method }), PORT, SECRET);
    assert.equal(sem.ok, false, `${method} ${url}`);
    assert.equal(sem.status, 401, `${method} ${url}`);
    const com = checkRequest(req(url, { method, origin: `http://127.0.0.1:${PORT}`, cookie }), PORT, SECRET);
    assert.equal(com.ok, true, `${method} ${url}`);
  }
  // As outras rotas de /api/auth seguem como antes (proxy para a nuvem).
  assert.equal(checkRequest(req('/api/auth/select-restaurant', { method: 'POST' }), PORT, SECRET).ok, true);
});

test('escrita sem Origin (print agent, app-server) segue para as rotas não-locais', () => {
  assert.equal(checkRequest(req('/api/print/jobs/abc', { method: 'PATCH' }), PORT, SECRET).ok, true);
});

test('hasLocalSession: tamanho diferente e cookie ausente', () => {
  assert.equal(hasLocalSession(undefined, SECRET), false);
  assert.equal(hasLocalSession(`${LOCAL_SESSION_COOKIE}=abc`, SECRET), false);
  assert.equal(hasLocalSession(cookie, SECRET), true);
});

test('o cookie da sessão local nunca é repassado', () => {
  assert.equal(stripLocalSessionCookie(cookie), 'outro=1');
  assert.equal(stripLocalSessionCookie(`${LOCAL_SESSION_COOKIE}=x`), undefined);
  assert.equal(stripLocalSessionCookie(undefined), undefined);
  assert.equal(stripLocalSessionCookie(['a=1', `${LOCAL_SESSION_COOKIE}=x`]), 'a=1');
});

test('PIN: 5 erros livres, depois espera crescente com teto', () => {
  let t = 0;
  const l = new PinAttemptLimiter(5, 30_000, 15 * 60_000, () => t);
  for (let i = 0; i < 4; i++) l.recordFailure();
  assert.equal(l.retryAfterSeconds(), 0);
  l.recordFailure();
  assert.equal(l.retryAfterSeconds(), 30);
  t += 30_000;
  assert.equal(l.retryAfterSeconds(), 0);
  l.recordFailure();
  assert.equal(l.retryAfterSeconds(), 60);
  for (let i = 0; i < 20; i++) l.recordFailure();
  assert.equal(l.retryAfterSeconds(), 900);
  l.recordSuccess();
  assert.equal(l.retryAfterSeconds(), 0);
});

test('openExternal só para http(s)', () => {
  assert.equal(isSafeExternalUrl('https://alinhafood.com.br'), true);
  assert.equal(isSafeExternalUrl('http://wa.me/55'), true);
  for (const u of ['file:///C:/Windows/system32/calc.exe', 'ms-msdt:/id', 'search-ms:query=x', 'javascript:alert(1)', 'lixo']) {
    assert.equal(isSafeExternalUrl(u), false, u);
  }
});

test('imagem do cardápio só por https', () => {
  assert.equal(isAllowedImageSource('https://x.supabase.co/storage/v1/object/public/a.png'), true);
  for (const u of ['http://192.168.0.1/admin', 'file:///etc/passwd', 'ftp://x/y']) {
    assert.equal(isAllowedImageSource(u), false, u);
  }
});
