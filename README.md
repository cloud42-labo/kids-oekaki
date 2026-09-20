# Kids Oekaki

小学低学年向けのタブレットお絵かきアプリ。`oekaki_v2.html` PoCを、拡張可能なPWAアーキテクチャへ移行した初期コードベースです。

## Included in v0.1 scaffold
- まっしろ / 4コマまんが / えにっき
- ペン / マーカー / けしごむ
- 基本色 + カスタムカラー / 太さ1〜60
- 動的レイヤー追加・削除・表示切替
- Undo / Redo
- PNG保存 (`toBlob`)
- Pointer Events + coalesced samples
- PWA manifest + service worker
- Stroke/Stampを保持できるDocumentモデル

## Run
```bash
npm install
npm run dev
```

## Build
```bash
npm run build
npm run preview
```

## Next backlog
1. Android/Kindle実機で描画・回転・保存・オフライン・パームリジェクションをE2E確認。
2. レイヤー名変更・並び替え・ロック。
3. レインボー/ネオンなどMagic Brush renderer。
4. ハート/星/フキダシ/集中線スタンプUI。
5. IndexedDB自動保存と作品一覧。
6. Web入力制約が残る場合のみCapacitor 8 Android shellを追加。
