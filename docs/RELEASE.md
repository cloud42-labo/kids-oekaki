# Release

Kids OekakiはSemVerを使用する。

## Version

- 開発中: `0.x.y`
- Release Candidate: `1.0.0-rc.N`
- 正式公開: `1.0.0`

`package.json` の `version` とGit tagは必ず一致させる。

例:

```text
package.json: 1.0.0-rc.1
tag: v1.0.0-rc.1
```

## Release gate

tagをpushすると `.github/workflows/release.yml` が以下を自動実行する。

1. tagとpackage versionの一致確認
2. `npm ci`
3. `npm run build`
4. Playwright E2E
5. `dist` をZIP化
6. GitHub Release作成
7. Release Notes自動生成

Release workflowが成功しても、Android / Kindleの実機Acceptanceが必要な変更は実機確認なしに正式公開判定しない。

## v1.0 candidate

v1.0候補を作る時点で `package.json` を `1.0.0-rc.1` へ更新し、通常のPRレビュー・CIを通してmainへマージする。その後 `v1.0.0-rc.1` tagをmainの該当commitへ付ける。
