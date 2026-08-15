import crypto from 'node:crypto';
import path from 'node:path';
import { getDb, readMirrorTable } from './db';

/**
 * Notinhas offline (Fase 3/4) — mesma formatação da nuvem via dist/receipt-lib
 * (buildReceiptText bundlado da Alinhafood 01), mesmo contrato de polling do
 * print agent (claim máx 5, stale reclaim 2min, 3 tentativas).
 */

const CLAIM_LIMIT = 5;
const MAX_ATTEMPTS = 3;
const STALE_CLAIM_MS = 2 * 60_000;

type ReceiptLib = {
  buildReceiptText: (
    order: Record<string, unknown>,
    restaurantName: string,
    settings: Record<string, unknown>,
  ) => string;
  /** Comanda de produção — só os itens do setor, sem preços. */
  buildSectorReceiptText?: (
    order: Record<string, unknown>,
    restaurantName: string,
    settings: Record<string, unknown>,
    sector: { name: string; paper_width_mm?: number | null },
    items: Array<Record<string, unknown>>,
  ) => string;
};

type MirrorSector = {
  id: string;
  slug: string;
  name: string;
  enabled?: boolean | number | null;
  paper_width_mm?: number | null;
  copies?: number | null;
  print_full_order?: boolean | number | null;
  fire_on?: string | null;
  /** Canal que o setor atende: 'all' | 'delivery' | 'salao'. */
  channel_filter?: string | null;
  is_default?: boolean | number | null;
  sort_order?: number | null;
  /** Computador (print_agents) que atende este setor — vem do sync/pull. */
  agent_id?: string | null;
};

/** Uma linha de "o que este setor imprime" (print_sector_rules da nuvem). */
type MirrorRule = {
  sector_id?: string | null;
  category_id?: string | null;
  product_id?: string | null;
  channel?: string | null;
};

type OrderChannel = 'delivery' | 'salao';

/** Escopo de um token por computador: quais setores aquele PC atende. */
export interface AgentScope {
  agentId: string;
  sectorIds: string[];
  slugs: string[];
}

/** SQLite guarda booleano como 0/1; o espelho da nuvem manda true/false. */
function isTrue(v: unknown): boolean {
  return v === true || v === 1 || v === '1' || v === 'true';
}

let receiptLib: ReceiptLib | null = null;
function getReceiptLib(): ReceiptLib | null {
  if (receiptLib) return receiptLib;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    receiptLib = require(path.join(__dirname, 'receipt-lib.js')) as ReceiptLib;
  } catch (err) {
    console.error('[print] receipt-lib indisponível:', (err as Error).message);
  }
  return receiptLib;
}

function mirrorSettings(): Record<string, unknown> | null {
  return readMirrorTable<Record<string, unknown>>('store_settings')[0] ?? null;
}

function mirrorRestaurantName(): string {
  const r = readMirrorTable<{ name?: string }>('restaurants')[0];
  return r?.name ?? 'Alinhafood';
}

export function expectedAgentToken(): string | null {
  const s = mirrorSettings();
  const token = s?.print_agent_token;
  return typeof token === 'string' && token.length > 0 ? token : null;
}

/**
 * Resolve um token por computador (print_agents) no espelho local — é o que
 * permite ao gateway aceitar os tokens da seção "Computadores" do painel, e
 * não só o token legado. Devolve null para token desconhecido E para espelho
 * sem a tabela (nuvem/pull antigos): nos dois casos o gateway se comporta
 * exatamente como antes.
 */
export function agentScopeByToken(token: string): AgentScope | null {
  if (!token) return null;
  try {
    const agent = readMirrorTable<{ id?: string; token?: string }>('print_agents')
      .find((a) => typeof a.token === 'string' && a.token === token);
    if (!agent?.id) return null;

    // Espelha o vínculo da nuvem (print_sectors.agent_id). Agente sem setor
    // tem escopo vazio — recebe nada, igual à fn_print_poll_multi.
    const meus = readMirrorTable<MirrorSector>('print_sectors')
      .filter((s) => isTrue(s.enabled) && s.agent_id === agent.id);

    return {
      agentId: agent.id,
      sectorIds: meus.map((s) => s.id),
      slugs: meus.map((s) => s.slug),
    };
  } catch {
    return null;
  }
}

