# AGENTS.md — Codexレビュー規約

Kids OekakiのPRレビューでは、一般的なコード品質に加えて次を優先確認する。

## Code Review Rules

- Pointer Events処理で線飛び、遅延、二重入力、stylus/指の回帰を生む変更がないか。
- 描画中のReact state更新や再描画が過剰になり、フレーム落ち・ちらつきを生まないか。
- pinch zoom / panと描画gestureの競合がないか。
- Undo / Redo、Layer、Document modelの整合性が壊れないか。
- 保存・復元で既存作品データを失う破壊的変更がないか。
- Service Worker / cache更新で古いbundleが残り続けないか。
- GitHub Pagesのsub-pathでもmanifest、icon、service worker、asset URLが壊れないか。
- GitHub Actions permissionsが必要以上に広くないか。
- 秘密情報がコード、Workflow、ログへ混入していないか。

## AIレビューだけで完結しない変更

stylus / touch / palm rejection、pinch zoom / pan、長時間描画性能、Android / KindleでのPWA install / offline、画面回転、PNG保存は実機確認を要求する。
