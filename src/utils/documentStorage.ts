import type { ToolSettings } from '../domain/drawing';
import { renderDocument } from '../engine/renderer';
import type { DrawingHistory } from '../state/useDrawingDocument';

const DB_NAME = 'kids-oekaki';
const DB_VERSION = 1;
const STORE_NAME = 'drawing-sessions';
const LEGACY_CURRENT_KEY = 'current';
const DRAFT_PREFIX = 'draft:';
const SCHEMA_VERSION = 2;
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

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('保存場所を開けませんでした'));
  });
}

function validateHistory(history: DrawingHistory | undefined) {
  if (!history?.present || !Array.isArray(history.past) || !Array.isArray(history.future)) {
    throw new Error('保存データを安全に読み込めませんでした。');
  }
}

function defaultName(history: DrawingHistory, savedAt: string) {
  const template = history.present.template === '4koma' ? '4コマ' : history.present.template === 'diary' ? 'えにっき' : 'まっしろ';
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
  renderDocument(sourceCtx, drawing);

  const preview = document.createElement('canvas');
  preview.width = width;
  preview.height = height;
  const previewCtx = preview.getContext('2d');
  if (!previewCtx) return undefined;
  previewCtx.drawImage(source, 0, 0, width, height);
  return preview.toDataURL('image/webp', 0.72);
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
  try {
    const existing = await readValue<StoredDrawingSession>(db, `${DRAFT_PREFIX}${id}`);
    const session: StoredDrawingSession = {
      schemaVersion: SCHEMA_VERSION,
      id,
      name: normalizeName(name ?? existing?.name, history, savedAt),
      savedAt,
      history,
      settings,
      thumbnail: createThumbnail(history),
    };
    await putValue(db, `${DRAFT_PREFIX}${id}`, session);
    return session;
  } finally {
    db.close();
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

    return entries
      .filter(({ key }) => typeof key === 'string' && key.startsWith(DRAFT_PREFIX))
      .map(({ value }) => {
        validateHistory(value.history);
        if (value.schemaVersion !== SCHEMA_VERSION) {
          throw new Error('この保存データは新しい形式です。アプリを更新してから開いてください。');
        }
        return {
          ...value,
          name: normalizeName(value.name, value.history, value.savedAt),
          thumbnail: value.thumbnail ?? createThumbnail(value.history),
        };
      })
      .sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  } finally {
    db.close();
  }
}

export async function loadDrawingSession(id: string): Promise<StoredDrawingSession | null> {
  const db = await openDb();
  try {
    const value = await readValue<StoredDrawingSession>(db, `${DRAFT_PREFIX}${id}`);
    if (!value) return null;
    if (value.schemaVersion !== SCHEMA_VERSION) {
      throw new Error('この保存データは新しい形式です。アプリを更新してから開いてください。');
    }
    validateHistory(value.history);
    return {
      ...value,
      name: normalizeName(value.name, value.history, value.savedAt),
      thumbnail: value.thumbnail ?? createThumbnail(value.history),
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
}
