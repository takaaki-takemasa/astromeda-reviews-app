// 自動翻訳ヘルパー (DeepL)
function isProbablyJapanese(text: string): boolean {
  return /[\u3040-\u309F\u30A0-\u30FF]/.test(text);
}
async function translateToJapanese(text: string): Promise<string | null> {
  if (!text || isProbablyJapanese(text)) return null;
  const apiKey = process.env.DEEPL_API_KEY;
  if (!apiKey) return null;
  try {
    const endpoint = apiKey.endsWith(":fx") ? "https://api-free.deepl.com/v2/translate" : "https://api.deepl.com/v2/translate";
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `DeepL-Auth-Key ${apiKey}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ text, target_lang: "JA" }).toString(),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { translations?: Array<{ text?: string }> };
    return json.translations?.[0]?.text || null;
  } catch { return null; }
}

import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { useLoaderData, useActionData, Form, useNavigation } from "@remix-run/react";
import { unauthenticated } from "../shopify.server";

// Direct Vercel URL route (no App Proxy) — token UUID is the only secret.
// Uses unauthenticated.admin() against the installed shop.
const SHOP_DOMAIN = "production-mining-base.myshopify.com";
import { enforceRateLimit, RATE_LIMITS } from "../lib/rate-limit";

/**
 * Customer-facing review submission form via App Proxy.
 *
 * URL: https://shop.mining-base.co.jp/apps/reviews/submit?token=XXX
 *      → Shopify proxies to /proxy/submit?token=XXX (this route)
 *
 * Phase K-01〜K-07 で扱う論点:
 *   K-02: token 検証 (UUID形式 / expires_at / used_at)
 *   K-04: 写真サイズ MIME 検証 (Phase K+ で実装)
 *   K-05: status='pending' 強制 (Phase A-11 T-05)
 *   K-06: Rate Limit (Phase C-04)
 *   K-07: NG ワード自動検出 (基本パターンのみ)
 */

const FIND_TOKEN_QUERY = `#graphql
  query FindToken($handle: String!) {
    metaobjects(type: "astromeda_review_token", first: 5, query: $handle) {
      edges { node { id handle fields { key value } } }
    }
  }
`;

const MARK_USED_MUTATION = `#graphql
  mutation MarkTokenUsed($id: ID!, $fields: [MetaobjectFieldInput!]!) {
    metaobjectUpdate(id: $id, metaobject: { fields: $fields }) {
      metaobject { id }
      userErrors { field message code }
    }
  }
`;

const CREATE_REVIEW_MUTATION = `#graphql
  mutation CreateReview($metaobject: MetaobjectCreateInput!) {
    metaobjectCreate(metaobject: $metaobject) {
      metaobject { id }
      userErrors { field message code }
    }
  }
`;

interface TokenData {
  id: string;
  token: string;
  email: string;
  customer_name: string;
  order_id: string;
  token_type: string;
  expires_at: string;
  used_at: string;
}

function f(node: { fields: Array<{ key: string; value: string }> }, key: string): string {
  return node.fields.find((x) => x.key === key)?.value ?? "";
}

function isValidUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

async function findTokenByValue(admin: { graphql: (q: string, opts?: { variables: Record<string, unknown> }) => Promise<Response> }, tokenValue: string): Promise<TokenData | null> {
  const res = await admin.graphql(FIND_TOKEN_QUERY, { variables: { handle: `fields.token:"${tokenValue}"` } });
  const json = (await res.json()) as { data?: { metaobjects?: { edges: Array<{ node: { id: string; fields: Array<{ key: string; value: string }> } }> } } };
  const edges = json.data?.metaobjects?.edges ?? [];
  if (edges.length === 0) return null;
  const node = edges[0].node;
  return {
    id: node.id,
    token: f(node, "token"),
    email: f(node, "email"),
    customer_name: f(node, "customer_name"),
    order_id: f(node, "order_id"),
    token_type: f(node, "token_type"),
    expires_at: f(node, "expires_at"),
    used_at: f(node, "used_at"),
  };
}

function validateToken(t: TokenData | null): { ok: true; token: TokenData } | { ok: false; reason: "missing" | "expired" | "used" | "invalid" } {
  if (!t) return { ok: false, reason: "missing" };
  if (t.used_at) return { ok: false, reason: "used" };
  if (t.expires_at && new Date(t.expires_at).getTime() < Date.now()) return { ok: false, reason: "expired" };
  return { ok: true, token: t };
}

const NG_WORD_PATTERNS = [
  /(死ね|殺す|くたばれ)/i,
  /(クソ|くそ|うんち)/i,
  /(バカ|ばか|アホ|あほ)/i,
  /(http:\/\/|https:\/\/)/i, // 外部リンクは原則弾く
];

function detectNgWords(text: string): string[] {
  return NG_WORD_PATTERNS.filter((p) => p.test(text)).map((p) => p.source);
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  enforceRateLimit(request, RATE_LIMITS.PUBLIC_AUTH);
  // Token UUID is the only secret. We trust the UUID and use unauthenticated admin
  // for Metaobject lookups against the installed production-mining-base store.
  const { admin } = await unauthenticated.admin(SHOP_DOMAIN);
  const url = new URL(request.url);
  const tokenValue = url.searchParams.get("token") || "";
  if (!isValidUuid(tokenValue)) {
    return { state: "invalid_token" as const, message: "リンクが正しくありません。メールに記載されたリンクをご確認ください。" };
  }
  const token = await findTokenByValue(admin, tokenValue);
  const v = validateToken(token);
  if (!v.ok) {
    return { state: v.reason as "missing" | "expired" | "used", message: v.reason === "expired" ? "このレビュー招待の有効期限が切れています。" : v.reason === "used" ? "このリンクは既にご利用済です。お一人様 1 回までの投稿となります。" : "リンクが正しくありません。" };
  }
  return { state: "ready" as const, token: v.token };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  enforceRateLimit(request, RATE_LIMITS.PUBLIC_SUBMIT);
  const { admin } = await unauthenticated.admin(SHOP_DOMAIN);

  const formData = await request.formData();
  const tokenValue = String(formData.get("token") || "");
  const rating = Number(formData.get("rating") || 0);
  const title = String(formData.get("title") || "").trim().slice(0, 80);
  const body = String(formData.get("body") || "").trim().slice(0, 2000);
  const reviewer_name = String(formData.get("reviewer_name") || "").trim().slice(0, 40);

  if (!isValidUuid(tokenValue)) return { ok: false, error: "リンクが不正です" };
  if (rating < 1 || rating > 5) return { ok: false, error: "評価を選択してください" };
  if (body.length < 20) return { ok: false, error: "本文を 20 文字以上で入力してください" };

  const token = await findTokenByValue(admin, tokenValue);
  const v = validateToken(token);
  if (!v.ok) return { ok: false, error: v.reason === "used" ? "このリンクは既に使用済です" : v.reason === "expired" ? "このリンクは有効期限切れです" : "このリンクは無効です" };

  // NG word detection (K-07): if matched, still save but with status=pending +
  // append note for CEO review (default behavior is already status=pending for all submissions)
  const ngHits = detectNgWords(`${title}\n${body}`);

  const sourceType = v.token.token_type === "gift" ? "gift" : "verified_purchase";

  // Always status=pending (Phase A-11 T-05)
  const reviewFields = [
    { key: "rating", value: String(rating) },
    { key: "title", value: title },
    { key: "body", value: await (async () => {
      if (isProbablyJapanese(body)) return body;
      const tr = await translateToJapanese(body);
      return tr ? body + "\n\n──── 日本語訳 ────\n\n" + tr : body;
    })() },
    { key: "reviewer_name", value: reviewer_name || v.token.customer_name || "匿名" },
    { key: "reviewer_email", value: v.token.email },
    { key: "source_type", value: sourceType },
    { key: "order_id", value: v.token.order_id },
    ...(v.token.token_type === "gift" ? [{ key: "gift_token_id", value: v.token.id }] : []),
    { key: "status", value: "pending" },
    ...(ngHits.length > 0 ? [{ key: "reply_text", value: `[automated NG flag] hits: ${ngHits.join(", ")}` }] : []),
  ];

  const createRes = await admin.graphql(CREATE_REVIEW_MUTATION, {
    variables: { metaobject: { type: "astromeda_review", fields: reviewFields } },
  });
  const createJson = (await createRes.json()) as { data?: { metaobjectCreate?: { metaobject?: { id: string }; userErrors: Array<{ field: string[]; message: string }> } } };
  const errs = createJson.data?.metaobjectCreate?.userErrors ?? [];
  if (errs.length > 0) return { ok: false, error: "投稿の保存に失敗しました。しばらく経って再度お試しください。" };

  // Mark token as used_at
  await admin.graphql(MARK_USED_MUTATION, {
    variables: { id: v.token.id, fields: [{ key: "used_at", value: new Date().toISOString() }] },
  });

  return { ok: true, message: "ご投稿ありがとうございます。ASTROMEDA で確認後 1-2 営業日以内に公開いたします。" };
};

// ──────────────────────────────────────────────
// UI: 公開フォーム (Polaris は admin 用なので、ここはカスタム CSS で軽量に)
// ──────────────────────────────────────────────

export default function PublicReviewSubmit() {
  const data = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const nav = useNavigation();
  const submitting = nav.state === "submitting";

  if (data.state !== "ready") {
    return (
      <PublicShell>
        <h1 style={{ margin: 0, fontSize: 22 }}>レビュー投稿リンク</h1>
        <p style={{ color: "#475569", lineHeight: 1.7 }}>{data.message}</p>
        <a href="https://shop.mining-base.co.jp/" style={cta}>ASTROMEDA ストアへ戻る</a>
      </PublicShell>
    );
  }

  if (result?.ok) {
    return (
      <PublicShell>
        <h1 style={{ margin: 0, fontSize: 22 }}>投稿完了</h1>
        <p style={{ color: "#475569", lineHeight: 1.7 }}>{result.message}</p>
        <a href="https://shop.mining-base.co.jp/" style={cta}>ASTROMEDA ストアへ戻る</a>
      </PublicShell>
    );
  }

  const token = data.token;

  return (
    <PublicShell>
      <h1 style={{ margin: 0, fontSize: 22 }}>レビュー投稿フォーム</h1>
      <p style={{ color: "#475569", lineHeight: 1.7 }}>
        {token.customer_name || "お客様"} へ・3 分でご感想をお寄せください。
      </p>

      <Form method="post">
        <input type="hidden" name="token" value={token.token} />

        <label style={fieldLabel}>評価 (必須)</label>
        <div style={{ display: "flex", gap: 4, marginBottom: 16 }}>
          {[1, 2, 3, 4, 5].map((n) => (
            <label key={n} style={{ display: "inline-flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
              <input type="radio" name="rating" value={n} required style={{ accentColor: "#0d9488" }} />
              <span style={{ color: "#0d9488", fontSize: 24 }}>{"★".repeat(n)}</span>
            </label>
          ))}
        </div>

        <label style={fieldLabel}>タイトル (任意 / 80 字以内)</label>
        <input name="title" maxLength={80} style={fieldInput} placeholder="例: 想像以上の高品質でした" />

        <label style={fieldLabel}>本文 (必須 / 20 〜 2000 字)</label>
        <textarea name="body" minLength={20} maxLength={2000} required rows={8} style={{ ...fieldInput, resize: "vertical", minHeight: 160 }} placeholder="商品を使ってみた感想を教えてください" />

        <label style={fieldLabel}>表示名 (任意 / 入力なしは「{token.customer_name || "匿名"}」)</label>
        <input name="reviewer_name" maxLength={40} style={fieldInput} placeholder="例: たかし" />

        {result && !result.ok ? (
          <div style={{ color: "#d72c0d", margin: "12px 0", fontSize: 14 }}>{result.error}</div>
        ) : null}

        <button type="submit" disabled={submitting} style={{ ...cta, opacity: submitting ? 0.6 : 1, cursor: submitting ? "wait" : "pointer", border: "none", width: "100%" }}>
          {submitting ? "送信中..." : "レビューを投稿する"}
        </button>
      </Form>

      <p style={{ marginTop: 24, fontSize: 12, color: "#94a3b8", lineHeight: 1.6 }}>
        投稿いただいたレビューは ASTROMEDA で確認後、公開いたします。
        個人情報は <a href="https://shop.mining-base.co.jp/policies/privacy-policy" style={{ color: "#0d9488" }}>プライバシーポリシー</a> に従って取り扱われます。
      </p>
    </PublicShell>
  );
}

function PublicShell({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <title>レビュー投稿 | ASTROMEDA</title>
      </head>
      <body style={{ margin: 0, padding: 0, background: "#f8fafc", fontFamily: '-apple-system, "Hiragino Sans", "Yu Gothic UI", "Meiryo", sans-serif', color: "#0f172a", lineHeight: 1.6 }}>
        <div style={{ background: "#0d9488", padding: 18, textAlign: "center" }}>
          <span style={{ color: "#fff", fontSize: 18, fontWeight: 700, letterSpacing: 2 }}>ASTROMEDA</span>
        </div>
        <main style={{ maxWidth: 600, margin: "32px auto", padding: 24, background: "#fff", borderRadius: 12, boxShadow: "0 1px 3px rgba(0,0,0,.06)" }}>
          {children}
        </main>
        <footer style={{ textAlign: "center", padding: "24px 16px 40px", fontSize: 11, color: "#94a3b8" }}>
          ASTROMEDA / 株式会社マイニングベース
        </footer>
      </body>
    </html>
  );
}

const fieldLabel: React.CSSProperties = { display: "block", marginTop: 16, marginBottom: 6, fontWeight: 600, fontSize: 13, color: "#1e293b" };
const fieldInput: React.CSSProperties = { display: "block", width: "100%", padding: "10px 12px", border: "1px solid #e2e8f0", borderRadius: 8, fontSize: 16, fontFamily: "inherit", boxSizing: "border-box" };
const cta: React.CSSProperties = { display: "inline-block", marginTop: 20, padding: "12px 24px", background: "#0d9488", color: "#fff", textDecoration: "none", borderRadius: 8, fontWeight: 500, fontSize: 16, minHeight: 44, textAlign: "center", lineHeight: 1.4 };
