import {
  Page, Layout, Card, BlockStack, InlineStack, Text, EmptyState, IndexTable, Badge,
  Button, Modal, TextField, FormLayout, Checkbox, Banner, Select, Box, Divider,
  InlineGrid,
} from "@shopify/polaris";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher, useRevalidator } from "@remix-run/react";
import { useState, useCallback, useEffect, useMemo } from "react";
import { authenticate } from "../shopify.server";
import { appendAuditLogSafe } from "../lib/audit-log";

type TargetType = "collection" | "product_tag" | "category" | "all";

interface EmailConfig {
  id: string;
  target_type: TargetType;
  target_handle: string;
  target_label: string;
  enabled: boolean;
  delay_days: number;
  subject: string;
  body_template: string;
  reply_to: string;
  incentive_text: string;
  last_modified_at: string;
  last_modified_by: string;
}

interface CollectionOption { handle: string; title: string; productCount: number; }
interface ProductTagOption { tag: string; count: number; }

const LIST_QUERY = `#graphql
  query ListEmailConfigs($first: Int!) {
    metaobjects(type: "astromeda_review_email_config", first: $first) {
      edges {
        node {
          id handle updatedAt
          fields { key value }
        }
      }
    }
  }
`;

const COLLECTIONS_QUERY = `#graphql
  query ListCollections($first: Int!, $after: String) {
    collections(first: $first, after: $after, sortKey: TITLE) {
      edges {
        cursor
        node { id handle title productsCount { count } }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const PRODUCT_TAGS_QUERY = `#graphql
  query ListProductTags($first: Int!) {
    productTags(first: $first) {
      edges { node }
    }
  }
`;

const ORDERS_LAST_30D_COUNT_QUERY = `#graphql
  query CountFulfilledOrdersLast30Days {
    ordersCount(query: "fulfillment_status:shipped AND created_at:>=2026-04-14") {
      count precision
    }
  }
`;

const CREATE_MUTATION = `#graphql
  mutation CreateEmailConfig($metaobject: MetaobjectCreateInput!) {
    metaobjectCreate(metaobject: $metaobject) {
      metaobject { id }
      userErrors { field message code }
    }
  }
`;

const UPDATE_MUTATION = `#graphql
  mutation UpdateEmailConfig($id: ID!, $fields: [MetaobjectFieldInput!]!) {
    metaobjectUpdate(id: $id, metaobject: { fields: $fields }) {
      metaobject { id }
      userErrors { field message code }
    }
  }
`;

const DELETE_MUTATION = `#graphql
  mutation DeleteEmailConfig($id: ID!) {
    metaobjectDelete(id: $id) {
      deletedId
      userErrors { field message code }
    }
  }
