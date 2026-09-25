import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { Media } from '@capacitor-community/media';
import type { DrawingDocument } from '../domain/drawing';
import { renderDocument } from '../engine/renderer';

const ALBUM_NAME = 'おえかき';

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

// アプリ専用アルバム（Android/media/<pkg>/おえかき）のフルパスをsavePhotoの
// albumIdentifierとして使う。createAlbumは既に存在する場合"Album already exists"
// でrejectするだけなので無視してよいが、それ以外の失敗（真にアルバムを作れない）は
// 呼び出し元へ伝播させ、savePhoto側の失敗として顕在化させる。
async function ensureAlbum(): Promise<string> {
  const { path } = await Media.getAlbumsPath();
  const albumIdentifier = `${path}/${ALBUM_NAME}`;
  try {
    await Media.createAlbum({ name: ALBUM_NAME });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes('already exists')) {
      throw error;
    }
  }
  return albumIdentifier;
}

// Android（Capacitor WebView）では <a download> によるブラウザのダウンロード機構が
// 存在しないため、リンクをclickしても無反応でファイルが保存されない。
// Directory.Cache + Shareだけでは、ユーザーが共有シートで明示的に「保存」を選ばない
// 限りどこにも永続化されない（アプリのキャッシュはOSがいつ消してもおかしくない）ため
// 「保存した」というAcceptance Criteriaを満たさない。
// @capacitor-community/mediaのsavePhoto()はMediaStore経由で端末のフォトギャラリーへ
// 直接書き込む。androidGalleryMode（既定false、このアプリでは未設定）を使わない限り
// アプリ専用アルバムへの書き込みになるため、ランタイムのストレージ権限は不要。
// 保存自体はsavePhoto()の時点で完了しており、その後のCache書き出し・共有シートは
// 「他アプリへ送る」ためのおまけの手段なので、失敗しても保存の成否には影響させない。
async function saveOnNative(blob: Blob, filename: string) {
  const base64 = await blobToBase64(blob);
  const albumIdentifier = await ensureAlbum();
  const fileNameWithoutExtension = filename.replace(/\.png$/, '');

  // savePhoto()のnative実装（Android）はpathを読み取り可能なファイルURIとして
  // 扱い、Web dataURLをデコードしない。先にFilesystemで実ファイル化してから
  // その native URIを渡す。
  await Filesystem.writeFile({
    path: filename,
    data: base64,
    directory: Directory.Cache,
  });
  const { uri } = await Filesystem.getUri({ path: filename, directory: Directory.Cache });

  await Media.savePhoto({
    path: uri,
    albumIdentifier,
    fileName: fileNameWithoutExtension,
  });

  try {
    await Share.share({
      title: 'おえかきを保存しました',
      url: uri,
    });
  } catch {
    // 共有は付加的な手段。ギャラリーへの保存自体は上のsavePhoto()で既に成功している。
  }
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
