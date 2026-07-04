import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Gera o "app-server" do desktop a partir do build da Alinhafood 01.
 *
 * SOMENTE LEITURA na pasta de produção: roda `next build` lá (mesmo comando do
 * deploy) e copia o resultado para resources/app-server. Nenhum arquivo da
 * Alinhafood 01 é modificado.
 */

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webRoot = path.resolve(desktopRoot, '..', 'Alinhafood 01');
const envFile = path.join(desktopRoot, '.env.desktop');
const outDir = path.join(desktopRoot, 'resources', 'app-server');

const REQUIRED_KEYS = [
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'NEXT_PUBLIC_APP_URL',
  'ADMIN_PATH_SECRET',
  'NEXT_PUBLIC_ADMIN_PATH_SECRET',
];

const FORBIDDEN_KEYS = ['SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_JWT_SECRET'];

function parseEnvFile(file) {
  const env = {};
  for (const rawLine of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    const comment = value.indexOf(' #');
    if (comment !== -1) value = value.slice(0, comment).trim();
    env[key] = value;
  }
  return env;
}

if (!fs.existsSync(envFile)) {
  console.error('[build-app] .env.desktop não encontrado.');
  console.error('  → copie .env.desktop.example para .env.desktop e preencha os valores.');
  process.exit(1);
}

const desktopEnv = parseEnvFile(envFile);

for (const key of FORBIDDEN_KEYS) {
  if (desktopEnv[key]) {
    console.error(`[build-app] ERRO DE SEGURANÇA: ${key} presente no .env.desktop.`);
    console.error('  Chaves privadas NUNCA podem entrar no build do desktop. Remova e tente de novo.');
    process.exit(1);
  }
}

const missing = REQUIRED_KEYS.filter((key) => !desktopEnv[key]);
if (missing.length > 0) {
  console.error(`[build-app] faltam variáveis no .env.desktop: ${missing.join(', ')}`);
  process.exit(1);
}

console.log(`[build-app] rodando next build em ${webRoot} ...`);
execSync('npm run build', {
  cwd: webRoot,
  stdio: 'inherit',
  env: { ...process.env, ...desktopEnv },
});

const standaloneDir = path.join(webRoot, '.next', 'standalone');
if (!fs.existsSync(standaloneDir)) {
  console.error('[build-app] .next/standalone não foi gerado — confira output: "standalone" no next.config.ts');
  process.exit(1);
}

console.log('[build-app] copiando standalone + static + public ...');
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(path.dirname(outDir), { recursive: true });
fs.cpSync(standaloneDir, outDir, { recursive: true });

// O standalone pode nidificar o app num subdiretório (workspace root inference)
function findServerJsDir(dir) {
  if (fs.existsSync(path.join(dir, 'server.js'))) return dir;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name === '.next') continue;
    const nested = findServerJsDir(path.join(dir, entry.name));
    if (nested) return nested;
  }
  return null;
}

const serverDir = findServerJsDir(outDir);
if (!serverDir) {
  console.error('[build-app] server.js não encontrado no standalone copiado');
  process.exit(1);
}

fs.cpSync(path.join(webRoot, '.next', 'static'), path.join(serverDir, '.next', 'static'), { recursive: true });
const publicDir = path.join(webRoot, 'public');
if (fs.existsSync(publicDir)) {
  fs.cpSync(publicDir, path.join(serverDir, 'public'), { recursive: true });
}

const config = {
  cloudUrl: desktopEnv.NEXT_PUBLIC_APP_URL,
  gatewayPort: 3737,
  appServerPort: 3738,
  supabaseUrl: desktopEnv.NEXT_PUBLIC_SUPABASE_URL,
  supabaseAnonKey: desktopEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  adminPathSecret: desktopEnv.ADMIN_PATH_SECRET,
};
fs.writeFileSync(
  path.join(desktopRoot, 'resources', 'desktop-config.json'),
  JSON.stringify(config, null, 2),
);

console.log(`[build-app] pronto: ${outDir}`);
console.log(`[build-app] server.js em: ${serverDir}`);
console.log('[build-app] desktop-config.json gerado');
