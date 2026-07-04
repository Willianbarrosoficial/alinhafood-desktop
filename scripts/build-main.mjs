import { build } from 'esbuild';

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
  alias: { '@': '../Alinhafood 01' },
});

console.log('[build-main] dist/main.js, dist/preload.js e dist/receipt-lib.js gerados');
