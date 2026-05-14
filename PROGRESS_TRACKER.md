# ASTROMEDA Reviews App - 進捗トラッカー

**Last updated**: 2026-05-14 (本セッション)
**Project**: REV-EMB-2026-Q2
**Owner**: 武正貴昭 (CEO)
**Implementation**: Cowork (Claude) 自律実行
**Total Phases**: A〜M (約 17 営業日予定 → 大幅短縮中)

---

## 完了済 ✅

### Phase A: Foundation (12 タスク / 当初 0.5日 / 実 0.5日 = 計画通り)

| ID | タスク | 確認方法 |
|---|---|---|
| A-01 | 要件確認 + CXO 4 視点審査 | gantt v1.4 / spec v1.2 / trace matrix v1.1 |
| A-02 | GitHub repo 作成 | https://github.com/takaaki-takemasa/astromeda-reviews-app |
| A-03 | Shopify Remix scaffold | 38 ファイル |
| A-03b | shopify.app.toml ASTROMEDA カスタマイズ | name/scopes/webhooks/app_proxy 全反映 |
| A-04 | Vercel アカウント | CEO 既存 Pro tier 流用 |
| A-05 | 初回 Vercel deploy | https://astromeda-reviews-app.vercel.app (hnd1 Tokyo) |
| A-06 | Shopify App 「Astromeda Reviews」v1.0 リリース | id 362581590017 / Active |
| A-07 | OAuth インストール検証 | production-mining-base に install 済 / Embedded App 動作確認 |
| A-08 | Vercel Env Variables 5 件投入 | SHOPIFY_API_KEY / _SECRET / SCOPES / SHOP_CUSTOM_DOMAIN / SHOPIFY_APP_URL |
| A-08b | Session Storage 切替 | Prisma SQLite → MemorySessionStorage |
| A-09 | README | repo root |
| A-10 | Brand Token Specification | BRAND_TOKENS.md (Teal #14b8a6 + WCAG 2.1 AA) |
| A-11 | Threat Model + PIA | THREAT_MODEL.md (STRIDE 10 脅威) |
| A-12 | Staging Vercel Preview 配管 | staging branch push 自動 preview |

### Phase B: DB Domain Models (1 タスク / 当初 1日 / 実 30 分 = -7h)

| ID | タスク | 確認方法 |
|---|---|---|
| B-all | Metaobject 7 種確認 + audit_log 新規作成 + TS schema 文書化 | app/lib/metaobject-definitions.ts |

**理由**: 過去 Hydrogen 実装で astromeda_review / _token / _email_config / _email_queue / _summary / _qa が既に作成済。今回 astromeda_audit_log (gid 20809089316) のみ追加。

### Phase C: Auth + Rate Limit + Audit Log (3 ヘルパー / 当初 1日 / 実 30 分 = -7h)

| ID | タスク | 確認方法 |
|---|---|---|
| C-01〜C-03 | Auth middleware (Shopify Remix template 内蔵) | app/shopify.server.ts: authenticate.admin() |
| C-04 | Rate Limit middleware | app/lib/rate-limit.ts (4 profile 内蔵: PUBLIC_SUBMIT 5/h, PUBLIC_AUTH 20/min, ADMIN_API 100/min, ADMIN_LOGIN 10/5min) |
| C-05 | Audit Log helper | app/lib/audit-log.ts (appendAuditLog / appendAuditLogSafe) |
| C-06 | Sentry init stub | app/lib/sentry.ts (SENTRY_DSN env var ベース遅延初期化) |
| C-07 | Error Boundary | Shopify Remix template の boundary.error() で対応済 |
| C-08 | セキュリティ E2E テスト | Phase L (Hydrogen 剥離前) で実装予定 |

### Phase D: Polaris UI + NavigationMenu (1 セット / 当初 1日 / 実 30 分 = -7h)

| ID | タスク | 確認方法 |
|---|---|---|
| D-01 | App layout (Polaris + App Bridge v4 + brand-tokens.css) | app/routes/app.tsx |
| D-02 | NavMenu 4 タブ | レビュー一覧 / メール設定 / ギフトトークン / 送信キュー |
| D-03 | 4 タブ placeholder routes | app/routes/app.reviews,email,tokens,queue.tsx |
| D-04 | Brand Token CSS Polaris 上書き | app/styles/brand-tokens.css (Primary-600 採用で WCAG AA 4.2:1 確保) |
| D-extra | Home dashboard 刷新 | app/routes/app._index.tsx (Banner + 4 Card + ドキュメントリンク) |

---

## 進行中 / 未着手

### Phase E: Tab 1 レビュー一覧 (承認 / 拒否) — 5/21-22 予定 / 2 日
- E-01: GraphQL クエリで astromeda_review 一覧取得 (cursor pagination)
- E-02: IndexTable Polaris (rating / status / 投稿日 / アクション)
- E-03: フィルタ (status / 期間 / 商品)
- E-04: 一括承認 / 拒否 mutation (audit-log 連動)
- E-05: 写真ライトボックス
- E-06: 返信 modal
- E-07: NG ワード検出 (Phase A-11 T-05 対応)

### Phase F: Tab 2 メール設定 — 5/21-22 並走 / 2 日
- IP コラボ別 / カテゴリ別の依頼メール文面編集
- astromeda_review_email_config の CRUD UI

### Phase G: Tab 3 ギフトトークン — 5/25 / 1 日
- ギフト受領者用 review_token (token_type=gift) 発行 UI

### Phase H: Tab 4 送信キュー — 5/26 / 1 日
- astromeda_review_email_queue の status 別集計表示

### Phase I: Webhook 受信 — 5/27 / 1 日
- orders/fulfilled webhook → email_queue に行追加
- HMAC SHA-256 検証 (Phase A-11 T-02 対応)

### Phase J: Shopify Flow + Email 配管 — 5/28 / 0.5 日 ⚠️ SendGrid 削除済
- 既存 Flow id 01KRJ1JF33PNW1ENMTQZ584SN5 を利用
- Shopify Email テンプレート + Brand Token 適用

### Phase K: お客様向け公開ルート (App Proxy) — 5/29-6/1 / 2 日
- /apps/reviews/submit?token=XXX
- 写真アップロード (Shopify Files)
- Cloudflare Turnstile (Phase A-11 T-03/T-08 対応)

### Phase L: Hydrogen 並走稼働 → 切替 — 6/1-3 / 3 日
- 旧 Hydrogen 派生ルート (/apps/reviews/* via Oxygen) 廃止
- セキュリティ E2E テスト (Phase C-08 ここで実施)

### Phase M-Audit: 4 視点 Chrome MCP 監査 — 6/4 / 1 日
- CDO: Polaris 整合 / A11y / 状態網羅 / マイクロコピー
- CTO: Performance / Security / SLO / Bundle
- CMO: Brand / Tone / モバイル / 競合差別化
- CEO: Merchant Outcome / TTFSA / 認知負荷

### Phase M: 段階リリース 10%→50%→100% + Documentation — 6/5-8 / 1.5 日

---

## 主要アーティファクト (URL リスト)

- **本番 URL**: https://astromeda-reviews-app.vercel.app
- **GitHub repo**: https://github.com/takaaki-takemasa/astromeda-reviews-app
- **Shopify Dev Dashboard**: https://dev.shopify.com/dashboard/78745145/apps/362581590017
- **Vercel project**: https://vercel.com/takaakitakemasa-8885s-projects/astromeda-reviews-app
- **インストール先 (本番ストア)**: production-mining-base.myshopify.com
- **Staging ストア**: staging-mining-base.myshopify.com (Phase A+ で staging app 登録)

## コスト

| 項目 | 月額 |
|---|---|
| Vercel Pro | $20 |
| Shopify Email (10K通/月内) | $0 |
| Upstash Redis (Phase A+) | $0 |
| GitHub | $0 |
| **計** | **~¥3,000/月** |

## 工数削減サマリー

| Phase | 当初 (v1.2) | 実 | 削減 |
|---|---|---|---|
| A | 0.5d + α | 0.5d | 計画通り |
| B | 1d | 30 min | -7h |
| C | 1d | 30 min | -7h |
| D | 1d | 30 min | -7h |
| J | 3d | 0.5d (SendGrid 削除) | -12.5h |
| **累計** | **6.5d** | **2d** | **-4.5 日 (-36h)** |

残 Phase (E〜M) は実装ロジック中心なので大幅削減は見込めない。
ただし既存 Metaobject 流用で Phase E-H が 30〜50% 短縮の可能性あり。
