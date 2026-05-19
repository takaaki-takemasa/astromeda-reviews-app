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

async function writeTrace(db: any, label: string, payload: any) {
  try {
    await db.collection("astromeda_bootstrap_trace").doc(new Date().toISOString() + "_" + Math.random().toString(36).slice(2,8)).set({
      ts: new Date().toISOString(),
      label,
      payload,
    });
  } catch (_) {}
}

async function bootstrapOfflineSession(shop: string, sessionToken: string, request: Request): Promise<void> {
  const apiKey = process.env.SHOPIFY_API_KEY;
  const apiSecret = process.env.SHOPIFY_API_SECRET;

  const projectId = process.env.GCP_PROJECT_ID;
  const keyJson = process.env.GCP_SERVICE_ACCOUNT_KEY;
  if (!projectId || !keyJson) return;
  let credentials: any;
  try { credentials = JSON.parse(keyJson); } catch { return; }
  const db = new Firestore({ projectId, credentials });

  await writeTrace(db, "enter", { shop, hasSessionToken: !!sessionToken, hasApiKey: !!apiKey, hasSecret: !!apiSecret, sessionTokenLen: sessionToken?.length || 0 });

  if (!apiKey || !apiSecret || !shop || !sessionToken) {
    await writeTrace(db, "abort_missing", { shop, hasApiKey: !!apiKey, hasSecret: !!apiSecret, hasToken: !!sessionToken });
    return;
  }

  const col = db.collection("shopify_sessions");
  const existing = await col.where("shop", "==", shop).get();
  const hasOffline = existing.docs.some((d: any) => {
    const data = d.data();
    return data.isOnline === false && data.accessToken;
  });
  await writeTrace(db, "existing_check", { shop, totalSessions: existing.size, hasOffline });
  if (hasOffline) return;

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

  await writeTrace(db, "exchange_response", { status: exchangeRes.status, statusText: exchangeRes.statusText });

  if (!exchangeRes.ok) {
    const errText = await exchangeRes.text();
    await writeTrace(db, "exchange_fail", { status: exchangeRes.status, body: errText.slice(0, 500) });
    return;
  }

  const tokenData = (await exchangeRes.json()) as { access_token?: string; scope?: string };
  if (!tokenData.access_token) {
    await writeTrace(db, "no_token", { tokenData: JSON.stringify(tokenData).slice(0, 500) });
    return;
  }

  const offlineId = `offline_${shop}`;
  await col.doc(offlineId).set({
    id: offlineId,
    shop,
    state: "",
    isOnline: false,
    scope: tokenData.scope || "",
    accessToken: tokenData.access_token,
  });
  await writeTrace(db, "saved", { offlineId, scope: tokenData.scope });
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