/**
 * Setores habilitados espelhados da nuvem, na ordem de exibição.
 * Vazio significa "loja não usa setores" OU "o espelho ainda não trouxe a
 * tabela" — nos dois casos o caminho de uma notinha só continua valendo.
 */
function mirrorSectors(): MirrorSector[] {
  try {
    return readMirrorTable<MirrorSector>('print_sectors')
      .filter((s) => isTrue(s.enabled))
      .sort((a, b) => Number(a.sort_order ?? 0) - Number(b.sort_order ?? 0));
  } catch {
    return [];
  }
}

/**
 * Canal do pedido, para o recorte por canal. MESMA régua do servidor
 * (`resolveOrderChannel`): mesa, balcão e consumo no local são salão; entrega e
 * RETIRADA são delivery.
 */
function canalDoPedido(orderView: Record<string, unknown>): OrderChannel {
  const tipo = String(orderView.order_type ?? '');
  if (tipo === 'mesa' || tipo === 'balcao') return 'salao';
  if (String(orderView.delivery_type ?? '') === 'dine_in') return 'salao';
  return 'delivery';
}

/**
 * O que cada setor imprime, espelhado da nuvem e já recortado para o canal
 * deste pedido: category_id → setores, product_id → setores.
 *
 * Espelho sem regras cai no mapeamento antigo (`categories.print_sector_id`),
 * que cobre os dois casos em que ele fica vazio: nuvem antiga que ainda não
 * manda a tabela, e loja que de fato não configurou nada — nesta o espelho
 * legado também está vazio, porque o painel mantém os dois em sincronia.
 */
function mirrorRules(canal: OrderChannel, habilitados: Set<string>) {
  const porCategoria = new Map<string, string[]>();
  const porProduto = new Map<string, string[]>();

  const empilhar = (mapa: Map<string, string[]>, chave: string, sectorId: string) => {
    mapa.set(chave, [...(mapa.get(chave) ?? []), sectorId]);
  };

  let regras: MirrorRule[] = [];
  try {
    regras = readMirrorTable<MirrorRule>('print_sector_rules');
  } catch {
    regras = [];
  }

  if (regras.length > 0) {
    for (const r of regras) {
      if (!r.sector_id || !habilitados.has(r.sector_id)) continue;
      const canalRegra = r.channel ?? 'all';
      if (canalRegra !== 'all' && canalRegra !== canal) continue;
      if (r.product_id) empilhar(porProduto, r.product_id, r.sector_id);
      else if (r.category_id) empilhar(porCategoria, r.category_id, r.sector_id);
    }
    return { porCategoria, porProduto };
  }

  try {
    for (const c of readMirrorTable<{ id?: string; print_sector_id?: string | null }>('categories')) {
      if (c.id && c.print_sector_id && habilitados.has(c.print_sector_id)) {
        empilhar(porCategoria, c.id, c.print_sector_id);
      }
    }
  } catch {
    // espelho antigo, sem a coluna — segue sem mapeamento
  }
  return { porCategoria, porProduto };
}

