import { EventEmitter } from 'node:events';
import { request } from 'undici';
import type { DesktopConfig } from '../config';

/**
 * Detecção de queda com histerese (evita flapping):
 *   2 falhas consecutivas  → OFFLINE
 *   3 sucessos consecutivos → ONLINE
 *
 * Distingue nuvem (app no Coolify) de Supabase: se o app cair mas o Supabase
 * estiver de pé, o supabase-js do client ainda funciona (modo "degradado" é
 * refinamento futuro; hoje qualquer um dos dois fora de ar = OFFLINE para o
 * gateway, que é quem depende da nuvem).
 */

export type Mode = 'online' | 'offline';

export interface HealthStatus {
  mode: Mode;
  cloudOk: boolean;
  supabaseOk: boolean;
  lastCheckAt: string | null;
  since: string;
}

const PROBE_INTERVAL_MS = 15_000;
const PROBE_TIMEOUT_MS = 3_000;
const FAILURES_TO_OFFLINE = 2;
const SUCCESSES_TO_ONLINE = 3;

export class HealthMonitor extends EventEmitter {
  private mode: Mode = 'online';
  private cloudOk = true;
  private supabaseOk = true;
  private lastCheckAt: string | null = null;
  private since = new Date().toISOString();
  private failures = 0;
  private successes = 0;
  private timer: NodeJS.Timeout | null = null;
  private forced: Mode | null = null;

  constructor(private config: DesktopConfig) {
    super();
  }

  start(): void {
    if (this.timer) return;
    void this.probe();
    this.timer = setInterval(() => void this.probe(), PROBE_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  status(): HealthStatus {
    return {
      mode: this.forced ?? this.mode,
      cloudOk: this.cloudOk,
      supabaseOk: this.supabaseOk,
      lastCheckAt: this.lastCheckAt,
      since: this.since,
    };
  }

  isOnline(): boolean {
    return (this.forced ?? this.mode) === 'online';
  }

  /** Simulação para QA (usada apenas fora do app empacotado). */
  force(mode: Mode | null): void {
    const before = this.forced ?? this.mode;
    this.forced = mode;
    const after = this.forced ?? this.mode;
    if (before !== after) this.transition(after);
  }

  private async probeUrl(url: string): Promise<boolean> {
    try {
      const res = await request(url, {
        method: 'GET',
        headersTimeout: PROBE_TIMEOUT_MS,
        bodyTimeout: PROBE_TIMEOUT_MS,
      });
      await res.body.dump();
      return res.statusCode < 500;
    } catch {
      return false;
    }
  }

  private async probe(): Promise<void> {
    const [cloudOk, supabaseOk] = await Promise.all([
      this.probeUrl(`${this.config.cloudUrl.replace(/\/$/, '')}/manifest.json`),
      this.probeUrl(`${this.config.supabaseUrl.replace(/\/$/, '')}/auth/v1/health`),
    ]);
    this.cloudOk = cloudOk;
    this.supabaseOk = supabaseOk;
    this.lastCheckAt = new Date().toISOString();

    const healthy = cloudOk && supabaseOk;
    if (healthy) {
      this.successes += 1;
      this.failures = 0;
      if (this.mode === 'offline' && this.successes >= SUCCESSES_TO_ONLINE) {
        this.mode = 'online';
        if (!this.forced) this.transition('online');
      }
    } else {
      this.failures += 1;
      this.successes = 0;
      if (this.mode === 'online' && this.failures >= FAILURES_TO_OFFLINE) {
        this.mode = 'offline';
        if (!this.forced) this.transition('offline');
      }
    }
  }

  private transition(mode: Mode): void {
    this.since = new Date().toISOString();
    console.log(`[health] modo → ${mode.toUpperCase()}`);
    this.emit('change', mode);
  }
}
