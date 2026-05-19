import type { LoaderFunctionArgs } from "@remix-run/node";

// Public diagnostic endpoint — reports env var PRESENCE only (not values) for debugging.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  // Simple auth: require ?key=<DIAG_KEY> if DIAG_KEY env var is set, else open
  const expectedKey = process.env.DIAG_KEY;
  if (expectedKey && url.searchParams.get("key") !== expectedKey) {
    return new Response("forbidden", { status: 403 });
  }
  return Response.json({
    SHOPIFY_API_KEY: !!process.env.SHOPIFY_API_KEY,
    SHOPIFY_API_SECRET: !!process.env.SHOPIFY_API_SECRET,
    SHOPIFY_APP_URL: !!process.env.SHOPIFY_APP_URL,
    SHOPIFY_ADMIN_ACCESS_TOKEN: !!process.env.SHOPIFY_ADMIN_ACCESS_TOKEN,
    SHOPIFY_ADMIN_ACCESS_TOKEN_starts_shpat: !!(process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || "").startsWith("shpat_"),
    SHOPIFY_ADMIN_ACCESS_TOKEN_len: (process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || "").length,
    RESEND_API_KEY: !!process.env.RESEND_API_KEY,
    GCP_PROJECT_ID: !!process.env.GCP_PROJECT_ID,
    GCP_SERVICE_ACCOUNT_KEY: !!process.env.GCP_SERVICE_ACCOUNT_KEY,
    PRODUCTION_SHOP_DOMAIN: process.env.PRODUCTION_SHOP_DOMAIN || null,
    SHOP_CUSTOM_DOMAIN: process.env.SHOP_CUSTOM_DOMAIN || null,
    SCOPES: process.env.SCOPES || null,
    NODE_ENV: process.env.NODE_ENV || null,
  });
};
