# Threat Model & Privacy Impact Assessment

**Project:** astromeda-reviews-app
**Document Version:** v1.0
**Date:** 2026-05-15
**Owner:** CTO (Claude) / Approver: CEO 武正貴昭

---

## 1. システム概要

ASTROMEDA EC のレビュー機能を提供する Shopify Embedded App。お客様の氏名・メールアドレス・写真・購入履歴を取り扱う。

### データフロー

```
[お客様] --(購入)--> [Shopify Order]
                        |
                        v
              [Shopify Flow] (orders/fulfilled trigger + 14日 delay)
                        |
                        v  HTTP POST + secret token
              [astromeda-reviews-app on Fly.io]
                        |
                        +-- (Token 発行) --> [Shopify Metaobject astromeda_review_token]
                        |
                        +-- (Token URL を Flow に返却)
                                |
                                v
                        [Shopify Email] --(noreply@mining-base.co.jp / DKIM/SPF は Shopify 側で完備)--> [お客様メール]
                                                |
                                                v   お客様クリック
                                       [App Proxy /apps/reviews/submit]
                                                |
                                                +-- (POST + photo) --> [Shopify Files]
                                                |
                                                +-- (Review 保存) --> [Shopify Metaobject astromeda_review]
                                                                            |
                                                                    (CEO 承認後)
                                                                            v
                                                                  [Storefront 表示]
```

## 2. STRIDE 脅威分析

| 脅威 | 種別 | リスク | 影響 | 緩和策 | 実装タスク |
|---|---|---|---|---|---|
| **T-01** 認証されていない管理画面アクセス | S (Spoofing) | High | 全レビューが操作可能 | App Bridge Session Token 検証 / RBAC | C-02, C-03 |
| **T-02** 偽の Webhook で queue 汚染 | S | Medium | スパムメール大量送信 | HMAC SHA-256 検証 (Shopify webhook secret) | I-02 |
| **T-03** 投稿フォーム偽トークン | S | Medium | 偽レビュー投稿 | UUID v4 + 90日期限 + 1回使用 + GraphQL Metaobject 検証 | K-02, B-05 |
| **T-04** 個人情報漏洩 (メール / 写真) | I (Info Disclosure) | High | 法的リスク (個人情報保護法) | HTTPS only / Shopify Files 内部URL / Audit Log | A-05, C-05 |
| **T-05** 不適切レビュー公開 | T (Tampering) | Medium | ブランド毀損 | 必ず status:pending 強制 / 承認ワークフロー / NG ワード自動検出 | K-05, E-07 |
| **T-06** Audit Log 改竄 | T | Low | 監査証跡喪失 | Append-only Metaobject / アクション全記録 | C-05 |
| **T-07** 認証なしで Reviewing API 叩く | E (Privilege Escalation) | High | 全レビュー操作 | 全 admin route で authenticate.admin() 必須 | C-02 |
| **T-08** Rate Limit 突破 | D (DoS) | Medium | サーバー過負荷 | IP base 5 req/hour (公開) / 100 req/min (admin) | C-04 |
| **T-09** 写真アップロード DoS | D | Medium | ストレージ枯渇 | 5MB/枚 × 6枚 上限 / MIME type 検証 / Shopify Files quota | K-04 |
| **T-10** メールスパム (悪意のあるトークン発行) | R (Repudiation) | Low | レピュテーション毀損 | issued_by 必須 / Audit Log / Rate Limit | G-01, C-05 |

## 3. Privacy Impact Assessment (PIA)

### 取扱う個人情報

| 項目 | 取得経路 | 保管場所 | 保管期間 | 取得目的 |
|---|---|---|---|---|
| メールアドレス | 注文時 (Shopify Customer) | Shopify Metaobject astromeda_review_token | 90日 (期限) | レビュー依頼メール送信 |
| 氏名 (姓+名) | 注文時 | Shopify Metaobject astromeda_review_token | 90日 | メール宛名 |
| 表示名 (ニックネーム可) | レビュー投稿時 | Shopify Metaobject astromeda_review | 永続 (お客様削除依頼まで) | レビュー署名 |
| 投稿者 IP アドレス | 自動取得 | Audit Log (90日) | 90日 | Rate Limit / 不正検出 |
| アップロード写真 | レビュー投稿時 | Shopify Files (CDN) | 永続 | レビュー添付表示 |
| 注文 ID | 注文時 | Shopify Metaobject astromeda_review (verified_purchase の場合) | 永続 | 認証購入バッジ表示 |

### 法令対応

- **個人情報保護法 (日本)**: 取得目的をプライバシーポリシーで明示 / 同意取得 / 削除依頼対応
- **ステマ法 (景品表示法改正・2023/10〜)**: 「認証購入」「ギフト」バッジで購入経路を明示
- **GDPR (将来 EU 顧客向け)**: 現時点は対象外。EU 進出時に再評価
- **PCI-DSS**: 本アプリは決済情報を扱わないため非対象

### お客様の権利

1. **アクセス権**: マイページから自身のレビュー一覧表示 (Phase 2 検討)
2. **削除権**: メールで申請 → ASTROMEDA カスタマーサポート → 7 営業日以内に対応
3. **訂正権**: 同上
4. **データポータビリティ**: Phase 2 検討

### データ最小化原則

- メール送信完了後、`astromeda_review_token` の email/customer_name は不要 → token 期限切れ (90日後) で自動削除可能
- IP アドレスは Audit Log 90日のみ保管。それ以降は purge

## 4. セキュリティ実装チェックリスト

### Phase A
- [ ] A-11: 本ドキュメント commit
- [ ] A-05: HTTPS only (Fly.io は自動)

### Phase C (Auth Layer)
- [ ] C-01: App Bridge v4 (Session Token)
- [ ] C-02: authenticate.admin() ミドルウェア
- [ ] C-03: shop scope 検証
- [ ] C-04: Rate Limit
- [ ] C-05: Audit Log
- [ ] C-06: Sentry 連携
- [ ] C-08: セキュリティ E2E テスト (401/403/429 全パターン)

### Phase I (Webhook)
- [ ] I-02: HMAC SHA-256 検証

### Phase K (Public Form)
- [ ] K-02: トークン検証 (UUID format / expiry / used_at)
- [ ] K-04: 写真サイズ・MIME 検証
- [ ] K-05: status:pending 強制

### Phase M-A2 (CTO Audit)
- [ ] M-A2: 全脅威 T-01〜T-10 の緩和実装を Chrome MCP で検証
  - 認証なし → 401 即返却
  - HMAC 不正 → 401
  - Rate Limit 突破 → 429
  - 期限切れトークン → 410
  - 使用済みトークン → 409

## 5. インシデント対応

### 重大インシデント発生時

1. **検知**: Sentry alert / Fly.io metrics 異常
2. **隔離**: 該当 endpoint を fly.toml で一時無効化
3. **通知**: CEO 武正さん へ即時 → 必要なら個人情報保護委員会へ報告 (重大漏洩時)
4. **復旧**: Rollback via Fly.io release rollback
5. **事後**: 原因分析 + Threat Model 更新

### Rollback 訓練 (M-08)

- App Bridge 異常
- Shopify Flow / Shopify Email 障害 (Shopify SaaS 全体障害)
- Webhook 二重発火
- DB (Metaobject) 書き込み失敗

各シナリオを意図的に発火し、MTTR < 5 分を確認。

## 6. 監査ログ要件

全 admin action を `astromeda_audit_log` Metaobject に記録:

```
{
  actor: "admin@mining-base.co.jp",
  act