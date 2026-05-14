import { Page, Layout, Card, BlockStack, Text, EmptyState } from "@shopify/polaris";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return {};
};

export default function EmailTab() {
  return (
    <Page
      title="メール設定"
      subtitle="IP コラボ別・カテゴリ別にレビュー依頼メールの本文と送信トリガーを編集"
    >
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <EmptyState heading="メール設定" image="">
                <Text as="p" variant="bodyMd">
                  既存 Shopify Flow (id 01KRJ1JF33PNW1ENMTQZ584SN5) と
                  Metaobject astromeda_review_email_config を連携。
                  Phase F で実装予定 (5/21-22)。
                </Text>
              </EmptyState>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
