import type { LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";

const EXPORT_LIST_QUERY = `#graphql
  query ListAllReviews($first: Int!, $after: String) {
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
              ... on Product { id title handle }
              ... on MediaImage { image { url } }
            }
          }
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

function fieldVal(node: { fields: Array<{ key: string; value: string | null }> }, key: string): string {
  const f = node.fields.find((x) => x.key === key);
  return f?.value ?? "";
}

function refVal(node: { fields: Array<{ key: string; value: string | null; reference: any }> }, key: string): any {
  const f = node.fields.find((x) => x.key === key);
  return f?.reference ?? null;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  // Fetch up to 1000 reviews (paginated 250/page * 4)
  const allNodes: any[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 4; i++) {
    const res = await admin.graphql(EXPORT_LIST_QUERY, {
      variables: { first: 250, after: cursor },
    });
    const json = (await res.json()) as { data?: { metaobjects?: { edges: Array<{ node: any }>; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } };
    const edges = json.data?.metaobjects?.edges ?? [];
    for (const e of edges) allNodes.push(e.node);
    const pi = json.data?.metaobjects?.pageInfo;
    if (!pi?.hasNextPage) break;
    cursor = pi.endCursor;
  }

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
    "photo_1",
    "photo_2",
    "photo_3",
    "photo_4",
    "photo_5",
    "photo_6",
    "approved_at",
    "approved_by",
    "updated_at",
  ];

  const lines: string[] = [];
  lines.push(headers.join(","));

  for (const node of allNodes) {
    const productRef = refVal(node, "product_ref");
    const productHandle = productRef?.handle ?? "";
    const productTitle = productRef?.title ?? "";

    const photoUrls: string[] = [];
    for (let i = 1; i <= 6; i++) {
      const ref = refVal(node, `photo_${i}`);
      photoUrls.push(ref?.image?.url ?? "");
    }

    const row = [
      node.id,
      productHandle,
      productTitle,
      fieldVal(node, "rating"),
      fieldVal(node, "title"),
      fieldVal(node, "body"),
      fieldVal(node, "reviewer_name"),
      fieldVal(node, "reviewer_email"),
      fieldVal(node, "source_type"),
      fieldVal(node, "status"),
      ...photoUrls,
      fieldVal(node, "approved_at"),
      fieldVal(node, "approved_by"),
      node.updatedAt ?? "",
    ];
    lines.push(row.map(csvEscape).join(","));
  }

  // UTF-8 BOM for Excel compatibility
  const csvBody = "﻿" + lines.join("\r\n") + "\r\n";

  const date = new Date().toISOString().slice(0, 10);
  return new Response(csvBody, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="astromeda-reviews-${date}.csv"`,
      "Cache-Control": "no-store",
    },
  });
};
