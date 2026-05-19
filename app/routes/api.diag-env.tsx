import { json } from "@remix-run/node";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { Firestore } from "@google-cloud/firestore";

export const loader = async (_args: LoaderFunctionArgs) => {
  const result: any = {
    SHOPIFY_API_KEY: !!process.env.SHOPIFY_API_KEY,
    SHOPIFY_API_SECRET: !!process.env.SHOPIFY_API_SECRET,
    SHOPIFY_APP_URL: !!process.env.SHOPIFY_APP_URL,
    SHOPIFY_ADMIN_ACCESS_TOKEN_present: !!process.env.SHOPIFY_ADMIN_ACCESS_TOKEN,
    SHOPIFY_ADMIN_ACCESS_TOKEN_len: (process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || "").length,
    GCP_PROJECT_ID: process.env.GCP_PROJECT_ID || null,
    GCP_SERVICE_ACCOUNT_KEY_present: !!process.env.GCP_SERVICE_ACCOUNT_KEY,
  };

  // Firestore session inspection
  try {
    const projectId = process.env.GCP_PROJECT_ID;
    const keyJson = process.env.GCP_SERVICE_ACCOUNT_KEY;
    if (projectId && keyJson) {
      const credentials = JSON.parse(keyJson);
      const db = new Firestore({ projectId, credentials });
      const snap = await db.collection("shopify_sessions").where("shop", "==", "production-mining-base.myshopify.com").get();
      result.firestore_sessions_for_shop = snap.size;
      result.firestore_sessions_summary = snap.docs.map((d: any) => {
        const data = d.data();
        return {
          id: d.id.slice(0, 30) + (d.id.length > 30 ? "..." : ""),
          isOnline: data.isOnline,
          hasAccessToken: !!data.accessToken,
          accessTokenLen: (data.accessToken || "").length,
          scope: (data.scope || "").slice(0, 80),
        };
      });
    }
  } catch (e: any) {
    result.firestore_error = e?.message || String(e);
  }

  return json(result);
};
