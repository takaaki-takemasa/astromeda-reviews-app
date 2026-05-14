# Staging Branch

This branch deploys to a Vercel Preview Deployment.

- **Auto-deploy**: Yes (Vercel Git Integration)
- **Preview URL pattern**: `astromeda-reviews-app-git-staging-takaakitakemasa-8885s-projects.vercel.app`
- **Shopify dev store**: `staging-mining-base.myshopify.com` (Phase A+ で staging app 登録予定)
- **Purpose**: Phase A+ で feature ブランチを切る際に main を保護するための buffer

## 運用ルール

1. main = production (astromeda-reviews-app.vercel.app)
2. staging = preview deploy (test changes before merging to main)
3. feature/* = PR-level preview (auto from PR open)

Phase A 完了時点 (2026-05-14) ではこの branch は main と同期。
Phase B 以降で実検証用 PR が来た際に preview deploy が回り始める。
