import {
  Page, Layout, Card, BlockStack, InlineStack, Text, EmptyState, IndexTable, Badge,
  Button, Modal, TextField, FormLayout, Banner, Tabs,
} from "@shopify/polaris";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher, useRevalidator, useSearchParams } from "@remix-run/react";
import { useState, useCallback } from "react";
import { authenticate } from "../shopify.server";
import { appendAuditLogSafe } from "../lib/audit-log";

interface Token {
  id: string;
  token: string;
  email: string;
  customer_name: string;
  order_id: string;
  token_type: string;
  expires_at: string;
  used_at: string;
  issued_by: string;
  gift_note: string;
  created_at: string;
}

const LIST_QUERY = `#graphql
  query ListTokens($first: Int!) {
    metaobjects(type: "astromeda_review_token", first: $first, sortKey: "updated_at", reverse: true) {
      edges { node { id updatedAt fields { key value } } }
    }
  }
`;

const CREATE_MUTATION = `#graphql
  mutation CreateToken($metaobject: MetaobjectCreateInput!) {
    metaobjectCreate(metaobject: $metaobject) {
      metaobject { id handle }
      userErrors { field message code }
    }
  }
`;

function field(node: { fields: Array<{ key: string; value: string }> }, key: string): string {
  return node.fields.find((f) => f.key === key)?.value ?? "";
}

function generateToken(): string {
  // UUID v4-ish using crypto.randomUUID if available
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const tab = url.searchParams.get("tab") ?? "all"; // all | gift | purchase | expired
  const response = await admin.graphql(LIST_QUERY, { variables: { first: 50 } });
  const data = (await response.json()) as { data?: { metaobjects?: { edges: Array<{ node: { id: string; updatedAt: string; fields: Array<{ key: string; value: string }> } }> } } };
  const edges = data.data?.metaobjects?.edges ?? [];
  let tokens: Token[] = edges.map((e) => ({
    id: e.node.id,
    token: field(e.node, "token"),
    email: field(e.node, "email"),
    customer_name: field(e.node, "customer_name"),
    order_id: field(e.node, "order_id"),
    token_type: field(e.node, "token_type") || "purchase",
    expires_at: field(e.node, "expires_at"),
    used_at: field(e.node, "used_at"),
    issued_by: field(e.node, "issued_by"),
    gift_note: field(e.node, "gift_note"),
    created_at: e.node.updatedAt,
  }));
  const now = Date.now();
  if (tab === "gift") tokens = tokens.filter((t) => t.token_type === "gift");
  else if (tab === "purchase") tokens = tokens.filter((t) => t.token_type === "purchase");
  else if (tab === "expired") tokens = tokens.filter((t) => t.expires_at && new Date(t.expires_at).getTime() < now);

  return { tokens, tab };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "issue");

  if (intent === "issue") {
    const email = String(formData.get("email") || "");
    const customer_name = String(formData.get("customer_name") || "");
    const order_id = String(formData.get("order_id") || "");
    const gift_note = String(formData.get("gift_note") || "");
    const expires_days = Number(formData.get("expires_days") || 90);
    const token = generateToken();
    const expires_at = new Date(Date.now() + expires_days * 24 * 60 * 60 * 1000).toISOString();

    const fields = [
      { key: "token", value: token },
      { key: "email", value: email },
      { key: "customer_name", value: customer_name },
      { key: "order_id", value: order_id },
      { key: "token_type", value: "gift" },
      { key: "expires_at", value: expires_at },
      { key: "issued_by", value: session.shop },
      { key: "gift_note", value: gift_note },
    ];
    const res = await admin.graphql(CREATE_MUTATION, { variables: { metaobject: { type: "astromeda_review_token", fields } } });
    const json = (await res.json()) as { data?: { metaobjectCreate?: { metaobject?: { id: string }; userErrors: Array<{ field: string[]; message: string }> } } };
    const errs = json.data?.metaobjectCreate?.userErrors ?? [];
    const newId = json.data?.metaobjectCreate?.metaobject?.id;
    if (newId) {
      await appendAuditLogSafe({ admin, actor: session.shop, action: "token.issue", resource_id: newId, resource_type: "astromeda_review_token", request, metadata: { token_type: "gift", email, order_id } });
    }
    return { ok: errs.length === 0, id: newId, token, errors: errs };
  }

  return { ok: false, error: "unknown intent" };
};

const STORE_DOMAIN = "shop.mining-base.co.jp";

