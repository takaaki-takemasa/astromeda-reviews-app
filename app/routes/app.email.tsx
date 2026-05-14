import {
  Page,
  Layout,
  Card,
  BlockStack,
  InlineStack,
  Text,
  EmptyState,
  IndexTable,
  Badge,
  Button,
  Modal,
  TextField,
  FormLayout,
  Checkbox,
  Banner,
  Select,
} from "@shopify/polaris";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher, useRevalidator } from "@remix-run/react";
import { useState, useCallback } from "react";
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

const LIST_QUERY = `#graphql
  query ListEmailConfigs($first: Int!) {
    metaobjects(type: "astromeda_review_email_config", first: $first) {
      edges {
        node {
          id
          handle
          updatedAt
          fields { key value }
        }
      }
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
  const response = await admin.graphql(LIST_QUERY, { variables: { first: 50 } });
  const data = (await response.json()) as {
    data?: {
      metaobjects?: { edges: Array<{ node: { id: string; updatedAt: string; fields: Array<{ key: string; value: string }> } }> };
    };
  };
  const edges = data.data?.metaobjects?.edges ?? [];
  const configs: EmailConfig[] = edges.map((e) => ({
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
  return { configs };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");
  const id = formData.get("id") ? String(formData.get("id")) : null;
  const nowIso = new Date().toISOString();

  const baseFields = [
    "target_type",
    "target_handle",
    "target_label",
    "enabled",
    "delay_days",
    "subject",
    "body_template",
    "reply_to",
    "incentive_text",
  ]
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
    const res = await admin.graphql(CREATE_MUTATION, {
      variables: {
        metaobject: { type: "astromeda_review_email_config", fields: [...baseFields, ...trailFields] },
      },
    });
    const json = (await res.json()) as {
      data?: { metaobjectCreate?: { metaobject?: { id: string }; userErrors: Array<{ field: string[]; message: string }> } };
    };
    const errs = json.data?.metaobjectCreate?.userErrors ?? [];
    const newId = json.data?.metaobjectCreate?.metaobject?.id;
    if (newId) {
      await appendAuditLogSafe({ admin, actor: session.shop, action: "config.update", resource_id: newId, resource_type: "astromeda_review_email_config", request, metadata: { intent: "create" } });
    }
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

export default function EmailTab() {
  const { configs } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const revalidator = useRevalidator();

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<EmailConfig | null>(null);
  const [form, setForm] = useState<Omit<EmailConfig, "id" | "last_modified_at" | "last_modified_by">>({
    target_type: "collection",
    target_handle: "",
    target_label: "",
    enabled: false,
    delay_days: 14,
    subject: "ご感想をお聞かせください",
    body_template: DEFAULT_TEMPLATE,
    reply_to: "support@mining-base.co.jp",
    incentive_text: "",
  });

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
    fd.set("target_type", form.target_type);
    fd.set("target_handle", form.target_handle);
    fd.set("target_label", form.target_label);
    fd.set("enabled", form.enabled ? "true" : "false");
    fd.set("delay_days", String(form.delay_days));
    fd.set("subject", form.subject);
    fd.set("body_template", form.body_template);
    fd.set("reply_to", form.reply_to);
    fd.set("incentive_text", form.incentive_text);
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
                headings={[
                  { title: "ターゲット" },
                  { title: "種別" },
                  { title: "件名" },
                  { title: "delay (日)" },
                  { title: "状態" },
                  { title: "操作" },
                ]}
                selectable={false}
              >
                {configs.map((c, idx) => (
                  <IndexTable.Row id={c.id} key={c.id} position={idx}>
                    <IndexTable.Cell>
                      <Text as="span" variant="bodyMd" fontWeight="semibold">{c.target_label || c.target_handle || "(無名)"}</Text>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <Badge>{c.target_type === "collection" ? "コレクション" : c.target_type === "product_tag" ? "タグ" : c.target_type === "category" ? "カテゴリ" : "全商品"}</Badge>
                    </IndexTable.Cell>
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
        large
      >
        <Modal.Section>
          <FormLayout>
            <FormLayout.Group>
              <Select
                label="ターゲット種別"
                options={[
                  { label: "コレクション", value: "collection" },
                  { label: "商品タグ", value: "product_tag" },
                  { label: "カテゴリ", value: "category" },
                  { label: "全商品 (フォールバック)", value: "all" },
                ]}
                value={form.target_type}
                onChange={(v) => setForm({ ...form, target_type: v as TargetType })}
              />
              <TextField label="ターゲット handle / タグ名" autoComplete="off" value={form.target_handle} onChange={(v) => setForm({ ...form, target_handle: v })} helpText="例: jujutsukaisen-collaboration / コラボPC" />
            </FormLayout.Group>
            <TextField label="ターゲット表示名 (管理画面用)" autoComplete="off" value={form.target_label} onChange={(v) => setForm({ ...form, target_label: v })} helpText="例: 呪術廻戦コラボ" />
            <FormLayout.Group>
              <TextField label="発送後の遅延日数" type="number" min={1} max={90} autoComplete="off" value={String(form.delay_days)} onChange={(v) => setForm({ ...form, delay_days: Number(v) || 14 })} />
              <TextField label="Reply-To メール" type="email" autoComplete="off" value={form.reply_to} onChange={(v) => setForm({ ...form, reply_to: v })} />
            </FormLayout.Group>
            <TextField label="件名" autoComplete="off" value={form.subject} onChange={(v) => setForm({ ...form, subject: v })} helpText="30 字以内推奨" />
            <TextField label="本文 (Liquid テンプレート)" autoComplete="off" multiline={10} value={form.body_template} onChange={(v) => setForm({ ...form, body_template: v })} helpText="{{ customer.first_name }} / {{ review_url }} 等の Liquid 変数が使えます" />
            <TextField label="インセンティブ文言 (任意)" autoComplete="off" value={form.incentive_text} onChange={(v) => setForm({ ...form, incentive_text: v })} helpText="例: 投稿者全員に次回 500 円 OFF クーポン" />
            <Checkbox label="この設定を有効化する (即時 Shopify Flow から参照される)" checked={form.enabled} onChange={(v) => setForm({ ...form, enabled: v })} />
          </FormLayout>
        </Modal.Section>
      </Modal>
    </Page>
  );
}
