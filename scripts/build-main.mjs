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

console.log('[build-main] dist/main.js e dist/preload.js gerados');
