import { Page, Layout, Card, BlockStack, Text, Banner, Link as PolarisLink, InlineStack, Badge } from "@shopify/polaris";
import { Link } from "@remix-run/react";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return {
    phase: "A + B + C foundation 完了 / Phase D Polaris UI 配管中",
    counts: { pending: 0, total: 0, queue: 0 },
  };
};

export default function HomeDashboard() {
  return (
    <Page title="ASTROMEDA 口コミ管理">
      <BlockStack gap="500">
        <Banner tone="info" title="REV-EMB-2026-Q2 / Phase D in progress">
          <Text as="p" variant="bodyMd">
            Phase A (Foundation) / B (DB Models) / C (Auth + Audit Log + Rate Limit) は完了。
            Phase D で本タブと 4 タブの Polaris 配管中。
            実機能 (レビュー承認 / メール設定 / トークン発行 / キュー監視) は Phase E-H (5/21〜26) で順次実装。
          </Text>
        </Banner>

        <Layout>
          <Layout.Section variant="oneThird">
            <Card>
              <BlockStack gap="200">
                <Text as="h3" variant="headingMd">レビュー一覧</Text>
                <Text as="p" variant="bodyMd">
                  承認待ち <Badge tone="attention">0</Badge> / 公開中 <Badge tone="success">0</Badge>
                </Text>
                <Link to="/app/reviews">レビュー一覧を開く →</Link>
              </BlockStack>
            </Card>
          </Layout.Section>
          <Layout.Section variant="oneThird">
            <Card>
              <BlockStack gap="200">
                <Text as="h3" variant="headingMd">メール設定</Text>
                <Text as="p" variant="bodyMd">
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
                <Text as="p" variant="bodyMd">
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
                <Text as="p" variant="bodyMd">
                  Shopify Flow 経由の送信予約 <Badge tone="info">0</Badge>
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
              <PolarisLink url="https://github.com/takaaki-takemasa/astromeda-reviews-app/blob/main/PHASE_A_COMPLETE.md" external>Phase A 完了報告</PolarisLink>
            </InlineStack>
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
