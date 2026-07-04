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

    -- Fase 3: escrita offline. Pedido criado offline vive aqui até a nuvem
    -- confirmar (pushed=1); o evento de subida nasce na MESMA transação.
    CREATE TABLE IF NOT EXISTS offline_orders (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL,
      table_number INTEGER,
      order_number TEXT,
      status TEXT NOT NULL,
      payment_status TEXT NOT NULL DEFAULT 'unpaid',
      created_at TEXT NOT NULL,
      data TEXT NOT NULL,
      pushed INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_offline_orders_table ON offline_orders (table_number, pushed);

    CREATE TABLE IF NOT EXISTS sync_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_outbox_status ON sync_outbox (status, id);

    -- Mudanças offline sobre pedidos que JÁ existem na nuvem (status, pago):
    -- o espelho é read-only, então o patch local vive aqui até o replay subir.
    CREATE TABLE IF NOT EXISTS order_overrides (
      order_id TEXT PRIMARY KEY,
      patch TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- Notinhas offline: mesmo contrato do print_jobs da nuvem — o print agent
    -- C# consome via gateway (/api/print/jobs) sem saber a diferença.
    CREATE TABLE IF NOT EXISTS print_jobs (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      dedupe_key TEXT UNIQUE,
      status TEXT NOT NULL DEFAULT 'pending',
      copies INTEGER NOT NULL DEFAULT 1,
      payload TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      claimed_at TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_print_jobs_status ON print_jobs (status, created_at);
  `);

  // Migração aditiva: método HTTP do replay (PATCH p/ status, POST demais)
  try {
    db.exec("ALTER TABLE sync_outbox ADD COLUMN method TEXT NOT NULL DEFAULT 'POST'");
  } catch {
    // coluna já existe
  }

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
