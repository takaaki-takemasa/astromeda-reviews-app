/**
 * /app/shipments — レビュー未送信リスト
 *
 * 発送済み注文を起点に、商品×お客様単位で以下3状態を可視化:
 *   🔴 未依頼  : 発送済み・レビュー依頼トークン未発行
 *   🟡 依頼済  : 依頼トークン発行済み・レビュー未投稿 (または pending)
 *   🟢 レビュー済 : approved レビュー有り
 *
 * UI:
 *   - 上段タブ: IPコラボ (全IP / サンリオ / ストファイ6 / ... 26IP)
 *   - フィルタ: 商品カテゴリ (キーボード / マウスパッド / PC本体 / ...)
 *   - 3列状態表示
 *   - ページネーション (50/page)
 *   - 「今すぐ依頼を送る」ボタン (個別)
 *
 * Phase 1 MVP: 上記の表示 + 個別送信。
 * Phase 2 で 製品群テンプレ割当 + 一斉送信 を追加予定。
 */

import {
  Page, Layout, Card, BlockStack, InlineStack, Text, EmptyState, IndexTable, Badge,
  Tabs, Select, Button, Pagination, Banner, Popover, ActionList, TextField,
} from "@shopify/polaris";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useSearchParams, useFetcher, Form } from "@remix-run/react";
import { useState, useCallback, useMemo } from "react";
import { authenticate } from "../shopify.server";
import { appendAuditLogSafe } from "../lib/audit-log";

// ──────────────────────────────────────────────────────────────────
// 型
// ──────────────────────────────────────────────────────────────────
type ShipmentState = "pending_request" | "requested" | "reviewed";

interface ShipmentRow {
  key: string;             // ${order_id}::${product_gid}::${email}
  order_id: string;        // shopify order number (e.g. "#1234")
  order_gid: string;       // gid://shopify/Order/...
  customer_email: string;
  customer_name: string;
  product_gid: string;
  product_handle: string;
  product_title: string;
  product_image_url: string | null;
  ip_label: string;        // IP コラボ名 (例: "サンリオキャラクターズ")
  ip_handle: string;       // IPコラボのコレクションハンドル
  category: string;        // "キーボード" / "マウスパッド" / "PC本体" / "PCケース" / "グッズ" / "その他"
  fulfilled_at: string;    // ISO
  state: ShipmentState;
  token_id: string | null;
  review_id: string | null;
  request_sent_at: string | null;
}

// ──────────────────────────────────────────────────────────────────
// 親商品判定 (option / parts / pulldown を除外)
// ──────────────────────────────────────────────────────────────────
function isParentProduct(node: { templateSuffix?: string | null; handle?: string; tags?: string[] }): boolean {
  const ts = (node.templateSuffix || "").toLowerCase();
  if (ts.includes("option") || ts.includes("parts") || ts === "option_parts_pc") return false;
  const tags = (node.tags || []).map((t) => t.toLowerCase());
  if (tags.includes("pulldown-component") || tags.includes("option") || tags.includes("part") || tags.includes("オプション") || tags.includes("部品")) return false;
  const h = (node.handle || "").toLowerCase();
  if (h.startsWith("option-") || h.startsWith("opt-") || h.startsWith("pulldown-")) return false;
  return true;
}

// ──────────────────────────────────────────────────────────────────
// 商品カテゴリ自動判定 (商品タイトルから)
// ──────────────────────────────────────────────────────────────────
function detectCategory(title: string): string {
  const t = title || "";
  if (t.match(/キーボード/)) return "キーボード";
  if (t.match(/マウスパッド|デスクマット|ゲーミングラバー/)) return "マウスパッド";
  if (t.match(/PCケース|ケース|パネル|交換用パネル/)) return "PCケース・パネル";
  if (t.match(/モバイルバッテリー/)) return "モバイルバッテリー";
  if (t.match(/アクリルキーホルダー|アクリルスタンド|メタルカード|缶バッジ|トートバッグ|キーホルダー/)) return "グッズ";
  if (t.match(/Ryzen|Intel|RTX|Core|ゲーミングPC|PC|デスクトップ|BTO/i)) return "PC本体";
  return "その他";
}