/** Cria a notinha local para um pedido offline (criação = trigger order_accepted). */
export function createLocalPrintJob(orderView: Record<string, unknown>, trigger = 'order_accepted'): void {
  const settings = mirrorSettings();
  if (!settings) return;
  if (trigger === 'order_accepted' && settings.print_auto_on_accept !== true) return;

  const lib = getReceiptLib();
  if (!lib) return;

  const orderId = String(orderView.id);
  const restaurantName = mirrorRestaurantName();
  const agora = new Date().toISOString();

  const insert = getDb().prepare(
    `INSERT INTO print_jobs (id, order_id, dedupe_key, status, copies, payload, created_at, target, sector_id)
     VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?)
     ON CONFLICT(dedupe_key) DO NOTHING`,
  );

  try {
    const sectors = mirrorSectors();
    const usaSetores =
      settings.print_routing_mode === 'sector' &&
      sectors.length > 0 &&
      typeof lib.buildSectorReceiptText === 'function';

    // Fallback duro: sem setores no espelho, sem a função de comanda no bundle,
    // ou loja em modo legado → uma notinha completa, exatamente como antes.
    // Offline NUNCA pode deixar de imprimir por falta de configuração nova.
    if (!usaSetores) {
      const receiptText = lib.buildReceiptText(orderView, restaurantName, settings);
      const copies = Math.min(Math.max(Number(settings.print_job_copies ?? 1), 1), 5);
      insert.run(
        crypto.randomUUID(), orderId, `${orderId}:${trigger}`, copies,
        JSON.stringify({
          receipt_text: receiptText,
          order_id: orderId,
          restaurant_name: restaurantName,
          total: Number(orderView.total ?? 0),
          customer_name: String(orderView.customer_name ?? ''),
          order_type: String(orderView.order_type ?? ''),
        }),
        agora, 'hall', null,
      );
      console.log(`[print] notinha local criada p/ pedido ${String(orderView.order_number ?? orderId)}`);
      return;
    }

    // ── Roteamento por setor, espelhando a regra do servidor ──
    // Setor restrito a um canal sai inteiro deste pedido, igual à nuvem.
    const canal = canalDoPedido(orderView);
    const doCanal = sectors.filter((s) => {
      const filtro = s.channel_filter ?? 'all';
      return filtro === 'all' || filtro === canal;
    });
    const habilitados = new Set(doCanal.map((s) => s.id));
    const { porCategoria, porProduto } = mirrorRules(canal, habilitados);
    const padrao =
      doCanal.find((s) => isTrue(s.is_default)) ??
      doCanal.find((s) => s.slug === 'hall') ??
      doCanal[0];

    // Sem nenhum setor atendendo este canal não há para onde mandar; a nota
    // completa do fallback lá em cima é melhor que pedido sem papel.
    if (!padrao) {
      const receiptText = lib.buildReceiptText(orderView, restaurantName, settings);
      insert.run(
        crypto.randomUUID(), orderId, `${orderId}:${trigger}`,
        Math.min(Math.max(Number(settings.print_job_copies ?? 1), 1), 5),
        JSON.stringify({
          receipt_text: receiptText,
          order_id: orderId,
          restaurant_name: restaurantName,
          total: Number(orderView.total ?? 0),
          customer_name: String(orderView.customer_name ?? ''),
          order_type: String(orderView.order_type ?? ''),
        }),
        agora, 'hall', null,
      );
      return;
    }

    const itens = Array.isArray(orderView.order_items)
      ? (orderView.order_items as Array<Record<string, unknown>>)
      : [];

    const disparaAgora = (s: MirrorSector) =>
      (s.fire_on ?? 'on_accept') === (trigger === 'order_accepted' ? 'on_accept' : trigger);
    const automatico = trigger !== 'manual_sector';
    const imprimeSozinho = new Set(
      doCanal.filter((s) => (s.fire_on ?? 'on_accept') !== 'manual').map((s) => s.id),
    );

    const porSetor = new Map<string, Array<Record<string, unknown>>>();
    const adicionar = (sectorId: string, item: Record<string, unknown>) => {
      const bucket = porSetor.get(sectorId);
      if (bucket) bucket.push(item);
      else porSetor.set(sectorId, [item]);
    };

    for (const item of itens) {
      // Mesma cascata do servidor: produto (exceção) → categoria → padrão. Um
      // item pode cair em VÁRIOS setores, e nenhum item pode ficar sem destino.
      const produto = item.products as { category_id?: string | null } | null | undefined;
      const productId = typeof item.product_id === 'string' ? item.product_id : null;
      const catId = produto?.category_id ?? null;

      let destinos = (productId ? porProduto.get(productId) : undefined) ?? [];
      if (destinos.length === 0) destinos = (catId ? porCategoria.get(catId) : undefined) ?? [];
      if (destinos.length === 0) destinos = [padrao.id];

      for (const sectorId of new Set(destinos)) adicionar(sectorId, item);

      // Item que só caiu em setor de disparo manual não sairia em comanda
      // nenhuma no fluxo automático — vai também para o padrão.
      if (automatico && !destinos.some((id) => imprimeSozinho.has(id)) && !destinos.includes(padrao.id)) {
        adicionar(padrao.id, item);
      }
    }

    let criados = 0;
    for (const setor of doCanal) {
      if (!disparaAgora(setor)) continue;
      const itensDoSetor = porSetor.get(setor.id) ?? [];
      const viaCompleta = isTrue(setor.print_full_order);
      if (!viaCompleta && itensDoSetor.length === 0) continue;

      const texto = viaCompleta
        ? lib.buildReceiptText(orderView, restaurantName, {
            ...settings,
            print_paper_width_mm: setor.paper_width_mm ?? settings.print_paper_width_mm,
          })
        : lib.buildSectorReceiptText!(orderView, restaurantName, settings,
            { name: setor.name, paper_width_mm: setor.paper_width_mm }, itensDoSetor);

      // dedupe_key no formato do servidor, para o mesmo pedido não sair duas
      // vezes quando a nuvem voltar e reprocessar.
      const dedupe = setor.slug === 'hall' && trigger === 'order_accepted'
        ? `${orderId}:${trigger}`
        : `${orderId}:${setor.slug}:${trigger}`;

      insert.run(
        crypto.randomUUID(), orderId, dedupe,
        Math.min(Math.max(Number(setor.copies ?? 1), 1), 5),
        JSON.stringify({
          receipt_text: texto,
          order_id: orderId,
          restaurant_name: restaurantName,
          total: Number(orderView.total ?? 0),
          customer_name: String(orderView.customer_name ?? ''),
          order_type: String(orderView.order_type ?? ''),
          sector_slug: setor.slug,
          sector_name: setor.name,
        }),
        agora, setor.slug, setor.id,
      );
      criados++;
    }
    console.log(`[print] ${criados} notinha(s) local(is) criada(s) p/ pedido ${String(orderView.order_number ?? orderId)}`);
  } catch (err) {
    console.error('[print] falha ao montar notinha local:', (err as Error).message);
  }
}

