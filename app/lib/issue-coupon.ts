/**
 * Phase 2.4: クーポン自動発行 + サンクスメール送信ヘルパー
 *
 * レビュー承認時に呼ばれる:
 *   1. astromeda_incentive_settings を読む
 *   2. クーポンコード生成 (REV-XXXXXX)
 *   3. Shopify Discount Code 発行 (write_discounts scope 必要)
 *   4. astromeda_review_coupon Metaobject に保存
 *   5. Resend でサンクスメール送信
 *
 * 既存承認済みレビューには適用しない (重複防止のため、issued フラグで判定)
 */

import { sendThankYouEmail } from "./resend-email";

function fieldsToMap(fields: Array<{key: string; value: string}>): Record<string, string> {
  const m: Record<string, string> = {};
  for (const f of fields) m[f.key] = f.value;
  return m;
}

function generateCouponCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "REV-";
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

const SETTINGS_QUERY = `#graphql
  query GetSettings {
    metaobjectByHandle(handle: {type: "astromeda_incentive_settings", handle: "default"}) {
      id
      fields { key value }
    }
  }
`;

const REVIEW_FIELDS_QUERY = `#graphql
  query GetReview($id: ID!) {
    metaobject(id: $id) {
      id
      fields { key value }
    }
  }
`;

const PRODUCT_INFO_QUERY = `#graphql
  query GetProduct($id: ID!) {
    product(id: $id) {
      title
      handle
      collections(first: 5) { edges { node { handle title } } }
    }
  }
`;

// 既に発行済みかチェック
const EXISTING_COUPON_QUERY = `#graphql
  query FindCoupon($q: String!) {
    metaobjects(type: "astromeda_review_coupon", first: 5, query: $q) {
      edges { node { id fields { key value } } }
    }
  }
`;

const DISCOUNT_CREATE = `#graphql
  mutation CreateDiscount($basicCodeDiscount: DiscountCodeBasicInput!) {
    discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
      codeDiscountNode { id }
      userErrors { field message code }
    }
  }
`;

const COUPON_CREATE = `#graphql
  mutation Create($metaobject: MetaobjectCreateInput!) {
    metaobjectCreate(metaobject: $metaobject) {
      metaobject { id }
      userErrors { field message code }
    }
  }
`;

export interface IssueCouponResult {
  ok: boolean;
  code?: string;
  couponMetaobjectId?: string;
  shopifyDiscountId?: string;
  emailSent?: boolean;
  emailId?: string;
  skipped?: string; // "already_issued" | "disabled" | "no_email" | "no_product"
  error?: string;
}

