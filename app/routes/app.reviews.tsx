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
} from "@shopify/polaris";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher, useSearchParams } from "@remix-run/react";
import { useState, useCallback, useMemo } from "react";
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
  const fetcher = useFetcher<typeof action>();
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

  return (
    <Page
      title="レビュー一覧"
      subtitle="お客様から投稿された商品レビューの承認・拒否を管理"
      primaryAction={
        tab === "pending" && selectedResources.length > 0
          ? { content: `${selectedResources.length} 件を承認`, onAction: () => bulkSubmit("approve") }
          : undefined
      }
      secondaryActions={
        tab === "pending" && selectedResources.length > 0
          ? [{ content: `${selectedResources.length} 件を拒否`, destructive: true, onAction: () => bulkSubmit("reject") }]
          : []
      }
    >
      <Layout>
        <Layout.Section>
          {fetcher.data?.ok && fetcher.data.updated && fetcher.data.updated > 0 ? (
            <Banner tone="success" title={`${fetcher.data.updated} 件を更新しました`} onDismiss={() => {}} />
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
    </Page>
  );
}
