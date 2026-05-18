/**
 * /app/incentive-preview — Phase 2 (インセンティブ統合) 実装プラン
 *
 * CEO のデプロイ前確認用のプレビュー画面。実機能ではなく設計内容のみ表示。
 */

import { Page, Layout, Card, BlockStack, InlineStack, Text, Banner, Badge, Button, Divider, List } from "@shopify/polaris";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher } from "@remix-run/react";
import { authenticate } from "../shopify.server";
import { useState } from "react";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return { ok: true };
};

export default function IncentivePreview() {
  useLoaderData<typeof loader>();
  const [decision, setDecision] = useState<"" | "approved" | "rejected">("");

  return (
    <Page
      title="Phase 2: インセンティブ統合 実装プラン"
      subtitle="レビュー投稿の見返りに次回利用クーポンを自動発行する仕組み。デプロイ前に CEO の確認・承認をお願いします。"
    >
      <Layout>
        <Layout.Section>
          <Banner title="この画面の目的" tone="info">
            <Text as="p" variant="bodyMd">
              Phase 2 で追加予定の「インセンティブ統合」の設計内容を、デプロイ前に確認するための画面です。コードはまだ書いていません。下の各セクションをご確認のうえ、ページ末尾の「承認する」「修正を依頼する」ボタンを押してください。
            </Text>
          </Banner>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingLg">🎯 解決する課題</Text>
              <Text as="p" variant="bodyMd">
                現状: レビュー依頼メールを送ってもインセンティブが無いので投稿率が低い（業界平均 5〜10%）。
              </Text>
              <Text as="p" variant="bodyMd">
                目標: クーポンインセンティブを付けて投稿率 <strong>30〜40%</strong> へ。LTV と口コミ件数を同時に伸ばす。
              </Text>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingLg">⚙ システム構成</Text>
              <Text as="h3" variant="headingMd">新規 Metaobject: <code>astromeda_review_coupon</code></Text>
              <List>
                <List.Item><code>code</code> — クーポンコード（例: <Badge>REV-A1B2C3</Badge>）</List.Item>
                <List.Item><code>discount_type</code> — percentage or fixed_amount</List.Item>
                <List.Item><code>discount_value</code> — 10% or ¥1000 など</List.Item>
                <List.Item><code>applicable_to</code> — all_products / collection_handle / product_handle</List.Item>
                <List.Item><code>validity_days</code> — デフォルト 90日</List.Item>
                <List.Item><code>issued_to_email</code> — 受領者のメール</List.Item>
                <List.Item><code>shopify_discount_code_id</code> — Shopify Discount Code との連携 GID</List.Item>
                <List.Item><code>issued_at</code> / <code>used_at</code> / <code>sales_amount</code></List.Item>
              </List>
              <Divider />
              <Text as="h3" variant="headingMd">Shopify Discount Code API 連携</Text>
              <Text as="p" variant="bodyMd">
                <code>discountCodeBasicCreate</code> mutation で、レビュー投稿時に <strong>そのお客様専用の</strong>クーポンを動的生成。1人につき1コード、再利用不可、期限付き、IP コラボにスコープ可能。
              </Text>
              <Text as="p" variant="bodyMd" tone="subdued">
                必要スコープ追加: <code>write_discounts</code> / <code>read_discounts</code>
              </Text>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingLg">📨 メールフロー</Text>
              <Text as="p" variant="bodyMd">
                <strong>1. 依頼メール</strong>（既存 + 訴求文追加）<br/>
                「レビュー投稿で次回 <strong>10% OFF</strong> クーポンプレゼント 🎁」が訴求文として既存テンプレに追加されます。
              </Text>
              <Text as="p" variant="bodyMd">
                <strong>2. 投稿完了画面</strong>（新規）<br/>
                投稿直後に画面上で実際のクーポンコードを即時表示（離脱前にお客様の手元に渡る）。
              </Text>
              <Text as="p" variant="bodyMd">
                <strong>3. サンクスメール</strong>（新規）<br/>
                投稿の御礼 + クーポンコードを改めてメールで送信（90日後に1日前リマインダ）。
              </Text>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingLg">🖥 admin UI</Text>
              <Text as="h3" variant="headingMd">トップページ「インセンティブ設定」カード</Text>
              <Banner tone="info">
                <BlockStack gap="100">
                  <Text as="p" variant="bodyMd" fontWeight="semibold">🎁 インセンティブ設定</Text>
                  <Text as="p" variant="bodyMd">現在: レビュー投稿で <Badge tone="success">10% OFF</Badge> クーポン</Text>
                  <Text as="p" variant="bodyMd">有効: 90日 / 対象: 同IPコラボ商品</Text>
                  <Text as="p" variant="bodyMd">発行 142 件 / 利用 58 件（利用率 <Badge tone="success">41%</Badge>）</Text>
                  <Text as="p" variant="bodyMd" tone="subdued">→ 設定を編集 →</Text>
                </BlockStack>
              </Banner>
              <Divider />
              <Text as="h3" variant="headingMd">設定編集画面（新規）</Text>
              <List>
                <List.Item>割引額: <Badge>10%</Badge> or <Badge>固定額 ¥1000</Badge></List.Item>
                <List.Item>対象範囲: 全商品 / 同 IP コラボ / 商品カテゴリ別</List.Item>
                <List.Item>有効期限: 30 / 60 / 90 / 180 日</List.Item>
                <List.Item>訴求文の文言（依頼メール本文用）</List.Item>
                <List.Item>IP コラボ別オーバーライド（サンリオは 15% など）</List.Item>
              </List>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingLg">📊 分析ダッシュボード（次次フェーズ）</Text>
              <List>
                <List.Item>クーポン経由の売上（円）</List.Item>
                <List.Item>レビュー後の再購入率</List.Item>
                <List.Item>IP コラボ別の利用率</List.Item>
                <List.Item>平均評価 × 利用率の相関</List.Item>
              </List>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingLg">🧪 仮顧客テスト送信 UI（同時実装）</Text>
              <Text as="p" variant="bodyMd">
                CEO が自分で機能を踏破できるよう、admin 内で「仮顧客 + 仮商品 + 仮注文」を作って実機テストできる UI を同時に実装します。
              </Text>
              <List>
                <List.Item>名前・メール・テスト商品・テンプレ を入力</List.Item>
                <List.Item>送信ボタンで Shopify Draft Order ¥0 + Invoice Email 送信</List.Item>
                <List.Item>CEO が受信メール → クリック → 投稿 → クーポン受領 のフルループ検証可能</List.Item>
              </List>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingLg">⏱ 実装規模 / 工数</Text>
              <List>
                <List.Item>Phase 2.1 メタオブジェクト + 設定UI: 2-3h</List.Item>
                <List.Item>Phase 2.2 Shopify Discount Code 連携: 2-3h</List.Item>
                <List.Item>Phase 2.3 メールテンプレ拡張: 1h</List.Item>
                <List.Item>Phase 2.4 投稿完了画面 + サンクスメール: 2h</List.Item>
                <List.Item>Phase 2.5 仮顧客テスト送信 UI: 1h</List.Item>
                <List.Item><strong>合計: 8〜10h（1セッション内に収まる）</strong></List.Item>
              </List>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingLg">✅ CEO の承認</Text>
              <Text as="p" variant="bodyMd">
                上記の設計内容で問題なければ「承認する」を押してください。修正が必要であれば「修正を依頼」を押してチャットで指示してください。
              </Text>
              {decision === "approved" ? (
                <Banner tone="success">
                  <Text as="p" variant="bodyMd">
                    <strong>承認されました。</strong>Cowork に「Phase 2 やって」と伝えてください。実装に入ります。
                  </Text>
                </Banner>
              ) : decision === "rejected" ? (
                <Banner tone="warning">
                  <Text as="p" variant="bodyMd">
                    Cowork に修正点をチャットで伝えてください。
                  </Text>
                </Banner>
              ) : (
                <InlineStack gap="200">
                  <Button variant="primary" tone="success" size="large" onClick={() => setDecision("approved")}>
                    ✅ 承認する
                  </Button>
                  <Button size="large" onClick={() => setDecision("rejected")}>
                    ✏️ 修正を依頼
                  </Button>
                </InlineStack>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
