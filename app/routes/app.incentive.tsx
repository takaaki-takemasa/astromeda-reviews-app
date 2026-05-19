/**
 * /app/incentive — インセンティブ設定 + 発行履歴 + 仮顧客テスト送信
 *
 * Phase 2.0 admin UI.
 */

import {
  Page, Layout, Card, BlockStack, InlineStack, Text, Badge, Button, Banner, Select, TextField,
  FormLayout, IndexTable, EmptyState, Divider, Tabs, ChoiceList, Toast, Frame,
} from "@shopify/polaris";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher, useSearchParams } from "@remix-run/react";
import { useState, useCallback, useEffect } from "react";
import { authenticate } from "../shopify.server";
import { appendAuditLogSafe } from "../lib/audit-log";
import { sendReviewRequestEmail } from "../lib/resend-email";

// ──────────────────────────────────────────────────────────────────
// Loader
// ──────────────────────────────────────────────────────────────────
const SETTINGS_QUERY = `#graphql
  query GetIncentiveSettings {
    metaobjectByHandle(handle: {type: "astromeda_incentive_settings", handle: "default"}) {
      id
      fields { key value }
    }
  }
`;

const COUPONS_QUERY = `#graphql
  query ListCoupons($first: Int!) {
    metaobjects(type: "astromeda_review_coupon", first: $first, sortKey: "updated_at", reverse: true) {
      edges { node { id fields { key value } } }
    }
  }
`;

const SHOPIFY_DISCOUNTS_QUERY = `#graphql
  query ListShopifyDiscounts {
    codeDiscountNodes(first: 50, sortKey: CREATED_AT, reverse: true) {
      edges {
        node {
          id
          codeDiscount {
            ... on DiscountCodeBasic {
              title
              status
              startsAt
              endsAt
              codes(first: 1) { edges { node { code } } }
              customerGets {
                value {
                  ... on DiscountPercentage { percentage }
                  ... on DiscountAmount { amount { amount } }
                }
              }
            }
          }
        }
      }
    }
  }
`;

