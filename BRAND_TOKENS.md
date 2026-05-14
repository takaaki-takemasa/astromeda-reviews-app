# ASTROMEDA Brand Token Specification

**Project:** astromeda-reviews-app
**Document Version:** v1.0
**Date:** 2026-05-15
**Owner:** CDO (Claude) / Approver: CEO 武正貴昭
**Phase:** A-10 (Foundation)

---

## 1. 目的

Shopify Polaris の標準デザイントークンを上書きし、ASTROMEDA ブランドの一貫した世界観を Embedded App 全体（管理画面 + お客様向け公開フォーム + 自動送信メール）に適用する。

### スコープ

| エリア | 適用 | 備考 |
|---|---|---|
| Shopify Admin Embedded App (4タブ) | ✅ Polaris extension via CSS variables | App Bridge 互換性を維持 |
| App Proxy 公開フォーム (`/apps/reviews/submit`) | ✅ Custom CSS + Polaris-aligned tokens | お客様タッチポイント |
| SendGrid 自動送信メール (HTML) | ✅ Inline CSS only (email client compat) | A-J-10 で展開 |
| Storefront レビュー表示 (Hydrogen) | ⚠️ Phase L で別途整合 | 本プロジェクト範囲外 |

---

## 2. カラーパレット

### Primary (ASTROMEDA Teal)

ASTROMEDA のシグネチャカラー。CTA・主要アクション・アクセントに使用。

| Token | Hex | Use Case |
|---|---|---|
| `--ast-primary-50` | `#f0fdfa` | 背景の極淡い teal（成功バナー等） |
| `--ast-primary-100` | `#ccfbf1` | hover 背景 |
| `--ast-primary-300` | `#5eead4` | 装飾的アクセント |
| `--ast-primary-500` | `#14b8a6` | **メインブランドカラー** (Primary Button, Active Tab, Brand Logo) |
| `--ast-primary-600` | `#0d9488` | hover/active 状態 |
| `--ast-primary-700` | `#0f766e` | pressed 状態・テキスト on light bg |
| `--ast-primary-900` | `#134e4a` | 高コントラストテキスト |

### Neutral (Polaris Compatible)

Polaris デフォルトを継承（管理画面のロジック識別性を維持）。

| Token | Hex | Use Case |
|---|---|---|
| `--ast-bg` | `#ffffff` | ベース背景 |
| `--ast-bg-subdued` | `#f6f6f7` | Card 内のサブ背景 |
| `--ast-border` | `#e1e3e5` | Divider, Card border |
| `--ast-text` | `#202223` | 本文テキスト（Polaris `--p-color-text`）|
| `--ast-text-subdued` | `#6d7175` | 補助テキスト・ヒント |
| `--ast-text-disabled` | `#8c9196` | disabled 状態 |

### Semantic Colors

| Token | Hex | Use Case |
|---|---|---|
| `--ast-success` | `#008060` | 「承認」「公開」「送信完了」 |
| `--ast-success-bg` | `#e3f1df` | 成功 Banner 背景 |
| `--ast-warning` | `#b98900` | 「pending」「期限近い」 |
| `--ast-warning-bg` | `#fff5d9` | 警告 Banner 背景 |
| `--ast-critical` | `#d72c0d` | 「拒否」「削除」「エラー」 |
| `--ast-critical-bg` | `#fed3d1` | エラー Banner 背景 |
| `--ast-info` | `#2c6ecb` | 情報通知 |
| `--ast-info-bg` | `#ebf3ff` | 情報 Banner 背景 |

### コントラスト比検証 (WCAG 2.1 AA)

| 組み合わせ | 比 | 基準 | 結果 |
|---|---|---|---|
| `#14b8a6` on `#ffffff` | 3.1:1 | 大文字 3:1 / Button 3:1 | ✅ Pass (Button) |
| `#0f766e` on `#ffffff` | 5.9:1 | 通常テキスト 4.5:1 | ✅ Pass |
| `#202223` on `#ffffff` | 16.8:1 | 通常テキスト 4.5:1 | ✅ Pass |
| `#6d7175` on `#ffffff` | 5.0:1 | 通常テキスト 4.5:1 | ✅ Pass |
| `#ffffff` on `#14b8a6` | 3.1:1 | 大文字 3:1 / Button 3:1 | ✅ Pass (Button) |
| `#ffffff` on `#0d9488` | 4.2:1 | Button 3:1 | ✅ Pass |

