import Database from 'better-sqlite3';
import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Banco local do desktop — %APPDATA%/Alinhafood/store.db (WAL).
 *
 * Fase 2: espelho de LEITURA genérico (mirror_rows guarda a linha inteira em
 * JSON, agnóstico a schema — resiliente a mudanças de colunas na nuvem).
 * Fase 3 adiciona tabelas próprias para escrita (orders, caixa, outbox).
 */

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;

  const dir = app.getPath('userData');
  fs.mkdirSync(dir, { recursive: true });
  db = new Database(path.join(dir, 'store.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS local_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS mirror_rows (
      table_name TEXT NOT NULL,
      id TEXT NOT NULL,
      data TEXT NOT NULL,
      synced_at TEXT NOT NULL,
      PRIMARY KEY (table_name, id)
    );
    CREATE INDEX IF NOT EXISTS idx_mirror_table ON mirror_rows (table_name);
  `);

  if (!getMeta('device_id')) setMeta('device_id', crypto.randomUUID());

  return db;
}

export function getMeta(key: string): string | null {
  const row = getDb().prepare('SELECT value FROM local_meta WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setMeta(key: string, value: string): void {
  getDb()
    .prepare('INSERT INTO local_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);
}

/** Substitui o espelho de uma tabela inteira numa transação (snapshot sync). */
export function replaceMirrorTable(tableName: string, rows: Array<{ id: string | number; [k: string]: unknown }>): void {
  const database = getDb();
  const now = new Date().toISOString();
  const del = database.prepare('DELETE FROM mirror_rows WHERE table_name = ?');
  const ins = database.prepare(
    'INSERT INTO mirror_rows (table_name, id, data, synced_at) VALUES (?, ?, ?, ?)',
  );
  database.transaction(() => {
    del.run(tableName);
    for (const row of rows) {
      ins.run(tableName, String(row.id), JSON.stringify(row), now);
    }
  })();
}

export function readMirrorTable<T = Record<string, unknown>>(tableName: string): T[] {
  const rows = getDb()
    .prepare('SELECT data FROM mirror_rows WHERE table_name = ?')
    .all(tableName) as Array<{ data: string }>;
  return rows.map((r) => JSON.parse(r.data) as T);
}

export function mirrorCounts(): Record<string, number> {
  const rows = getDb()
    .prepare('SELECT table_name, COUNT(*) as n FROM mirror_rows GROUP BY table_name')
    .all() as Array<{ table_name: string; n: number }>;
  return Object.fromEntries(rows.map((r) => [r.table_name, r.n]));
}
