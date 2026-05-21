import {
  DropZone,
  Page,
  Layout,
  Card,
  BlockStack,
  Text,
  EmptyState,
  InlineStack,
  Badge,
  IndexTable,
  Button,
  Banner,
  Tabs,
  Pagination,
  useIndexResourceState,
  Modal,
  TextField,
  Select,
  FormLayout,
  Thumbnail,
  Divider,
  Box,
  Link,
  SkeletonBodyText,
  ProgressBar,
} from "@shopify/polaris";
import { useAppBridge } from "@shopify/app-bridge-react";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher, useSearchParams } from "@remix-run/react";
import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import { authenticate } from "../shopify.server";
import { issueCouponForReview } from "../lib/issue-coupon";
import { appendAuditLogSafe } from "../lib/audit-log";

// Vercel Pro: 60 秒まで。チャンク 1 つあたり 30 行 × 500ms ≈ 15-20 秒で完走想定だが安全マージンとして明示
export const config = { maxDuration: 60 };

type ReviewStatus = "pending" | "approved" | "rejected";

interface ProductRef {
  id: string;
  title: string;
  handle: string;
  image_url: string | null;
}

interface PhotoSlot {
  slot: number; // 1-6
  file_id: string; // gid://shopify/MediaImage/...
  url: string | null;
}

interface ReviewItem {
  id: string;
  handle: string;
  rating: number;
  title: string;
  body: string;
  reviewer_name: string;
  reviewer_email: string;
  status: ReviewStatus;
  source_type: string;
  order_id: string;
  gift_token_id: string;
  reply_text: string;
  approved_at: string;
  approved_by: string;
  posted_at: string;
  created_at: string;
  product: ProductRef | null;
  photos: PhotoSlot[];
}

interface GiftTokenInfo {
  id: string;
  customer_name: string;
  email: string;
  token_type: string;
  issued_by: string;
  expires_at: string;
  used_at: string;
  gift_note: string;
}

interface OrderInfo {
  id: string;
  name: string;
  customer_name: string;
  email: string;
  created_at: string;
}

interface ReviewDetail {
  review: ReviewItem;
  gift_token: GiftTokenInfo | null;
  order: OrderInfo | null;
}

interface ActionResult {
  ok: boolean;
  error?: string;
  updated?: number;
  failed?: number;
  created?: number;
  edited?: number;
  new_id?: string | null;
  detail?: ReviewDetail;
  intent?: string;
}

