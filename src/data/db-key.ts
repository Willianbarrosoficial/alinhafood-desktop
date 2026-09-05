import { app, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Chave do banco local cifrado (auditoria LGPD 2026-09-04, L-24).
 *
 * `%APPDATA%/Alinhafood/store.key`: 1 byte de modo + corpo.
 *   modo 0x01 → corpo cifrado pelo safeStorage do Electron (DPAPI no Windows,
 *               Keychain no Mac): só o mesmo usuário do mesmo PC decifra.
 *   modo 0x00 → corpo em texto (só quando o safeStorage não está disponível —
 *               raro no Windows; fica registrado no log para o suporte saber).
 *
 * A chave é aleatória (256 bits, hex) e nunca sai deste arquivo. Sem ela o
 * store.db é ilegível; o app então recria o banco vazio e sincroniza da nuvem,
 * que é a fonte de verdade — o espelho local é contingência, não arquivo.
 */
const KEY_FILE = 'store.key';
const HEX_256_BITS = /^[0-9a-f]{64}$/;

export type ChaveDoBanco = { hex: string; protegida: boolean };

function caminhoDaChave(): string {
  return path.join(app.getPath('userData'), KEY_FILE);
}

export function carregarOuCriarChave(): ChaveDoBanco {
  const file = caminhoDaChave();
  const disponivel = safeStorage.isEncryptionAvailable();

  if (fs.existsSync(file)) {
    const raw = fs.readFileSync(file);
    if (raw.length < 2) throw new Error('store.key vazia ou truncada');
    const modo = raw[0];
    const corpo = raw.subarray(1);
    let hex: string;
    if (modo === 1) {
      if (!disponivel) throw new Error('store.key protegida pelo safeStorage, mas o safeStorage não está disponível neste perfil');
      hex = safeStorage.decryptString(corpo);
    } else {
      hex = corpo.toString('utf8').trim();
    }
    if (!HEX_256_BITS.test(hex)) throw new Error('store.key com conteúdo inválido');
    return { hex, protegida: modo === 1 };
  }

  const hex = crypto.randomBytes(32).toString('hex');
  const corpo = disponivel ? safeStorage.encryptString(hex) : Buffer.from(hex, 'utf8');
  if (!disponivel) {
    console.warn('[db-key] safeStorage indisponível — store.key gravada sem proteção do sistema');
  }
  // Escrita atômica: um boot interrompido no meio não deixa uma chave pela metade
  // (que tornaria o banco cifrado ilegível para sempre).
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, Buffer.concat([Buffer.from([disponivel ? 1 : 0]), corpo]), { mode: 0o600 });
  fs.renameSync(tmp, file);
  return { hex, protegida: disponivel };
}
