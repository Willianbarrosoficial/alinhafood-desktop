import { request } from 'undici';
import type { DesktopConfig } from '../config';
import type { HealthMonitor } from '../runtime/health-monitor';
import { getAdminToken } from '../runtime/session-store';
import { replaceMirrorTable, setMeta, getMeta, mirrorCounts, getDb } from '../data/db';
import { markOrderPushed } from '../data/orders-local';

/**
 * Down-sync (Fase 2): snapshot das tabelas de leitura do escopo de salão.
 *
 * Estratégia snapshot (não incremental): o catálogo de um restaurante são
 * centenas de linhas — puxar tudo a cada ciclo é barato, elimina o problema
 * de detectar deleções (o clássico do cursor updated_at) e é resiliente a
 * qualquer mudança de schema na nuvem. Incremental fica para quando houver
 * medição real de necessidade.
 */

const SYNC_INTERVAL_MS = 60_000;

export interface PullEngineStatus {
  lastSyncAt: string | null;
  lastError: string | null;
  tables: Record<string, number>;
  restaurantId: string | null;
  outbox: { pending: number; dead: number; done: number };
}

interface OutboxRow {
  id: number;
  entity: string;
  entity_id: string;
  endpoint: string;
  payload: string;
  attempts: number;
}

interface PullResponse {
  restaurant_id: string;
  subscription_active: boolean;
  tables: Record<string, Array<{ id: string | number }>>;
  server_time: string;
}

export class PullEngine {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastError: string | null = null;

  constructor(
    private config: DesktopConfig,
    private health: HealthMonitor,
  ) {
    // Reconexão dispara sync imediato (push virá antes do pull na Fase 3)
    health.on('change', (mode: string) => {
      if (mode === 'online') void this.syncNow();
    });
  }

  start(): void {
    if (this.timer) return;
    void this.syncNow();
    this.timer = setInterval(() => void this.syncNow(), SYNC_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  status(): PullEngineStatus {
    const counts = getDb()
      .prepare('SELECT status, COUNT(*) as n FROM sync_outbox GROUP BY status')
      .all() as Array<{ status: string; n: number }>;
    const byStatus = Object.fromEntries(counts.map((c) => [c.status, c.n]));
    return {
      lastSyncAt: getMeta('last_sync_at'),
      lastError: this.lastError,
      tables: mirrorCounts(),
      restaurantId: getMeta('restaurant_id'),
      outbox: {
        pending: byStatus['pending'] ?? 0,
        dead: byStatus['dead'] ?? 0,
        done: byStatus['done'] ?? 0,
      },
    };
  }

  /**
   * Drena a outbox em ordem cronológica (push ANTES do pull — o estado do
   * salão offline é a autoridade). Idempotência garantida na nuvem pela PK.
   *  - 2xx (created/duplicate) → done;
   *  - 401/403 → sessão expirada: para o ciclo, mantém pendente;
   *  - 4xx de validação → dead-letter (visível no status, nunca some sozinho);
   *  - 5xx/rede → mantém pendente e para o ciclo (backoff = próximo ciclo).
   */
  private async drainOutbox(token: string): Promise<void> {
    const db = getDb();
    const pending = db
      .prepare("SELECT id, entity, entity_id, endpoint, payload, attempts FROM sync_outbox WHERE status = 'pending' ORDER BY id")
      .all() as OutboxRow[];
    if (pending.length === 0) return;

    console.log(`[sync] outbox: ${pending.length} evento(s) para subir`);
    for (const evt of pending) {
      try {
        const res = await request(`${this.config.cloudUrl.replace(/\/$/, '')}${evt.endpoint}`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
            'x-alinhafood-desktop': '1',
          },
          body: evt.payload,
          headersTimeout: 20_000,
          bodyTimeout: 30_000,
        });
        const responseBody = (await res.body.json().catch(() => null)) as
          | { status?: string; error?: string }
          | null;

        if (res.statusCode >= 200 && res.statusCode < 300) {
          db.prepare("UPDATE sync_outbox SET status = 'done', last_error = NULL WHERE id = ?").run(evt.id);
          if (evt.entity === 'order') markOrderPushed(evt.entity_id);
          console.log(`[sync] ${evt.entity} ${evt.entity_id} subiu (${responseBody?.status ?? res.statusCode})`);
        } else if (res.statusCode === 401 || res.statusCode === 403) {
          this.lastError = 'sessão expirada — faça login novamente para sincronizar';
          return;
        } else if (res.statusCode === 404) {
          // Endpoint ausente na nuvem (deploy pendente / mismatch de versão) —
          // retryable, nunca dead-letter: o pedido não pode morrer por isso.
          this.lastError = 'nuvem sem endpoint de sync — aguardando deploy';
          db.prepare('UPDATE sync_outbox SET attempts = attempts + 1, last_error = ? WHERE id = ?').run(
            this.lastError,
            evt.id,
          );
          return;
        } else if (res.statusCode >= 400 && res.statusCode < 500) {
          const reason = responseBody?.error ?? `HTTP ${res.statusCode}`;
          db.prepare(
            "UPDATE sync_outbox SET status = 'dead', attempts = attempts + 1, last_error = ? WHERE id = ?",
          ).run(reason, evt.id);
          console.error(`[sync] evento ${evt.id} rejeitado pela nuvem (dead-letter): ${reason}`);
        } else {
          db.prepare('UPDATE sync_outbox SET attempts = attempts + 1, last_error = ? WHERE id = ?').run(
            `HTTP ${res.statusCode}`,
            evt.id,
          );
          return;
        }
      } catch (err) {
        db.prepare('UPDATE sync_outbox SET attempts = attempts + 1, last_error = ? WHERE id = ?').run(
          (err as Error).message,
          evt.id,
        );
        return;
      }
    }
  }

  async syncNow(): Promise<void> {
    if (this.running || !this.health.isOnline()) return;
    const token = getAdminToken();
    if (!token) return; // ainda sem login — nada a sincronizar

    this.running = true;
    try {
      // Push primeiro, pull depois — o que aconteceu offline chega à nuvem
      // antes de qualquer atualização de espelho sobrescrever o estado local.
      await this.drainOutbox(token);

      const res = await request(`${this.config.cloudUrl.replace(/\/$/, '')}/api/sync/pull`, {
        method: 'GET',
        headers: {
          authorization: `Bearer ${token}`,
          'x-alinhafood-desktop': '1',
        },
        headersTimeout: 20_000,
        bodyTimeout: 60_000,
      });

      if (res.statusCode === 401 || res.statusCode === 403) {
        await res.body.dump();
        this.lastError = 'sessão expirada — faça login novamente';
        return;
      }
      if (res.statusCode !== 200) {
        await res.body.dump();
        this.lastError = `nuvem respondeu ${res.statusCode}`;
        return;
      }

      const payload = (await res.body.json()) as PullResponse;
      for (const [table, rows] of Object.entries(payload.tables)) {
        replaceMirrorTable(table, rows);
      }
      setMeta('restaurant_id', payload.restaurant_id);
      setMeta('subscription_active', String(payload.subscription_active));
      setMeta('subscription_checked_at', payload.server_time);
      setMeta('last_sync_at', new Date().toISOString());
      this.lastError = null;
      console.log(
        `[sync] espelho atualizado: ${Object.entries(payload.tables)
          .map(([t, r]) => `${t}=${r.length}`)
          .join(' ')}`,
      );
    } catch (err) {
      this.lastError = (err as Error).message;
      console.error('[sync] falha no pull:', this.lastError);
    } finally {
      this.running = false;
    }
  }
}
