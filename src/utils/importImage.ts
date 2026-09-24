// Reads a device photo picked via <input type="file"> and prepares it for
// use as a draft-layer ImageObject: downscaled and re-encoded so a saved
// document doesn't carry a multi-megabyte original (see documentStorage.ts —
// the whole undo history, including this image's data URL, is written to
// IndexedDB on every autosave).
const MAX_DIMENSION = 1600;
const JPEG_QUALITY = 0.85;

export type DecodedDraftImage = {
  src: string;
  naturalWidth: number;
  naturalHeight: number;
};

function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('画像を読み込めませんでした'));
    img.src = src;
  });
}

// Re-encodes as JPEG regardless of the source format. This app's use case is
// a photo/reference to trace over, not a sticker, so the transparency a PNG
// source might carry is not needed and dropping it keeps saved documents
// smaller (JPEG compresses photos far better than PNG).
export async function loadDraftImageFile(file: File): Promise<DecodedDraftImage> {
  if (!file.type.startsWith('image/')) {
    throw new Error('画像ファイルを選んでください');
  }
  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await loadImageElement(objectUrl);
    if (!img.naturalWidth || !img.naturalHeight) {
      throw new Error('画像を読み込めませんでした');
    }
    const scale = Math.min(1, MAX_DIMENSION / Math.max(img.naturalWidth, img.naturalHeight));
    const width = Math.max(1, Math.round(img.naturalWidth * scale));
    const height = Math.max(1, Math.round(img.naturalHeight * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('画像を読み込めませんでした');
    ctx.drawImage(img, 0, 0, width, height);

    return { src: canvas.toDataURL('image/jpeg', JPEG_QUALITY), naturalWidth: width, naturalHeight: height };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
