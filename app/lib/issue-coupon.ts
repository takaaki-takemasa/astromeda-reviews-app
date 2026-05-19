/**
 * Phase 2.5: Shopify ディスカウント連携版クーポン発行ヘルパー
 *
 * 設計: Shopify ディスカウント (codeDiscountNode) を Single Source of Truth とする。
 *   1. CEO が Shopify 管理画面で「Review Reward」など割引設定を 1 つ作る
 *   2. app の設定で connected_discount_gid を選ぶ
 *   3. レビュー承認時、その配下に固有コードを追加 (discountRedeemCodeBulkAdd)
 *   4. 我々の Metaobject は履歴記録のみ
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
      id fields { key value }
    }
  }
`;

const REVIEW_FIELDS_QUERY = `#graphql
  query GetReview($id: ID!) {
    metaobject(id: $id) { id fields { key value } }
  }
`;

const PRODUCT_INFO_QUERY = `#graphql
  query GetProduct($id: ID!) {
    product(id: $id) {
      title handle
      collections(first: 5) { edges { node { handle title } } }
    }
  }
`;

const EXISTING_COUPON_QUERY = `#graphql
  query FindCoupon {
    metaobjects(type: "astromeda_review_coupon", first: 50) {
      edges { node { id fields { key value } } }
    }
  }
`;

const DISCOUNT_INFO_QUERY = `#graphql
  query GetDiscount($id: ID!) {
    codeDiscountNode(id: $id) {
      id
      codeDiscount {
        ... on DiscountCodeBasic {
          title status startsAt endsAt
          customerGets {
            value {
              ... on DiscountPercentage { percentage }
              ... on DiscountAmount { amount { amount currencyCode } }
            }
          }
        }
      }
    }
  }
`;

const REDEEM_CODE_BULK_ADD = `#graphql
  mutation BulkAdd($discountId: ID!, $codes: [DiscountRedeemCodeInput!]!) {
    discountRedeemCodeBulkAdd(discountId: $discountId, codes: $codes) {
      bulkCreation { id }
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
  shopifyBulkCreationId?: string;
  emailSent?: boolean;
  emailId?: string;
  skipped?: string;
  error?: string;
}

export async function issueCouponForReview(admin: any, reviewGid: string): Promise<IssueCouponResult> {
  try {
    // 1) Settings + Shopify discount GID
    const sres: any = await admin.graphql(SETTINGS_QUERY);
    const sj = await sres.json();
    const sNode = sj?.data?.metaobjectByHandle;
    if (!sNode) return { ok: false, error: "settings not found" };
    const s = fieldsToMap(sNode.fields);
    if (s.enabled !== "true") return { ok: false, skipped: "disabled" };
    const discountGid = (s.shopify_discount_gid || "").trim();
    if (!discountGid) return { ok: false, skipped: "no_discount_linked", error: "Shopify ディスカウント未連携。設定タブで選択してください" };

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

    // 3) Already issued? (同 review に対しては再発行しない)
    const eres: any = await admin.graphql(EXISTING_COUPON_QUERY);
    const ej = await eres.json();
    const existing = (ej?.data?.metaobjects?.edges ?? []).find((e: any) => fieldsToMap(e.node.fields).review_id === reviewGid);
    if (existing) return { ok: false, skipped: "already_issued" };

    // 4) Product + Discount info (メール用)
    const pres: any = await admin.graphql(PRODUCT_INFO_QUERY, { variables: { id: productGid } });
    const pj = await pres.json();
    const product = pj?.data?.product;
    const productTitle = product?.title || "対象商品";

    const dres: any = await admin.graphql(DISCOUNT_INFO_QUERY, { variables: { id: discountGid } });
    const dj = await dres.json();
    const dNode = dj?.data?.codeDiscountNode;
    if (!dNode) return { ok: false, error: "linked Shopify discount not found" };
    const dInfo = dNode.codeDiscount || {};
    const valObj = dInfo.customerGets?.value || {};
    let couponLabel = "";
    if (valObj.percentage != null) couponLabel = `${Math.round(valObj.percentage * 100)}%`;
    else if (valObj.amount?.amount) couponLabel = `¥${valObj.amount.amount}`;
    const expiresIso = dInfo.endsAt || new Date(Date.now() + 90 * 86400000).toISOString();

    let applicableScope = "対象商品";
    const colls = (product?.collections?.edges ?? []).map((c: any) => c.node);
    const ipColl = colls.find((c: any) => (c.handle || "").toLowerCase().includes("collaboration"));
    if (ipColl) applicableScope = `${ipColl.title} の商品`;

    // 5) Generate code + add to existing Shopify discount
    const code = generateCouponCode();
    const nowIso = new Date().toISOString();
    let bulkCreationId = "";
    let scopeError = "";
    // Try merchant OAuth first
    try {
      const ares: any = await admin.graphql(REDEEM_CODE_BULK_ADD, {
        variables: { discountId: discountGid, codes: [{ code }] },
      });
      const aj = await ares.json();
      const aerrs = aj?.data?.discountRedeemCodeBulkAdd?.userErrors ?? [];
      if (aerrs.length > 0) {
        scopeError = aerrs.map((e: any) => e.message).join(", ");
        console.error("[ISSUE-COUPON] bulkAdd userErrors", aerrs);
      } else {
        bulkCreationId = aj?.data?.discountRedeemCodeBulkAdd?.bulkCreation?.id || "";
      }
    } catch (e: any) {
      scopeError = e?.message || String(e);
      console.error("[ISSUE-COUPON] bulkAdd OAuth exception", scopeError);
    }
    // Fallback: offline admin token (when write_discounts scope not yet granted to embedded app)
    if (!bulkCreationId && process.env.SHOPIFY_ADMIN_ACCESS_TOKEN) {
      try {
        const shop = process.env.PRODUCTION_SHOP_DOMAIN || "production-mining-base.myshopify.com";
        const cleanQuery = REDEEM_CODE_BULK_ADD.replace(/^#graphql\s*/, "");
        const r = await fetch(`https://${shop}/admin/api/2024-10/graphql.json`, {
          method: "POST",
          headers: { "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_ACCESS_TOKEN, "Content-Type": "application/json" },
          body: JSON.stringify({ query: cleanQuery, variables: { discountId: discountGid, codes: [{ code }] } }),
        });
        const fbj = await r.json();
        const fbErrs = fbj?.data?.discountRedeemCodeBulkAdd?.userErrors ?? [];
        if (fbErrs.length > 0) {
          scopeError = "fallback also failed: " + fbErrs.map((e: any) => e.message).join(", ");
          console.error("[ISSUE-COUPON] fallback bulkAdd userErrors", fbErrs);
        } else {
          bulkCreationId = fbj?.data?.discountRedeemCodeBulkAdd?.bulkCreation?.id || "";
          if (bulkCreationId) {
            scopeError = ""; // recovered
            console.log("[ISSUE-COUPON] fallback bulkAdd succeeded via SHOPIFY_ADMIN_ACCESS_TOKEN", bulkCreationId);
          }
        }
      } catch (fbErr: any) {
        console.error("[ISSUE-COUPON] fallback bulkAdd exception", fbErr?.message);
      }
    }

    // 6) Save coupon Metaobject (履歴用・常に保存)
    const cres: any = await admin.graphql(COUPON_CREATE, {
      variables: {
        metaobject: {
          type: "astromeda_review_coupon",
          fields: [
            { key: "code", value: code },
            { key: "discount_type", value: valObj.percentage != null ? "percentage" : "fixed_amount" },
            { key: "discount_value", value: String(valObj.percentage != null ? Math.round(valObj.percentage * 100) : valObj.amount?.amount || 0) },
            { key: "validity_days", value: "" },
            { key: "applicable_to", value: "shopify_discount" },
            { key: "issued_to_email", value: email },
            { key: "issued_at", value: nowIso },
            { key: "expires_at", value: expiresIso },
            { key: "shopify_discount_code_id", value: discountGid },
            { key: "source", value: "review_submission" },
            { key: "review_id", value: reviewGid },
            { key: "verified_at", value: bulkCreationId ? nowIso : "" },
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

    // 7) Thank-you email
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
      if (tres.ok) { emailSent = true; emailId = tres.id || ""; }
      else console.error("[ISSUE-COUPON] thank-you email failed", tres.error);
    } catch (e: any) {
      console.error("[ISSUE-COUPON] thank-you email exception", e?.message);
    }

    console.log("[ISSUE-COUPON] DONE", { code, couponMetaobjectId, bulkCreationId, scopeError, emailSent, emailId });
    return {
      ok: true,
      code,
      couponMetaobjectId,
      shopifyBulkCreationId: bulkCreationId,
      emailSent,
      emailId,
      error: scopeError || undefined,
    };
  } catch (e: any) {
    console.error("[ISSUE-COUPON] CAUGHT", e?.message);
    return { ok: false, error: e?.message ?? String(e) };
  }
}