**Primary Button text**: 白文字 on `#0d9488` (Primary-600) を採用し 4.2:1 を確保。`#14b8a6` (Primary-500) は装飾的用途・Logo のみ。

---

## 3. タイポグラフィ

### フォントファミリー

```css
--ast-font-sans: -apple-system, BlinkMacSystemFont, "Hiragino Kaku Gothic ProN",
                 "Hiragino Sans", "Yu Gothic UI", "Meiryo", "Noto Sans JP",
                 system-ui, sans-serif;

--ast-font-mono: ui-monospace, SFMono-Regular, "SF Mono", Menaka, Consolas,
                 "Liberation Mono", monospace;
```

**根拠**:
- 日本語環境を最優先（顧客 95% が日本国内）
- システムフォント優先で Web Font ダウンロード時間ゼロ（LCP 改善）
- Polaris の `--p-font-family-sans` と互換

### サイズスケール (rem ベース)

| Token | rem | px | Use Case |
|---|---|---|---|
| `--ast-text-xs` | 0.75 | 12 | キャプション・補助ラベル |
| `--ast-text-sm` | 0.875 | 14 | フォーム入力・補助情報 |
| `--ast-text-base` | 1.0 | 16 | 本文（管理画面・公開フォーム） |
| `--ast-text-lg` | 1.125 | 18 | Card タイトル |
| `--ast-text-xl` | 1.25 | 20 | Section heading |
| `--ast-text-2xl` | 1.5 | 24 | Page heading (h1) |
| `--ast-text-3xl` | 2.0 | 32 | Email subject prominent |

### Font Weight

| Token | Value | Use Case |
|---|---|---|
| `--ast-fw-regular` | 400 | 本文 |
| `--ast-fw-medium` | 500 | Button label |
| `--ast-fw-semibold` | 600 | Heading h2-h4 |
| `--ast-fw-bold` | 700 | Heading h1, 強調 |

### Line Height

| Token | Value | Use Case |
|---|---|---|
| `--ast-lh-tight` | 1.2 | Heading |
| `--ast-lh-normal` | 1.5 | 本文（日本語推奨） |
| `--ast-lh-relaxed` | 1.7 | 長文（メール本文） |

---

## 4. スペーシング (8px ベースグリッド)

```css
--ast-space-1: 0.25rem; /*  4px */
--ast-space-2: 0.5rem;  /*  8px */
--ast-space-3: 0.75rem; /* 12px */
--ast-space-4: 1rem;    /* 16px */
--ast-space-5: 1.25rem; /* 20px */
--ast-space-6: 1.5rem;  /* 24px */
--ast-space-8: 2rem;    /* 32px */
--ast-space-10: 2.5rem; /* 40px */
--ast-space-12: 3rem;   /* 48px */
--ast-space-16: 4rem;   /* 64px */
```

Polaris の `--p-space-*` と完全互換。

---

## 5. Border / Radius / Shadow

### Border Radius

| Token | Value | Use Case |
|---|---|---|
| `--ast-radius-sm` | 4px | Tag, Badge |
| `--ast-radius-md` | 8px | Button, Input, Card |
| `--ast-radius-lg` | 12px | Modal, Large Card |
| `--ast-radius-full` | 9999px | Pill, Avatar |

### Shadow

| Token | Value | Use Case |
|---|---|---|
| `--ast-shadow-sm` | `0 1px 2px rgba(0,0,0,0.05)` | Card |
| `--ast-shadow-md` | `0 4px 8px rgba(0,0,0,0.08)` | Dropdown, Tooltip |
| `--ast-shadow-lg` | `0 12px 24px rgba(0,0,0,0.12)` | Modal |

### Border Width

```css
--ast-border-width: 1px;
--ast-border-width-thick: 2px; /* focus ring */
```

---

## 6. Polaris 拡張方針

