import { redirect } from "@remix-run/node";

export const loader = async () => {
  // Non-embedded landing → redirect to login (Shopify will provide shop dropdown)
  throw redirect("/auth/login");
};

export default function PublicIndex() {
  return null;
}
