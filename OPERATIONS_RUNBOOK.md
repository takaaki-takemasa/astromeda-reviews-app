# ASTROMEDA Reviews App - 運用マニュアル (CEO 向け)

**Version**: 1.0 (Phase M)
**Last updated**: 2026-05-14
**対象読者**: CEO 武正貴昭 / カスタマーサポート / 将来加入する運用担当者

---

## 🎯 このアプリができること

Shopify Admin の「アプリ」→ **Astromeda Reviews** から開く 4 タブの管理画面で、お客様の口コミ依頼〜公開承認まで全工程を管理できます。

### 4 タブの役割

| タブ | 何をするか |
|---|---|
| **レビュー一覧** | お客様から届いたレビューを承認/拒否。一括選択可。返信もここから。 |
| **メール設定** | IP コラボ別やカテゴリ別に依頼メールの文面を編集。toggle で有効/無効切替。 |
| **ギフトトークン** | ギフト受領者用のレビュー招待 URL を発行。クリップボードコピー可。 |
| **送信キュー** | Shopify Flow が予約した送信予約を監視。失敗時は状態確認。 |

---

## 📅 日々の運用フロー (推奨 1 日 1 回・5 分)

1. **Shopify Admin** → アプリ → **Astromeda Reviews** を開く
2. **レビュー一覧** タブを開く (承認待ち件数が Badge で表示される)
3. 投稿内容を読み、問題なければチェックを入れて「**N 件を承認**」
4. 不適切な投稿があれば「**N 件を拒否**」(理由は管理側のみ可視)
5. 公開中タブで反映を確認 → ストアフロント商品ページの星評価に反映

---

## 🔄 完全な口コミフロー (お客様視点)

```
[1] お客様が注文 → Shopify
       ↓
[2] 14 日経過後、Shopify Flow が自動で:
    - /api/tokens/issue (Vercel) を呼び出し
    - token UUID 生成 + Metaobject astromeda_review_token に保存
    - お客様のメールアドレスに「ご感想をお聞かせください」メール送信
       ↓
[3] お客様がメール内 CTA をクリック
    → https://shop.mining-base.co.jp/apps/reviews-1/submit?token=XXX
       ↓
[4] 軽量フォーム (モバイル最適化) で評価★+ タイトル + 本文 + 表示名 入力
       ↓
[5] 送信 → 自動で status='pending' で保存・token は使用済マーク
       ↓
[6] CEO が Embedded App Tab 1「レビュー一覧」で「承認」
       ↓
[7] status='approved' に変わり、商品ページに星評価が表示される
```

---

## 🆘 障害時の対応 (Rollback / Recovery)

### ケース 1: 管理画面が開かない / 真っ白
1. **原因**: Vercel deployment が失敗 / Shopify セッション期限切れ
2. **確認**: https://vercel.com/takaakitakemasa-8885s-projects/astromeda-reviews-app/deployments
3. **対処**: 最新 deployment の Status が Error なら、直前の Ready deployment の右上「⋯」→「**Promote to Production**」を 1 クリックで切り戻し (5 秒以内反映)

### ケース 2: お客様からメールが届かない
1. **確認 1**: Shopify Admin → アプリ → Flow → ワークフロー一覧 →「New Workflow」(口コミ)の有効/無効
2. **確認 2**: Embedded App Tab 4「送信キュー」で `failed` タブを開く → error_message 列を確認
3. **対処**: Shopify Email 配信問題は Shopify サポートに連絡。Flow が止まっている場合は ワークフローを再有効化

### ケース 3: 不適切なレビューが公開された
1. Embedded App Tab 1「レビュー一覧」→「公開中」タブを開く
2. 問題のレビューを選択 → 「拒否」をクリック → status='rejected' に変更
3. (将来) 削除機能は Phase M+ で追加予定

### ケース 4: お客様が「リンクをクリックしたら期限切れと出る」
1. 期限切れトークンは 90 日経過すると無効化
2. **対処**: Embedded App Tab 3「ギフトトークン」→「ギフトトークンを発行」で新トークン発行 → URL コピーしてお客様にメール送信

