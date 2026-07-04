import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

export interface DesktopConfig {
  /** URL de produção do Alinhafood — alvo do proxy (ex.: https://alinhafood.com.br) */
  cloudUrl: string;
  /** Porta pública do gateway local (janela e, na Fase 4, dispositivos da LAN) */
  gatewayPort: number;
  /** Porta interna do Next standalone (somente 127.0.0.1) */
  appServerPort: number;
  supabaseUrl: string;
  supabaseAnonKey: string;
  adminPathSecret: string;
}

const DEFAULTS = {
  gatewayPort: 3737,
  appServerPort: 3738,
};

/** resources/ do app: pasta do projeto em dev, process.resourcesPath empacotado */
export function resourcesDir(): string {
  return app.isPackaged
    ? process.resourcesPath
    : path.join(__dirname, '..', 'resources');
}

export function appServerDir(): string {
  return path.join(resourcesDir(), 'app-server');
}

let cached: DesktopConfig | null = null;

export function loadConfig(): DesktopConfig {
  if (cached) return cached;

  const configPath = path.join(resourcesDir(), 'desktop-config.json');
  let fromFile: Partial<DesktopConfig> = {};
  if (fs.existsSync(configPath)) {
    fromFile = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Partial<DesktopConfig>;
  }

  const env = process.env;
  const config: DesktopConfig = {
    cloudUrl: env.ALINHAFOOD_CLOUD_URL ?? fromFile.cloudUrl ?? '',
    gatewayPort: Number(env.ALINHAFOOD_GATEWAY_PORT ?? fromFile.gatewayPort ?? DEFAULTS.gatewayPort),
    appServerPort: Number(env.ALINHAFOOD_APP_SERVER_PORT ?? fromFile.appServerPort ?? DEFAULTS.appServerPort),
    supabaseUrl: env.NEXT_PUBLIC_SUPABASE_URL ?? fromFile.supabaseUrl ?? '',
    supabaseAnonKey: env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? fromFile.supabaseAnonKey ?? '',
    adminPathSecret: env.ADMIN_PATH_SECRET ?? fromFile.adminPathSecret ?? '',
  };

  if (!config.cloudUrl) {
    throw new Error(
      'desktop-config.json não encontrado ou sem cloudUrl. Rode "npm run build:app" para gerá-lo a partir do .env.desktop.',
    );
  }

  cached = config;
  return config;
}
