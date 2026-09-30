/**
 * Re-export do formatador de notinha da Alinhafood 01 — bundlado pelo esbuild
 * (scripts/build-main.mjs) para dist/receipt-lib.js. A formatação offline fica
 * BYTE A BYTE idêntica à da nuvem: mesma função, mesma fonte.
 *
 * Pelo alias `@/` e não por caminho relativo: o alias segue ALINHAFOOD_WEB_ROOT
 * (a cópia limpa da main), o relativo apontava sempre para a pasta irmã.
 */
export { buildReceiptText, buildSectorReceiptText } from '@/lib/server/print-jobs';
export type { PrintOrderRow, PrintSettingsRow } from '@/lib/server/print-jobs';
