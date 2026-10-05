// Shared low-level IndexedDB plumbing. Every object store this app uses
// lives in the same 'kids-oekaki' database, and IndexedDB only invokes
// onupgradeneeded once per actual version bump (for whichever connection
// happens to trigger it) — so both stores must be created from this single
// shared openDb(), not from two modules each opening the database with their
// own DB_VERSION. documentStorage.ts (saved session records) and
// imageAssetStore.ts (de-duplicated image bytes, see OEK-05-S04-T11) both
// import this instead of calling indexedDB.open() themselves.
export const DB_NAME = 'kids-oekaki';
// v1: drawing-sessions only.
// v2 (OEK-05-S04-T11): adds image-assets. ImageObject.src used to hold a
// full downscaled-JPEG data URL directly, so every undo-history snapshot
// that referenced it serialized a full copy of those bytes into
// drawing-sessions. image-assets now holds each distinct image's bytes
// exactly once, content-addressed, and ImageObject.src holds only a short
// reference into it (utils/imageAssetStore.ts). A v1-only build never reads
// this store, so the bump doesn't change anything it can already see.
export const DB_VERSION = 2;
export const SESSIONS_STORE = 'drawing-sessions';
export const IMAGE_ASSETS_STORE = 'image-assets';

export function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SESSIONS_STORE)) db.createObjectStore(SESSIONS_STORE);
      if (!db.objectStoreNames.contains(IMAGE_ASSETS_STORE)) db.createObjectStore(IMAGE_ASSETS_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('保存場所を開けませんでした'));
  });
}
