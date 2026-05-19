import type { HeadersFunction, LoaderFunctionArgs } from "@remix-run/node";
import { Link, Outlet, useLoaderData, useRouteError } from "@remix-run/react";
import { boundary } from "@shopify/shopify-app-remix/server";
import { AppProvider } from "@shopify/shopify-app-remix/react";
import { NavMenu } from "@shopify/app-bridge-react";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";
import brandTokensStyles from "../styles/brand-tokens.css?url";

import { authenticate } from "../shopify.server";
import { Firestore } from "@google-cloud/firestore";

export const links = () => [
  { rel: "stylesheet", href: polarisStyles },
  { rel: "stylesheet", href: brandTokensStyles },
];

async function bootstrapOfflineSession(shop: string, sessionToken: string): Promise<void> {
  const apiKey = process.env.SHOPIFY_API_KEY;
  const apiSecret = process.env.SHOPIFY_API_SECRET;
  if (!apiKey || !apiSecret || !shop || !sessionToken) return;

  // 1. Check Firestore for existing offline session
  const projectId = process.env.GCP_PROJECT_ID;
  const keyJson = process.env.GCP_SERVICE_ACCOUNT_KEY;
  if (!projectId || !keyJson) return;
  let credentials: any;
  try { credentials = JSON.parse(keyJson); } catch { return; }
  const db = new Firestore({ projectId, credentials });
  const col = db.collection("shopify_sessions");

  const existing = await col.where("shop", "==", shop).get();
  const hasOffline = existing.docs.some((d: any) => {
    const data = d.data();
    return data.isOnline === false && data.accessToken;
  });
  if (hasOffline) {
    console.log("[app.tsx bootstrap] offline session already exists for", shop);
    return;
  }

  // 2. Token exchange: session token (online) → offline access token
  const exchangeRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: apiKey,
      client_secret: apiSecret,
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: sessionToken,
      subject_token_type: "urn:ietf:params:oauth:token-type:id_token",
      requested_token_type: "urn:shopify:params:oauth:token-type:offline-access-token",
    }),
  });

  if (!exchangeRes.ok) {
    const errText = await exchangeRes.text();
    console.error("[app.tsx bootstrap] token exchange failed:", exchangeRes.status, errText.slice(0, 300));
    return;
  }

  const tokenData = (await exchangeRes.json()) as { access_token?: string; scope?: string };
  if (!tokenData.access_token) {
    console.error("[app.tsx bootstrap] no access_token in response:", JSON.stringify(tokenData));
    return;
  }

  // 3. Save to Firestore as offline session
  const offlineId = `offline_${shop}`;
  await col.doc(offlineId).set({
    id: offlineId,
    shop,
    state: "",
    isOnline: false,
    scope: tokenData.scope || "",
    accessToken: tokenData.access_token,
  });
  console.log("[app.tsx bootstrap] ✅ offline session saved for", shop);
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  // Best-effort: ensure an offline access token exists so /proxy/submit can use admin GraphQL.
  try {
    if (session?.shop) {
      const sessionTokenHeader = request.headers.get("authorization") || "";
      const sessionToken = sessionTokenHeader.replace(/^Bearer\s+/i, "");
      if (sessionToken) {
        await bootstrapOfflineSession(session.shop, sessionToken);
      }
    }
  } catch (e: any) {
    console.error("[app.tsx] bootstrap exception:", e?.message || e);
  }
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();

  return (
    <AppProvider isEmbeddedApp apiKey={apiKey}>
      <NavMenu>
        <Link to="/app" rel="home">
          口コミ管理
        </Link>
        <Link to="/app/reviews">レビュー一覧</Link>
        <Link to="/app/shipments">レビュー未送信リスト</Link>
        <Link to="/app/incentive">🎁 インセンティブ</Link>
        <Link to="/app/email">メール設定</Link>
        <Link to="/app/tokens">ギフトトークン</Link>
        <Link to="/app/queue">送信キュー</Link>
      </NavMenu>
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs Remix to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
