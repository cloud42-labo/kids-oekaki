#!/usr/bin/env bash
set -euo pipefail

PACKAGE="com.cloud42labo.kidsoekaki"
ARCHIVE="${1:-}"

if [ -z "$ARCHIVE" ] || [ ! -f "$ARCHIVE" ]; then
  echo "Usage: bash scripts/android-restore-appdata.sh <kids-oekaki-appdata-*.tar>" >&2
  exit 1
fi

if ! command -v adb >/dev/null 2>&1; then
  echo "adb が見つかりません。Android platform-tools をインストールしてください。" >&2
  exit 1
fi

adb get-state >/dev/null

if ! adb shell pm path "$PACKAGE" >/dev/null 2>&1; then
  echo "$PACKAGE が端末にインストールされていません。先に固定署名のmigration APKを入れてください。" >&2
  exit 1
fi

if ! adb shell run-as "$PACKAGE" true >/dev/null 2>&1; then
  echo "run-as が使えません。復元時は kids-oekaki-migration.apk をインストールしてください。" >&2
  exit 1
fi

REMOTE="/data/local/tmp/kids-oekaki-appdata.tar"

echo "Kids Oekaki を停止してバックアップを復元します..."
adb shell am force-stop "$PACKAGE" >/dev/null
adb push "$ARCHIVE" "$REMOTE" >/dev/null
adb shell chmod 644 "$REMOTE"

# shell reads the archive and pipes it to the app UID. run-as starts in the app
# data directory, so restored files are owned by the correct application UID.
adb shell "cat '$REMOTE' | run-as '$PACKAGE' tar -xf -"
adb shell rm -f "$REMOTE"
adb shell am force-stop "$PACKAGE" >/dev/null

echo "Restore OK."
echo "Kids Oekakiを起動し、過去作品が開けることを確認してください。"
