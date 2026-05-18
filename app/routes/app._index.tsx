import { Page, Layout, Card, BlockStack, Text, Banner, Link as PolarisLink, InlineStack, Badge } from "@shopify/polaris";
import { Link, useLoaderData } from "@remix-run/react";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";

const COUNT_QUERY = `#graphql
  query CountReviews($first: Int!, $after: String) {
    metaobjects(type: "astromeda_review", first: $first, after: $after) {
      edges {
        node {
          fields { key value }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  // ─── 全件取得 → status 別に集計 (admin.reviews と同じ方式) ───
  const statuses: string[] = [];
  let cursor: string | null = null;
  let safety = 0;
  try {
    while (safety < 50) {
      const res: any = await admin.graphql(COUNT_QUERY, {
        variables: { first: 250, after: cursor },
      });
      const json = await res.json();
      const edges = json.data?.metaobjects?.edges ?? [];
      for (const edge of edges) {
        const fields = edge?.node?.fields ?? [];
        const statusField = fields.find((f: any) => f?.key === "status");
        statuses.push((statusField?.value as string) || "pending");
      }
      const pageInfo = json.data?.metaobjects?.pageInfo;
      if (!pageInfo?.hasNextPage) break;
      cursor = pageInfo.endCursor;
      safety++;
    }
  } catch (e) {
    console.error("[app._index] count fetch failed", e);
  }

  const counts = {
    pending: statuses.filter((s) => s === "pending").length,
    approved: statuses.filter((s) => s === "approved").length,
    rejected: statuses.filter((s) => s === "rejected").length,
    total: statuses.length,
    queue: 0,
  };

  return {
    phase: "A + B + C foundation 完了 / Phase D Polaris UI 配管中",
    counts,
  };
};

export default function HomeDashboard() {
  const { counts } = useLoaderData<typeof loader>();

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
                  承認待ち <Badge tone="attention">{String(counts.pending)}</Badge> / 公開中 <Badge tone="success">{String(counts.approved)}</Badge>
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
                  Shopify Flow 経由の送信予約 <Badge tone="info">{String(counts.queue)}</Badge>
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
