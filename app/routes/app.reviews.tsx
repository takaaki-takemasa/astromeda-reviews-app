import {
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
  Tooltip,
  Modal,
  TextField,
  Select,
  FormLayout,
  Thumbnail,
} from "@shopify/polaris";
import { useAppBridge } from "@shopify/app-bridge-react";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher, useSearchParams } from "@remix-run/react";
import { useState, useCallback, useMemo, useEffect } from "react";
import { authenticate } from "../shopify.server";
import { appendAuditLogSafe } from "../lib/audit-log";

type ReviewStatus = "pending" | "approved" | "rejected";

interface ReviewItem {
  id: string;
  rating: number;
  title: string;
  body: string;
  reviewer_name: string;
  status: ReviewStatus;
  source_type: string;
  created_at: string;
}

// Unified action return shape — fields are optional per branch
interface ActionResult {
  ok: boolean;
  error?: string;
  // bulk approve/reject
  updated?: number;
  failed?: number;
  details?: Array<{ id: string; ok: boolean; errors: Array<{ field: string[]; message: string }> }>;
  // create
  created?: number;
  new_id?: string | null;
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
          }
        }
        cursor
      }
      pageInfo {
        hasNextPage
        endCursor
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

function extractField(node: { fields: Array<{ key: string; value: string }> }, key: string): string {
  return node.fields.find((f) => f.key === key)?.value ?? "";
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const tab = (url.searchParams.get("tab") as ReviewStatus | null) ?? "pending";
  const cursor = url.searchParams.get("cursor");

  // Use search query syntax: `fields:status = "pending"` (Shopify Admin metaobjects search syntax)
  const statusFilter = `fields.status:"${tab}"`;

  const response = await admin.graphql(LIST_QUERY, {
    variables: { status: statusFilter, first: 20, after: cursor ?? null },
  });
  const data = (await response.json()) as {
    data?: {
      metaobjects?: {
        edges: Array<{
          node: { id: string; handle: string; updatedAt: string; fields: Array<{ key: string; value: string }> };
          cursor: string;
        }>;
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      };
    };
  };

  const edges = data.data?.metaobjects?.edges ?? [];
  const reviews: ReviewItem[] = edges.map((e) => ({
    id: e.node.id,
    rating: Number(extractField(e.node, "rating") || 0),
    title: extractField(e.node, "title"),
    body: extractField(e.node, "body"),
    reviewer_name: extractField(e.node, "reviewer_name"),
    status: (extractField(e.node, "status") as ReviewStatus) || "pending",
    source_type: extractField(e.node, "source_type"),
    created_at: e.node.updatedAt,
  }));

  return {
    tab,
    reviews,
    pageInfo: data.data?.metaobjects?.pageInfo ?? { hasNextPage: false, endCursor: null },
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  // ─── intent: create (admin-authored review) ───
  if (intent === "create") {
    const productId = String(formData.get("productId") || "").trim();
    const rating = Number(formData.get("rating") || 0);
    const title = String(formData.get("title") || "").trim().slice(0, 60);
    const body = String(formData.get("body") || "").trim().slice(0, 1000);
    const reviewer_name = String(formData.get("reviewer_name") || "").trim().slice(0, 40);
    const reviewer_email = String(formData.get("reviewer_email") || "").trim().slice(0, 200);

    if (!productId.startsWith("gid://shopify/Product/")) return { ok: false, error: "商品を選択してください" };
    if (rating < 1 || rating > 5) return { ok: false, error: "評価を 1〜5 で選択してください" };
    if (!title) return { ok: false, error: "タイトルを入力してください" };
    if (body.length < 10) return { ok: false, error: "本文を 10 文字以上で入力してください" };
    if (!reviewer_name) return { ok: false, error: "表示名を入力してください" };

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
      return { ok: false, error: `保存失敗: ${errs.map((e) => e.message).join(", ")}` };
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

    return { ok: true, created: 1, new_id: newId };
  }

  // ─── intent: approve / reject (bulk) ───
  const idsRaw = formData.get("ids") as string | null;
  const ids = idsRaw ? idsRaw.split(",") : [];

  if (!intent || ids.length === 0) {
    return { ok: false, error: "intent or ids missing" };
  }

  const targetStatus = intent === "approve" ? "approved" : intent === "reject" ? "rejected" : null;
  if (!targetStatus) return { ok: false, error: "invalid intent" };

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
      // Best-effort audit log (per ID)
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
    details: updates,
  };
};

export default function ReviewsTab() {
  const { tab, reviews, pageInfo } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<ActionResult>();
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

  const tabs = [
    { id: "pending", content: "承認待ち" },
    { id: "approved", content: "公開中" },
    { id: "rejected", content: "拒否" },
  ];

  const rows = reviews.map((r, idx) => (
    <IndexTable.Row id={r.id} key={r.id} position={idx} selected={selectedResources.includes(r.id)}>
      <IndexTable.Cell>
        <Text as="span" variant="bodyMd" fontWeight="semibold">{"★".repeat(r.rating)}<span style={{ color: "#ccc" }}>{"★".repeat(Math.max(0, 5 - r.rating))}</span></Text>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <Text as="span" variant="bodyMd" fontWeight="semibold">{r.title || "(タイトルなし)"}</Text>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <Tooltip content={r.body}><Text as="span" variant="bodySm" tone="subdued">{r.body.slice(0, 60)}{r.body.length > 60 ? "…" : ""}</Text></Tooltip>
      </IndexTable.Cell>
      <IndexTable.Cell>{r.reviewer_name || "—"}</IndexTable.Cell>
      <IndexTable.Cell>
        {r.source_type === "verified_purchase" ? <Badge tone="success">認証購入</Badge> : r.source_type === "gift" ? <Badge tone="info">ギフト</Badge> : <Badge>{r.source_type || "不明"}</Badge>}
      </IndexTable.Cell>
      <IndexTable.Cell>
        {r.status === "pending" ? <Badge tone="attention">承認待ち</Badge> : r.status === "approved" ? <Badge tone="success">公開中</Badge> : <Badge tone="critical">拒否</Badge>}
      </IndexTable.Cell>
      <IndexTable.Cell>{new Date(r.created_at).toLocaleString("ja-JP")}</IndexTable.Cell>
    </IndexTable.Row>
  ));

  // ─── Admin-create modal state ───
  const shopify = useAppBridge();
  const [createOpen, setCreateOpen] = useState(false);
  const [pickedProduct, setPickedProduct] = useState<{ id: string; title: string; image?: string | null } | null>(null);
  const [formRating, setFormRating] = useState("5");
  const [formTitle, setFormTitle] = useState("");
  const [formBody, setFormBody] = useState("");
  const [formName, setFormName] = useState("ASTROMEDA 編集部");
  const [formEmail, setFormEmail] = useState("");

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

  // Close modal on successful create
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok && fetcher.data?.created) {
      setCreateOpen(false);
    }
  }, [fetcher.state, fetcher.data]);

  const canSubmitCreate =
    !!pickedProduct &&
    !!formTitle.trim() &&
    formBody.trim().length >= 10 &&
    !!formName.trim() &&
    fetcher.state === "idle";

  return (
    <Page
      title="レビュー一覧"
      subtitle="お客様から投稿された商品レビューの承認・拒否を管理"
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
          {fetcher.data && !fetcher.data.ok ? (
            <Banner tone="critical" title="一部の更新に失敗しました" onDismiss={() => {}}>
              <Text as="p" variant="bodySm">失敗: {fetcher.data.failed ?? 0} 件</Text>
            </Banner>
          ) : null}

          <Card>
            <BlockStack gap="0">
              <Tabs tabs={tabs} selected={tabIndex < 0 ? 0 : tabIndex} onSelect={handleTabChange} />
              {reviews.length === 0 ? (
                <EmptyState heading={tab === "pending" ? "承認待ちのレビューはありません" : tab === "approved" ? "公開中のレビューはまだありません" : "拒否されたレビューはありません"} image="">
                  <Text as="p" variant="bodyMd">注文発送 14 日後に Shopify Flow から自動でレビュー依頼メールが送信され、お客様が投稿すると ここに承認待ちレビューが表示されます。</Text>
                </EmptyState>
              ) : (
                <IndexTable
                  resourceName={resourceName}
                  itemCount={reviews.length}
                  selectedItemsCount={allResourcesSelected ? "All" : selectedResources.length}
                  onSelectionChange={handleSelectionChange}
                  headings={[
                    { title: "評価" },
                    { title: "タイトル" },
                    { title: "本文" },
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
              {/* Product picker */}
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

              {fetcher.data && !fetcher.data.ok && fetcher.data.error ? (
                <Banner tone="critical" title={fetcher.data.error} onDismiss={() => {}} />
              ) : null}
            </FormLayout>
          </BlockStack>
        </Modal.Section>
      </Modal>
    </Page>
  );
}
