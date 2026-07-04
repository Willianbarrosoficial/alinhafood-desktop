import { app, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Guarda a sessão do admin capturada no login, para dois usos:
 *  1) o sync engine autenticar chamadas ao /api/sync/* da nuvem;
 *  2) o PIN de emergência re-instalar a sessão offline.
 *
 * DOIS arquivos, de propósito:
 *  - session.bin  → sessão "viva". Limpa num logout (DELETE /api/auth/session).
 *  - activation.bin → cópia DURÁVEL. Só é atualizada em login online; NUNCA
 *    limpa por logout offline. É a que o PIN usa. Sem isso, um logout espúrio
 *    durante a queda (o cliente não alcança o Supabase e "acha" que deslogou)
 *    apagaria a sessão e o PIN não teria o que re-instalar.
 *
 * Cifrado com safeStorage (Keychain/DPAPI). É um JWT de sessão — não é chave
 * de API. Um token stale re-instalado só dá acesso offline ao salão; quando a
 * nuvem volta, o supabase-js força re-login se a sessão tiver sido revogada.
 */

const SESSION_FILE = 'admin-session.bin';
const ACTIVATION_FILE = 'admin-activation.bin';
// Snapshot da sessão do supabase-js (localStorage do cliente) — permite o PIN
// restaurar o login do lado do CLIENTE (o React deriva `user` daqui), não só o
// cookie do servidor. Sem isso o admin abre e volta pro /login no apagão.
const SNAPSHOT_FILE = 'admin-session-snapshot.bin';

function filePath(name: string): string {
  return path.join(app.getPath('userData'), name);
}

function encode(token: string): Buffer {
  return safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(token)
    : Buffer.from(token, 'utf8');
}

function decode(raw: Buffer): string {
  return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(raw) : raw.toString('utf8');
}

let sessionCache: string | null | undefined;
let activationCache: string | null | undefined;

export function saveAdminToken(token: string): void {
  sessionCache = token;
  activationCache = token;
  fs.writeFileSync(filePath(SESSION_FILE), encode(token), { mode: 0o600 });
  // Cópia durável para o PIN — sobrevive a logouts offline
  fs.writeFileSync(filePath(ACTIVATION_FILE), encode(token), { mode: 0o600 });
}

export function clearAdminToken(): void {
  // Só a sessão viva. A ativação (usada pelo PIN) permanece de propósito.
  sessionCache = null;
  fs.rmSync(filePath(SESSION_FILE), { force: true });
}

export function getAdminToken(): string | null {
  if (sessionCache !== undefined) return sessionCache;
  try {
    sessionCache = decode(fs.readFileSync(filePath(SESSION_FILE)));
  } catch {
    sessionCache = null;
  }
  return sessionCache;
}

/** Token durável para o PIN re-instalar a sessão (a "ativação" do computador). */
export function getActivationToken(): string | null {
  if (activationCache !== undefined) return activationCache;
  try {
    activationCache = decode(fs.readFileSync(filePath(ACTIVATION_FILE)));
  } catch {
    activationCache = null;
  }
  return activationCache;
}

export function hasActivation(): boolean {
  return getActivationToken() !== null;
}

/** Snapshot da sessão do supabase-js (JSON do localStorage do cliente). */
export function saveSessionSnapshot(json: string): void {
  fs.writeFileSync(filePath(SNAPSHOT_FILE), encode(json), { mode: 0o600 });
}

export function getSessionSnapshot(): string | null {
  try {
    return decode(fs.readFileSync(filePath(SNAPSHOT_FILE)));
  } catch {
    return null;
  }
}
