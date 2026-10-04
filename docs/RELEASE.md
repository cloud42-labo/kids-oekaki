# Release

Kids OekakiはSemVerを使用する。

## Version

- 開発中: `0.x.y`
- Release Candidate: `1.0.0-rc.N`
- 正式公開: `1.0.0`

`package.json` の `version` とversioned release tagは必ず一致させる。

例:

```text
package.json: 1.0.0-rc.1
tag: v1.0.0-rc.1
```

## Release gate

versioned releaseは、対象versionをmainへマージした後、GitHub Actionsの
`Release Kids Oekaki` を **main** から手動実行し、
`release_tag=v<package.json version>` を指定する。任意commitへのtag pushから
固定署名Secretsを使うReleaseは起動しない。

workflowは以下を実行する。

1. 指定release_tagとpackage versionの一致確認
2. `npm ci`
3. `npm run build`
4. Playwright E2E
5. `dist` をZIP化
6. GitHub Release作成
7. Release Notes自動生成

Release workflowが成功しても、Android / Kindleの実機Acceptanceが必要な変更は実機確認なしに正式公開判定しない。

## v1.0 candidate

v1.0候補を作る時点で `package.json` を `1.0.0-rc.1` へ更新し、通常のPRレビュー・CIを通してmainへマージする。その後、main上の `Release Kids Oekaki` を手動実行し、`release_tag=v1.0.0-rc.1` を指定する。workflowがmainの該当commitをtargetにversioned GitHub Releaseを作成する。
