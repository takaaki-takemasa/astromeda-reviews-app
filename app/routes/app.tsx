import type { HeadersFunction, LoaderFunctionArgs } from "@remix-run/node";
import { Link, Outlet, useLoaderData, useRouteError } from "@remix-run/react";
import { boundary } from "@shopify/shopify-app-remix/server";
import { AppProvider } from "@shopify/shopify-app-remix/react";
import { NavMenu } from "@shopify/app-bridge-react";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";
import brandTokensStyles from "../styles/brand-tokens.css?url";

import { authenticate, sessionStorage } from "../shopify.server";
import { Session } from "@shopify/shopify-api";

export const links = () => [
  { rel: "stylesheet", href: polarisStyles },
  { rel: "stylesheet", href: brandTokensStyles },
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  // Bootstrap: ensure an OFFLINE access token is stored for this shop.
  // unstable_newEmbeddedAuthStrategy gives us an ONLINE session token via token exchange,
  // but /proxy/submit needs an OFFLINE token. Do an explicit token exchange to get offline.
  try {
    if (session?.shop) {
      const existing = await sessionStorage.findSessionsByShop(session.shop);
      const hasOffline = existing.some((s) => !s.isOnline && s.accessToken);
      if (!hasOffline) {
        const sessionTokenHeader = request.headers.get("authorization") || "";
        const sessionToken = sessionTokenHeader.replace(/^Bearer\s+/i, "");
        if (sessionToken) {
          const tokenExchangeRes = await fetch(`https://${session.shop}/admin/oauth/access_token`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              client_id: process.env.SHOPIFY_API_KEY,
              client_secret: process.env.SHOPIFY_API_SECRET,
              grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
              subject_token: sessionToken,
              subject_token_type: "urn:ietf:params:oauth:token-type:id_token",
              requested_token_type: "urn:shopify:params:oauth:token-type:offline-access-token",
            }),
          });
          if (tokenExchangeRes.ok) {
            const tokenData = await tokenExchangeRes.json() as { access_token?: string; scope?: string };
            if (tokenData.access_token) {
              const offlineSession = new Session({
                id: `offline_${session.shop}`,
                shop: session.shop,
                state: "",
                isOnline: false,
                scope: tokenData.scope || session.scope || "",
                accessToken: tokenData.access_token,
              });
              await sessionStorage.storeSession(offlineSession);
              console.log("[app.tsx] ✅ offline session bootstrapped via token-exchange for", session.shop);
            } else {
              console.error("[app.tsx] token exchange returned no access_token:", JSON.stringify(tokenData));
            }
          } else {
            const errText = await tokenExchangeRes.text();
            console.error("[app.tsx] token exchange failed:", tokenExchangeRes.status, errText.slice(0, 300));
          }
        } else {
          console.warn("[app.tsx] no session token header, skipping offline bootstrap");
        }
      }
    }
  } catch (e: any) {
    console.error("[app.tsx] offline bootstrap exception:", e?.message || e);
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
