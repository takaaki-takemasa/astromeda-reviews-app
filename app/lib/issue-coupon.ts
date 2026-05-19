/**
 * Phase 2.5 v2: Per-review DiscountCodeBasic 発行ヘルパー
 *
 * 設計: マスターディスカウントは「テンプレート」として機能
 *   1. CEO が Shopify 管理画面で「Review Reward」マスターを 1 つ作成
 *      (割引率・対象商品/コレクション・最低購入額・combinesWith・顧客スコープを設定)
 *   2. app 設定の dropdown でマスターを選択
 *   3. レビュー承認時、マスターの設定を「コピー」して新規 DiscountCodeBasic を作成
 *      - code: REV-XXXXXX (固有 6 桁)
 *      - usageLimit: 1 (per-code 単発使用・CEO 要件)
 *      - appliesOncePerCustomer: true (同一顧客の重複防止)
 *      - endsAt: 発行時刻 + validity_days (incentive_settings 由来)
 *      - 他項目: マスターからコピー
 *   4. 我々の Metaobject (astromeda_review_coupon) は履歴記録のみ
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
      collections(first: 5) { edges { node { id handle title } } }
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

// Master template の設定を読み取って新規 discount に複製する
const TEMPLATE_QUERY = `#graphql
  query GetTemplate($id: ID!) {
    codeDiscountNode(id: $id) {
      id
      codeDiscount {
        ... on DiscountCodeBasic {
          title
          status
          startsAt
          endsAt
          combinesWith { productDiscounts orderDiscounts shippingDiscounts }
          minimumRequirement {
            ... on DiscountMinimumSubtotal { greaterThanOrEqualToSubtotal { amount } }
            ... on DiscountMinimumQuantity { greaterThanOrEqualToQuantity }
          }
          customerGets {
            value {
              ... on DiscountPercentage { percentage }
              ... on DiscountAmount { amount { amount currencyCode } appliesOnEachItem }
            }
            items {
              ... on DiscountProducts {
                products(first: 50) { edges { node { id } } }
                productVariants(first: 50) { edges { node { id } } }
              }
              ... on DiscountCollections {
                collections(first: 50) { edges { node { id } } }
              }
              ... on AllDiscountItems { allItems }
            }
            appliesOnOneTimePurchase
            appliesOnSubscription
          }
        }
      }
    }
  }
`;

const DISCOUNT_CODE_CREATE = `#graphql
  mutation CreateDiscount($basicCodeDiscount: DiscountCodeBasicInput!) {
    discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
      codeDiscountNode {
        id
        codeDiscount {
          ... on DiscountCodeBasic {
            title status endsAt usageLimit appliesOncePerCustomer
            codes(first: 1) { edges { node { code } } }
          }
        }
      }
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
  shopifyDiscountNodeId?: string;
  emailSent?: boolean;
  emailId?: string;
  skipped?: string;
  error?: string;
}

/**
 * Build DiscountCodeBasicInput by copying fields from the master template
 */
