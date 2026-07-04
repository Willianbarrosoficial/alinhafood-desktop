import { app, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Guarda o access_token do admin capturado no login (via gateway) para o
 * sync engine autenticar chamadas ao /api/sync/pull da nuvem.
 *
 * Cifrado com safeStorage (Keychain/DPAPI) quando disponível; nunca em texto
 * plano se o SO oferecer cofre. É um JWT de sessão — NÃO é chave de API.
 */

const FILE = 'admin-session.bin';

function filePath(): string {
  return path.join(app.getPath('userData'), FILE);
}

let cached: string | null | undefined;

export function saveAdminToken(token: string): void {
  cached = token;
  const data = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(token)
    : Buffer.from(token, 'utf8');
  fs.writeFileSync(filePath(), data, { mode: 0o600 });
}

export function clearAdminToken(): void {
  cached = null;
  fs.rmSync(filePath(), { force: true });
}

export function getAdminToken(): string | null {
  if (cached !== undefined) return cached;
  try {
    const raw = fs.readFileSync(filePath());
    cached = safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(raw)
      : raw.toString('utf8');
  } catch {
    cached = null;
  }
  return cached;
}
