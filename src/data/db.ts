import Database from 'better-sqlite3-multiple-ciphers';
import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { carregarOuCriarChave } from './db-key';

/**
 * Banco local do desktop — %APPDATA%/Alinhafood/store.db (WAL, cifrado).
 *
 * Fase 2: espelho de LEITURA genérico (mirror_rows guarda a linha inteira em
 * JSON, agnóstico a schema — resiliente a mudanças de colunas na nuvem).
 * Fase 3 adiciona tabelas próprias para escrita (orders, caixa, outbox).
 *
 * Cifra (auditoria LGPD 2026-09-04, L-24): o arquivo é o espelho de pedidos e
 * clientes da loja; em texto puro, um PC roubado levava a base inteira. O driver
 * `better-sqlite3-multiple-ciphers` é o mesmo better-sqlite3 com o SQLite3
 * Multiple Ciphers embutido; a chave vem de db-key.ts. Um store.db antigo (até
 * a 0.6.1) é cifrado NO LUGAR no primeiro boot, via `PRAGMA rekey`.
 */

let db: Database.Database | null = null;

/** O banco responde com esta chave (ou sem chave, se `d` foi aberto sem ela)? */
function estaLegivel(d: Database.Database): boolean {
  try {
    d.prepare('SELECT count(*) AS n FROM sqlite_master').get();
    return true;
  } catch {
    return false; // "file is not a database": chave errada ou ausente
  }
}

function aplicarChave(d: Database.Database, hex: string): void {
  // Passphrase (o hex vira senha, derivada pelo driver). O formato raw x'…' varia
  // por cifra; a passphrase funciona em todas e é o que a documentação recomenda.
  d.pragma(`key = '${hex}'`);
}

/**
 * Abre store.db cifrado. Três casos:
 *  - arquivo não existe → cria já cifrado;
 *  - arquivo cifrado com a nossa chave → abre;
 *  - arquivo em texto puro (instalação antiga) → cifra no lugar e abre.
 * Se a cifra falhar, devolve o banco como está: operação da loja primeiro. O
 * motivo fica em local_meta.db_encryption para o suporte enxergar.
 */
function abrirCifrado(file: string): { db: Database.Database; estado: string } {
  const { hex, protegida } = carregarOuCriarChave();
  const existia = fs.existsSync(file);

  let d = new Database(file);
  aplicarChave(d, hex);
  if (!existia || estaLegivel(d)) {
    return { db: d, estado: protegida ? 'ok' : 'ok-chave-sem-safeStorage' };
  }

  // Não abriu com a chave: ou é texto puro (0.6.1 e anteriores) ou é outra chave.
  d.close();
  const plain = new Database(file);
  if (!estaLegivel(plain)) {
    plain.close();
    throw new Error('store.db ilegível com a chave atual e também sem chave — store.key trocada?');
  }

  console.warn('[db] store.db em texto puro — cifrando no lugar (uma vez só)');
  try {
    // rekey precisa do arquivo inteiro: sai do WAL (checkpoint + remove -wal/-shm),
    // cifra, e o WAL volta em getDb().
    plain.pragma('journal_mode = DELETE');
    plain.pragma(`rekey = '${hex}'`);
    plain.close();
  } catch (err) {
    try { plain.close(); } catch { /* já fechado */ }
    const motivo = (err as Error).message;
    console.error('[db] falha ao cifrar store.db — seguindo em texto puro:', motivo);
    const aberto = new Database(file);
    return { db: aberto, estado: `failed:${motivo.slice(0, 120)}` };
  }

  d = new Database(file);
  aplicarChave(d, hex);
  if (!estaLegivel(d)) {
    d.close();
    throw new Error('store.db não abre depois do rekey — dado local em risco, não prosseguir');
  }
  console.log('[db] store.db cifrado com sucesso');
  return { db: d, estado: 'ok-migrado' };
}

export function getDb(): Database.Database {
  if (db) return db;

  const dir = app.getPath('userData');
  fs.mkdirSync(dir, { recursive: true });
  const aberto = abrirCifrado(path.join(dir, 'store.db'));
  db = aberto.db;
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

  // Migração aditiva: destino da notinha offline. Sem elas, o modo offline só
  // sabia imprimir uma via no balcão — numa loja com cozinha e produção, tudo
  // que fosse pedido com o Desktop desconectado saía numa impressora só.
  try {
    db.exec("ALTER TABLE print_jobs ADD COLUMN target TEXT NOT NULL DEFAULT 'hall'");
  } catch {
    // coluna já existe
  }
  try {
    db.exec('ALTER TABLE print_jobs ADD COLUMN sector_id TEXT');
  } catch {
    // coluna já existe
  }

  if (!getMeta('device_id')) setMeta('device_id', crypto.randomUUID());
  setMeta('db_encryption', aberto.estado);

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