// ──────────────────────────────────────────────────────────────────
// 商品 → IP マッピング (Shopify collections から)
// ──────────────────────────────────────────────────────────────────
type ProductIPInfo = { ipLabel: string; ipHandle: string };
async function buildProductIPMap(admin: any, productGids: string[]): Promise<Map<string, ProductIPInfo>> {
  // 発送に出てくる商品 GID だけを 100 件ずつ nodes() で fetch (store 全商品 fetch を回避)
  const map = new Map<string, ProductIPInfo>();
  if (productGids.length === 0) return map;
  const uniqueGids = Array.from(new Set(productGids));
  const QUERY = `#graphql
    query ProductsByIds($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on Product {
          id
          title
          handle
          templateSuffix
          tags
          collections(first: 10) { edges { node { handle title } } }
        }
      }
    }
  `;
  // 100件ずつ分割 fetch
  for (let i = 0; i < uniqueGids.length; i += 100) {
    const batch = uniqueGids.slice(i, i + 100);
    const res: any = await admin.graphql(QUERY, { variables: { ids: batch } });
    const j = await res.json();
    const nodes = (j?.data?.nodes ?? []).filter((n: any) => n);
    const edges = nodes.map((n: any) => ({ node: n }));
    for (const e of edges) {
      const n = e.node;
      if (!isParentProduct(n)) continue;
      // collections の中から最も「IP コラボらしい」ものを採用 (handle に collaboration 含む / または特定名称)
      const colls = (n.collections?.edges ?? []).map((c: any) => c.node);
      let ip: ProductIPInfo = { ipLabel: "その他", ipHandle: "other" };
      for (const c of colls) {
        const h = (c.handle || "").toLowerCase();
        // 親 IP collection らしいもの (collaboration を含む / または特定リスト)
        if (h.endsWith("-collaboration") || h.includes("collaboration") || h === "sanrio-characters-collaboration" || h === "hololive-english-collaboration" || h === "naruto-shippuden" || h === "heroaca-collaboration" || h === "jujutsukaisen-collaboration" || h === "bocchi-rocks-collaboration") {
          ip = { ipLabel: c.title || c.handle, ipHandle: c.handle };
          break;
        }
      }
      // フォールバック: タイトルから IP 推定
      if (ip.ipHandle === "other") {
        const title = n.title || "";
        if (title.includes("サンリオ") || title.includes("クロミ") || title.includes("シナモロール") || title.includes("マイメロ") || title.includes("ハローキティ") || title.includes("ポチャッコ") || title.includes("ポムポムプリン")) ip = { ipLabel: "サンリオキャラクターズ", ipHandle: "sanrio-characters-collaboration" };
        else if (title.includes("ストリートファイター") || title.includes("ジュリ") || title.includes("リュウ") || title.includes("キャミィ") || title.includes("春麗")) ip = { ipLabel: "ストリートファイター6", ipHandle: "streetfighter-collaboration" };
        else if (title.includes("hololive") || title.includes("ホロライブ")) ip = { ipLabel: "hololive English", ipHandle: "hololive-english-collaboration" };
        else if (title.includes("呪術廻戦") || title.includes("宿儺") || title.includes("五条")) ip = { ipLabel: "呪術廻戦", ipHandle: "jujutsukaisen-collaboration" };
        else if (title.includes("チェンソーマン") || title.includes("レゼ")) ip = { ipLabel: "チェンソーマン", ipHandle: "chainsawman-movie-reze" };
        else if (title.includes("ぼっち") || title.includes("結束バンド")) ip = { ipLabel: "ぼっち・ざ・ろっく！", ipHandle: "bocchi-rocks-collaboration" };
        else if (title.includes("ナルト") || title.includes("NARUTO") || title.includes("うずまき")) ip = { ipLabel: "NARUTO疾風伝", ipHandle: "naruto-shippuden" };
        else if (title.includes("ヒロアカ") || title.includes("ヒーロー") || title.includes("デク") || title.includes("爆豪")) ip = { ipLabel: "僕のヒーローアカデミア", ipHandle: "heroaca-collaboration" };
        else if (title.includes("ソニック")) ip = { ipLabel: "ソニック", ipHandle: "sega-sonic-astromeda-collaboration" };
        else if (title.includes("ワンピース") || title.includes("ONE PIECE") || title.includes("ルフィ")) ip = { ipLabel: "ONE PIECEバウンティラッシュ", ipHandle: "one-piece-bountyrush-collaboration" };
        else if (title.includes("BLEACH") || title.includes("一護") || title.includes("ブリーチ")) ip = { ipLabel: "BLEACH", ipHandle: "bleach-rebirth-of-souls-collaboration" };
        else if (title.includes("コードギアス") || title.includes("ルルーシュ") || title.includes("C.C.")) ip = { ipLabel: "コードギアス", ipHandle: "geass-collaboration" };
        else if (title.includes("東京喰種") || title.includes("カネキ")) ip = { ipLabel: "東京喰種", ipHandle: "tokyoghoul-collaboration" };
        else if (title.includes("ラブライブ") || title.includes("虹ヶ咲") || title.includes("カレン")) ip = { ipLabel: "ラブライブ虹ヶ咲", ipHandle: "lovelive-nijigasaki-collaboration" };
        else if (title.includes("SAO") || title.includes("ソードアート") || title.includes("キリト") || title.includes("アスナ")) ip = { ipLabel: "ソードアートオンライン", ipHandle: "swordart-online-collaboration" };
        else if (title.includes("ゆるキャン")) ip = { ipLabel: "ゆるキャン△", ipHandle: "yurucamp-collaboration" };
        else if (title.includes("パックマス") || title.includes("PAC-MAN")) ip = { ipLabel: "パックマス", ipHandle: "pacmas-astromeda-collaboration" };
        else if (title.includes("すみっコ") || title.includes("ねこ") && title.includes("とかげ")) ip = { ipLabel: "すみっコぐらし", ipHandle: "sumikko" };
        else if (title.includes("ガールズ＆パンツァー") || title.includes("ガルパン")) ip = { ipLabel: "ガールズ＆パンツァー", ipHandle: "girls-und-panzer-collaboration" };
        else if (title.includes("Palworld") || title.includes("パルワールド")) ip = { ipLabel: "Palworld", ipHandle: "astromeda-palworld-collaboration-pc" };
        else if (title.includes("リラックマ")) ip = { ipLabel: "リラックマ", ipHandle: "goods-rilakkuma" };
      }
      map.set(n.id, ip);
    }
  }
  return map;
}