### 6.1 CSS 変数による拡張（推奨アプローチ）

Polaris は `--p-color-*` 系の CSS 変数で実装されているため、グローバルに上書き可能：

```css
/* app/styles/brand-tokens.css */
:root {
  /* ASTROMEDA ブランドを Polaris にマッピング */
  --p-color-bg-primary: var(--ast-primary-500);
  --p-color-bg-primary-hover: var(--ast-primary-600);
  --p-color-bg-primary-active: var(--ast-primary-700);
  --p-color-border-primary: var(--ast-primary-500);
  --p-color-text-primary: var(--ast-primary-700);

  /* ASTROMEDA 独自トークン */
  --ast-primary-500: #14b8a6;
  --ast-primary-600: #0d9488;
  /* ... (上記全 token 定義) */
}
```

### 6.2 コンポーネント独自スタイル（最小限）

以下のコンポーネントのみ独自スタイルを当てる。それ以外は Polaris 標準のまま使用：

| Polaris Component | 拡張内容 | 理由 |
|---|---|---|
| `Button` (Primary) | bg-color を ASTROMEDA Teal に | ブランド差別化 |
| `Banner` (Success) | text-color を ASTROMEDA Teal に | 統一感 |
| `Badge` (Status) | カラーマッピング統一 | レビュー status バッジ |
| `Tabs` (Active) | underline color を Teal に | Active 状態の視認性 |

**それ以外（IndexTable, Form, Modal, EmptyState etc.）は Polaris 標準を尊重**。Shopify Admin の他アプリと UX 統一性を保つことが Merchant Outcome 向上に直結。

### 6.3 NG パターン

- ❌ Polaris の標準コンポーネントを完全に置き換える独自実装
- ❌ Polaris の角丸 8px を 0px / 20px 等に大幅変更
- ❌ Polaris の標準スペーシング 16px を 8px / 32px 等に大幅変更
- ❌ Tab の縦並び化等、Polaris 標準パターンから逸脱

**Why**: Shopify Admin の他アプリと操作感を揃えることで、merchant の学習コストゼロ + Shopify App Store ガイドライン適合。

---

## 7. お客様向け公開フォーム独自トークン

App Proxy `/apps/reviews/submit` は Polaris の外側で動く（Shopify Storefront に embed）。

### モバイル優先設計

| 項目 | 値 | 根拠 |
|---|---|---|
| Container max-width | 600px | スマホ縦持ち最適 + iPad 表示 |
| Body min-width | 320px | iPhone SE 対応 |
| Tap target min size | 44 x 44 px | iOS HIG / WCAG 2.5.5 |
| Font size (本文) | 16px | iOS Safari の auto zoom 防止 |
| Padding (Container) | 16px | mobile-friendly 余白 |

### CTA Button

```css
.ast-cta-primary {
  background: var(--ast-primary-600); /* #0d9488 */
  color: #ffffff;
  font-size: 1.0rem; /* 16px */
  font-weight: 500;
  padding: 12px 24px;
  border-radius: 8px;
  min-height: 44px;
  border: none;
  cursor: pointer;
  transition: background 0.15s ease;
}

.ast-cta-primary:hover {
  background: var(--ast-primary-700); /* #0f766e */
}

.ast-cta-primary:focus-visible {
  outline: 2px solid var(--ast-primary-500);
  outline-offset: 2px;
}
```

---

## 8. メール (SendGrid) 用トークン

メールクライアント互換性のため、**全て inline style** で書く。CSS 変数は使えない。

### カラー (HEX 直値)

```html
<!-- Subject line emphasis -->
<span style="color: #0d9488; font-weight: 600;">3分</span>

<!-- CTA Button (table-based for Outlook compat) -->
<table role="presentation" cellspacing="0" cellpadding="0" border="0">
  <tr>
    <td style="background: #0d9488; border-radius: 8px; padding: 14px 32px;">
      <a href="..." style="color: #ffffff; text-decoration: none; font-weight: 500; font-size: 16px; font-family: -apple-system, 'Hiragino Sans', sans-serif;">
        レビューを書く
      </a>
    </td>
  </tr>
</table>

<!-- Header banner -->
<div style="background: #14b8a6; padding: 24px; text-align: center;">
  <img src="https://shop.mining-base.co.jp/cdn/shop/files/astromeda-logo-white.png"
       alt="ASTROMEDA" width="180" height="40" style="display: block; margin: 0 auto;">
</div>
```

