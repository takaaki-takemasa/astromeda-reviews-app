# Phase A Foundation - 完了報告

**日付**: 2026-05-14
**プロジェクト**: REV-EMB-2026-Q2 (Astromeda Reviews Embedded App)
**ステータス**: 🟢 **Phase A 完了 - Phase B (DB Domain Models) に進行可能**

---

## 完了タスク一覧

| ID | タスク | 完了状況 | アーティファクト |
|---|---|---|---|
| A-01 | キックオフ・要件最終確認 | ✅ | gantt v1.4 / spec v1.2 / trace matrix v1.1 |
| A-02 | GitHub repo 作成 | ✅ | https://github.com/takaaki-takemasa/astromeda-reviews-app |
| A-03 | Shopify Remix App テンプレート scaffold | ✅ | 38 ファイル |
| A-03b | shopify.app.toml + package.json カスタマイズ | ✅ | name=astromeda-reviews, embedded=true |
| A-04 | Vercel アカウント | ✅ | CEO 既存 (takaakitakemasa-8885's, Pro tier) |
| A-05 | 初回 Vercel deploy | ✅ | https://astromeda-reviews-app.vercel.app (hnd1 Tokyo Edge) |
| A-06 | Shopify App 「Astromeda Reviews」新規作成 + v1.0 リリース | ✅ | App id 362581590017 / v1.0-initial-vercel-app-proxy 有効 |
| A-07 | OAuth インストールフロー検証 | ✅ | production-mining-base にインストール成功 / Embedded App 動作確認 |
| A-08 | Vercel Env Variables 設定 | ✅ | 5 keys: SHOPIFY_API_KEY / _SECRET / SCOPES / SHOP_CUSTOM_DOMAIN / SHOPIFY_APP_URL |
| A-08b | Session Storage 切替 | ✅ | Prisma SQLite → MemorySessionStorage (Vercel serverless 対応) |
| A-09 | プロジェクト README | ✅ | README.md (4.5 KB) |
| A-10 | Brand Token 仕様 | ✅ | BRAND_TOKENS.md (Teal #14b8a6 + Polaris extension + WCAG 2.1 AA) |
| A-11 | Threat Model + PIA | ✅ | THREAT_MODEL.md (STRIDE 10 脅威 + 個人情報保護法/ステマ法対応) |
| A-12 | Staging 配管 | ✅ | staging branch push → Vercel Preview Deployment 自動 |

## v1.0 → v1.4 変更履歴 (今回のセッションで実施)

| Version | 変更 | 理由 |
|---|---|---|
| v1.0 | 初版 (Gantt + Spec + Trace Matrix) | CXO 提出可能レベルの計画 |
| v1.1 | + Traceability Matrix | タスクと仕様のクロスリファレンス |
| v1.2 | + Phase M-Audit / Brand Token / Threat Model / Staging / Rollback Drill / Gradual Rollout | 4 視点 CXO レビュー指摘の反映 |
| **v1.3** | **SendGrid 削除 → Shopify Flow + Shopify Email** | **CEO 指摘**: Shopify ネイティブ機能で代替可能 |
| **v1.4** | **Fly.io → Vercel** | **CEO 指示**: 既存 Vercel アカウント Pro tier 流用 |

## 工数削減効果

| Phase | 当初 (v1.2) | 確定 (v1.4) | 削減 |
|---|---|---|---|
| A 全体 | 0.5d + α | 0.5d 完了 | 計画通り |
| J (Email) | 3 日 | 0.5 日 | **-12.5h** (SendGrid 削除) |
| A-04 アカウント | 30 min | 10 min | -20 min (Vercel 既存) |
| A-05 deploy | 45 min | 25 min | -20 min |
| A-12 staging | 45 min | 自動 | -45 min (Vercel Preview) |

## 確定したスタック

```
[お客様] --購入--> [Shopify Order]
                       |
                       v
              [Shopify Flow] (14日 delay)
                       |
                       v
              [Vercel /api/tokens/issue]
                       |
                       +-- [Shopify Metaobject astromeda_review_token]
                       |
                       v
              [Shopify Email] (Brand Token 適用済 HTML)
                       |
                       v
              [お客様メール] --CTA クリック-->
                       v
              [shop.mining-base.co.jp/apps/reviews/submit?token=XXX]
                       |
                       v  (App Proxy → Vercel)
              [astromeda-reviews-app.vercel.app/proxy/submit]
                       |
                       +-- 写真 → [Shopify Files]
                       +-- レビュー保存 → [Shopify Metaobject astromeda_review]
                                          |
                                  (CEO 承認後)
                                          v
                                [Storefront 表示]
```

### コスト合計

| 項目 | 月額 |
|---|---|
| Vercel Pro (Embedded App ホスト) | $20 |
| Shopify Email (10K通/月内) | $0 |
| Upstash Redis (Phase A+ で導入予定) | $0 (無料 256MB) |
| GitHub (private repo) | $0 |
| Sentry (free tier) | $0 |
| **計** | **約 ¥3,000/月** |

## 次のフェーズ (Phase B: 5/18, 1日)

DB Domain Models = Shopify Metaobjects 6 定義を作成:
1. astromeda_review (本体)
2. astromeda_review_token (招待トークン)
3. astromeda_email_template (メール文面)
4. astromeda_send_queue (送信履歴)
5. astromeda_gift_token (ギフトコード関連)
6. astromeda_audit_log (CEO 承認ログ)

CEO 操作不要・自律実行可能。

---

## CEO への報告フォーマット

CEO は非エンジニア。本ファイルがあれば一目で進捗が分かる:
- 上の表 = 全タスクの完了状態
- v1.0→v1.4 履歴 = なぜ計画が変わったか
- 「次のフェーズ」セクション = 次に何をやるか

次回更新は Phase B 完了時 (5/18 予定)。
