import { redirect, type LoaderFunctionArgs } from "@remix-run/node";
import { login } from "../../shopify.server";

/**
 * Public landing route. Two paths:
 * 1. If `shop` query param is present → Shopify Admin is asking to load the
 *    embedded app. Redirect to /app with all params preserved.
 * 2. Otherwise → render the public Login form to let merchants self-install.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }
  return { showForm: Boolean(login) };
};

export default function PublicIndex() {
  // Minimal landing - Shopify embedded flow doesn't render this anyway.
  return null;
}
