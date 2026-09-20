# Kids Oekaki — Claude Code 運用ルール

Kids Oekakiの正式Product Repository。2026-09-20に `cloud42-labo/experimental` から分離した。

## 作業開始ゲート

1. Notion Stories & Tasksの対象Taskを確認する。Taskなしで実装を始めない。
2. Productは `Kids Oekaki (OEK)`。開発成果は原則 `Application Delivery`。
3. Done済み範囲を変える場合は既存Taskを無断再利用せず、Reopen / 新規Taskを判断する。
4. `cloud42-labo/brain` の関連Decision / Noteを確認する。

## SSoT

- 実装・CI/CD・Release成果物: このRepository
- 運用状態・Task・Acceptance: Notion
- 経験記憶・Decision: cloud42-labo/brain
- 再利用可能な手順: cloud42-labo/skills

## Commands

```bash
npm ci
npm run build
npm run test:e2e
```

## GitHub運用

- mainへ直接pushしない。
- Claudeが実装しPRを作る。
- PR本文からNotion Taskを追跡可能にする。
- Claude自身はマージせず、Codex review / ChatGPT側のレビュー・マージへ引き継ぐ。

## 実機Gate

CI/E2Eだけでは stylus / 指入力、pinch zoom / pan、20分連続描画、Android / Kindle固有挙動、PWA install / offline再起動、PNG保存、画面回転をDoneにしない。対象実機で確認し、結果をNotion Taskへ記録する。

## 秘密情報

Token、署名鍵、API key等をRepositoryへコミットしない。