export async function issueCouponForReview(admin: any, reviewGid: string): Promise<IssueCouponResult> {
  try {
    // 1) Settings
    const sres: any = await admin.graphql(SETTINGS_QUERY);
    const sj = await sres.json();
    const sNode = sj?.data?.metaobjectByHandle;
    if (!sNode) return { ok: false, error: "settings not found" };
    const s = fieldsToMap(sNode.fields);
    if (s.enabled !== "true") return { ok: false, skipped: "disabled" };

    // 2) Review fields
    const rres: any = await admin.graphql(REVIEW_FIELDS_QUERY, { variables: { id: reviewGid } });
    const rj = await rres.json();
    const rNode = rj?.data?.metaobject;
    if (!rNode) return { ok: false, error: "review not found" };
    const r = fieldsToMap(rNode.fields);
    const email = (r.reviewer_email || "").trim();
    const name = (r.reviewer_name || "お客様").trim();
    const productGid = (r.product_ref || "").trim();
    if (!email) return { ok: false, skipped: "no_email" };
    if (!productGid) return { ok: false, skipped: "no_product" };

    // 3) Check if already issued for this review
    const eres: any = await admin.graphql(EXISTING_COUPON_QUERY, { variables: { q: `display_name:${email}` } });
    const ej = await eres.json();
    const existing = (ej?.data?.metaobjects?.edges ?? []).find((e: any) => {
      const m = fieldsToMap(e.node.fields);
      return m.review_id === reviewGid;
    });
    if (existing) return { ok: false, skipped: "already_issued" };

    // 4) Product info
    const pres: any = await admin.graphql(PRODUCT_INFO_QUERY, { variables: { id: productGid } });
    const pj = await pres.json();
    const product = pj?.data?.product;
    const productTitle = product?.title || "対象商品";

    // 5) Generate code + apply scope
    const code = generateCouponCode();
    const validityDays = parseInt(s.validity_days || "90", 10);
    const nowIso = new Date().toISOString();
    const expiresIso = new Date(Date.now() + validityDays * 86400000).toISOString();
    const discountValue = parseFloat(s.discount_value || "10");
    const isPercentage = s.discount_type === "percentage";
    const couponLabel = isPercentage ? `${discountValue}%` : `¥${discountValue.toLocaleString()}`;

    // Determine applicable scope text for email
    let applicableScope = "全商品";
    if (s.applicable_to === "same_ip") {
      // Find first "collaboration" collection
      const colls = (product?.collections?.edges ?? []).map((c: any) => c.node);
      const ipColl = colls.find((c: any) => (c.handle || "").toLowerCase().includes("collaboration") || (c.handle || "").toLowerCase().includes("collab"));
      applicableScope = ipColl ? `${ipColl.title} の商品` : "同IPコラボの商品";
    } else if (s.applicable_to === "product") {
      applicableScope = `「${productTitle}」のみ`;
    } else if (s.applicable_to === "category") {
      applicableScope = "同カテゴリの商品";
    }

    // 6) Try to create Shopify Discount Code (may fail if write_discounts scope not granted)
    let shopifyDiscountId = "";
    let scopeError = "";
    try {
      const value = isPercentage
        ? { percentage: discountValue / 100 }
        : { discountAmount: { amount: discountValue, appliesOnEachItem: false } };
      const dres: any = await admin.graphql(DISCOUNT_CREATE, {
        variables: {
          basicCodeDiscount: {
            title: `Review Reward ${code}`,
            code,
            startsAt: nowIso,
            endsAt: expiresIso,
            customerSelection: { all: true },
            customerGets: { value, items: { all: true } },
            usageLimit: 1,
            appliesOncePerCustomer: true,
          },
        },
      });
      const dj = await dres.json();
      const derrs = dj?.data?.discountCodeBasicCreate?.userErrors ?? [];
      if (derrs.length > 0) {
        scopeError = derrs.map((e: any) => e.message).join(", ");
        console.error("[ISSUE-COUPON] discount create userErrors", derrs);
      } else {
        shopifyDiscountId = dj?.data?.discountCodeBasicCreate?.codeDiscountNode?.id || "";
      }
    } catch (e: any) {
      scopeError = e?.message || String(e);
      console.error("[ISSUE-COUPON] discount create exception", scopeError);
    }

    // 7) Save coupon Metaobject (always, even if Shopify Discount Code failed)
    const cres: any = await admin.graphql(COUPON_CREATE, {
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
            { key: "verified_at", value: shopifyDiscountId ? nowIso : "" },
          ],
        },
      },
    });
    const cj = await cres.json();
    const cerrs = cj?.data?.metaobjectCreate?.userErrors ?? [];
    if (cerrs.length > 0) {
      console.error("[ISSUE-COUPON] coupon metaobject errors", cerrs);
      return { ok: false, error: cerrs.map((e: any) => e.message).join(", "), code };
    }
    const couponMetaobjectId = cj?.data?.metaobjectCreate?.metaobject?.id || "";

    // 8) Send thank-you email via Resend
    let emailSent = false;
    let emailId = "";
    try {
      const tres = await sendThankYouEmail({
        to: email,
        customerName: name,
        productTitle,
        couponCode: code,
        couponLabel,
        expiresAt: expiresIso,
        applicableScope,
      });
      if (tres.ok) {
        emailSent = true;
        emailId = tres.id || "";
      } else {
        console.error("[ISSUE-COUPON] thank-you email failed", tres.error);
      }
    } catch (e: any) {
      console.error("[ISSUE-COUPON] thank-you email exception", e?.message);
    }

    console.log("[ISSUE-COUPON] DONE", { code, couponMetaobjectId, shopifyDiscountId, scopeError, emailSent, emailId });
    return { ok: true, code, couponMetaobjectId, shopifyDiscountId, emailSent, emailId, error: scopeError || undefined };
  } catch (e: any) {
    console.error("[ISSUE-COUPON] CAUGHT", e?.message);
    return { ok: false, error: e?.message ?? String(e) };
  }
}
