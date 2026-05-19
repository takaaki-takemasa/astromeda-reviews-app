import {
  Page, Layout, Card, BlockStack, InlineStack, Text, EmptyState, IndexTable, Badge,
  Button, Modal, TextField, FormLayout, Checkbox, Banner, Select, Box, Divider,
  InlineGrid, ChoiceList,
} from "@shopify/polaris";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher, useRevalidator } from "@remix-run/react";
import { useState, useCallback, useEffect, useMemo } from "react";
import { authenticate } from "../shopify.server";
import { appendAuditLogSafe } from "../lib/audit-log";
import {
  IP_COLLABS, ASTROMEDA_COLORS, ASTROMEDA_GPUS, PRODUCT_GROUPS,
  resolveTarget, inferSelection, detectProductGroup,
  type HierarchicalSelection, type TargetRoot,
} from "../lib/astromeda-taxonomy";

type TargetType = "collection" | "product_tag" | "product" | "category" | "all";

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

interface ProductOption { id: string; title: string; handle: string; tags: string[]; collectionHandles: string[]; }

const LIST_QUERY = `#graphql
  query ListEmailConfigs($first: Int!) {
    metaobjects(type: "astromeda_review_email_config", first: $first) {
      edges {
        node { id handle updatedAt fields { key value } }
      }
    }
  }
`;

// 対象コレクション (IPコラボ + 8色 + gaming-pc) ごとに製品をまとめて取得する。
// status:active + first:250 では 1417 商品中の IP 商品 (日本語タイトル) が
// alphabetical sort で 250 番以降に押し出されて 0 件になっていた根本バグの修正。
function buildCollectionsProductsQuery(): string {
  const ipAliases = IP_COLLABS.map((ip, i) => {
    const handle = ip.productCollectionHandle || ip.handle;
    return `ip${i}: collectionByHandle(handle: "${handle}") { handle title products(first: 100) { edges { node { id title handle tags } } } }`;
  }).join("\n  ");
  const colorAliases = ASTROMEDA_COLORS.map((c, i) =>
    `color${i}: collectionByHandle(handle: "${c.slug}") { handle title products(first: 100) { edges { node { id title handle tags } } } }`
  ).join("\n  ");
  const gamingPc = `gamingPc: collectionByHandle(handle: "gaming-pc") { handle title products(first: 50, sortKey: BEST_SELLING) { edges { node { id title handle tags } } } }`;
  return `#graphql\nquery AllRelevantCollections {\n  ${ipAliases}\n  ${colorAliases}\n  ${gamingPc}\n}`;
}
type CollectionNode = { handle: string; title?: string; products?: { edges: Array<{ node: { id: string; title: string; handle: string; tags: string[] } }> } } | null;

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

const PARTS_TAG_PATTERNS = [
  /pulldown[-_]?component/i,
  /^parts?$/i,
  /パーツ/,
  /^部品/,
  /add[-_]?on/i,
  /サブ商品/,
  /component$/i,
];
const isPartTag = (tag: string) => PARTS_TAG_PATTERNS.some((p) => p.test(tag));

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  const collectionsQuery = buildCollectionsProductsQuery();

  const [cfgRes, collRes, orderRes] = await Promise.all([
    admin.graphql(LIST_QUERY, { variables: { first: 50 } }),
    admin.graphql(collectionsQuery).catch(() => null),
    admin.graphql(ORDERS_LAST_30D_COUNT_QUERY).catch(() => null),
  ]);

  const cfgJson = (await cfgRes.json()) as { data?: { metaobjects?: { edges: Array<{ node: { id: string; updatedAt: string; fields: Array<{ key: string; value: string }> } }> } } };
  const collJson = collRes ? (await collRes.json()) as { data?: Record<string, CollectionNode> } : null;
  const orderJson = orderRes ? (await orderRes.json()) as { data?: { ordersCount?: { count: number } } } : null;

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

  // 商品 → collectionHandles[] にマージ。同一商品が複数コレクションに入る場合に対応。
  const productMap = new Map<string, ProductOption>();
  if (collJson?.data) {
    for (const [, coll] of Object.entries(collJson.data)) {
      if (!coll || !coll.products) continue;
      for (const edge of coll.products.edges) {
        const p = edge.node;
        if ((p.tags ?? []).some((t) => isPartTag(t))) continue;
        const existing = productMap.get(p.handle);
        if (existing) {
          if (!existing.collectionHandles.includes(coll.handle)) existing.collectionHandles.push(coll.handle);
        } else {
          productMap.set(p.handle, { id: p.id, title: p.title, handle: p.handle, tags: p.tags ?? [], collectionHandles: [coll.handle] });
        }
      }
    }
  }
  const products: ProductOption[] = Array.from(productMap.values());

  return { configs, products, ordersLast30Days: orderJson?.data?.ordersCount?.count ?? 0 };
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

