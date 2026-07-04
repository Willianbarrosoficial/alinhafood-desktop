import crypto from 'node:crypto';
import { getDb, getMeta, setMeta, readMirrorTable } from './db';

/**
 * Pedidos offline (Fase 3) — criação local + leitura de comandas.
 *
 * Regras herdadas do plano:
 *  - id/itens com UUID local (idempotência da subida é a própria PK na nuvem);
 *  - numeração local com prefixo F (F001, F002...) por sessão de caixa — nunca
 *    colide com a numeração da nuvem (delivery continua chegando lá durante a
 *    queda e consome a sequência normal);
 *  - pedido + evento de outbox gravados na MESMA transação SQLite;
 *  - unit_price congelado no momento da venda (já vem assim do front).
 */

interface CheckoutInput {
  restaurant_id?: string;
  order_type?: string;
  delivery_type?: string;
  table_number?: number | null;
  customer_name?: string | null;
  customer_phone?: string | null;
  waiter_name?: string | null;
  waiter_session_id?: string | null;
  payment_method?: string | null;
  needs_change?: boolean;
  change_for?: number | null;
}

interface ItemInput {
  product_id: string;
  quantity: number;
  unit_price: number;
  note?: string | null;
  selected_options?: unknown[];
}

export interface CreateLocalOrderBody {
  checkout?: CheckoutInput;
  items?: ItemInput[];
  total?: number;
}

type MirrorCaixaSession = { id: string; status?: string };
type MirrorOrder = Record<string, unknown> & {
  id: string;
  table_number?: number | null;
  payment_status?: string | null;
  status?: string | null;
  created_at?: string | null;
};

const ACTIVE_STATUSES = new Set(['pending', 'confirmed', 'preparing', 'ready', 'delivered']);

function openCaixaSession(): MirrorCaixaSession | null {
  const sessions = readMirrorTable<MirrorCaixaSession>('caixa_sessions');
  return sessions.find((s) => s.status === 'open') ?? sessions[0] ?? null;
}

function nextLocalOrderNumber(sessionId: string): string {
  const key = `local_order_seq:${sessionId}`;
  const next = Number(getMeta(key) ?? '0') + 1;
  setMeta(key, String(next));
  // Formato FF-000001: casa com orders_order_number_format_check da nuvem
  // (regra '^[LETRAS]{2}-[0-9]{6}$'), é visualmente inconfundível como pedido
  // offline e nunca colide com a sequência numérica normal do caixa.
  return `FF-${String(next).padStart(6, '0')}`;
}

export function createLocalOrder(body: CreateLocalOrderBody):
  | { ok: true; orderId: string; orderNumber: string }
  | { ok: false; status: number; error: string } {
  const checkout = body.checkout;
  const items = body.items ?? [];
  const total = Number(body.total ?? 0);

  if (!checkout?.restaurant_id) return { ok: false, status: 400, error: 'restaurant_id é obrigatório' };
  if (!Array.isArray(items) || items.length === 0) {
    return { ok: false, status: 400, error: 'items é obrigatório' };
  }
  const orderType = checkout.order_type ?? 'balcao';
  if (orderType !== 'mesa' && orderType !== 'balcao') {
    return { ok: false, status: 422, error: 'Somente pedidos de mesa e balcão podem ser criados offline.' };
  }

  const session = openCaixaSession();
  if (!session) {
    return { ok: false, status: 409, error: 'Abra o caixa antes de criar pedidos.' };
  }

  const orderId = crypto.randomUUID();
  const orderNumber = nextLocalOrderNumber(session.id);
  const createdAt = new Date().toISOString();

  // Mesmo shape do INSERT em orders feito por createRestaurantOrder
  // (lib/supabase-queries.ts) — o push-order insere este objeto literalmente.
  const orderRow: Record<string, unknown> = {
    id: orderId,
    restaurant_id: checkout.restaurant_id,
    user_id: null,
    status: 'preparing',
    payment_status: 'unpaid',
    total,
    customer_name:
      checkout.customer_name ?? (orderType === 'mesa' ? `Mesa ${checkout.table_number}` : 'Balcão'),
    customer_phone: checkout.customer_phone ?? '',
    delivery_address: orderType,
    order_type: orderType,
    delivery_type: checkout.delivery_type ?? (orderType === 'mesa' ? 'dine_in' : 'pickup'),
    table_number: checkout.table_number ?? null,
    waiter_name: checkout.waiter_name ?? null,
    waiter_session_id: checkout.waiter_session_id ?? null,
    payment_method: checkout.payment_method ?? 'pix',
    needs_change: checkout.needs_change ?? false,
    change_for: checkout.needs_change ? (checkout.change_for ?? null) : null,
    service_fee_amount: 0,
    delivery_fee: 0,
    order_number: orderNumber,
    caixa_session_id: session.id,
    created_at: createdAt,
  };

  const itemRows = items.map((i) => ({
    id: crypto.randomUUID(),
    order_id: orderId,
    product_id: i.product_id,
    quantity: i.quantity,
    unit_price: i.unit_price,
    note: i.note ?? null,
    selected_options: Array.isArray(i.selected_options) ? i.selected_options : [],
  }));

  // A comanda local carrega os itens aninhados no mesmo formato do select
  // 'orders + order_items(*)' que as telas consomem.
  const localView = { ...orderRow, order_items: itemRows };

  const db = getDb();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO offline_orders (id, restaurant_id, table_number, order_number, status, payment_status, created_at, data, pushed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    ).run(
      orderId,
      String(checkout.restaurant_id),
      checkout.table_number ?? null,
      orderNumber,
      'preparing',
      'unpaid',
      createdAt,
      JSON.stringify(localView),
    );
    db.prepare(
      `INSERT INTO sync_outbox (entity, entity_id, endpoint, payload, created_at)
       VALUES ('order', ?, '/api/sync/push-order', ?, ?)`,
    ).run(orderId, JSON.stringify({ order: orderRow, items: itemRows }), createdAt);
  })();

  console.log(`[offline] pedido ${orderNumber} criado (mesa ${checkout.table_number ?? '—'}, total ${total})`);
  return { ok: true, orderId, orderNumber };
}