`;

function extractField(node: { fields: Array<{ key: string; value: string }> }, key: string): string {
  return node.fields.find((f) => f.key === key)?.value ?? "";
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  // Parallel fetch: configs / collections / product tags / orders count
  const [cfgRes, colRes, tagRes, orderRes] = await Promise.all([
    admin.graphql(LIST_QUERY, { variables: { first: 50 } }),
    admin.graphql(COLLECTIONS_QUERY, { variables: { first: 100, after: null } }),
    admin.graphql(PRODUCT_TAGS_QUERY, { variables: { first: 250 } }),
    admin.graphql(ORDERS_LAST_30D_COUNT_QUERY).catch(() => null),
  ]);

  const cfgJson = (await cfgRes.json()) as { data?: { metaobjects?: { edges: Array<{ node: { id: string; updatedAt: string; fields: Array<{ key: string; value: string }> } }> } } };
  const colJson = (await colRes.json()) as { data?: { collections?: { edges: Array<{ node: { id: string; handle: string; title: string; productsCount?: { count: number } } }> } } };
  const tagJson = (await tagRes.json()) as { data?: { productTags?: { edges: Array<{ node: string }> } } };
  const orderJson = orderRes ? (await orderRes.json()) as { data?: { ordersCount?: { count: number; precision: string } } } : null;

  const configs: EmailConfig[] = (cfgJson.data?.metaobjects?.edges ?? []).map((e) => ({
    id: e.node.id,
    target_type: (extractField(e.node, "target_type") as TargetType) || "all",
    target_handle: extractField(e.node, "target_handle"),
    target_label: extractField(e.node, "target_label"),
    enabled: extractField(e.node, "enabled") === "true",
    delay_days: Number(extractField(e.node, "delay_days") || 14),
    subject: extractField(e.node, "subject"),
    body_template: extractField(e.node, "body_template"),
    reply_to: extractField(e.node, "reply_to"),
    incentive_text: extractField(e.node, "incentive_text"),
    last_modified_at: e.node.updatedAt,
    last_modified_by: extractField(e.node, "last_modified_by"),
  }));

  const collections: CollectionOption[] = (colJson.data?.collections?.edges ?? []).map((e) => ({
    handle: e.node.handle,
    title: e.node.title,
    productCount: e.node.productsCount?.count ?? 0,
  }));

  const tags: ProductTagOption[] = (tagJson.data?.productTags?.edges ?? [])
    .map((e) => ({ tag: e.node, count: 0 }))
    .filter((t) => t.tag && t.tag.length > 0);

  const ordersLast30Days = orderJson?.data?.ordersCount?.count ?? 0;

  return { configs, collections, tags, ordersLast30Days };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");
  const id = formData.get("id") ? String(formData.get("id")) : null;
  const nowIso = new Date().toISOString();

  const baseFields = ["target_type","target_handle","target_label","enabled","delay_days","subject","body_template","reply_to","incentive_text"]
    .map((k) => {
      const v = formData.get(k);
      if (v === null) return null;
      return { key: k, value: String(v) };
    })
    .filter((x): x is { key: string; value: string } => x !== null);

  const trailFields = [
    { key: "last_modified_at", value: nowIso },
    { key: "last_modified_by", value: session.shop },
  ];

  if (intent === "create") {
    const res = await admin.graphql(CREATE_MUTATION, { variables: { metaobject: { type: "astromeda_review_email_config", fields: [...baseFields, ...trailFields] } } });
    const json = (await res.json()) as { data?: { metaobjectCreate?: { metaobject?: { id: string }; userErrors: Array<{ field: string[]; message: string }> } } };
    const errs = json.data?.metaobjectCreate?.userErrors ?? [];
    const newId = json.data?.metaobjectCreate?.metaobject?.id;
    if (newId) await appendAuditLogSafe({ admin, actor: session.shop, action: "config.update", resource_id: newId, resource_type: "astromeda_review_email_config", request, metadata: { intent: "create" } });
    return { ok: errs.length === 0, id: newId, errors: errs };
  }
  if (intent === "update" && id) {
    const res = await admin.graphql(UPDATE_MUTATION, { variables: { id, fields: [...baseFields, ...trailFields] } });
    const json = (await res.json()) as { data?: { metaobjectUpdate?: { userErrors: Array<{ field: string[]; message: string }> } } };
    const errs = json.data?.metaobjectUpdate?.userErrors ?? [];
    await appendAuditLogSafe({ admin, actor: session.shop, action: "config.update", resource_id: id, resource_type: "astromeda_review_email_config", request });
    return { ok: errs.length === 0, errors: errs };
  }
  if (intent === "delete" && id) {
    const res = await admin.graphql(DELETE_MUTATION, { variables: { id } });
    const json = (await res.json()) as { data?: { metaobjectDelete?: { userErrors: Array<{ field: string[]; message: string }> } } };
    const errs = json.data?.metaobjectDelete?.userErrors ?? [];
    await appendAuditLogSafe({ admin, actor: session.shop, action: "config.update", resource_id: id, resource_type: "astromeda_review_email_config", request, metadata: { intent: "delete" } });
    return { ok: errs.length === 0, errors: errs };
  }
  if (intent === "toggle" && id) {
    const enabled = String(formData.get("enabled")) === "true";
    const fields = [
      { key: "enabled", value: enabled ? "true" : "false" },
      ...(enabled ? [{ key: "enabled_at", value: nowIso }, { key: "enabled_by", value: session.shop }] : []),
      ...trailFields,
    ];
    const res = await admin.graphql(UPDATE_MUTATION, { variables: { id, fields } });
    const json = (await res.json()) as { data?: { metaobjectUpdate?: { userErrors: Array<{ field: string[]; message: string }> } } };
    const errs = json.data?.metaobjectUpdate?.userErrors ?? [];
    await appendAuditLogSafe({ admin, actor: session.shop, action: enabled ? "config.enable" : "config.disable", resource_id: id, resource_type: "astromeda_review_email_config", request });
    return { ok: errs.length === 0, errors: errs };
  }
  return { ok: false, error: "unknown intent" };
};

const PREDEFINED_CATEGORIES = [
  { label: "ゲーミングPC", value: "gaming-pc" },
  { label: "クリエイターPC", value: "creator-pc" },
  { label: "ストリーマーPC", value: "streamer-pc" },
  { label: "ガジェット", value: "gadgets" },
  { label: "グッズ", value: "goods" },
  { label: "PCパーツ", value: "pc-parts" },
];

const DEFAULT_TEMPLATE = `{{ customer.first_name }} 様