function buildInputFromTemplate(
  template: any,
  newCode: string,
  reviewerName: string,
  validityDays: number,
): any {
  const now = new Date();
  const endsAt = new Date(now.getTime() + validityDays * 86400000).toISOString();

  const valObj = template?.customerGets?.value || {};
  const itemsObj = template?.customerGets?.items || {};

  // value (rate)
  const value: any = {};
  if (valObj.percentage != null) {
    value.percentage = valObj.percentage;
  } else if (valObj.amount?.amount != null) {
    value.discountAmount = {
      amount: parseFloat(valObj.amount.amount),
      appliesOnEachItem: valObj.appliesOnEachItem ?? false,
    };
  } else {
    value.percentage = 0.1; // fallback 10% OFF
  }

  // items (scope)
  const items: any = {};
  if (itemsObj.allItems === true) {
    items.all = true;
  } else if (Array.isArray(itemsObj.products?.edges) && itemsObj.products.edges.length > 0) {
    items.products = {
      productsToAdd: itemsObj.products.edges.map((e: any) => e.node.id),
    };
  } else if (Array.isArray(itemsObj.collections?.edges) && itemsObj.collections.edges.length > 0) {
    items.collections = {
      add: itemsObj.collections.edges.map((e: any) => e.node.id),
    };
  } else {
    items.all = true; // fallback to all items
  }

  const customerGets = {
    value,
    items,
    appliesOnOneTimePurchase: template?.customerGets?.appliesOnOneTimePurchase ?? true,
    appliesOnSubscription: template?.customerGets?.appliesOnSubscription ?? false,
  };

  // minimumRequirement
  const minimumRequirement: any = {};
  const minSub = template?.minimumRequirement?.greaterThanOrEqualToSubtotal?.amount;
  const minQty = template?.minimumRequirement?.greaterThanOrEqualToQuantity;
  if (minSub != null) {
    minimumRequirement.subtotal = { greaterThanOrEqualToSubtotal: parseFloat(minSub) };
  } else if (minQty != null) {
    minimumRequirement.quantity = { greaterThanOrEqualToQuantity: minQty };
  }
  const hasMin = Object.keys(minimumRequirement).length > 0;

  const combines = template?.combinesWith || { productDiscounts: false, orderDiscounts: false, shippingDiscounts: false };

  return {
    title: `Review Reward - ${reviewerName} - ${newCode}`,
    code: newCode,
    startsAt: now.toISOString(),
    endsAt,
    usageLimit: 1, // CEO 要件: 1 コード = 1 回のみ
    appliesOncePerCustomer: true, // 安全装置: 同一顧客の二重使用防止
    customerGets,
    combinesWith: combines,
    appliesOnOneTimePurchase: template?.customerGets?.appliesOnOneTimePurchase ?? true,
    appliesOnSubscription: template?.customerGets?.appliesOnSubscription ?? false,
    ...(hasMin ? { minimumRequirement } : {}),
  };
}

