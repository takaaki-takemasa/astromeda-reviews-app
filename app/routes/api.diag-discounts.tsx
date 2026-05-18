// PUBLIC diagnostic endpoint for Phase 2.5 verification
// Returns whether SHOPIFY_ADMIN_ACCESS_TOKEN is set and can fetch discounts
// NOT for production use - delete after Phase 2.5 validated
import type { LoaderFunctionArgs } from "react-router";

export const loader = async (_args: LoaderFunctionArgs) => {
  const offlineToken = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
  const shop = process.env.PRODUCTION_SHOP_DOMAIN || "production-mining-base.myshopify.com";

  const out: any = {
    build_tag: "0e7411b+fallback-da82431",
    has_offline_token: Boolean(offlineToken),
    offline_token_prefix: offlineToken ? offlineToken.slice(0, 8) + "..." : null,
    shop,
    discounts: null,
    error: null,
  };

  if (!offlineToken) {
    out.error = "SHOPIFY_ADMIN_ACCESS_TOKEN env var not set";
    return new Response(JSON.stringify(out, null, 2), {
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }

  try {
    const q = `query ListShopifyDiscounts {
      codeDiscountNodes(first: 50, sortKey: CREATED_AT, reverse: true) {
        edges {
          node {
            id
            codeDiscount {
              ... on DiscountCodeBasic {
                title status
                codes(first: 1) { edges { node { code } } }
                customerGets { value {
                  ... on DiscountPercentage { percentage }
                  ... on DiscountAmount { amount { amount } }
                } }
              }
            }
          }
        }
      }
    }`;
    const r = await fetch(`https://${shop}/admin/api/2024-10/graphql.json`, {
      method: "POST",
      headers: { "X-Shopify-Access-Token": offlineToken, "Content-Type": "application/json" },
      body: JSON.stringify({ query: q }),
    });
    const j = await r.json();
    if (j?.errors) {
      out.error = "GraphQL error: " + j.errors.map((e: any) => e.message).join("; ");
    } else {
      const edges = j?.data?.codeDiscountNodes?.edges || [];
      const active = edges.filter((e: any) => {
        const st = e?.node?.codeDiscount?.status || "";
        return st === "ACTIVE" || st === "SCHEDULED";
      });
      out.discounts = {
        total_returned: edges.length,
        active_or_scheduled: active.length,
        samples: active.slice(0, 5).map((e: any) => {
          const d = e.node.codeDiscount;
          return { id: e.node.id, title: d?.title, status: d?.status, code: d?.codes?.edges?.[0]?.node?.code };
        }),
      };
    }
  } catch (e: any) {
    out.error = "fetch failed: " + String(e?.message || e);
  }

  return new Response(JSON.stringify(out, null, 2), {
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
};
