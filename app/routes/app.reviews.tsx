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
} from "@shopify/polaris";
import { useAppBridge } from "@shopify/app-bridge-react";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher, useSearchParams } from "@remix-run/react";
import { useState, useCallback, useMemo, useEffect } from "react";
import { authenticate } from "../shopify.server";
import { appendAuditLogSafe } from "../lib/audit-log";

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
  query ListReviews($status: String!, $first: Int!, $after: String) {
    metaobjects(type: "astromeda_review", first: $first, after: $after, query: $status) {
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
    created_at: node.updatedAt,
    product,
    photos,
  };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const tab = (url.searchParams.get("tab") as ReviewStatus | null) ?? "pending";
  const cursor = url.searchParams.get("cursor");

  const statusFilter = `fields.status:"${tab}"`;

  const response = await admin.graphql(LIST_QUERY, {
    variables: { status: statusFilter, first: 20, after: cursor ?? null },
  });
  const data = (await response.json()) as {
    data?: {
      metaobjects?: {
        edges: Array<Parameters<typeof extractReview>[0]>;
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      };
    };
  };

  const edges = data.data?.metaobjects?.edges ?? [];
  const reviews: ReviewItem[] = edges.map(extractReview);

  // Extract shop slug (strip .myshopify.com) for admin URLs
  const shopFull = (session.shop ?? "").toString();
  const shop = shopFull.replace(/\.myshopify\.com$/, "");

  return {
    tab,
    reviews,
    pageInfo: data.data?.metaobjects?.pageInfo ?? { hasNextPage: false, endCursor: null },
    shop,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

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
    const requiredCols = ["product_handle", "rating", "title", "body", "reviewer_name"];
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
        const title = get("title");
        const body = get("body");
        const reviewer_name = get("reviewer_name");
        const reviewer_email = get("reviewer_email");
        let source_type = get("source_type") || "unverified";
        let status = get("status") || "pending";

        if (!handle) throw new Error("product_handle が空");
        const productGid = handleToGid.get(handle);
        if (!productGid) throw new Error(`商品が見つかりません: ${handle}`);
        if (!(rating >= 1 && rating <= 5)) throw new Error(`rating は 1-5: ${get("rating")}`);
        if (!title) throw new Error("title が空");
        if (!body || body.length < 1) throw new Error("body が空");
        if (!reviewer_name) throw new Error("reviewer_name が空");
        const validSource = ["verified_purchase", "gift_recipient", "unverified"];
        if (!validSource.includes(source_type)) source_type = "unverified";
        const validStatus = ["pending", "approved", "rejected"];
        if (!validStatus.includes(status)) status = "pending";

        const fields: Array<{ key: string; value: string }> = [
          { key: "product_ref", value: productGid },
          { key: "rating", value: String(rating) },
          { key: "title", value: title },
          { key: "body", value: body },
          { key: "reviewer_name", value: reviewer_name },
          { key: "reviewer_email", value: reviewer_email || `admin@${session.shop}` },
          { key: "source_type", value: source_type },
          { key: "status", value: status },
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
    if (!title) return { ok: false, error: "タイトルを入力してください", intent };
    if (body.length < 10) return { ok: false, error: "本文を 10 文字以上で入力してください", intent };
    if (!reviewer_name) return { ok: false, error: "表示名を入力してください", intent };

    const fields = [
      { key: "rating", value: String(rating) },
      { key: "title", value: title },
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
    if (!title) return { ok: false, error: "タイトルを入力してください", intent };
    if (body.length < 10) return { ok: false, error: "本文を 10 文字以上で入力してください", intent };
    if (!reviewer_name) return { ok: false, error: "表示名を入力してください", intent };

    const fields = [
      { key: "product_ref", value: productId },
      { key: "rating", value: String(rating) },
      { key: "title", value: title },
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

  return {
    ok: updates.every((u) => u.ok),
    updated: updates.filter((u) => u.ok).length,
    failed: updates.filter((u) => !u.ok).length,
    intent,
  };
};

// ─────────────────────────────────────────────
// Storefront preview card (matches typical Astromeda review card styling)
// ─────────────────────────────────────────────
function ReviewStorefrontPreview({ review }: { review: ReviewItem }) {
  const dateText = new Date(review.created_at).toLocaleDateString("ja-JP", {
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
        {review.title || "(タイトルなし)"}
      </h3>
      <p style={{ margin: 0, fontSize: 14, color: "#374151", lineHeight: 1.8, whiteSpace: "pre-wrap" }}>
        {review.body}
      </p>
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
  const { tab, reviews, pageInfo, shop } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<ActionResult>();
  const detailFetcher = useFetcher<ActionResult>();
  const [, setSearchParams] = useSearchParams();

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

  const bulkSubmit = (intent: "approve" | "reject") => {
    if (selectedResources.length === 0) return;
    const fd = new FormData();
    fd.set("intent", intent);
    fd.set("ids", selectedResources.join(","));
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

  const openImport = useCallback(() => {
    setImportFile(null);
    setImportOpen(true);
  }, []);
  const submitImport = useCallback(() => {
    if (!importFile) return;
    const fd = new FormData();
    fd.set("intent", "import_csv");
    fd.set("file", importFile, importFile.name);
    fetcher.submit(fd, { method: "post", encType: "multipart/form-data" });
  }, [importFile, fetcher]);

  // Close import modal on success
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok && fetcher.data?.intent === "import_csv") {
      // keep modal open to show result, don't reset
    }
  }, [fetcher.state, fetcher.data]);

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
    fd.set("title", formTitle);
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
    !!formTitle.trim() &&
    formBody.trim().length >= 10 &&
    !!formName.trim() &&
    fetcher.state === "idle";

  // ─── Edit-mode state (in detail modal) ───
  const [editMode, setEditMode] = useState(false);
  const [editRating, setEditRating] = useState("5");
  const [editTitle, setEditTitle] = useState("");
  const [editBody, setEditBody] = useState("");
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
    fd.set("title", editTitle);
    fd.set("body", editBody);
    fd.set("reviewer_name", editName);
    fd.set("reviewer_email", editEmail);
    fetcher.submit(fd, { method: "post" });
  }, [detailReview, editRating, editTitle, editBody, editName, editEmail, fetcher]);

  const canSubmitEdit =
    !!detailReview &&
    !!editTitle.trim() &&
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
    { id: "pending", content: "承認待ち" },
    { id: "approved", content: "公開中" },
    { id: "rejected", content: "拒否" },
  ];

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
        <Text as="span" variant="bodyMd" fontWeight="semibold">
          {"★".repeat(r.rating)}
          <span style={{ color: "#ccc" }}>{"★".repeat(Math.max(0, 5 - r.rating))}</span>
        </Text>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <InlineStack gap="200" blockAlign="center" wrap={false}>
          {r.product?.image_url ? (
            <Thumbnail source={r.product.image_url} alt={r.product.title} size="small" />
          ) : (
            <div style={{ width: 40, height: 40, background: "#f3f4f6", borderRadius: 4, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, color: "#9ca3af" }}>NO IMG</div>
          )}
          <Text as="span" variant="bodySm" truncate>
            {r.product?.title || "(商品削除)"}
          </Text>
        </InlineStack>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <BlockStack gap="050">
          <Text as="span" variant="bodyMd" fontWeight="semibold" truncate>
            {r.title || "(タイトルなし)"}
          </Text>
          <Text as="span" variant="bodySm" tone="subdued" truncate>
            {r.body.slice(0, 80)}
            {r.body.length > 80 ? "…" : ""}
          </Text>
        </BlockStack>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <BlockStack gap="050">
          <Text as="span" variant="bodyMd">{r.reviewer_name || "—"}</Text>
          {r.reviewer_email ? (
            <Text as="span" variant="bodySm" tone="subdued" truncate>{r.reviewer_email}</Text>
          ) : null}
        </BlockStack>
      </IndexTable.Cell>
      <IndexTable.Cell>{sourceBadge(r.source_type)}</IndexTable.Cell>
      <IndexTable.Cell>{statusBadge(r.status)}</IndexTable.Cell>
      <IndexTable.Cell>
        <Text as="span" variant="bodySm">
          {new Date(r.created_at).toLocaleDateString("ja-JP")}
        </Text>
      </IndexTable.Cell>
    </IndexTable.Row>
  ));

  return (
    <Page
      title="レビュー一覧"
      subtitle="行をクリックすると詳細とストアフロントプレビューを表示します"
      primaryAction={{ content: "新規レビューを作成", onAction: openCreate }}
      secondaryActions={
        tab === "pending" && selectedResources.length > 0
          ? [
              { content: `${selectedResources.length} 件を承認`, onAction: () => bulkSubmit("approve") },
              { content: `${selectedResources.length} 件を拒否`, destructive: true, onAction: () => bulkSubmit("reject") },
            ]
          : []
      }
    >
      <Layout>
        <Layout.Section>
          {fetcher.data?.ok && fetcher.data.updated && fetcher.data.updated > 0 ? (
            <Banner tone="success" title={`${fetcher.data.updated} 件を更新しました`} onDismiss={() => {}} />
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

          <Card>
            <BlockStack gap="0">
              <Tabs tabs={tabs} selected={tabIndex < 0 ? 0 : tabIndex} onSelect={handleTabChange} />
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
                    { title: "レビュー (タイトル/本文抜粋)" },
                    { title: "投稿者" },
                    { title: "経路" },
                    { title: "状態" },
                    { title: "投稿日" },
                  ]}
                  selectable={tab === "pending"}
                >
                  {rows}
                </IndexTable>
              )}
            </BlockStack>
          </Card>

          {pageInfo.hasNextPage ? (
            <InlineStack align="end">
              <Pagination
                hasNext={pageInfo.hasNextPage}
                onNext={() => setSearchParams({ tab, cursor: pageInfo.endCursor ?? "" })}
                hasPrevious={false}
                onPrevious={() => {}}
              />
            </InlineStack>
          ) : null}
        </Layout.Section>
      </Layout>

      {/* ─── Detail modal ─── */}
      <Modal
        open={!!detailReview}
        onClose={closeDetail}
        title={detailReview ? `レビュー詳細 — ${detailReview.title || "(タイトルなし)"}` : "詳細"}
        size="large"
        primaryAction={
          detailReview && detailReview.status === "pending"
            ? {
                content: "承認して公開",
                onAction: () => handleDetailAction("approve"),
                loading: fetcher.state === "submitting",
              }
            : { content: "閉じる", onAction: closeDetail }
        }
        secondaryActions={
          detailReview && detailReview.status === "pending"
            ? [
                { content: "拒否する", destructive: true, onAction: () => handleDetailAction("reject"), loading: fetcher.state === "submitting" },
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
                        <Thumbnail source={detailReview.product.image_url} alt={detailReview.product.title} size="medium" />
                      ) : null}
                      <BlockStack gap="100">
                        <Text as="span" variant="bodyMd" fontWeight="bold">{detailReview.product.title}</Text>
                        <Text as="span" variant="bodySm" tone="subdued">{detailReview.product.id}</Text>
                        <InlineStack gap="300">
                          <Link
                            url={`https://admin.shopify.com/store/${shop}/products/${detailReview.product.id.split("/").pop()}`}
                            external
                          >
                            管理画面で開く
                          </Link>
                          {detailReview.product.handle ? (
                            <Link url={`https://shop.mining-base.co.jp/products/${detailReview.product.handle}`} external>
                              ストアフロントで開く
                            </Link>
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
                        <Link url={`https://admin.shopify.com/store/${shop}/orders/${detailExtras.order.id.split("/").pop()}`} external>{detailExtras.order.name}</Link>
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
                        label="タイトル"
                        value={editTitle}
                        onChange={setEditTitle}
                        autoComplete="off"
                        maxLength={60}
                        showCharacterCount
                        requiredIndicator
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
                      <Text as="h4" variant="headingMd">{detailReview.title || "(タイトルなし)"}</Text>
                      <div style={{ whiteSpace: "pre-wrap", padding: "8px 12px", background: "#f9fafb", borderRadius: 8, fontSize: 14, lineHeight: 1.8 }}>
                        {detailReview.body}
                      </div>
                      <Text as="p" variant="bodySm" tone="subdued">
                        投稿日時: {new Date(detailReview.created_at).toLocaleString("ja-JP")}
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
                    <ReviewStorefrontPreview review={detailReview} />
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
                label="タイトル"
                value={formTitle}
                onChange={setFormTitle}
                autoComplete="off"
                maxLength={60}
                showCharacterCount
                placeholder="例: 想像以上の高品質でした"
                requiredIndicator
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
        onClose={() => setImportOpen(false)}
        title="CSV を取り込み"
        primaryAction={{
          content: fetcher.state === "submitting" && fetcher.data?.intent !== "import_csv" ? "取り込み..." : (fetcher.state === "submitting" ? "取り込み中..." : "実行"),
          onAction: submitImport,
          disabled: !importFile || fetcher.state === "submitting",
          loading: fetcher.state === "submitting",
        }}
        secondaryActions={[{ content: "閉じる", onAction: () => setImportOpen(false) }]}
      >
        <Modal.Section>
          <BlockStack gap="400">
            <Banner tone="info">
              <Text as="p" variant="bodySm">
                CSV の列: id (空欄で新規 / gid で更新) / product_handle (必須) / rating (1-5 必須) / title (必須) / body (必須) / reviewer_name (必須) / reviewer_email / source_type (verified_purchase | gift_recipient | unverified) / status (pending | approved | rejected) / photo_1..6 / approved_at / approved_by / updated_at
              </Text>
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
            {fetcher.data?.intent === "import_csv" && fetcher.data?.ok && fetcher.data?.csvImport ? (
              <Banner tone="success" title="取り込み完了">
                <Text as="p" variant="bodySm">
                  作成: {fetcher.data.csvImport.created} 件 / 更新: {fetcher.data.csvImport.updated} 件 / エラー: {fetcher.data.csvImport.errors.length} 件
                </Text>
                {fetcher.data.csvImport.errors.length > 0 ? (
                  <Box paddingBlockStart="200">
                    <Text as="p" variant="bodySm" tone="critical">エラー詳細 (最大10件):</Text>
                    <ul style={{ marginTop: 6, paddingLeft: 18, fontSize: 12 }}>
                      {fetcher.data.csvImport.errors.slice(0, 10).map((e: any, i: number) => (
                        <li key={i}>行 {e.row}: {e.error}</li>
                      ))}
                    </ul>
                  </Box>
                ) : null}
              </Banner>
            ) : null}
          </BlockStack>
        </Modal.Section>
      </Modal>
    </Page>
  );
}
