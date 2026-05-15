// Postinstall patch: neutralize @remix-run/server-runtime's throwIfPotentialCSRFAttack
// for all routes so that Shopify App Proxy POST requests succeed.
//
// Why this is needed:
//   - App Proxy sets x-forwarded-host = astromeda-reviews-app.vercel.app
//   - The browser sets Origin = https://shop.mining-base.co.jp
//   - Remix's CSRF check throws because these don't match.
//   - The Shopify App Proxy signature already provides CSRF-equivalent protection,
//     plus we validate token UUIDs in Metaobject, so dropping Remix's extra check is safe.
//
// We replace the function body with `return;` so every call is a no-op.
// Both CommonJS (dist/actions.js) and ESM (dist/esm/actions.js) bundles must be patched
// because Vite may pick either depending on conditions.
// Idempotent: re-running this script does not double-apply.

const fs = require("fs");
const path = require("path");

const candidates = [
  path.resolve(__dirname, "..", "node_modules", "@remix-run", "server-runtime", "dist", "actions.js"),
  path.resolve(__dirname, "..", "node_modules", "@remix-run", "server-runtime", "dist", "esm", "actions.js"),
];

const MARK = "// ASTROMEDA_CSRF_PATCH_V2_APPLIED";

// Match: function throwIfPotentialCSRFAttack(headers) {
// (whitespace tolerant)
const NEEDLE_RE = /(function\s+throwIfPotentialCSRFAttack\s*\(\s*headers\s*\)\s*\{)/;

let totalPatched = 0;
for (const target of candidates) {
  if (!fs.existsSync(target)) {
    console.log("[patch-remix-csrf] skip (not found):", target);
    continue;
  }
  let src = fs.readFileSync(target, "utf8");
  if (src.startsWith(MARK)) {
    console.log("[patch-remix-csrf] already patched:", target);
    totalPatched++;
    continue;
  }

  if (!NEEDLE_RE.test(src)) {
    console.log("[patch-remix-csrf] NEEDLE NOT FOUND in:", target);
    // Dump first 30 chars of function declaration pattern that did exist
    const m = src.match(/function\s+throwIfPotentialCSRFAttack[^{]*\{/);
    if (m) console.log("[patch-remix-csrf]   actual signature:", JSON.stringify(m[0]));
    continue;
  }

  // Inject "return;" immediately after the opening brace
  const patched = MARK + "\n" + src.replace(
    NEEDLE_RE,
    "$1\n  return; // ASTROMEDA CSRF check disabled — see scripts/patch-remix-csrf.cjs\n"
  );

  fs.writeFileSync(target, patched);
  console.log("[patch-remix-csrf] APPLIED:", target);
  totalPatched++;
}

console.log(`[patch-remix-csrf] total files patched: ${totalPatched}`);
