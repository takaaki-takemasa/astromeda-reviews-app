import { json } from "@remix-run/node";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { Firestore } from "@google-cloud/firestore";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const result: any = {
    SHOPIFY_API_KEY: !!process.env.SHOPIFY_API_KEY,
    SHOPIFY_API_SECRET: !!process.env.SHOPIFY_API_SECRET,
    SHOPIFY_ADMIN_ACCESS_TOKEN_present: !!process.env.SHOPIFY_ADMIN_ACCESS_TOKEN,
    GCP_PROJECT_ID: process.env.GCP_PROJECT_ID || null,
    GCP_SERVICE_ACCOUNT_KEY_present: !!process.env.GCP_SERVICE_ACCOUNT_KEY,
  };

  const url = new URL(request.url);
  const action = url.searchParams.get("action");

  try {
    const projectId = process.env.GCP_PROJECT_ID;
    const keyJson = process.env.GCP_SERVICE_ACCOUNT_KEY;
    if (projectId && keyJson) {
      const credentials = JSON.parse(keyJson);
      const db = new Firestore({ projectId, credentials });

      // List ALL sessions across all shops
      const allSnap = await db.collection("shopify_sessions").limit(20).get();
      result.firestore_total_sessions = allSnap.size;
      result.firestore_all_sessions = allSnap.docs.map((d: any) => {
        const data = d.data();
        return {
          id: d.id.slice(0, 50),
          shop: data.shop,
          isOnline: data.isOnline,
          hasToken: !!data.accessToken,
          scope: (data.scope || "").slice(0, 60),
        };
      });
    }
  } catch (e: any) {
    result.firestore_error = e?.message || String(e);
  }

  return json(result);
};
