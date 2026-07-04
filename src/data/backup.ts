import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { getDb, getMeta, setMeta } from './db';

/**
 * Backup local automático do banco (Fase 3 — 1 PC).
 *
 * Snapshot via better-sqlite3 .backup() (consistente mesmo com o banco em uso):
 *  - 1x/dia (rotação: mantém os 7 mais recentes);
 *  - antes de cada auto-update (rotação: mantém os 3 mais recentes).
 *
 * A nuvem continua sendo o backup principal; isto protege a janela de dados
 * offline ainda não sincronizados e permite rollback de update problemático.
 */

const DAILY_KEEP = 7;
const PREUPDATE_KEEP = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

function backupsDir(): string {
  const dir = path.join(app.getPath('userData'), 'backups');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function rotate(prefix: string, keep: number): void {
  const files = fs
    .readdirSync(backupsDir())
    .filter((f) => f.startsWith(prefix) && f.endsWith('.db'))
    .sort();
  for (const old of files.slice(0, Math.max(0, files.length - keep))) {
    fs.rmSync(path.join(backupsDir(), old), { force: true });
  }
}

async function snapshot(prefix: string, keep: number): Promise<string | null> {
  const dest = path.join(backupsDir(), `${prefix}-${stamp()}.db`);
  try {
    await getDb().backup(dest);
    rotate(prefix, keep);
    console.log(`[backup] snapshot criado: ${path.basename(dest)}`);
    return dest;
  } catch (err) {
    console.error('[backup] falha ao criar snapshot:', (err as Error).message);
    return null;
  }
}

/** Cria o backup diário se já passou ~24h do último (chamado no boot). */
export async function backupIfDue(): Promise<void> {
  const lastMs = Number(getMeta('last_daily_backup') ?? '0');
  if (Date.now() - lastMs < DAY_MS) return;
  const created = await snapshot('daily', DAILY_KEEP);
  if (created) setMeta('last_daily_backup', String(Date.now()));
}

/** Backup antes de aplicar uma atualização (chamado pelo auto-updater). */
export async function backupBeforeUpdate(): Promise<void> {
  await snapshot('preupdate', PREUPDATE_KEEP);
}