/** Patch local (status/pagamento offline) aplicado sobre pedidos do espelho. */
function applyOverride(order: MirrorOrder): MirrorOrder {
  const row = getDb()
    .prepare('SELECT patch FROM order_overrides WHERE order_id = ?')
    .get(order.id) as { patch: string } | undefined;
  if (!row) return order;
  return { ...order, ...(JSON.parse(row.patch) as Record<string, unknown>) };
}

function upsertOverride(orderId: string, patch: Record<string, unknown>): void {
  const db = getDb();
  const existing = db
    .prepare('SELECT patch FROM order_overrides WHERE order_id = ?')
    .get(orderId) as { patch: string } | undefined;
  const merged = { ...(existing ? (JSON.parse(existing.patch) as Record<string, unknown>) : {}), ...patch };
  db.prepare(
    `INSERT INTO order_overrides (order_id, patch, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(order_id) DO UPDATE SET patch = excluded.patch, updated_at = excluded.updated_at`,
  ).run(orderId, JSON.stringify(merged), new Date().toISOString());
}

/** Aplica patch num pedido offline ainda local: entidade E payload pendente juntos. */
function patchOfflineOrder(orderId: string, patch: Record<string, unknown>): boolean {
  const db = getDb();
  const row = db.prepare('SELECT data, pushed FROM offline_orders WHERE id = ?').get(orderId) as
    | { data: string; pushed: number }
    | undefined;
  if (!row) return false;

  const data = { ...(JSON.parse(row.data) as Record<string, unknown>), ...patch };
  db.transaction(() => {
    db.prepare(
      'UPDATE offline_orders SET data = ?, status = COALESCE(?, status), payment_status = COALESCE(?, payment_status) WHERE id = ?',
    ).run(
      JSON.stringify(data),
      (patch.status as string) ?? null,
      (patch.payment_status as string) ?? null,
      orderId,
    );
    if (row.pushed === 0) {
      // Ainda na fila: o pedido sobe já com o estado final — um evento só.
      const evt = db
        .prepare(
          "SELECT id, payload FROM sync_outbox WHERE entity = 'order' AND entity_id = ? AND status = 'pending'",
        )
        .get(orderId) as { id: number; payload: string } | undefined;
      if (evt) {
        const payload = JSON.parse(evt.payload) as { order: Record<string, unknown>; items: unknown[] };
        payload.order = { ...payload.order, ...patch };
        db.prepare('UPDATE sync_outbox SET payload = ? WHERE id = ?').run(JSON.stringify(payload), evt.id);
      }
    }
  })();
  return row.pushed === 1; // true = já está na nuvem, precisa de replay próprio
}

export function updateLocalOrderStatus(body: {
  order_id?: string;
  status?: string;
  restaurant_id?: string;
}): { ok: true } | { ok: false; status: number; error: string } {
  const { order_id: orderId, status, restaurant_id: restaurantId } = body;
  if (!orderId || !status) return { ok: false, status: 400, error: 'order_id e status são obrigatórios' };
  if (status === 'cancelled') {
    return { ok: false, status: 422, error: 'Cancelamento exige conexão (PIN de segurança).' };
  }

  const isLocal = getDb().prepare('SELECT 1 FROM offline_orders WHERE id = ?').get(orderId);
  const needsReplay = isLocal ? patchOfflineOrder(orderId, { status }) : true;
  if (!isLocal) upsertOverride(orderId, { status });

  if (needsReplay) {
    getDb()
      .prepare(
        `INSERT INTO sync_outbox (entity, entity_id, endpoint, method, payload, created_at)
         VALUES ('order-status', ?, ?, 'PATCH', ?, ?)`,
      )
      .run(
        orderId,
        `/api/admin/orders/${orderId}/status`,
        JSON.stringify({ status, ...(restaurantId ? { restaurant_id: restaurantId } : {}) }),
        new Date().toISOString(),
      );
  }
  console.log(`[offline] status do pedido ${orderId.slice(0, 8)} → ${status}`);
  return { ok: true };
}

