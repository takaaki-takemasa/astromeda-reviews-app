/**
 * Resend transactional email helper.
 *
 * Phase 2 で Draft Order Invoice 経由から Resend 経由に切り替えるためのラッパ。
 * - 開発/テスト時: from = "Astromeda Reviews <onboarding@resend.dev>" (Resend sandbox)
 *   制約: Resend account の owner email にしか送信できない
 * - 本番: mining-base.co.jp ドメインを Resend で verify 後、from を reviews@mining-base.co.jp に変更
 */

const RESEND_API_URL = "https://api.resend.com/emails";
const DEFAULT_FROM = process.env.RESEND_FROM || "Astromeda Reviews <onboarding@resend.dev>";

export interface SendEmailParams {
  to: string;
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
  tags?: Array<{ name: string; value: string }>;
}

export interface SendEmailResult {
  ok: boolean;
  id?: string;
  error?: string;
}

export async function sendEmail(params: SendEmailParams): Promise<SendEmailResult> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return { ok: false, error: "RESEND_API_KEY env var not set" };
  }
  try {
    const body: any = {
      from: DEFAULT_FROM,
      to: [params.to],
      subject: params.subject,
      html: params.html,
    };
    if (params.text) body.text = params.text;
    if (params.replyTo) body.reply_to = params.replyTo;
    if (params.tags) body.tags = params.tags;

    const res = await fetch(RESEND_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as { id?: string; message?: string; name?: string };
    if (!res.ok) {
      return { ok: false, error: json.message || json.name || `HTTP ${res.status}` };
    }
    return { ok: true, id: json.id };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

function esc(s: string): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export interface ReviewRequestEmailParams {
  to: string;
  customerName: string;
  productTitle: string;
  reviewUrl: string;
  couponPitch?: string;
}

export async function sendReviewRequestEmail(p: ReviewRequestEmailParams): Promise<SendEmailResult> {
  const subject = `[Astromeda] ${p.productTitle} のレビューをお願いします`;
  const pitchBlock = p.couponPitch
    ? `<div style="margin: 24px 0; padding: 20px; background: linear-gradient(135deg, #fef3c7 0%, #fde68a 100%); border-radius: 12px; text-align: center;"><div style="font-size: 28px; margin-bottom: 8px;">🎁</div><p style="margin: 0; font-size: 16px; font-weight: 700; color: #92400e;">${esc(p.couponPitch)}</p></div>`
    : "";
  const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject)}</title></head><body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Hiragino Sans','Yu Gothic',sans-serif;color:#111827;"><table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f9fafb;padding:40px 16px;"><tr><td align="center"><table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,0.06);"><tr><td style="padding:32px 32px 8px 32px;"><p style="margin:0;font-size:13px;color:#9ca3af;letter-spacing:2px;">ASTROMEDA</p><h1 style="margin:8px 0 0 0;font-size:22px;font-weight:700;line-height:1.4;color:#06060C;">${esc(p.customerName)} 様、<br>レビューをお寄せいただけませんか?</h1></td></tr><tr><td style="padding:16px 32px;"><p style="margin:0 0 16px 0;font-size:15px;line-height:1.7;color:#374151;">先日ご利用いただいた<br><strong style="color:#06060C;">「${esc(p.productTitle)}」</strong><br>はいかがでしたでしょうか?</p><p style="margin:0 0 24px 0;font-size:15px;line-height:1.7;color:#374151;">お客様の声が次のお客様の購入判断を助け、より良い商品づくりにつながります。1分ほどでご投稿いただけます。</p><div style="text-align:center;margin:24px 0;"><a href="${esc(p.reviewUrl)}" style="display:inline-block;padding:14px 36px;background:#06060C;color:#ffffff;text-decoration:none;font-size:16px;font-weight:600;border-radius:8px;">レビューを投稿する</a></div>${pitchBlock}</td></tr><tr><td style="padding:16px 32px 32px 32px;border-top:1px solid #f3f4f6;"><p style="margin:0;font-size:12px;color:#9ca3af;line-height:1.6;">このメールは Astromeda レビューシステムから自動送信されています。<br>お心当たりがない場合はお手数ですがこのメールを破棄してください。</p></td></tr></table></td></tr></table></body></html>`;
  const text = `${p.customerName} 様\n\n先日ご利用いただいた「${p.productTitle}」はいかがでしたでしょうか?\n\nお客様の声が次のお客様の購入判断を助け、より良い商品づくりにつながります。\n1分ほどでご投稿いただけます。\n\n▶ レビューを投稿する\n${p.reviewUrl}\n\n${p.couponPitch ? "🎁 " + p.couponPitch + "\n\n" : ""}— Astromeda Reviews System`;
  return sendEmail({ to: p.to, subject, html, text, replyTo: "customersupport@mng-base.com", tags: [{ name: "type", value: "review_request" }] });
}

