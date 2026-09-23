import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import type { DrawingDocument } from '../domain/drawing';
import { renderDocument } from '../engine/renderer';

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      // data:image/png;base64,xxxx… の先頭部分を取り除き、base64本体だけを返す
      const result = reader.result as string;
      const base64 = result.slice(result.indexOf(',') + 1);
      resolve(base64);
    };
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read blob as base64'));
    reader.readAsDataURL(blob);
  });
}

// Android（Capacitor WebView）では <a download> によるブラウザのダウンロード機構が
// 存在しないため、リンクをclickしても無反応でファイルが保存されない。
// ネイティブ環境ではCapacitor FilesystemでアプリのキャッシュへPNGを書き出したうえで、
// OSの共有シートを開き、ユーザーが「保存結果を確認」できる状態にする。
// Directory.Cache（アプリ専用領域）を使うのは、Directory.Documentsが端末の共有
// ストレージ（Environment.getExternalStoragePublicDirectory）にマップされ、
// ランタイムのストレージ権限を要求してしまうため。Cacheはアプリ専用領域なので
// 権限不要で書き込め、既存のFileProvider設定（<cache-path>）でも共有可能。
async function saveOnNative(blob: Blob, filename: string) {
  const base64 = await blobToBase64(blob);
  await Filesystem.writeFile({
    path: filename,
    data: base64,
    directory: Directory.Cache,
  });
  const { uri } = await Filesystem.getUri({ path: filename, directory: Directory.Cache });
  await Share.share({
    title: 'おえかきを保存しました',
    url: uri,
  });
}

function saveOnWeb(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = window.document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function exportPng(document: DrawingDocument) {
  const canvas = window.document.createElement('canvas');
  canvas.width = document.width;
  canvas.height = document.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context is unavailable');
  renderDocument(ctx, document);

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((result) => result ? resolve(result) : reject(new Error('PNG export failed')), 'image/png');
  });

  const filename = `oekaki-${new Date().toISOString().slice(0, 10)}.png`;

  if (Capacitor.isNativePlatform()) {
    await saveOnNative(blob, filename);
  } else {
    saveOnWeb(blob, filename);
  }
}
