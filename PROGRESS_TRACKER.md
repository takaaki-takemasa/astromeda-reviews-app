# ASTROMEDA Reviews App - 進捗トラッカー

**Last updated**: 2026-05-14 (本セッション 11 Phase 完了 / Phase J Flow 適用待ち + M-Audit / M 残)
**Project**: REV-EMB-2026-Q2
**Owner**: 武正貴昭 (CEO)
**Implementation**: Cowork (Claude) 自律実行
**進捗**: 17 営業日想定 → 1 セッションで Phase A〜L のコア実装完了

---

## ✅ 完了 Phase

### Phase A: Foundation (12/12)
全 A-01〜A-12 完了。production-mining-base にインストール済の Embedded App が
https://astromeda-reviews-app.vercel.app で稼働中。詳細は PHASE_A_COMPLETE.md。

### Phase B: DB Models (1/1)
Metaobject 7 種 (既存 6 + astromeda_audit_log 新規追加)。
app/lib/metaobject-definitions.ts に GID + TS 型を文書化。

### Phase C: Auth + Rate Limit + Audit Log (3 ヘルパー実装)
- app/lib/audit-log.ts (T-06 対応)
- app/lib/rate-limit.ts (T-08/T-10 対応・4 profile)
- app/lib/sentry.ts (SENTRY_DSN ベース遅延 init stub)

### Phase D: Polaris UI Foundation (1 セット)
NavMenu 4 タブ + 4 placeholder routes + Brand Token CSS + Home dashboard。

### Phase E: Tab 1 レビュー一覧 (core 完了)
GraphQL loader + IndexTable + Polaris Tabs (pending/approved/rejected) +
一括承認/拒否 action + audit-log 連動。
残: 写真ライトボックス / 返信 modal (Phase E+)。

### Phase F: Tab 2 メール設定 (完全 CRUD)
astromeda_review_email_config の create/update/delete/toggle 完全実装。
Modal で target_type 4 種 / handle / 件名 / Liquid 本文 / delay_days 編集可。

### Phase G: Tab 3 ギフトトークン (完全実装)
発行 form modal + URL コピー + 4 フィルタタブ。
crypto.randomUUID + astromeda_review_token に append。

### Phase H: Tab 4 送信キュー (完全実装)
astromeda_review_email_queue 読取専用一覧。5 タブ + カウント表示。

### Phase I: Webhook orders/fulfilled (完全実装)
HMAC 検証 + product_tags マッチング + delay_days 算出 + queue 自動投入。

### Phase J: endpoint 実装完了 + Flow draft 保存済
- /api/tokens/issue endpoint 実装 ✅
- Shopify Flow の HTTP request URL を Vercel エンドポイントに draft 保存 ✅
- **残**: Flow editor の 適用ボタン (Chrome MCP click 不安定だったため次回ワンクリック必要)

### Phase K (core): お客様向け公開フォーム
/proxy/submit (App Proxy 経由)。token 検証 + Rate Limit + NG ワード自動検出 +
mobile-first 軽量 HTML form。
残: 写真アップロード (K-04, Shopify Files 連携)。

### Phase L: Hydrogen 並走停止
旧 Hydrogen 内蔵口コミルート 10 ファイルを deprecation stub に置換
(astromeda-ec commit 5b8c44e / -2982 行)。
- customer-facing routes → 301 redirect
- admin/API routes → 410 Gone

---

## 未着手 / 部分残

### Phase J Flow editor 残作業 (5 分)
Chrome MCP で Shopify Admin → Flow → 「New Workflow」を開いて
画面右上の「変更を適用」をクリック。draft は URL = Vercel endpoint で保存済。

### Phase M-Audit: 4 視点監査 (1d / 6/4 予定)
**事前準備**: 数件のテストレビューデータが必要 (Phase J 適用後 14 日経過で自動取得 or 手動投入)。
- 🎨 CDO Audit (90 min): Polaris 整合 / A11y / 状態網羅 / マイクロコピー
- ⚙️ CTO Audit (90 min): Performance / Security / SLO / Bundle
- 📣 CMO Audit (60 min): Brand / Tone / モバイル / 競合差別化
- 👔 CEO Audit (60 min): Merchant Outcome / TTFSA / 認知負荷

### Phase M: 段階リリース + 最終ドキュメント (1.5d / 6/5-8 予定)
- 10% → 50% → 100% rollout (お客様のメール送信は Shopify Flow 経由なので Flow 側で
  segment 条件を追加して段階化可能)
- Sentry alert 設定 (SENTRY_DSN 取得後 init を有効化)
- Rollback Drill (Phase A-11 v1.2 で追加)
- 最終 README + 運用マニュアル

### 各 Phase 内の小残 (Phase E+ / K+)
- E-05: 写真ライトボックス (Tab 1 一覧)
- E-06: 返信 modal (Tab 1 一覧 → astromeda_review.reply_text/reply_at)
- K-04: 写真アップロード (公開フォーム → Shopify Files)
- C-08: セキュリティ E2E テスト (401/403/429 シナリオ)
- M-08: Rollback Drill (MTTR < 5 分の意図的障害発火訓練)

---

## 主要アーティファクト

| 項目 | URL |
|---|---|
| 本番 Embedded App | https://astromeda-reviews-app.vercel.app |
| GitHub (reviews-app) | https://github.com/takaaki-takemasa/astromeda-reviews-app |
| GitHub (hydrogen-ec) | https://github.com/takaaki-takemasa/astromeda-ec |
| Shopify Dev Dashboard | https://dev.shopify.com/dashboard/78745145/apps/362581590017 |
| Vercel project | https://vercel.com/takaakitakemasa-8885s-projects/astromeda-reviews-app |
| Shopify Flow (口コミ) | https://admin.shopify.com/store/production-mining-base/apps/flow/editor/019e2419-3c69-745b-b26f-31b592fda8ac/... |
| 公開フォーム | https://shop.mining-base.co.jp/apps/reviews/submit?token=XXX |

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
| J endpoint | 3d | 30 min | -23h |
| K core | 2d | 30 min | -15h |
| L | 3d | 20 min | -23h |
| **累計** | **18.5d** | **4d 相当** | **-145h** |

残: J Flow 適用 (5 分) + M-Audit (1d) + M (1.5d) = 約 2.5 日。

## 確定スタック

```
[お客様注文 fulfilled] → [Shopify Flow] (14日 delay)
                            ↓ HTTP request
[Vercel /api/tokens/issue] → astromeda_review_token append
                            ↓
[Shopify Email] (Brand Token 適用) → [お客様メール]
                            ↓ CTA クリック
[shop.mining-base.co.jp/apps/reviews/submit?token=XXX]
                            ↓ App Proxy
[Vercel /proxy/submit] → token 検証 / Rate Limit / NG ワード
                            ↓
[astromeda_review] status=pending → [Embedded App Tab 1 で CEO 承認]
                            ↓ 承認後
[Storefront 商品ページに表示] (ReviewStars Hydrogen component)
```

## CEO への申し送り

本セッション完了時点で **MVP 機能としては動作可能** な状態:
- 管理画面 4 タブ全部稼働
- 公開フォーム動作確認可能
- Webhook 受信動作
- audit-log で全 admin 操作の証跡

Phase J Flow 適用 (5 分) と Phase M-Audit (1日) と Phase M (1.5日) で完全 GA に到達。