async function callGraphqlWithFallback(admin: any, query: string, variables: any) {
  // Try merchant OAuth first
  try {
    const res: any = await admin.graphql(query, { variables });
    const j = await res.json();
    if (j?.errors && j.errors.length > 0) throw new Error("graphql_errors: " + j.errors.map((e: any) => e.message).join("; "));
    return { data: j, source: "oauth" };
  } catch (oauthErr: any) {
    // Fallback to offline admin token if available
    if (process.env.SHOPIFY_ADMIN_ACCESS_TOKEN) {
      const shop = process.env.PRODUCTION_SHOP_DOMAIN || "production-mining-base.myshopify.com";
      const cleanQuery = query.replace(/^#graphql\s*/, "");
      const r = await fetch(`https://${shop}/admin/api/2024-10/graphql.json`, {
        method: "POST",
        headers: { "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_ACCESS_TOKEN, "Content-Type": "application/json" },
        body: JSON.stringify({ query: cleanQuery, variables }),
      });
      const j = await r.json();
      return { data: j, source: "offline_fallback" };
    }
    throw oauthErr;
  }
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
    const templateGid = (s.shopify_discount_gid || "").trim();
    if (!templateGid) {
      return {
        ok: false,
        skipped: "no_discount_linked",
        error: "Shopify ディスカウントテンプレートが未連携。設定タブでマスターを選択してください",
      };
    }
    const validityDays = Math.max(1, parseInt(s.validity_days || "90", 10) || 90);

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
    const existing = (ej?.data?.metaobjects?.edges ?? []).find(
      (e: any) => fieldsToMap(e.node.fields).review_id === reviewGid,
    );
    if (existing) return { ok: false, skipped: "already_issued" };

    // 4) Product + Template info (メール文面 + 新規 discount 作成用)
    const pres: any = await admin.graphql(PRODUCT_INFO_QUERY, { variables: { id: productGid } });
    const pj = await pres.json();
    const product = pj?.data?.product;
    const productTitle = product?.title || "対象商品";

    const tres: any = await callGraphqlWithFallback(admin, TEMPLATE_QUERY, { id: templateGid });
    const template = tres.data?.data?.codeDiscountNode?.codeDiscount;
    if (!template) {
      return { ok: false, error: "linked Shopify discount template not found or scope missing" };
    }

    const valObj = template.customerGets?.value || {};
    let couponLabel = "";
    if (valObj.percentage != null) couponLabel = `${Math.round(valObj.percentage * 100)}%`;
    else if (valObj.amount?.amount) couponLabel = `¥${valObj.amount.amount}`;

    let applicableScope = "対象商品";
    const colls = (product?.collections?.edges ?? []).map((c: any) => c.node);
    const ipColl = colls.find((c: any) => (c.handle || "").toLowerCase().includes("collaboration"));
    if (ipColl) applicableScope = `${ipColl.title} の商品`;

    // 5) Generate code + create new DiscountCodeBasic (with usageLimit:1)
    const code = generateCouponCode();
    const nowIso = new Date().toISOString();
    const input = buildInputFromTemplate(template, code, name, validityDays);

    let newDiscountNodeId = "";
    let createError = "";
    let createSource = "";
    try {
      const cres: any = await callGraphqlWithFallback(admin, DISCOUNT_CODE_CREATE, {
        basicCodeDiscount: input,
      });
      createSource = cres.source;
      const cdata = cres.data?.data?.discountCodeBasicCreate;
      const cerrs = cdata?.userErrors ?? [];
      if (cerrs.length > 0) {
        createError = cerrs.map((e: any) => e.message).join(", ");
        console.error("[ISSUE-COUPON] discount create userErrors", cerrs, "input=", JSON.stringify(input));
      } else {
        newDiscountNodeId = cdata?.codeDiscountNode?.id || "";
        console.log("[ISSUE-COUPON] new DiscountCodeBasic created", { code, newDiscountNodeId, source: createSource });
      }
    } catch (e: any) {
      createError = e?.message || String(e);
      console.error("[ISSUE-COUPON] discount create exception", createError);
    }

    const expiresIso = new Date(Date.now() + validityDays * 86400000).toISOString();

    // 6) Save coupon Metaobject (履歴用・常に保存)
    const couponCreate: any = await admin.graphql(COUPON_CREATE, {
      variables: {
        metaobject: {
          type: "astromeda_review_coupon",
          fields: [
            { key: "code", value: code },
            { key: "discount_type", value: valObj.percentage != null ? "percentage" : "fixed_amount" },
            {
              key: "discount_value",
              value: String(
                valObj.percentage != null ? Math.round(valObj.percentage * 100) : valObj.amount?.amount || 0,
              ),
            },
            { key: "validity_days", value: String(validityDays) },
            { key: "applicable_to", value: "shopify_discount" },
            { key: "issued_to_email", value: email },
            { key: "issued_at", value: nowIso },
            { key: "expires_at", value: expiresIso },
            { key: "shopify_discount_code_id", value: newDiscountNodeId },
            { key: "source", value: "review_submission" },
            { key: "review_id", value: reviewGid },
            { key: "verified_at", value: newDiscountNodeId ? nowIso : "" },
          ],
        },
      },
    });
    const couponJson = await couponCreate.json();
    const couponErrs = couponJson?.data?.metaobjectCreate?.userErrors ?? [];
    if (couponErrs.length > 0) {
      console.error("[ISSUE-COUPON] coupon metaobject errors", couponErrs);
      return { ok: false, error: couponErrs.map((e: any) => e.message).join(", "), code };
    }
    const couponMetaobjectId = couponJson?.data?.metaobjectCreate?.metaobject?.id || "";

    // 7) Thank-you email
    let emailSent = false;
    let emailId = "";
    try {
      const tres2 = await sendThankYouEmail({
        to: email,
        customerName: name,
        productTitle,
        couponCode: code,
        couponLabel,
        expiresAt: expiresIso,
        applicableScope,
      });
      if (tres2.ok) {
        emailSent = true;
        emailId = tres2.id || "";
      } else {
        console.error("[ISSUE-COUPON] thank-you email failed", tres2.error);
      }
    } catch (e: any) {
      console.error("[ISSUE-COUPON] thank-you email exception", e?.message);
    }

    console.log("[ISSUE-COUPON] DONE", {
      code,
      couponMetaobjectId,
      newDiscountNodeId,
      createError,
      emailSent,
      emailId,
    });
    return {
      ok: true,
      code,
      couponMetaobjectId,
      shopifyDiscountNodeId: newDiscountNodeId,
      emailSent,
      emailId,
      error: createError || undefined,
    };
  } catch (e: any) {
    console.error("[ISSUE-COUPON] CAUGHT", e?.message);
    return { ok: false, error: e?.message ?? String(e) };
  }
}