// ──────────────────────────────────────────────────────────────────
// Shopify Order 取得 (fulfilled)
// ──────────────────────────────────────────────────────────────────
interface LineItemTuple {
  order_gid: string;
  order_number: string;
  customer_email: string;
  customer_name: string;
  product_gid: string;
  product_title: string;
  product_handle: string;
  product_image_url: string | null;
  fulfilled_at: string;
}

async function fetchAllFulfilledLineItems(admin: any, sinceIso: string): Promise<LineItemTuple[]> {
  const ORDERS_QUERY = `#graphql
    query FulfilledOrders($first: Int!, $after: String, $q: String!) {
      orders(first: $first, after: $after, query: $q, sortKey: PROCESSED_AT, reverse: true) {
        edges {
          node {
            id
            name
            displayFulfillmentStatus
            processedAt
            customer { firstName lastName email displayName }
            fulfillments(first: 5) { createdAt }
            lineItems(first: 50) {
              edges {
                node {
                  id
                  title
                  quantity
                  product { id handle title templateSuffix tags featuredImage { url } }
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
  const tuples: LineItemTuple[] = [];
  let cursor: string | null = null;
  let safety = 0;
  while (safety < 8) {  // 400件上限 (8 * 50)
    const q = `fulfillment_status:fulfilled AND status:any AND processed_at:>=${sinceIso}`;
    const res: any = await admin.graphql(ORDERS_QUERY, { variables: { first: 50, after: cursor, q } });
    const j = await res.json();
    const edges = j?.data?.orders?.edges ?? [];
    for (const e of edges) {
      const order = e.node;
      const customerEmail = order.customer?.email || "";
      if (!customerEmail) continue;
      const customerName = order.customer?.displayName || `${order.customer?.firstName || ""} ${order.customer?.lastName || ""}`.trim() || "(名前未登録)";
      const fulfilledAt = order.fulfillments?.[0]?.createdAt || order.processedAt || "";
      const liEdges = order.lineItems?.edges ?? [];
      const seenProductGids = new Set<string>();
      for (const liE of liEdges) {
        const product = liE.node?.product;
        if (!product || !product.id) continue;
        if (seenProductGids.has(product.id)) continue;
        if (!isParentProduct(product)) continue;
        seenProductGids.add(product.id);
        tuples.push({
          order_gid: order.id,
          order_number: order.name || "",
          customer_email: customerEmail,
          customer_name: customerName,
          product_gid: product.id,
          product_title: product.title || "",
          product_handle: product.handle || "",
          product_image_url: product.featuredImage?.url || null,
          fulfilled_at: fulfilledAt,
        });
      }
    }
    const pi = j?.data?.orders?.pageInfo;
    if (!pi?.hasNextPage) break;
    cursor = pi.endCursor;
    safety++;
  }
  return tuples;
}

// ──────────────────────────────────────────────────────────────────
// 既存 token + review との突合
// ──────────────────────────────────────────────────────────────────
async function fetchTokensAndReviews(admin: any): Promise<{ tokens: Map<string, { id: string; created_at: string }>; reviews: Map<string, { id: string; status: string }> }> {
  const TOKEN_QUERY = `#graphql
    query Tokens($first: Int!, $after: String) {
      metaobjects(type: "astromeda_review_token", first: $first, after: $after, sortKey: "updated_at", reverse: true) {
        edges { node { id updatedAt fields { key value } } }
        pageInfo { hasNextPage endCursor }
      }
    }
  `;
  const REVIEW_QUERY = `#graphql
    query Reviews($first: Int!, $after: String) {
      metaobjects(type: "astromeda_review", first: $first, after: $after) {
        edges { node { id fields { key value } } }
        pageInfo { hasNextPage endCursor }
      }
    }
  `;
  // tokens
  const tokens = new Map<string, { id: string; created_at: string }>();
  {
    let cursor: string | null = null;
    let safety = 0;
    while (safety < 20) {
      const res: any = await admin.graphql(TOKEN_QUERY, { variables: { first: 250, after: cursor } });
      const j = await res.json();
      const edges = j?.data?.metaobjects?.edges ?? [];
      for (const e of edges) {
        const fmap: Record<string, string> = {};
        for (const f of (e.node.fields || [])) fmap[f.key] = f.value;
        const order_id = fmap.order_id || "";
        const email = (fmap.email || "").toLowerCase();
        if (order_id && email) {
          tokens.set(`${order_id}::${email}`, { id: e.node.id, created_at: e.node.updatedAt });
        }
      }
      const pi = j?.data?.metaobjects?.pageInfo;
      if (!pi?.hasNextPage) break;
      cursor = pi.endCursor;
      safety++;
    }
  }
  // reviews
  const reviews = new Map<string, { id: string; status: string }>();
  {
    let cursor: string | null = null;
    let safety = 0;
    while (safety < 20) {
      const res: any = await admin.graphql(REVIEW_QUERY, { variables: { first: 250, after: cursor } });
      const j = await res.json();
      const edges = j?.data?.metaobjects?.edges ?? [];
      for (const e of edges) {
        const fmap: Record<string, string> = {};
        for (const f of (e.node.fields || [])) fmap[f.key] = f.value;
        const productRef = fmap.product_ref || "";
        const email = (fmap.reviewer_email || "").toLowerCase();
        const orderId = fmap.order_id || "";
        const status = fmap.status || "pending";
        // 索引キー: (product_ref + email) と (order_id + email + product_ref) 両方
        if (productRef && email) {
          reviews.set(`${productRef}::${email}`, { id: e.node.id, status });
        }
        if (orderId && email && productRef) {
          reviews.set(`${orderId}::${email}::${productRef}`, { id: e.node.id, status });
        }
      }
      const pi = j?.data?.metaobjects?.pageInfo;
      if (!pi?.hasNextPage) break;
      cursor = pi.endCursor;
      safety++;
    }
  }
  return { tokens, reviews };
}

// ──────────────────────────────────────────────────────────────────
// Loader
// ──────────────────────────────────────────────────────────────────
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const ipHandleParam = url.searchParams.get("ip") || "all";
  const categoryParam = url.searchParams.get("category") || "all";
  const stateParam = (url.searchParams.get("state") || "pending_request") as ShipmentState | "all";
  const pageParam = parseInt(url.searchParams.get("page") || "1", 10);
  const currentPage = isNaN(pageParam) || pageParam < 1 ? 1 : pageParam;
  const PAGE_SIZE = 50;

  // 期間スコープ: デフォルト過去180日 (UI で変更可能)
  const sortBy = (url.searchParams.get("sort_by") || "fulfilled_at").toLowerCase();
  const sortDir = (url.searchParams.get("sort_dir") || "desc").toLowerCase() === "asc" ? "asc" : "desc";
  const daysParam = parseInt(url.searchParams.get("days") || "180", 10);
  const days = isNaN(daysParam) || daysParam < 1 ? 180 : Math.min(daysParam, 730);
  const sinceIso = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  console.log("[SHIPMENTS] loader start", { days, sinceIso });
  // 先に発送データを取得し、そこから出てくる商品 GID だけ IP map を構築する
  const [tuples, { tokens, reviews }] = await Promise.all([
    fetchAllFulfilledLineItems(admin, sinceIso),
    fetchTokensAndReviews(admin),
  ]);
  const productGids = Array.from(new Set(tuples.map((t) => t.product_gid)));
  const productIPMap = await buildProductIPMap(admin, productGids);
  console.log("[SHIPMENTS] data loaded", { products: productIPMap.size, tuples: tuples.length, tokens: tokens.size, reviews: reviews.size });

  // build rows
  const allRows: ShipmentRow[] = tuples.map((t) => {
    const ip = productIPMap.get(t.product_gid) || { ipLabel: "その他", ipHandle: "other" };
    const category = detectCategory(t.product_title);
    const emailLower = t.customer_email.toLowerCase();
    const tokenKey = `${t.order_gid.replace("gid://shopify/Order/", "")}::${emailLower}`;
    // tokens の order_id は数値文字列で入っている可能性が高い (Shopify Flow 由来)
    const tokenInfo = tokens.get(tokenKey) || tokens.get(`${t.order_number}::${emailLower}`);
    const reviewInfo = reviews.get(`${t.product_gid}::${emailLower}`);
    let state: ShipmentState = "pending_request";
    if (reviewInfo) state = "reviewed";
    else if (tokenInfo) state = "requested";
    return {
      key: `${t.order_gid}::${t.product_gid}::${emailLower}`,
      order_id: t.order_number,
      order_gid: t.order_gid,
      customer_email: t.customer_email,
      customer_name: t.customer_name,
      product_gid: t.product_gid,
      product_handle: t.product_handle,
      product_title: t.product_title,
      product_image_url: t.product_image_url,
      ip_label: ip.ipLabel,
      ip_handle: ip.ipHandle,
      category,
      fulfilled_at: t.fulfilled_at,
      state,
      token_id: tokenInfo?.id || null,
      review_id: reviewInfo?.id || null,
      request_sent_at: tokenInfo?.created_at || null,
    };
  });

  // Context-aware facets:
  //  - ipFacets: 商品カテゴリ filter を適用後の IP 分布 (現在のカテゴリ文脈で各 IP 何件)
  //  - categoryFacets: IP filter を適用後のカテゴリ分布 (現在の IP 文脈で各カテゴリ何件)
  //  - allIpTotal: 全 IP 合計件数 (商品カテゴリ filter のみ適用)
  const rowsForIpFacets = allRows.filter((r) => categoryParam === "all" || r.category === categoryParam);
  const rowsForCategoryFacets = allRows.filter((r) => ipHandleParam === "all" || r.ip_handle === ipHandleParam);
  const ipFacets = new Map<string, { label: string; count: number }>();
  const categoryFacets = new Map<string, number>();
  for (const r of rowsForIpFacets) {
    const cur = ipFacets.get(r.ip_handle);
    if (cur) cur.count++;
    else ipFacets.set(r.ip_handle, { label: r.ip_label, count: 1 });
  }
  for (const r of rowsForCategoryFacets) {
    categoryFacets.set(r.category, (categoryFacets.get(r.category) || 0) + 1);
  }
  const allIpTotal = rowsForIpFacets.length;
  const allCategoryTotal = rowsForCategoryFacets.length;

  // state counts (after IP+category filter)
  const filtered = allRows.filter((r) => {
    if (ipHandleParam !== "all" && r.ip_handle !== ipHandleParam) return false;
    if (categoryParam !== "all" && r.category !== categoryParam) return false;
    return true;
  });
  const stateCounts = {
    pending_request: filtered.filter((r) => r.state === "pending_request").length,
    requested: filtered.filter((r) => r.state === "requested").length,
    reviewed: filtered.filter((r) => r.state === "reviewed").length,
    all: filtered.length,
  };

  // state filter
  const stateFiltered = stateParam === "all" ? filtered : filtered.filter((r) => r.state === stateParam);
  // sort: dynamic by user choice (default: 発送日新しい順)
  const sortMul = sortDir === "asc" ? 1 : -1;
  const getSortKey = (r: any): string | number => {
    switch (sortBy) {
      case "product":
      case "product_title":
        return (r.product_title || "").toLowerCase();
      case "ip":
      case "ip_label":
        return (r.ip_label || "").toLowerCase();
      case "category":
        return (r.category || "").toLowerCase();
      case "customer":
      case "customer_name":
        return (r.customer_name || "").toLowerCase();
      case "customer_email":
        return (r.customer_email || "").toLowerCase();
      case "order_id":
        return (r.order_id || "").toLowerCase();
      case "state":
        // state ordering: pending_request < requested < reviewed (発送→依頼→レビュー の時系列)
        return r.state === "pending_request" ? 0 : r.state === "requested" ? 1 : 2;
      case "fulfilled_at":
      default:
        return r.fulfilled_at ? new Date(r.fulfilled_at).getTime() : 0;
    }
  };
  stateFiltered.sort((a, b) => {
    const ak = getSortKey(a);
    const bk = getSortKey(b);
    if (ak < bk) return -1 * sortMul;
    if (ak > bk) return 1 * sortMul;
    // tie-breaker: fulfilled_at desc
    const aT = a.fulfilled_at ? new Date(a.fulfilled_at).getTime() : 0;
    const bT = b.fulfilled_at ? new Date(b.fulfilled_at).getTime() : 0;
    return bT - aT;
  });

  const totalCount = stateFiltered.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const start = (currentPage - 1) * PAGE_SIZE;
  const pageRows = stateFiltered.slice(start, start + PAGE_SIZE);

  return {
    rows: pageRows,
    pagination: { currentPage, totalPages, totalCount, pageSize: PAGE_SIZE },
    ipFacets: Array.from(ipFacets.entries()).map(([h, v]) => ({ handle: h, label: v.label, count: v.count })).sort((a, b) => b.count - a.count),
    categoryFacets: Array.from(categoryFacets.entries()).map(([k, v]) => ({ key: k, count: v })).sort((a, b) => b.count - a.count),
    stateCounts,
    allIpTotal,
    allCategoryTotal,
    filters: { ip: ipHandleParam, category: categoryParam, state: stateParam, days, sortBy, sortDir },
  };
};

// ──────────────────────────────────────────────────────────────────
// Action: 今すぐ依頼を送る (個別 / 一斉)
// ──────────────────────────────────────────────────────────────────
function generateUuid(): string {
  if (typeof crypto !== "undefined" && (crypto as any).randomUUID) return (crypto as any).randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

const STORE_DOMAIN = process.env.SHOP_CUSTOM_DOMAIN || "shop.mining-base.co.jp";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent") as string | null;

  if (intent === "send_request") {
    const order_id = String(formData.get("order_id") || "");
    const customer_email = String(formData.get("customer_email") || "").toLowerCase();
    const customer_name = String(formData.get("customer_name") || "");
    const product_gid = String(formData.get("product_gid") || "");
    if (!order_id || !customer_email) return { ok: false, error: "order_id and customer_email are required" };

    // 1. トークン発行
    const token = generateUuid();
    const expires_at = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();
    const review_url = `https://${STORE_DOMAIN}/apps/reviews-1/submit?token=${token}`;
    const CREATE_TOKEN = `#graphql
      mutation CreateToken($metaobject: MetaobjectCreateInput!) {
        metaobjectCreate(metaobject: $metaobject) {
          metaobject { id }
          userErrors { field message code }
        }
      }
    `;
    const tres: any = await admin.graphql(CREATE_TOKEN, {
      variables: {
        metaobject: {
          type: "astromeda_review_token",
          fields: [
            { key: "token", value: token },
            { key: "email", value: customer_email },
            { key: "customer_name", value: customer_name },
            { key: "order_id", value: order_id },
            { key: "token_type", value: "purchase" },
            { key: "expires_at", value: expires_at },
            { key: "issued_by", value: "admin-shipments-tab" },
          ],
        },
      },
    });
    const tj = await tres.json();
    const tokenErrs = tj?.data?.metaobjectCreate?.userErrors ?? [];
    const tokenId = tj?.data?.metaobjectCreate?.metaobject?.id;
    if (tokenErrs.length > 0 || !tokenId) {
      return { ok: false, error: tokenErrs[0]?.message || "token create failed", intent };
    }

    // 2. send_queue へ即時送信 entry を作成
    const CREATE_QUEUE = `#graphql
      mutation CreateQueue($metaobject: MetaobjectCreateInput!) {
        metaobjectCreate(metaobject: $metaobject) {
          metaobject { id }
          userErrors { field message code }
        }
      }
    `;
    const nowIso = new Date().toISOString();
    await admin.graphql(CREATE_QUEUE, {
      variables: {
        metaobject: {
          type: "astromeda_review_email_queue",
          fields: [
            { key: "order_id", value: order_id },
            { key: "email", value: customer_email },
            { key: "customer_name", value: customer_name },
            { key: "scheduled_at", value: nowIso },
            { key: "status", value: "queued" },
            { key: "token_id", value: tokenId },
          ],
        },
      },
    });

    await appendAuditLogSafe({
      admin,
      actor: session.shop,
      action: "review.request.send",
      resource_id: tokenId,
      resource_type: "astromeda_review_token",
      request,
      metadata: { order_id, email: customer_email, product_gid, review_url, source: "admin-shipments-tab" },
    });

    return { ok: true, intent, token, tokenId, review_url };
  }

  return { ok: false, error: "unknown intent", intent };
};

