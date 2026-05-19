import { json } from "@remix-run/node";
import type { LoaderFunctionArgs } from "@remix-run/node";

export const loader = async (_args: LoaderFunctionArgs) => {
  return json({
    SHOPIFY_API_KEY: !!process.env.SHOPIFY_API_KEY,
    SHOPIFY_API_SECRET: !!process.env.SHOPIFY_API_SECRET,
    SHOPIFY_APP_URL: !!process.env.SHOPIFY_APP_URL,
    SHOPIFY_ADMIN_ACCESS_TOKEN_present: !!process.env.SHOPIFY_ADMIN_ACCESS_TOKEN,
    SHOPIFY_ADMIN_ACCESS_TOKEN_len: (process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || "").length,
    SHOPIFY_ADMIN_ACCESS_TOKEN_prefix: (process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || "").slice(0, 8),
    RESEND_API_KEY: !!process.env.RESEND_API_KEY,
    GCP_PROJECT_ID: process.env.GCP_PROJECT_ID || null,
    GCP_SERVICE_ACCOUNT_KEY_present: !!process.env.GCP_SERVICE_ACCOUNT_KEY,
    SCOPES: process.env.SCOPES || null,
    NODE_ENV: process.env.NODE_ENV || null,
  });
};
