# Android Distribution

このドキュメントは Kids Oekaki のAndroid配布方式を記録する。
実装・CI/CD・Release成果物のSSoTは `cloud42-labo/kids-oekaki` とする。

## 責務境界（PWA / Android shell）

- 描画ドメイン（`domain/` `state/` `engine/`）・UI・PWAは既存コードを唯一のSSoTとする。
- Android shellはCapacitorによる薄いネイティブラッパーとし、`dist/` をWebViewでホストする。
- ネイティブ固有機能は、ファイル保存・共有などブラウザだけでは成立しない範囲に限定する。
- 作品の編集可能データはWebViewのIndexedDB（`kids-oekaki / drawing-sessions`）へ保存される。
  **同一applicationId・同一署名で上書き更新する限り、通常のアプリアップデートではこのデータを削除しない。**

## Android基本設定

- Capacitor 8 stable
- `webDir = dist`
- `applicationId / namespace = com.cloud42labo.kidsoekaki`
- `minSdkVersion = 24`
- `compileSdkVersion / targetSdkVersion = 36`
- `versionName` は `package.json` のSemVer（現在 `0.13.6`）と一致させる。

`applicationId` はGoogle Play初回公開後は実質変更できないため、今後も
`com.cloud42labo.kidsoekaki` を維持する。

## versionCode

旧CIのdebug APKは `ANDROID_VERSION_CODE` を渡していなかったため、実質 `versionCode=1` だった。

OEK-05-S03-T05以降の配布ビルドではGitHub Actionsのrun numberから単調増加値を生成する。

- migration APK: `100000 + GITHUB_RUN_NUMBER * 2`
- release APK / AAB: migration APKの値 + 1

同一workflow内でもrelease版をmigration版より新しくし、migration版からrelease版へ
必ず上書き更新できるようにする。

## 固定署名

### 方針

GitHub Actions runnerがその場で生成するdebug keystoreは配布には使用しない。
配布APK/AABは、Kids Oekaki専用の**固定Release署名鍵**で毎回署名する。

必要なGitHub Actions Secrets:

- `OEKAKI_RELEASE_KEYSTORE_BASE64`
- `OEKAKI_RELEASE_STORE_PASSWORD`
- `OEKAKI_RELEASE_KEY_ALIAS`
- `OEKAKI_RELEASE_KEY_PASSWORD`

秘密鍵・パスワードはRepositoryへコミットしない。
CIはSecrets未設定の場合に配布ビルドを明示的に失敗させる。

CIではkeystoreのSHA-1と生成されたAPK/AABの署名SHA-1を比較し、
意図した固定鍵で署名されていない成果物を公開しない。

### 署名鍵の初回作成

メンテナーの安全な端末上で1回だけ作成する。

```bash
keytool -genkeypair -v \
  -keystore kids-oekaki-release.jks \
  -alias kidsoekaki \
  -keyalg RSA \
  -keysize 4096 \
  -validity 10000
```

keystore本体は安全なバックアップ先にも保管する。
その後、改行なしBase64を `OEKAKI_RELEASE_KEYSTORE_BASE64` としてGitHub Secretsへ登録する。

macOS / Linux例:

```bash
base64 < kids-oekaki-release.jks | tr -d '\n'
```

この鍵は将来Google Playへ提出するAABのupload keyとして継続利用する。
Play App Signingを有効にした場合、Play配布APKの最終アプリ署名鍵はGoogle Play側で管理される。

## Release workflow

`.github/workflows/release.yml` は以下を行う。

1. PWA build / E2E
2. Capacitor Android sync
3. 固定keystoreの復元
4. release APK / AABを固定鍵で署名
5. APK/AAB署名指紋をkeystoreと照合
6. `kids-oekaki-release.apk` と `kids-oekaki-release.aab` をGitHub Releaseへ公開
7. mainへのpushはrolling tag `latest` として公開する
8. versioned releaseはmain上の `workflow_dispatch` で `release_tag=v<package.json version>` を指定して作成する。任意commitへの `v*` tag pushから署名Releaseは実行しない

`workflow_dispatch` で `include_migration_apk=true` を指定した場合だけ、
`kids-oekaki-migration.apk` も生成する。この移行runでは `release_tag` を空欄にし、
GitHub Releaseを更新せずworkflow artifactとして取得する。

migration APKは固定Release鍵で署名する一方、既存データ復元のため `debuggable=true` とする。
通常利用・通常配布には使わない。

## 重要: 旧debug APKからの初回移行

### なぜ初回だけ特別対応が必要か

2026-09-27以前のGitHub Actions配布APKは `assembleDebug` で作成され、
runnerごとに別のdebug keystoreが生成され得る状態だった。

Androidは**署名証明書が異なるAPKを同じアプリとして上書き更新できない**。
そのため現在端末に保存済みの作品がある場合、固定署名版へ切り替える最初の1回だけ
データ退避・復元が必要になる可能性が高い。

**作品を退避する前に旧アプリをアンインストールしないこと。**

### 初回移行手順

1. 重要作品は念のためPNGにも保存する。
2. USB debuggingを有効にし、PCから端末へ `adb` 接続する。
3. 旧debug APKをインストールしたまま、以下を実行する。

```bash
bash scripts/android-backup-appdata.sh
```

4. 作成された `kids-oekaki-appdata-*.tar` が空でないことを確認する。
5. GitHub Actions Secretsへ固定署名鍵4項目を登録する。
6. GitHub Actionsの `Release Kids Oekaki` を **main** から手動実行し、`include_migration_apk=true`、`release_tag` は空欄にする。
7. 成功runの `kids-oekaki-<version>-android-<versionCode>` workflow artifactをダウンロードし、`kids-oekaki-migration.apk` と `kids-oekaki-release.apk` を確保する。
8. **バックアップ確認後に限り**旧debug APKをアンインストールする。
9. `kids-oekaki-migration.apk` をインストールする。
10. migration APKは起動せず、以下でバックアップを復元する。

```bash
bash scripts/android-restore-appdata.sh kids-oekaki-appdata-YYYYMMDD-HHMMSS.tar
```

11. migration APKを起動し、過去作品が一覧にあり開けることを確認する。
12. `kids-oekaki-release.apk` をアンインストールせず上書きインストールする。
13. 過去作品が残り、新規作品も保存・再読込できることを確認する。

ここまで完了すれば以後は固定署名版同士なので、
**アンインストールなしの通常アップデートで作品データを維持できる。**

## Google Play移行

Google Play公開前に次を確認する。

- applicationIdは `com.cloud42labo.kidsoekaki` のまま
- AABは固定Oekaki release/upload keyで署名
- versionCodeはPlay上の直前版より大きい
- Play App Signingの設定を確認
- 既存sideload版からPlay版へ更新する際の署名互換性を実機で検証

初回Store公開は OEK-05-S05 のHuman Gateとして扱う。

## 参照

- [ARCHITECTURE.md](ARCHITECTURE.md)
- [RELEASE.md](RELEASE.md)