export function markLocalOrdersPaid(body: {
  order_ids?: string[];
  restaurant_id?: string;
  options?: Record<string, unknown>;
}): { ok: true } | { ok: false; status: number; error: string } {
  const ids = body.order_ids ?? [];
  const restaurantId = body.restaurant_id;
  if (ids.length === 0 || !restaurantId) {
    return { ok: false, status: 400, error: 'order_ids e restaurant_id são obrigatórios' };
  }
  const options = body.options ?? {};
  const paidPatch: Record<string, unknown> = {
    payment_status: 'paid',
    ...(options.payment_method ? { payment_method: options.payment_method } : {}),
  };

  const needReplay: string[] = [];
  for (const id of ids) {
    const isLocal = getDb().prepare('SELECT 1 FROM offline_orders WHERE id = ?').get(id);
    if (isLocal) {
      if (patchOfflineOrder(id, paidPatch)) needReplay.push(id);
    } else {
      upsertOverride(id, paidPatch);
      needReplay.push(id);
    }
  }

  if (needReplay.length > 0) {
    // Um evento só, no formato do endpoint da nuvem (inclui service fee,
    // troco e split de pagamentos exatamente como a tela enviou).
    getDb()
      .prepare(
        `INSERT INTO sync_outbox (entity, entity_id, endpoint, method, payload, created_at)
         VALUES ('mark-paid', ?, '/api/admin/orders/mark-paid', 'POST', ?, ?)`,
      )
      .run(
        needReplay.join(','),
        JSON.stringify({ restaurant_id: restaurantId, order_ids: needReplay, ...options }),
        new Date().toISOString(),
      );
  }
  console.log(`[offline] ${ids.length} pedido(s) marcados como pagos (${needReplay.length} p/ replay)`);
  return { ok: true };
}

/** As telas leem o nome via order_items[].products.name — enriquece do espelho. */
function enrichItemsWithProductName(order: MirrorOrder): MirrorOrder {
  const items = order.order_items;
  if (!Array.isArray(items)) return order;
  const products = readMirrorTable<{ id: string; name?: string }>('products');
  const nameById = new Map(products.map((p) => [String(p.id), p.name ?? 'Produto']));
  return {
    ...order,
    order_items: items.map((raw) => {
      const item = raw as Record<string, unknown>;
      if (item.products && typeof item.products === 'object') return item;
      return { ...item, products: { name: nameById.get(String(item.product_id)) ?? 'Produto' } };
    }),
  };
}

/** Espelho + pedidos offline fundidos, com overrides aplicados e sem duplicatas. */
function mergedOrders(): MirrorOrder[] {
  const mirror = readMirrorTable<MirrorOrder>('active_orders').map(applyOverride);
  const local = (getDb()
    .prepare('SELECT data FROM offline_orders ORDER BY created_at DESC LIMIT 200')
    .all() as Array<{ data: string }>).map((r) => JSON.parse(r.data) as MirrorOrder);
  const seen = new Set(local.map((o) => o.id));
  return [...local, ...mirror.filter((o) => !seen.has(o.id))]
    .map(enrichItemsWithProductName)
    .sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')));
}

const isActiveUnpaid = (o: MirrorOrder) =>
  o.payment_status !== 'paid' && ACTIVE_STATUSES.has(String(o.status));

/** Comandas ativas da mesa: espelho da nuvem (pré-queda) + pedidos offline, sem duplicar. */
export function listTableActiveOrders(tableNumber: number): MirrorOrder[] {
  return mergedOrders().filter(
    (o) => Number(o.table_number) === tableNumber && isActiveUnpaid(o),
  );
}

/** Grade de mesas do salão: pedidos de mesa ativos e não pagos (todas as mesas). */
export function listMesaActiveOrders(): MirrorOrder[] {
  return mergedOrders().filter(
    (o) => (o as { order_type?: string }).order_type === 'mesa' && isActiveUnpaid(o),
  );
}

/**
 * Feed de "Meus Pedidos" offline: comandas ativas do espelho (inclui delivery
 * que JÁ estava em andamento antes da queda) + pedidos criados offline.
 * Delivery novo não existe offline por definição — não chega sem nuvem.
 */
export function listOrdersFeed(): MirrorOrder[] {
  return mergedOrders().slice(0, 100);
}

export function markOrderPushed(orderId: string): void {
  getDb().prepare('UPDATE offline_orders SET pushed = 1 WHERE id = ?').run(orderId);
}
