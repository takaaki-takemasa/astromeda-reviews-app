import {
  Page, Layout, Card, BlockStack, InlineStack, Text, EmptyState, IndexTable, Badge, Tabs,
} from "@shopify/polaris";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useSearchParams } from "@remix-run/react";
import { authenticate } from "../shopify.server";

interface QueueItem {
  id: string;
  order_id: string;
  email: string;
  customer_name: string;
  config_id: string;
  fulfilled_at: string;
  scheduled_at: string;
  sent_at: string;
  status: string;
  error_message: string;
  token_id: string;
  updated_at: string;
}

const LIST_QUERY = `#graphql
  query ListQueue($first: Int!) {
    metaobjects(type: "astromeda_review_email_queue", first: $first, sortKey: "updated_at", reverse: true) {
      edges { node { id updatedAt fields { key value } } }
    }
  }
`;

function field(node: { fields: Array<{ key: string; value: string }> }, key: string): string {
  return node.fields.find((f) => f.key === key)?.value ?? "";
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const tab = url.searchParams.get("tab") ?? "all";
  const response = await admin.graphql(LIST_QUERY, { variables: { first: 50 } });
  const data = (await response.json()) as { data?: { metaobjects?: { edges: Array<{ node: { id: string; updatedAt: string; fields: Array<{ key: string; value: string }> } }> } } };
  const edges = data.data?.metaobjects?.edges ?? [];
  let items: QueueItem[] = edges.map((e) => ({
    id: e.node.id,
    order_id: field(e.node, "order_id"),
    email: field(e.node, "email"),
    customer_name: field(e.node, "customer_name"),
    config_id: field(e.node, "config_id"),
    fulfilled_at: field(e.node, "fulfilled_at"),
    scheduled_at: field(e.node, "scheduled_at"),
    sent_at: field(e.node, "sent_at"),
    status: field(e.node, "status") || "queued",
    error_message: field(e.node, "error_message"),
    token_id: field(e.node, "token_id"),
    updated_at: e.node.updatedAt,
  }));
  if (tab !== "all") items = items.filter((i) => i.status === tab);
  const counts = {
    all: edges.length,
    queued: 0, scheduled: 0, sent: 0, failed: 0,
  };
  edges.forEach((e) => {
    const s = field(e.node, "status") || "queued";
    if (s in counts) (counts as never as Record<string, number>)[s] += 1;
  });
  return { items, tab, counts };
};

export default function QueueTab() {
  const { items, tab, counts } = useLoaderData<typeof loader>();
  const [, setSearchParams] = useSearchParams();
  const tabs = [
    { id: "all", content: `すべて (${counts.all})` },
    { id: "queued", content: `キュー (${counts.queued})` },
    { id: "scheduled", content: `送信予約 (${counts.scheduled})` },
    { id: "sent", content: `送信済 (${counts.sent})` },
    { id: "failed", content: `失敗 (${counts.failed})` },
  ];
  const tabIndex = Math.max(0, tabs.findIndex((t) => t.id === tab));

  return (
    <Page
      title="送信キュー"
      subtitle="Shopify Flow が発火させた送信予約・送信履歴の監視"
    >
      <Layout>
        <Layout.Section>
          <Card>
            <Tabs tabs={tabs} selected={tabIndex} onSelect={(i) => setSearchParams({ tab: tabs[i].id })} />
            {items.length === 0 ? (
              <EmptyState heading={tab === "all" ? "送信予約はまだありません" : "該当する状態の予約はありません"} image="">
                <Text as="p" variant="bodyMd">注文の Shopify Flow (orders/fulfilled トリガー、14 日 delay) から自動でここに送信予約が追加されます。Phase I 連携完了後に流れ始めます。</Text>
              </EmptyState>
            ) : (
              <IndexTable
                resourceName={{ singular: "送信", plural: "送信" }}
                itemCount={items.length}
                selectable={false}
                headings={[
                  { title: "注文 ID" },
                  { title: "宛先" },
                  { title: "発送日" },
                  { title: "送信予定" },
                  { title: "送信日時" },
                  { title: "状態" },
                ]}
              >
                {items.map((q, i) => (
                  <IndexTable.Row id={q.id} key={q.id} position={i}>
                    <IndexTable.Cell>{q.order_id || "—"}</IndexTable.Cell>
                    <IndexTable.Cell><Text as="span" variant="bodyMd">{q.customer_name || "—"} <Text as="span" variant="bodySm" tone="subdued">{q.email}</Text></Text></IndexTable.Cell>
                    <IndexTable.Cell>{q.fulfilled_at ? new Date(q.fulfilled_at).toLocaleDateString("ja-JP") : "—"}</IndexTable.Cell>
                    <IndexTable.Cell>{q.scheduled_at ? new Date(q.scheduled_at).toLocaleString("ja-JP") : "—"}</IndexTable.Cell>
                    <IndexTable.Cell>{q.sent_at ? new Date(q.sent_at).toLocaleString("ja-JP") : "—"}</IndexTable.Cell>
                    <IndexTable.Cell>
                      {q.status === "sent" ? <Badge tone="success">送信済</Badge> :
                       q.status === "scheduled" ? <Badge tone="info">予約済</Badge> :
                       q.status === "failed" ? <Badge tone="critical">失敗</Badge> :
                       <Badge tone="attention">キュー</Badge>}
                    </IndexTable.Cell>
                  </IndexTable.Row>
                ))}
              </IndexTable>
            )}
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
