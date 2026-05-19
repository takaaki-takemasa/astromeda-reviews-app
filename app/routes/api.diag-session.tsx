import { json } from "@remix-run/node";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";

// Admin-only diag: shows current session details (no tokens leaked).
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  return json({
    shop: session?.shop || null,
    isOnline: session?.isOnline,
    state: session?.state,
    scope: session?.scope || null,
    has_accessToken: !!session?.accessToken,
    accessToken_len: (session?.accessToken || "").length,
    accessToken_prefix: (session?.accessToken || "").slice(0, 8),
    expires: session?.expires,
    onlineAccessInfo_associatedUser: (session as any)?.onlineAccessInfo?.associated_user?.email || null,
    authHeader_present: !!request.headers.get("authorization"),
    authHeader_prefix: (request.headers.get("authorization") || "").slice(0, 30),
  });
};
