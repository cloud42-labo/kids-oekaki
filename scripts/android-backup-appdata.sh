#!/usr/bin/env bash
set -euo pipefail

PACKAGE="com.cloud42labo.kidsoekaki"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="${1:-kids-oekaki-appdata-${STAMP}.tar}"

if ! command -v adb >/dev/null 2>&1; then
  echo "adb が見つかりません。Android platform-tools をインストールしてください。" >&2
  exit 1
fi

adb get-state >/dev/null

if ! adb shell pm path "$PACKAGE" >/dev/null 2>&1; then
  echo "$PACKAGE が端末にインストールされていません。" >&2
  exit 1
fi

if ! adb shell run-as "$PACKAGE" true >/dev/null 2>&1; then
  echo "run-as が使えません。現在のAPKがdebuggableであることを確認してください。" >&2
  exit 1
fi

echo "Kids Oekaki を停止してアプリデータを退避します..."
adb shell am force-stop "$PACKAGE" >/dev/null

# run-as starts in the package data directory. Archive the complete app sandbox so
# WebView IndexedDB (drawing-sessions) is preserved together with related metadata.
adb exec-out run-as "$PACKAGE" tar -cf - . > "$OUT"

if [ ! -s "$OUT" ]; then
  echo "バックアップファイルが空です。旧アプリはアンインストールしないでください。" >&2
  exit 1
fi

if command -v tar >/dev/null 2>&1; then
  tar -tf "$OUT" >/dev/null
fi

SIZE="$(wc -c < "$OUT" | tr -d ' ')"
echo "Backup OK: $OUT ($SIZE bytes)"
echo "このファイルの確認が終わるまで旧Kids Oekakiをアンインストールしないでください。"
