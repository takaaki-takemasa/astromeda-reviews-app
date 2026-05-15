import type { LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";

// Filter: アクティブな親商品 (templateSuffix が option_parts_pc / pulldown-component 系を除外)
const PRODUCTS_QUERY = `#graphql
  query ListActiveParentProducts($first: Int!, $after: String) {
    products(first: $first, after: $after, query: "status:ACTIVE") {
      edges {
        node {
          id
          title
          handle
          templateSuffix
          tags
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

function csvEscape(value: string | null | undefined): string {
  if (value == null) return "";
  const s = String(value);
  if (s.includes(",") || s.includes("\"") || s.includes("\n") || s.includes("\r")) {
    return "\"" + s.replace(/"/g, "\"\"") + "\"";
  }
  return s;
}

// オプション/部品系を除外する判定
function isParentProduct(node: { templateSuffix: string | null; handle: string; tags: string[] }): boolean {
  // 1. templateSuffix が "option" や "parts" を含むものを除外
  const ts = (node.templateSuffix || "").toLowerCase();
  if (ts.includes("option") || ts.includes("parts") || ts === "option_parts_pc") return false;

  // 2. タグでオプション/部品を除外
  const tags = (node.tags || []).map((t) => t.toLowerCase());
  if (tags.includes("pulldown-component") || tags.includes("option") || tags.includes("part") || tags.includes("オプション") || tags.includes("部品")) return false;

  // 3. handle がオプション系の prefix で始まる場合 (念のため)
  const h = (node.handle || "").toLowerCase();
  if (h.startsWith("option-") || h.startsWith("opt-") || h.startsWith("pulldown-")) return false;

  return true;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  // 最大 1000 商品 (250/ページ × 4)
  const allNodes: Array<{ id: string; title: string; handle: string; templateSuffix: string | null; tags: string[] }> = [];
  let cursor: string | null = null;
  for (let i = 0; i < 4; i++) {
    const res = await admin.graphql(PRODUCTS_QUERY, {
      variables: { first: 250, after: cursor },
    });
    const json = (await res.json()) as { data?: { products?: { edges: Array<{ node: any }>; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } };
    const edges = json.data?.products?.edges ?? [];
    for (const e of edges) allNodes.push(e.node);
    const pi = json.data?.products?.pageInfo;
    if (!pi?.hasNextPage) break;
    cursor = pi.endCursor;
  }

  // 親商品のみフィルター
  const parents = allNodes.filter(isParentProduct);

  // CSV の列: id (空欄 = 新規) + product_handle + product_title + 残りはユーザーが Excel で記入
  const headers = [
    "id",
    "product_handle",
    "product_title",
    "rating",
    "title",
    "body",
    "reviewer_name",
    "reviewer_email",
    "source_type",
    "status",
  ];
  const lines: string[] = [];
  lines.push(headers.join(","));

  for (const node of parents) {
    const row = [
      "", // id は空欄 = 新規作成
      node.handle,
      node.title,
      "", // rating
      "", // title
      "", // body
      "", // reviewer_name
      "", // reviewer_email
      "", // source_type
      "", // status
    ];
    lines.push(row.map(csvEscape).join(","));
  }

  const csvBody = "﻿" + lines.join("\r\n") + "\r\n";
  const date = new Date().toISOString().slice(0, 10);
  return new Response(csvBody, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="astromeda-parent-products-${date}.csv"`,
      "Cache-Control": "no-store",
    },
  });
};
