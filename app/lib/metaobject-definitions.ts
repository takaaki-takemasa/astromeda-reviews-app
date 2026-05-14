/**
 * Astromeda Reviews App - Metaobject Definitions
 *
 * Phase B: 5/14 完了 (REV-EMB-2026-Q2)
 *
 * これらの Metaobject 定義は production-mining-base.myshopify.com 上に
 * 既に存在する (一部は前 Hydrogen 実装で作成、astromeda_audit_log は Phase B で追加)。
 *
 * 新しい store にインストールする場合は app/routes/api.admin.setup.tsx
 * (Phase B-08 で実装予定) を叩いて metaobjectDefinitionCreate を実行する。
 *
 * 既存定義の field 名と GID:
 */

export type MetaobjectType =
  | "astromeda_review"
  | "astromeda_review_token"
  | "astromeda_review_email_config"
  | "astromeda_review_email_queue"
  | "astromeda_review_summary"
  | "astromeda_qa"
  | "astromeda_audit_log";

export const METAOBJECT_GIDS: Record<MetaobjectType, string> = {
  // 本体レビュー (22 fields: product_ref, rating, title, body, photo_1..6, reviewer_name, reviewer_email, source_type, order_id, gift_token_id, status, collection_tags, reply_text, reply_at, helpful_count, approved_at, approved_by)
  astromeda_review: "gid://shopify/MetaobjectDefinition/20792344868",

  // 招待トークン (10 fields: token, email, customer_name, order_id, token_type, product_refs, expires_at, used_at, issued_by, gift_note)
  astromeda_review_token: "gid://shopify/MetaobjectDefinition/20792377636",

  // メール設定 / テンプレート (13 fields: target_type, target_handle, target_label, enabled, delay_days, subject, body_template, reply_to, incentive_text, last_modified_at, last_modified_by, enabled_at, enabled_by)
  astromeda_review_email_config: "gid://shopify/MetaobjectDefinition/20794016036",

  // 送信予約キュー (11 fields: order_id, email, customer_name, product_refs, config_id, fulfilled_at, scheduled_at, sent_at, status, error_message, token_id)
  astromeda_review_email_queue: "gid://shopify/MetaobjectDefinition/20794048804",

  // 集計キャッシュ (13 fields: product_ref, total_count, average_rating, star_1..5_count, photo_count, verified_count, gift_count, last_updated)
  astromeda_review_summary: "gid://shopify/MetaobjectDefinition/20792443172",

  // 商品 Q&A (9 fields: product_ref, question, answer, asker_name, asker_email, answered_by, status, helpful_count, answered_at)
  astromeda_qa: "gid://shopify/MetaobjectDefinition/20792410404",

  // 監査ログ append-only (9 fields: actor, action, resource_id, resource_type, timestamp, ip, user_agent, request_id, metadata_json)
  astromeda_audit_log: "gid://shopify/MetaobjectDefinition/20809089316",
};

/**
 * 各 Metaobject の TypeScript 型表現 (Phase B+ で実装時に拡張)
 */

export type ReviewStatus = "pending" | "approved" | "rejected";
export type ReviewSourceType = "verified_purchase" | "gift" | "manual";
export type ReviewTokenType = "purchase" | "gift";
export type EmailQueueStatus = "queued" | "scheduled" | "sent" | "failed";
// Metaobject astromeda_review_email_config の target_type は single_choice enum で
// "global" / "ip_collection" / "product_collection" の 3 値のみ許容。
// 詳細分類は target_handle の接頭辞 (product: / ip: / color: / gpu:) で encode。
export type EmailConfigTargetType = "global" | "ip_collection" | "product_collection";
export type AuditAction =
  | "review.approve"
  | "review.reject"
  | "review.delete"
  | "review.reply"
  | "token.issue"
  | "token.revoke"
  | "config.update"
  | "config.enable"
  | "config.disable"
  | "email.send"
  | "email.skip";

export interface AstromedaAuditLogFields {
  actor: string;                  // required
  action: AuditAction | string;   // required
  resource_id: string;             // required - gid://shopify/...
  resource_type?: MetaobjectType;
  timestamp: string;               // required - ISO 8601
  ip?: string;
  user_agent?: string;
  request_id?: string;
  metadata_json?: string;          // JSON-stringified extra context
}

/**
 