const LIST_QUERY = `#graphql
  query ListReviews($first: Int!, $after: String) {
    metaobjects(type: "astromeda_review", first: $first, after: $after) {
      edges {
        node {
          id
          handle
          updatedAt
          fields {
            key
            value
            reference {
              ... on Product {
                id
                title
                handle
                featuredImage { url altText }
              }
            }
          }
        }
        cursor
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

// LITE: id + updatedAt + fields(key,value のみ。Product reference resolution なし)
// 1028 件のフル fetch を高速化するために sort/filter/count 用に使う。
const LIST_QUERY_LITE = `#graphql
  query ListReviewsLite($first: Int!, $after: String) {
    metaobjects(type: "astromeda_review", first: $first, after: $after) {
      edges {
        node {
          id
          updatedAt
          status: field(key: "status") { value }
          rating: field(key: "rating") { value }
          posted_at: field(key: "posted_at") { value }
          approved_at: field(key: "approved_at") { value }
        }
        cursor
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

// FULL: 表示中のページ (最大 100 件) の ID のみを batch fetch (Product reference 含む)
const NODES_FULL_QUERY = `#graphql
  query GetFullReviews($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Metaobject {
        id
        handle
        updatedAt
        fields {
          key
          value
          reference {
            ... on Product {
              id
              title
              handle
              featuredImage { url altText }
            }
          }
        }
      }
    }
  }
`;

const UPDATE_STATUS_MUTATION = `#graphql
  mutation UpdateReviewStatus($id: ID!, $fields: [MetaobjectFieldInput!]!) {
    metaobjectUpdate(id: $id, metaobject: { fields: $fields }) {
      metaobject { id }
      userErrors { field message code }
    }
  }
`;

const CREATE_REVIEW_MUTATION = `#graphql
  mutation CreateAdminReview($metaobject: MetaobjectCreateInput!) {
    metaobjectCreate(metaobject: $metaobject) {
      metaobject { id handle }
      userErrors { field message code }
    }
  }
`;

const EDIT_REVIEW_MUTATION = `#graphql
  mutation EditReview($id: ID!, $fields: [MetaobjectFieldInput!]!) {
    metaobjectUpdate(id: $id, metaobject: { fields: $fields }) {
      metaobject { id }
      userErrors { field message code }
    }
  }
`;

const DELETE_REVIEW_MUTATION = `#graphql
  mutation DeleteReview($id: ID!) {
    metaobjectDelete(id: $id) {
      deletedId
      userErrors { field message code }
    }
  }
`;

const STAGED_UPLOADS_CREATE_MUTATION = `#graphql
  mutation StagedUploadsCreate($input: [StagedUploadInput!]!) {
    stagedUploadsCreate(input: $input) {
      stagedTargets {
        url
        resourceUrl
        parameters { name value }
      }
      userErrors { field message }
    }
  }
`;

const FILE_CREATE_MUTATION = `#graphql
  mutation CreatePhoto($files: [FileCreateInput!]!) {
    fileCreate(files: $files) {
      files {
        ... on MediaImage {
          id
          image { url altText width height }
        }
      }
      userErrors { field message code }
    }
  }
`;

const FETCH_TOKEN_QUERY = `#graphql
  query FetchToken($id: ID!) {
    metaobject(id: $id) {
      id
      fields { key value }
    }
  }
`;

const FETCH_ORDER_QUERY = `#graphql
  query FetchOrder($id: ID!) {
    order(id: $id) {
      id
      name
      createdAt
      customer { firstName lastName email }
    }
  }
`;

function fieldVal(
  node: { fields: Array<{ key: string; value: string }> },
  key: string,
): string {
  return node.fields.find((x) => x.key === key)?.value ?? "";
}

function extractReview(edge: {
  node: {
    id: string;
    handle: string;
    updatedAt: string;
    fields: Array<{
      key: string;
      value: string;
      reference?: {
        // Product
        id?: string;
        title?: string;
        handle?: string;
        featuredImage?: { url?: string; altText?: string };
        // MediaImage
        image?: { url?: string; altText?: string };
      } | null;
    }>;
  };
}): ReviewItem {
  const node = edge.node;
  const productField = node.fields.find((f) => f.key === "product_ref");
  let product: ProductRef | null = null;
  if (productField?.reference?.id) {
    const ref = productField.reference;
    product = {
      id: ref.id ?? "",
      title: ref.title ?? "(削除済み商品)",
      handle: ref.handle ?? "",
      image_url: ref.featuredImage?.url ?? null,
    };
  }
  // Extract photo_1..photo_6 references
  const photos: PhotoSlot[] = [];
  for (let i = 1; i <= 6; i++) {
    const pf = node.fields.find((f) => f.key === `photo_${i}`);
    if (pf?.value && pf?.reference?.id) {
      photos.push({
        slot: i,
        file_id: pf.reference.id,
        url: pf.reference.image?.url ?? null,
      });
    }
  }
  return {
    id: node.id,
    handle: node.handle,
    rating: Number(fieldVal(node, "rating") || 0),
    title: fieldVal(node, "title"),
    body: fieldVal(node, "body"),
    reviewer_name: fieldVal(node, "reviewer_name"),
    reviewer_email: fieldVal(node, "reviewer_email"),
    status: (fieldVal(node, "status") as ReviewStatus) || "pending",
    source_type: fieldVal(node, "source_type"),
    order_id: fieldVal(node, "order_id"),
    gift_token_id: fieldVal(node, "gift_token_id"),
    reply_text: fieldVal(node, "reply_text"),
    approved_at: fieldVal(node, "approved_at"),
    approved_by: fieldVal(node, "approved_by"),
    posted_at: fieldVal(node, "posted_at"),
    created_at: node.updatedAt,
    product,
    photos,
  };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const tab = (url.searchParams.get("tab") as ReviewStatus | null) ?? "pending";
  const sort = (url.searchParams.get("sort") as string | null) ?? "posted_at_desc";
  const pageParam = parseInt(url.searchParams.get("page") || "1", 10);
  const currentPage = isNaN(pageParam) || pageParam < 1 ? 1 : pageParam;

  const PAGE_SIZE = 100;

  // ─── 2-pass 最適化: 全件 lite fetch → sort/paginate → ページ内 full fetch ───
  // Pass 1: lite (reference resolution なし) で sort/filter/count に必要な最小フィールドのみ取得
  type LiteRow = { id: string; status: string; rating: number; posted_at: string; approved_at: string; updatedAt: string };
  const liteAll: LiteRow[] = [];
  let cursor: string | null = null;
  let safety = 0;
  const passOneDeadline = Date.now() + 45000; // 45s budget for Pass 1
  let partialData = false;
  while (safety < 50) {
    if (Date.now() > passOneDeadline) {
      partialData = true;
      console.warn("[reviews loader] Pass 1 deadline hit, returning partial data", { fetched: liteAll.length });
      break;
    }
    const res: any = await admin.graphql(LIST_QUERY_LITE, {
      variables: { first: 250, after: cursor },
    });
    const json = await res.json();
    const edges = json.data?.metaobjects?.edges ?? [];
    for (const edge of edges) {
      const node = edge.node;
      liteAll.push({
        id: node.id,
        status: node.status?.value || "pending",
        rating: Number(node.rating?.value || 0),
        posted_at: node.posted_at?.value || "",
        approved_at: node.approved_at?.value || "",
        updatedAt: node.updatedAt || "",
      });
    }
    const pageInfo = json.data?.metaobjects?.pageInfo;
    if (!pageInfo?.hasNextPage) break;
    cursor = pageInfo.endCursor;
    safety++;
  }

  // タブごとに count を計算 (lite で十分)
  const tabCounts = {
    pending: liteAll.filter((r) => r.status === "pending").length,
    approved: liteAll.filter((r) => r.status === "approved").length,
    rejected: liteAll.filter((r) => r.status === "rejected").length,
  };

  // 現在の tab で filter
  const filteredLite = liteAll.filter((r) => r.status === tab);
  // ソート: posted_at_desc/asc, rating_desc/asc, approved_at_desc/asc
  filteredLite.sort((a, b) => {
    if (sort === "posted_at_desc") {
      const aT = a.posted_at ? new Date(a.posted_at).getTime() : 0;
      const bT = b.posted_at ? new Date(b.posted_at).getTime() : 0;
      return bT - aT;
    }
    if (sort === "posted_at_asc") {
      const aT = a.posted_at ? new Date(a.posted_at).getTime() : Infinity;
      const bT = b.posted_at ? new Date(b.posted_at).getTime() : Infinity;
      return aT - bT;
    }
    if (sort === "rating_desc") return (b.rating || 0) - (a.rating || 0);
    if (sort === "rating_asc") return (a.rating || 0) - (b.rating || 0);
    if (sort === "approved_at_desc") {
      const aT = a.approved_at ? new Date(a.approved_at).getTime() : 0;
      const bT = b.approved_at ? new Date(b.approved_at).getTime() : 0;
      return bT - aT;
    }
    if (sort === "approved_at_asc") {
      const aT = a.approved_at ? new Date(a.approved_at).getTime() : Infinity;
      const bT = b.approved_at ? new Date(b.approved_at).getTime() : Infinity;
      return aT - bT;
    }
    return 0;
  });
  const totalCount = filteredLite.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const startIdx = (currentPage - 1) * PAGE_SIZE;
  const pageLite = filteredLite.slice(startIdx, startIdx + PAGE_SIZE);

  // Pass 2: 表示中のページの ID のみ full fetch (Product reference 解決込み)
  let reviews: ReviewItem[] = [];
  if (pageLite.length > 0) {
    const ids = pageLite.map((r) => r.id);
    const fullRes: any = await admin.graphql(NODES_FULL_QUERY, {
      variables: { ids },
    });
    const fullJson = await fullRes.json();
    const fullNodes: any[] = fullJson.data?.nodes ?? [];
    // id → full node map を作って lite の順序を保持
    const byId = new Map<string, any>();
    for (const n of fullNodes) {
      if (n && n.id) byId.set(n.id, n);
    }
    reviews = pageLite
      .map((lr) => {
        const fn = byId.get(lr.id);
        if (!fn) return null;
        return extractReview({ node: fn });
      })
      .filter((x): x is ReviewItem => x !== null);
  }

  // Extract shop slug (strip .myshopify.com) for admin URLs
  const shopFull = (session.shop ?? "").toString();
  const shop = shopFull.replace(/\.myshopify\.com$/, "");

  return {
    tab,
    reviews,
    pageInfo: { hasNextPage: currentPage < totalPages, endCursor: null as string | null },
    shop,
    pagination: {
      pageSize: PAGE_SIZE,
      currentPage,
      totalPages,
      totalCount,
      cursorHistory: [] as string[],
    },
    tabCounts,
    sort,
    partialData,
  };
};


// ─────────────────────────────────────────────
// 自動翻訳ヘルパー (DeepL API)
// DEEPL_API_KEY が未設定なら null を返してフォールバック (原文のみ保存)
// ─────────────────────────────────────────────
function isProbablyJapanese(text: string): boolean {
  // ひらがな/カタカナを含めば日本語と判定
  return /[\u3040-\u309F\u30A0-\u30FF]/.test(text);
}

async function translateToJapanese(text: string): Promise<string | null> {
  if (!text || !text.trim()) return null;
  if (isProbablyJapanese(text)) return null; // 既に日本語
  const apiKey = process.env.DEEPL_API_KEY;
  if (!apiKey) return null;
  try {
    // DeepL Free API
    const endpoint = apiKey.endsWith(":fx")
      ? "https://api-free.deepl.com/v2/translate"
      : "https://api.deepl.com/v2/translate";
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `DeepL-Auth-Key ${apiKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        text,
        target_lang: "JA",
      }).toString(),
    });
    if (!res.ok) {
      console.warn("[translate] DeepL failed", res.status, await res.text().catch(() => ""));
      return null;
    }
    const json = (await res.json()) as { translations?: Array<{ text?: string }> };
    return json.translations?.[0]?.text || null;
  } catch (e: any) {
    console.warn("[translate] error", e?.message);
    return null;
  }
}

const TRANSLATION_MARKER_SERVER = "──── 日本語訳 ────";
function appendTranslation(original: string, translation: string | null): string {
  if (!translation) return original;
  // すでに翻訳併記済みなら何もしない
  if (original.includes(TRANSLATION_MARKER_SERVER)) return original;
  return original + "\n\n" + TRANSLATION_MARKER_SERVER + "\n\n" + translation;
}


// ════════════════════════════════════════════════════════════
// 静的 HTML 書き換えヘルパー (admin が approve/reject 時に呼ぶ)
// ════════════════════════════════════════════════════════════

const PRODUCT_REVIEWS_QUERY = `#graphql
  query ProductApprovedReviews($productId: ID!, $first: Int!) {
    metaobjects(type: "astromeda_review", first: $first) {
      edges {
        node {
          id
          fields {
            key
            value
            reference {
              ... on Product { id }
              ... on MediaImage { image { url altText } }
            }
          }
        }
      }
    }
  }
`;

const PRODUCT_METAFIELD_SET = `#graphql
  mutation SetReviewsHtml($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id }
      userErrors { field message code }
    }
  }
`;

function escapeHtml(s: any): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function newlineToBr(s: string): string {
  return s.replace(/\r?\n/g, "<br>");
}

function renderReviewCardHtml(r: any, productTitle: string): string {
  const rating = parseInt(r.rating || "0", 10);
  const source = r.source_type || "";
  const stars = "★".repeat(rating) + `<span style="color:#d1d5db">${"★".repeat(Math.max(0,5-rating))}</span>`;
  let badge = "";
  if (source === "verified_purchase") badge = `<span class="astro-review-card__badge astro-review-card__badge--verified">✓ 認証購入</span>`;
  else if (source === "gift_recipient") badge = `<span class="astro-review-card__badge astro-review-card__badge--gift">🎁 ギフト受領</span>`;
  const titleHtml = r.title ? `<h3 class="astro-review-card__title">${escapeHtml(r.title)}</h3>` : "";
  const body = r.body || "";
  const TRANSLATION_MARKER = "──── 日本語訳 ────";
  const parts = body.split(TRANSLATION_MARKER);
  const original = (parts[0] || "").trim();
  const translation = (parts[1] || "").trim();
  let bodyHtml = original ? `<p class="astro-review-card__body">${newlineToBr(escapeHtml(original))}</p>` : "";
  if (translation) {
    bodyHtml += `<div class="astro-review-card__translation"><span class="astro-review-card__translation-badge">🇯🇵 日本語訳</span><p class="astro-review-card__translation-body">${newlineToBr(escapeHtml(translation))}</p></div>`;
  }
  let photosHtml = "";
  const photos = (r.photos || []).filter((p: any) => p && p.url);
  if (photos.length > 0) {
    photosHtml = `<div class="astro-review-card__photos">` + photos.map((p: any) => `<a href="${escapeHtml(p.url)}" target="_blank" rel="noopener"><img src="${escapeHtml(p.url)}" alt="${escapeHtml(r.title || "")}" loading="lazy"></a>`).join("") + `</div>`;
  }
  const author = r.reviewer_name ? escapeHtml(r.reviewer_name) : "匿名";
  let dateStr = "";
  if (r.posted_at) {
    const d = new Date(r.posted_at);
    if (isFinite(d.getTime())) dateStr = `${d.getFullYear()}年${d.getMonth()+1}月${d.getDate()}日`;
  }
  return `<article class="astro-review-card" itemscope itemtype="https://schema.org/Review"><meta itemprop="itemReviewed" content="${escapeHtml(productTitle)}"><div itemprop="reviewRating" itemscope itemtype="https://schema.org/Rating" style="display:inline"><meta itemprop="ratingValue" content="${rating}"><meta itemprop="bestRating" content="5"><div class="astro-review-card__stars">${stars}${badge}</div></div>${titleHtml}${bodyHtml}${photosHtml}<footer class="astro-review-card__footer"><span itemprop="author">— ${author}</span><time>${dateStr}</time></footer></article>`;
}

function computeAvgRating(reviews: any[]): { avg: string; avgRounded: number; sampleSize: number } {
  const count = reviews.length;
  if (count === 0) return { avg: "0.0", avgRounded: 0, sampleSize: 0 };
  const sampleSize = Math.min(50, count);
  let sumRating = 0;
  for (let i = 0; i < sampleSize; i++) sumRating += parseInt(reviews[i].rating || "0", 10);
  const avg = (Math.round(sumRating * 10 / sampleSize) / 10).toFixed(1);
  const avgRounded = Math.round(sumRating / sampleSize);
  return { avg, avgRounded, sampleSize };
}

function renderReviewsContainerHtml(reviews: any[], productTitle: string): string {
  if (reviews.length === 0) return "";
  const count = reviews.length;
  const { avg, avgRounded } = computeAvgRating(reviews);
  const avgStars = "★".repeat(avgRounded) + `<span style="color:#d1d5db">${"★".repeat(Math.max(0,5-avgRounded))}</span>`;
  const maxShow = 6;
  const cardsHtml = reviews.slice(0, maxShow).map(r => renderReviewCardHtml(r, productTitle)).join("");
  const moreHint = count > maxShow ? `<div class="astro-reviews__more-hint">残り ${count - maxShow} 件のレビュー (今後対応予定)</div>` : "";
  const STYLE = `<style>.astro-reviews{max-width:1100px;margin:48px auto;padding:0 16px;font-family:-apple-system,BlinkMacSystemFont,'Hiragino Sans',sans-serif}.astro-reviews__heading{font-size:24px;font-weight:700;color:#06060C;margin:0 0 4px}.astro-reviews__sub{font-size:11px;color:#9ca3af;letter-spacing:2px;margin:0 0 20px}.astro-reviews__summary{display:flex;gap:28px;align-items:center;padding:24px;background:#fafbfc;border-radius:12px;margin-bottom:24px;flex-wrap:wrap}.astro-reviews__avg-num{font-size:48px;font-weight:800;color:#06060C;line-height:1}.astro-reviews__avg-stars{color:#ffa500;font-size:22px;letter-spacing:2px}.astro-reviews__avg-count{font-size:18px;color:#06060C;margin-top:10px;font-weight:700}.astro-reviews__list{display:grid;grid-template-columns:1fr;gap:16px}@media (min-width:768px){.astro-reviews__list{grid-template-columns:1fr 1fr}}.astro-review-card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:20px 24px}.astro-review-card__stars{color:#ffa500;font-size:18px;letter-spacing:2px;margin-bottom:6px}.astro-review-card__badge{display:inline-block;font-size:11px;padding:2px 8px;border-radius:4px;margin-left:8px;vertical-align:2px}.astro-review-card__badge--verified{background:#ecfdf5;color:#059669;border:1px solid #d1fae5}.astro-review-card__badge--gift{background:#f0f9ff;color:#0284c7;border:1px solid #bae6fd}.astro-review-card__title{font-size:16px;font-weight:700;color:#111827;margin:4px 0 8px;line-height:1.4}.astro-review-card__body{font-size:14px;color:#374151;line-height:1.7;margin:0;white-space:pre-wrap}.astro-review-card__translation{margin-top:12px;padding-top:10px;border-top:1px dashed #cbd5e1}.astro-review-card__translation-badge{display:inline-block;padding:2px 8px;background:#eef2ff;color:#4338ca;border-radius:4px;font-size:11px;font-weight:700;margin-bottom:6px}.astro-review-card__translation-body{margin:0;font-size:13px;color:#6b7280;line-height:1.7;white-space:pre-wrap}.astro-review-card__photos{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:12px}.astro-review-card__photos img{width:100%;height:100px;object-fit:cover;border-radius:6px}.astro-review-card__footer{margin-top:16px;padding-top:12px;border-top:1px solid #f3f4f6;font-size:12px;color:#6b7280;display:flex;justify-content:space-between}.astro-reviews__more-hint{margin-top:16px;text-align:center;font-size:13px;color:#6b7280}</style>`;
  return `${STYLE}<section class="astro-reviews" aria-labelledby="astro-reviews-heading"><h2 id="astro-reviews-heading" class="astro-reviews__heading">商品レビュー</h2><p class="astro-reviews__sub">PRODUCT REVIEWS</p><div class="astro-reviews__summary"><div style="text-align:center;"><div class="astro-reviews__avg-num">${avg}</div><div class="astro-reviews__avg-stars">${avgStars}</div><div class="astro-reviews__avg-count">合計 ${count} 件のレビュー</div></div></div><div class="astro-reviews__list">${cardsHtml}</div>${moreHint}</section>`;
}

async function fetchProductApprovedReviewsForProduct(admin: any, productGid: string): Promise<any[]> {
  // v9: LIST_QUERY_LITE で Product reference resolution を回避 (1028件 fetch を高速化)
  // 既に LIST_QUERY_LITE には product_ref の value (GID 文字列) が含まれているので、
  // string 比較だけで対象 review を絞り込める。photos は metafield に書き込まないので省略 (現状仕様)。
  const approved: any[] = [];
  let cursor: string | null = null;
  let safety = 0;
  while (safety < 50) {
    const res: any = await admin.graphql(LIST_QUERY_LITE, { variables: { first: 250, after: cursor } });
    const json = await res.json();
    const edges = json.data?.metaobjects?.edges ?? [];
    for (const edge of edges) {
      const node = edge?.node;
      const fields = node?.fields ?? [];
      const fmap: Record<string,string> = {};
      for (const f of fields) fmap[f.key] = f.value;
      const status = fmap.status || "pending";
      const prodRefRaw = fmap.product_ref || "";
      if (status !== "approved") continue;
      if (prodRefRaw !== productGid) continue;
      approved.push({
        id: node.id,
        rating: fmap.rating || "5",
        title: fmap.title || "",
        body: fmap.body || "",
        reviewer_name: fmap.reviewer_name || "",
        source_type: fmap.source_type || "",
        posted_at: fmap.posted_at || "",
        photos: [],
      });
    }
    const pageInfo = json.data?.metaobjects?.pageInfo;
    if (!pageInfo?.hasNextPage) break;
    cursor = pageInfo.endCursor;
    safety++;
  }
  // posted_at 新しい順にソート
  approved.sort((a, b) => {
    const aT = a.posted_at ? new Date(a.posted_at).getTime() : 0;
    const bT = b.posted_at ? new Date(b.posted_at).getTime() : 0;
    return bT - aT;
  });
  return approved;
}

async function fetchProductTitle(admin: any, productGid: string): Promise<string> {
  try {
    const res: any = await admin.graphql(`query ProductTitle($id:ID!){product(id:$id){title}}`, { variables: { id: productGid } });
    const json = await res.json();
    return json?.data?.product?.title || "";
  } catch (e) {
    return "";
  }
}

// v8: 既存 metafield 取得用 query
const PRODUCT_REVIEWS_HTML_QUERY = `#graphql
  query GetReviewsHtml($id: ID!) {
    product(id: $id) {
      title
      metafield(namespace: "astromeda", key: "reviews_html") { value }
    }
  }
`;

// v10: approved_reviews 索引 metafield を読んで対象 review だけを nodes() で取得する高速版
// 1028件全件スキャンが不要になり、Vercel 60秒タイムアウトを回避できる
const PRODUCT_APPROVED_LIST_QUERY = `#graphql
  query GetApprovedList($id: ID!) {
    product(id: $id) {
      title
      reviewsHtml: metafield(namespace: "astromeda", key: "reviews_html") { value }
      approvedReviews: metafield(namespace: "astromeda", key: "approved_reviews") { value }
    }
  }
`;

const REVIEW_NODES_QUERY = `#graphql
  query GetReviewNodes($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Metaobject {
        id
        updatedAt
        fields { key value }
      }
    }
  }
`;

// v11: Product metafield ではなく Metaobject cache に保存
// (write_products scope なしでも write_metaobjects だけで完結)
// cache.handle = product handle で 1:1 紐付け
async function getProductApprovedList(admin: any, productGid: string): Promise<{ title: string; existingHtml: string; ids: string[]; cacheId: string | null }> {
  // product info
  let title = "";
  let productHandle = "";
  try {
    const pres: any = await admin.graphql(`query P($id: ID!) { product(id: $id) { title handle } }`, { variables: { id: productGid } });
    const pjson = await pres.json();
    title = pjson?.data?.product?.title || "";
    productHandle = pjson?.data?.product?.handle || "";
  } catch (e) { /* skip */ }
  if (!productHandle) return { title, existingHtml: "", ids: [], cacheId: null };
  // cache metaobject (handle = product.handle)
  let existingHtml = "";
  let ids: string[] = [];
  let cacheId: string | null = null;
  try {
    const cres: any = await admin.graphql(`query C($handle: MetaobjectHandleInput!) { metaobjectByHandle(handle: $handle) { id fields { key value } } }`, {
      variables: { handle: { type: "astromeda_product_reviews_cache", handle: productHandle } },
    });
    const cjson = await cres.json();
    const cache = cjson?.data?.metaobjectByHandle;
    if (cache) {
      cacheId = cache.id;
      for (const f of (cache.fields || [])) {
        if (f.key === "html") existingHtml = f.value || "";
        else if (f.key === "approved_review_ids") {
          try { const parsed = JSON.parse(f.value || "[]"); if (Array.isArray(parsed)) ids = parsed.filter((x: any) => typeof x === "string"); } catch (e) { /* skip */ }
        }
      }
    }
  } catch (e) { /* skip */ }
  return { title, existingHtml, ids, cacheId };
}

async function setCacheApprovedIds(admin: any, productGid: string, productHandle: string, ids: string[]): Promise<void> {
  const res: any = await admin.graphql(`mutation Upsert($handle: MetaobjectHandleInput!, $metaobject: MetaobjectUpsertInput!) { metaobjectUpsert(handle: $handle, metaobject: $metaobject) { metaobject { id } userErrors { field message code } } }`, {
    variables: {
      handle: { type: "astromeda_product_reviews_cache", handle: productHandle },
      metaobject: {
        fields: [
          { key: "product_ref", value: productGid },
          { key: "approved_review_ids", value: JSON.stringify(ids) },
        ],
      },
    },
  });
  const json = await res.json();
  const errs = json?.data?.metaobjectUpsert?.userErrors ?? [];
  if (errs.length > 0) {
    console.error("[SET-CACHE-IDS] userErrors", { productGid, errs });
  } else {
    console.log("[SET-CACHE-IDS] ok", { productGid, idsLen: ids.length });
  }
}

// 後方互換: 旧名 setProductApprovedList を新 helper にエイリアス
async function setProductApprovedList(admin: any, productGid: string, ids: string[]): Promise<void> {
  // need product handle - look it up
  try {
    const pres: any = await admin.graphql(`query P($id: ID!) { product(id: $id) { handle } }`, { variables: { id: productGid } });
    const pjson = await pres.json();
    const productHandle: string = pjson?.data?.product?.handle || "";
    if (productHandle) await setCacheApprovedIds(admin, productGid, productHandle, ids);
  } catch (e: any) { console.error("[SET-LIST→CACHE] FAIL", { productGid, error: e?.message }); }
}

async function addReviewToProductList(admin: any, productGid: string, reviewGid: string): Promise<string[]> {
  try {
    console.log("[ADD-LIST] enter (cache)", { productGid, reviewGid });
    const { ids } = await getProductApprovedList(admin, productGid);
    console.log("[ADD-LIST] current list", { productGid, currentLen: ids.length });
    if (!ids.includes(reviewGid)) ids.push(reviewGid);
    await setProductApprovedList(admin, productGid, ids);
    console.log("[ADD-LIST] written", { productGid, newLen: ids.length });
    return ids;
  } catch (e: any) {
    console.error("[ADD-LIST] FAIL", { productGid, reviewGid, error: e?.message ?? String(e) });
    throw e;
  }
}

async function removeReviewFromProductList(admin: any, productGid: string, reviewGid: string): Promise<string[]> {
  const { ids } = await getProductApprovedList(admin, productGid);
  const filtered = ids.filter((id) => id !== reviewGid);
  if (filtered.length !== ids.length) await setProductApprovedList(admin, productGid, filtered);
  return filtered;
}

async function fetchReviewsByIds(admin: any, ids: string[]): Promise<any[]> {
  if (ids.length === 0) return [];
  const r: any = await admin.graphql(REVIEW_NODES_QUERY, { variables: { ids } });
  const j = await r.json();
  const nodes: any[] = j?.data?.nodes ?? [];
  const reviews: any[] = [];
  for (const n of nodes) {
    if (!n || !n.id) continue;
    const fmap: Record<string, string> = {};
    for (const f of (n.fields || [])) fmap[f.key] = f.value;
    // approved 以外は skip (リストにあっても status が変わっている可能性)
    if (fmap.status !== "approved") continue;
    reviews.push({
      id: n.id,
      rating: fmap.rating || "5",
      title: fmap.title || "",
      body: fmap.body || "",
      reviewer_name: fmap.reviewer_name || "",
      source_type: fmap.source_type || "",
      posted_at: fmap.posted_at || "",
      photos: [],
    });
  }
  // posted_at 新しい順
  reviews.sort((a, b) => {
    const aT = a.posted_at ? new Date(a.posted_at).getTime() : 0;
    const bT = b.posted_at ? new Date(b.posted_at).getTime() : 0;
    return bT - aT;
  });
  return reviews;
}

// v11: Product metafield ではなく Metaobject `astromeda_product_reviews_cache` に保存
// → write_products scope 不要 (Embedded App の write_metaobjects scope だけで完結)
// cache の handle は product handle (例: keyboard-sanrio-characters-collaboration-kuromi)
const CACHE_BY_HANDLE_QUERY = `#graphql
  query GetCache($handle: MetaobjectHandleInput!) {
    metaobjectByHandle(handle: $handle) {
      id
      fields { key value }
    }
  }
`;

const PRODUCT_TITLE_HANDLE_QUERY = `#graphql
  query GetProductTitleHandle($id: ID!) {
    product(id: $id) {
      title
      handle
    }
  }
`;

const METAOBJECT_UPSERT_MUTATION = `#graphql
  mutation UpsertCache($handle: MetaobjectHandleInput!, $metaobject: MetaobjectUpsertInput!) {
    metaobjectUpsert(handle: $handle, metaobject: $metaobject) {
      metaobject { id handle }
      userErrors { field message code }
    }
  }
`;

async function regenerateProductReviewsHtml(admin: any, productGid: string): Promise<{ ok: boolean; count: number; skipped?: boolean; error?: string }> {
  try {
    console.log("[REGEN] enter", { productGid });
    if (!productGid || !productGid.startsWith("gid://shopify/Product/")) {
      console.error("[REGEN] invalid gid", { productGid });
      return { ok: false, count: 0, error: "invalid product gid" };
    }
    // 1. product info (title, handle) + 既存 approved_reviews 索引
    const { title: productTitle, ids } = await getProductApprovedList(admin, productGid);
    // product handle も必要 (cache の handle として使う)
    const pres: any = await admin.graphql(PRODUCT_TITLE_HANDLE_QUERY, { variables: { id: productGid } });
    const pjson = await pres.json();
    const productHandle: string = pjson?.data?.product?.handle || "";
    console.log("[REGEN] got product info", { productGid, productTitle, productHandle, idsLen: ids.length });
    if (!productHandle) { console.error("[REGEN] no handle", { productGid }); return { ok: false, count: 0, error: "no product handle" }; }
    // 2. 索引リストにある review ID だけ nodes() で取得
    const reviews = await fetchReviewsByIds(admin, ids);
    console.log("[REGEN] fetched reviews", { productGid, reviewsLen: reviews.length });
    // 3. リストにあるが status が approved でない (=stale) を filter で除外していたら、リストも掃除
    if (reviews.length !== ids.length) {
      const liveIds = reviews.map((r) => r.id);
      console.log("[REGEN] stale cleanup", { productGid, before: ids.length, after: liveIds.length });
      try { await setProductApprovedList(admin, productGid, liveIds); } catch (e: any) { console.error("[REGEN] stale cleanup FAIL", { error: e?.message }); }
    }
    // 4. HTML 描画 + 集計値計算 (Storefront 表示用)
    const html = renderReviewsContainerHtml(reviews, productTitle);
    const valueToWrite = html || "(no reviews)";
    const { avg: avgRatingStr } = computeAvgRating(reviews);
    console.log("[REGEN] html ready", { productGid, htmlLen: valueToWrite.length });
    // 5. Metaobject upsert (handle = product handle)
    const res: any = await admin.graphql(METAOBJECT_UPSERT_MUTATION, {
      variables: {
        handle: { type: "astromeda_product_reviews_cache", handle: productHandle },
        metaobject: {
          fields: [
            { key: "product_ref", value: productGid },
            { key: "html", value: valueToWrite },
            { key: "count", value: String(reviews.length) },
            { key: "avg_rating", value: avgRatingStr },
          ],
        },
      },
    });
    const json = await res.json();
    const errs = json?.data?.metaobjectUpsert?.userErrors ?? [];
    if (errs.length > 0) {
      console.error("[REGEN] metaobjectUpsert userErrors", { productGid, errs });
      return { ok: false, count: reviews.length, error: errs.map((e: any) => e.message).join(", ") };
    }
    const cacheId = json?.data?.metaobjectUpsert?.metaobject?.id;
    console.log("[REGEN] DONE (Metaobject cache)", { productGid, productHandle, cacheId, count: reviews.length, htmlLen: valueToWrite.length });
    return { ok: true, count: reviews.length, skipped: false };
  } catch (e: any) {
    console.error("[REGEN] CAUGHT", { productGid, error: e?.message ?? String(e), stack: e?.stack?.slice(0, 500) });
    return { ok: false, count: 0, error: e?.message ?? String(e) };
  }
}

// review GID から product_ref を引いて、その商品の HTML を再生成 (delete 時用)
async function regenerateForReview(admin: any, reviewGid: string): Promise<{ ok: boolean; productGid?: string }> {
  try {
    const r: any = await admin.graphql(`query R($id:ID!){metaobject(id:$id){fields{key value}}}`, { variables: { id: reviewGid } });
    const j = await r.json();
    const fields = j?.data?.metaobject?.fields ?? [];
    const prodRef = fields.find((f: any) => f.key === "product_ref")?.value;
    if (!prodRef) return { ok: false };
    const result = await regenerateProductReviewsHtml(admin, prodRef);
    return { ok: result.ok, productGid: prodRef };
  } catch (e) {
    return { ok: false };
  }
}

// ════════════════════════════════════════════════════════════
export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  // ─── intent: import_csv_resolve (client pre-step: resolve unique product handles to GIDs) ───
  // 修正(2026-05-17): handle ごとの serial GraphQL 呼び出しを aliased query で一括化。
  // 30 件の handle で 30 回 API 呼び出し→ Vercel 10s timeout になっていた問題を解消。
  if (intent === "import_csv_resolve") {
    let handles: string[] = [];
    try { handles = JSON.parse(String(formData.get("handles") || "[]")); } catch { handles = []; }
    if (!Array.isArray(handles)) return { ok: false, error: "handles が不正です", intent };

    const resolveStart = Date.now();
    const cleanHandles = handles.filter((h) => h && typeof h === "string");
    const handleToGid: Record<string, string> = {};
    const unresolved: string[] = [];

    // バッチサイズ 50 で aliased query を組む (1 クエリで 50 handle まで)
    const BATCH_SIZE = 50;
    for (let i = 0; i < cleanHandles.length; i += BATCH_SIZE) {
      const batch = cleanHandles.slice(i, i + BATCH_SIZE);
      const aliasedFields = batch
        .map((_h, idx) => `h${idx}: productByHandle(handle: $h${idx}) { id handle }`)
        .join("\n          ");
      const variableDefs = batch.map((_h, idx) => `$h${idx}: String!`).join(", ");
      const queryStr = `#graphql
        query ResolveHandles(${variableDefs}) {
          ${aliasedFields}
        }
      `;
      const variables: Record<string, string> = {};
      batch.forEach((h, idx) => { variables[`h${idx}`] = h; });
      try {
        const res = await admin.graphql(queryStr, { variables });
        const json = (await res.json()) as { data?: Record<string, { id?: string; handle?: string } | null>; errors?: any };
        if (json.errors) {
          return { ok: false, error: `Shopify GraphQL error: ${JSON.stringify(json.errors)}`, intent };
        }
        batch.forEach((h, idx) => {
          const node = json.data?.[`h${idx}`];
          if (node?.id) handleToGid[h] = node.id;
          else unresolved.push(h);
        });
      } catch (e: any) {
        return { ok: false, error: `resolve batch failed: ${e?.message ?? String(e)}`, intent };
      }
    }

    // ─── 既存 astromeda_review を全件取得して自然キー → GID マップを構築 ───
    // (CSV 再投入時の重複防止)
    const existingKeyToGid: Record<string, string> = {};
    let cursor: string | null = null;
    let existingFetchPages = 0;
    try {
      while (true) {
        const listRes: any = await admin.graphql(`#graphql
          query ListExistingReviews($cursor: String) {
            metaobjects(type: "astromeda_review", first: 250, after: $cursor) {
              edges {
                cursor
                node {
                  id
                  fields { key value }
                }
              }
              pageInfo { hasNextPage }
            }
          }
        `, { variables: { cursor } });
        const listJson: any = await listRes.json();
        const edges = listJson.data?.metaobjects?.edges ?? [];
        for (const edge of edges) {
          const fields: Record<string, string> = {};
          for (const f of (edge.node.fields || [])) fields[f.key] = f.value;
          const productRef = fields.product_ref || "";
          const reviewerEmail = fields.reviewer_email || "";
          const body = fields.body || "";
          const naturalKey = `${productRef}::${reviewerEmail}::${body.slice(0, 80)}`;
          existingKeyToGid[naturalKey] = edge.node.id;
          cursor = edge.cursor;
        }
        existingFetchPages++;
        const hasNext = listJson.data?.metaobjects?.pageInfo?.hasNextPage;
        if (!hasNext) break;
        if (existingFetchPages > 50) break; // safety cap
      }
    } catch (e: any) {
      // 既存取得失敗は警告のみ。fall back: 重複作成は許容
      console.warn("[import_csv_resolve] existing fetch failed:", e?.message);
    }

    const elapsed = Date.now() - resolveStart;
    return {
      ok: true,
      intent,
      handleToGid,
      unresolved,
      existingKeyToGid,
      _debug: {
        elapsedMs: elapsed,
        batchCount: Math.ceil(cleanHandles.length / 50),
        existingFetchPages,
        existingCount: Object.keys(existingKeyToGid).length,
      },
    };
  }

  // ─── intent: import_csv_chunk (process a small chunk of rows; client-side chunking) ───
  if (intent === "import_csv_chunk") {
    let headers: string[] = [];
    let rows: string[][] = [];
    let handleToGid: Record<string, string> = {};
    let existingKeyToGid: Record<string, string> = {};
    let rowOffset = 2;
    try {
      headers = JSON.parse(String(formData.get("headers") || "[]"));
      rows = JSON.parse(String(formData.get("rows") || "[]"));
      handleToGid = JSON.parse(String(formData.get("handleToGid") || "{}"));
      existingKeyToGid = JSON.parse(String(formData.get("existingKeyToGid") || "{}"));
      rowOffset = parseInt(String(formData.get("rowOffset") || "2"), 10) || 2;
    } catch (e: any) {
      return { ok: false, error: `chunk payload parse error: ${e?.message ?? String(e)}`, intent };
    }
    if (!Array.isArray(headers) || !Array.isArray(rows)) {
      return { ok: false, error: "headers / rows が配列ではありません", intent };
    }
    const headersLow = headers.map((h) => String(h).trim().toLowerCase());
    const idxOf = (k: string) => headersLow.indexOf(k);
    const requiredCols = ["product_handle", "rating", "body", "reviewer_name"];
    for (const c of requiredCols) {
      if (idxOf(c) === -1) return { ok: false, error: `必須列が不足しています: ${c}`, intent };
    }

    const results = { created: 0, updated: 0, errors: [] as Array<{ row: number; error: string }> };
    const chunkStart = Date.now();
    let lastRowLog = "";

    for (let r = 0; r < rows.length; r++) {
      const row = rows[r];
      if (!Array.isArray(row) || row.every((c) => !c || !String(c).trim())) continue;
      try {
        const get = (k: string) => (idxOf(k) >= 0 ? String(row[idxOf(k)] ?? "").trim() : "");
        const id = get("id");
        const handle = get("product_handle");
        const rating = parseInt(get("rating"), 10);
        const titleRaw = get("title");
        const body = get("body");
        const reviewer_name = get("reviewer_name");
        const reviewer_email = get("reviewer_email");
        let source_type = get("source_type") || "unverified";
        let status = get("status") || "pending";

        if (!handle) throw new Error("product_handle が空");
        const productGid = handleToGid[handle];
        if (!productGid) throw new Error(`商品が見つかりません: ${handle}`);
        if (!(rating >= 1 && rating <= 5)) throw new Error(`rating は 1-5: ${get("rating")}`);
        // title は任意 (空なら body の先頭から自動生成する)
        if (!body || body.length < 1) throw new Error("body が空");
        if (!reviewer_name) throw new Error("reviewer_name が空");
        const validSource = ["verified_purchase", "gift_recipient", "unverified"];
        if (!validSource.includes(source_type)) source_type = "unverified";
        const validStatus = ["pending", "approved", "rejected"];
        if (!validStatus.includes(status)) status = "pending";
        // posted_at (CSV由来の投稿日時): ISO 8601 のみ受理
        let posted_at = get("posted_at");
        if (posted_at) {
          const d = new Date(posted_at);
          posted_at = isFinite(d.getTime()) ? d.toISOString() : "";
        }

        const fields: Array<{ key: string; value: string }> = [
          { key: "product_ref", value: productGid },
          { key: "rating", value: String(rating) },
          { key: "title", value: (() => {
            if (titleRaw) return titleRaw.replace(/[\r\n]+/g, " ").trim().slice(0, 100);
            // 翻訳マーカーより前の部分を採用 (改行も除去)
            const _bodyForTitle = (body || "").split("──── 日本語訳 ────")[0];
            return _bodyForTitle.replace(/[\r\n]+/g, " ").trim().slice(0, 40);
          })() },
          { key: "body", value: body },
          { key: "reviewer_name", value: reviewer_name },
          { key: "reviewer_email", value: reviewer_email || `admin@${session.shop}` },
          { key: "source_type", value: source_type },
          { key: "status", value: status },
          ...(posted_at ? [{ key: "posted_at", value: posted_at }] : []),
        ];

        // 自然キーで既存レビュー検索 (id 列があれば優先、無効/空なら fallback)
        const naturalKey = `${productGid}::${reviewer_email || `admin@${session.shop}`}::${(body || "").slice(0, 80)}`;
        const idIsValid = id && id.startsWith("gid://shopify/Metaobject/");
        const matchedByKey = existingKeyToGid[naturalKey] || "";
        // 優先順位: 1) CSV の id 列 (Export → 編集 → 再 upload ワークフロー)
        //          2) 自然キー一致 (id 列空の手書き CSV ワークフロー)
        //          3) 新規作成
        const effectiveId = idIsValid ? id : matchedByKey;

        if (effectiveId) {
          const upRes = await admin.graphql(EDIT_REVIEW_MUTATION, { variables: { id: effectiveId, fields } });
          const upJson = (await upRes.json()) as { data?: { metaobjectUpdate?: { userErrors: Array<{ message: string }> } } };
          const errs = upJson.data?.metaobjectUpdate?.userErrors ?? [];
          if (errs.length) throw new Error(errs.map((e) => e.message).join(", "));
          results.updated++;
        } else {
          const fieldsForCreate = [...fields];
          if (status === "approved") {
            fieldsForCreate.push({ key: "approved_at", value: new Date().toISOString() });
            fieldsForCreate.push({ key: "approved_by", value: `${session.shop} (CSV import)` });
          }
          const crRes = await admin.graphql(CREATE_REVIEW_MUTATION, {
            variables: { metaobject: { type: "astromeda_review", fields: fieldsForCreate } },
          });
          const crJson = (await crRes.json()) as { data?: { metaobjectCreate?: { metaobject?: { id: string }; userErrors: Array<{ message: string }> } } };
          const errs = crJson.data?.metaobjectCreate?.userErrors ?? [];
          if (errs.length) throw new Error(errs.map((e) => e.message).join(", "));
          if (!crJson.data?.metaobjectCreate?.metaobject?.id) throw new Error("Metaobject 作成失敗");
          results.created++;
        }
      } catch (e: any) {
        lastRowLog = `row ${rowOffset + r}: ${e?.message ?? String(e)}`;
        results.errors.push({ row: rowOffset + r, error: e?.message ?? String(e) });
      }
    }

    const chunkElapsed = Date.now() - chunkStart;
    return { ok: true, intent, csvImport: results, _debug: { chunkElapsed, lastRowLog, rowsProcessed: rows.length } };
  }

  // ─── intent: import_csv (admin uploads CSV → bulk create/update) ───
  if (intent === "import_csv") {
    const fileField = formData.get("file");
    if (!fileField || typeof fileField !== "object" || !("size" in (fileField as any))) {
      return { ok: false, error: "CSV ファイルが添付されていません", intent };
    }
    const f = fileField as File;
    if (f.size > 5 * 1024 * 1024) return { ok: false, error: "CSV は 5MB 以下にしてください", intent };

    let text = await f.text();
    // strip BOM
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);

    // ─── RFC 4180 minimal parser ───
    type Row = string[];
    function parseCsv(input: string): Row[] {
      const rows: Row[] = [];
      let cur: Row = [];
      let field = "";
      let inQuotes = false;
      for (let i = 0; i < input.length; i++) {
        const c = input[i];
        if (inQuotes) {
          if (c === '"') {
            if (input[i + 1] === '"') { field += '"'; i++; }
            else { inQuotes = false; }
          } else { field += c; }
        } else {
          if (c === '"') { inQuotes = true; }
          else if (c === ",") { cur.push(field); field = ""; }
          else if (c === "\r") { /* skip */ }
          else if (c === "\n") { cur.push(field); rows.push(cur); cur = []; field = ""; }
          else { field += c; }
        }
      }
      if (field.length > 0 || cur.length > 0) { cur.push(field); rows.push(cur); }
      return rows.filter((r) => r.length > 1 || (r.length === 1 && r[0].trim() !== ""));
    }

    const rows = parseCsv(text);
    if (rows.length < 2) return { ok: false, error: "CSV にデータ行がありません (1行目はヘッダー)", intent };

    const headers = rows[0].map((h) => h.trim().toLowerCase());
    const idxOf = (k: string) => headers.indexOf(k);
    const requiredCols = ["product_handle", "rating", "body", "reviewer_name"];
    for (const c of requiredCols) {
      if (idxOf(c) === -1) return { ok: false, error: `必須列が不足しています: ${c}`, intent };
    }

    // Pre-fetch product handle → GID map (only for handles used in CSV)
    const handles = Array.from(new Set(rows.slice(1).map((r) => (r[idxOf("product_handle")] || "").trim()).filter(Boolean)));
    const handleToGid = new Map<string, string>();
    for (const h of handles) {
      const phRes = await admin.graphql(`#graphql
        query ProductByHandle($handle: String!) {
          productByHandle(handle: $handle) { id }
        }
      `, { variables: { handle: h } });
      const phJson = (await phRes.json()) as { data?: { productByHandle?: { id?: string } } };
      const gid = phJson.data?.productByHandle?.id;
      if (gid) handleToGid.set(h, gid);
    }

    const results = { created: 0, updated: 0, errors: [] as Array<{ row: number; error: string }> };

    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      if (row.every((c) => !c || !c.trim())) continue; // skip blank
      try {
        const get = (k: string) => (idxOf(k) >= 0 ? (row[idxOf(k)] || "").trim() : "");
        const id = get("id");
        const handle = get("product_handle");
        const rating = parseInt(get("rating"), 10);
        const titleRaw = get("title");
        const body = get("body");
        const reviewer_name = get("reviewer_name");
        const reviewer_email = get("reviewer_email");
        let source_type = get("source_type") || "unverified";
        let status = get("status") || "pending";

        if (!handle) throw new Error("product_handle が空");
        const productGid = handleToGid.get(handle);
        if (!productGid) throw new Error(`商品が見つかりません: ${handle}`);
        if (!(rating >= 1 && rating <= 5)) throw new Error(`rating は 1-5: ${get("rating")}`);
        // title は任意 (空なら body の先頭から自動生成する)
        if (!body || body.length < 1) throw new Error("body が空");
        if (!reviewer_name) throw new Error("reviewer_name が空");
        const validSource = ["verified_purchase", "gift_recipient", "unverified"];
        if (!validSource.includes(source_type)) source_type = "unverified";
        const validStatus = ["pending", "approved", "rejected"];
        if (!validStatus.includes(status)) status = "pending";
        // posted_at (CSV由来の投稿日時): ISO 8601 のみ受理
        let posted_at = get("posted_at");
        if (posted_at) {
          const d = new Date(posted_at);
          posted_at = isFinite(d.getTime()) ? d.toISOString() : "";
        }

        // 非日本語 body は DeepL で翻訳して併記
        let bodyForStore = body;
        if (!body.includes(TRANSLATION_MARKER_SERVER) && !isProbablyJapanese(body)) {
          const jaTrans = await translateToJapanese(body);
          if (jaTrans) bodyForStore = appendTranslation(body, jaTrans);
        }

        const fields: Array<{ key: string; value: string }> = [
          { key: "product_ref", value: productGid },
          { key: "rating", value: String(rating) },
          { key: "title", value: ((titleRaw || (bodyForStore || "").split("──── 日本語訳 ────")[0]) || "").replace(/[\r\n]+/g, " ").trim().slice(0, 100) || "(タイトルなし)" },
          { key: "body", value: bodyForStore },
          { key: "reviewer_name", value: reviewer_name },
          { key: "reviewer_email", value: reviewer_email || `admin@${session.shop}` },
          { key: "source_type", value: source_type },
          { key: "status", value: status },
          ...(posted_at ? [{ key: "posted_at", value: posted_at }] : []),
        ];

        if (id && id.startsWith("gid://shopify/Metaobject/")) {
          const upRes = await admin.graphql(EDIT_REVIEW_MUTATION, { variables: { id, fields } });
          const upJson = (await upRes.json()) as { data?: { metaobjectUpdate?: { userErrors: Array<{ message: string }> } } };
          const errs = upJson.data?.metaobjectUpdate?.userErrors ?? [];
          if (errs.length) throw new Error(errs.map((e) => e.message).join(", "));
          results.updated++;
        } else {
          const fieldsForCreate = [...fields];
          if (status === "approved") {
            fieldsForCreate.push({ key: "approved_at", value: new Date().toISOString() });
            fieldsForCreate.push({ key: "approved_by", value: `${session.shop} (CSV import)` });
          }
          const crRes = await admin.graphql(CREATE_REVIEW_MUTATION, {
            variables: { metaobject: { type: "astromeda_review", fields: fieldsForCreate } },
          });
          const crJson = (await crRes.json()) as { data?: { metaobjectCreate?: { metaobject?: { id: string }; userErrors: Array<{ message: string }> } } };
          const errs = crJson.data?.metaobjectCreate?.userErrors ?? [];
          if (errs.length) throw new Error(errs.map((e) => e.message).join(", "));
          if (!crJson.data?.metaobjectCreate?.metaobject?.id) throw new Error("Metaobject 作成失敗");
          results.created++;
        }
      } catch (e: any) {
        results.errors.push({ row: r + 1, error: e?.message ?? String(e) });
      }
    }

    await appendAuditLogSafe({
      admin, actor: session.shop, action: "review.import_csv",
      resource_id: "csv:" + (f.name || "upload"), resource_type: "astromeda_review",
      request, metadata: { created: results.created, updated: results.updated, errors: results.errors.length },
    });

    return { ok: true, intent, csvImport: results };
  }

  // ─── intent: fetch_detail (load token/order info for a review) ───
  if (intent === "fetch_detail") {
    const reviewId = String(formData.get("reviewId") || "");
    if (!reviewId.startsWith("gid://shopify/Metaobject/")) {
      return { ok: false, error: "review id が不正です", intent };
    }
    // Re-fetch review with refs
    const reviewRes = await admin.graphql(
      `#graphql
        query R($id: ID!) {
          metaobject(id: $id) {
            id handle updatedAt
            fields {
              key value
              reference {
                ... on Product {
                  id title handle
                  featuredImage { url altText }
                }
                ... on MediaImage {
                  id
                  image { url altText }
                }
              }
            }
          }
        }`,
      { variables: { id: reviewId } },
    );
    const rJson = (await reviewRes.json()) as {
      data?: { metaobject?: { id: string; handle: string; updatedAt: string; fields: Array<{ key: string; value: string; reference?: { id?: string; title?: string; handle?: string; featuredImage?: { url?: string; altText?: string }; image?: { url?: string; altText?: string } } | null }> } };
    };
    const rNode = rJson.data?.metaobject;
    if (!rNode) return { ok: false, error: "レビューが見つかりません", intent };
    const review = extractReview({ node: rNode });

    // fetch token if gift_recipient
    let gift_token: GiftTokenInfo | null = null;
    if (review.gift_token_id && review.gift_token_id.startsWith("gid://shopify/Metaobject/")) {
      try {
        const tRes = await admin.graphql(FETCH_TOKEN_QUERY, { variables: { id: review.gift_token_id } });
        const tJson = (await tRes.json()) as { data?: { metaobject?: { id: string; fields: Array<{ key: string; value: string }> } } };
        const tNode = tJson.data?.metaobject;
        if (tNode) {
          gift_token = {
            id: tNode.id,
            customer_name: fieldVal(tNode, "customer_name"),
            email: fieldVal(tNode, "email"),
            token_type: fieldVal(tNode, "token_type"),
            issued_by: fieldVal(tNode, "issued_by"),
            expires_at: fieldVal(tNode, "expires_at"),
            used_at: fieldVal(tNode, "used_at"),
            gift_note: fieldVal(tNode, "gift_note"),
          };
        }
      } catch (e) {
        console.error("[app.reviews/fetch_detail] token fetch failed", e);
      }
    }

    // fetch order if verified_purchase
    let order: OrderInfo | null = null;
    if (review.order_id && review.order_id.startsWith("gid://shopify/Order/")) {
      try {
        const oRes = await admin.graphql(FETCH_ORDER_QUERY, { variables: { id: review.order_id } });
        const oJson = (await oRes.json()) as { data?: { order?: { id: string; name: string; createdAt: string; customer?: { firstName?: string; lastName?: string; email?: string } } } };
        const oNode = oJson.data?.order;
        if (oNode) {
          const last = oNode.customer?.lastName ?? "";
          const first = oNode.customer?.firstName ?? "";
          order = {
            id: oNode.id,
            name: oNode.name,
            customer_name: `${last} ${first}`.trim(),
            email: oNode.customer?.email ?? "",
            created_at: oNode.createdAt,
          };
        }
      } catch (e) {
        console.error("[app.reviews/fetch_detail] order fetch failed", e);
      }
    }

    return { ok: true, intent, detail: { review, gift_token, order } };
  }

  // ─── intent: edit (admin edits existing review fields) ───
  if (intent === "quick_edit_body") {
    const reviewId = String(formData.get("reviewId") || "");
    const newBody = String(formData.get("body") || "").trim().slice(0, 1000);
    if (!reviewId.startsWith("gid://shopify/Metaobject/")) return { ok: false, error: "review id が不正です", intent };
    if (newBody.length < 1) return { ok: false, error: "本文が空です", intent };
    // title 再生成 (body の先頭から)
    const _bodyForTitle = newBody.split("──── 日本語訳 ────")[0];
    const newTitle = _bodyForTitle.replace(/[\r\n]+/g, " ").trim().slice(0, 100) || "(タイトルなし)";
    const fields = [
      { key: "body", value: newBody },
      { key: "title", value: newTitle },
    ];
    const r = await admin.graphql(EDIT_REVIEW_MUTATION, { variables: { id: reviewId, fields } });
    const j = (await r.json()) as { data?: { metaobjectUpdate?: { userErrors: Array<{ message: string }> } } };
    const errs = j.data?.metaobjectUpdate?.userErrors ?? [];
    if (errs.length > 0) return { ok: false, error: `保存失敗: ${errs.map((e) => e.message).join(", ")}`, intent };
    await appendAuditLogSafe({
      admin, actor: session.shop, action: "review.quick_edit_body",
      resource_id: reviewId, resource_type: "astromeda_review",
      request, metadata: { body_len: newBody.length },
    });
    // v7: 編集後に該当 product の reviews_html を再生成
    await regenerateForReview(admin, reviewId);
    return { ok: true, intent, edited: 1 };
  }

  // ─── intent: quick_edit_name (inline edit of reviewer_name) ───
  if (intent === "quick_edit_name") {
    const reviewId = String(formData.get("reviewId") || "");
    const newName = String(formData.get("reviewer_name") || "").trim().slice(0, 40);
    if (!reviewId.startsWith("gid://shopify/Metaobject/")) return { ok: false, error: "review id が不正です", intent };
    if (newName.length < 1) return { ok: false, error: "投稿者名が空です", intent };
    const r = await admin.graphql(EDIT_REVIEW_MUTATION, { variables: { id: reviewId, fields: [{ key: "reviewer_name", value: newName }] } });
    const j = (await r.json()) as { data?: { metaobjectUpdate?: { userErrors: Array<{ message: string }> } } };
    const errs = j.data?.metaobjectUpdate?.userErrors ?? [];
    if (errs.length > 0) return { ok: false, error: `保存失敗: ${errs.map((e) => e.message).join(", ")}`, intent };
    await appendAuditLogSafe({
      admin, actor: session.shop, action: "review.quick_edit_name",
      resource_id: reviewId, resource_type: "astromeda_review",
      request, metadata: { reviewer_name: newName },
    });
    await regenerateForReview(admin, reviewId);
    return { ok: true, intent, edited: 1 };
  }

    if (intent === "edit") {
    const reviewId = String(formData.get("reviewId") || "");
    if (!reviewId.startsWith("gid://shopify/Metaobject/")) {
      return { ok: false, error: "review id が不正です", intent };
    }
    const rating = Number(formData.get("rating") || 0);
    const title = String(formData.get("title") || "").trim().slice(0, 60);
    const body = String(formData.get("body") || "").trim().slice(0, 1000);
    const reviewer_name = String(formData.get("reviewer_name") || "").trim().slice(0, 40);
    const reviewer_email = String(formData.get("reviewer_email") || "").trim().slice(0, 200);

    if (rating < 1 || rating > 5) return { ok: false, error: "評価を 1〜5 で選択してください", intent };
    // title は任意 (空なら body 先頭から自動派生)
    if (body.length < 10) return { ok: false, error: "本文を 10 文字以上で入力してください", intent };
    if (!reviewer_name) return { ok: false, error: "表示名を入力してください", intent };

    const fields = [
      { key: "rating", value: String(rating) },
      { key: "title", value: ((titleRaw || (body || "").split("──── 日本語訳 ────")[0]) || "").replace(/[\r\n]+/g, " ").trim().slice(0, 100) || "(タイトルなし)" },
      { key: "body", value: body },
      { key: "reviewer_name", value: reviewer_name },
      { key: "reviewer_email", value: reviewer_email },
    ];
    const editRes = await admin.graphql(EDIT_REVIEW_MUTATION, {
      variables: { id: reviewId, fields },
    });
    const editJson = (await editRes.json()) as {
      data?: { metaobjectUpdate?: { userErrors: Array<{ field: string[]; message: string; code: string }> } };
    };
    const eErrs = editJson.data?.metaobjectUpdate?.userErrors ?? [];
    if (eErrs.length > 0) {
      console.log("[app.reviews/edit] userErrors", JSON.stringify(eErrs));
      return { ok: false, error: `保存失敗: ${eErrs.map((e) => e.message).join(", ")}`, intent };
    }
    await appendAuditLogSafe({
      admin, actor: session.shop, action: "review.edit",
      resource_id: reviewId, resource_type: "astromeda_review",
      request, metadata: { rating, title_len: title.length, body_len: body.length },
    });
    return { ok: true, intent, edited: 1 };
  }

  // ─── intent: add_photo (D&D file via stagedUploads OR URL paste → fileCreate → set photo_N) ───
  if (intent === "add_photo") {
    const reviewId = String(formData.get("reviewId") || "");
    const slot = Number(formData.get("slot") || 0);
    const url = String(formData.get("url") || "").trim();
    const fileField = formData.get("file");

    if (!reviewId.startsWith("gid://shopify/Metaobject/")) return { ok: false, error: "review id が不正です", intent };
    if (slot < 1 || slot > 6) return { ok: false, error: "slot は 1〜6 を指定してください", intent };

    let originalSource = "";

    if (fileField && typeof fileField === "object" && "size" in (fileField as any) && (fileField as File).size > 0) {
      const f = fileField as File;
      if (f.size > 10 * 1024 * 1024) {
        return { ok: false, error: "画像は 10 MB 以下にしてください", intent };
      }
      if (!/^image\//.test(f.type || "")) {
        return { ok: false, error: "画像ファイル (PNG / JPG / GIF / WebP) を選択してください", intent };
      }
      const stagedRes = await admin.graphql(STAGED_UPLOADS_CREATE_MUTATION, {
        variables: {
          input: [
            {
              filename: f.name || `review-${slot}.jpg`,
              mimeType: f.type || "image/jpeg",
              httpMethod: "POST",
              resource: "FILE",
              fileSize: String(f.size),
            },
          ],
        },
      });
      const stagedJson = (await stagedRes.json()) as {
        data?: { stagedUploadsCreate?: { stagedTargets?: Array<{ url: string; resourceUrl: string; parameters: Array<{ name: string; value: string }> }>; userErrors: Array<{ field: string[]; message: string }> } };
      };
      const sErrs = stagedJson.data?.stagedUploadsCreate?.userErrors ?? [];
      if (sErrs.length > 0) {
        console.log("[app.reviews/add_photo] stagedUploadsCreate userErrors", JSON.stringify(sErrs));
        return { ok: false, error: `staging 失敗: ${sErrs.map((e) => e.message).join(", ")}`, intent };
      }
      const target = stagedJson.data?.stagedUploadsCreate?.stagedTargets?.[0];
      if (!target) return { ok: false, error: "staging target が取得できませんでした", intent };
      const stagingFd = new FormData();
      for (const p of target.parameters) stagingFd.append(p.name, p.value);
      stagingFd.append("file", f, f.name || `review-${slot}.jpg`);
      const uploadRes = await fetch(target.url, { method: "POST", body: stagingFd as any });
      if (!uploadRes.ok) {
        const errText = await uploadRes.text().catch(() => "");
        console.log("[app.reviews/add_photo] staging upload failed", uploadRes.status, errText.slice(0, 500));
        return { ok: false, error: `画像アップロード失敗 (HTTP ${uploadRes.status})`, intent };
      }
      originalSource = target.resourceUrl;
    } else if (url) {
      if (!/^https?:\/\//.test(url)) return { ok: false, error: "有効な http(s):// URL を入力してください", intent };
      originalSource = url;
    } else {
      return { ok: false, error: "ファイルか URL のいずれかを指定してください", intent };
    }

    const fcRes = await admin.graphql(FILE_CREATE_MUTATION, {
      variables: {
        files: [
          {
            contentType: "IMAGE",
            originalSource,
            alt: `astromeda review photo ${slot}`,
          },
        ],
      },
    });
    const fcJson = (await fcRes.json()) as {
      data?: { fileCreate?: { files?: Array<{ id?: string }>; userErrors: Array<{ field: string[]; message: string; code: string }> } };
    };
    const fErrs = fcJson.data?.fileCreate?.userErrors ?? [];
    if (fErrs.length > 0) {
      console.log("[app.reviews/add_photo] fileCreate userErrors", JSON.stringify(fErrs));
      return { ok: false, error: `画像登録失敗: ${fErrs.map((e) => e.message).join(", ")}`, intent };
    }
    const fileId = fcJson.data?.fileCreate?.files?.[0]?.id;
    if (!fileId) return { ok: false, error: "画像登録失敗 (file id 取得不可)", intent };

    const upRes = await admin.graphql(EDIT_REVIEW_MUTATION, {
      variables: { id: reviewId, fields: [{ key: `photo_${slot}`, value: fileId }] },
    });
    const upJson = (await upRes.json()) as {
      data?: { metaobjectUpdate?: { userErrors: Array<{ field: string[]; message: string; code: string }> } };
    };
    const uErrs = upJson.data?.metaobjectUpdate?.userErrors ?? [];
    if (uErrs.length > 0) {
      console.log("[app.reviews/add_photo] update userErrors", JSON.stringify(uErrs));
      return { ok: false, error: `スロット保存失敗: ${uErrs.map((e) => e.message).join(", ")}`, intent };
    }
    await appendAuditLogSafe({
      admin, actor: session.shop, action: "review.add_photo",
      resource_id: reviewId, resource_type: "astromeda_review",
      request, metadata: { slot, file_id: fileId, source_url: url },
    });
    return { ok: true, intent, edited: 1 };
  }

  // ─── intent: remove_photo (clear photo_N field) ───
  if (intent === "remove_photo") {
    const reviewId = String(formData.get("reviewId") || "");
    const slot = Number(formData.get("slot") || 0);
    if (!reviewId.startsWith("gid://shopify/Metaobject/")) return { ok: false, error: "review id が不正です", intent };
    if (slot < 1 || slot > 6) return { ok: false, error: "slot は 1〜6 を指定してください", intent };

    // Clear by setting value to empty string (Shopify accepts this for file_reference clearing)
    const upRes = await admin.graphql(EDIT_REVIEW_MUTATION, {
      variables: { id: reviewId, fields: [{ key: `photo_${slot}`, value: "" }] },
    });
    const upJson = (await upRes.json()) as {
      data?: { metaobjectUpdate?: { userErrors: Array<{ field: string[]; message: string; code: string }> } };
    };
    const uErrs = upJson.data?.metaobjectUpdate?.userErrors ?? [];
    if (uErrs.length > 0) {
      console.log("[app.reviews/remove_photo] userErrors", JSON.stringify(uErrs));
      return { ok: false, error: `削除失敗: ${uErrs.map((e) => e.message).join(", ")}`, intent };
    }
    await appendAuditLogSafe({
      admin, actor: session.shop, action: "review.remove_photo",
      resource_id: reviewId, resource_type: "astromeda_review",
      request, metadata: { slot },
    });
    return { ok: true, intent, edited: 1 };
  }

  // ─── intent: create (admin-authored review) ───
  if (intent === "create") {
    const productId = String(formData.get("productId") || "").trim();
    const rating = Number(formData.get("rating") || 0);
    const title = String(formData.get("title") || "").trim().slice(0, 60);
    const body = String(formData.get("body") || "").trim().slice(0, 1000);
    const reviewer_name = String(formData.get("reviewer_name") || "").trim().slice(0, 40);
    const reviewer_email = String(formData.get("reviewer_email") || "").trim().slice(0, 200);

    if (!productId.startsWith("gid://shopify/Product/")) return { ok: false, error: "商品を選択してください", intent };
    if (rating < 1 || rating > 5) return { ok: false, error: "評価を 1〜5 で選択してください", intent };
    // title は任意 (空なら body 先頭から自動派生)
    if (body.length < 10) return { ok: false, error: "本文を 10 文字以上で入力してください", intent };
    if (!reviewer_name) return { ok: false, error: "表示名を入力してください", intent };

    const fields = [
      { key: "product_ref", value: productId },
      { key: "rating", value: String(rating) },
      { key: "title", value: ((titleRaw || (body || "").split("──── 日本語訳 ────")[0]) || "").replace(/[\r\n]+/g, " ").trim().slice(0, 100) || "(タイトルなし)" },
      { key: "body", value: body },
      { key: "reviewer_name", value: reviewer_name },
      { key: "reviewer_email", value: reviewer_email || `admin@${session.shop}` },
      { key: "source_type", value: "unverified" },
      { key: "status", value: "pending" },
      { key: "reply_text", value: "[admin_created] 管理画面から作成 by " + session.shop },
    ];

    const createRes = await admin.graphql(CREATE_REVIEW_MUTATION, {
      variables: { metaobject: { type: "astromeda_review", fields } },
    });
    const createJson = (await createRes.json()) as {
      data?: { metaobjectCreate?: { metaobject?: { id: string; handle: string }; userErrors: Array<{ field: string[]; message: string; code: string }> } };
    };
    const errs = createJson.data?.metaobjectCreate?.userErrors ?? [];
    if (errs.length > 0) {
      console.log("[app.reviews/action] create userErrors", JSON.stringify(errs));
      return { ok: false, error: `保存失敗: ${errs.map((e) => e.message).join(", ")}`, intent };
    }

    const newId = createJson.data?.metaobjectCreate?.metaobject?.id ?? null;
    await appendAuditLogSafe({
      admin,
      actor: session.shop,
      action: "review.admin_create",
      resource_id: newId ?? "(unknown)",
      resource_type: "astromeda_review",
      request,
      metadata: { rating, title, productId, source: "admin_ui" },
    });

    return { ok: true, created: 1, new_id: newId, intent };
  }

  // ─── intent: bulk_delete_by_status (status 全件削除) ───
  if (intent === "bulk_delete_by_status") {
    const targetStatus = (formData.get("status") as string) || "pending";
    if (!["pending", "approved", "rejected"].includes(targetStatus)) {
      return { ok: false, error: "invalid status", intent };
    }
    // 全件取得 → status filter
    const targetIds: string[] = [];
    let cursor: string | null = null;
    let safety = 0;
    while (safety < 50) {
      const res: any = await admin.graphql(LIST_QUERY, {
        variables: { first: 250, after: cursor },
      });
      const json = await res.json();
      const edges = json.data?.metaobjects?.edges ?? [];
      for (const edge of edges) {
        const node = edge?.node;
        const statusField = node?.fields?.find((f: any) => f?.key === "status");
        const status = statusField?.value || "pending";
        if (status === targetStatus) targetIds.push(node.id);
      }
      const pageInfo = json.data?.metaobjects?.pageInfo;
      if (!pageInfo?.hasNextPage) break;
      cursor = pageInfo.endCursor;
      safety++;
    }
    if (targetIds.length === 0) {
      return { ok: true, deleted: 0, failed: 0, intent, message: `削除対象 ${targetStatus} は 0 件でした` };
    }
    // バッチで削除 (10件ずつ並列)
    let deleted = 0, failed = 0;
    const errs: any[] = [];
    const BATCH = 10;
    for (let i = 0; i < targetIds.length; i += BATCH) {
      const slice = targetIds.slice(i, i + BATCH);
      const results = await Promise.all(slice.map(async (id) => {
        try {
          const res = await admin.graphql(DELETE_REVIEW_MUTATION, { variables: { id } });
          const json = (await res.json()) as any;
          const eList = json?.data?.metaobjectDelete?.userErrors ?? [];
          if (eList.length > 0) return { id, ok: false, error: eList.map((e: any) => e.message).join(", ") };
          return { id, ok: true };
        } catch (e: any) {
          return { id, ok: false, error: e?.message ?? String(e) };
        }
      }));
      for (const r of results) {
        if (r.ok) deleted++; else { failed++; errs.push(r); }
      }
    }
    await appendAuditLogSafe({
      admin,
      actor: session.shop,
      action: "review.bulk_delete_by_status",
      resource_id: "(bulk)",
      resource_type: "astromeda_review",
      request,
      metadata: { status: targetStatus, deleted, failed, total: targetIds.length },
    });
    return { ok: failed === 0, deleted, failed, intent, errors: errs.slice(0, 20) };
  }

  // ─── intent: delete (個別 / 一括 両対応) ───
  if (intent === "delete") {
    const idsRaw = formData.get("ids") as string | null;
    const ids = idsRaw ? idsRaw.split(",").filter(Boolean) : [];
    if (ids.length === 0) {
      return { ok: false, error: "削除する ID が指定されていません", intent };
    }
    const results = await Promise.all(
      ids.map(async (id) => {
        try {
          const res = await admin.graphql(DELETE_REVIEW_MUTATION, { variables: { id } });
          const json = (await res.json()) as { data?: { metaobjectDelete?: { deletedId?: string; userErrors: Array<{ message: string }> } } };
          const errs = json.data?.metaobjectDelete?.userErrors ?? [];
          if (errs.length > 0) {
            return { id, ok: false, error: errs.map((e) => e.message).join(", ") };
          }
          // 監査ログに記録
          await appendAuditLogSafe({
            admin,
            actor: session.shop,
            action: "review.delete",
            resource_id: id,
            resource_type: "astromeda_review",
            request,
            metadata: { batch_size: ids.length },
          });
          return { id, ok: true };
        } catch (e: any) {
          return { id, ok: false, error: e?.message ?? String(e) };
        }
      }),
    );
    return {
      ok: results.every((r) => r.ok),
      deleted: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      intent,
      errors: results.filter((r) => !r.ok).map((r) => ({ id: r.id, error: r.error })),
    };
  }

  // ─── intent: backfill_reviews_html (全商品の reviews_html を再生成) ───
  if (intent === "backfill_reviews_html") {
    // 全 approved review を fetch → product_ref で group → 各 product 再生成
    const productGroups = new Map<string, number>();
    let cursor: string | null = null;
    let safety = 0;
    while (safety < 50) {
      const res: any = await admin.graphql(LIST_QUERY, { variables: { first: 250, after: cursor } });
      const json = await res.json();
      const edges = json.data?.metaobjects?.edges ?? [];
      for (const edge of edges) {
        const fields = edge?.node?.fields ?? [];
        const status = fields.find((f: any) => f.key === "status")?.value || "pending";
        if (status !== "approved") continue;
        const prodRef = fields.find((f: any) => f.key === "product_ref")?.value;
        if (prodRef) productGroups.set(prodRef, (productGroups.get(prodRef) || 0) + 1);
      }
      const pageInfo = json.data?.metaobjects?.pageInfo;
      if (!pageInfo?.hasNextPage) break;
      cursor = pageInfo.endCursor;
      safety++;
    }
    let synced = 0, failed = 0;
    const errors: any[] = [];
    const productGids = [...productGroups.keys()];
    const BATCH = 5;
    for (let i = 0; i < productGids.length; i += BATCH) {
      const slice = productGids.slice(i, i + BATCH);
      const results = await Promise.all(slice.map(pg => regenerateProductReviewsHtml(admin, pg)));
      for (const r of results) {
        if (r.ok) synced++; else { failed++; errors.push(r.error); }
      }
    }
    await appendAuditLogSafe({
      admin, actor: session.shop, action: "review.backfill_reviews_html",
      resource_id: "(bulk)", resource_type: "astromeda_review",
      request, metadata: { products: productGids.length, synced, failed, total_approved_reviews: [...productGroups.values()].reduce((a,b)=>a+b,0) },
    });
    return { ok: failed === 0, intent, products: productGids.length, synced, failed, errors: errors.slice(0, 10) };
  }

  // ─── intent: approve / reject ───
  const idsRaw = formData.get("ids") as string | null;
  const ids = idsRaw ? idsRaw.split(",") : [];

  if (!intent || ids.length === 0) {
    return { ok: false, error: "intent or ids missing", intent };
  }

  const targetStatus = intent === "approve" ? "approved" : intent === "reject" ? "rejected" : null;
  if (!targetStatus) return { ok: false, error: "invalid intent", intent };

  const nowIso = new Date().toISOString();
  const updates = await Promise.all(
    ids.map(async (id) => {
      const fields = [
        { key: "status", value: targetStatus },
        ...(targetStatus === "approved"
          ? [
              { key: "approved_at", value: nowIso },
              { key: "approved_by", value: session.shop },
            ]
          : []),
      ];
      const res = await admin.graphql(UPDATE_STATUS_MUTATION, { variables: { id, fields } });
      const json = (await res.json()) as {
        data?: { metaobjectUpdate?: { userErrors: Array<{ field: string[]; message: string }> } };
      };
      const errs = json.data?.metaobjectUpdate?.userErrors ?? [];
      await appendAuditLogSafe({
        admin,
        actor: session.shop,
        action: intent === "approve" ? "review.approve" : "review.reject",
        resource_id: id,
        resource_type: "astromeda_review",
        request,
        metadata: { batch_size: ids.length, errors: errs },
      });
      return { id, ok: errs.length === 0, errors: errs };
    }),
  );

  // v10: approve/reject 時に approved_reviews 索引リストを incremental 更新 → 高速 regenerate
  console.log("[ACTION] start maintenance phase", { intent, idsLen: ids.length });
  // 1. review ごとに product_ref を取得
  const reviewProductMap = new Map<string, string>();
  for (const id of ids) {
    try {
      const r: any = await admin.graphql(`query R($id:ID!){metaobject(id:$id){fields{key value}}}`, { variables: { id } });
      const j = await r.json();
      const fields = j?.data?.metaobject?.fields ?? [];
      const prodRef = fields.find((f: any) => f.key === "product_ref")?.value;
      if (prodRef) reviewProductMap.set(id, prodRef);
    } catch (e: any) { console.error("[ACTION] fetch product_ref FAIL", { reviewId: id, error: e?.message ?? String(e) }); }
  }
  console.log("[ACTION] product_ref map built", { mapSize: reviewProductMap.size });
  // 2. approve なら list に追加 / reject なら list から削除
  const productGids = new Set<string>();
  for (const [reviewId, productGid] of reviewProductMap.entries()) {
    productGids.add(productGid);
    try {
      if (intent === "approve") {
        await addReviewToProductList(admin, productGid, reviewId);
      } else if (intent === "reject") {
        await removeReviewFromProductList(admin, productGid, reviewId);
      }
    } catch (e: any) { console.error("[ACTION] list maintenance FAIL", { intent, productGid, reviewId, error: e?.message ?? String(e) }); }
  }
  // 3. 対象 product の HTML を再生成 (索引リスト経由で高速)
  for (const productGid of productGids) {
    const result = await regenerateProductReviewsHtml(admin, productGid);
    if (!result.ok) console.error("[ACTION] regenerate FAIL", { productGid, result });
    else console.log("[ACTION] regenerate result", { productGid, ok: result.ok, count: result.count, skipped: result.skipped });
  }
  // 4. Phase 2.4: approve 時にクーポン自動発行 + サンクスメール送信
  let couponsIssued = 0;
  let couponsFailed = 0;
  if (intent === "approve") {
    console.log("[ACTION] coupon issuance phase start", { reviewIds: ids.length });
    for (const reviewId of ids) {
      try {
        const cres = await issueCouponForReview(admin, reviewId);
        if (cres.ok) {
          couponsIssued++;
          console.log("[ACTION] coupon issued", { reviewId, code: cres.code, emailSent: cres.emailSent, shopifyDiscount: !!cres.shopifyDiscountId });
        } else if (cres.skipped) {
          console.log("[ACTION] coupon skipped", { reviewId, reason: cres.skipped });
        } else {
          couponsFailed++;
          console.error("[ACTION] coupon issue FAIL", { reviewId, error: cres.error });
        }
      } catch (e: any) {
        couponsFailed++;
        console.error("[ACTION] coupon issue EXCEPTION", { reviewId, error: e?.message });
      }
    }
    console.log("[ACTION] coupon issuance phase complete", { issued: couponsIssued, failed: couponsFailed });
  }
  console.log("[ACTION] maintenance phase complete", { productsProcessed: productGids.size, couponsIssued, couponsFailed });

  return {
    ok: updates.every((u) => u.ok),
    updated: updates.filter((u) => u.ok).length,
    failed: updates.filter((u) => !u.ok).length,
    intent,
    synced_products: productGids.size,
    coupons_issued: couponsIssued,
    coupons_failed: couponsFailed,
  };
};

// 翻訳 split helper
const TRANSLATION_MARKER = "──── 日本語訳 ────";
function splitTranslation(body) {
  if (!body || !body.includes(TRANSLATION_MARKER)) {
    return { original: body || "", translation: null };
  }
  const idx = body.indexOf(TRANSLATION_MARKER);
  return {
    original: body.slice(0, idx).trim(),
    translation: body.slice(idx + TRANSLATION_MARKER.length).trim() || null,
  };
}

// ─────────────────────────────────────────────
// Storefront preview card (matches typical Astromeda review card styling)
// ─────────────────────────────────────────────
function ReviewStorefrontPreview({ review, productImage, productTitle }: { review: ReviewItem; productImage?: string | null; productTitle?: string }) {
  const dateText = new Date(review.posted_at || review.created_at).toLocaleDateString("ja-JP", {
    year: "numeric", month: "long", day: "numeric",
  });

  return (
    <div
      style={{
        background: "#ffffff",
        border: "1px solid #e5e7eb",
        borderRadius: 12,
        padding: "20px 24px",
        maxWidth: 640,
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Hiragino Sans', sans-serif",
      }}
    >
      {(productImage || productTitle) ? (
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 12px", background: "#f9fafb", borderRadius: 8, marginBottom: 12 }}>
          {productImage ? (
            <img src={productImage} alt={productTitle || ""} style={{ width: 64, height: 64, objectFit: "cover", borderRadius: 6, border: "1px solid #e5e7eb" }} />
          ) : null}
          <div style={{ fontSize: 13, fontWeight: 600, color: "#374151", lineHeight: 1.4 }}>{productTitle || ""}</div>
        </div>
      ) : null}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <span style={{ color: "#0d9488", fontSize: 22, letterSpacing: 2 }}>
          {"★".repeat(review.rating)}
          <span style={{ color: "#d1d5db" }}>{"★".repeat(Math.max(0, 5 - review.rating))}</span>
        </span>
        {review.source_type === "verified_purchase" ? (
          <span style={{ fontSize: 11, color: "#059669", border: "1px solid #d1fae5", background: "#ecfdf5", padding: "2px 6px", borderRadius: 4 }}>✓ 認証購入</span>
        ) : review.source_type === "gift_recipient" ? (
          <span style={{ fontSize: 11, color: "#0284c7", border: "1px solid #bae6fd", background: "#f0f9ff", padding: "2px 6px", borderRadius: 4 }}>🎁 ギフト受領</span>
        ) : (
          <span style={{ fontSize: 11, color: "#6b7280", border: "1px solid #e5e7eb", background: "#f9fafb", padding: "2px 6px", borderRadius: 4 }}>未認証</span>
        )}
      </div>
      <h3 style={{ margin: "4px 0 8px", fontSize: 17, fontWeight: 700, color: "#111827", lineHeight: 1.4 }}>
        
      </h3>
      {(() => {
        const { original, translation } = splitTranslation(review.body);
        return (
          <>
            <p style={{ margin: 0, fontSize: 14, color: "#374151", lineHeight: 1.8, whiteSpace: "pre-wrap" }}>
              {original}
            </p>
            {translation ? (
              <div style={{ marginTop: 10, paddingTop: 8, borderTop: "1px dashed #cbd5e1" }}>
                <span style={{ display: "inline-block", padding: "2px 8px", background: "#eef2ff", color: "#4338ca", borderRadius: 4, fontSize: 11, fontWeight: 700, marginBottom: 6 }}>🇯🇵 日本語訳</span>
                <p style={{ margin: 0, fontSize: 13, color: "#6b7280", lineHeight: 1.7, whiteSpace: "pre-wrap" }}>{translation}</p>
              </div>
            ) : null}
          </>
        );
      })()}
      <div style={{ marginTop: 16, paddingTop: 12, borderTop: "1px solid #f3f4f6", fontSize: 12, color: "#6b7280", display: "flex", justifyContent: "space-between" }}>
        <span>— {review.reviewer_name || "匿名"}</span>
        <span>{dateText}</span>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// Main component
// ─────────────────────────────────────────────
export default function ReviewsTab() {
  const { tab, reviews, pageInfo, shop, pagination, tabCounts, sort, partialData } = useLoaderData<typeof loader>() as any;

  // pagination bar inline JSX (上段+下段で使い回し)
  // この変数は ReviewsTab 内で定義する必要がある (pagination が scope に入っているため)
  const fetcher = useFetcher<ActionResult>();
  const importFetcher = useFetcher<any>();
  // fetcher.submit の Promise wrap (CSV import で使う)
  // useFetcher の state を監視して完了を待つ
  const importFetcherRef = useRef(importFetcher);
  useEffect(() => { importFetcherRef.current = importFetcher; }, [importFetcher]);
  const detailFetcher = useFetcher<ActionResult>();
  const [, setSearchParams] = useSearchParams();

  // pagination bar inline JSX
  const paginationBar = pagination.totalCount > 0 ? (
    <Card>
      <InlineStack align="space-between" blockAlign="center" gap="400">
        <div style={{ fontSize: 14, color: "#374151", lineHeight: 1.4 }}>
          全 <strong style={{ fontSize: 16, color: "#111827" }}>{pagination.totalCount}</strong> 件中{" "}
          <strong style={{ fontSize: 16, color: "#111827" }}>
            {(pagination.currentPage - 1) * pagination.pageSize + 1}
            {" - "}
            {Math.min(pagination.currentPage * pagination.pageSize, pagination.totalCount)}
          </strong>
          {" 件を表示中"}
          {pagination.totalPages > 1 ? (
            <span style={{ marginLeft: 12, padding: "3px 10px", background: "#f3f4f6", borderRadius: 6, fontWeight: 600 }}>
              ページ {pagination.currentPage} / {pagination.totalPages}
            </span>
          ) : null}
        </div>
        {pagination.totalPages > 1 ? (
          <InlineStack gap="200">
            <Button
              disabled={!(pagination.currentPage > 1)}
              onClick={() => {
                const prev = pagination.currentPage - 1;
                if (prev <= 1) {
                  setSearchParams({ tab });
                } else {
                  setSearchParams({ tab, page: String(prev) });
                }
              }}
            >
              ← 前のページ
            </Button>
            <Button
              variant="primary"
              disabled={!(pagination.currentPage < pagination.totalPages)}
              onClick={() => {
                const next = pagination.currentPage + 1;
                setSearchParams({ tab, page: String(next) });
              }}
            >
              次のページ →
            </Button>
          </InlineStack>
        ) : null}
      </InlineStack>
    </Card>
  ) : null;

  const handleTabChange = useCallback(
    (idx: number) => {
      const order: ReviewStatus[] = ["pending", "approved", "rejected"];
      setSearchParams({ tab: order[idx] });
    },
    [setSearchParams],
  );

  const tabIndex = useMemo(() => ["pending", "approved", "rejected"].indexOf(tab), [tab]);

  const resourceName = { singular: "レビュー", plural: "レビュー" };
  const { selectedResources, allResourcesSelected, handleSelectionChange } = useIndexResourceState(
    reviews.map((r) => ({ id: r.id })),
  );

  const bulkSubmit = (intent: "approve" | "reject" | "delete") => {
    if (selectedResources.length === 0) return;
    if (intent === "delete") {
      // 削除は確認必須
      const ok = window.confirm(`選択した ${selectedResources.length} 件のレビューを完全に削除します。この操作は元に戻せません。本当に削除しますか？`);
      if (!ok) return;
    }
    const fd = new FormData();
    fd.set("intent", intent);
    fd.set("ids", selectedResources.join(","));
    fetcher.submit(fd, { method: "post" });
  };

  const deleteSingle = (id: string, title: string) => {
    const label = title?.trim() || "(タイトルなし)";
    const ok = window.confirm(`「${label}」を完全に削除します。この操作は元に戻せません。本当に削除しますか？`);
    if (!ok) return;
    const fd = new FormData();
    fd.set("intent", "delete");
    fd.set("ids", id);
    fetcher.submit(fd, { method: "post" });
  };

  // 行から直接ステータス変更
  const changeStatusSingle = (id: string, newStatus: "approve" | "reject", e?: React.MouseEvent) => {
    // 行クリック (詳細モーダル) を抑制
    if (e) {
      e.stopPropagation();
      e.preventDefault();
    }
    const fd = new FormData();
    fd.set("intent", newStatus);
    fd.set("ids", id);
    fetcher.submit(fd, { method: "post" });
  };

  // ─── Admin-create modal state ───
  const shopify = useAppBridge();
  const [createOpen, setCreateOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [pickedProduct, setPickedProduct] = useState<{ id: string; title: string; image?: string | null } | null>(null);
  const [formRating, setFormRating] = useState("5");
  const [formTitle, setFormTitle] = useState("");
  const [formBody, setFormBody] = useState("");
  const [formName, setFormName] = useState("ASTROMEDA 編集部");
  const [formEmail, setFormEmail] = useState("");

  const [importProgress, setImportProgress] = useState<{
    total: number;
    processed: number;
    created: number;
    updated: number;
    errors: Array<{ row: number; error: string }>;
    status: "idle" | "resolving" | "importing" | "done" | "error" | "cancelled";
    message: string;
  } | null>(null);
  const importAbortRef = useRef<AbortController | null>(null);

  const openImport = useCallback(() => {
    setImportFile(null);
    setImportProgress(null);
    setImportOpen(true);
  }, []);

  const cancelImport = useCallback(() => {
    importAbortRef.current?.abort();
  }, []);

  const submitImport = useCallback(async () => {
    if (!importFile) return;
    const abort = new AbortController();
    importAbortRef.current = abort;

    setImportProgress({
      total: 0, processed: 0, created: 0, updated: 0, errors: [],
      status: "resolving", message: "CSV を解析中...",
    });

    try {
      // ─── parse CSV in browser (RFC 4180 minimal) ───
      let text = await importFile.text();
      if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
      type Row = string[];
      const parseCsv = (input: string): Row[] => {
        const rows: Row[] = [];
        let cur: Row = [];
        let field = "";
        let inQuotes = false;
        for (let i = 0; i < input.length; i++) {
          const c = input[i];
          if (inQuotes) {
            if (c === '"') { if (input[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; } }
            else { field += c; }
          } else {
            if (c === '"') { inQuotes = true; }
            else if (c === ",") { cur.push(field); field = ""; }
            else if (c === "\r") { /* skip */ }
            else if (c === "\n") { cur.push(field); rows.push(cur); cur = []; field = ""; }
            else { field += c; }
          }
        }
        if (field.length > 0 || cur.length > 0) { cur.push(field); rows.push(cur); }
        return rows.filter((r) => r.length > 1 || (r.length === 1 && r[0].trim() !== ""));
      };
      const all = parseCsv(text);
      console.log("[CSV-IMPORT-DEBUG-DEPLOY-V3] parseCsv done, rows:", all.length);
      if (all.length < 2) throw new Error("CSV にデータ行がありません (1行目はヘッダー)");
      const headers = all[0].map((h) => String(h).trim());
      const headersLow = headers.map((h) => h.toLowerCase());
      const idxHandle = headersLow.indexOf("product_handle");
      if (idxHandle === -1) throw new Error("必須列 product_handle が見つかりません");
      const dataRows = all.slice(1).filter((r) => r.some((c) => c && String(c).trim()));
      if (dataRows.length === 0) throw new Error("データ行がありません");

      // Promise-wrapped fetcher.submit (auth が自動で通る正規パス)
      const submitAndAwait = (formData: FormData): Promise<any> => new Promise((resolve, reject) => {
        const checkInterval = 50;
        const maxWait = 90000; // 90s max per call
        const startTime = Date.now();
        let lastState = importFetcherRef.current.state;
        let stateSeenLoading = lastState !== "idle";
        importFetcherRef.current.submit(formData, { method: "post" });
        // initial state may still be idle; poll for transition
        const tick = () => {
          if (abort.signal.aborted) return reject(new Error("AbortError"));
          const f = importFetcherRef.current;
          if (Date.now() - startTime > maxWait) return reject(new Error("submitAndAwait timeout"));
          if (f.state !== "idle") stateSeenLoading = true;
          if (stateSeenLoading && f.state === "idle") {
            if (f.data !== undefined) resolve(f.data);
            else resolve({ ok: false, error: "(no data)" });
            return;
          }
          setTimeout(tick, checkInterval);
        };
        setTimeout(tick, checkInterval);
      });

      // ─── resolve unique handles → GIDs ───
      const uniqueHandles = Array.from(new Set(dataRows.map((r) => String(r[idxHandle] || "").trim()).filter(Boolean)));
      setImportProgress((p) => ({ ...(p!), message: `商品 ID を解決中... (${uniqueHandles.length} 件)` }));
      const resolveFd = new FormData();
      resolveFd.set("intent", "import_csv_resolve");
      resolveFd.set("handles", JSON.stringify(uniqueHandles));
      // fetcher.submit を使う (Remix が auth を自動で付ける)
      const resolveJson = await submitAndAwait(resolveFd);
      if (!resolveJson?.ok) throw new Error(resolveJson?.error || "商品 ID 解決失敗");
      const handleToGid: Record<string, string> = resolveJson.handleToGid || {};
      const unresolved: string[] = resolveJson.unresolved || [];
      const existingKeyToGid: Record<string, string> = resolveJson.existingKeyToGid || {};
      if (unresolved.length > 0 && Object.keys(handleToGid).length === 0) {
        throw new Error(`いずれの商品も解決できませんでした: ${unresolved.slice(0, 5).join(", ")}`);
      }

      // ─── chunk rows (10 per chunk; サーバ並列化と組み合わせて Vercel timeout 回避) ───
      const CHUNK = 10;
      const chunks: string[][][] = [];
      for (let i = 0; i < dataRows.length; i += CHUNK) chunks.push(dataRows.slice(i, i + CHUNK));

      setImportProgress({
        total: dataRows.length, processed: 0, created: 0, updated: 0, errors: [],
        status: "importing",
        message: `0 / ${dataRows.length} 行を処理中... (チャンク 1/${chunks.length})`,
      });

      let aggCreated = 0;
      let aggUpdated = 0;
      const aggErrors: Array<{ row: number; error: string }> = [];
      let processed = 0;

      for (let c = 0; c < chunks.length; c++) {
        if (abort.signal.aborted) {
          setImportProgress((p) => ({ ...(p!), status: "cancelled", message: "中止しました" }));
          return;
        }
        const chunkFd = new FormData();
        chunkFd.set("intent", "import_csv_chunk");
        chunkFd.set("headers", JSON.stringify(headers));
        chunkFd.set("rows", JSON.stringify(chunks[c]));
        chunkFd.set("handleToGid", JSON.stringify(handleToGid));
        chunkFd.set("existingKeyToGid", JSON.stringify(existingKeyToGid));
        chunkFd.set("rowOffset", String(processed + 2));
        const chunkJson = await submitAndAwait(chunkFd);
        if (!chunkJson?.ok) throw new Error(chunkJson?.error || `チャンク ${c + 1}/${chunks.length} 失敗`);
        aggCreated += chunkJson.csvImport?.created || 0;
        aggUpdated += chunkJson.csvImport?.updated || 0;
        if (Array.isArray(chunkJson.csvImport?.errors)) aggErrors.push(...chunkJson.csvImport.errors);
        processed += chunks[c].length;
        setImportProgress({
          total: dataRows.length, processed, created: aggCreated, updated: aggUpdated,
          errors: aggErrors, status: "importing",
          message: `${processed} / ${dataRows.length} 行を処理中... (チャンク ${c + 1}/${chunks.length})`,
        });
      }

      setImportProgress({
        total: dataRows.length, processed,
        created: aggCreated, updated: aggUpdated, errors: aggErrors,
        status: "done",
        message: `完了: 作成 ${aggCreated} / 更新 ${aggUpdated} / エラー ${aggErrors.length}`,
      });
    } catch (e: any) {
      if (e?.name === "AbortError") {
        setImportProgress((p) => ({
          ...(p ?? { total: 0, processed: 0, created: 0, updated: 0, errors: [] }),
          status: "cancelled", message: "中止しました",
        }));
      } else {
        setImportProgress((p) => ({
          ...(p ?? { total: 0, processed: 0, created: 0, updated: 0, errors: [] }),
          status: "error", message: e?.message || String(e),
        }));
      }
    } finally {
      importAbortRef.current = null;
    }
  }, [importFile]);

  const openCreate = useCallback(() => {
    setPickedProduct(null);
    setFormRating("5");
    setFormTitle("");
    setFormBody("");
    setFormName("ASTROMEDA 編集部");
    setFormEmail("");
    setCreateOpen(true);
  }, []);

  const pickProduct = useCallback(async () => {
    try {
      const selected = await shopify.resourcePicker({ type: "product", multiple: false, action: "select" });
      if (selected && Array.isArray(selected) && selected.length > 0) {
        const p = selected[0] as { id: string; title: string; images?: Array<{ originalSrc?: string; url?: string }> };
        const img = p.images?.[0]?.originalSrc ?? p.images?.[0]?.url ?? null;
        setPickedProduct({ id: p.id, title: p.title, image: img });
      }
    } catch (err) {
      console.error("[admin.reviews] resourcePicker error", err);
    }
  }, [shopify]);

  const submitCreate = useCallback(() => {
    if (!pickedProduct) return;
    const fd = new FormData();
    fd.set("intent", "create");
    fd.set("productId", pickedProduct.id);
    fd.set("rating", formRating);
    fd.set("title", formTitle || formBody.slice(0, 40));
    fd.set("body", formBody);
    fd.set("reviewer_name", formName);
    fd.set("reviewer_email", formEmail);
    fetcher.submit(fd, { method: "post" });
  }, [pickedProduct, formRating, formTitle, formBody, formName, formEmail, fetcher]);

  useEffect(() => {
    if (
      fetcher.state === "idle" &&
      fetcher.data?.ok &&
      fetcher.data?.intent === "create" &&
      fetcher.data?.created
    ) {
      setCreateOpen(false);
    }
  }, [fetcher.state, fetcher.data]);

  const canSubmitCreate =
    !!pickedProduct &&
    formBody.trim().length >= 10 &&
    !!formName.trim() &&
    fetcher.state === "idle";

  // ─── Edit-mode state (in detail modal) ───
  const [editMode, setEditMode] = useState(false);
  const [editRating, setEditRating] = useState("5");
  const [editTitle, setEditTitle] = useState("");
  const [editBody, setEditBody] = useState("");
  const [inlineEditId, setInlineEditId] = useState<string | null>(null);
  const [inlineEditBody, setInlineEditBody] = useState<string>("");
  const [inlineEditNameId, setInlineEditNameId] = useState<string | null>(null);
  const [inlineEditNameValue, setInlineEditNameValue] = useState<string>("");
  const [editName, setEditName] = useState("");
  const [editEmail, setEditEmail] = useState("");
  const [photoUrlInputs, setPhotoUrlInputs] = useState<Record<number, string>>({});

  // ─── Detail modal state ───
  const [detailReview, setDetailReview] = useState<ReviewItem | null>(null);

  const openDetail = useCallback(
    (review: ReviewItem) => {
      setDetailReview(review);
      setEditMode(false);
      setEditRating(String(review.rating));
      setEditTitle(review.title);
      setEditBody(review.body);
      setEditName(review.reviewer_name);
      setEditEmail(review.reviewer_email);
      setPhotoUrlInputs({});
      const fd = new FormData();
      fd.set("intent", "fetch_detail");
      fd.set("reviewId", review.id);
      detailFetcher.submit(fd, { method: "post" });
    },
    [detailFetcher],
  );

  const closeDetail = useCallback(() => setDetailReview(null), []);

  // Approve/reject from within detail modal
  const handleDetailAction = useCallback(
    (action: "approve" | "reject") => {
      if (!detailReview) return;
      const fd = new FormData();
      fd.set("intent", action);
      fd.set("ids", detailReview.id);
      fetcher.submit(fd, { method: "post" });
    },
    [detailReview, fetcher],
  );

  // Close detail modal after approve/reject
  useEffect(() => {
    if (
      fetcher.state === "idle" &&
      fetcher.data?.ok &&
      (fetcher.data?.intent === "approve" || fetcher.data?.intent === "reject") &&
      fetcher.data?.updated &&
      detailReview
    ) {
      setDetailReview(null);
    }
  }, [fetcher.state, fetcher.data, detailReview]);

  // Refresh detail extras after edit/add_photo/remove_photo
  useEffect(() => {
    if (
      fetcher.state === "idle" &&
      fetcher.data?.ok &&
      (fetcher.data?.intent === "edit" ||
        fetcher.data?.intent === "add_photo" ||
        fetcher.data?.intent === "remove_photo") &&
      detailReview
    ) {
      // re-fetch detail to refresh photo URLs + field values
      const fd = new FormData();
      fd.set("intent", "fetch_detail");
      fd.set("reviewId", detailReview.id);
      detailFetcher.submit(fd, { method: "post" });
      if (fetcher.data?.intent === "edit") setEditMode(false);
      if (fetcher.data?.intent === "add_photo") setPhotoUrlInputs({});
    }
  }, [fetcher.state, fetcher.data, detailReview, detailFetcher]);

  // Submit edit
  const submitEdit = useCallback(() => {
    if (!detailReview) return;
    const fd = new FormData();
    fd.set("intent", "edit");
    fd.set("reviewId", detailReview.id);
    fd.set("rating", editRating);
    fd.set("title", editTitle || editBody.slice(0, 40));
    fd.set("body", editBody);
    fd.set("reviewer_name", editName);
    fd.set("reviewer_email", editEmail);
    fetcher.submit(fd, { method: "post" });
  }, [detailReview, editRating, editTitle, editBody, editName, editEmail, fetcher]);

  const canSubmitEdit =
    !!detailReview &&
    editBody.trim().length >= 10 &&
    !!editName.trim() &&
    fetcher.state === "idle";

  const cancelEdit = useCallback(() => {
    if (!detailReview) return;
    setEditMode(false);
    setEditRating(String(detailReview.rating));
    setEditTitle(detailReview.title);
    setEditBody(detailReview.body);
    setEditName(detailReview.reviewer_name);
    setEditEmail(detailReview.reviewer_email);
  }, [detailReview]);

  // Add photo (D&D file)
  const addPhotoFile = useCallback(
    (slot: number, file: File) => {
      if (!detailReview) return;
      const fd = new FormData();
      fd.set("intent", "add_photo");
      fd.set("reviewId", detailReview.id);
      fd.set("slot", String(slot));
      fd.set("file", file, file.name);
      fetcher.submit(fd, { method: "post", encType: "multipart/form-data" });
    },
    [detailReview, fetcher],
  );
  // Add photo (URL fallback)
  const addPhoto = useCallback(
    (slot: number) => {
      if (!detailReview) return;
      const url = (photoUrlInputs[slot] || "").trim();
      if (!url) return;
      const fd = new FormData();
      fd.set("intent", "add_photo");
      fd.set("reviewId", detailReview.id);
      fd.set("slot", String(slot));
      fd.set("url", url);
      fetcher.submit(fd, { method: "post" });
    },
    [detailReview, photoUrlInputs, fetcher],
  );

  // Remove photo
  const removePhoto = useCallback(
    (slot: number) => {
      if (!detailReview) return;
      const fd = new FormData();
      fd.set("intent", "remove_photo");
      fd.set("reviewId", detailReview.id);
      fd.set("slot", String(slot));
      fetcher.submit(fd, { method: "post" });
    },
    [detailReview, fetcher],
  );

  const detailExtras = detailFetcher.data?.detail;
  const detailLoading = detailFetcher.state === "submitting" || detailFetcher.state === "loading";

  const tabs = [
    { id: "pending", content: `承認待ち${tabCounts ? ` (${tabCounts.pending})` : ""}` },
    { id: "approved", content: `公開中${tabCounts ? ` (${tabCounts.approved})` : ""}` },
    { id: "rejected", content: `拒否${tabCounts ? ` (${tabCounts.rejected})` : ""}` },
  ];

  // ソートオプション (各タブ共通)
  const sortOptions = [
    { label: "投稿日が新しい順", value: "posted_at_desc" },
    { label: "投稿日が古い順", value: "posted_at_asc" },
    { label: "星評価が高い順 (5→1)", value: "rating_desc" },
    { label: "星評価が低い順 (1→5)", value: "rating_asc" },
    { label: "承認日が新しい順", value: "approved_at_desc" },
    { label: "承認日が古い順", value: "approved_at_asc" },
  ];
  const handleSortChange = (newSort: string) => {
    const params = new URLSearchParams(window.location.search);
    params.set("sort", newSort);
    params.delete("page");
    window.location.search = params.toString();
  };

  const sourceBadge = (st: string) => {
    if (st === "verified_purchase") return <Badge tone="success">認証購入</Badge>;
    if (st === "gift_recipient") return <Badge tone="info">ギフト</Badge>;
    if (st === "unverified") return <Badge>管理画面</Badge>;
    return <Badge>{st || "—"}</Badge>;
  };

  const statusBadge = (s: ReviewStatus) => {
    if (s === "pending") return <Badge tone="attention">承認待ち</Badge>;
    if (s === "approved") return <Badge tone="success">公開中</Badge>;
    return <Badge tone="critical">拒否</Badge>;
  };

  const rows = reviews.map((r, idx) => (
    <IndexTable.Row
      id={r.id}
      key={r.id}
      position={idx}
      selected={selectedResources.includes(r.id)}
      onClick={() => openDetail(r)}
    >
      <IndexTable.Cell>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-start", minWidth: 120, paddingTop: 4, paddingBottom: 4 }}>
          <Text as="span" variant="bodyMd" fontWeight="semibold">
            {"★".repeat(r.rating)}
            <span style={{ color: "#ccc" }}>{"★".repeat(Math.max(0, 5 - r.rating))}</span>
          </Text>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {r.status !== "approved" ? (
              <button
                type="button"
                onClick={(e) => changeStatusSingle(r.id, "approve", e)}
                style={{
                  fontSize: 13,
                  padding: "8px 14px",
                  background: "#10b981",
                  color: "#fff",
                  border: "none",
                  borderRadius: 6,
                  cursor: "pointer",
                  fontWeight: 700,
                  whiteSpace: "nowrap",
                  lineHeight: 1.3,
                  minHeight: 36,
                  boxShadow: "0 1px 2px rgba(0,0,0,0.1)",
                }}
                title="このレビューを承認して公開する"
              >
                ✓ 承認する
              </button>
            ) : null}
            {r.status !== "rejected" ? (
              <button
                type="button"
                onClick={(e) => changeStatusSingle(r.id, "reject", e)}
                style={{
                  fontSize: 13,
                  padding: "8px 14px",
                  background: "#fff",
                  color: "#dc2626",
                  border: "1.5px solid #fca5a5",
                  borderRadius: 6,
                  cursor: "pointer",
                  fontWeight: 700,
                  whiteSpace: "nowrap",
                  lineHeight: 1.3,
                  minHeight: 36,
                  boxShadow: "0 1px 2px rgba(0,0,0,0.05)",
                }}
                title="このレビューを非表示にする"
              >
                ✕ 非表示
              </button>
            ) : null}
          </div>
        </div>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <div style={{ display: "flex", alignItems: "center", gap: 12, paddingTop: 6, paddingBottom: 6 }}>
          {(() => {
            const productHref = r.product?.handle ? `https://shop.mining-base.co.jp/products/${r.product.handle}` : null;
            const imgEl = r.product?.image_url ? (
              <img
                src={r.product.image_url}
                alt={r.product.title || ""}
                style={{
                  width: 72,
                  height: 72,
                  objectFit: "cover",
                  borderRadius: 6,
                  border: "1px solid #e5e7eb",
                  flexShrink: 0,
                }}
              />
            ) : (
              <div style={{ width: 72, height: 72, background: "#f3f4f6", borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, color: "#9ca3af", flexShrink: 0, border: "1px solid #e5e7eb" }}>NO IMG</div>
            );
            const titleEl = (
              <span style={{
                display: "block",
                maxWidth: 240,
                fontSize: 13,
                lineHeight: 1.4,
                wordBreak: "break-word",
                whiteSpace: "normal",
                color: productHref ? "#2563eb" : "inherit",
                textDecoration: productHref ? "underline" : "none",
              }}>
                {r.product?.title || "(商品削除)"}
              </span>
            );
            if (productHref) {
              return (
                <>
                  <a href={productHref} target="_blank" rel="noopener noreferrer" title={`商品ページを開く: ${r.product?.title || ""}`} style={{ flexShrink: 0, lineHeight: 0 }} onClick={(e) => e.stopPropagation()}>
                    {imgEl}
                  </a>
                  <a href={productHref} target="_blank" rel="noopener noreferrer" style={{ textDecoration: "none" }} onClick={(e) => e.stopPropagation()}>
                    {titleEl}
                  </a>
                </>
              );
            }
            return (<>{imgEl}{titleEl}</>);
          })()}
        </div>
      </IndexTable.Cell>
      <IndexTable.Cell>
        {(() => {
          const { original, translation } = splitTranslation(r.body);
          const isEditing = inlineEditId === r.id;
          if (isEditing) {
            return (
              <div style={{ maxWidth: 400 }} onClick={(e) => e.stopPropagation()}>
                <textarea
                  value={inlineEditBody}
                  onChange={(e) => setInlineEditBody(e.target.value)}
                  rows={5}
                  style={{ width: "100%", padding: 8, border: "2px solid #2563eb", borderRadius: 6, fontSize: 13, fontFamily: "inherit", lineHeight: 1.5, resize: "vertical" }}
                  autoFocus
                />
                <div style={{ marginTop: 6, display: "flex", gap: 6, fontSize: 11, color: "#6b7280" }}>
                  <span>{inlineEditBody.length} 文字 / 1000 文字</span>
                </div>
                <div style={{ marginTop: 8, display: "flex", gap: 6 }}>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      const fd = new FormData();
                      fd.set("intent", "quick_edit_body");
                      fd.set("reviewId", r.id);
                      fd.set("body", inlineEditBody);
                      fetcher.submit(fd, { method: "post" });
                      setInlineEditId(null);
                    }}
                    style={{ padding: "6px 12px", background: "#10b981", color: "#fff", border: "none", borderRadius: 4, cursor: "pointer", fontWeight: 600, fontSize: 12 }}
                  >
                    ✓ 保存
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setInlineEditId(null);
                      setInlineEditBody("");
                    }}
                    style={{ padding: "6px 12px", background: "#fff", color: "#6b7280", border: "1px solid #d1d5db", borderRadius: 4, cursor: "pointer", fontSize: 12 }}
                  >
                    キャンセル
                  </button>
                </div>
              </div>
            );
          }
          return (
            <div
              style={{ fontSize: 13, color: "#374151", lineHeight: 1.5, whiteSpace: "normal", wordBreak: "break-word", maxWidth: 400, cursor: "pointer", padding: 6, borderRadius: 4, position: "relative" }}
              onClick={(e) => {
                e.stopPropagation();
                setInlineEditId(r.id);
                setInlineEditBody(r.body);
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "#f9fafb"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
              title="クリックして編集"
            >
              <div>{original}</div>
              {translation ? (
                <div style={{ marginTop: 6, paddingTop: 6, borderTop: "1px dashed #d1d5db", fontSize: 12, color: "#6b7280" }}>
                  <span style={{ display: "inline-block", padding: "1px 6px", background: "#eef2ff", color: "#4338ca", borderRadius: 3, fontSize: 10, fontWeight: 600, marginRight: 6 }}>🇯🇵 訳</span>
                  {translation}
                </div>
              ) : null}
              <span style={{ position: "absolute", top: 4, right: 4, fontSize: 10, color: "#9ca3af", opacity: 0.6 }}>✏️ 編集</span>
            </div>
          );
        })()}
      </IndexTable.Cell>
      <IndexTable.Cell>
        {inlineEditNameId === r.id ? (
          <div style={{ maxWidth: 200 }} onClick={(e) => e.stopPropagation()}>
            <input
              type="text"
              value={inlineEditNameValue}
              onChange={(e) => setInlineEditNameValue(e.target.value)}
              maxLength={40}
              autoFocus
              style={{ width: "100%", padding: 6, border: "2px solid #2563eb", borderRadius: 4, fontSize: 12, fontFamily: "inherit" }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  const fd = new FormData();
                  fd.set("intent", "quick_edit_name");
                  fd.set("reviewId", r.id);
                  fd.set("reviewer_name", inlineEditNameValue);
                  fetcher.submit(fd, { method: "post" });
                  setInlineEditNameId(null);
                } else if (e.key === "Escape") {
                  setInlineEditNameId(null);
                  setInlineEditNameValue("");
                }
              }}
            />
            <div style={{ marginTop: 4, display: "flex", gap: 4 }}>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  const fd = new FormData();
                  fd.set("intent", "quick_edit_name");
                  fd.set("reviewId", r.id);
                  fd.set("reviewer_name", inlineEditNameValue);
                  fetcher.submit(fd, { method: "post" });
                  setInlineEditNameId(null);
                }}
                style={{ padding: "3px 8px", background: "#10b981", color: "#fff", border: "none", borderRadius: 3, cursor: "pointer", fontSize: 11, fontWeight: 600 }}
              >
                ✓
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setInlineEditNameId(null);
                  setInlineEditNameValue("");
                }}
                style={{ padding: "3px 8px", background: "#fff", color: "#6b7280", border: "1px solid #d1d5db", borderRadius: 3, cursor: "pointer", fontSize: 11 }}
              >
                ✕
              </button>
            </div>
            <div style={{ marginTop: 2, fontSize: 10, color: "#9ca3af" }}>{inlineEditNameValue.length}/40 (Enter: 保存)</div>
          </div>
        ) : (
          <div
            style={{ display: "flex", flexDirection: "column", gap: 2, maxWidth: 90, fontSize: 11, lineHeight: 1.3, cursor: "pointer", position: "relative" }}
            onClick={(e) => {
              e.stopPropagation();
              setInlineEditNameId(r.id);
              setInlineEditNameValue(r.reviewer_name || "");
            }}
            title="クリックで投稿者名を編集"
          >
            <span style={{ fontWeight: 600, color: "#374151", wordBreak: "break-word" }}>
              {r.reviewer_name || "—"}
            </span>
            <span style={{ color: "#9ca3af", fontSize: 10 }}>
              {new Date(r.posted_at || r.created_at).toLocaleDateString("ja-JP", { year: "2-digit", month: "numeric", day: "numeric" })}
            </span>
            <span style={{ position: "absolute", top: -2, right: 0, fontSize: 9, color: "#9ca3af", opacity: 0.5 }}>✏️</span>
          </div>
        )}
      </IndexTable.Cell>
      <IndexTable.Cell>{statusBadge(r.status)}</IndexTable.Cell>
    </IndexTable.Row>
  ));

  return (
    <Page
      title="レビュー一覧"
      subtitle="行クリックで詳細表示／評価の下の ✓承認 / ✕非表示 で個別変更／チェックボックスで一括操作"
      primaryAction={{ content: "新規レビューを作成", onAction: openCreate }}
      secondaryActions={
        selectedResources.length > 0
          ? (tab === "pending"
              ? [
                  { content: `${selectedResources.length} 件を承認`, onAction: () => bulkSubmit("approve") },
                  { content: `${selectedResources.length} 件を非表示にする`, destructive: true, onAction: () => bulkSubmit("reject") },
                  { content: `${selectedResources.length} 件を完全削除`, destructive: true, onAction: () => bulkSubmit("delete") },
                ]
              : tab === "approved"
              ? [
                  { content: `${selectedResources.length} 件を非表示にする`, destructive: true, onAction: () => bulkSubmit("reject") },
                  { content: `${selectedResources.length} 件を完全削除`, destructive: true, onAction: () => bulkSubmit("delete") },
                ]
              : [
                  { content: `${selectedResources.length} 件を承認 (再公開)`, onAction: () => bulkSubmit("approve") },
                  { content: `${selectedResources.length} 件を完全削除`, destructive: true, onAction: () => bulkSubmit("delete") },
                ])
          : []
      }
    >
      <Layout>
        <Layout.Section>
          {partialData ? (
            <Banner tone="warning" title="取得タイムアウト: 一部のレビューのみ表示中">
              <Text as="p" variant="bodyMd">
                Vercel の処理時間制限を回避するため、最初の数百件のみ取得しました。
                ページや並び順を変えても再ログイン画面は出ません。
                時間をおいて再読み込みすると最新の全件が反映されます。
              </Text>
            </Banner>
          ) : null}
          {fetcher.data?.ok && fetcher.data.updated && fetcher.data.updated > 0 ? (
            <Banner tone="success" title={`${fetcher.data.updated} 件を更新しました`} onDismiss={() => {}} />
          ) : null}
          {fetcher.data?.ok && fetcher.data.intent === "quick_edit_body" ? (
            <Banner tone="success" title="本文を更新しました" onDismiss={() => {}} />
          ) : null}
          {fetcher.data?.ok && fetcher.data.intent === "backfill_reviews_html" ? (
            <Banner
              tone={fetcher.data.failed > 0 ? "warning" : "success"}
              title={`${fetcher.data.synced} 商品の HTML を再生成しました${fetcher.data.failed ? ` (失敗: ${fetcher.data.failed})` : ""}`}
              onDismiss={() => {}}
            />
          ) : null}
          {fetcher.data?.ok && fetcher.data.intent === "bulk_delete_by_status" ? (
            <Banner
              tone={fetcher.data.failed > 0 ? "warning" : "success"}
              title={`${fetcher.data.deleted} 件削除しました${fetcher.data.failed ? ` (失敗: ${fetcher.data.failed})` : ""}`}
              onDismiss={() => {}}
            />
          ) : null}
          {fetcher.data?.ok && fetcher.data.intent === "delete" && fetcher.data.deleted ? (
            <Banner tone="success" title={`${fetcher.data.deleted} 件のレビューを完全削除しました`} onDismiss={() => {}} />
          ) : null}
          {fetcher.data?.ok && fetcher.data.created ? (
            <Banner tone="success" title="新規レビューを作成しました (承認待ちタブに表示されます)" onDismiss={() => {}} />
          ) : null}
          {fetcher.data && !fetcher.data.ok && fetcher.data.intent !== "create" ? (
            <Banner tone="critical" title={fetcher.data.error || "一部の更新に失敗しました"} onDismiss={() => {}} />
          ) : null}

          <InlineStack gap="200" align="end">
            <Button onClick={async () => {
              try {
                const res = await fetch("/app/reviews/products.csv", { credentials: "include" });
                if (!res.ok) { console.error("products export failed", res.status); return; }
                const blob = await res.blob();
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                const d = new Date().toISOString().slice(0, 10);
                a.href = url;
                a.download = `astromeda-parent-products-${d}.csv`;
                document.body.appendChild(a);
                a.click();
                setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 0);
              } catch (e) { console.error("products export error", e); }
            }}>
              対象商品一覧 CSV
            </Button>
            <Button onClick={async () => {
              try {
                const res = await fetch("/app/reviews/export.csv", { credentials: "include" });
                if (!res.ok) { console.error("export failed", res.status); return; }
                const blob = await res.blob();
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                const d = new Date().toISOString().slice(0, 10);
                a.href = url;
                a.download = `astromeda-reviews-${d}.csv`;
                document.body.appendChild(a);
                a.click();
                setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 0);
              } catch (e) { console.error("export error", e); }
            }}>
              CSV を出力
            </Button>
            <Button onClick={openImport}>
              CSV を取り込み
            </Button>
          </InlineStack>

          {/* 上段: pagination bar */}
          {paginationBar}
          <Card>
            <BlockStack gap="0">
              <Tabs tabs={tabs} selected={tabIndex < 0 ? 0 : tabIndex} onSelect={handleTabChange} />
              <div style={{ padding: "12px 16px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, borderBottom: "1px solid #e1e3e5" }}>
                <div style={{ display: "flex", gap: 8 }}>
                  <Button
                    onClick={() => {
                      // confirm removed (バックフィルは非破壊操作のため)
                      const fd = new FormData();
                      fd.set("intent", "backfill_reviews_html");
                      fetcher.submit(fd, { method: "post" });
                    }}
                  >
                    🔄 全商品の HTML を再生成
                  </Button>
                  {tab === "pending" && tabCounts && tabCounts.pending > 0 ? (
                    <Button
                      tone="critical"
                      variant="primary"
                      onClick={() => {
                        const n = tabCounts.pending;
                        const ok1 = window.confirm(`承認待ちの ${n} 件をすべて完全削除します。\nこの操作は元に戻せません。続行しますか？`);
                        if (!ok1) return;
                        const ok2 = window.confirm(`本当に ${n} 件を削除しますか？\n(誤操作防止のための 2 段階確認)`);
                        if (!ok2) return;
                        const fd = new FormData();
                        fd.set("intent", "bulk_delete_by_status");
                        fd.set("status", "pending");
                        fetcher.submit(fd, { method: "post" });
                      }}
                    >
                      承認待ちを全削除 ({tabCounts.pending})
                    </Button>
                  ) : null}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 13, color: "#616161" }}>並び替え:</span>
                <div style={{ minWidth: 220 }}>
                  <Select
                    label=""
                    labelHidden
                    options={sortOptions}
                    value={sort}
                    onChange={handleSortChange}
                  />
                </div>
                </div>
              </div>
              {reviews.length === 0 ? (
                <EmptyState
                  heading={tab === "pending" ? "承認待ちのレビューはありません" : tab === "approved" ? "公開中のレビューはまだありません" : "拒否されたレビューはありません"}
                  image=""
                >
                  <Text as="p" variant="bodyMd">
                    注文発送 14 日後に Shopify Flow から自動でレビュー依頼メールが送信され、お客様が投稿すると ここに承認待ちレビューが表示されます。
                  </Text>
                </EmptyState>
              ) : (
                <IndexTable
                  resourceName={resourceName}
                  itemCount={reviews.length}
                  selectedItemsCount={allResourcesSelected ? "All" : selectedResources.length}
                  onSelectionChange={handleSelectionChange}
                  headings={[
                    { title: "評価" },
                    { title: "商品" },
                    { title: "レビュー" },
                    { title: "投稿者 / 投稿日" },
                    { title: "状態" },
                  ]}
                  selectable={tab === "pending"}
                >
                  {rows}
                </IndexTable>
              )}
            </BlockStack>
          </Card>

          {/* 下段: pagination bar (totalCount > 0 のみ) */}
          {paginationBar}
        </Layout.Section>
      </Layout>

      {/* ─── Detail modal ─── */}
      <Modal
        open={!!detailReview}
        onClose={closeDetail}
        title={detailReview ? `レビュー詳細 — ${detailReview.title || ""}` : "詳細"}
        size="large"
        footer={
          detailReview ? (
            <InlineStack align="start">
              <Button
                tone="critical"
                variant="primary"
                onClick={() => {
                  if (detailReview) {
                    deleteSingle(detailReview.id, detailReview.title || "");
                    closeDetail();
                  }
                }}
              >
                🗑️ このレビューを削除
              </Button>
            </InlineStack>
          ) : null
        }
        primaryAction={
          detailReview
            ? detailReview.status === "pending"
              ? { content: "承認して公開", onAction: () => handleDetailAction("approve"), loading: fetcher.state === "submitting" }
              : detailReview.status === "approved"
              ? { content: "非表示にする", destructive: true, onAction: () => handleDetailAction("reject"), loading: fetcher.state === "submitting" }
              : { content: "承認して再公開", onAction: () => handleDetailAction("approve"), loading: fetcher.state === "submitting" }
            : { content: "閉じる", onAction: closeDetail }
        }
        secondaryActions={
          detailReview
            ? detailReview.status === "pending"
              ? [
                  { content: "非表示にする", destructive: true, onAction: () => handleDetailAction("reject"), loading: fetcher.state === "submitting" },
                  { content: "閉じる", onAction: closeDetail },
                ]
              : detailReview.status === "approved"
              ? [{ content: "閉じる", onAction: closeDetail }]
              : [
                  { content: "閉じる", onAction: closeDetail },
                ]
            : []
        }
      >
        {detailReview ? (
          <Modal.Section>
            <BlockStack gap="500">
              {/* ── 商品情報 ── */}
              <Card>
                <BlockStack gap="300">
                  <Text as="h3" variant="headingSm">対象商品</Text>
                  {detailReview.product ? (
                    <InlineStack gap="400" blockAlign="center">
                      {detailReview.product.image_url ? (
                        <Thumbnail source={detailReview.product.image_url} alt={detailReview.product.title} size="large" />
                      ) : null}
                      <BlockStack gap="100">
                        <Text as="span" variant="bodyMd" fontWeight="bold">{detailReview.product.title}</Text>
                        <Text as="span" variant="bodySm" tone="subdued">{detailReview.product.id}</Text>
                        <InlineStack gap="300">
                          <a
                            href={`https://admin.shopify.com/store/${shop}/products/${detailReview.product.id.split("/").pop()}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{ color: "#005bd3", textDecoration: "underline", fontSize: 14 }}
                          >
                            管理画面で開く
                          </a>
                          {detailReview.product.handle ? (
                            <a
                              href={`https://shop.mining-base.co.jp/products/${detailReview.product.handle}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              style={{ color: "#005bd3", textDecoration: "underline", fontSize: 14 }}
                            >
                              ストアフロントで開く
                            </a>
                          ) : null}
                        </InlineStack>
                      </BlockStack>
                    </InlineStack>
                  ) : (
                    <Text as="p" tone="critical">対象商品が削除されているか、参照できません</Text>
                  )}
                </BlockStack>
              </Card>

              {/* ── 投稿者情報 ── */}
              <Card>
                <BlockStack gap="300">
                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="h3" variant="headingSm">投稿者プロフィール</Text>
                    <InlineStack gap="200" blockAlign="center">
                      {sourceBadge(detailReview.source_type)}
                      <Button size="slim" onClick={() => setEditMode(true)} disabled={editMode}>
                        編集する
                      </Button>
                    </InlineStack>
                  </InlineStack>
                  {editMode ? (
                    <FormLayout>
                      <TextField
                        label="表示名 (ストアフロントに公開)"
                        value={editName}
                        onChange={setEditName}
                        autoComplete="off"
                        maxLength={40}
                        showCharacterCount
                        requiredIndicator
                        helpText="不適切な表現・下品な名前はここで修正してください。"
                      />
                      <TextField
                        label="メール (非公開・連絡用)"
                        value={editEmail}
                        onChange={setEditEmail}
                        autoComplete="off"
                        helpText="ストアフロントには表示されません。"
                      />
                      <InlineStack gap="200">
                        <Button variant="primary" onClick={submitEdit} disabled={!canSubmitEdit} loading={fetcher.state === "submitting" && fetcher.data?.intent !== "add_photo" && fetcher.data?.intent !== "remove_photo"}>
                          変更を保存
                        </Button>
                        <Button onClick={cancelEdit}>キャンセル</Button>
                      </InlineStack>
                    </FormLayout>
                  ) : (
                  <BlockStack gap="200">
                    <InlineStack gap="200">
                      <Box minWidth="100px"><Text as="span" tone="subdued" variant="bodySm">表示名</Text></Box>
                      <Text as="span" variant="bodyMd" fontWeight="semibold">{detailReview.reviewer_name || "—"}</Text>
                    </InlineStack>
                    <InlineStack gap="200">
                      <Box minWidth="100px"><Text as="span" tone="subdued" variant="bodySm">メール</Text></Box>
                      <Text as="span" variant="bodyMd">{detailReview.reviewer_email || "—"}</Text>
                    </InlineStack>
                  </BlockStack>
                  )}

                  <Divider />

                  {detailLoading ? (
                    <SkeletonBodyText lines={3} />
                  ) : detailReview.source_type === "gift_recipient" && detailExtras?.gift_token ? (
                    <BlockStack gap="200">
                      <Text as="h4" variant="headingXs">🎁 ギフト招待元</Text>
                      <InlineStack gap="200">
                        <Box minWidth="100px"><Text as="span" tone="subdued" variant="bodySm">受領者</Text></Box>
                        <Text as="span">{detailExtras.gift_token.customer_name || "—"}</Text>
                      </InlineStack>
                      <InlineStack gap="200">
                        <Box minWidth="100px"><Text as="span" tone="subdued" variant="bodySm">送付先メール</Text></Box>
                        <Text as="span">{detailExtras.gift_token.email || "—"}</Text>
                      </InlineStack>
                      <InlineStack gap="200">
                        <Box minWidth="100px"><Text as="span" tone="subdued" variant="bodySm">トークン発行元</Text></Box>
                        <Text as="span" variant="bodySm">{detailExtras.gift_token.issued_by || "—"}</Text>
                      </InlineStack>
                      <InlineStack gap="200">
                        <Box minWidth="100px"><Text as="span" tone="subdued" variant="bodySm">使用日時</Text></Box>
                        <Text as="span" variant="bodySm">{detailExtras.gift_token.used_at ? new Date(detailExtras.gift_token.used_at).toLocaleString("ja-JP") : "未使用"}</Text>
                      </InlineStack>
                      {detailExtras.gift_token.gift_note ? (
                        <Box paddingBlockStart="200">
                          <Text as="p" variant="bodySm" tone="subdued">ギフトメモ: {detailExtras.gift_token.gift_note}</Text>
                        </Box>
                      ) : null}
                    </BlockStack>
                  ) : detailReview.source_type === "verified_purchase" && detailExtras?.order ? (
                    <BlockStack gap="200">
                      <Text as="h4" variant="headingXs">✓ 認証購入元の注文</Text>
                      <InlineStack gap="200">
                        <Box minWidth="100px"><Text as="span" tone="subdued" variant="bodySm">注文番号</Text></Box>
                        <a
                          href={`https://admin.shopify.com/store/${shop}/orders/${detailExtras.order.id.split("/").pop()}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ color: "#005bd3", textDecoration: "underline" }}
                        >{detailExtras.order.name}</a>
                      </InlineStack>
                      <InlineStack gap="200">
                        <Box minWidth="100px"><Text as="span" tone="subdued" variant="bodySm">購入者</Text></Box>
                        <Text as="span">{detailExtras.order.customer_name || "—"}</Text>
                      </InlineStack>
                      <InlineStack gap="200">
                        <Box minWidth="100px"><Text as="span" tone="subdued" variant="bodySm">注文日</Text></Box>
                        <Text as="span" variant="bodySm">{new Date(detailExtras.order.created_at).toLocaleString("ja-JP")}</Text>
                      </InlineStack>
                    </BlockStack>
                  ) : detailReview.source_type === "unverified" ? (
                    <Box>
                      <Text as="p" variant="bodySm" tone="subdued">
                        管理画面から作成されたレビュー。実際の購入/ギフト受領との紐付けはありません。
                      </Text>
                      {detailReview.reply_text && detailReview.reply_text.startsWith("[admin_created]") ? (
                        <Text as="p" variant="bodySm" tone="subdued">{detailReview.reply_text}</Text>
                      ) : null}
                    </Box>
                  ) : null}
                </BlockStack>
              </Card>

              {/* ── レビュー本文 (全文) — 編集モード対応 ── */}
              <Card>
                <BlockStack gap="300">
                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="h3" variant="headingSm">{editMode ? "レビューを編集" : "レビュー全文"}</Text>
                    <InlineStack gap="200" blockAlign="center">
                      {statusBadge(detailReview.status)}
                      {!editMode ? (
                        <Button size="slim" onClick={() => setEditMode(true)}>編集する</Button>
                      ) : null}
                    </InlineStack>
                  </InlineStack>

                  {editMode ? (
                    <FormLayout>
                      <Select
                        label="評価 (★)"
                        options={[
                          { label: "★★★★★ (5)", value: "5" },
                          { label: "★★★★ (4)", value: "4" },
                          { label: "★★★ (3)", value: "3" },
                          { label: "★★ (2)", value: "2" },
                          { label: "★ (1)", value: "1" },
                        ]}
                        value={editRating}
                        onChange={setEditRating}
                      />
                      <TextField
                        label="本文 (10 文字以上)"
                        value={editBody}
                        onChange={setEditBody}
                        multiline={6}
                        autoComplete="off"
                        maxLength={1000}
                        showCharacterCount
                        requiredIndicator
                      />
                      <TextField
                        label="表示名"
                        value={editName}
                        onChange={setEditName}
                        autoComplete="off"
                        maxLength={40}
                        requiredIndicator
                      />
                      <TextField
                        label="メールアドレス (非公開)"
                        value={editEmail}
                        onChange={setEditEmail}
                        autoComplete="off"
                        helpText="お客様の連絡先として保存。ストアフロントには表示されません。"
                      />
                      <InlineStack gap="200">
                        <Button variant="primary" onClick={submitEdit} disabled={!canSubmitEdit} loading={fetcher.state === "submitting" && fetcher.data?.intent !== "add_photo" && fetcher.data?.intent !== "remove_photo"}>
                          変更を保存
                        </Button>
                        <Button onClick={cancelEdit}>キャンセル</Button>
                      </InlineStack>
                    </FormLayout>
                  ) : (
                    <BlockStack gap="200">
                      <Text as="span" variant="headingMd">
                        <span style={{ color: "#0d9488" }}>{"★".repeat(detailReview.rating)}</span>
                        <span style={{ color: "#d1d5db" }}>{"★".repeat(Math.max(0, 5 - detailReview.rating))}</span>
                        <span style={{ marginLeft: 8, fontSize: 14, color: "#6b7280" }}>({detailReview.rating} / 5)</span>
                      </Text>
                      <Text as="h4" variant="headingMd">{detailReview.title || ""}</Text>
                      <div style={{ padding: "8px 12px", background: "#f9fafb", borderRadius: 8, fontSize: 14, lineHeight: 1.8 }}>
                        {(() => {
                          const { original, translation } = splitTranslation(detailReview.body);
                          return (
                            <>
                              <div style={{ whiteSpace: "pre-wrap" }}>{original}</div>
                              {translation ? (
                                <div style={{ marginTop: 12, paddingTop: 10, borderTop: "1px dashed #cbd5e1" }}>
                                  <span style={{ display: "inline-block", padding: "2px 8px", background: "#eef2ff", color: "#4338ca", borderRadius: 4, fontSize: 11, fontWeight: 700, marginBottom: 6 }}>🇯🇵 日本語訳</span>
                                  <div style={{ whiteSpace: "pre-wrap", fontSize: 13, color: "#6b7280", lineHeight: 1.7 }}>{translation}</div>
                                </div>
                              ) : null}
                            </>
                          );
                        })()}
                      </div>
                      <Text as="p" variant="bodySm" tone="subdued">
                        投稿日時: {new Date(detailReview.posted_at || detailReview.created_at).toLocaleString("ja-JP")}
                        {detailReview.approved_at ? ` / 承認日時: ${new Date(detailReview.approved_at).toLocaleString("ja-JP")} (by ${detailReview.approved_by})` : ""}
                      </Text>
                    </BlockStack>
                  )}
                </BlockStack>
              </Card>

              {/* ── 写真 (photo_1 〜 photo_6) ── */}
              <Card>
                <BlockStack gap="300">
                  <Text as="h3" variant="headingSm">写真 ({((detailExtras?.review?.photos)?.length ?? detailReview.photos.length)}/6)</Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    画像をドラッグ&ドロップまたは選択して追加できます。空きスロット 6 枚まで・10 MB 以下。
                  </Text>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
                    {[1, 2, 3, 4, 5, 6].map((slot) => {
                      const photos = detailExtras?.review?.photos ?? detailReview.photos;
                      const existing = photos.find((p) => p.slot === slot) ?? null;
                      if (existing && existing.url) {
                        return (
                          <div key={slot} style={{ position: "relative", border: "1px solid #e5e7eb", borderRadius: 8, overflow: "hidden", background: "#f9fafb" }}>
                            <img src={existing.url} alt={`photo ${slot}`} style={{ width: "100%", height: 140, objectFit: "cover", display: "block" }} />
                            <div style={{ padding: "6px 8px", display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 11 }}>
                              <span style={{ color: "#6b7280" }}>枠 {slot}</span>
                              <Button size="micro" tone="critical" variant="plain" onClick={() => removePhoto(slot)}>削除</Button>
                            </div>
                          </div>
                        );
                      }
                      return (
                        <div key={slot} style={{ border: "1px dashed #d1d5db", borderRadius: 8, padding: 8, background: "#f9fafb", display: "flex", flexDirection: "column", gap: 6, minHeight: 180 }}>
                          <Text as="span" variant="bodySm" tone="subdued">枠 {slot} (空き)</Text>
                          <DropZone
                            accept="image/*"
                            type="image"
                            allowMultiple={false}
                            onDrop={(_files, accepted) => {
                              if (accepted && accepted[0]) addPhotoFile(slot, accepted[0]);
                            }}
                            disabled={fetcher.state === "submitting"}
                          >
                            <DropZone.FileUpload actionTitle="画像を選択" actionHint="またはドラッグ&ドロップ" />
                          </DropZone>
                          <details>
                            <summary style={{ fontSize: 11, color: "#6b7280", cursor: "pointer" }}>URL で追加（上級者向け）</summary>
                            <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 6 }}>
                              <TextField
                                label=""
                                labelHidden
                                value={photoUrlInputs[slot] || ""}
                                onChange={(v) => setPhotoUrlInputs((m) => ({ ...m, [slot]: v }))}
                                autoComplete="off"
                                placeholder="https://..."
                              />
                              <Button size="slim" onClick={() => addPhoto(slot)} disabled={!photoUrlInputs[slot] || fetcher.state === "submitting"}>
                                この URL から追加
                              </Button>
                            </div>
                          </details>
                        </div>
                      );
                    })}
                  </div>
                </BlockStack>
              </Card>

              {/* ── ストアフロントプレビュー ── */}
              <Card>
                <BlockStack gap="300">
                  <Text as="h3" variant="headingSm">ストアフロント表示プレビュー</Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    {detailReview.status === "approved"
                      ? "承認済みのため、現在ストアフロントの商品ページに以下の形で表示されています。"
                      : "承認すると、ストアフロントの商品ページに以下の形で表示されます。"}
                  </Text>
                  <Box padding="200" background="bg-surface-secondary" borderRadius="200">
                    <ReviewStorefrontPreview
                      review={editMode ? {
                        ...detailReview,
                        rating: parseInt(editRating, 10) || detailReview.rating,
                        body: editBody || detailReview.body,
                        reviewer_name: editName || detailReview.reviewer_name,
                        reviewer_email: editEmail,
                      } : detailReview}
                      productImage={detailReview.product?.image_url}
                      productTitle={detailReview.product?.title}
                    />
                  </Box>
                </BlockStack>
              </Card>
            </BlockStack>
          </Modal.Section>
        ) : null}
      </Modal>

      {/* ─── Create review modal (unchanged) ─── */}
      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="新規レビューを作成"
        primaryAction={{
          content: fetcher.state === "submitting" ? "保存中..." : "下書きとして保存",
          onAction: submitCreate,
          disabled: !canSubmitCreate,
          loading: fetcher.state === "submitting",
        }}
        secondaryActions={[{ content: "キャンセル", onAction: () => setCreateOpen(false) }]}
      >
        <Modal.Section>
          <BlockStack gap="400">
            <Banner tone="info">
              <Text as="p" variant="bodySm">
                ここで作成したレビューは「承認待ち」タブに入り、source_type=unverified として記録されます。
                公開するには承認操作が必要です。テスト用途・実機 UI 確認にお使いください。
              </Text>
            </Banner>

            <FormLayout>
              <div>
                <Text as="h3" variant="headingSm">対象商品</Text>
                <div style={{ marginTop: 8 }}>
                  {pickedProduct ? (
                    <InlineStack gap="300" blockAlign="center">
                      {pickedProduct.image ? (
                        <Thumbnail source={pickedProduct.image} alt={pickedProduct.title} size="small" />
                      ) : null}
                      <BlockStack gap="100">
                        <Text as="span" variant="bodyMd" fontWeight="semibold">{pickedProduct.title}</Text>
                        <Text as="span" variant="bodySm" tone="subdued">{pickedProduct.id}</Text>
                      </BlockStack>
                      <Button onClick={pickProduct}>変更</Button>
                    </InlineStack>
                  ) : (
                    <Button onClick={pickProduct}>商品を選ぶ</Button>
                  )}
                </div>
              </div>

              <Select
                label="評価 (★)"
                options={[
                  { label: "★★★★★ (5)", value: "5" },
                  { label: "★★★★ (4)", value: "4" },
                  { label: "★★★ (3)", value: "3" },
                  { label: "★★ (2)", value: "2" },
                  { label: "★ (1)", value: "1" },
                ]}
                value={formRating}
                onChange={setFormRating}
              />

              <TextField
                label="本文 (10 文字以上)"
                value={formBody}
                onChange={setFormBody}
                multiline={6}
                autoComplete="off"
                maxLength={1000}
                showCharacterCount
                placeholder="商品の感想を入力してください"
                requiredIndicator
              />

              <TextField
                label="表示名"
                value={formName}
                onChange={setFormName}
                autoComplete="off"
                maxLength={40}
                requiredIndicator
                helpText="ストアフロントでの公開名。初期値: ASTROMEDA 編集部"
              />

              <TextField
                label="メールアドレス (任意・非公開)"
                value={formEmail}
                onChange={setFormEmail}
                autoComplete="off"
                placeholder="空欄なら admin@<shop> が自動入力されます"
              />

              {fetcher.data && !fetcher.data.ok && fetcher.data.intent === "create" && fetcher.data.error ? (
                <Banner tone="critical" title={fetcher.data.error} onDismiss={() => {}} />
              ) : null}
            </FormLayout>
          </BlockStack>
        </Modal.Section>
      </Modal>

      {/* ─── CSV Import modal ─── */}
      <Modal
        open={importOpen}
        onClose={() => { if (importProgress?.status !== "importing" && importProgress?.status !== "resolving") setImportOpen(false); }}
        title="CSV を取り込み"
        primaryAction={
          importProgress?.status === "importing" || importProgress?.status === "resolving"
            ? { content: "中止", onAction: cancelImport, destructive: true }
            : importProgress?.status === "done"
              ? { content: "閉じる", onAction: () => setImportOpen(false) }
              : { content: "実行", onAction: submitImport, disabled: !importFile }
        }
        secondaryActions={
          importProgress?.status === "importing" || importProgress?.status === "resolving"
            ? undefined
            : [{ content: "閉じる", onAction: () => setImportOpen(false) }]
        }
      >
        <Modal.Section>
          <BlockStack gap="400">
            <Banner tone="info" title="使い方">
              <BlockStack gap="100">
                <Text as="p" variant="bodySm">
                  <strong>① 新規レビューを CSV で一括投稿する場合:</strong> id 列は<strong>空欄のままで OK</strong> です。取り込み時に Shopify が自動で ID を発行します。「対象商品一覧 CSV」ボタンから親商品一覧をダウンロードして、行ごとに rating/title/body などを Excel で記入してください。
                </Text>
                <Text as="p" variant="bodySm">
                  <strong>② 既存レビューを編集する場合:</strong> 「CSV を出力」でダウンロードした CSV の id 列 (gid://shopify/Metaobject/...) を残したまま編集すると、その行は<strong>更新</strong>されます。
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  必須列: product_handle / rating (1-5) / title / body / reviewer_name<br/>
                  任意列: reviewer_email / source_type (verified_purchase | gift_recipient | unverified) / status (pending | approved | rejected)
                </Text>
              </BlockStack>
            </Banner>
            <Banner tone="warning">
              <Text as="p" variant="bodySm">
                「CSV を出力」でダウンロードしたファイルを Excel 等で編集して取り込んでください。photo_1..6 列は今のところ書き戻し対象外です (画像は写真スロットの D&D から登録)。
              </Text>
            </Banner>
            <DropZone
              accept="text/csv,.csv"
              type="file"
              allowMultiple={false}
              onDrop={(_files, accepted) => { if (accepted && accepted[0]) setImportFile(accepted[0]); }}
              disabled={fetcher.state === "submitting"}
            >
              <DropZone.FileUpload actionTitle="CSV を選択" actionHint="またはドラッグ&ドロップ" />
            </DropZone>
            {importFile ? (
              <Text as="p" variant="bodySm">選択中: {importFile.name} ({Math.round(importFile.size / 1024)} KB)</Text>
            ) : null}
            {importProgress ? (
              <BlockStack gap="200">
                {(importProgress.status === "importing" || importProgress.status === "resolving") ? (
                  <>
                    <ProgressBar progress={importProgress.total > 0 ? Math.round((importProgress.processed / importProgress.total) * 100) : 5} size="medium" />
                    <Text as="p" variant="bodySm">{importProgress.message}</Text>
                    <Text as="p" variant="bodySm" tone="subdued">
                      作成 {importProgress.created} 件 / 更新 {importProgress.updated} 件 / エラー {importProgress.errors.length} 件
                    </Text>
                  </>
                ) : null}
                {importProgress.status === "done" ? (
                  <Banner tone="success" title="取り込み完了">
                    <Text as="p" variant="bodySm">
                      作成: {importProgress.created} 件 / 更新: {importProgress.updated} 件 / エラー: {importProgress.errors.length} 件
                    </Text>
                    {importProgress.errors.length > 0 ? (
                      <Box paddingBlockStart="200">
                        <Text as="p" variant="bodySm" tone="critical">エラー詳細 (最大20件):</Text>
                        <ul style={{ marginTop: 6, paddingLeft: 18, fontSize: 12 }}>
                          {importProgress.errors.slice(0, 20).map((e, i) => (
                            <li key={i}>行 {e.row}: {e.error}</li>
                          ))}
                        </ul>
                      </Box>
                    ) : null}
                  </Banner>
                ) : null}
                {importProgress.status === "error" ? (
                  <Banner tone="critical" title="取り込み失敗">
                    <Text as="p" variant="bodySm">{importProgress.message}</Text>
                    {importProgress.processed > 0 ? (
                      <Text as="p" variant="bodySm" tone="subdued">
                        途中までの結果: 作成 {importProgress.created} 件 / 更新 {importProgress.updated} 件 / エラー {importProgress.errors.length} 件
                      </Text>
                    ) : null}
                  </Banner>
                ) : null}
                {importProgress.status === "cancelled" ? (
                  <Banner tone="warning" title="中止しました">
                    <Text as="p" variant="bodySm">
                      途中までの結果: 作成 {importProgress.created} 件 / 更新 {importProgress.updated} 件 / エラー {importProgress.errors.length} 件
                    </Text>
                  </Banner>
                ) : null}
              </BlockStack>
            ) : null}
          </BlockStack>
        </Modal.Section>
      </Modal>
    </Page>
  );
}