interface ClaimedJob {
  id: string;
  order_id: string;
  copies: number;
  payload: Record<string, unknown>;
  attempts: number;
  created_at: string;
  /** Slug do setor — é por ele que o agente escolhe a impressora física. */
  target: string;
  sector_id: string | null;
}

/**
 * `sector_id IN (…) OR (sector_id IS NULL AND target IN (…))` — a MESMA regra
 * de escopo da fn_print_poll_multi da nuvem. Lista vazia vira a constante `0`
 * (falso): SQLite recusa `IN ()`, e um agente sem setor não deve casar nada.
 */
function scopeClause(scope: AgentScope): { sql: string; params: string[] } {
  const bySector = scope.sectorIds.length > 0
    ? `sector_id IN (${scope.sectorIds.map(() => '?').join(',')})`
    : '0';
  const bySlug = scope.slugs.length > 0
    ? `target IN (${scope.slugs.map(() => '?').join(',')})`
    : '0';
  return {
    sql: `(${bySector} OR (sector_id IS NULL AND ${bySlug}))`,
    params: [...scope.sectorIds, ...scope.slugs],
  };
}

/**
 * Contrato idêntico ao GET /api/print/jobs da nuvem: reclaim de stale + claim.
 * Com `scope` (token por computador), cada PC leva só os jobs dos setores
 * dele; sem escopo (token interno do helper ou o legado), leva tudo — que é o
 * comportamento de sempre.
 */