// ──────────────────────────────────────────────────────────────────
// UI
// ──────────────────────────────────────────────────────────────────
function fmtDate(iso: string): string {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
  } catch { return ""; }
}

function fmtRelative(iso: string): string {
  if (!iso) return "";
  try {
    const d = new Date(iso).getTime();
    const now = Date.now();
    const diffMs = now - d;
    const day = Math.floor(diffMs / 86400000);
    if (diffMs < 0) return "未来日";
    if (day === 0) return "今日";
    if (day === 1) return "昨日";
    if (day < 7) return `${day}日前`;
    if (day < 30) return `${Math.floor(day / 7)}週間前`;
    if (day < 365) return `${Math.floor(day / 30)}ヶ月前`;
    return `${Math.floor(day / 365)}年前`;
  } catch { return ""; }
}

function StateBadge({ state }: { state: ShipmentState }) {
  if (state === "pending_request") return <Badge tone="critical">🔴 未依頼</Badge>;
  if (state === "requested") return <Badge tone="attention">🟡 依頼済</Badge>;
  return <Badge tone="success">🟢 レビュー済</Badge>;
}

export default function ShipmentsTab() {
  const { rows, pagination, ipFacets, categoryFacets, stateCounts, filters, allIpTotal, allCategoryTotal } = useLoaderData<typeof loader>() as any;
  const [searchParams, setSearchParams] = useSearchParams();
  const fetcher = useFetcher<typeof action>();
  const [flashMessage, setFlashMessage] = useState<string | null>(null);

  // IP セレクター: 上位 4 IP は Tab、残りは Popover + 検索可能 ActionList
  const TOP_IP_COUNT = 4;
  const topIps = ipFacets.slice(0, TOP_IP_COUNT);
  const restIps = ipFacets.slice(TOP_IP_COUNT);
  const allTabs = [
    { id: "all", content: `全IP (${allIpTotal})` },
    ...topIps.map((f: any) => ({ id: f.handle, content: `${f.label} (${f.count})` })),
  ];
  // selected IP がトップ 4 に居なければ全IPタブを active 扱いにし、別途 chip で表示
  const selectedIp = filters.ip;
  const selectedIpInTop = selectedIp === "all" || topIps.some((t: any) => t.handle === selectedIp);
  const ipTabIndex = selectedIpInTop ? Math.max(0, allTabs.findIndex((t) => t.id === selectedIp)) : 0;

  const handleIpTabChange = useCallback((idx: number) => {
    const nextIp = allTabs[idx].id;
    const next = new URLSearchParams(searchParams);
    next.set("ip", nextIp);
    next.set("page", "1");
    setSearchParams(next);
  }, [searchParams, setSearchParams, allTabs]);

  // 検索可能 IP popover
  const [ipPopoverActive, setIpPopoverActive] = useState(false);
  const [ipSearchQuery, setIpSearchQuery] = useState("");
  const filteredRestIps = useMemo(() => {
    const q = ipSearchQuery.trim().toLowerCase();
    if (!q) return restIps;
    return restIps.filter((f: any) => f.label.toLowerCase().includes(q) || f.handle.toLowerCase().includes(q));
  }, [restIps, ipSearchQuery]);

  // 現在選択中の IP が rest 側にある場合のラベル
  const selectedRestIp = restIps.find((f: any) => f.handle === selectedIp);

  // Category select
  const categoryOptions = [
    { label: `全カテゴリ (${allCategoryTotal})`, value: "all" },
    ...categoryFacets.map((f: any) => ({ label: `${f.key} (${f.count})`, value: f.key })),
  ];
  const handleCategoryChange = useCallback((val: string) => {
    const next = new URLSearchParams(searchParams);
    next.set("category", val);
    next.set("page", "1");
    setSearchParams(next);
  }, [searchParams, setSearchParams]);

  // State tabs
  const stateTabs = [
    { id: "pending_request", content: `🔴 未依頼 (${stateCounts.pending_request})` },
    { id: "requested", content: `🟡 依頼済 (${stateCounts.requested})` },
    { id: "reviewed", content: `🟢 レビュー済 (${stateCounts.reviewed})` },
  ];
  const stateTabIndex = Math.max(0, stateTabs.findIndex((t) => t.id === filters.state));
  const handleStateTabChange = useCallback((idx: number) => {
    const next = new URLSearchParams(searchParams);
    next.set("state", stateTabs[idx].id);
    next.set("page", "1");
    setSearchParams(next);
  }, [searchParams, setSearchParams, stateTabs]);

  // Sort - Polaris IndexTable native sortable API
  const currentSortBy = filters.sortBy || "fulfilled_at";
  const currentSortDir = filters.sortDir || "desc";
  // 列順: 商品/IP, お客様, 注文番号, 発送日, 状態, アクション
  const sortColumnKeyByIndex: Record<number, string> = { 0: "product", 1: "customer", 2: "order_id", 3: "fulfilled_at", 4: "state" };
  const sortColumnIndexByKey: Record<string, number> = { product: 0, customer: 1, order_id: 2, fulfilled_at: 3, state: 4 };
  const sortColumnIndex = sortColumnIndexByKey[currentSortBy] ?? 3;
  const handlePolarisSort = useCallback((idx: number, direction: "ascending" | "descending") => {
    const key = sortColumnKeyByIndex[idx];
    if (!key) return;
    const next = new URLSearchParams(searchParams);
    next.set("sort_by", key);
    next.set("sort_dir", direction === "ascending" ? "asc" : "desc");
    next.set("page", "1");
    setSearchParams(next);
  }, [searchParams, setSearchParams]);

  // Pagination
  const handlePage = useCallback((newPage: number) => {
    const next = new URLSearchParams(searchParams);
    next.set("page", String(newPage));
    setSearchParams(next);
  }, [searchParams, setSearchParams]);

  // Send individual request
  const sendRequest = useCallback((row: ShipmentRow) => {
    const fd = new FormData();
    fd.set("intent", "send_request");
    fd.set("order_id", row.order_id.replace("#", ""));
    fd.set("customer_email", row.customer_email);
    fd.set("customer_name", row.customer_name);
    fd.set("product_gid", row.product_gid);
    fetcher.submit(fd, { method: "post" });
  }, [fetcher]);

  // Flash on action success
  if (fetcher.state === "idle" && fetcher.data?.ok && fetcher.data?.intent === "send_request" && flashMessage === null) {
    setFlashMessage(`依頼を送信しました (token: ${(fetcher.data as any).token?.slice(0, 8)}...)`);
    setTimeout(() => setFlashMessage(null), 4000);
  }

  return (
    <Page
      title="レビュー未送信リスト"
      subtitle={`発送済み注文を商品×お客様単位で表示。3状態 (未依頼/依頼済/レビュー済) を可視化し、個別に「今すぐ依頼を送る」ことができます。`}
    >
      <Layout>
        {flashMessage ? (
          <Layout.Section>
            <Banner tone="success" onDismiss={() => setFlashMessage(null)}>{flashMessage}</Banner>
          </Layout.Section>
        ) : null}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack gap="200" align="start" blockAlign="center" wrap={false}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <Tabs tabs={allTabs} selected={ipTabIndex} onSelect={handleIpTabChange} />
                </div>
                {restIps.length > 0 ? (
                  <Popover
                    active={ipPopoverActive}
                    activator={
                      <Button
                        onClick={() => setIpPopoverActive(!ipPopoverActive)}
                        disclosure={ipPopoverActive ? "up" : "down"}
                        pressed={!!selectedRestIp}
                      >
                        {selectedRestIp ? `${selectedRestIp.label} (${selectedRestIp.count})` : `他 ${restIps.length} IP`}
                      </Button>
                    }
                    onClose={() => setIpPopoverActive(false)}
                    preferredAlignment="right"
                  >
                    <div style={{ padding: 12, minWidth: 320 }}>
                      <TextField
                        label="IP を検索"
                        labelHidden
                        autoComplete="off"
                        placeholder="IPコラボ名で検索…"
                        value={ipSearchQuery}
                        onChange={setIpSearchQuery}
                        clearButton
                        onClearButtonClick={() => setIpSearchQuery("")}
                      />
                      <div style={{ maxHeight: 320, overflowY: "auto", marginTop: 8 }}>
                        <ActionList
                          items={filteredRestIps.map((f: any) => ({
                            content: `${f.label} (${f.count})`,
                            onAction: () => {
                              const next = new URLSearchParams(searchParams);
                              next.set("ip", f.handle);
                              next.set("page", "1");
                              setSearchParams(next);
                              setIpPopoverActive(false);
                              setIpSearchQuery("");
                            },
                            active: selectedIp === f.handle,
                          }))}
                        />
                        {filteredRestIps.length === 0 ? (
                          <Text as="p" variant="bodySm" tone="subdued">該当する IP がありません</Text>
                        ) : null}
                      </div>
                    </div>
                  </Popover>
                ) : null}
              </InlineStack>
              <InlineStack gap="400" align="space-between" blockAlign="end">
                <Select label="商品カテゴリ" options={categoryOptions} value={filters.category} onChange={handleCategoryChange} />
                <InlineStack gap="200" blockAlign="center">
                  <Text as="span" variant="bodyMd" tone="subdued">全 {pagination.totalCount} 件中 {(pagination.currentPage - 1) * pagination.pageSize + 1}-{Math.min(pagination.currentPage * pagination.pageSize, pagination.totalCount)} 件表示</Text>
                  <Pagination
                    hasPrevious={pagination.currentPage > 1}
                    hasNext={pagination.currentPage < pagination.totalPages}
                    onPrevious={() => handlePage(pagination.currentPage - 1)}
                    onNext={() => handlePage(pagination.currentPage + 1)}
                    label={`${pagination.currentPage} / ${pagination.totalPages}`}
                  />
                </InlineStack>
              </InlineStack>
              <Tabs tabs={stateTabs} selected={stateTabIndex} onSelect={handleStateTabChange} />
              {rows.length === 0 ? (
                <EmptyState heading="該当する明細がありません" image="">
                  <Text as="p" variant="bodyMd">フィルタ条件を変えるか、別の状態タブを選択してください。</Text>
                </EmptyState>
              ) : (
                <IndexTable
                  resourceName={{ singular: "発送明細", plural: "発送明細" }}
                  itemCount={rows.length}
                  selectable={false}
                  sortable={[true, true, true, true, true, false]}
                  sortDirection={currentSortDir === "asc" ? "ascending" : "descending"}
                  sortColumnIndex={sortColumnIndex}
                  defaultSortDirection="descending"
                  onSort={handlePolarisSort}
                  headings={[
                    { title: "商品 / IP" },
                    { title: "お客様" },
                    { title: "注文番号" },
                    { title: "発送日" },
                    { title: "状態" },
                    { title: "アクション" },
                  ]}
                >
                  {rows.map((r: any, idx: number) => (
                    <IndexTable.Row id={r.key} key={r.key} position={idx}>
                      <IndexTable.Cell>
                        <div style={{ maxWidth: 420 }}>
                          <InlineStack gap="200" blockAlign="center" wrap={false}>
                            {r.product_image_url ? (
                              <img src={r.product_image_url} alt={r.product_title} style={{ width: 48, height: 48, objectFit: "cover", borderRadius: 4, border: "1px solid #e5e7eb", flexShrink: 0 }} />
                            ) : (
                              <div style={{ width: 48, height: 48, background: "#f3f4f6", borderRadius: 4, flexShrink: 0 }} />
                            )}
                            <BlockStack gap="050">
                              <div style={{ maxWidth: 340, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.product_title}>
                                <Text as="span" variant="bodyMd" fontWeight="semibold">{r.product_title}</Text>
                              </div>
                              <Text as="span" variant="bodySm" tone="subdued">{r.ip_label} · {r.category}</Text>
                            </BlockStack>
                          </InlineStack>
                        </div>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <div style={{ maxWidth: 220 }}>
                          <BlockStack gap="050">
                            <Text as="span" variant="bodyMd">{r.customer_name}</Text>
                            <div style={{ maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.customer_email}>
                              <Text as="span" variant="bodySm" tone="subdued">{r.customer_email}</Text>
                            </div>
                          </BlockStack>
                        </div>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <Text as="span" variant="bodyMd">{r.order_id}</Text>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <BlockStack gap="050">
                          <Text as="span" variant="bodyMd">{fmtDate(r.fulfilled_at)}</Text>
                          <Text as="span" variant="bodySm" tone="subdued">{fmtRelative(r.fulfilled_at)}</Text>
                        </BlockStack>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <StateBadge state={r.state} />
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        {r.state === "pending_request" ? (
                          <Button size="slim" variant="primary" onClick={() => sendRequest(r)} loading={fetcher.state !== "idle"}>📧 今すぐ依頼</Button>
                        ) : r.state === "requested" ? (
                          <Text as="span" variant="bodySm" tone="subdued">依頼 {fmtDate(r.request_sent_at || "")}</Text>
                        ) : (
                          <Text as="span" variant="bodySm" tone="success">✓ 投稿済</Text>
                        )}
                      </IndexTable.Cell>
                    </IndexTable.Row>
                  ))}
                </IndexTable>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
