# Android Distribution

このドキュメントは OEK-05-S03（Androidアプリとしてインストール可能な配布物を作る）の
アーキテクチャ決定を記録する。T01は着手したが完了証跡なく Superseded となり、
T04（本Task）として再実行して確定した。以降の実装（T02: Capacitor Android shell、
T03: Release build / 実機Smoke Test導線）はこの決定に従う。

## 責務境界（PWA/Android shellのSSoT分離）

- 描画ドメイン（`domain/` `state/` `engine/`）・UI・PWA（service worker / manifest）は
  引き続き既存のPWAコードベースを唯一のSSoTとする。二重実装しない。
- Android shellは [Capacitor](https://capacitorjs.com/) による薄いネイティブラッパーとし、
  ビルド済みPWA（`dist/`）をWebViewでホストするだけの役割に限定する。
- Capacitorプラグインは、ブラウザ実行では実現できない範囲（アプリアイコン起動、
  スプラッシュ画面、必要になった場合のファイル保存/共有インテント等）に限定して追加する。
  描画ロジック・Undo/Redo・Document構造をネイティブ側へ持ち込まない。
- [ARCHITECTURE.md](ARCHITECTURE.md) の方針（「実機検証でブラウザの入力/palm-rejection/
  ファイル保存の限界が見つかったらCapacitor Android shellを足す」）と整合させる。

## Capacitorバージョンとビルド設定

- Capacitor **8系 stable**を採用する（alpha/betaは使わない）。2026-09-21時点の最新は
  8.5.x系。
- `webDir` は Vite のビルド出力である `dist` を指定する。
- Capacitor 8のAndroidテンプレート既定値をそのまま採用する:
  - `minSdkVersion = 24`
  - `compileSdkVersion = 36`
  - `targetSdkVersion = 36`
  - Gradle Wrapper 8.14.3 / AGP 8.13.0
  （出典: [Capacitor 8.0 Updating Guide](https://capacitorjs.com/docs/updating/8-0)）
- `com.cloud42labo.serendipityspot`（`cloud42-labo/serendipity-spot`）は
  `minSdk=26` を採用しているが、Kids Oekakiは「家庭にある既存タブレット・お下がり端末を
  子供の創作道具として再利用できる」という製品原則があるため、Capacitor 8が許容する
  最も低い `minSdk=24` をそのまま採用し、対応端末の幅を優先する。
- `compileSdk`/`targetSdk=36`（Android 16）は、Google Playの新規アプリ・アップデートに
  対する target API要件（2026-08-31以降 API 36必須、猶予は2026-11-01まで）を満たす
  （出典: [Meet Google Play's target API level requirement](https://developer.android.com/google/play/requirements/target-sdk)）。
  Capacitor 8の既定値がこの要件と一致しているため、追加の引き上げ作業は不要。

## applicationId

- `applicationId` / `namespace` は **`com.cloud42labo.kidsoekaki`** とする。
- 既存の `cloud42-labo/serendipity-spot` が `com.cloud42labo.serendipityspot` を
  採用しており、Cloud42 Labo内の逆ドメイン命名規則（`com.cloud42labo.<appname>`）に揃える。
- **`applicationId`はGoogle Playへの初回公開後は実質的に変更できない。**
  変更する場合は別アプリとして再公開が必要になり、既存ユーザーの引き継ぎができない。
  そのため、Store初回公開（OEK-05-S05）より前の、このT04の時点で確定させる。
  T02以降の実装でこの値を変更する場合は、Store未公開の間に限り本ドキュメントを
  更新したうえで変更すること。

## versionCode / versionName

- `versionName` は `package.json` の `version`（PWA側のSemVer、現在 `0.13.5`）と一致させる。
  [RELEASE.md](RELEASE.md) のSemVer運用（`0.x.y` → `1.0.0-rc.N` → `1.0.0`）をそのまま
  Android側にも反映する。
- `versionCode` は `versionName` とは独立した単調増加の整数とし、Android向けビルドを
  生成するたびに1ずつ増やす（`versionName`のマイナー/パッチ更新と1:1対応させない）。
  既存の `serendipity-spot`（`versionCode=41` に対し `versionName=1.6.0`）と同じ運用。
  初回ビルド（T02のCI debug build）は `versionCode=1` から開始する。

## 署名 / Store公開Gate

- T02/T03の時点では **debug署名**のinstallable APKをGitHub Actions artifactとして
  生成するに留める（Store提出はしない）。Androidのpackage managerはunsigned APKの
  インストールを許可しないため、「unsigned」は選択肢に含めない。Capacitor/Android
  Studioのdebug buildが自動生成するdebugキーストアでの署名をそのまま使う。
- Release署名鍵（keystoreファイル・キーストアパスワード・キーエイリアスパスワード）は
  リポジトリにコミットせず、GitHub Secretsにのみ置く（各CLAUDE.mdの「秘密情報」原則と同一）。
  署名workflowはSecretsから読み込むjobとして、通常のCI/CDと分離する。
- Google Play Console上での初回Store公開は独立したHuman Gate（OEK-05-S05）で扱い、
  この時点でapplicationId・パッケージ内容の最終確認を行う。T02/T03のCI成功だけで
  Store公開判定はしない（実機Gateの原則と同様）。

## 参照

- [Capacitor 8.0 Updating Guide](https://capacitorjs.com/docs/updating/8-0)
- [Google Play: Meet the target API level requirement](https://developer.android.com/google/play/requirements/target-sdk)
- [ARCHITECTURE.md](ARCHITECTURE.md)
- [RELEASE.md](RELEASE.md)
