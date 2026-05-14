import { Page, Layout, Card, BlockStack, Text, EmptyState } from "@shopify/polaris";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return {};
};

export default function QueueTab() {
  return (
    <Page
      title="送信キュー"
      subtitle="Shopify Flow が発火させた送信予約・送信履歴の監視"
    >
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <EmptyState heading="送信キュー" image="">
                <Text as="p" variant="bodyMd">
                  Metaobject astromeda_review_email_queue から status 別に集計。
                  Phase H で実装予定 (5/26)。
                </Text>
              </EmptyState>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
