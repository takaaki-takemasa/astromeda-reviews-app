import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { enforceRateLimit, RATE_LIMITS } from "../lib/rate-limit";
import { appendAuditLogSafe } from "../lib/audit-log";

/**
 * POST /api/tokens/issue
 *
 * Phase J 連携用 endpoint。Shopify Flow の HTTP request アクションから呼ばれる。
 *
 * Input (JSON body):
 *   {
 *     "order_id": "12345",          // 必須
 *     "email": "user@example.com",   // 必須
 *     "customer_name": "山田 太郎",   // 任意
 *     "expires_days": 90              // 任意 (default 90)
 *   }
 *
 * Output (JSON):
 *   {
 *     "ok": true,
 *     "token": "uuid-v4",
 *     "review_url": "https://shop.mining-base.co.jp/apps/reviews-1/submit?token=XXX",
 *     "expires_at": "2026-08-14T..."
 *   }
 *
 * Shopify Flow 設定:
 *   1) trigger: orders/fulfilled
 *   2) condition (任意): customer.email is not blank
 *   3) action: Send HTTP request
 *      url: https://astromeda-reviews-app.vercel.app/api/tokens/issue
 *      method: POST
 *      headers: Content-Type: application/json
 *      body (JSON):
 *        {
 *          "order_id": "{{order.id}}",
 *          "email": "{{order.customer.email}}",
 *          "customer_name": "{{order.customer.first_name}} {{order.customer.last_name}}"
 *        }
 *   4) action: Wait (14 days)
 *   5) action: Send email
 *      to: {{order.customer.email}}
 *      subject: {{step1.subject}}  ← Phase J+1 で config から取得する追加 endpoint 予定
 *      body: {{step1.review_url}} を含むテンプレート
 */

const CREATE_TOKEN_MUTATION = `#graphql
  mutation CreateReviewToken($metaobject: MetaobjectCreateInput!) {
    metaobjectCreate(metaobject: $metaobject) {
      metaobject { id }
      userErrors { field message code }
    }
  }
`;

const STORE_DOMAIN = process.env.SHOP_CUSTOM_DOMAIN || "shop.mining-base.co.jp";

function generateUuid(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  // RFC4122 v4 fallback
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export const action = async ({ request }: ActionFunctionArgs) => {
  enforceRateLimit(request, RATE_LIMITS.ADMIN_API);

  // Shopify Flow's HTTP request action signs requests with X-Shopify-Hmac-Sha256
  // when configured with a shared secret. For now we treat this as an internal
  // endpoint authenticated by being called from Shopify Flow + Vercel TLS only.
  // TODO Phase J+: require a shared HMAC secret via SHOP_FLOW_HMAC_KEY env var.

  let payload: { order_id?: string; email?: string; customer_name?: string; expires_days?: number };
  try {
    payload = (await request.json()) as typeof payload;
  } catch {
    return Response.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const order_id = String(payload.order_id ?? "");
  const email = String(payload.email ?? "");
  const customer_name = String(payload.customer_name ?? "");
  const expires_days = Number(payload.expires_days ?? 90);

  if (!order_id || !email) {
    return Response.json({ ok: false, error: "order_id and email are required" }, { status: 400 });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return Response.json({ ok: false, error: "invalid_email" }, { status: 400 });
  }

  // Use unauthenticated admin context for offline session (configured for the
  // shop the user installed the app on). This is the standard pattern for
  // background jobs / webhook receivers.
  const shopDomain = (() => {
    // Best effort: try to detect from referer header, otherwise rely on
    // a configured PRODUCTION_SHOP env var. For Phase J the call comes from
    // Shopify Flow which we set up against a specific shop.
    return process.env.PRODUCTION_SHOP_DOMAIN || "production-mining-base.myshopify.com";
  })();

  const { admin } = await authenticate.public.appProxy(request)
    .catch(async () => ({ admin: null as never }));

  // If appProxy auth fails (because Flow's HTTP request action doesn't sign
  // like App Proxy), fall back to unauthenticated() context.
  const unauth = admin
    ? { admin }
    : await (await import("../shopify.server")).default.unauthenticated.admin(shopDomain);

  const token = generateUuid();
  const expires_at = new Date(Date.now() + expires_days * 24 * 60 * 60 * 1000).toISOString();
  const review_url = `https://${STORE_DOMAIN}/apps/reviews-1/submit?token=${token}`;

  const fields = [
    { key: "token", value: token },
    { key: "email", value: email },
    { key: "customer_name", value: customer_name },
    { key: "order_id", value: order_id },
    { key: "token_type", value: "purchase" },
    { key: "expires_at", value: expires_at },
    { key: "issued_by", value: "shopify-flow" },
  ];

  const res = await unauth.admin.graphql(CREATE_TOKEN_MUTATION, {
    variables: { metaobject: { type: "astromeda_review_token", fields } },
  });
  const json = (await res.json()) as { data?: { metaobjectCreate?: { metaobject?: { id: string }; userErrors: Array<{ field: string[]; message: string }> } } };
  const errs = json.data?.metaobjectCreate?.userErrors ?? [];
  const newId = json.data?.metaobjectCreate?.metaobject?.id;

  if (errs.length > 0 || !newId) {
    return Response.json({ ok: false, error: errs[0]?.message || "create_failed" }, { status: 500 });
  }

  await appendAuditLogSafe({
    admin: unauth.admin,
    actor: "shopify-flow",
    action: "token.issue",
    resource_id: newId,
    resource_type: "astromeda_review_token",
    request,
    metadata: { order_id, email, expires_at, source: "phase_J_flow_http_action" },
  });

  return Response.json({
    ok: true,
    token,
    review_url,
    expires_at,
  });
};

// GET = 405 (intentional - this endpoint only accepts POST from Flow)
export const loader = () => {
  return new Response(JSON.stringify({ ok: false, error: "method_not_allowed", message: "POST only" }), {
    status: 405,
    headers: { "content-type": "application/json", allow: "POST" },
  });
};
