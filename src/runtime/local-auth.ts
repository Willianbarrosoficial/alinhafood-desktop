import crypto from 'node:crypto';
import { getMeta, setMeta, readMirrorTable } from '../data/db';
import { getActivationToken, hasActivation, getSessionSnapshot } from './session-store';

/**
 * PIN de emergência — login offline (Fase 3).
 *
 * Não cria token novo: o PIN DESTRAVA a re-instalação da sessão já capturada
 * no login online. O access_token (ES256) fica cifrado via safeStorage
 * (session-store); o middleware valida a assinatura localmente com a JWKS do
 * espelho (ignora expiração). Assim o admin volta ao app durante um apagão
 * sem que a senha real do Supabase toque o disco.
 *
 * Escopo: só destrava a operação de salão offline naquele PC. Revogável — no
 * próximo login online o token é re-capturado; se a nuvem invalidar a sessão,
 * o supabase-js do cliente falha o refresh e força re-login.
 */

const SCRYPT_KEYLEN = 32;

export interface LocalAuthState {
  hasPin: boolean;
  hasSession: boolean;
}

export function localAuthState(): LocalAuthState {
  return {
    hasPin: getMeta('pin_hash') !== null,
    // Ativação durável — sobrevive a logout offline, ao contrário da sessão viva
    hasSession: hasActivation(),
  };
}

/** Define/atualiza o PIN. Exige uma ativação (login online prévio neste PC). */
export function setupPin(pin: string): { ok: true } | { ok: false; error: string } {
  if (!/^\d{4,8}$/.test(pin)) {
    return { ok: false, error: 'O PIN deve ter de 4 a 8 dígitos.' };
  }
  if (!hasActivation()) {
    return { ok: false, error: 'Faça login com internet antes de definir o PIN de emergência.' };
  }
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pin, salt, SCRYPT_KEYLEN);
  setMeta('pin_salt', salt.toString('hex'));
  setMeta('pin_hash', hash.toString('hex'));
  console.log('[local-auth] PIN de emergência definido');
  return { ok: true };
}

export function verifyPin(pin: string): boolean {
  const saltHex = getMeta('pin_salt');
  const hashHex = getMeta('pin_hash');
  if (!saltHex || !hashHex) return false;
  try {
    const expected = Buffer.from(hashHex, 'hex');
    const actual = crypto.scryptSync(pin, Buffer.from(saltHex, 'hex'), SCRYPT_KEYLEN);
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

/** Token durável para re-instalar a sessão após o PIN (sobrevive a logout offline). */
export function storedSessionToken(): string | null {
  return getActivationToken();
}

/** Snapshot da sessão do supabase-js p/ o cliente restaurar no localStorage. */
export function sessionSnapshot(): string | null {
  return getSessionSnapshot();
}

/** Caminho do admin p/ redirecionar após o login por PIN: /<slug>/admin/<secret>. */
export function adminRedirectPath(adminPathSecret: string): string | null {
  const restaurant = readMirrorTable<{ slug?: string }>('restaurants')[0];
  if (!restaurant?.slug || !adminPathSecret) return null;
  return `/${restaurant.slug}/admin/${adminPathSecret}`;
}
