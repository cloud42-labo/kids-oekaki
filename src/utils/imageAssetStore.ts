import type { DrawingDocument, DrawingLayer, ImageObject } from '../domain/drawing';
import { IMAGE_ASSETS_STORE, SESSIONS_STORE, openDb } from './db';

// ImageObject.src historically held the full downscaled-JPEG data URL
// directly (utils/importImage.ts). Every undo-history snapshot
// (MAX_HISTORY=60 in state/useDrawingDocument.ts) that includes that object
// fully structured-clone-serializes that whole string into IndexedDB on
// every autosave — moving/resizing an image repeatedly never changes its
// bytes but still copies them into every new snapshot, so a single session's
// saved data could exceed 100MB (OEK-05-S04-T11).
//
// Fix: ImageObject.src now holds a short *reference* ("asset:<content
// hash>") into IMAGE_ASSETS_STORE, a separate object store that holds each
// distinct image's bytes exactly once, content-addressed so re-importing (or
// migrating two different sessions that happen to embed) the same bytes
// reuses the same record instead of writing a second copy. A legacy inline
// data: URL (saved before this change) is still a valid src —
// resolveImageSrc() below passes it through unchanged, and
// engine/renderer.ts never needed to know the difference — but
// documentStorage.ts migrates it into this store (and rewrites the saved
// session to the asset: reference) the next time that session loads, so
// storage shrinks for old drawings without the user doing anything.
const ASSET_REF_PREFIX = 'asset:';

export type ImageAssetRecord = {
  id: string;
  dataUrl: string;
  // Used by garbageCollectImageAssets()'s grace period below — see its own
  // comment for why a brand-new asset must not be eligible for collection
  // yet even if no saved session happens to reference it at this instant.
  createdAt: number;
};

export function isAssetRef(src: string): boolean {
  return src.startsWith(ASSET_REF_PREFIX);
}

function assetIdFromRef(src: string): string {
  return src.slice(ASSET_REF_PREFIX.length);
}

function toAssetRef(assetId: string): string {
  return `${ASSET_REF_PREFIX}${assetId}`;
}

// SHA-256 over the data URL string itself (not just the base64 payload) —
// importImage.ts always re-encodes with the same fixed format
// ('image/jpeg', one fixed quality), so identical pixels always produce an
// identical string, and hashing the whole string is simpler than parsing out
// the base64 body first.
async function hashContent(content: string): Promise<string> {
  const bytes = new TextEncoder().encode(content);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function getAsset(db: IDBDatabase, id: string): Promise<ImageAssetRecord | undefined> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IMAGE_ASSETS_STORE, 'readonly');
    const request = tx.objectStore(IMAGE_ASSETS_STORE).get(id);
    request.onsuccess = () => resolve(request.result as ImageAssetRecord | undefined);
    request.onerror = () => reject(request.error ?? new Error('画像データを読めませんでした'));
  });
}

function putAsset(db: IDBDatabase, record: ImageAssetRecord): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IMAGE_ASSETS_STORE, 'readwrite');
    tx.objectStore(IMAGE_ASSETS_STORE).put(record, record.id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('画像データを保存できませんでした'));
    tx.onabort = () => reject(tx.error ?? new Error('画像データを保存できませんでした'));
  });
}

// Content-addressed: the id is derived from `dataUrl` itself, so storing the
// exact same bytes twice — the same photo re-imported, or two different
// saved sessions that happen to embed byte-identical data (see
// migrateImageAssetsInSession below) — always resolves to the one existing
// record instead of writing a duplicate.
export async function storeImageAsset(dataUrl: string): Promise<string> {
  const id = await hashContent(dataUrl);
  const db = await openDb();
  try {
    const existing = await getAsset(db, id);
    if (!existing) {
      await putAsset(db, { id, dataUrl, createdAt: Date.now() });
    }
    return toAssetRef(id);
  } finally {
    db.close();
  }
}

export async function getImageAssetDataUrl(assetId: string): Promise<string | undefined> {
  const db = await openDb();
  try {
    const record = await getAsset(db, assetId);
    return record?.dataUrl;
  } finally {
    db.close();
  }
}

