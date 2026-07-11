/**
 * Classificação/filtro de impressoras no runtime desktop — espelha a lógica do
 * PrinterDetector.cs do agente standalone (filtra virtuais, marca térmicas,
 * ordena as melhores primeiro), aplicada por cima do getPrintersAsync do
 * Electron (que devolve a lista crua do Windows).
 */

const THERMAL =
  /epson.?tm|tm-?t\d|elgin|bematech|mp-?\d{2}|daruma|dr\d{3}|tanca|tp-?\d{3}|sweda|sewoo|xprinter|pos-?\d{2}|nitere|perto|esc[ -/]?pos|thermal|receipt|cupom|gprinter|knup|generic.*pos/i;

const VIRTUAL = /microsoft print to pdf|microsoft xps|onenote|fax|pdfcreator|send to onenote/i;

export interface RawPrinter {
  name: string;
  displayName?: string;
  description?: string;
  isDefault?: boolean;
}

export interface UiPrinter {
  name: string;
  displayName: string;
  isDefault: boolean;
  isLikelyThermal: boolean;
}

export function classifyPrinters(raw: RawPrinter[]): UiPrinter[] {
  const list = raw
    .filter((p) => p.name && !VIRTUAL.test(`${p.name} ${p.displayName ?? ''} ${p.description ?? ''}`))
    .map((p) => ({
      name: p.name,
      displayName: p.displayName || p.name,
      isDefault: p.isDefault ?? false,
      isLikelyThermal: THERMAL.test(`${p.name} ${p.displayName ?? ''} ${p.description ?? ''}`),
    }));

  return list.sort((a, b) => {
    if (a.isLikelyThermal !== b.isLikelyThermal) return a.isLikelyThermal ? -1 : 1;
    if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
    return a.displayName.localeCompare(b.displayName, 'pt-BR');
  });
}
