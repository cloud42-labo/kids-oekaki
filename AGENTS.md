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

## Finding Quality Contract

Codex reviewは改善案の列挙ではなく、**このPRをmergeすると具体的に壊れるものを検出するGate**として扱う。

### Blocking Findingにできる条件

次をすべて満たすFindingだけをP0/P1相当のMerge Blockerとして投稿する。

1. current headに成立する
2. 具体的なfailure mode（correctness / security / data loss / 操作不能 / Acceptance Criteria違反）がある
3. このPRの変更scopeとの因果がある
4. Required fixと、解消を確認するverificationが示せる

blocking Findingには最低限 `Severity / Location / Failure mode / Evidence / Required fix` を含める。

style/naming/formatting/nit、一般的best practice、具体的経路のない推測、不要なrefactor、変更前から存在するscope外問題は原則Merge Blockerにしない。同一根因の指摘は重複投稿せずまとめる。重大な問題が無ければclean verdictで終了する。

### Re-reviewはdelta-first

2回目以降は、まず前回のblocking Findingが解消したかと、前回review後のdeltaが新しいblockerを導入したかだけを確認する。毎回PR全体をゼロから探索し直して改善候補を掘り続けることはしない。ただし、再レビュー中にPR自身が原因の、current headに成立する新たなEvidence-backed blockerを発見した場合は、delta起因でなくても報告する。この場合もFinding Quality Contractを満たす具体的Evidenceを示す。同じ論点の言い換えは既存Findingへ紐づける。

## AIレビューだけで完結しない変更

stylus / touch / palm rejection、pinch zoom / pan、長時間描画性能、Android / KindleでのPWA install / offline、画面回転、PNG保存は実機確認を要求する。

ただし、**実機確認が必要という事実だけではPRのMerge Blockerにしない**。実機Gateは原則としてTask Done / Release Acceptance側で管理する。コードをmergeすること自体が不可逆・危険、またはmerge後に検証不能になる場合だけ、具体的理由を示してMerge Blockerとする。
