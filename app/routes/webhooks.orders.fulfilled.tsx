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

  let matched: typeof configs[number] | undefined;
  // Priority 1: product_tag match
  matched = configs.find((c) => {
    if (f(c, "enabled") !== "true") return false;
    if (f(c, "target_type") !== "product_tag") return false;
    return allTags.has(f(c, "target_handle"));
  });
  // Priority 2: collection match (we don't have collection info here, defer)
  // Priority 3: all fallback
  if (!matched) {
    matched = configs.find((c) => f(c, "enabled") === "true" && f(c, "target_type") === "all");
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
    { key: "config_id", value: matched.id },
    { key: "fulfilled_at", value: fulfilledAt },
    { key: "scheduled_at", value: scheduledAt },
    { key: "status", value: "scheduled" },
  ];

  const createRes = await admin.graphql(CREATE_QUEUE_MUTATION, {
    variables: { metaobject: { type: "astromeda_review_email_queue", fields } },
  });
  const createJson = (await createRes.json()) as { data?: { metaobjectCreate?: { metaobject?: { id: string }; userErrors: Array<{ field: string[]; message: string }> } } };
  const errs = createJson.data?.metaobjectCreate?.userErrors ?? [];
  const newId = createJson.data?.metaobjectCreate?.metaobject?.id;

  if (errs.length > 0) {
    // eslint-disable-next-line no-console
    console.error("[webhook] queue insertion failed", errs);
  }

  if (newId) {
    await appendAuditLogSafe({
      admin,
      actor: `webhook:${shop}`,
      action: "email.send", // queued for sending
      resource_id: newId,
      resource_type: "astromeda_review_email_queue",
      request,
      metadata: { order_id: order.id, config_id: matched.id, scheduled_at: scheduledAt },
    });
  }

  return new Response();
};