// Resolves an ImageObject.src into something an <img> element can actually
// decode: a legacy inline data: URL passes through unchanged (it already is
// one); an asset: reference is looked up in IMAGE_ASSETS_STORE. Returns
// undefined for a dangling reference (the asset row is missing — shouldn't
// happen in normal use, but garbageCollectImageAssets()'s grace period is a
// heuristic, not a hard guarantee; see its own comment) so callers can treat
// that like any other failed image load instead of throwing.
export async function resolveImageSrc(src: string): Promise<string | undefined> {
  if (!isAssetRef(src)) return src;
  return getImageAssetDataUrl(assetIdFromRef(src));
}

type HistoryLike = { past: DrawingDocument[]; present: DrawingDocument; future: DrawingDocument[] };

async function migrateImageObjectsInDocument(
  doc: DrawingDocument,
  cache: Map<string, string>,
): Promise<{ doc: DrawingDocument; migrated: boolean }> {
  let migrated = false;
  const layers = await Promise.all(
    doc.layers.map(async (layer: DrawingLayer) => {
      let layerChanged = false;
      const objects = await Promise.all(
        layer.objects.map(async (object) => {
          if (object.type !== 'image' || isAssetRef(object.src)) return object;
          let ref = cache.get(object.src);
          if (!ref) {
            ref = await storeImageAsset(object.src);
            cache.set(object.src, ref);
          }
          layerChanged = true;
          const migratedObject: ImageObject = { ...object, src: ref };
          return migratedObject;
        }),
      );
      if (!layerChanged) return layer;
      migrated = true;
      return { ...layer, objects };
    }),
  );
  if (!migrated) return { doc, migrated: false };
  return { doc: { ...doc, layers }, migrated: true };
}

// Migrates every ImageObject across a session's ENTIRE history (not just
// `present` — undo/redo can bring back a pre-migration snapshot otherwise,
// see state/useDrawingDocument.ts's restoreHistory, which applies the same
// "migrate every snapshot" treatment to ensureDraftLayer for the same
// reason) from an inline data: URL to an asset: reference. `cache` dedupes
// identical bytes across snapshots and across the whole session — without
// it, each of up to 60 history snapshots carrying the same inline photo
// would redo the same hash+write instead of discovering it already has a
// reference for that exact string (storeImageAsset's own DB-level dedup
// would still prevent a *duplicate row*, but not the redundant hashing/IO).
// Called by documentStorage.ts on every load of an older saved session (see
// its migrateSessionIfNeeded) so existing drawings shrink automatically
// instead of requiring the user to re-import anything.
export async function migrateImageAssetsInSession<T extends { history: HistoryLike }>(
  session: T,
): Promise<{ session: T; migrated: boolean }> {
  const cache = new Map<string, string>();
  let migrated = false;

  const past = await Promise.all(
    session.history.past.map(async (doc) => {
      const result = await migrateImageObjectsInDocument(doc, cache);
      if (result.migrated) migrated = true;
      return result.doc;
    }),
  );
  const presentResult = await migrateImageObjectsInDocument(session.history.present, cache);
  if (presentResult.migrated) migrated = true;
  const future = await Promise.all(
    session.history.future.map(async (doc) => {
      const result = await migrateImageObjectsInDocument(doc, cache);
      if (result.migrated) migrated = true;
      return result.doc;
    }),
  );

  if (!migrated) return { session, migrated: false };
  return { session: { ...session, history: { past, present: presentResult.doc, future } }, migrated: true };
}

// Freshly stored assets younger than this are never collected, regardless of
// whether any saved session references them yet. storeImageAsset() writes an
// asset's bytes *before* the ImageObject referencing it is ever added to a
// document (App.tsx#importImage awaits it first), and that document isn't
// itself persisted until the next autosave (debounced ~1.2s — see App.tsx)
// commits. Without this grace period, garbageCollectImageAssets() running in
// that gap — triggered by an unrelated save, in this tab or another — would
// see a freshly-created asset with no session referencing it yet and delete
// it, turning the image into a dangling reference the moment its own save
// finally lands. 10s is comfortably larger than that debounce plus a slow
// IndexedDB write in any single tab; it can't fully rule out a pathological
// multi-tab race, but that's an accepted trade-off for a local, single-device
// kids' drawing app rather than building full cross-tab-transactional
// reference counting for it.
const DEFAULT_GC_GRACE_MS = 10_000;

