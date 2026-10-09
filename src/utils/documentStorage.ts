import type { ToolSettings } from '../domain/drawing';
import { preloadDocumentImages, renderDocument } from '../engine/renderer';
import type { DrawingHistory } from '../state/useDrawingDocument';
import { SESSIONS_STORE as STORE_NAME, openDb } from './db';
import { garbageCollectImageAssets, migrateImageAssetsInSession } from './imageAssetStore';

const LEGACY_CURRENT_KEY = 'current';
const DRAFT_PREFIX = 'draft:';
// v2: pre-draft-image-import format (every DrawingObject is a
// stroke/blur/stamp). v3: adds the ImageObject variant (domain/drawing.ts)
// for imported photos. A v2 document is always a valid v3 document (it can
// never contain an image object), so it's safe to read-and-upgrade in place.
// A v3 document is NOT safe for a client that only knows v2: that client's
// object-rendering switch has no 'image' case, so it would silently treat an
// ImageObject as an unrecognized stamp and the photo would vanish from the
// canvas/exports while the user keeps editing and autosaving over it (Codex
// review finding on PR #11, reviewed commit c43ce60a45). Bumping
// SCHEMA_VERSION means a v2-only build's own (unchanged) strict `!==` guard
// below now rejects a v3 document outright — "この保存データは新しい形式です"
// — instead of misreading it.
// v4 (OEK-05-S04-T11): ImageObject.src may now be an "asset:<hash>"
// reference into IMAGE_ASSETS_STORE instead of an inline data URL (see
// utils/imageAssetStore.ts). A v3-only build would pass that string straight
// to an <img>.src, which the browser treats as an unrecognized protocol —
// the photo would silently fail to load instead of being misread, but it's
// still exactly the "a client that doesn't know this new ImageObject detail
// must refuse the document, not guess" situation the v2→v3 bump above
// already defends against, so the same strict-rejection guard applies here.
// migrateSessionIfNeeded() below both converts a v3 document's inline data
// URLs to asset: references AND relabels it to v4 in the same write, so a v4
// label always implies "every ImageObject.src in this session is an asset:
// reference" — never a half-migrated mix.
const SCHEMA_VERSION = 4;
// Oldest schemaVersion this build still reads (and upgrades on load). Only
// v2 predates this build; anything older already got folded into v2 by
// migrateLegacyCurrent() below before it could reach the versioned
// draft:-prefixed records this constant guards.
const MIN_READABLE_SCHEMA_VERSION = 2;
const THUMBNAIL_MAX_WIDTH = 180;
const THUMBNAIL_MAX_HEIGHT = 128;

export type StoredDrawingSession = {
  schemaVersion: number;
  id: string;
  name: string;
  savedAt: string;
  history: DrawingHistory;
  settings?: ToolSettings;
  thumbnail?: string;
};

type LegacyStoredDrawingSession = {
  schemaVersion: number;
  savedAt: string;
  history: DrawingHistory;
};

function validateHistory(history: DrawingHistory | undefined) {
  if (!history?.present || !Array.isArray(history.past) || !Array.isArray(history.future)) {
    throw new Error('保存データを安全に読み込めませんでした。');
  }
}

// Thrown only by upgradeSchemaVersion's final branch below, so callers can
// tell "this build structurally cannot read this version" apart from any
// other failure (e.g. a QuotaExceededError from image-asset migration) —
// see the dedicated catch in listDrawingSessions, which must never treat an
// UnsupportedSchemaVersionError the same way it treats those other,
// retry-safe failures (Codex review finding, PR #27 current-head: a prior,
// overly-broad catch there let an unreadable newer-schema session through
// as if it were ordinary rawValue, so it could be opened and autosaved —
// relabeling and silently overwriting it with this older build's
// SCHEMA_VERSION).
class UnsupportedSchemaVersionError extends Error {}

// Rejects anything this build doesn't know how to read (older than
// MIN_READABLE_SCHEMA_VERSION, or newer than SCHEMA_VERSION — e.g. saved by
// a build with a feature this one predates) rather than silently
// misinterpreting its DrawingObject variants, and upgrades an older-but-
// readable document's version label in place. Every readable older version
// so far (currently just v2) is a strict structural subset of the current
// one, so no field-level migration is needed beyond relabeling.
function upgradeSchemaVersion(value: StoredDrawingSession): StoredDrawingSession {
  if (value.schemaVersion === SCHEMA_VERSION) return value;
  if (value.schemaVersion >= MIN_READABLE_SCHEMA_VERSION && value.schemaVersion < SCHEMA_VERSION) {
    return { ...value, schemaVersion: SCHEMA_VERSION };
  }
  throw new UnsupportedSchemaVersionError('この保存データは新しい形式です。アプリを更新してから開いてください。');
}