export default function TokensTab() {
  const { tokens, tab } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const revalidator = useRevalidator();
  const [, setSearchParams] = useSearchParams();
  const [modalOpen, setModalOpen] = useState(false);
  const [form, setForm] = useState({ email: "", customer_name: "", order_id: "", gift_note: "", expires_days: 90 });

  const submit = useCallback(() => {
    const fd = new FormData();
    fd.set("intent", "issue");
    fd.set("email", form.email);
    fd.set("customer_name", form.customer_name);
    fd.set("order_id", form.order_id);
    fd.set("gift_note", form.gift_note);
    fd.set("expires_days", String(form.expires_days));
    fetcher.submit(fd, { method: "post" });
    setModalOpen(false);
    setForm({ email: "", customer_name: "", order_id: "", gift_note: "", expires_days: 90 });
    setTimeout(() => revalidator.revalidate(), 500);
  }, [form, fetcher, revalidator]);

  const tabs = [
    { id: "all", content: "すべて" },
    { id: "gift", content: "ギフト" },
    { id: "purchase", content: "購入" },
    { id: "expired", content: "期限切れ" },
  ];
  const tabIndex = Math.max(0, tabs.findIndex((t) => t.id === tab));

  const copy = (token: string) => {
    const url = `https://${STORE_DOMAIN}/apps/reviews-1/submit?token=${token}`;
    if (typeof navigator !== "undefined" && navigator.clipboard) navigator.clipboard.writeText(url);
  };

  return (
    <Page
      title="ギフトトークン"
      subtitle="ギフト受領者向けレビュー招待 URL を発行・管理"
      primaryAction={{ content: "ギフトトークンを発行", onAction: () => setModalOpen(true) }}
    >
      <Layout>
        <Layout.Section>
          {fetcher.data?.ok && fetcher.data.token ? (
            <Banner tone="success" title="トークンを発行しました" onDismiss={() => {}}>
              <BlockStack gap="200">
                <Text as="p" variant="bodyMd">送信用 URL (クリップボードにコピー、メールでお客様に送付):</Text>
                <Text as="p" variant="bodySm" tone="subdued">https://{STORE_DOMAIN}/apps/reviews-1/submit?token={fetcher.data.token}</Text>
                <InlineStack><Button onClick={() => copy(fetcher.data!.token!)}>URL をコピー</Button></InlineStack>
              </BlockStack>
            </Banner>
          ) : null}
          {fetcher.data && !fetcher.data.ok ? <Banner tone="critical" title="発行に失敗しました" onDismiss={() => {}} /> : null}

          <Card>
            <Tabs tabs={tabs} selected={tabIndex} onSelect={(i) => setSearchParams({ tab: tabs[i].id })} />
            {tokens.length === 0 ? (
              <EmptyState heading="該当するトークンはありません" image="" action={{ content: "新規発行", onAction: () => setModalOpen(true) }}>
                <Text as="p" variant="bodyMd">ギフトプレゼントを受け取ったお客様が、購入者を経由せずレビュー投稿できるトークン URL をここから発行します。</Text>
              </EmptyState>
            ) : (
              <IndexTable
                resourceName={{ singular: "トークン", plural: "トークン" }}
                itemCount={tokens.length}
                selectable={false}
                headings={[
                  { title: "種別" },
                  { title: "宛先" },
                  { title: "注文 ID" },
                  { title: "期限" },
                  { title: "状態" },
                  { title: "操作" },
                ]}
              >
                {tokens.map((t, i) => {
                  const expired = t.expires_at && new Date(t.expires_at).getTime() < Date.now();
                  const used = !!t.used_at;
                  return (
                    <IndexTable.Row id={t.id} key={t.id} position={i}>
                      <IndexTable.Cell>{t.token_type === "gift" ? <Badge tone="info">ギフト</Badge> : <Badge tone="success">購入</Badge>}</IndexTable.Cell>
                      <IndexTable.Cell><Text as="span" variant="bodyMd">{t.customer_name || "—"} <Text as="span" variant="bodySm" tone="subdued">{t.email}</Text></Text></IndexTable.Cell>
                      <IndexTable.Cell>{t.order_id || "—"}</IndexTable.Cell>
                      <IndexTable.Cell>{t.expires_at ? new Date(t.expires_at).toLocaleDateString("ja-JP") : "—"}</IndexTable.Cell>
                      <IndexTable.Cell>
                        {used ? <Badge tone="success">使用済</Badge> : expired ? <Badge tone="critical">期限切れ</Badge> : <Badge tone="attention">未使用</Badge>}
                      </IndexTable.Cell>
                      <IndexTable.Cell>{!used && !expired ? <Button onClick={() => copy(t.token)} variant="plain">URL コピー</Button> : null}</IndexTable.Cell>
                    </IndexTable.Row>
                  );
                })}
              </IndexTable>
            )}
          </Card>
        </Layout.Section>
      </Layout>

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title="ギフトトークンを発行"
        primaryAction={{ content: "発行", onAction: submit, disabled: !form.email }}
        secondaryActions={[{ content: "キャンセル", onAction: () => setModalOpen(false) }]}
      >
        <Modal.Section>
          <FormLayout>
            <TextField label="お客様のメールアドレス" type="email" autoComplete="email" value={form.email} onChange={(v) => setForm({ ...form, email: v })} requiredIndicator />
            <TextField label="お客様の氏名" autoComplete="off" value={form.customer_name} onChange={(v) => setForm({ ...form, customer_name: v })} />
            <TextField label="注文 ID (任意)" autoComplete="off" value={form.order_id} onChange={(v) => setForm({ ...form, order_id: v })} helpText="ギフト元の注文 ID を記録すると追跡が楽です" />
            <TextField label="ギフトメッセージ (任意)" autoComplete="off" multiline={3} value={form.gift_note} onChange={(v) => setForm({ ...form, gift_note: v })} />
            <TextField label="有効期限 (日)" type="number" min={7} max={365} autoComplete="off" value={String(form.expires_days)} onChange={(v) => setForm({ ...form, expires_days: Number(v) || 90 })} />
          </FormLayout>
        </Modal.Section>
      </Modal>
    </Page>
  );
}