function fieldsToMap(fields: Array<{key: string; value: string}>): Record<string, string> {
  const m: Record<string, string> = {};
  for (const f of fields) m[f.key] = f.value;
  return m;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  // 1) Settings
  let settings: any = { enabled: true, discount_type: "percentage", discount_value: "10", validity_days: "90", applicable_to: "same_ip", email_pitch: "", minimum_purchase: "0" };
  try {
    const r: any = await admin.graphql(SETTINGS_QUERY);
    const j = await r.json();
    const node = j?.data?.metaobjectByHandle;
    if (node) settings = { id: node.id, ...fieldsToMap(node.fields) };
  } catch (e) { /* skip */ }

  // 2) Coupons (recent 50)
  const coupons: any[] = [];
  try {
    const r: any = await admin.graphql(COUPONS_QUERY, { variables: { first: 50 } });
    const j = await r.json();
    const edges = j?.data?.metaobjects?.edges ?? [];
    for (const e of edges) {
      const m = fieldsToMap(e.node.fields);
      coupons.push({ id: e.node.id, ...m });
    }
  } catch (e) { /* skip */ }

  // 3) Stats
  const totalIssued = coupons.length;
  const totalUsed = coupons.filter((c) => c.used_at).length;
  const usageRate = totalIssued > 0 ? Math.round((totalUsed / totalIssued) * 100) : 0;

  // 4) Shopify Discount list (連携選択肢)
  let shopifyDiscounts: any[] = [];
  let discountFetchError: string | null = null;
  try {
    let dj: any;
    const offlineToken = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
    const fallbackShop = session?.shop || process.env.PRODUCTION_SHOP_DOMAIN || "";
    // Try merchant OAuth first, fall back to offline token if scope is insufficient
    try {
      const dres: any = await admin.graphql(SHOPIFY_DISCOUNTS_QUERY);
      dj = await dres.json();
    } catch (oauthErr: any) {
      dj = { errors: [{ message: "oauth_failed: " + String(oauthErr?.message || oauthErr) }] };
    }
    const oauthEmpty = !dj?.data?.codeDiscountNodes?.edges || dj.data.codeDiscountNodes.edges.length === 0;
    const oauthHasError = dj?.errors && dj.errors.length > 0;
    if ((oauthEmpty || oauthHasError) && offlineToken && fallbackShop) {
      // Fallback: use offline admin token with full scope
      try {
        const r = await fetch(`https://${fallbackShop}/admin/api/2024-10/graphql.json`, {
          method: "POST",
          headers: { "X-Shopify-Access-Token": offlineToken, "Content-Type": "application/json" },
          body: JSON.stringify({ query: SHOPIFY_DISCOUNTS_QUERY.replace(/^#graphql\s*/, "") }),
        });
        const fbj = await r.json();
        if (fbj?.data?.codeDiscountNodes?.edges?.length > 0) {
          dj = fbj;
          discountFetchError = null;
        } else if (fbj?.errors) {
          discountFetchError = "offline_token_error: " + fbj.errors.map((e: any) => e.message).join("; ");
        }
      } catch (fbErr: any) {
        if (!discountFetchError) discountFetchError = "fallback_failed: " + String(fbErr?.message || fbErr);
      }
    }
    if (dj?.errors && dj.errors.length > 0 && !discountFetchError) {
      discountFetchError = dj.errors.map((er: any) => er.message).join("; ");
    }
    const edges = dj?.data?.codeDiscountNodes?.edges ?? [];
    shopifyDiscounts = edges
      .filter((e: any) => {
        const st = e?.node?.codeDiscount?.status || "";
        return st === "ACTIVE" || st === "SCHEDULED";
      })
      .map((e: any) => {
      const n = e.node;
      const d = n.codeDiscount || {};
      const valObj = d.customerGets?.value || {};
      let label = "";
      if (valObj.percentage != null) label = `${Math.round(valObj.percentage * 100)}% OFF`;
      else if (valObj.amount?.amount) label = `¥${valObj.amount.amount} OFF`;
      const sampleCode = d.codes?.edges?.[0]?.node?.code || "";
      return {
        id: n.id,
        title: d.title || sampleCode || "(無題)",
        status: d.status || "",
        startsAt: d.startsAt || "",
        endsAt: d.endsAt || "",
        sampleCode,
        label,
      };
    });
  } catch (e: any) {
    discountFetchError = String(e?.message || e || "unknown");
  }

  // shop handle for absolute Shopify admin deep-links inside iframe
  const shopHandle = (session?.shop || "").replace(".myshopify.com", "");

  return { settings, coupons, stats: { totalIssued, totalUsed, usageRate }, shopifyDiscounts, discountFetchError, shopHandle };
};

export const headers: HeadersFunction = () => ({
  "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
  "Pragma": "no-cache",
  "Expires": "0",
});

// ──────────────────────────────────────────────────────────────────
// Action
// ──────────────────────────────────────────────────────────────────
function generateCouponCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "REV-";
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

const DISCOUNT_CREATE = `#graphql
  mutation CreateDiscount($basicCodeDiscount: DiscountCodeBasicInput!) {
    discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
      codeDiscountNode { id codeDiscount { ... on DiscountCodeBasic { codes(first: 1) { edges { node { code } } } } } }
      userErrors { field message code }
    }
  }
`;

const DISCOUNT_QUERY = `#graphql
  query GetDiscount($id: ID!) {
    codeDiscountNode(id: $id) {
      id
      codeDiscount {
        ... on DiscountCodeBasic {
          title
          status
          startsAt
          endsAt
          codes(first: 1) { edges { node { code } } }
        }
      }
    }
  }
`;

const COUPON_CREATE_MO = `#graphql
  mutation CreateCouponMo($metaobject: MetaobjectCreateInput!) {
    metaobjectCreate(metaobject: $metaobject) {
      metaobject { id }
      userErrors { field message code }
    }
  }
`;

const SETTINGS_UPSERT = `#graphql
  mutation UpsertSettings($handle: MetaobjectHandleInput!, $metaobject: MetaobjectUpsertInput!) {
    metaobjectUpsert(handle: $handle, metaobject: $metaobject) {
      metaobject { id }
      userErrors { field message code }
    }
  }
`;

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const fd = await request.formData();
  const intent = String(fd.get("intent") || "");

  // ----- Save Settings -----
  if (intent === "save_settings") {
    const res: any = await admin.graphql(SETTINGS_UPSERT, {
      variables: {
        handle: { type: "astromeda_incentive_settings", handle: "default" },
        metaobject: {
          fields: [
            { key: "enabled", value: String(fd.get("enabled") || "true") },
            { key: "discount_type", value: String(fd.get("discount_type") || "percentage") },
            { key: "discount_value", value: String(fd.get("discount_value") || "10") },
            { key: "validity_days", value: String(fd.get("validity_days") || "90") },
            { key: "applicable_to", value: String(fd.get("applicable_to") || "same_ip") },
            { key: "email_pitch", value: String(fd.get("email_pitch") || "") },
            { key: "minimum_purchase", value: String(fd.get("minimum_purchase") || "0") },
            { key: "shopify_discount_gid", value: String(fd.get("shopify_discount_gid") || "") },
          ],
        },
      },
    });
    const j = await res.json();
    const errs = j?.data?.metaobjectUpsert?.userErrors ?? [];
    if (errs.length > 0) return { ok: false, intent, error: errs.map((e: any) => e.message).join(", ") };
    await appendAuditLogSafe({ admin, actor: session.shop, action: "incentive.settings.update", resource_id: "default", resource_type: "astromeda_incentive_settings", request });
    return { ok: true, intent };
  }

  // ----- Test Send (仮顧客にレビュー依頼メールを Resend で送信) -----
  if (intent === "test_send") {
    const name = String(fd.get("name") || "");
    const email = String(fd.get("email") || "");
    const productGid = String(fd.get("product_gid") || "");
    if (!name || !email) return { ok: false, intent, error: "name と email は必須" };

    // 商品タイトル取得 (read_products は scope 既存)
    let productTitle = "テスト商品";
    if (productGid) {
      try {
        const pres: any = await admin.graphql(`query P($id: ID!) { product(id: $id) { title } }`, { variables: { id: productGid } });
        const pj = await pres.json();
        productTitle = pj?.data?.product?.title || productTitle;
      } catch (_) { /* skip */ }
    }

    // 訴求文 (設定から取得)
    let couponPitch = "レビュー投稿で次回 10% OFF クーポンをプレゼント 🎁";
    try {
      const sres: any = await admin.graphql(SETTINGS_QUERY);
      const sj = await sres.json();
      const settingsNode = sj?.data?.metaobjectByHandle;
      if (settingsNode) {
        const s = fieldsToMap(settingsNode.fields);
        if (s.email_pitch && s.email_pitch.trim()) couponPitch = s.email_pitch.trim();
      }
    } catch (_) { /* skip */ }

    const token = "TEST-" + Math.random().toString(36).slice(2, 10).toUpperCase();
    const STORE_DOMAIN = process.env.SHOP_CUSTOM_DOMAIN || "shop.mining-base.co.jp";
    const reviewUrl = `https://${STORE_DOMAIN}/apps/reviews/submit?token=${token}`;

    const result = await sendReviewRequestEmail({ to: email, customerName: name, productTitle, reviewUrl, couponPitch });
    if (!result.ok) {
      console.error("[test_send] resend FAIL", result.error);
      return { ok: false, intent, error: `Resend 送信失敗: ${result.error}` };
    }
    await appendAuditLogSafe({ admin, actor: session.shop, action: "incentive.test_send", resource_id: result.id || "(no-id)", resource_type: "ResendEmail", request, metadata: { name, email, productGid, productTitle, token, reviewUrl, resend_id: result.id } });
    return { ok: true, intent, reviewUrl, token, resend_id: result.id };
  }

  // ----- (旧 Draft Order Invoice 経由は廃止。以下未使用ブロック)
  if (intent === "DEPRECATED_test_send_draft_order") {
    const name = String(fd.get("name") || "");
    const email = String(fd.get("email") || "");
    const productGid = String(fd.get("product_gid") || "");
    if (!name || !email) return { ok: false, intent, error: "name と email は必須" };
    // ① 顧客検索 or 作成
    const findRes: any = await admin.graphql(`query FindCustomer($q: String!) { customers(first: 1, query: $q) { edges { node { id } } } }`, { variables: { q: `email:${email}` } });
    const findJ = await findRes.json();
    let customerId: string = findJ?.data?.customers?.edges?.[0]?.node?.id || "";
    if (!customerId) {
      const cres: any = await admin.graphql(`mutation Create($input: CustomerInput!) { customerCreate(input: $input) { customer { id } userErrors { field message } } }`, {
        variables: { input: { firstName: name.split(" ")[0] || name, lastName: name.split(" ")[1] || "", email } }
      });
      const cj = await cres.json();
      customerId = cj?.data?.customerCreate?.customer?.id || "";
      if (!customerId) return { ok: false, intent, error: cj?.data?.customerCreate?.userErrors?.[0]?.message || "customer create failed" };
    }
    // ② 商品 title 取得
    let productTitle = "[テスト商品]";
    if (productGid) {
      const pres: any = await admin.graphql(`query P($id: ID!) { product(id: $id) { title } }`, { variables: { id: productGid } });
      const pj = await pres.json();
      productTitle = pj?.data?.product?.title || productTitle;
    }
    // ③ Draft Order 作成
    const dres: any = await admin.graphql(`mutation D($input: DraftOrderInput!) { draftOrderCreate(input: $input) { draftOrder { id name } userErrors { field message } } }`, {
      variables: {
        input: {
          customerId,
          email,
          note: "Astromeda Reviews 仮顧客テスト送信 (¥0)",
          tags: ["astromeda-reviews-test"],
          lineItems: [{ title: `[テスト] ${productTitle}`, quantity: 1, originalUnitPrice: "0.00", requiresShipping: false, taxable: false }],
        }
      }
    });
    const dj = await dres.json();
    const draftOrderId = dj?.data?.draftOrderCreate?.draftOrder?.id;
    const draftOrderName = dj?.data?.draftOrderCreate?.draftOrder?.name;
    if (!draftOrderId) return { ok: false, intent, error: dj?.data?.draftOrderCreate?.userErrors?.[0]?.message || "draft order create failed" };
    // ④ レビュー依頼 URL (Phase 1 と同じ形式)
    const token = "TEST-" + Math.random().toString(36).slice(2, 10).toUpperCase();
    const STORE_DOMAIN = process.env.SHOP_CUSTOM_DOMAIN || "shop.mining-base.co.jp";
    const reviewUrl = `https://${STORE_DOMAIN}/apps/reviews/submit?token=${token}`;
    // ⑤ Invoice Email 送信
    const customMessage = `${name} 様\n\nAstromeda Reviews 仮顧客テスト送信です。\n\nお買い上げ予定の「${productTitle}」をご利用いただいたあとは、ぜひレビューをお書きください。\n\n▶ レビューを投稿する\n${reviewUrl}\n\nレビュー投稿で次回 10% OFF クーポンをプレゼント 🎁\n\n（このメールは社内テスト用の Draft Order ${draftOrderName} 経由で送信されています。¥0 ですのでお支払いは不要です。）`;
    const sres: any = await admin.graphql(`mutation S($id: ID!, $email: EmailInput) { draftOrderInvoiceSend(id: $id, email: $email) { draftOrder { id name } userErrors { field message } } }`, {
      variables: {
        id: draftOrderId,
        email: { to: email, subject: `[Astromeda Reviews] テスト送信: ${productTitle} のレビューをお願いします`, customMessage }
      }
    });
    const sj = await sres.json();
    const serrs = sj?.data?.draftOrderInvoiceSend?.userErrors ?? [];
    if (serrs.length > 0) return { ok: false, intent, error: serrs[0]?.message };
    await appendAuditLogSafe({ admin, actor: session.shop, action: "incentive.test_send", resource_id: draftOrderId, resource_type: "DraftOrder", request, metadata: { name, email, productGid, draftOrderName, token, reviewUrl } });
    return { ok: true, intent, draftOrderName, reviewUrl, token };
  }

  // ----- Issue Coupon (real, on review submit) -----
  if (intent === "issue_coupon") {
    const email = String(fd.get("email") || "");
    const reviewGid = String(fd.get("review_id") || "");
    if (!email) return { ok: false, intent, error: "email is required" };

    // Read settings
    const sres: any = await admin.graphql(SETTINGS_QUERY);
    const sj = await sres.json();
    const settingsNode = sj?.data?.metaobjectByHandle;
    if (!settingsNode) return { ok: false, intent, error: "settings not found" };
    const s = fieldsToMap(settingsNode.fields);
    if (s.enabled !== "true") return { ok: false, intent, error: "incentive disabled" };

    const code = generateCouponCode();
    const validityDays = parseInt(s.validity_days || "90", 10);
    const nowIso = new Date().toISOString();
    const expiresIso = new Date(Date.now() + validityDays * 86400000).toISOString();

    // 1) Create Shopify Discount Code
    const discountValue = parseFloat(s.discount_value || "10");
    let shopifyDiscountId = "";
    try {
      const isPercentage = s.discount_type === "percentage";
      const value = isPercentage
        ? { percentage: -discountValue / 100 }
        : { discountAmount: { amount: discountValue, appliesOnEachItem: false } };
      const dres: any = await admin.graphql(DISCOUNT_CREATE, {
        variables: {
          basicCodeDiscount: {
            title: `Review Reward ${code}`,
            code,
            startsAt: nowIso,
            endsAt: expiresIso,
            customerSelection: { customers: { add: [] }, customerSegments: { add: [] }, all: true },
            customerGets: { value, items: { all: true } },
            usageLimit: 1,
            appliesOncePerCustomer: true,
          },
        },
      });
      const dj = await dres.json();
      const derrs = dj?.data?.discountCodeBasicCreate?.userErrors ?? [];
      if (derrs.length > 0) {
        console.error("[ISSUE-COUPON] discount create errors", derrs);
        return { ok: false, intent, error: derrs.map((e: any) => e.message).join(", ") };
      }
      shopifyDiscountId = dj?.data?.discountCodeBasicCreate?.codeDiscountNode?.id || "";
    } catch (e: any) {
      console.error("[ISSUE-COUPON] discount create exception", e?.message);
      return { ok: false, intent, error: e?.message || "discount create failed" };
    }

    // 2) Verify discount code exists
    let verifiedAt: string | null = null;
    if (shopifyDiscountId) {
      try {
        const qres: any = await admin.graphql(DISCOUNT_QUERY, { variables: { id: shopifyDiscountId } });
        const qj = await qres.json();
        const fetched = qj?.data?.codeDiscountNode?.codeDiscount?.codes?.edges?.[0]?.node?.code;
        if (fetched === code) verifiedAt = new Date().toISOString();
      } catch (e) { /* skip */ }
    }

    // 3) Persist coupon Metaobject
    const cres: any = await admin.graphql(COUPON_CREATE_MO, {
      variables: {
        metaobject: {
          type: "astromeda_review_coupon",
          fields: [
            { key: "code", value: code },
            { key: "discount_type", value: s.discount_type || "percentage" },
            { key: "discount_value", value: s.discount_value || "10" },
            { key: "validity_days", value: String(validityDays) },
            { key: "applicable_to", value: s.applicable_to || "same_ip" },
            { key: "issued_to_email", value: email },
            { key: "issued_at", value: nowIso },
            { key: "expires_at", value: expiresIso },
            { key: "shopify_discount_code_id", value: shopifyDiscountId },
            { key: "source", value: "review_submission" },
            { key: "review_id", value: reviewGid },
            { key: "verified_at", value: verifiedAt || "" },
          ],
        },
      },
    });
    const cj = await cres.json();
    const cerrs = cj?.data?.metaobjectCreate?.userErrors ?? [];
    if (cerrs.length > 0) return { ok: false, intent, error: cerrs.map((e: any) => e.message).join(", ") };

    await appendAuditLogSafe({ admin, actor: session.shop, action: "incentive.coupon.issue", resource_id: cj?.data?.metaobjectCreate?.metaobject?.id, resource_type: "astromeda_review_coupon", request, metadata: { code, email, shopifyDiscountId, verifiedAt, reviewGid } });
    return { ok: true, intent, code, expires_at: expiresIso, verified_at: verifiedAt, shopify_discount_id: shopifyDiscountId };
  }

  // ----- Health Check (URL + coupon validity sample) -----
  if (intent === "health_check") {
    const sampleSize = parseInt(String(fd.get("sample") || "10"), 10);
    const cres: any = await admin.graphql(COUPONS_QUERY, { variables: { first: sampleSize } });
    const cj = await cres.json();
    const edges = cj?.data?.metaobjects?.edges ?? [];
    const results: any[] = [];
    for (const e of edges) {
      const m = fieldsToMap(e.node.fields);
      let urlOk = true; // not implemented yet
      let couponOk = false;
      const did = m.shopify_discount_code_id;
      if (did) {
        try {
          const qres: any = await admin.graphql(DISCOUNT_QUERY, { variables: { id: did } });
          const qj = await qres.json();
          const status = qj?.data?.codeDiscountNode?.codeDiscount?.status;
          couponOk = status === "ACTIVE" || status === "SCHEDULED";
        } catch (_) { /* skip */ }
      }
      results.push({ id: e.node.id, code: m.code, email: m.issued_to_email, couponOk, urlOk });
    }
    const okCount = results.filter((r) => r.couponOk).length;
    return { ok: true, intent, results, summary: { total: results.length, ok: okCount, failed: results.length - okCount } };
  }

  return { ok: false, error: "unknown intent" };
};

// ──────────────────────────────────────────────────────────────────
// UI
// ──────────────────────────────────────────────────────────────────
export default function IncentiveTab() {
  const { settings, coupons, stats, shopifyDiscounts, discountFetchError, shopHandle } = useLoaderData<typeof loader>() as any;
  const [searchParams, setSearchParams] = useSearchParams();
  const fetcher = useFetcher<typeof action>();
  const [tabIdx, setTabIdx] = useState(parseInt(searchParams.get("tab") || "0", 10));
  const [toast, setToast] = useState<string | null>(null);

  // Settings form state
  const [enabled, setEnabled] = useState(settings.enabled === "true");
  const [dtype, setDtype] = useState(settings.discount_type || "percentage");
  const [dvalue, setDvalue] = useState(settings.discount_value || "10");
  const [vdays, setVdays] = useState(settings.validity_days || "90");
  const [appTo, setAppTo] = useState(settings.applicable_to || "same_ip");
  const [pitch, setPitch] = useState(settings.email_pitch || "");
  const [minPurchase, setMinPurchase] = useState(settings.minimum_purchase || "0");
  const [shopifyDiscountGid, setShopifyDiscountGid] = useState(settings.shopify_discount_gid || "");

  // Test send form state
  const [testName, setTestName] = useState("武正貴昭");
  const [testEmail, setTestEmail] = useState("takaaki.takemasa@mng-base.com");
  const [testProductGid, setTestProductGid] = useState("gid://shopify/Product/10274036023588"); // クロミキーボード

  const saveSettings = useCallback(() => {
    const fd = new FormData();
    fd.set("intent", "save_settings");
    fd.set("enabled", enabled ? "true" : "false");
    fd.set("discount_type", dtype);
    fd.set("discount_value", dvalue);
    fd.set("validity_days", vdays);
    fd.set("applicable_to", appTo);
    fd.set("email_pitch", pitch);
    fd.set("minimum_purchase", minPurchase);
    fd.set("shopify_discount_gid", shopifyDiscountGid);
    fetcher.submit(fd, { method: "post" });
  }, [enabled, dtype, dvalue, vdays, appTo, pitch, minPurchase, fetcher]);

  const sendTest = useCallback(() => {
    const fd = new FormData();
    fd.set("intent", "test_send");
    fd.set("name", testName);
    fd.set("email", testEmail);
    fd.set("product_gid", testProductGid);
    fetcher.submit(fd, { method: "post" });
  }, [testName, testEmail, testProductGid, fetcher]);

  const runHealthCheck = useCallback(() => {
    const fd = new FormData();
    fd.set("intent", "health_check");
    fd.set("sample", "10");
    fetcher.submit(fd, { method: "post" });
  }, [fetcher]);

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok && !toast) {
      const intent = fetcher.data.intent;
      if (intent === "save_settings") setToast("設定を保存しました");
      else if (intent === "test_send") setToast(`テスト送信完了: ${testEmail} (Resend ID: ${(fetcher.data as any).resend_id?.slice(0,8) || "?"})`);
      else if (intent === "health_check") setToast(`ヘルスチェック完了: ${(fetcher.data as any).summary?.ok}/${(fetcher.data as any).summary?.total} 正常`);
      setTimeout(() => setToast(null), 4500);
    } else if (fetcher.state === "idle" && fetcher.data && fetcher.data.ok === false) {
      setToast(`エラー: ${(fetcher.data as any).error}`);
      setTimeout(() => setToast(null), 6000);
    }
  }, [fetcher.state, fetcher.data, toast, testEmail]);

  const tabs = [
    { id: "settings", content: "⚙ 設定" },
    { id: "history", content: `📜 発行履歴 (${stats.totalIssued})` },
    { id: "test", content: "🧪 仮顧客テスト送信" },
    { id: "health", content: "🩺 ヘルスチェック" },
  ];

  return (
    <Frame>
      {toast ? <Toast content={toast} onDismiss={() => setToast(null)} /> : null}
      <Page
        title="🎁 インセンティブ統合 (Phase 2)"
        subtitle="レビュー投稿でお客様に自動でクーポンを発行・送付する仕組み"
      >
        <Layout>
          <Layout.Section>
            <Card>
              <BlockStack gap="200">
                <InlineStack gap="600" align="space-between" blockAlign="center">
                  <BlockStack gap="100">
                    <Text as="span" variant="bodySm" tone="subdued">クーポン発行数</Text>
                    <Text as="span" variant="heading2xl">{stats.totalIssued}</Text>
                  </BlockStack>
                  <BlockStack gap="100">
                    <Text as="span" variant="bodySm" tone="subdued">利用済み</Text>
                    <Text as="span" variant="heading2xl">{stats.totalUsed}</Text>
                  </BlockStack>
                  <BlockStack gap="100">
                    <Text as="span" variant="bodySm" tone="subdued">利用率</Text>
                    <Text as="span" variant="heading2xl">{stats.usageRate}<Text as="span" variant="bodyMd">%</Text></Text>
                  </BlockStack>
                  <BlockStack gap="100">
                    <Text as="span" variant="bodySm" tone="subdued">状態</Text>
                    {enabled ? <Badge tone="success">稼働中</Badge> : <Badge tone="warning">停止中</Badge>}
                  </BlockStack>
                </InlineStack>
              </BlockStack>
            </Card>
          </Layout.Section>

          <Layout.Section>
            <Card padding="0">
              <Tabs tabs={tabs} selected={tabIdx} onSelect={(i) => { setTabIdx(i); setSearchParams({ tab: String(i) }); }} />
            </Card>
          </Layout.Section>

          {/* ============ Settings Tab (Shopify ディスカウント連携版) ============ */}
          {tabIdx === 0 ? (
            <Layout.Section>
              <Card>
                <BlockStack gap="400">
                  <Text as="h2" variant="headingLg">クーポン設定</Text>
                  <Banner tone="info">
                    <BlockStack gap="100">
                      <Text as="p" variant="bodyMd" fontWeight="semibold">Shopify ディスカウント管理と連携しています</Text>
                      <Text as="p" variant="bodyMd">割引率・期間・対象範囲などの設定は <strong>Shopify 管理画面 → ディスカウント</strong> で行います。ここではどのディスカウントを連携するかを選ぶだけです。</Text>
                    </BlockStack>
                  </Banner>
                  <FormLayout>
                    <ChoiceList
                      title="インセンティブ機能"
                      choices={[{ label: "🟢 稼働中 (レビュー投稿で自動発行)", value: "on" }, { label: "🔴 停止中", value: "off" }]}
                      selected={[enabled ? "on" : "off"]}
                      onChange={(v) => setEnabled(v[0] === "on")}
                    />
                    {discountFetchError ? (
                      <Banner tone="critical">
                        <BlockStack gap="100">
                          <Text as="p" variant="bodyMd" fontWeight="semibold">⚠️ Shopify ディスカウントの読み込みに失敗しました</Text>
                          <Text as="p" variant="bodyMd">原因の可能性: アプリの権限に <strong>read_discounts</strong> がまだ付与されていません。Partner Dashboard で新しいアプリバージョンをリリースし、Shopify admin で「アプリの権限を更新」してください。エラー詳細: {String(discountFetchError).slice(0, 200)}</Text>
                        </BlockStack>
                      </Banner>
                    ) : (shopifyDiscounts || []).length === 0 ? (
                      <Banner tone="warning">
                        <BlockStack gap="100">
                          <Text as="p" variant="bodyMd" fontWeight="semibold">📭 連携可能なディスカウントが見つかりません</Text>
                          <Text as="p" variant="bodyMd">Shopify 管理画面で ACTIVE / SCHEDULED 状態の Discount Code を作成すると、ここに表示されます。</Text>
                        </BlockStack>
                      </Banner>
                    ) : null}
                    <Select
                      label="連携する Shopify ディスカウント"
                      options={[{ label: "— 連携なし (個別に新規発行)", value: "" }, ...((shopifyDiscounts || []) as any[]).map((d: any) => ({ label: `${d.title} (${d.label || d.status})`, value: d.id }))]}
                      value={shopifyDiscountGid}
                      onChange={setShopifyDiscountGid}
                      helpText="承認時にこのディスカウント配下に固有コードを追加します。設定変更は Shopify 管理画面で。"
                    />
                    {(() => {
                      const sel = (shopifyDiscounts || []).find((d: any) => d.id === shopifyDiscountGid);
                      if (!sel) return null;
                      // adminUrl now computed inline with shopHandle
                      return (
                        <Banner tone="success">
                          <BlockStack gap="100">
                            <Text as="p" variant="bodyMd" fontWeight="semibold">{sel.title}</Text>
                            <Text as="p" variant="bodyMd">割引: <Badge tone="success">{sel.label}</Badge> 状態: <Badge>{sel.status}</Badge></Text>
                            {sel.endsAt ? <Text as="p" variant="bodyMd">期限: {sel.endsAt.slice(0, 10)} まで</Text> : null}
                            <InlineStack gap="200">
                              <Button url={`https://admin.shopify.com/store/${shopHandle}/discounts/${sel.id.replace("gid://shopify/DiscountCodeNode/", "")}`} target="_top" external>🔗 Shopify でこのディスカウントを編集</Button>
                            </InlineStack>
                          </BlockStack>
                        </Banner>
                      );
                    })()}
                    <InlineStack gap="200">
                      <Button url={`https://admin.shopify.com/store/${shopHandle}/discounts/new`} target="_top" variant="secondary" external>+ Shopify で新規ディスカウントを作成</Button>
                    </InlineStack>
                    <Divider />
                    <TextField label="発行コードの有効期間 (日数)" value={vdays} onChange={setVdays} type="number" autoComplete="off" helpText="レビュー承認時に発行する固有コード REV-XXXXXX の有効期限。例: 90 → 発行から90日後に失効" />
                    <TextField label="依頼メール訴求文" value={pitch} onChange={setPitch} multiline={3} helpText="例: レビュー投稿で次回 10% OFF プレゼント 🎁。Shopify ディスカウント側で変更したら手動で更新してください。" autoComplete="off" />
                    <InlineStack gap="200">
                      <Button variant="primary" tone="success" onClick={saveSettings} loading={fetcher.state !== "idle"}>💾 設定を保存</Button>
                    </InlineStack>
                  </FormLayout>
                </BlockStack>
              </Card>
            </Layout.Section>
          ) : null}

          {/* ============ History Tab ============ */}
          {tabIdx === 1 ? (
            <Layout.Section>
              <Card>
                {coupons.length === 0 ? (
                  <EmptyState heading="まだクーポンが発行されていません" image="">
                    <Text as="p" variant="bodyMd">レビュー投稿があると自動でここに記録されます。</Text>
                  </EmptyState>
                ) : (
                  <IndexTable
                    resourceName={{ singular: "クーポン", plural: "クーポン" }}
                    itemCount={coupons.length}
                    selectable={false}
                    headings={[
                      { title: "コード" },
                      { title: "宛先" },
                      { title: "割引" },
                      { title: "発行日" },
                      { title: "期限" },
                      { title: "状態" },
                    ]}
                  >
                    {coupons.map((c: any, idx: number) => (
                      <IndexTable.Row id={c.id} key={c.id} position={idx}>
                        <IndexTable.Cell><Text as="span" fontWeight="semibold"><code>{c.code}</code></Text></IndexTable.Cell>
                        <IndexTable.Cell>{c.issued_to_email}</IndexTable.Cell>
                        <IndexTable.Cell>{c.discount_type === "percentage" ? `${c.discount_value}%` : `¥${c.discount_value}`}</IndexTable.Cell>
                        <IndexTable.Cell>{c.issued_at?.slice(0, 10) || "—"}</IndexTable.Cell>
                        <IndexTable.Cell>{c.expires_at?.slice(0, 10) || "—"}</IndexTable.Cell>
                        <IndexTable.Cell>
                          {c.used_at ? <Badge tone="info">使用済</Badge> : c.verified_at ? <Badge tone="success">有効</Badge> : <Badge tone="warning">未検証</Badge>}
                        </IndexTable.Cell>
                      </IndexTable.Row>
                    ))}
                  </IndexTable>
                )}
              </Card>
            </Layout.Section>
          ) : null}

          {/* ============ Test Send Tab ============ */}
          {tabIdx === 2 ? (
            <Layout.Section>
              <Card>
                <BlockStack gap="400">
                  <Text as="h2" variant="headingLg">🧪 仮顧客にレビュー依頼メールを送信</Text>
                  <Banner tone="info">
                    <Text as="p" variant="bodyMd">
                      Resend transactional email でレビュー依頼メールを実送信します。CEO 自身のメールでフルループを検証できます。
                    </Text>
                  </Banner>
                  <FormLayout>
                    <FormLayout.Group>
                      <TextField label="お名前" value={testName} onChange={setTestName} autoComplete="name" />
                      <TextField label="メールアドレス" type="email" value={testEmail} onChange={setTestEmail} autoComplete="email" />
                    </FormLayout.Group>
                    <TextField label="商品 GID" value={testProductGid} onChange={setTestProductGid} helpText="gid://shopify/Product/... 形式。空欄なら [テスト商品] になります。" autoComplete="off" />
                    <InlineStack gap="200">
                      <Button variant="primary" onClick={sendTest} loading={fetcher.state !== "idle"}>📧 テスト送信</Button>
                    </InlineStack>
                  </FormLayout>
                  {fetcher.data?.intent === "test_send" && (fetcher.data as any).ok ? (
                    <Banner tone="success">
                      <BlockStack gap="100">
                        <Text as="p" variant="bodyMd"><strong>送信完了!</strong></Text>
                        <Text as="p" variant="bodyMd">Resend ID: <code>{(fetcher.data as any).resend_id}</code></Text>
                        <Text as="p" variant="bodyMd">レビュー URL: <code>{(fetcher.data as any).reviewUrl}</code></Text>
                      </BlockStack>
                    </Banner>
                  ) : null}
                </BlockStack>
              </Card>
            </Layout.Section>
          ) : null}

          {/* ============ Health Check Tab ============ */}
          {tabIdx === 3 ? (
            <Layout.Section>
              <Card>
                <BlockStack gap="400">
                  <Text as="h2" variant="headingLg">🩺 ヘルスチェック</Text>
                  <Text as="p" variant="bodyMd">
                    発行済みクーポンが Shopify 側で実際に有効かを確認します。直近10件をサンプリングし、Discount Code の ACTIVE 状態を照会します。
                  </Text>
                  <InlineStack gap="200">
                    <Button variant="primary" onClick={runHealthCheck} loading={fetcher.state !== "idle"}>🩺 ヘルスチェック実行</Button>
                  </InlineStack>
                  {fetcher.data?.intent === "health_check" && (fetcher.data as any).ok ? (
                    <BlockStack gap="200">
                      <Banner tone={(fetcher.data as any).summary?.failed === 0 ? "success" : "warning"}>
                        <Text as="p" variant="bodyMd">
                          結果: {(fetcher.data as any).summary?.ok} / {(fetcher.data as any).summary?.total} 正常
                        </Text>
                      </Banner>
                      <IndexTable
                        resourceName={{ singular: "件", plural: "件" }}
                        itemCount={(fetcher.data as any).results?.length || 0}
                        selectable={false}
                        headings={[{ title: "コード" }, { title: "宛先" }, { title: "Shopify Discount" }, { title: "URL" }]}
                      >
                        {((fetcher.data as any).results || []).map((r: any, idx: number) => (
                          <IndexTable.Row id={r.id} key={r.id} position={idx}>
                            <IndexTable.Cell><code>{r.code}</code></IndexTable.Cell>
                            <IndexTable.Cell>{r.email}</IndexTable.Cell>
                            <IndexTable.Cell>{r.couponOk ? <Badge tone="success">有効</Badge> : <Badge tone="critical">無効</Badge>}</IndexTable.Cell>
                            <IndexTable.Cell>{r.urlOk ? <Badge tone="success">OK</Badge> : <Badge tone="warning">未確認</Badge>}</IndexTable.Cell>
                          </IndexTable.Row>
                        ))}
                      </IndexTable>
                    </BlockStack>
                  ) : null}
                </BlockStack>
              </Card>
            </Layout.Section>
          ) : null}
        </Layout>
      </Page>
    </Frame>
  );
}