export function claimLocalPrintJobs(scope?: AgentScope): ClaimedJob[] {
  const db = getDb();
  const now = new Date().toISOString();
  const staleBefore = new Date(Date.now() - STALE_CLAIM_MS).toISOString();

  db.prepare(
    `UPDATE print_jobs SET status = 'pending', claimed_at = NULL,
       error_message = 'Job reencaminhado após perda de conexão com o agente.'
     WHERE status = 'processing' AND attempts < ? AND claimed_at < ?`,
  ).run(MAX_ATTEMPTS, staleBefore);
  db.prepare(
    `UPDATE print_jobs SET status = 'failed',
       error_message = 'Falha automática após expirar em processamento.'
     WHERE status = 'processing' AND attempts >= ? AND claimed_at < ?`,
  ).run(MAX_ATTEMPTS, staleBefore);

  // O teto sobe com o número de setores: 3 impressoras esgotariam um limite
  // pensado para uma, e a comanda da produção esperaria o próximo poll.
  const setoresAtivos = Math.max(1, mirrorSectors().length);
  const limite = Math.min(CLAIM_LIMIT * setoresAtivos, 20);

  const filtro = scope ? scopeClause(scope) : null;
  const candidates = db
    .prepare(
      `SELECT id, order_id, copies, payload, attempts, created_at, target, sector_id FROM print_jobs
       WHERE status = 'pending' AND attempts < ?${filtro ? ` AND ${filtro.sql}` : ''} ORDER BY created_at LIMIT ?`,
    )
    .all(MAX_ATTEMPTS, ...(filtro?.params ?? []), limite) as Array<Omit<ClaimedJob, 'payload'> & { payload: string }>;

  const claim = db.prepare(
    `UPDATE print_jobs SET status = 'processing', claimed_at = ?, attempts = attempts + 1,
       error_message = NULL WHERE id = ? AND status = 'pending'`,
  );
  const claimed: ClaimedJob[] = [];
  for (const c of candidates) {
    if (claim.run(now, c.id).changes > 0) {
      claimed.push({ ...c, attempts: c.attempts + 1, payload: JSON.parse(c.payload) as Record<string, unknown> });
    }
  }
  return claimed;
}

/**
 * PATCH do agente: completed | failed. Retorna false se o job não é local.
 * Com `scope`, o update só alcança jobs do escopo daquele token — a mesma
 * proteção do `.in('target', slugs)` da rota da nuvem: sem ela, um id cruzado
 * fecharia comanda de outro setor sem papel nenhum ter saído.
 */
export function updateLocalPrintJob(
  jobId: string,
  status: string,
  errorMessage?: string,
  scope?: AgentScope,
): boolean {
  const filtro = scope ? scopeClause(scope) : null;
  const result = getDb()
    .prepare(`UPDATE print_jobs SET status = ?, error_message = ? WHERE id = ?${filtro ? ` AND ${filtro.sql}` : ''}`)
    .run(status === 'completed' ? 'completed' : 'failed', errorMessage ?? null, jobId, ...(filtro?.params ?? []));
  return result.changes > 0;
}

/** Cria um job de teste (texto simples) para o usuário validar a impressora. */
export function createTestPrintJob(): void {
  const restaurantName = mirrorRestaurantName();
  const width = Number(mirrorSettings()?.paper_width_mm ?? 58) >= 80 ? 48 : 32;
  const center = (s: string) => {
    const pad = Math.max(0, Math.floor((width - s.length) / 2));
    return ' '.repeat(pad) + s;
  };
  const line = '='.repeat(width);
  const now = new Date();
  const receipt = [
    center(restaurantName.toUpperCase()),
    line,
    center('TESTE DE IMPRESSAO'),
    line,
    center('Alinhafood Desktop'),
    center(`${now.toLocaleDateString('pt-BR')} ${now.toLocaleTimeString('pt-BR')}`),
    '',
    center('Se voce esta lendo isto,'),
    center('a impressora esta funcionando!'),
    '',
    '',
  ].join('\n');

  getDb()
    .prepare(
      `INSERT INTO print_jobs (id, order_id, dedupe_key, status, copies, payload, created_at, target)
       VALUES (?, 'test', ?, 'pending', 1, ?, ?, 'hall')`,
    )
    .run(
      crypto.randomUUID(),
      `test:${now.getTime()}`,
      JSON.stringify({ receipt_text: receipt, order_id: 'test', restaurant_name: restaurantName, total: 0, customer_name: 'Teste', order_type: 'teste' }),
      now.toISOString(),
    );
  console.log('[print] cupom de teste enfileirado');
}

export function pendingLocalPrintJobs(): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) as n FROM print_jobs WHERE status IN ('pending','processing')")
    .get() as { n: number };
  return row.n;
}
