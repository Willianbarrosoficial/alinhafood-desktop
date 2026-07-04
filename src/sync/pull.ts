import { request } from 'undici';
import type { DesktopConfig } from '../config';
import type { HealthMonitor } from '../runtime/health-monitor';
import { getAdminToken } from '../runtime/session-store';
import { replaceMirrorTable, setMeta, getMeta, mirrorCounts } from '../data/db';

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
    return {
      lastSyncAt: getMeta('last_sync_at'),
      lastError: this.lastError,
      tables: mirrorCounts(),
      restaurantId: getMeta('restaurant_id'),
    };
  }

  async syncNow(): Promise<void> {
    if (this.running || !this.health.isOnline()) return;
    const token = getAdminToken();
    if (!token) return; // ainda sem login — nada a sincronizar

    this.running = true;
    try {
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
