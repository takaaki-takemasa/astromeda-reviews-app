import { Page, Layout, Card, BlockStack, Text, EmptyState, InlineStack, Badge } from "@shopify/polaris";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  // Phase E で実装: Metaobject astromeda_review から一覧取得
  return {
    counts: { pending: 0, approved: 0, rejected: 0 },
    reviews: [] as Array<{ id: string; rating: number; status: string }>,
  };
};

export default function ReviewsTab() {
  const { counts } = useLoaderData<typeof loader>();
  return (
    <Page
      title="レビュー一覧"
      subtitle="お客様から投稿された商品レビューの承認・拒否・返信を管理"
    >
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack gap="200">
                <Badge tone="attention">承認待ち: {counts.pending}</Badge>
                <Badge tone="success">公開中: {counts.approved}</Badge>
                <Badge tone="critical">拒否: {counts.rejected}</Badge>
              </InlineStack>
              <EmptyState
                heading="レビューはまだありません"
                image=""
              >
                <Text as="p" variant="bodyMd">
                  お客様の注文発送 14 日後に Shopify Flow から自動でレビュー依頼メールが送信され、
                  ここに承認待ちレビューが表示されます。Phase E で実装予定。
                </Text>
              </EmptyState>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
