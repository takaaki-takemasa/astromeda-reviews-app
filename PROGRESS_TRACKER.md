# ASTROMEDA Reviews App - 進捗トラッカー

**Last updated**: 2026-05-14 (本セッション・10 Phase 完了)
**Project**: REV-EMB-2026-Q2
**Owner**: 武正貴昭 (CEO)
**Implementation**: Cowork (Claude) 自律実行
**Total Phases**: A〜M (約 17 営業日予定 → 1 セッションで Phase K まで進捗)

---

## ✅ 完了済 (A〜I, K)

### Phase A: Foundation (12 タスク / 0.5d → 0.5d 計画通り)
全タスク (A-01〜A-12) 完了。本番 URL https://astromeda-reviews-app.vercel.app で稼働中、production-mining-base にインストール済。

### Phase B: DB Domain Models (1 タスク / 1d → 30 min, -7h)
Metaobject 7 種確認 + astromeda_audit_log 新規作成 + TS schema (app/lib/metaobject-definitions.ts) 文書化。

### Phase C: Auth + Rate Limit + Audit Log (3 ヘルパー / 1d → 30 min, -7h)
- app/lib/audit-log.ts: appendAuditLog + appendAuditLogSafe
- app/lib/rate-limit.ts: 4 profile (PUBLIC_SUBMIT/PUBLIC_AUTH/ADMIN_API/ADMIN_LOGIN)
- app/lib/sentry.ts: SENTRY_DSN ベース遅延初期化 stub

### Phase D: Polaris UI Foundation (1 セット / 1d → 30 min, -7h)
NavMenu 4 タブ (レビュー一覧 / メール設定 / ギフトトークン / 送信キュー) + Brand Token CSS + Home dashboard + 4 placeholder routes。

### Phase E: Tab 1 レビュー一覧 (2d → 30 min, -15h)
- GraphQL loader (metaobjects astromeda_review)
- IndexTable (評価/タイトル/本文/投稿者/経路/状態/日時)
- Polaris Tabs 3 タブ (pending/approved/rejected) + cursor pagination
- 一括承認/拒否 action with audit-log 連動
- 残: 写真ライトボックス / 返信 modal は Phase E+ で

### Phase F: Tab 2 メール設定 (2d → 30 min, -15h)
- astromeda_review_email_config 完全 CRUD (create/update/delete/toggle)
- 編集 Modal (target_type 4 種 / handle / 件名 / 本文 Liquid テンプレート / delay_days / reply_to / インセンティブ)
- enable toggle で audit-log 連動

### Phase G: Tab 3 ギフトトークン (1d → 30 min, -7h)
- ギフトトークン発行 form (email/name/order_id/gift_note/expires_days)
- crypto.randomUUID() + astromeda_review_token (token_type=gift) append
- URL コピー UI (`/apps/reviews/submit?token=XXX`)
- 4 フィルタタブ (すべて/ギフト/購入/期限切れ)

### Phase H: Tab 4 送信キュー (1d → 30 min, -7h)
- astromeda_review_email_queue 読取専用一覧
- 5 タブ (all/queued/scheduled/sent/failed) + カウント表示
- 注文 ID / 宛先 / 発送日 / 送信予定 / 送信日時 / 状態 表示

### Phase I: Webhook orders/fulfilled (1d → 30 min, -7h)
- /webhooks/orders/fulfilled receiver (authenticate.webhook の HMAC 検証使用)
- order の product_tags でマッチング → enabled な email_config を取得
- delay_days から scheduled_at 算出 → email_queue に append
- audit-log 連動

### Phase K (core): お客様向け公開フォーム (2d → 30 min, -15h)
- /proxy/submit (App Proxy 経由) → authenticate.public.appProxy()
- token UUID 検証 / expired / used チェック
- Rate Limit (PUBLIC_AUTH 20/min, PUBLIC_SUBMIT 5/h) 強制
- NG ワード自動検出 (基本パターン)
- status='pending' 強制 + token used_at マーク
- mobile-first 軽量 HTML form (Polaris 不使用 / 44px tap target / WCAG AA)
- 残: 写真アップロード (K-04) は Phase K+ で

---

## 進行中 / 未着手

### Phase J: Shopify Flow + Email 配管 (0.5d / 5/28)
- ⚠️ 既存 Flow id `01KRJ1JF33PNW1ENMTQZ584SN5` を再利用済
- 残作業: Flow から /api/tokens/issue を呼ぶ HTTP request アクションを追加
  + Shopify Email テンプレートに Brand Token 適用
- Chrome MCP で Shopify Admin → Workflow Editor 経由で設定。
- /api/tokens/issue endpoint の実装が未着手 (Phase J+1 で 30 分以内に実装可)

### Phase L: Hydrogen 並走稼働 → 切替 (3d / 6/1-3)
- 旧 Hydrogen 派生 /apps/reviews/* via Oxygen を停止
- 本番ドメイン App Proxy 確認 (shopify.app.toml の app_proxy URL は既に Vercel)
- セキュリティ E2E テスト (Phase C-08 の延期分)

### Phase M-Audit: 4 視点監査 (1d / 6/4)
- CDO/CTO/CMO/CEO の 4 persona で Chrome MCP 監査
- 90 + 90 + 60 + 60 = 300 min 想定

### Phase M: 段階リリース (1.5d / 6/5-8)
- 10% → 50% → 100% rollout
- Sentry alert 設定
- 最終ドキュメント

### 各 Phase 内の小残 (Phase E+ / K+)
- E-05: 写真ライトボックス (Tab 1)
- E-06: 返信 modal (Tab 1)
- K-04: 写真アップロード (公開フォーム → Shopify Files)
- /api/tokens/issue endpoint (Phase J 連携用)

---

## 主要アーティファクト

| 項目 | URL |
|---|---|
| 本番 URL | https://astromeda-reviews-app.vercel.app |
| GitHub repo | https://github.com/takaaki-takemasa/astromeda-reviews-app |
| Shopify App Dashboard | https://dev.shopify.com/dashboard/78745145/apps/362581590017 |
| Vercel project | https://vercel.com/takaakitakemasa-8885s-projects/astromeda-reviews-app |
| 公開フォーム (Phase K) | https://shop.mining-base.co.jp/apps/reviews/submit?token=XXX |

## コスト

| 項目 | 月額 |
|---|---|
| Vercel Pro | $20 |
| Shopify Email | $0 (10K/月内) |
| Upstash Redis (Phase A+) | $0 |
| GitHub | $0 |
| **計** | **~¥3,000/月** |

## 工数削減累計

| Phase | 当初 | 実 | 削減 |
|---|---|---|---|
| A | 0.5d | 0.5d | 計画通り |
| B | 1d | 30 min | -7h |
| C | 1d | 30 min | -7h |
| D | 1d | 30 min | -7h |
| E | 2d | 30 min | -15h |
| F | 2d | 30 min | -15h |
| G | 1d | 30 min | -7h |
| H | 1d | 30 min | -7h |
| I | 1d | 30 min | -7h |
| J | 3d | (削減済) | -12.5h (前: SendGrid 削除) |
| K (core) | 2d | 30 min | -15h |
| **累計** | **15.5d** | **3.5d 相当** | **-99.5h** |

残: L (3d) + M-Audit (1d) + M (1.5d) = 5.5 日。
