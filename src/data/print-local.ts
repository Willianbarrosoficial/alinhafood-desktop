import crypto from 'node:crypto';
import path from 'node:path';
import { getDb, readMirrorTable } from './db';

/**
 * Notinhas offline (Fase 3/4) — mesma formatação da nuvem via dist/receipt-lib
 * (buildReceiptText bundlado da Alinhafood 01), mesmo contrato de polling do
 * print agent (claim máx 5, stale reclaim 2min, 3 tentativas).
 */

const CLAIM_LIMIT = 5;
const MAX_ATTEMPTS = 3;
const STALE_CLAIM_MS = 2 * 60_000;

type ReceiptLib = {
  buildReceiptText: (
    order: Record<string, unknown>,
    restaurantName: string,
    settings: Record<string, unknown>,
  ) => string;
};

let receiptLib: ReceiptLib | null = null;
function getReceiptLib(): ReceiptLib | null {
  if (receiptLib) return receiptLib;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    receiptLib = require(path.join(__dirname, 'receipt-lib.js')) as ReceiptLib;
  } catch (err) {
    console.error('[print] receipt-lib indisponível:', (err as Error).message);
  }
  return receiptLib;
}

function mirrorSettings(): Record<string, unknown> | null {
  return readMirrorTable<Record<string, unknown>>('store_settings')[0] ?? null;
}

function mirrorRestaurantName(): string {
  const r = readMirrorTable<{ name?: string }>('restaurants')[0];
  return r?.name ?? 'Alinhafood';
}

export function expectedAgentToken(): string | null {
  const s = mirrorSettings();
  const token = s?.print_agent_token;
  return typeof token === 'string' && token.length > 0 ? token : null;
}

/** Cria a notinha local para um pedido offline (criação = trigger order_accepted). */
export function createLocalPrintJob(orderView: Record<string, unknown>, trigger = 'order_accepted'): void {
  const settings = mirrorSettings();
  if (!settings) return;
  if (trigger === 'order_accepted' && settings.print_auto_on_accept !== true) return;

  const lib = getReceiptLib();
  if (!lib) return;

  try {
    const receiptText = lib.buildReceiptText(orderView, mirrorRestaurantName(), settings);
    const copies = Math.min(Math.max(Number(settings.print_job_copies ?? 1), 1), 5);
    const orderId = String(orderView.id);
    getDb()
      .prepare(
        `INSERT INTO print_jobs (id, order_id, dedupe_key, status, copies, payload, created_at)
         VALUES (?, ?, ?, 'pending', ?, ?, ?)
         ON CONFLICT(dedupe_key) DO NOTHING`,
      )
      .run(
        crypto.randomUUID(),
        orderId,
        `${orderId}:${trigger}`,
        copies,
        JSON.stringify({
          receipt_text: receiptText,
          order_id: orderId,
          restaurant_name: mirrorRestaurantName(),
          total: Number(orderView.total ?? 0),
          customer_name: String(orderView.customer_name ?? ''),
          order_type: String(orderView.order_type ?? ''),
        }),
        new Date().toISOString(),
      );
    console.log(`[print] notinha local criada p/ pedido ${String(orderView.order_number ?? orderId)}`);
  } catch (err) {
    console.error('[print] falha ao montar notinha local:', (err as Error).message);
  }
}

interface ClaimedJob {
  id: string;
  order_id: string;
  copies: number;
  payload: Record<string, unknown>;
  attempts: number;
  created_at: string;
}

/** Contrato idêntico ao GET /api/print/jobs da nuvem: reclaim de stale + claim. */
export function claimLocalPrintJobs(): ClaimedJob[] {
  const db = getDb();
  const now = new Date().toISOString();
  const staleBefore = new Date(Date.now() - STALE_CLAIM_MS).toISOString();

  db.prepare(
    `UPDATE print_jobs SET status = 'pending', claimed_at = NULL,
       error_message = 'Job reencaminhado após perda de conexão com o agente.'
     WHERE status = 'processing' AND attempts < ? AND claimed_at < ?`,
  ).run(MAX_ATTEMPTS, staleBefore);
  db.prepare(
    `UPDATE print_jobs SET status = 'failed',
       error_message = 'Falha automática após expirar em processamento.'
     WHERE status = 'processing' AND attempts >= ? AND claimed_at < ?`,
  ).run(MAX_ATTEMPTS, staleBefore);

  const candidates = db
    .prepare(
      `SELECT id, order_id, copies, payload, attempts, created_at FROM print_jobs
       WHERE status = 'pending' AND attempts < ? ORDER BY created_at LIMIT ?`,
    )
    .all(MAX_ATTEMPTS, CLAIM_LIMIT) as Array<Omit<ClaimedJob, 'payload'> & { payload: string }>;

  const claim = db.prepare(
    `UPDATE print_jobs SET status = 'processing', claimed_at = ?, attempts = attempts + 1,
       error_message = NULL WHERE id = ? AND status = 'pending'`,
  );
  const claimed: ClaimedJob[] = [];
  for (const c of candidates) {
    if (claim.run(now, c.id).changes > 0) {
      claimed.push({ ...c, attempts: c.attempts + 1, payload: JSON.parse(c.payload) as Record<string, unknown> });
    }
  }
  return claimed;
}

/** PATCH do agente: completed | failed. Retorna false se o job não é local. */
export function updateLocalPrintJob(jobId: string, status: string, errorMessage?: string): boolean {
  const result = getDb()
    .prepare('UPDATE print_jobs SET status = ?, error_message = ? WHERE id = ?')
    .run(status === 'completed' ? 'completed' : 'failed', errorMessage ?? null, jobId);
  return result.changes > 0;
}

export function pendingLocalPrintJobs(): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) as n FROM print_jobs WHERE status IN ('pending','processing')")
    .get() as { n: number };
  return row.n;
}
