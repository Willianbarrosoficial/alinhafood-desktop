import { build } from 'esbuild';

// Mesma raiz do build:app (ver scripts/build-app-server.mjs): a notinha tem que
// sair do mesmo commit do painel embutido.
const webRoot = process.env.ALINHAFOOD_WEB_ROOT || '../Alinhafood 01';

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  packages: 'external',
  sourcemap: true,
};

await build({
  ...shared,
  entryPoints: ['src/main.ts'],
  outfile: 'dist/main.js',
});

await build({
  ...shared,
  entryPoints: ['src/preload.ts'],
  outfile: 'dist/preload.js',
});

await build({
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: false,
  entryPoints: ['src/print/receipt-lib.ts'],
  outfile: 'dist/receipt-lib.js',
  // Bundla TUDO (inclusive supabase-js, nunca instanciado offline) — o alias
  // resolve os imports '@/' da Alinhafood 01 dentro do próprio projeto dela.
  // `@alinhafood/shared` é o pacote de regras puras da Alinhafood 01 (resolvido
  // lá por `paths` do tsconfig, sem node_modules) — a notinha importa dele.
  alias: { '@': webRoot, '@alinhafood/shared': `${webRoot}/packages/shared/src` },
});

console.log('[build-main] dist/main.js, dist/preload.js e dist/receipt-lib.js gerados');
