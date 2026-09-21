# Android / Kindle 実機 Human Acceptance 手順

これはOEK-05-S03-T03の成果物。CI/E2E（`build-and-e2e` / `android-debug-build`）は
ブラウザ・エミュレータ上の確認に留まり、[CLAUDE.md](../CLAUDE.md)の「実機Gate」に挙げた
項目（stylus/指入力、pinch zoom/pan、20分連続描画、Android/Kindle固有挙動、
PWA install/offline再起動、PNG保存、画面回転）はDoneにできない。ここに書く手順は
**人（Human）が対象実機で実行し、結果をNotion Taskへ記録する**ためのもの。
Claude自身はこの手順を実行できない。

## 準備

1. GitHub Actionsの `android-debug-build` job（`.github/workflows/ci.yml`、対象commitの
   Actions run）から `kids-oekaki-v<version>-debug-build<run>` artifactをダウンロードし、
   端末へ転送する（USB / クラウドストレージ等）。
2. 対象端末で「提供元不明のアプリ」のインストールを一時的に許可する
   （debug署名APKのため。[docs/ANDROID_DISTRIBUTION.md](ANDROID_DISTRIBUTION.md)参照）。
3. 対象端末の組み合わせ（最低2台、可能なら両方）:
   - Android タブレット（できればstylus対応機種）
   - Kindle Fireタブレット

## チェックリスト

各項目をPass/Failで記録する。Failした場合は再現手順・端末名・Androidバージョンを添える。

| # | 確認項目 | 手順 | 期待結果 |
|---|---|---|---|
| 1 | インストール | APKをタップしてインストール | エラーなく完了し、ホーム画面にアイコンが追加される |
| 2 | 起動 | アイコンをタップして起動 | 説明なしで10秒以内に台紙選択画面が表示される |
| 3 | 指描画 | 指で線を描く | 遅延・欠落なく追従する |
| 4 | stylus描画（対応機種のみ） | ペンで線を描く | 指と誤認せず、palm rejectionが機能する |
| 5 | pinch zoom / pan | 2本指でズーム・移動 | 意図しないpage zoom/scrollが発生しない |
| 6 | 20分連続描画 | 20分間、複数レイヤー・複数ストロークを描き続ける | クラッシュ・大幅な遅延なく安定動作する |
| 7 | Undo/Redo・レイヤー | Undo/Redo、レイヤー追加/並べ替え/表示切替 | 想定通りに反映される |
| 8 | Magic Brush / Stamp | にじいろ・ネオン、ハート/ほし等のスタンプ | 描画・配置できる |
| 9 | PNG保存 | 保存操作を実行 | 端末のギャラリー/ダウンロードにPNGが保存される |
| 10 | オフライン再起動 | 機内モードにしてアプリを再起動 | オフラインで起動し、直前の作業内容が保持される |
| 11 | 画面回転 | 端末を回転させる | レイアウトが崩れず、描画内容が失われない |

## 結果の記録先

実行結果（端末名・OSバージョン・Pass/Fail・不具合の再現手順）は、このTaskに対応する
Notion Task（`OEK-05-S03-T03`）のResultへ記録する。すべてPassした場合のみ、
`Status`を`Done`にできる（[CLAUDE.md](../CLAUDE.md)の実機Gate原則）。
1件でもFailがあれば、その内容を別Taskとして切り出すか本Taskへ残す。
