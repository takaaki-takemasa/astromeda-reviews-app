import { Page, Layout, Card, BlockStack, Text, EmptyState } from "@shopify/polaris";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return {};
};

export default function TokensTab() {
  return (
    <Page
      title="ギフトトークン"
      subtitle="ギフト受領者向けレビュー依頼トークンの発行・管理"
    >
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <EmptyState heading="ギフトトークン" image="">
                <Text as="p" variant="bodyMd">
                  Metaobject astromeda_review_token (token_type=gift) を発行・URL 生成。
                  Phase G で実装予定 (5/25)。
                </Text>
              </EmptyState>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