const DEFAULT_TEMPLATE = `{{ customer.first_name }} 様

このたびは ASTROMEDA の商品をご購入いただき誠にありがとうございます。

ご購入いただいた商品はいかがでしたでしょうか？
よろしければ、3 分でレビューをお寄せいただけると幸いです。

{{ review_url }}

ASTROMEDA / 株式会社マイニングベース
`;

function renderPreview(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => vars[key] ?? `{{ ${key} }}`);
}

export default function EmailTab() {
  const { configs, products, ordersLast30Days } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const revalidator = useRevalidator();

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<EmailConfig | null>(null);

  // 階層選択状態
  const [sel, setSel] = useState<HierarchicalSelection>({ root: "astromeda", scope: "all" });

  // メール設定フォーム状態 (上記とは別管理)
  const [meta, setMeta] = useState({
    enabled: false,
    delay_days: 14,
    subject: "ご感想をお聞かせください",
    body_template: DEFAULT_TEMPLATE,
    reply_to: "support@mining-base.co.jp",
    incentive_text: "",
    target_label: "",
  });

  // 階層選択から target を解決 (リアルタイム)
  const resolved = useMemo(() => resolveTarget(sel), [sel]);

  // target_label を resolved.label で自動同期 (CEO が手動で上書きしていなければ)
  useEffect(() => {
    if (!editing) {
      setMeta((m) => ({ ...m, target_label: resolved.target_label }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolved.target_label]);

  // 選択中 IP に存在する製品群を動的算出 (該当 IP の商品の detectProductGroup を unique 集計)
  const availableGroups = useMemo(() => {
    if (sel.root !== "ip_collab" || !sel.ip) return [];
    const ip = IP_COLLABS.find((x) => x.handle === sel.ip);
    const targetHandles = [ip?.handle, ip?.productCollectionHandle].filter(Boolean) as string[];
    const ipProducts = products.filter((p) => p.collectionHandles.some((h) => targetHandles.includes(h)));
    const groupCounts = new Map<string, number>();
    ipProducts.forEach((p) => {
      const g = detectProductGroup(p.title, p.tags);
      groupCounts.set(g, (groupCounts.get(g) || 0) + 1);
    });
    return Array.from(groupCounts.entries())
      .map(([slug, count]) => {
        const g = PRODUCT_GROUPS.find((x) => x.slug === slug);
        return { slug, jpName: g?.jpName || slug, count };
      })
      .sort((a, b) => b.count - a.count);
  }, [sel.root, sel.ip, products]);

  // 階層選択でフィルタした親製品リスト (個別商品プルダウン用)
  const filteredProducts = useMemo<ProductOption[]>(() => {
    if (sel.root === "ip_collab" && sel.ip) {
      // IP コラボの商品 (collection に含まれる)
      const ip = IP_COLLABS.find((x) => x.handle === sel.ip);
      const targetHandles = [ip?.handle, ip?.productCollectionHandle].filter(Boolean) as string[];
      let f = products.filter((p) => p.collectionHandles.some((h) => targetHandles.includes(h)));
      // 製品群フィルタ
      if (sel.productGroup) {
        f = f.filter((p) => detectProductGroup(p.title, p.tags) === sel.productGroup);
      }
      return f;
    }
    if (sel.root === "astromeda") {
      // アストロメダPC: カラー collection に含まれる + GPU タグ持ち
      let filtered = products;
      if (sel.color) {
        filtered = filtered.filter((p) => p.collectionHandles.includes(sel.color!));
      }
      if (sel.gpu) {
        const gpu = ASTROMEDA_GPUS.find((g) => g.slug === sel.gpu);
        if (gpu) {
          const gpuTagPatterns = [gpu.slug, gpu.jpName, gpu.jpName.replace(/\s/g, "")];
          filtered = filtered.filter((p) =>
            p.tags.some((t) => gpuTagPatterns.some((pattern) => t.toLowerCase().includes(pattern.toLowerCase())))
          );
        }
      }
      return filtered;
    }
    return [];
  }, [sel, products]);

  const openCreate = useCallback(() => {
    setEditing(null);
    setSel({ root: "astromeda", scope: "all" });
    setMeta({
      enabled: false, delay_days: 14, subject: "ご感想をお聞かせください",
      body_template: DEFAULT_TEMPLATE, reply_to: "support@mining-base.co.jp",
      incentive_text: "", target_label: "",
    });
    setModalOpen(true);
  }, []);

  const openEdit = useCallback((c: EmailConfig) => {
    setEditing(c);
    setSel(inferSelection(c.target_type, c.target_handle));
    setMeta({
      enabled: c.enabled, delay_days: c.delay_days, subject: c.subject,
      body_template: c.body_template, reply_to: c.reply_to,
      incentive_text: c.incentive_text, target_label: c.target_label,
    });
    setModalOpen(true);
  }, []);

  const submit = useCallback(() => {
    const fd = new FormData();
    fd.set("intent", editing ? "update" : "create");
    if (editing) fd.set("id", editing.id);
    fd.set("target_type", resolved.target_type);
    fd.set("target_handle", resolved.target_handle);
    fd.set("target_label", meta.target_label || resolved.target_label);
    fd.set("enabled", meta.enabled ? "true" : "false");
    fd.set("delay_days", String(meta.delay_days));
    fd.set("subject", meta.subject);
    fd.set("body_template", meta.body_template);
    fd.set("reply_to", meta.reply_to);
    fd.set("incentive_text", meta.incentive_text);
    fetcher.submit(fd, { method: "post" });
    setModalOpen(false);
    setTimeout(() => revalidator.revalidate(), 300);
  }, [editing, sel, resolved, meta, fetcher, revalidator]);

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

  // 送信予定数推定
  const sendEstimate = useMemo(() => {
    const matchingProducts = sel.scope === "specific" ? 1 : filteredProducts.length;
    const targetRatio = matchingProducts === 0 ? 0
      : sel.scope === "specific" ? 0.02
      : Math.min(1, matchingProducts / Math.max(50, products.length));
    return {
      matchingProducts,
      label: resolved.target_label,
      estimatedSends: Math.round(ordersLast30Days * targetRatio),
      ordersLast30Days,
    };
  }, [sel, filteredProducts, resolved, products.length, ordersLast30Days]);

  const previewVars = {
    "customer.first_name": "山田",
    "customer.last_name": "太郎",
    "customer.email": "yamada@example.com",
    "review_url": "https://shop.mining-base.co.jp/apps/reviews-1/submit?token=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
    "order.id": "1234567890",
    "order.name": "#10001",
    "shop.name": "ASTROMEDA",
  };
  const previewSubject = renderPreview(meta.subject, previewVars);
  const previewBody = renderPreview(meta.body_template, previewVars);

  // ─────────────────────────────────────────────
  // UI build
  // ─────────────────────────────────────────────

  const ipOptions = useMemo(() => [
    { label: "── IP を選択 ──", value: "" },
    ...IP_COLLABS.map((ip) => ({ label: ip.jpName, value: ip.handle })),
  ], []);

  const colorOptions = useMemo(() => [
    { label: "全色 (8 色まとめて)", value: "" },
    ...ASTROMEDA_COLORS.map((c) => ({ label: c.jpName, value: c.slug })),
  ], []);

  const gpuOptions = useMemo(() => [
    { label: "全 GPU", value: "" },
    ...ASTROMEDA_GPUS.map((g) => ({ label: g.jpName, value: g.slug })),
  ], []);

  const productOptions = useMemo(() => [
    { label: filteredProducts.length === 0 ? "(該当商品なし - 上の絞り込みを変更してください)" : "個別商品を選択", value: "" },
    ...filteredProducts.map((p) => ({ label: p.title, value: p.handle })),
  ], [filteredProducts]);

  return (
    <Page
      title="メール設定"
      subtitle="IP コラボ別・カラー別・GPU 別にレビュー依頼メールを編集"
      primaryAction={{ content: "新規メール設定を追加", onAction: openCreate }}
    >
      <Layout>
        <Layout.Section>
          {fetcher.data?.ok ? <Banner tone="success" title="保存しました" onDismiss={() => {}} /> : null}
          {fetcher.data && !fetcher.data.ok ? <Banner tone="critical" title="保存に失敗しました" onDismiss={() => {}} /> : null}

          <Card>
            {configs.length === 0 ? (
              <EmptyState heading="メール設定はまだ登録されていません" image="" action={{ content: "新規メール設定を追加", onAction: openCreate }}>
                <Text as="p" variant="bodyMd">IP コラボ別、アストロメダPC のカラー・GPU 別にレビュー依頼メールをここで管理します。</Text>
              </EmptyState>
            ) : (
              <IndexTable
                resourceName={{ singular: "メール設定", plural: "メール設定" }}
                itemCount={configs.length}
                selectable={false}
                headings={[{ title: "ターゲット" },{ title: "件名" },{ title: "delay (日)" },{ title: "状態" },{ title: "操作" }]}
              >
                {configs.map((c, idx) => (
                  <IndexTable.Row id={c.id} key={c.id} position={idx}>
                    <IndexTable.Cell><Text as="span" variant="bodyMd" fontWeight="semibold">{c.target_label || c.target_handle || "(無名)"}</Text></IndexTable.Cell>
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
        primaryAction={{ content: "保存", onAction: submit }}
        secondaryActions={[{ content: "キャンセル", onAction: () => setModalOpen(false) }]}
        size="large"
      >
        <Modal.Section>
          <InlineGrid columns={{ xs: 1, md: 2 }} gap="400">
            {/* 左カラム: 階層フォーム */}
            <BlockStack gap="400">
              {/* Step 1: ルート分岐 */}
              <Box padding="300" background="bg-surface-secondary" borderRadius="200">
                <ChoiceList
                  title="① まず大分類を選択"
                  choices={[
                    { label: "🖥️ アストロメダ非IPコラボ ゲーミングPC", value: "astromeda" },
                    { label: "✨ IPコラボ製品 (呪術廻戦・コードギアス 等)", value: "ip_collab" },
                  ]}
                  selected={[sel.root]}
                  onChange={(v) => setSel({ root: v[0] as TargetRoot, scope: "all" })}
                />
              </Box>

              {/* Step 2-IP: IP 選択 → 製品群 選択 → 絞り込み */}
              {sel.root === "ip_collab" ? (
                <Box padding="300" background="bg-surface-secondary" borderRadius="200">
                  <BlockStack gap="300">
                    <Select label="② IP を選択" options={ipOptions} value={sel.ip || ""} onChange={(v) => setSel({ ...sel, ip: v, productGroup: undefined, scope: "all", productHandle: undefined })} />
                    {sel.ip ? (
                      <Select
                        label="③ 製品群"
                        options={[
                          { label: `全製品群 (${filteredProducts.length} 件)`, value: "" },
                          ...availableGroups.map((g) => ({ label: `${g.jpName} (${g.count} 件)`, value: g.slug })),
                        ]}
                        value={sel.productGroup || ""}
                        onChange={(v) => setSel({ ...sel, productGroup: v || undefined, scope: "all", productHandle: undefined })}
                        helpText="ゲーミングPC / マウスパッド / キーボード等で絞り込み"
                      />
                    ) : null}
                    {sel.ip ? (
                      <ChoiceList
                        title="④ 絞り込み"
                        choices={[
                          { label: `${sel.productGroup ? "この製品群の" : "この IP の"}全商品 (${filteredProducts.length} 件)`, value: "all" },
                          { label: "個別モデルを選択", value: "specific" },
                        ]}
                        selected={[sel.scope]}
                        onChange={(v) => setSel({ ...sel, scope: v[0] as "all" | "specific" })}
                      />
                    ) : null}
                  </BlockStack>
                </Box>
              ) : null}

              {/* Step 2-Astromeda: カラー + GPU */}
              {sel.root === "astromeda" ? (
                <Box padding="300" background="bg-surface-secondary" borderRadius="200">
                  <BlockStack gap="300">
                    <FormLayout.Group>
                      <Select label="② カラー" options={colorOptions} value={sel.color || ""} onChange={(v) => setSel({ ...sel, color: v || undefined, productHandle: undefined })} />
                      <Select label="③ GPU" options={gpuOptions} value={sel.gpu || ""} onChange={(v) => setSel({ ...sel, gpu: v || undefined, productHandle: undefined })} />
                    </FormLayout.Group>
                    <ChoiceList
                      title="④ 絞り込み"
                      choices={[
                        { label: `この組み合わせの全商品 (${filteredProducts.length} 件)`, value: "all" },
                        { label: "個別商品を選択", value: "specific" },
                      ]}
                      selected={[sel.scope]}
                      onChange={(v) => setSel({ ...sel, scope: v[0] as "all" | "specific" })}
                    />
                  </BlockStack>
                </Box>
              ) : null}

              {/* Step 3: 個別商品プルダウン (scope=specific のとき) */}
              {sel.scope === "specific" ? (
                <Select
                  label="個別商品"
                  options={productOptions}
                  value={sel.productHandle || ""}
                  onChange={(v) => {
                    const p = filteredProducts.find((x) => x.handle === v);
                    setSel({ ...sel, productHandle: v || undefined, productTitle: p?.title });
                  }}
                  disabled={filteredProducts.length === 0}
                />
              ) : null}

              {/* 送信予定数 */}
              <Box padding="300" background="bg-surface-info" borderRadius="200">
                <BlockStack gap="200">
                  <Text as="h4" variant="headingSm">📊 送信予定数の目安</Text>
                  <Text as="p" variant="bodySm">対象: <strong>{sendEstimate.label}</strong></Text>
                  <Text as="p" variant="bodySm">対象商品数: <strong>{sendEstimate.matchingProducts}</strong> 件</Text>
                  <Text as="p" variant="bodySm">過去 30 日の発送注文: <strong>{sendEstimate.ordersLast30Days}</strong> 件</Text>
                  <Text as="p" variant="bodyXs" tone="subdued">月推定送信通数: <strong>約 {sendEstimate.estimatedSends}</strong> 通</Text>
                </BlockStack>
              </Box>

              <Divider />

              {/* メール本体設定 */}
              <FormLayout>
                <TextField label="管理画面用ラベル (自動入力)" autoComplete="off" value={meta.target_label} onChange={(v) => setMeta({ ...meta, target_label: v })} helpText="保存時の一覧表示名" />
                <FormLayout.Group>
                  <TextField label="発送後の遅延日数" type="number" min={1} max={90} autoComplete="off" value={String(meta.delay_days)} onChange={(v) => setMeta({ ...meta, delay_days: Number(v) || 14 })} suffix="日" />
                  <TextField label="Reply-To" type="email" autoComplete="off" value={meta.reply_to} onChange={(v) => setMeta({ ...meta, reply_to: v })} />
                </FormLayout.Group>
                <TextField label="件名" autoComplete="off" value={meta.subject} onChange={(v) => setMeta({ ...meta, subject: v })} maxLength={80} showCharacterCount />
                <TextField label="本文 (Liquid)" autoComplete="off" multiline={8} value={meta.body_template} onChange={(v) => setMeta({ ...meta, body_template: v })} helpText="{{ customer.first_name }} / {{ review_url }} 等" />
                <TextField label="インセンティブ文言 (任意)" autoComplete="off" value={meta.incentive_text} onChange={(v) => setMeta({ ...meta, incentive_text: v })} />
                <Checkbox label="この設定を有効化する" checked={meta.enabled} onChange={(v) => setMeta({ ...meta, enabled: v })} />
              </FormLayout>
            </BlockStack>

            {/* 右カラム: ライブプレビュー */}
            <BlockStack gap="300">
              <Text as="h3" variant="headingMd">📧 メールプレビュー (お客様視点)</Text>
              <Text as="p" variant="bodySm" tone="subdued">サンプル変数で置換した実メール表示。</Text>

              <Card padding="0">
                <Box background="bg-fill-secondary" padding="300">
                  <BlockStack gap="100">
                    <InlineStack gap="200" align="space-between"><Text as="span" variant="bodyXs" tone="subdued" fontWeight="semibold">差出人:</Text><Text as="span" variant="bodyXs">ASTROMEDA &lt;noreply@mining-base.co.jp&gt;</Text></InlineStack>
                    <InlineStack gap="200" align="space-between"><Text as="span" variant="bodyXs" tone="subdued" fontWeight="semibold">宛先:</Text><Text as="span" variant="bodyXs">yamada@example.com (山田 太郎 様)</Text></InlineStack>
                    <InlineStack gap="200" align="space-between"><Text as="span" variant="bodyXs" tone="subdued" fontWeight="semibold">Reply-To:</Text><Text as="span" variant="bodyXs">{meta.reply_to || "(未設定)"}</Text></InlineStack>
                  </BlockStack>
                </Box>
                <Divider />
                <Box padding="300" background="bg-fill">
                  <Text as="h2" variant="headingMd">{previewSubject || "(件名未入力)"}</Text>
                </Box>
                <Divider />
                <Box padding="0">
                  <div style={{ background: "#0d9488", padding: 18, textAlign: "center" }}>
                    <span style={{ color: "#fff", fontSize: 18, fontWeight: 700, letterSpacing: 2 }}>ASTROMEDA</span>
                  </div>
                  <Box padding="500">
                    <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: '-apple-system, "Hiragino Sans", "Yu Gothic UI", sans-serif', fontSize: 14, lineHeight: 1.7, margin: 0, color: "#0f172a" }}>{previewBody || "(本文未入力)"}</pre>
                    {meta.incentive_text ? (
                      <Box padding="300" background="bg-surface-success" borderRadius="200"><Text as="p" variant="bodySm">🎁 {meta.incentive_text}</Text></Box>
                    ) : null}
                  </Box>
                </Box>
              </Card>

              <Box padding="300" background="bg-surface-secondary" borderRadius="200">
                <BlockStack gap="100">
                  <Text as="h4" variant="headingSm">🔍 内部処理 (技術参考)</Text>
                  <Text as="p" variant="bodyXs" tone="subdued">target_type: <code>{resolved.target_type}</code></Text>
                  <Text as="p" variant="bodyXs" tone="subdued">target_handle: <code>{resolved.target_handle || "(未確定)"}</code></Text>
                </BlockStack>
              </Box>
            </BlockStack>
          </InlineGrid>
        </Modal.Section>
      </Modal>
    </Page>
  );
}
