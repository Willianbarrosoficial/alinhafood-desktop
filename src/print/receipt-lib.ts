/**
 * Re-export do formatador de notinha da Alinhafood 01 — bundlado pelo esbuild
 * (scripts/build-main.mjs) para dist/receipt-lib.js. A formatação offline fica
 * BYTE A BYTE idêntica à da nuvem: mesma função, mesma fonte.
 */
export { buildReceiptText } from '../../../Alinhafood 01/lib/server/print-jobs';
export type { PrintOrderRow, PrintSettingsRow } from '../../../Alinhafood 01/lib/server/print-jobs';