function defaultName(history: DrawingHistory, savedAt: string) {
  const templateKind = history.present.template;
  const template = templateKind === 'manga' || templateKind === '4koma'
    ? 'まんが'
    : templateKind === 'diary'
      ? 'えにっき'
      : templateKind === 'line-sticker'
        ? 'LINEスタンプ'
        : 'まっしろ';
  const date = new Date(savedAt);
  const stamp = Number.isNaN(date.getTime())
    ? ''
    : ` ${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  return `${template}${stamp}`;
}

function normalizeName(name: string | undefined, history: DrawingHistory, savedAt: string) {
  const trimmed = name?.trim();
  return trimmed || defaultName(history, savedAt);
}

function createThumbnail(history: DrawingHistory): string | undefined {
  if (typeof document === 'undefined') return undefined;
  const drawing = history.present;
  const scale = Math.min(THUMBNAIL_MAX_WIDTH / drawing.width, THUMBNAIL_MAX_HEIGHT / drawing.height, 1);
  const width = Math.max(1, Math.round(drawing.width * scale));
  const height = Math.max(1, Math.round(drawing.height * scale));
  const source = document.createElement('canvas');
  source.width = drawing.width;
  source.height = drawing.height;
  const sourceCtx = source.getContext('2d');
  if (!sourceCtx) return undefined;
  // { prune: false }: this renders `drawing` (one saved session's document),
  // which is not necessarily the document currently live in the editor (see
  // listDrawingSessions()'s thumbnail-backfill loop, which can run this for
  // *other* sessions). Pruning renderer.ts's shared decode cache against
  // this document alone could evict a src the live editor is still
  // mid-decode on. See renderDocument's own comment on `options.prune`.
  renderDocument(sourceCtx, drawing, null, null, { prune: false });

  const preview = document.createElement('canvas');
  preview.width = width;
  preview.height = height;
  const previewCtx = preview.getContext('2d');
  if (!previewCtx) return undefined;
  previewCtx.drawImage(source, 0, 0, width, height);
  return preview.toDataURL('image/webp', 0.72);
}

// createThumbnail() renders synchronously: if a draft-layer photo hasn't
// finished decoding yet, renderer.ts's drawImageObject skips it for *this*
// call and only schedules a redraw once decoding completes — but that
// redraw targets the canvas createThumbnail() already discarded after
// calling toDataURL() on it, so the photo would be silently missing from
// the persisted thumbnail forever (the live editor canvas is unaffected;
// it has its own redraw target — see engine/renderer.ts's per-target
// pendingRedraws). Awaiting preloadDocumentImages() first — the same guard
// utils/exportPng.ts already uses before its own renderDocument() call —
// guarantees every image is decoded before createThumbnail() rasterizes.
// Kept as a separate wrapper (rather than making createThumbnail itself
// async) because migrateLegacyCurrent() below calls the sync version from
// inside a live IndexedDB transaction, where awaiting anything before the
// next store request would let the transaction auto-close; that call site
// is safe to leave synchronous since schemaVersion-2-without-kind legacy
// documents predate the image-import feature and can never contain an
// image object.
async function createThumbnailAsync(history: DrawingHistory): Promise<string | undefined> {
  await preloadDocumentImages(history.present);
  return createThumbnail(history);
}

async function readValue<T>(db: IDBDatabase, key: IDBValidKey): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readonly');
    const request = transaction.objectStore(STORE_NAME).get(key);
    request.onsuccess = () => resolve(request.result as T | undefined);
    request.onerror = () => reject(request.error ?? new Error('保存した作品を読めませんでした'));
  });
}

async function putValue(db: IDBDatabase, key: IDBValidKey, value: unknown): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    transaction.objectStore(STORE_NAME).put(value, key);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('作品を保存できませんでした'));
    transaction.onabort = () => reject(transaction.error ?? new Error('作品を保存できませんでした'));
  });
}

async function deleteValue(db: IDBDatabase, key: IDBValidKey): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    transaction.objectStore(STORE_NAME).delete(key);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('作品を削除できませんでした'));
    transaction.onabort = () => reject(transaction.error ?? new Error('作品を削除できませんでした'));
  });
}

// Combines the two independent migrations a loaded session may need: its
// top-level schemaVersion label (upgradeSchemaVersion, structural/label-only)
// and its ImageObject.src values across every history snapshot
// (migrateImageAssetsInSession, utils/imageAssetStore.ts — rewrites a legacy
// inline data URL into a short asset: reference). Persists the result back
// to IndexedDB (so the migration — and the storage it frees — isn't redone
// on every future load) only when something actually changed; an
// already-current session round-trips through this as a no-op write-free
// read, same as before this function existed.
async function migrateSessionIfNeeded(
  db: IDBDatabase,
  key: IDBValidKey,
  rawValue: StoredDrawingSession,
): Promise<StoredDrawingSession> {
  const schemaUpgraded = upgradeSchemaVersion(rawValue); // throws if unreadable
  const { session: imagesMigrated, migrated: imagesChanged } = await migrateImageAssetsInSession(schemaUpgraded);
  if (schemaUpgraded === rawValue && !imagesChanged) return rawValue;
  await putValue(db, key, imagesMigrated);
  return imagesMigrated;
}

function migrateLegacyCurrent(db: IDBDatabase): Promise<StoredDrawingSession | null> {
  // read → copy → delete must happen in a single readwrite transaction so a
  // concurrent call (React StrictMode double-mount, a second tab) can never
  // observe the legacy record between our read and delete and migrate it a
  // second time.
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const getRequest = store.get(LEGACY_CURRENT_KEY);
    let migrated: StoredDrawingSession | null = null;

    getRequest.onsuccess = () => {
      const legacy = getRequest.result as LegacyStoredDrawingSession | undefined;
      if (!legacy) return;
      try {
        validateHistory(legacy.history);
      } catch (error) {
        transaction.abort();
        reject(error);
        return;
      }
      const id = crypto.randomUUID();
      const savedAt = legacy.savedAt || new Date().toISOString();
      migrated = {
        schemaVersion: SCHEMA_VERSION,
        id,
        name: defaultName(legacy.history, savedAt),
        savedAt,
        history: legacy.history,
        thumbnail: createThumbnail(legacy.history),
      };
      store.put(migrated, `${DRAFT_PREFIX}${id}`);
      store.delete(LEGACY_CURRENT_KEY);
    };
    getRequest.onerror = () => reject(getRequest.error ?? new Error('保存データの移行に失敗しました'));

    transaction.oncomplete = () => resolve(migrated);
    transaction.onerror = () => reject(transaction.error ?? new Error('保存データの移行に失敗しました'));
    transaction.onabort = () => reject(transaction.error ?? new Error('保存データの移行に失敗しました'));
  });
}

export async function saveDrawingSession(
  id: string,
  history: DrawingHistory,
  settings: ToolSettings,
  name?: string,
): Promise<StoredDrawingSession> {
  const db = await openDb();
  const savedAt = new Date().toISOString();
  let session: StoredDrawingSession;
  try {
    const existing = await readValue<StoredDrawingSession>(db, `${DRAFT_PREFIX}${id}`);
    session = {
      schemaVersion: SCHEMA_VERSION,
      id,
      name: normalizeName(name ?? existing?.name, history, savedAt),
      savedAt,
      history,
      settings,
      thumbnail: await createThumbnailAsync(history),
    };
    await putValue(db, `${DRAFT_PREFIX}${id}`, session);
  } finally {
    db.close();
  }
  // Runs after this session's own write has committed and its connection
  // closed (garbageCollectImageAssets opens its own via
  // utils/imageAssetStore.ts's openDb()), so this save's own newly
  // referenced assets are already visible to the mark-and-sweep scan — see
  // that function's own comment, and its grace period, for why this is safe
  // even though it also scans every *other* saved session.
  await runGarbageCollectionSafely();
  return session;
}

async function runGarbageCollectionSafely(): Promise<void> {
  try {
    await garbageCollectImageAssets();
  } catch {
    // Best-effort cleanup only — a failed GC pass must never surface as a
    // save/delete failure to the user; it just means some orphaned image
    // bytes linger until the next successful pass (saveDrawingSession,
    // deleteDrawingSession, or App.tsx's startup effect all trigger one).
  }
}

export async function renameDrawingSession(id: string, name: string): Promise<StoredDrawingSession | null> {
  const db = await openDb();
  try {
    const key = `${DRAFT_PREFIX}${id}`;
    const existing = await readValue<StoredDrawingSession>(db, key);
    if (!existing) return null;
    validateHistory(existing.history);
    const renamed: StoredDrawingSession = {
      ...existing,
      name: normalizeName(name, existing.history, existing.savedAt),
    };
    await putValue(db, key, renamed);
    return renamed;
  } finally {
    db.close();
  }
}

export async function listDrawingSessions(): Promise<StoredDrawingSession[]> {
  const db = await openDb();
  try {
    await migrateLegacyCurrent(db);
    const entries = await new Promise<Array<{ key: IDBValidKey; value: StoredDrawingSession }>>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const keysRequest = store.getAllKeys();
      const valuesRequest = store.getAll();
      transaction.oncomplete = () => {
        const keys = keysRequest.result;
        const values = valuesRequest.result as StoredDrawingSession[];
        resolve(keys.map((key, index) => ({ key, value: values[index] })));
      };
      transaction.onerror = () => reject(transaction.error ?? new Error('保存した作品を読めませんでした'));
    });

    const sessions = await Promise.all(
      entries
        .filter(({ key }) => typeof key === 'string' && key.startsWith(DRAFT_PREFIX))
        .map(async ({ key, value: rawValue }): Promise<StoredDrawingSession | null> => {
          validateHistory(rawValue.history);
          let value: StoredDrawingSession;
          try {
            value = await migrateSessionIfNeeded(db, key, rawValue);
          } catch (error) {
            if (error instanceof UnsupportedSchemaVersionError) {
              // This build structurally cannot read this session (saved by
              // a newer build) — rawValue is NOT a safe fallback here, since
              // returning it would list the session as if it were ordinary,
              // resumable, current-schema data, letting it be opened and
              // then autosaved back with this older build's SCHEMA_VERSION
              // (silently destroying whatever newer fields it had). Leave
              // it out of the resumable list entirely rather than either
              // crashing the whole listing or exposing it as falsely
              // readable (Codex review finding, PR #27 current-head).
              return null;
            }
            // Any other failure (most importantly a QuotaExceededError from
            // migrateImageAssetsInSession's own storeImageAsset write into
            // image-assets, which happens *before* the inline data-URL
            // copies it's replacing are freed — so migrating one session
            // temporarily needs room for both copies at once, exactly the
            // population already near quota that this whole PR targets) is
            // independent of whether rawValue itself is readable: rawValue
            // is still exactly as valid/readable as it was before this
            // attempt — upgradeSchemaVersion is label-only and
            // migrateImageAssetsInSession never mutates its input in place
            // (it always returns a new object when something changed; see
            // its own comment) — so falling back to it here is safe. This
            // session just stays visible in its old, still-working (inline
            // data URL and/or pre-upgrade schemaVersion) form, un-migrated
            // and un-persisted, and migration is simply retried the next
            // time this session loads (original Codex review finding, PR
            // #27 first round).
            value = rawValue;
          }
          return {
            ...value,
            name: normalizeName(value.name, value.history, value.savedAt),
            thumbnail: value.thumbnail ?? await createThumbnailAsync(value.history),
          };
        }),
    );
    return sessions
      .filter((session): session is StoredDrawingSession => session !== null)
      .sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  } finally {
    db.close();
  }
}

export async function loadDrawingSession(id: string): Promise<StoredDrawingSession | null> {
  const db = await openDb();
  try {
    const key = `${DRAFT_PREFIX}${id}`;
    const rawValue = await readValue<StoredDrawingSession>(db, key);
    if (!rawValue) return null;
    validateHistory(rawValue.history);
    const value = await migrateSessionIfNeeded(db, key, rawValue);
    return {
      ...value,
      name: normalizeName(value.name, value.history, value.savedAt),
      thumbnail: value.thumbnail ?? await createThumbnailAsync(value.history),
    };
  } finally {
    db.close();
  }
}

export async function deleteDrawingSession(id: string): Promise<void> {
  const db = await openDb();
  try {
    await deleteValue(db, `${DRAFT_PREFIX}${id}`);
  } finally {
    db.close();
  }
  // Deleting a whole session can orphan every image it referenced — see
  // saveDrawingSession's own call for why this runs after the connection
  // above has closed.
  await runGarbageCollectionSafely();
}
