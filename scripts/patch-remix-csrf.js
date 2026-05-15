// Postinstall patch: relax @remix-run/server-runtime's throwIfPotentialCSRFAttack
// for /proxy/* routes so that Shopify App Proxy POST requests succeed.
//
// Why this is needed:
//   - App Proxy sets x-forwarded-host = astromeda-reviews-app.vercel.app
//   - The browser sets Origin = https://shop.mining-base.co.jp
//   - Remix's CSRF check throws because these don't match.
//   - The Shopify App Proxy signature already provides CSRF-equivalent protection,
//     so dropping the Remix-level check for /proxy/* is safe.
//
// Idempotent: re-running this script does not double-apply.

const fs = require("fs");
const path = require("path");

const target = path.resolve(
  __dirname,
  "..",
  "node_modules",
  "@remix-run",
  "server-runtime",
  "dist",
  "server.js"
);

if (!fs.existsSync(target)) {
  console.log("[patch-remix-csrf] target not found, skipping:", target);
  process.exit(0);
}

let src = fs.readFileSync(target, "utf8");
const MARK = "// ASTROMEDA_CSRF_PATCH_APPLIED";

if (src.includes(MARK)) {
  console.log("[patch-remix-csrf] already applied, skipping");
  process.exit(0);
}

// Wrap every call to "throwIfPotentialCSRFAttack(request)" with a /proxy/ skip-guard.
// Pattern is repeated in server.js; replace all.
const needle = "throwIfPotentialCSRFAttack(request)";
const replacement =
  "(new URL(request.url).pathname.startsWith('/proxy/') ? null : throwIfPotentialCSRFAttack(request))";

if (!src.includes(needle)) {
  console.log("[patch-remix-csrf] needle not found in server.js, skipping");
  process.exit(0);
}

let count = 0;
while (src.includes(needle)) {
  src = src.replace(needle, replacement);
  count++;
  if (count > 20) break;
}

src = MARK + "\n" + src;
fs.writeFileSync(target, src);
console.log(`[patch-remix-csrf] applied (${count} call site(s) wrapped)`);
