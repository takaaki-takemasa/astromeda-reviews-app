import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { appendAuditLogSafe } from "../lib/audit-log";

/**
 * Shopify Webhook: orders/fulfilled
 *
 * 注文発送完了通知を受信し、astromeda_review_email_queue に送信予約レコードを追加する。
 * Shopify Flow も同じイベントで起動するが、こちらは「我々のアプリ側の record-keeping」用。
 *
 * Phase A-11 Threat Model T-02 (偽 Webhook で queue 汚染):
 *   authenticate.webhook() が HMAC SHA-256 検証を自動で行う。
 *   検証失敗時は 401 を返す (Shopify Remix template 内蔵動作)。
 */

const FIND_CONFIG_QUERY = `#graphql
  query FindEmailConfig {
    metaobjects(type: "astromeda_review_email_config", first: 50) {
      edges { node { id fields { key value } } }
    }
  }
`;

const CREATE_QUEUE_MUTATION = `#graphql
  mutation CreateQueueEntry($metaobject: MetaobjectCreateInput!) {
    metaobjectCreate(metaobject: $metaobject) {
      metaobject { id }
      userErrors { field message code }
    }
  }
`;

interface ShopifyOrderLineItem {
  product_id?: number;
  title?: string;
  product?: { tags?: string[] };
}

interface ShopifyOrderPayload {
  id: number;
  email?: string;
  customer?: { first_name?: string; last_name?: string };
  line_items?: ShopifyOrderLineItem[];
  fulfillments?: Array<{ created_at?: string }>;
  tags?: string;
}

function f(node: { fields: Array<{ key: string; value: string }> }, key: string): string {
  return node.fields.find((x) => x.key === key)?.value ?? "";
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload, admin } = await authenticate.webhook(request);

  // eslint-disable-next-line no-console
  console.info(`[webhook] ${topic} received from ${shop}`);

  if (!admin) {
    // For uninstalled stores authenticate.webhook may not have admin context.
    return new Response();
  }

  const order = payload as ShopifyOrderPayload;
  if (!order?.id || !order?.email) {
    // eslint-disable-next-line no-console
    console.warn("[webhook] order missing required fields", { id: order?.id });
    return new Response();
  }

  // 1) Find matching email config based on product tags (most specific first), fallback to "all".
  const configsRes = await admin.graphql(FIND_CONFIG_QUERY);
  const configsJson = (await configsRes.json()) as { data?: { metaobjects?: { edges: Array<{ node: { id: string; fields: Array<{ key: string; value: string }> } }> } } };
  const configs = configsJson.data?.metaobjects?.edges?.map((e) => e.node) ?? [];

  const orderTags = (order.tags ?? "").split(",").map((t) => t.trim());
  const productTags = order.line_items?.flatMap((li) => li.product?.tags ?? []) ?? [];
  const allTags = new Set([...orderTags, ...productTags]);

  // target_type は Metaobject enum で global / ip_collection / product_collection の 3 値のみ。
  // product_collection の target_handle 接頭辞でさらに分類:
  //   "product:xxx"          → 個別商品
  //   "ip:xxx+group:yyy"     → IP × 製品群
  //   "color:xxx[+gpu:yyy]"  → アストロメダ色 (× GPU)
  //   "gpu:xxx"              → アストロメダ GPU 単独
  let matched: typeof configs[number] | undefined;

  // Priority 1: product_collection - product tag composite key match
  matched = configs.find((c) => {
    if (f(c, "enabled") !== "true") return false;
    if (f(c, "target_type") !== "product_collection") return false;
    const handle = f(c, "target_handle");
    // 個別商品: line_items から product handle で照合 (今は product handle が無いので skip)
    // タグ系: ip / color / gpu のいずれかが allTags に含まれていれば match
    if (handle.startsWith("ip:") || handle.startsWith("color:") || handle.startsWith("gpu:")) {
      const parts = handle.split("+").map((p) => p.split(":").pop() ?? p);
      return parts.every((p) => allTags.has(p));
    }
    return false;
  });

  // Priority 2: ip_collection - product tag に IP handle が含まれているか
  if (!matched) {
    matched = configs.find((c) => {
      if (f(c, "enabled") !== "true") return false;
      if (f(c, "target_type") !== "ip_collection") return false;
      return allTags.has(f(c, "target_handle"));
    });
  }

  // Priority 3: global fallback (全体配信)
  if (!matched) {
    matched = configs.find((c) => f(c, "enabled") === "true" && f(c, "target_type") === "global");
  }

  if (!matched) {
    // eslint-disable-next-line no-console
    console.info(`[webhook] no enabled config matches order ${order.id} - skipping queue insertion`);
    return new Response();
  }

  const delayDays = Number(f(matched, "delay_days") || 14);
  const fulfilledAt = order.fulfillments?.[0]?.created_at ?? new Date().toISOString();
  const scheduledAt = new Date(new Date(fulfilledAt).getTime() + delayDays * 24 * 60 * 60 * 1000).toISOString();

  const customerName = `${order.customer?.last_name ?? ""} ${order.customer?.first_name ?? ""}`.trim();

  const fields = [
    { key: "order_id", value: String(order.id) },
    { key: "email", value: order.email },
    { key: "customer_name", value: customerName },
    { k