このたびは ASTROMEDA の商品をご購入いただき誠にありがとうございます。

ご購入いただいた商品はいかがでしたでしょうか？
よろしければ、3 分でレビューをお寄せいただけると幸いです。

{{ review_url }}

ASTROMEDA / 株式会社マイニングベース
`;

// Simple Liquid-ish renderer for preview (only basic {{ var }} replacement)
function renderPreview(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => vars[key] ?? `{{ ${key} }}`);
}

export default function EmailTab() {
  const { configs, collections, tags, ordersLast30Days } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const revalidator = useRevalidator();

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<EmailConfig | null>(null);
  const [form, setForm] = useState({
    target_type: "collection" as TargetType,
    target_handle: "",
    target_label: "",
    enabled: false,
    delay_days: 14,
    subject: "ご感想をお聞かせください",
    body_template: DEFAULT_TEMPLATE,
    reply_to: "support@mining-base.co.jp",
    incentive_text: "",
  });

  // Auto-fill target_label when target_handle changes
  useEffect(() => {
    if (form.target_type === "collection") {
      const c = collections.find((x) => x.handle === form.target_handle);
      if (c && !form.target_label) setForm((f) => ({ ...f, target_label: c.title }));
    } else if (form.target_type === "category") {
      const cat = PREDEFINED_CATEGORIES.find((x) => x.value === form.target_handle);
      if (cat && !form.target_label) setForm((f) => ({ ...f, target_label: cat.label }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.target_handle, form.target_type]);

  const openCreate = useCallback(() => {
    setEditing(null);
    setForm({ target_type: "collection", target_handle: "", target_label: "", enabled: false, delay_days: 14, subject: "ご感想をお聞かせください", body_template: DEFAULT_TEMPLATE, reply_to: "support@mining-base.co.jp", incentive_text: "" });
    setModalOpen(true);
  }, []);

  const openEdit = useCallback((c: EmailConfig) => {
    setEditing(c);
    setForm({ target_type: c.target_type, target_handle: c.target_handle, target_label: c.target_label, enabled: c.enabled, delay_days: c.delay_days, subject: c.subject, body_template: c.body_template, reply_to: c.reply_to, incentive_text: c.incentive_text });
    setModalOpen(true);
  }, []);

  const submit = useCallback(() => {
    const fd = new FormData();
    fd.set("intent", editing ? "update" : "create");
    if (editing) fd.set("id", editing.id);
    Object.entries(form).forEach(([k, v]) => fd.set(k, typeof v === "boolean" ? (v ? "true" : "false") : String(v)));
    fetcher.submit(fd, { method: "post" });
    setModalOpen(false);
    setTimeout(() => revalidator.revalidate(), 300);
  }, [editing, form, fetcher, revalidator]);

  const toggle = useCallback((c: EmailConfig) => {
    const fd = new FormData();
    fd.set("intent", "toggle");
    fd.set("id", c.id);
    fd.set("enabled", c.enabled ? "false" : "true");
    fetcher.submit(fd, { method: "post" });
    setTimeout(() => revalidator.revalidate(), 300);
  }, [fetcher, revalidator]);

  const remove = useCallback((c: EmailConfig) => {
    if (!confirm(`「${c.target_label || c.target_handle}」を削除しますか？`)) return;
    const fd = new FormData();
    fd.set("intent", "delete");
    fd.set("id", c.id);
    fetcher.submit(fd, { method: "post" });
    setTimeout(() => revalidator.revalidate(), 300);
  }, [fetcher, revalidator]);

  // Compute send-volume estimate for current form selection
  const sendEstimate = useMemo(() => {
    let matchingProducts = 0;
    let label = "";
    if (form.target_type === "collection") {
      const c = collections.find((x) => x.handle === form.target_handle);
      matchingProducts = c?.productCount ?? 0;
      label = c ? `「${c.title}」コレクション` : "(未選択)";
    } else if (form.target_type === "product_tag") {
      matchingProducts = 0; // 正確な数値は productTags クエリでは取れないので 0 表示
      label = form.target_handle ? `タグ「${form.target_handle}」` : "(未選択)";
    } else if (form.target_type === "category") {
      const cat = PREDEFINED_CATEGORIES.find((x) => x.value === form.target_handle);
      label = cat ? `カテゴリ「${cat.label}」` : "(未選択)";
    } else {
      // all = total active products approximated by sum of all collection product counts (rough)
      matchingProducts = collections.reduce((s, c) => s + c.productCount, 0);
      label = "全商品 (フォールバック)";
    }
    // 過去 30 日の注文数 × 対象比率 (粗推定)
    const targetRatio = form.target_type === "all" ? 1 : matchingProducts > 0 ? Math.min(1, matchingProducts / 100) : 0;
    const estimatedSends = Math.round(ordersLast30Days * targetRatio);
    return { label, matchingProducts, estimatedSends, ordersLast30Days };
  }, [form.target_type, form.target_handle, collections, ordersLast30Days]);

  // Build dropdown options based on target_type
  const handleOptions = useMemo(() => {
    if (form.target_type === "collection") {
      return [
        { label: "コレクションを選択してください", value: "" },
        ...collections.map((c) => ({ label: `${c.title} (${c.productCount} 商品)`, value: c.handle })),
      ];
    }
    if (form.target_type === "product_tag") {
      return [
        { label: "タグを選択してください", value: "" },
        ...tags.map((t) => ({ label: t.tag, value: t.tag })),
      ];
    }
    if (form.target_type === "category") {
      return [
        { label: "カテゴリを選択してください", value: "" },
        ...PREDEFINED_CATEGORIES,
      ];
    }
    return [{ label: "(全商品共通設定なので不要)", value: "" }];
  }, [form.target_type, collections, tags]);

  // Real-time preview rendering
  const previewVars = {
    "customer.first_name": "山田",
    "customer.last_name": "太郎",
    "customer.email": "yamada@example.com",
    "review_url": "https://shop.mining-base.co.jp/apps/reviews-1/submit?token=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
    "order.id": "1234567890",
    "order.name": "#10001",
    "shop.name": "ASTROMEDA",
  };
  const previewSubject = renderPreview(form.subject, previewVars);
  const previewBody = renderPreview(form.body_template, previewVars);

  return (
    <Page
      title="メール設定"
      subtitle="IP コラボ別・カテゴリ別にレビュー依頼メールの本文と送信トリガーを編集"
      primaryAction={{ content: "新規メール設定を追加", onAction: openCreate }}
    >
      <Layout>
        <Layout.Section>
          {fetcher.data?.ok ? <Banner tone="success" title="保存しました" onDismiss={() => {}} /> : null}
          {fetcher.data && !fetcher.data.ok ? <Banner tone="critical" title="保存に失敗しました" onDismiss={() => {}} /> : null}

          <Card>
            {configs.length === 0 ? (
              <EmptyState heading="メール設定はまだ登録されていません" image="" action={{ content: "新規メール設定を追加", onAction: openCreate }}>
                <Text as="p" variant="bodyMd">IP コラボ別やカテゴリ別にレビュー依頼メールの文面と送信トリガー (発送 N 日後) をここで管理します。</Text>
              </EmptyState>
            ) : (
              <IndexTable
                resourceName={{ singular: "メール設定", plural: "メール設定" }}
                itemCount={configs.length}
                selectable={false}
                headings={[{ title: "ターゲット" },{ title: "種別" },{ title: "件名" },{ title: "delay (日)" },{ title: "状態" },{ title: "操作" }]}
              >
                {configs.map((c, idx) => (
                  <IndexTable.Row id={c.id} key={c.id} position={idx}>
                    <IndexTable.Cell><Text as="span" variant="bodyMd" fontWeight="semibold">{c.target_label || c.target_handle || "(無名)"}</Text></IndexTable.Cell>
                    <IndexTable.Cell><Badge>{c.target_type === "collection" ? "コレクション" : c.target_type === "product_tag" ? "タグ" : c.target_type === "category" ? "カテゴリ" : "全商品"}</Badge></IndexTable.Cell>
                    <IndexTable.Cell>{c.subject}</IndexTable.Cell>
                    <IndexTable.Cell>{c.delay_days}</IndexTable.Cell>
                    <IndexTable.Cell>{c.enabled ? <Badge tone="success">有効</Badge> : <Badge tone="attention">無効</Badge>}</IndexTable.Cell>
                    <IndexTable.Cell>
                      <InlineStack gap="200">
                        <Button onClick={() => openEdit(c)} variant="plain">編集</Button>
                        <Button onClick={() => toggle(c)} variant="plain">{c.enabled ? "無効化" : "有効化"}</Button>
                        <Button onClick={() => remove(c)} variant="plain" tone="critical">削除</Button>
                      </InlineStack>
                    </IndexTable.Cell>
                  </IndexTable.Row>
                ))}
              </IndexTable>
            )}
          </Card>
        </Layout.Section>
      </Layout>

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editing ? "メール設定を編集" : "新規メール設定を追加"}
        primaryAction={{ content: "保存", onAction: submit, disabled: form.target_type !== "all" && !form.target_handle }}
        secondaryActions={[{ content: "キャンセル", onAction: () => setModalOpen(false) }]}
        size="large"
      >
        <Modal.Section>
          <InlineGrid columns={{ xs: 1, md: 2 }} gap="400">
            {/* 左カラム: 設定フォーム */}
            <FormLayout>
              <FormLayout.Group>
                <Select
                  label="ターゲット種別"
                  options={[
                    { label: "コレクション (IP コラボなど)", value: "collection" },
                    { label: "商品タグ", value: "product_tag" },
                    { label: "カテゴリ", value: "category" },
                    { label: "全商品 (フォールバック)", value: "all" },
                  ]}
                  value={form.target_type}
                  onChange={(v) => setForm({ ...form, target_type: v as TargetType, target_handle: "", target_label: "" })}
                />
                <Select
                  label={form.target_type === "collection" ? "コレクション" : form.target_type === "product_tag" ? "商品タグ" : form.target_type === "category" ? "カテゴリ" : "—"}
                  options={handleOptions}
                  value={form.target_handle}
                  onChange={(v) => setForm({ ...form, target_handle: v })}
                  disabled={form.target_type === "all"}
                />
              </FormLayout.Group>

              <TextField label="ターゲット表示名 (管理画面用)" autoComplete="off" value={form.target_label} onChange={(v) => setForm({ ...form, target_label: v })} helpText="例: 呪術廻戦コラボ。空欄なら自動で選択名を採用" />

              {/* 送信予定数表示 */}
              <Box padding="300" background="bg-surface-info" borderRadius="200">
                <BlockStack gap="200">
                  <Text as="h4" variant="headingSm">📊 送信予定数の目安</Text>
                  <Text as="p" variant="bodySm">
                    対象: <strong>{sendEstimate.label}</strong>
                  </Text>
                  {form.target_type !== "all" ? (
                    <Text as="p" variant="bodySm">対象商品数: <strong>{sendEstimate.matchingProducts}</strong> 件</Text>
                  ) : null}
                  <Text as="p" variant="bodySm">
                    過去 30 日の発送注文: <strong>{sendEstimate.ordersLast30Days}</strong> 件
                  </Text>
                  <Text as="p" variant="bodyXs" tone="subdued">
                    ※「対象商品数 / 全商品」の比率 × 過去 30 日注文数 × 1 を掛けた粗推定: 月 <strong>約 {sendEstimate.estimatedSends}</strong> 通の送信見込み
                  </Text>
                </BlockStack>
              </Box>

              <FormLayout.Group>
                <TextField label="発送後の遅延日数" type="number" min={1} max={90} autoComplete="off" value={String(form.delay_days)} onChange={(v) => setForm({ ...form, delay_days: Number(v) || 14 })} suffix="日" />
                <TextField label="Reply-To メール" type="email" autoComplete="off" value={form.reply_to} onChange={(v) => setForm({ ...form, reply_to: v })} />
              </FormLayout.Group>

              <TextField label="件名" autoComplete="off" value={form.subject} onChange={(v) => setForm({ ...form, subject: v })} helpText="30 字以内推奨" maxLength={80} showCharacterCount />
              <TextField
                label="本文 (Liquid テンプレート)"
                autoComplete="off"
                multiline={10}
                value={form.body_template}
                onChange={(v) => setForm({ ...form, body_template: v })}
                helpText="{{ customer.first_name }} / {{ review_url }} / {{ order.name }} 等の変数が使えます。プレビューは右側に即時表示"
              />
              <TextField label="インセンティブ文言 (任意)" autoComplete="off" value={form.incentive_text} onChange={(v) => setForm({ ...form, incentive_text: v })} helpText="例: 投稿者全員に次回 500 円 OFF クーポン" />

              <Checkbox label="この設定を有効化する (即時 Shopify Flow から参照される)" checked={form.enabled} onChange={(v) => setForm({ ...form, enabled: v })} />
            </FormLayout>

            {/* 右カラム: リアルタイムプレビュー */}
            <BlockStack gap="300">
              <Text as="h3" variant="headingMd">📧 メールプレビュー (お客様視点)</Text>
              <Text as="p" variant="bodySm" tone="subdued">
                サンプルデータ ({"{{ customer.first_name }}"} → 「山田」、{"{{ review_url }}"} → 実際の token URL) で置換されたプレビューです。
              </Text>

              <Card padding="0">
                {/* Mail header bar */}
                <Box background="bg-fill-secondary" padding="300">
                  <BlockStack gap="100">
                    <InlineStack gap="200" align="space-between">
                      <Text as="span" variant="bodyXs" tone="subdued" fontWeight="semibold">差出人:</Text>
                      <Text as="span" variant="bodyXs">ASTROMEDA &lt;noreply@mining-base.co.jp&gt;</Text>
                    </InlineStack>
                    <InlineStack gap="200" align="space-between">
                      <Text as="span" variant="bodyXs" tone="subdued" fontWeight="semibold">宛先:</Text>
                      <Text as="span" variant="bodyXs">yamada@example.com (山田 太郎 様)</Text>
                    </InlineStack>
                    <InlineStack gap="200" align="space-between">
                      <Text as="span" variant="bodyXs" tone="subdued" fontWeight="semibold">Reply-To:</Text>
                      <Text as="span" variant="bodyXs">{form.reply_to || "(未設定)"}</Text>
                    </InlineStack>
                  </BlockStack>
                </Box>
                <Divider />
                {/* Subject */}
                <Box padding="300" background="bg-fill">
                  <Text as="h2" variant="headingMd">{previewSubject || "(件名未入力)"}</Text>
                </Box>
                <Divider />
                {/* Body with ASTROMEDA branded header */}
                <Box padding="0">
                  <div style={{ background: "#0d9488", padding: 18, textAlign: "center" }}>
                    <span style={{ color: "#fff", fontSize: 18, fontWeight: 700, letterSpacing: 2 }}>ASTROMEDA</span>
                  </div>
                  <Box padding="500">
                    <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: '-apple-system, "Hiragino Sans", "Yu Gothic UI", sans-serif', fontSize: 14, lineHeight: 1.7, margin: 0, color: "#0f172a" }}>
                      {previewBody || "(本文未入力)"}
                    </pre>
                    {form.incentive_text ? (
                      <Box padding="300" background="bg-surface-success" borderRadius="200">
                        <Text as="p" variant="bodySm">🎁 {form.incentive_text}</Text>
                      </Box>
                    ) : null}
                  </Box>
                </Box>
              </Card>

              <Text as="p" variant="bodyXs" tone="subdued">
                ⚠️ 本物のメールは Shopify Email で配信されます。実際のレイアウト・フォントは Shopify Email Template Editor で確認できます。
              </Text>
            </BlockStack>
          </InlineGrid>
        </Modal.Section>
      </Modal>
    </Page>
  );
}
