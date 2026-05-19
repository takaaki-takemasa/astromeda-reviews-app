import { Page, Layout, Card, BlockStack, Text, Banner, Link as PolarisLink, InlineStack } from "@shopify/polaris";
import { Link } from "@remix-run/react";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";

/**
 * Top dashboard - ZERO heavy data fetch.
 * Counts/details are loaded ONLY when user navigates into specific tab.
 *
 * 旧コードは全レビュー (1038+) を 5 ページ paginate して status カウント計算
 * → トップページ表示が激重だった。
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  // Auth check only - no data fetch
  await authenticate.admin(request);
  return null;
};

export default function HomeDashboard() {
  return (
    <Page title="ASTROMEDA 口コミ管理">
      <BlockStack gap="500">
        <Banner tone="info" title="運用中">
          <Text as="p" variant="bodyMd">
            レビュー未送信リスト / インセンティブ統合 / Shopify ディスカウント連携 が稼働中。
            各カードから機能を開けます。件数や詳細は各画面で表示されます。
          </Text>
        </Banner>

        <Layout>
          <Layout.Section variant="oneThird">
            <Card>
              <BlockStack gap="200">
                <Text as="h3" variant="headingMd">レビュー一覧</Text>
                <Text as="p" variant="bodyMd" tone="subdued">
                  投稿レビューを承認・編集・公開停止
                </Text>
                <Link to="/app/reviews">レビュー一覧を開く →</Link>
              </BlockStack>
            </Card>
          </Layout.Section>

          <Layout.Section variant="oneThird">
            <Card>
              <BlockStack gap="200">
                <Text as="h3" variant="headingMd">📧 レビュー未送信リスト</Text>
                <Text as="p" variant="bodyMd" tone="subdued">
                  発送済み商品×お客様で 🔴未依頼 / 🟡依頼済 / 🟢レビュー済 を可視化
                </Text>
                <Link to="/app/shipments">レビュー未送信リストを開く →</Link>
              </BlockStack>
            </Card>
          </Layout.Section>

          <Layout.Section variant="oneThird">
            <Card>
              <BlockStack gap="200">
                <Text as="h3" variant="headingMd">🎁 インセンティブ統合</Text>
                <Text as="p" variant="bodyMd" tone="subdued">
                  レビュー投稿で次回利用クーポンを自動発行 (Shopify ディスカウント連携)
                </Text>
                <Link to="/app/incentive">インセンティブ設定を開く →</Link>
              </BlockStack>
            </Card>
          </Layout.Section>

          <Layout.Section variant="oneThird">
            <Card>
              <BlockStack gap="200">
                <Text as="h3" variant="headingMd">メール設定</Text>
                <Text as="p" variant="bodyMd" tone="subdued">
                  IP / カテゴリ別の依頼メール文面を編集
                </Text>
                <Link to="/app/email">メール設定を開く →</Link>
              </BlockStack>
            </Card>
          </Layout.Section>

          <Layout.Section variant="oneThird">
            <Card>
              <BlockStack gap="200">
                <Text as="h3" variant="headingMd">ギフトトークン</Text>
                <Text as="p" variant="bodyMd" tone="subdued">
                  ギフト受領者用のレビュー招待 URL を発行
                </Text>
                <Link to="/app/tokens">トークン管理を開く →</Link>
              </BlockStack>
            </Card>
          </Layout.Section>

          <Layout.Section variant="oneThird">
            <Card>
              <BlockStack gap="200">
                <Text as="h3" variant="headingMd">送信キュー</Text>
                <Text as="p" variant="bodyMd" tone="subdued">
                  Shopify Flow 経由の送信予約
                </Text>
                <Link to="/app/queue">送信キューを開く →</Link>
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>

        <Card>
          <BlockStack gap="300">
            <Text as="h3" variant="headingMd">技術ドキュメント</Text>
            <InlineStack gap="300">
              <PolarisLink url="https://github.com/takaaki-takemasa/astromeda-reviews-app/blob/main/README.md" external>README</PolarisLink>
              <PolarisLink url="https://github.com/takaaki-takemasa/astromeda-reviews-app/blob/main/BRAND_TOKENS.md" external>Brand Tokens</PolarisLink>
              <PolarisLink url="https://github.com/takaaki-takemasa/astromeda-reviews-app/blob/main/THREAT_MODEL.md" external>Threat Model</PolarisLink>
            </InlineStack>
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