---

## 🚀 段階リリース計画 (Phase M-09〜M-11)

実顧客への影響を最小化するため 3 段階で展開:

| Phase | 期間 | 対象範囲 | 監視ポイント |
|---|---|---|---|
| **Day 1: 10% リリース** | 24 時間 | 注文 ID 末尾「0」のみ | Vercel logs / Tab 4「送信キュー」failed 件数 / Sentry エラー |
| **Day 2-3: 50% リリース** | 48 時間 | 注文 ID 末尾「0-4」 | 同上 + 開封率/CTR (Shopify Email analytics) |
| **Day 4-: 100% リリース** | 継続 | 全注文 | 同上 + レビュー投稿数 / 承認待ち件数 |

各段階で Tab 4「送信キュー」と Sentry を 24 時間確認。問題なければ次段階。

### 段階制御の方法
Shopify Flow editor → 既存ワークフローの「条件」アクションを追加 → `{{order.id | mod: 10}} <= N` で N を 0→4→9 へ拡大。

---

## 📞 連絡先 (障害時)

- **Vercel**: https://vercel.com/help (有料 Pro tier なのでチケット可)
- **Shopify**: Admin → サポート連絡 / partners.shopify.com
- **GitHub Issues**: https://github.com/takaaki-takemasa/astromeda-reviews-app/issues

---

## 🔐 セキュリティ運用ルール

1. **GitHub PAT は 90 日で自動失効** (現在の token は `ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx` 形式・本ファイルには記載しない)
2. **Vercel Env Vars は変更しない** (誤って削除するとアプリ全停止)
3. **Shopify App scope 拡張は CEO 確認必須** (現在は read_orders / write_metaobjects 等の最小権限)
4. **PII 取扱い**: お客様 email / 氏名は astromeda_review_token Metaobject に 90 日保管 → 自動失効。astromeda_review には reviewer_email 永続保管。お客様削除依頼があれば 7 営業日以内に対応 (Phase A-11 PIA §3)

---

## 📈 KPI モニタリング (Phase M+)

定期的に確認するメトリクス:

| 指標 | 目標 | 確認場所 |
|---|---|---|
| API レスポンスタイム p95 | < 500ms | Vercel Observability (Speed Insights) |
| サーバー稼働率 | 99.5% / 月 | Vercel uptime + 自前 status page |
| メール送信成功率 | ≥ 99% | Tab 4「送信キュー」/ Shopify Flow run history |
| メール開封率 | ≥ 40% | Shopify Email analytics |
| 公開フォーム CTR | ≥ 15% | Vercel function logs (/proxy/submit 訪問数) |
| フォーム完了率 | ≥ 60% | start vs submit ratio |
| 投稿 → 承認時間 (median) | ≤ 1 営業日 | astromeda_review.updatedAt - approved_at |
| 承認率 | ≥ 90% | approved / (approved + rejected) |
| ★4 以上のレビュー比率 | ≥ 70% | rating distribution Tab 1 |

---

## ✅ MVP 完了チェックリスト

- [x] Vercel 本番デプロイ (https://astromeda-reviews-app.vercel.app)
- [x] Shopify App 登録 + OAuth インストール
- [x] 4 タブの Embedded App 動作確認
- [x] /api/tokens/issue endpoint 動作
- [x] Shopify Flow 配線 (URL = Vercel エンドポイント)
- [x] orders/fulfilled webhook 動作
- [x] 公開フォーム /apps/reviews-1/submit 動作
- [x] Hydrogen 旧ルート deprecation 化 (Hydrogen repo 別 commit)
- [ ] **次**: Phase M-09 (10% リリース) - 実注文での E2E 検証
- [ ] Photo upload (K-04) - 次バージョン
- [ ] Sentry SDK install - 次バージョン
- [ ] Upstash Redis session storage - 次バージョン