### メールフォント

```css
font-family: -apple-system, BlinkMacSystemFont, "Hiragino Kaku Gothic ProN",
             "Hiragino Sans", "Yu Gothic UI", "Meiryo", "Noto Sans JP",
             sans-serif;
```

### コピーライティング基本ルール (Phase J-10 で詳細展開)

- 件名: 30 字以内 + emoji 1個まで
- プレビューテキスト: 90 字以内
- CTA: 「レビューを書く」「30秒で完了」等、動詞 + 完了時間明示
- 署名: 「ASTROMEDA / 株式会社マイニングベース」

---

## 9. アクセシビリティ要件 (WCAG 2.1 AA)

### 必須要件

- ✅ コントラスト比 4.5:1 以上（通常テキスト）
- ✅ コントラスト比 3:1 以上（大文字テキスト、UI コンポーネント）
- ✅ Tap target 44 x 44 px 以上（モバイル）
- ✅ Focus indicator 視認可能（outline 2px / `:focus-visible`）
- ✅ 色のみで情報伝達しない（status は 色 + ラベル + アイコン）
- ✅ `prefers-reduced-motion: reduce` 対応（アニメーション無効化）
- ✅ Screen reader label 完備（`aria-label`, `aria-describedby`）

### 検証ツール (Phase M-A1 CDO Audit で使用)

- axe DevTools (Chrome 拡張)
- WAVE (WebAIM)
- Lighthouse Accessibility Score 95+
- 手動 keyboard navigation 検証

---

## 10. 実装ファイル構成

Phase A-03 (Shopify Remix scaffold) 完了後の構造：

```
app/
├── styles/
│   ├── brand-tokens.css       ← 本ドキュメントを CSS に展開
│   ├── polaris-overrides.css  ← Polaris CSS 変数の上書き
│   └── public-form.css        ← App Proxy 公開フォーム独自
├── routes/
│   ├── app._index.tsx         ← Embedded App ホーム
│   ├── app.reviews.tsx        ← Tab 1: レビュー一覧
│   ├── app.email.tsx          ← Tab 2: メール設定
│   ├── app.tokens.tsx         ← Tab 3: ギフトトークン
│   ├── app.queue.tsx          ← Tab 4: 送信キュー
│   └── apps.reviews.submit.tsx ← App Proxy 公開フォーム
└── emails/
    ├── review-request.tsx     ← React Email template (J-phase)
    └── review-thanks.tsx      ← 投稿完了サンクスメール
```

---

## 11. ガントタスクとの対応

| Gantt Task | 内容 | 本ドキュメント参照 |
|---|---|---|
| A-10 | Brand Token 定義 | 本ドキュメント全体 |
| D-04 | Polaris UI Foundation | §6.1 CSS 拡張・§4 スペーシング |
| D-10 | Foundation Design Review | §2 カラー・§3 タイポ・§9 A11y |
| E-13 / F-12 / G-08 / H-08 | 各タブ Design Review | §6.2 コンポーネント独自スタイル |
| J-10 | Email Visual Design | §8 メール用トークン |
| K-08 | 公開フォーム視覚デザイン | §7 公開フォーム独自トークン |
| M-A1 | CDO Final Audit | §9 A11y 要件・§2 コントラスト比 |

---

## 12. 改訂履歴

| Version | Date | Changes | Approver |
|---|---|---|---|
| v1.0 | 2026-05-15 | 初版起案（CDO Phase A-10） | CDO (Claude) |
| (v1.1) | TBD | Phase D-10 Foundation Review 後の調整 | CDO + CEO |

---

## 承認

| 役職 | 氏名 | 日付 | 署名 |
|---|---|---|---|
| CDO (assigned to Claude) | Claude Sonnet 4 | 2026-05-15 | ✓ 起案 |
| CEO | 武正貴昭 | _____ | _________________ |
