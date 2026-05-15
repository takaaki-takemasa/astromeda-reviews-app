// Postinstall patch: neutralize @remix-run/server-runtime's throwIfPotentialCSRFAttack
// when the request path starts with /proxy/ (Shopify App Proxy entry).
//
// Why this is needed:
//   - App Proxy sets x-forwarded-host = astromeda-reviews-app.vercel.app
//   - The browser sets Origin = https://shop.mining-base.co.jp
//   - Remix's CSRF check throws because these don't match.
//   - The Shopify App Proxy signature already provides CSRF-equivalent protection,
//     so dropping the Remix-level check for /proxy/* is safe.
//
// We patch the FUNCTION ITSELF in actions.js so every call site is neutralized.
// Idempotent.

const fs = require("fs");
const path = require("path");

const candidates = [
  path.resolve(__dirname, "..", "node_modules", "@remix-run", "server-runtime", "dist", "actions.js"),
  path.resolve(__dirname, "..", "node_modules", "@remix-run", "server-runtime", "dist", "server.js"),
];

const MARK = "// ASTROMEDA_CSRF_PATCH_APPLIED";

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

  // Pattern A: function declaration `function throwIfPotentialCSRFAttack(request) {`
  // Pattern B: arrow assignment `throwIfPotentialCSRFAttack = (request) => {` or similar
  // Inject early-return at the top of the function body when path starts with /proxy/.

  let patched = src;
  let changed = false;

  // Match function body opening: function throwIfPotentialCSRFAttack(...) { ... }
  const fnDeclRe = /(function\s+throwIfPotentialCSRFAttack\s*\([^)]*\)\s*\{)/;
  if (fnDeclRe.test(patched)) {
    patched = patched.replace(
      fnDeclRe,
      "$1\n  try { if (new URL(request.url).pathname.startsWith('/proxy/')) return; } catch (e) {}"
    );
    changed = true;
  }

  // Also handle exports.throwIfPotentialCSRFAttack = function(...) { ... }
  const exportRe = /(exports\.throwIfPotentialCSRFAttack\s*=\s*function\s*\([^)]*\)\s*\{)/;
  if (exportRe.test(patched)) {
    patched = patched.replace(
      exportRe,
      "$1\n  try { if (new URL(request.url).pathname.startsWith('/proxy/')) return; } catch (e) {}"
    );
    changed = true;
  }

  if (changed) {
    patched = MARK + "\n" + patched;
    fs.writeFileSync(target, patched);
    console.log("[patch-remix-csrf] applied:", target);
    totalPatched++;
  } else {
    console.log("[patch-remix-csrf] no match in:", target);
  }
}

console.log(`[patch-remix-csrf] total files patched: ${totalPatched}`);
