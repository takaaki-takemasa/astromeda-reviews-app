# astromeda-reviews-app

ASTROMEDA 口コミ機能 - Shopify Admin Embedded App

**Project Code:** REV-EMB-2026-Q2
**Status:** Phase A (Foundation) - In Progress
**Timeline:** 2026/05/15 → 2026/06/08 (17 営業日)

---

## 概要

ASTROMEDA EC サイトの商品レビュー機能を提供する Shopify Embedded App。

- **エンドユーザー向け**: 注文発送 14 日後に届くメールから、購入商品のレビューを 3 分以内に投稿できるフォーム
- **運営管理者向け**: Shopify Admin サイドバー「口コミ管理」から、4 タブ (レビュー一覧 / メール設定 / ギフトトークン / 送信キュー) で運用可能

## 技術スタック

- **Framework**: [Shopify Remix App Template](https://shopify.dev/docs/api/shopify-app-remix) (`@shopify/shopify-app-remix`)
- **UI**: [Shopify Polaris](https://polaris.shopify.com/) v13+ ・ [App Bridge React](https://shopify.dev/docs/api/app-bridge-library) v4
- **Database (Session)**: Prisma + SQLite
- **Database (Domain)**: Shopify Metaobjects (6 定義) - スキーマ完全 Shopify 上完結
- **Hosting**: [Fly.io](https://fly.io) (region: `nrt` Narita, Japan)
- **Email**: [SendGrid](https://sendgrid.com) (`noreply@mining-base.co.jp` from)
- **CI/CD**: GitHub Actions → Fly.io 自動 deploy
- **Monitoring**: Sentry + Fly.io metrics

## ドキュメント

実装に着手する前に、以下 3 ドキュメントを必ず確認:

1. **[Gantt Chart v1.2](../口コミ機能_EmbeddedApp移行_ガントチャート_v1.html)** - 102 原子タスクの実行計画
2. **[UX/UI Design Specification v1.1](../口コミ機能_UXUI_DesignSpec_v1.html)** - 15 章のデザイン仕様
3. **[Traceability Matrix v1.0](../口コミ機能_TraceabilityMatrix_v1.html)** - 双方向クロスリファレンス + 4 視点監査詳細

## アーキテクチャ決定記録 (ADR) & 仕様書

- **[Threat Model & Privacy Impact Assessment](./THREAT_MODEL.md)** - STRIDE 10 脅威分析 + 個人情報取扱い (Phase A-11)
- **[Brand Token Specification](./BRAND_TOKENS.md)** - ASTROMEDA カラー・タイポ・Polaris 拡張・WCAG 2.1 AA (Phase A-10)
- **ADR-001: Technology Stack Selection** - Shopify Remix App + Fly.io + SendGrid (TBD)

## Phase 構成

| Phase | 期間 | 内容 |
|---|---|---|
| **A** | 5/15 (0.5d) + α | Foundation (本フェーズ) - repo / Fly.io / Polaris / Brand Token / Threat Model / Staging |
| B | 5/18 (1d) | DB Domain Models |
| C | 5/19 (1d) | Authentication + RBAC + Rate Limit + Audit Log |
| D | 5/20 (1d) | Polaris UI Foundation + NavigationMenu |
| E | 5/21-22 (2d) | Tab 1: レビュー一覧 (承認 / 拒否) |
| F | 5/21-22 (2d, 並走) | Tab 2: メール設定 |
| G | 5/25 (1d) | Tab 3: ギフトトークン |
| H | 5/26 (1d) | Tab 4: 送信キュー |
| I | 5/27 (1d) | Webhook 受信 (orders/fulfilled) |
| J | 5/28 (1d) | Email Cron + SendGrid + Visual Design |
| K | 5/29-6/1 (2d) | お客様向け公開ルート (App Proxy) |
| L | 6/1-3 (3d) | Hydrogen 完全剥離・並走稼働 |
| **M-Audit** | 6/4 (1d) | 4視点 独立 Chrome MCP 監査 |
| M | 6/5-6/8 (1.5d) | Documentation + 段階リリース 10%→50%→100% |

## 4視点 独立監査 (Phase M-Audit)

Shopify C-suite クロスレビュー相当の品質保証を Phase M-Audit (6/4) で実施:

- **🎨 CDO Audit (M-A1)**: Polaris 整合 / A11y / 状態網羅 / マイクロコピー (90 min)
- **⚙️ CTO Audit (M-A2)**: Performance / Security / SLO / Bundle (90 min)
- **📣 CMO Audit (M-A3)**: Brand / Tone / モバイル / 競合差別化 (60 min)
- **👔 CEO Audit (M-A4)**: Merchant Outcome / TTFSA / 認知負荷 (60 min)

4 視点全て Pass で Go-Live へ進行 (M-A5)。

## Local 開発

```bash
# Phase A-03 で Shopify Remix template scaffold 後に有効
npm install
npm run dev
```

## デプロイ

```bash
# Fly.io 自動デプロイ (GitHub Actions 経由)
git push origin main
```

## ライセンス

Proprietary - 株式会社マイニングベース 内部利用限定