export interface ThankYouEmailParams {
  to: string;
  customerName: string;
  productTitle: string;
  couponCode: string;
  couponLabel: string;
  expiresAt: string;
  applicableScope: string;
}

export async function sendThankYouEmail(p: ThankYouEmailParams): Promise<SendEmailResult> {
  const subject = `[Astromeda] ${p.customerName} 様、レビューありがとうございます (🎁 ${p.couponLabel} クーポン同封)`;
  const expiresDate = (() => {
    try { const d = new Date(p.expiresAt); return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`; } catch { return p.expiresAt; }
  })();
  const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject)}</title></head><body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Hiragino Sans','Yu Gothic',sans-serif;color:#111827;"><table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f9fafb;padding:40px 16px;"><tr><td align="center"><table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,0.06);"><tr><td style="padding:32px 32px 8px 32px;text-align:center;"><div style="font-size:48px;">🎉</div><p style="margin:8px 0 0 0;font-size:13px;color:#9ca3af;letter-spacing:2px;">ASTROMEDA</p><h1 style="margin:8px 0 0 0;font-size:24px;font-weight:700;line-height:1.4;color:#06060C;">${esc(p.customerName)} 様、<br>レビューありがとうございました</h1></td></tr><tr><td style="padding:16px 32px;"><p style="margin:0 0 24px 0;font-size:15px;line-height:1.7;color:#374151;text-align:center;">「${esc(p.productTitle)}」へのレビュー、確かに公開させていただきました。<br>お礼として、次回お買い物に使えるクーポンをお送りいたします。</p><div style="margin:32px 0;padding:32px;background:linear-gradient(135deg,#06060C 0%,#1a1a2e 100%);border-radius:16px;text-align:center;"><div style="font-size:14px;color:#9ca3af;letter-spacing:1px;margin-bottom:8px;">YOUR COUPON</div><div style="font-size:36px;font-weight:800;color:#fbbf24;margin-bottom:16px;">${esc(p.couponLabel)} OFF</div><div style="display:inline-block;padding:16px 32px;background:#ffffff;border-radius:12px;border:2px dashed #fbbf24;"><div style="font-size:12px;color:#6b7280;margin-bottom:4px;">クーポンコード</div><div style="font-size:24px;font-weight:700;letter-spacing:3px;color:#06060C;font-family:'Courier New',monospace;">${esc(p.couponCode)}</div></div><div style="margin-top:16px;font-size:13px;color:#9ca3af;">対象: ${esc(p.applicableScope)}<br>有効期限: ${esc(expiresDate)} まで</div></div><div style="text-align:center;margin:24px 0;"><a href="https://shop.mining-base.co.jp/" style="display:inline-block;padding:14px 36px;background:#06060C;color:#ffffff;text-decoration:none;font-size:16px;font-weight:600;border-radius:8px;">お買い物に進む</a></div><p style="margin:24px 0 0 0;font-size:13px;line-height:1.7;color:#6b7280;">・お会計時にクーポンコードを入力してください<br>・お一人様1回限りのご利用です<br>・他のクーポンとは併用できません</p></td></tr><tr><td style="padding:16px 32px 32px 32px;border-top:1px solid #f3f4f6;"><p style="margin:0;font-size:12px;color:#9ca3af;line-height:1.6;">お問い合わせ: customersupport@mng-base.com<br>— Astromeda Reviews System</p></td></tr></table></td></tr></table></body></html>`;
  const text = `${p.customerName} 様\n\n「${p.productTitle}」へのレビューをありがとうございました。\nお礼として、次回お買い物に使えるクーポンをお送りします。\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n🎁 ${p.couponLabel} OFF クーポン\n\nクーポンコード: ${p.couponCode}\n\n対象: ${p.applicableScope}\n有効期限: ${expiresDate} まで\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n▶ お買い物に進む\nhttps://shop.mining-base.co.jp/\n\nお問い合わせ: customersupport@mng-base.com\n— Astromeda Reviews System`;
  return sendEmail({ to: p.to, subject, html, text, replyTo: "customersupport@mng-base.com", tags: [{ name: "type", value: "thank_you_coupon" }, { name: "coupon_code", value: p.couponCode }] });
}
