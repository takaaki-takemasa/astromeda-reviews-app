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
  // Bootstrap: ensure an offline session exists in Firestore for this shop.
  // unstable_newEmbeddedAuthStrategy uses token-exchange which gives us an
  // access token that is valid for offline (per-shop) admin calls. If no
  // offline session is stored yet, save one so /proxy/submit's
  // unauthenticated.admin(SHOP) can find it.
  try {
    if (session?.shop && session?.accessToken) {
      const existing = await sessionStorage.findSessionsByShop(session.shop);
      const hasOffline = existing.some((s) => !s.isOnline);
      if (!hasOffline) {
        const offlineId = `offline_${session.shop}`;
        const offlineSession = new Session({
          id: offlineId,
          shop: session.shop,
          state: session.state || "",
          isOnline: false,
          scope: session.scope || "",
          accessToken: session.accessToken,
        });
        await sessionStorage.storeSession(offlineSession);
        console.log("[app.tsx] bootstrapped offline session for", session.shop);
      }
    }
  } catch (e: any) {
    console.error("[app.tsx] offline-session bootstrap failed:", e?.message || e);
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