function readAllDrawingSessions(db: IDBDatabase): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SESSIONS_STORE, 'readonly');
    const request = tx.objectStore(SESSIONS_STORE).getAll();
    request.onsuccess = () => resolve(request.result as unknown[]);
    request.onerror = () => reject(request.error ?? new Error('保存した作品を読めませんでした'));
  });
}

function readAllImageAssets(db: IDBDatabase): Promise<ImageAssetRecord[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IMAGE_ASSETS_STORE, 'readonly');
    const request = tx.objectStore(IMAGE_ASSETS_STORE).getAll();
    request.onsuccess = () => resolve(request.result as ImageAssetRecord[]);
    request.onerror = () => reject(request.error ?? new Error('画像データを読めませんでした'));
  });
}

function deleteImageAssets(db: IDBDatabase, ids: string[]): Promise<void> {
  if (ids.length === 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IMAGE_ASSETS_STORE, 'readwrite');
    const store = tx.objectStore(IMAGE_ASSETS_STORE);
    for (const id of ids) store.delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('画像データを削除できませんでした'));
    tx.onabort = () => reject(tx.error ?? new Error('画像データを削除できませんでした'));
  });
}

// Walks every saved session's full history (loosely typed — this reads raw
// IndexedDB records, which may be mid-migration or from an older schema) and
// collects every asset: id any ImageObject anywhere still points at.
function collectReferencedAssetIds(sessions: unknown[]): Set<string> {
  const ids = new Set<string>();
  const visitDocument = (doc: unknown) => {
    if (!doc || typeof doc !== 'object') return;
    const layers = (doc as { layers?: unknown }).layers;
    if (!Array.isArray(layers)) return;
    for (const layer of layers) {
      const objects = (layer as { objects?: unknown } | null)?.objects;
      if (!Array.isArray(objects)) continue;
      for (const object of objects) {
        const typed = object as { type?: unknown; src?: unknown } | null;
        if (typed?.type === 'image' && typeof typed.src === 'string' && isAssetRef(typed.src)) {
          ids.add(assetIdFromRef(typed.src));
        }
      }
    }
  };
  for (const raw of sessions) {
    const history = (raw as { history?: unknown } | null)?.history as
      | { past?: unknown[]; present?: unknown; future?: unknown[] }
      | undefined;
    if (!history) continue;
    (history.past ?? []).forEach(visitDocument);
    visitDocument(history.present);
    (history.future ?? []).forEach(visitDocument);
  }
  return ids;
}

// Mark-and-sweep: an asset is kept if ANY saved session's history (past,
// present, or future — undo/redo must keep working after this runs) still
// references it, or if it's younger than the grace period above. Everything
// else has become unreachable (the image was cleared/undone-away, or its
// whole session was deleted) and is removed. Scans every saved session's
// full history on every call, by design — called from documentStorage.ts's
// saveDrawingSession/deleteDrawingSession and once from App.tsx's startup
// effect, which is an acceptable cost at this app's scale (a handful of
// saved drawings, each capped at 60 history snapshots) rather than
// maintaining a live reference count across every undo/redo/push.
export async function garbageCollectImageAssets(graceMs: number = DEFAULT_GC_GRACE_MS): Promise<number> {
  const db = await openDb();
  try {
    const [sessions, assets] = await Promise.all([readAllDrawingSessions(db), readAllImageAssets(db)]);
    const liveIds = collectReferencedAssetIds(sessions);
    const now = Date.now();
    const toDelete = assets
      .filter((asset) => !liveIds.has(asset.id) && now - asset.createdAt >= graceMs)
      .map((asset) => asset.id);
    await deleteImageAssets(db, toDelete);
    return toDelete.length;
  } finally {
    db.close();
  }
}
