import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// OEK-05-S04-T11: ImageObject.src historically held the full
// downscaled-JPEG data URL directly, and every undo-history snapshot
// (MAX_HISTORY=60) that referenced it fully re-serialized that whole string
// into IndexedDB. These tests cover the fix (utils/imageAssetStore.ts +
// utils/documentStorage.ts's migration/GC): the image's bytes live exactly
// once in a separate 'image-assets' store, every ImageObject/history
// snapshot holds only a short reference, old inline-data-URL sessions get
// migrated on load, and orphaned assets are garbage-collected without ever
// deleting one still referenced by a live undo/redo history.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'sample-photo.png');

const DOC_WIDTH = 800;
const DOC_HEIGHT = 1131;
const RED = { r: 224, g: 49, b: 49 };

async function startBlankDrawing(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: /まっしろ/ }).click();
  await page.getByRole('button', { name: /たて/ }).click();
  await expect(page.locator('.creative-toolbar')).toBeVisible();
}

function canvasLocator(page: Page) {
  return page.locator('canvas').first();
}

async function canvasColorAt(page: Page, x: number, y: number): Promise<{ r: number; g: number; b: number }> {
  const canvas = canvasLocator(page);
  const [r, g, b] = await canvas.evaluate((element, coords) => {
    const ctx = (element as HTMLCanvasElement).getContext('2d')!;
    const data = ctx.getImageData(Math.round(coords.x), Math.round(coords.y), 1, 1).data;
    return [data[0], data[1], data[2]];
  }, { x, y });
  return { r, g, b };
}

function isCloseToColor(color: { r: number; g: number; b: number }, expected: { r: number; g: number; b: number }, tolerance = 25) {
  return Math.abs(color.r - expected.r) <= tolerance && Math.abs(color.g - expected.g) <= tolerance && Math.abs(color.b - expected.b) <= tolerance;
}

function isCloseToRed(color: { r: number; g: number; b: number }, tolerance = 25) {
  return isCloseToColor(color, RED, tolerance);
}

async function importSamplePhoto(page: Page) {
  await page.locator('input[type="file"]').setInputFiles(FIXTURE_PATH);
  await expect.poll(async () => isCloseToRed(await canvasColorAt(page, DOC_WIDTH / 2, DOC_HEIGHT / 2))).toBe(true);
}

async function docPointToScreen(page: Page, x: number, y: number) {
  const box = await canvasLocator(page).boundingBox();
  if (!box) throw new Error('canvas not visible');
  return { x: box.x + (x / DOC_WIDTH) * box.width, y: box.y + (y / DOC_HEIGHT) * box.height };
}

async function dragImage(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  const start = await docPointToScreen(page, from.x, from.y);
  const end = await docPointToScreen(page, to.x, to.y);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 8 });
  await page.mouse.up();
}

async function saveNow(page: Page) {
  await page.getByRole('button', { name: /保存/ }).click();
  await expect(page.getByRole('button', { name: /保存済/ })).toBeVisible();
}

// Reads every record of one IndexedDB object store, bypassing the app
// entirely — same pattern e2e/draft-image.spec.ts already uses for the
// 'drawing-sessions' store. No version is passed: these tests always run
// after at least one page.goto(), so the app has already opened (and
// upgraded, if needed) the database — opening with an explicit version here
// would race that upgrade (see draft-image.spec.ts and friends, all updated
// by this same PR to the same unversioned form for this exact reason).
async function readStore<T>(page: Page, storeName: string): Promise<T[]> {
  return page.evaluate((name) => new Promise<unknown[]>((resolve, reject) => {
    const request = indexedDB.open('kids-oekaki');
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction(name, 'readonly');
      const getAllReq = tx.objectStore(name).getAll();
      getAllReq.onsuccess = () => { db.close(); resolve(getAllReq.result); };
      getAllReq.onerror = () => reject(getAllReq.error ?? new Error(`failed to read ${name}`));
    };
    request.onerror = () => reject(request.error ?? new Error('failed to open db'));
  }), storeName) as Promise<T[]>;
}

// Writes a raw record directly into 'drawing-sessions', bypassing the app's
// own save path — same pattern as draft-image.spec.ts's seed helpers.
async function seedRawSession(page: Page, key: string, session: unknown) {
  await page.evaluate(({ key, session }) => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open('kids-oekaki');
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction('drawing-sessions', 'readwrite');
      tx.objectStore('drawing-sessions').put(session, key);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => reject(tx.error ?? new Error('failed to seed session'));
    };
    request.onerror = () => reject(request.error ?? new Error('failed to open db'));
  }), { key, session });
}

type ImageAssetRow = { id: string; dataUrl: string; createdAt: number };
type RawSessionRow = {
  schemaVersion: number;
  history: { past: unknown[]; present: { layers: Array<{ objects: Array<{ type: string; src?: string }> }> }; future: unknown[] };
};

function collectImageSrcs(row: RawSessionRow): string[] {
  const srcs: string[] = [];
  const visit = (doc: unknown) => {
    const layers = (doc as { layers?: unknown })?.layers;
    if (!Array.isArray(layers)) return;
    for (const layer of layers) {
      const objects = (layer as { objects?: unknown })?.objects;
      if (!Array.isArray(objects)) continue;
      for (const object of objects) {
        if ((object as { type?: unknown })?.type === 'image') srcs.push((object as { src: string }).src);
      }
    }
  };
  row.history.past.forEach(visit);
  visit(row.history.present);
  row.history.future.forEach(visit);
  return srcs;
}

test.use({ viewport: { width: 1000, height: 1300 } });

test.describe('image asset store (OEK-05-S04-T11)', () => {
  test('① 同じ画像を何度も移動・保存しても image-assets は1件のまま複製されない（ストレージが操作回数と比例して増えない）', async ({ page }) => {
    await startBlankDrawing(page);
    await importSamplePhoto(page);
    await saveNow(page);

    const assetsAfterFirstSave = await readStore<ImageAssetRow>(page, 'image-assets');
    expect(assetsAfterFirstSave).toHaveLength(1);
    const singleAssetBytes = assetsAfterFirstSave[0].dataUrl.length;
    // The base64 payload alone (without the "data:image/jpeg;base64," head),
    // used below as the fingerprint for "the actual image bytes appear
    // somewhere" — short enough as a reference string that it could never
    // appear by coincidence, long enough that it couldn't appear by
    // coincidence either.
    const imageBase64Body = assetsAfterFirstSave[0].dataUrl.slice(assetsAfterFirstSave[0].dataUrl.indexOf(',') + 1);

    const sessionsAfterFirstSave = await readStore<unknown>(page, 'drawing-sessions');
    const sizeAfterFirstSave = JSON.stringify(sessionsAfterFirstSave).length;

    // Move the image back and forth repeatedly, saving after every move —
    // the real-world pattern the Task describes (a child dragging a photo
    // around many times). Each move only patches x/y (updateImageObject —
    // state/useDrawingDocument.ts never touches .src), so every one of
    // these pushes a new 60-capped history snapshot that reuses the same
    // short asset: reference string, never the image bytes themselves.
    const MOVES = 8;
    for (let i = 0; i < MOVES; i += 1) {
      const dx = i % 2 === 0 ? 80 : -80;
      await dragImage(
        page,
        { x: DOC_WIDTH / 2, y: DOC_HEIGHT / 2 },
        { x: DOC_WIDTH / 2 + dx, y: DOC_HEIGHT / 2 },
      );
      await saveNow(page);
    }

    const assetsAfterMoves = await readStore<ImageAssetRow>(page, 'image-assets');
    // Still exactly one row for the one distinct photo, regardless of how
    // many times it was moved and re-saved. Against the pre-fix code (src
    // itself the data URL, inlined into every snapshot), nothing here would
    // ever appear in a separate store at all — this assertion alone already
    // distinguishes "there is a dedicated asset store" from "there isn't",
    // and the next assertion below additionally proves it isn't silently
    // growing a duplicate per distinct x/y value.
    expect(assetsAfterMoves).toHaveLength(1);
    expect(assetsAfterMoves[0].id).toBe(assetsAfterFirstSave[0].id);
    expect(assetsAfterMoves[0].dataUrl.length).toBe(singleAssetBytes);

    // Measurement (Task requirement 6): the actual image bytes must not
    // appear anywhere inside 'drawing-sessions' at all, no matter how many
    // history snapshots now exist — every one of them, old and new, only
    // ever holds the short asset: reference string. This is the direct,
    // exact proof that storage isn't growing by duplicating this image's
    // bytes; a size-based threshold would only be a fuzzy proxy for the same
    // claim. Against the pre-fix code (ImageObject.src itself the data
    // URL), this base64 payload would appear once per history snapshot that
    // references the image — i.e. it'd be found here.
    const sessionsAfterMoves = await readStore<unknown>(page, 'drawing-sessions');
    const sessionsBlob = JSON.stringify(sessionsAfterMoves);
    expect(sessionsBlob.includes(imageBase64Body)).toBe(false);

    // Softer sanity check alongside the exact proof above, as evidence for
    // the Task's "no linear growth" measurement: compare the actual growth
    // from 8 additional move+save operations against what the SAME 8
    // operations would have cost under the pre-fix design, where every
    // save re-inlined a full copy of the image's data URL into the new
    // history snapshot (roughly MOVES × singleAssetBytes of pure
    // duplication, on top of the same small per-snapshot JSON overhead this
    // fix still has). Actual growth here is only that small overhead — a
    // handful of coordinate/layer/object records — a small fraction of
    // what 8 duplicated image copies would have added.
    const sizeAfterMoves = sessionsBlob.length;
    const growth = sizeAfterMoves - sizeAfterFirstSave;
    const legacyDuplicationCost = MOVES * singleAssetBytes;
    expect(growth).toBeLessThan(legacyDuplicationCost * 0.5);
  });

  test('② セッションを削除し十分な時間が経つと、どこからも参照されなくなった画像アセットだけがGCで削除される', async ({ page }) => {
    await startBlankDrawing(page);
    await importSamplePhoto(page);
    await saveNow(page);

    const assetsBefore = await readStore<ImageAssetRow>(page, 'image-assets');
    expect(assetsBefore).toHaveLength(1);
    const assetId = assetsBefore[0].id;

    // Delete the only session referencing this asset via the real UI flow
    // (documentStorage.ts's deleteDrawingSession, which runs a GC pass
    // immediately afterward) — not a raw IndexedDB delete, so the app's own
    // grace-period logic is what's under test here.
    await page.getByRole('button', { name: '開始画面へ戻る' }).click();
    page.once('dialog', (dialog) => void dialog.accept());
    await page.locator('.saved-work-delete').first().click();
    await expect(page.locator('.saved-work-row')).toHaveCount(0);

    // Immediately after deletion, the asset must NOT be gone yet — it's
    // still younger than imageAssetStore.ts's grace period
    // (DEFAULT_GC_GRACE_MS), which exists precisely so a GC pass can never
    // race a fresh import/save and delete something about to be referenced.
    const assetsRightAfterDelete = await readStore<ImageAssetRow>(page, 'image-assets');
    expect(assetsRightAfterDelete.some((a) => a.id === assetId)).toBe(true);

    // Wait past the grace period (10s in utils/imageAssetStore.ts), then
    // trigger another GC pass the same way the app always does — via an
    // ordinary save (here: a brand-new, unrelated drawing) — rather than
    // reaching into the module directly.
    await page.waitForTimeout(10_500);
    await page.locator('.template-card', { hasText: 'まっしろ' }).click();
    await page.getByRole('button', { name: /たて/ }).click();
    await saveNow(page);

    const assetsAfterGc = await readStore<ImageAssetRow>(page, 'image-assets');
    expect(assetsAfterGc.some((a) => a.id === assetId)).toBe(false);
  });

  test('③ アセットに存在しない参照(ダングリング)を持つ保存データを開いても、アプリは落ちず該当画像だけ表示されない', async ({ page }) => {
    await page.goto('/');
    const id = 'dangling-session-1';
    const layerId = 'dangling-sketch';
    await seedRawSession(page, `draft:${id}`, {
      schemaVersion: 4,
      id,
      name: 'dangling',
      savedAt: new Date().toISOString(),
      history: {
        past: [],
        future: [],
        present: {
          width: DOC_WIDTH,
          height: DOC_HEIGHT,
          orientation: 'portrait',
          template: 'blank',
          activeLayerId: layerId,
          layers: [
            {
              id: layerId,
              name: 'したがき',
              visible: true,
              locked: false,
              opacity: 1,
              kind: 'draft',
              objects: [
                {
                  id: 'dangling-image',
                  type: 'image',
                  // No matching row in 'image-assets' — this reference can
                  // never resolve. resolveImageSrc() (utils/imageAssetStore.ts)
                  // returns undefined for it, and engine/renderer.ts's
                  // getImageElement/drawImageObject must treat that like any
                  // other failed/not-ready image (skip it) rather than throw.
                  src: 'asset:0000000000000000000000000000000000000000000000000000000000000000',
                  x: 250,
                  y: 415.5,
                  width: 300,
                  height: 300,
                },
              ],
            },
          ],
        },
      },
    });
    await page.reload();

    await page.locator('.saved-work-open').first().click();
    // The app renders normally — no crash, no unhandled error overlay —
    // and simply never paints the dangling image (the canvas stays
    // background-colored where it would have been).
    await expect(page.locator('.creative-toolbar')).toBeVisible();
    await expect.poll(async () => isCloseToRed(await canvasColorAt(page, 400, 565))).toBe(false);

    // The layer panel and undo/redo still work normally — the dangling
    // reference doesn't wedge the rest of the document.
    await expect(page.locator('.layer-row', { hasText: 'したがき' })).toBeVisible();
  });

  test('④ インラインdata URLで保存された旧データ(schemaVersion 3)を開くと、image-assetsへ1回だけ移行され保存データからはdata URLが消える', async ({ page }) => {
    await page.goto('/');
    // A real, valid solid-red PNG data URL, generated in the page itself
    // (not a hand-typed base64 literal, which would be impossible to verify
    // by eye) — stands in for what every ImageObject.src looked like before
    // this change (utils/importImage.ts always produced one, inlined
    // directly).
    const legacyDataUrl = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 2;
      canvas.height = 2;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#e03131';
      ctx.fillRect(0, 0, 2, 2);
      return canvas.toDataURL('image/png');
    });
    const id = 'legacy-image-session-1';
    const layerId = 'legacy-image-sketch';
    await seedRawSession(page, `draft:${id}`, {
      schemaVersion: 3,
      id,
      name: 'legacy image',
      savedAt: new Date().toISOString(),
      history: {
        past: [],
        future: [],
        present: {
          width: DOC_WIDTH,
          height: DOC_HEIGHT,
          orientation: 'portrait',
          template: 'blank',
          activeLayerId: layerId,
          layers: [
            {
              id: layerId,
              name: 'したがき',
              visible: true,
              locked: false,
              opacity: 1,
              kind: 'draft',
              objects: [
                { id: 'legacy-image', type: 'image', src: legacyDataUrl, x: 250, y: 415.5, width: 300, height: 300 },
              ],
            },
          ],
        },
      },
    });
    await page.reload();

    // listDrawingSessions() (App.tsx's mount effect) runs the migration
    // (documentStorage.ts's migrateSessionIfNeeded) before this card is even
    // shown, so by the time the start screen is interactive the rewrite has
    // already happened.
    await page.locator('.saved-work-open').first().click();
    await expect(page.locator('.creative-toolbar')).toBeVisible();
    await expect.poll(async () => isCloseToRed(await canvasColorAt(page, 400, 565))).toBe(true);

    const assets = await readStore<ImageAssetRow>(page, 'image-assets');
    expect(assets).toHaveLength(1);
    expect(assets[0].dataUrl).toBe(legacyDataUrl);

    const sessions = await readStore<RawSessionRow>(page, 'drawing-sessions');
    const migratedRow = sessions.find((row) => row.schemaVersion === 4);
    expect(migratedRow).toBeTruthy();
    const srcs = collectImageSrcs(migratedRow!);
    expect(srcs).toHaveLength(1);
    // No longer the inline data URL — rewritten to a short asset:
    // reference, which is the whole point of the migration (shrinking what
    // IndexedDB actually stores for this session).
    expect(srcs[0]).not.toBe(legacyDataUrl);
    expect(srcs[0].startsWith('asset:')).toBe(true);
  });

  test('⑤ 画像の移動をUndo/Redoしても、アセット参照のまま正しい位置に戻る', async ({ page }) => {
    await startBlankDrawing(page);
    await importSamplePhoto(page);

    // Default box is x:[250,550] y:[415.5,715.5]. Moving its center by
    // (+120,-120) shifts it to x:[370,670] y:[295.5,595.5] — the two
    // 300x300 boxes overlap substantially, so the sample points below are
    // deliberately chosen OUTSIDE that overlap: (300,470) is inside the
    // original box only (x < 370), and (620,450) is inside the moved box
    // only (x > 550) — each unambiguously signals just one of the two
    // positions, unlike a point nearer the shared center.
    const ORIGINAL_ONLY = { x: 300, y: 470 };
    const MOVED_ONLY = { x: 620, y: 450 };

    await dragImage(page, { x: DOC_WIDTH / 2, y: DOC_HEIGHT / 2 }, { x: DOC_WIDTH / 2 + 120, y: DOC_HEIGHT / 2 - 120 });
    await expect.poll(async () => isCloseToRed(await canvasColorAt(page, ORIGINAL_ONLY.x, ORIGINAL_ONLY.y))).toBe(false);
    await expect.poll(async () => isCloseToRed(await canvasColorAt(page, MOVED_ONLY.x, MOVED_ONLY.y))).toBe(true);

    await page.getByRole('button', { name: 'ひとつ戻る' }).click();
    await expect.poll(async () => isCloseToRed(await canvasColorAt(page, ORIGINAL_ONLY.x, ORIGINAL_ONLY.y))).toBe(true);
    await expect.poll(async () => isCloseToRed(await canvasColorAt(page, MOVED_ONLY.x, MOVED_ONLY.y))).toBe(false);

    await page.getByRole('button', { name: 'やり直す' }).click();
    await expect.poll(async () => isCloseToRed(await canvasColorAt(page, MOVED_ONLY.x, MOVED_ONLY.y))).toBe(true);
    await expect.poll(async () => isCloseToRed(await canvasColorAt(page, ORIGINAL_ONLY.x, ORIGINAL_ONLY.y))).toBe(false);

    // The undo/redo round-trip above only ever rewrote x/y on the same
    // ImageObject (state/useDrawingDocument.ts's updateImageObject) — it
    // never touched .src — so this still resolves through the one asset:
    // reference created at import time, not a second copy.
    await saveNow(page);
    const assets = await readStore<ImageAssetRow>(page, 'image-assets');
    expect(assets).toHaveLength(1);
  });

  // --- Codex review findings on PR #27 (OEK-05-S04-T11), reviewed commit
  // 623290735f0bb84ac6b5b2981bd5f734e82116ce — regression coverage for all
  // three P1s below. ---

  test('⑥ 移行中に1件のアセット書き込みが失敗(例: quota超過)しても、他の保存データは一覧から消えず開ける', async ({ page }) => {
    // Overrides crypto.subtle.digest (hashContent, utils/imageAssetStore.ts's
    // storeImageAsset) to fail for exactly one legacy session's inline data
    // URL — standing in for a QuotaExceededError from that session's asset
    // write during migration (documentStorage.ts's listDrawingSessions ->
    // migrateSessionIfNeeded -> migrateImageAssetsInSession). Registered via
    // addInitScript so it's active before the app's own script runs on the
    // reload below, which is when migration actually happens.
    await page.goto('/');
    const [poisonedDataUrl, okDataUrl] = await page.evaluate(() => {
      const make = (color: string) => {
        const canvas = document.createElement('canvas');
        canvas.width = 2;
        canvas.height = 2;
        const ctx = canvas.getContext('2d')!;
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, 2, 2);
        return canvas.toDataURL('image/png');
      };
      return [make('#e03131'), make('#1864ab')];
    });
    const POISONED_COLOR = { r: 224, g: 49, b: 49 }; // #e03131
    const OK_COLOR = { r: 24, g: 100, b: 171 }; // #1864ab

    await page.addInitScript((poisoned) => {
      const originalDigest = window.crypto.subtle.digest.bind(window.crypto.subtle);
      window.crypto.subtle.digest = (async (algorithm: AlgorithmIdentifier, data: BufferSource) => {
        const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array((data as ArrayBufferView).buffer, (data as ArrayBufferView).byteOffset, (data as ArrayBufferView).byteLength);
        const text = new TextDecoder().decode(bytes);
        if (text === poisoned) {
          throw new DOMException('Quota exceeded while migrating (simulated)', 'QuotaExceededError');
        }
        return originalDigest(algorithm, data);
      }) as typeof window.crypto.subtle.digest;
    }, poisonedDataUrl);

    const poisonedId = 'quota-fail-session-1';
    const poisonedLayerId = 'quota-fail-sketch';
    await seedRawSession(page, `draft:${poisonedId}`, {
      schemaVersion: 3,
      id: poisonedId,
      name: 'quota-fail',
      savedAt: new Date().toISOString(),
      history: {
        past: [],
        future: [],
        present: {
          width: DOC_WIDTH,
          height: DOC_HEIGHT,
          orientation: 'portrait',
          template: 'blank',
          activeLayerId: poisonedLayerId,
          layers: [
            {
              id: poisonedLayerId,
              name: 'したがき',
              visible: true,
              locked: false,
              opacity: 1,
              kind: 'draft',
              objects: [
                { id: 'quota-fail-image', type: 'image', src: poisonedDataUrl, x: 250, y: 415.5, width: 300, height: 300 },
              ],
            },
          ],
        },
      },
    });
    const okId = 'quota-ok-session-1';
    const okLayerId = 'quota-ok-sketch';
    await seedRawSession(page, `draft:${okId}`, {
      schemaVersion: 3,
      id: okId,
      name: 'quota-ok',
      savedAt: new Date(Date.now() - 1000).toISOString(),
      history: {
        past: [],
        future: [],
        present: {
          width: DOC_WIDTH,
          height: DOC_HEIGHT,
          orientation: 'portrait',
          template: 'blank',
          activeLayerId: okLayerId,
          layers: [
            {
              id: okLayerId,
              name: 'したがき',
              visible: true,
              locked: false,
              opacity: 1,
              kind: 'draft',
              objects: [
                { id: 'quota-ok-image', type: 'image', src: okDataUrl, x: 250, y: 415.5, width: 300, height: 300 },
              ],
            },
          ],
        },
      },
    });

    await page.reload();

    // Both sessions must still be listed — the poisoned one's migration
    // failure must not have rejected the whole listing (the exact bug this
    // finding targets: a single QuotaExceededError discarding every saved
    // session, including ones that didn't even need migration).
    await expect(page.locator('.saved-work-row')).toHaveCount(2);

    // Required fix: don't mark a session as migrated when it wasn't
    // actually migrated. Checked here, before either session is opened —
    // simply viewing a saved session makes it the active one and (via
    // App.tsx's own, pre-existing autosave-on-change effect) schedules an
    // ordinary re-save a moment later regardless of whether anything was
    // edited, which would legitimately persist the (unrelated) *current*
    // SCHEMA_VERSION over whatever was read — that later re-save is not
    // what this assertion is about, so it must run first. The poisoned
    // session's raw record must still be exactly as it was seeded
    // (schemaVersion 3, inline data URL) — not relabeled to schemaVersion 4
    // with a half-applied migration — while the unaffected one did get
    // fully migrated.
    const sessionsBeforeOpening = await readStore<RawSessionRow & { id: string }>(page, 'drawing-sessions');
    const poisonedRow = sessionsBeforeOpening.find((row) => row.id === poisonedId)!;
    expect(poisonedRow.schemaVersion).toBe(3);
    expect(collectImageSrcs(poisonedRow)[0]).toBe(poisonedDataUrl);
    const okRow = sessionsBeforeOpening.find((row) => row.id === okId)!;
    expect(okRow.schemaVersion).toBe(4);
    expect(collectImageSrcs(okRow)[0].startsWith('asset:')).toBe(true);

    // The un-migrated (poisoned) session must still be openable and still
    // render its photo correctly, through its original, un-migrated inline
    // data: URL (resolveImageSrc passes a non-asset: src through unchanged).
    await page.locator('.saved-work-row', { hasText: 'quota-fail' }).locator('.saved-work-open').click();
    await expect(page.locator('.creative-toolbar')).toBeVisible();
    await expect.poll(async () => isCloseToColor(await canvasColorAt(page, DOC_WIDTH / 2, DOC_HEIGHT / 2), POISONED_COLOR)).toBe(true);

    // Back to the start screen via reload (not the in-app "戻る" button) so
    // the schemaVersion assertions above stay about the migration step
    // itself, unaffected by the ordinary autosave this page's own open just
    // scheduled.
    await page.reload();

    // The other, unaffected session must also still be listed and openable.
    await page.locator('.saved-work-row', { hasText: 'quota-ok' }).locator('.saved-work-open').click();
    await expect(page.locator('.creative-toolbar')).toBeVisible();
    await expect.poll(async () => isCloseToColor(await canvasColorAt(page, DOC_WIDTH / 2, DOC_HEIGHT / 2), OK_COLOR)).toBe(true);
  });

  test('⑦ アセットに存在しない参照(ダングリング)を開いても、解決の再試行は無限に続かず安定する', async ({ page }) => {
    // Counts every read against the 'image-assets' store (the asset lookup
    // engine/renderer.ts's resolveImageSrc/getImageAssetDataUrl performs).
    // Registered before the app's own script runs, so it captures every
    // read from the very first render of the dangling reference onward.
    await page.addInitScript(() => {
      (window as unknown as { __assetReadCount: number }).__assetReadCount = 0;
      const originalGet = IDBObjectStore.prototype.get;
      IDBObjectStore.prototype.get = function (this: IDBObjectStore, ...args: Parameters<typeof originalGet>) {
        if (this.name === 'image-assets') {
          const w = window as unknown as { __assetReadCount: number };
          w.__assetReadCount = (w.__assetReadCount ?? 0) + 1;
        }
        return originalGet.apply(this, args);
      };
    });

    await page.goto('/');
    const id = 'dangling-loop-session-1';
    const layerId = 'dangling-loop-sketch';
    await seedRawSession(page, `draft:${id}`, {
      schemaVersion: 4,
      id,
      name: 'dangling-loop',
      savedAt: new Date().toISOString(),
      history: {
        past: [],
        future: [],
        present: {
          width: DOC_WIDTH,
          height: DOC_HEIGHT,
          orientation: 'portrait',
          template: 'blank',
          activeLayerId: layerId,
          layers: [
            {
              id: layerId,
              name: 'したがき',
              visible: true,
              locked: false,
              opacity: 1,
              kind: 'draft',
              objects: [
                {
                  id: 'dangling-loop-image',
                  type: 'image',
                  // No matching row in 'image-assets' — see test ③ above
                  // for why this can never resolve.
                  src: 'asset:1111111111111111111111111111111111111111111111111111111111111111',
                  x: 250,
                  y: 415.5,
                  width: 300,
                  height: 300,
                },
              ],
            },
          ],
        },
      },
    });
    await page.reload();

    await page.locator('.saved-work-row', { hasText: 'dangling-loop' }).locator('.saved-work-open').click();
    await expect(page.locator('.creative-toolbar')).toBeVisible();

    // Before the fix, engine/renderer.ts's getImageElement's
    // resolution-rejection handler called onReady unconditionally, which
    // re-rendered, re-encountered the same unresolved object, and created a
    // brand-new resolution request — an unbounded loop of IndexedDB reads
    // that never stops on its own. Sampling the counter at two points, a
    // couple of seconds apart, distinguishes that (still climbing) from the
    // fix (flat after the first failure).
    await page.waitForTimeout(1500);
    const countAfterSettling = await page.evaluate(() => (window as unknown as { __assetReadCount: number }).__assetReadCount ?? 0);
    expect(countAfterSettling).toBeGreaterThan(0);

    await page.waitForTimeout(2500);
    const countLater = await page.evaluate(() => (window as unknown as { __assetReadCount: number }).__assetReadCount ?? 0);
    expect(countLater).toBe(countAfterSettling);

    // Still no crash, still usable — same baseline as test ③.
    await expect(page.locator('.layer-row', { hasText: 'したがき' })).toBeVisible();
  });

  test('⑧ 取り込み直後の画像は、保存が完了する前に別タブの保存(GC)が走っても削除されない', async ({ context }) => {
    test.setTimeout(60_000);
    const pageA = await context.newPage();
    await startBlankDrawing(pageA);
    await importSamplePhoto(pageA);

    const assetsAfterImport = await readStore<ImageAssetRow>(pageA, 'image-assets');
    expect(assetsAfterImport).toHaveLength(1);
    const assetId = assetsAfterImport[0].id;

    // Keep mutating page A's in-memory document continuously — never
    // leaving the autosave debounce (1.2s — App.tsx#L153-158) a quiet gap
    // long enough to actually fire a save — for longer than the asset's
    // fixed creation-time grace period (10s — DEFAULT_GC_GRACE_MS in
    // utils/imageAssetStore.ts). This reproduces the window where the
    // freshly imported photo is referenced only by this tab's live,
    // unsaved document: nothing persisted anywhere references it yet.
    const editDeadline = Date.now() + 11_000;
    let dx = 60;
    while (Date.now() < editDeadline) {
      await dragImage(
        pageA,
        { x: DOC_WIDTH / 2, y: DOC_HEIGHT / 2 },
        { x: DOC_WIDTH / 2 + dx, y: DOC_HEIGHT / 2 },
      );
      dx = -dx;
      await pageA.waitForTimeout(500);
    }

    // From a second, independent tab (same browser profile — real
    // multi-tab use, so same IndexedDB) — save an unrelated drawing.
    // documentStorage.ts's saveDrawingSession runs a GC pass immediately
    // afterward: this is the race page A's still-unsaved photo must
    // survive.
    const pageB = await context.newPage();
    await startBlankDrawing(pageB);
    await saveNow(pageB);
    await pageB.close();

    // The asset must still exist immediately after that GC pass — before
    // the fix, it would already be gone here: unreferenced by any
    // persisted session and older than the grace period.
    const assetsAfterOtherTabGc = await readStore<ImageAssetRow>(pageA, 'image-assets');
    expect(assetsAfterOtherTabGc.some((a) => a.id === assetId)).toBe(true);

    // Now let page A's own save actually land — via the manual save button
    // (saveNow) rather than waiting on the passive autosave timer: the
    // autosave path (saveCurrent(false)) deliberately skips the
    // saveState/'保存済' UI feedback (showProgress=false — see App.tsx), so
    // it gives this test nothing observable to wait on. Which path persists
    // the reference doesn't matter for what this test is about (whether the
    // asset survived the earlier cross-tab GC race) — only that it does,
    // now, while the asset is still exactly as leaseImageAssetsInHistory
    // last left it.
    await saveNow(pageA);

    // Reload and confirm the photo is still there — try each saved-work
    // card (page B's unrelated blank drawing shares this same IndexedDB and
    // is also listed) and look for the one that actually shows the photo,
    // rather than assuming list order.
    await pageA.reload();
    const openButtons = pageA.locator('.saved-work-open');
    await expect(openButtons).toHaveCount(2);
    let foundPhoto = false;
    for (let i = 0; i < 2; i += 1) {
      await openButtons.nth(i).click();
      await expect(pageA.locator('.creative-toolbar')).toBeVisible();
      if (await isCloseToRed(await canvasColorAt(pageA, DOC_WIDTH / 2, DOC_HEIGHT / 2))) {
        foundPhoto = true;
        break;
      }
      await pageA.getByRole('button', { name: '開始画面へ戻る' }).click();
    }
    expect(foundPhoto).toBe(true);

    // And the asset itself is still there, now also properly referenced by
    // page A's own persisted session.
    const assetsAfterOwnSave = await readStore<ImageAssetRow>(pageA, 'image-assets');
    expect(assetsAfterOwnSave.some((a) => a.id === assetId)).toBe(true);
  });

  test('⑨ 未来のschemaVersionで保存されたデータは一覧に出ず、このビルドで開いて上書きされることもない', async ({ page }) => {
    // Regression test for the Codex review finding on PR #27 current-head
    // (reviewed commit 4639d41): the fix for test ⑥ above originally caught
    // *every* migrateSessionIfNeeded failure and fell back to rawValue,
    // including upgradeSchemaVersion's own rejection of a session saved by a
    // newer build than this one (schemaVersion > SCHEMA_VERSION). That made
    // such a session appear as an ordinary, resumable entry — openable, and
    // then autosaved back with this older build's SCHEMA_VERSION, silently
    // destroying whatever newer-schema fields it had. documentStorage.ts
    // must tell that case (UnsupportedSchemaVersionError) apart from a
    // retry-safe failure like a QuotaExceededError and simply leave it out
    // of the list, not expose it as falsely readable.
    await page.goto('/');
    const futureId = 'future-schema-session-1';
    const futureLayerId = 'future-schema-sketch';
    const okId = 'future-ok-session-1';
    const okLayerId = 'future-ok-sketch';
    await seedRawSession(page, `draft:${futureId}`, {
      schemaVersion: 5,
      id: futureId,
      name: 'future-schema',
      savedAt: new Date().toISOString(),
      history: {
        past: [],
        future: [],
        present: {
          width: DOC_WIDTH,
          height: DOC_HEIGHT,
          orientation: 'portrait',
          template: 'blank',
          activeLayerId: futureLayerId,
          layers: [
            { id: futureLayerId, name: 'したがき', visible: true, locked: false, opacity: 1, kind: 'draft', objects: [] },
          ],
        },
      },
    });
    await seedRawSession(page, `draft:${okId}`, {
      schemaVersion: 4,
      id: okId,
      name: 'future-ok',
      savedAt: new Date(Date.now() - 1000).toISOString(),
      history: {
        past: [],
        future: [],
        present: {
          width: DOC_WIDTH,
          height: DOC_HEIGHT,
          orientation: 'portrait',
          template: 'blank',
          activeLayerId: okLayerId,
          layers: [
            { id: okLayerId, name: 'したがき', visible: true, locked: false, opacity: 1, kind: 'draft', objects: [] },
          ],
        },
      },
    });

    await page.reload();

    // Only the readable (schemaVersion 4) session is listed — the
    // schemaVersion-5 one must not appear as if it were ordinary, openable
    // data, and must not have silently discarded the other session either.
    await expect(page.locator('.saved-work-row')).toHaveCount(1);
    await expect(page.locator('.saved-work-row')).toContainText('future-ok');

    // Its raw record on disk must be completely untouched — still
    // schemaVersion 5, not relabeled/overwritten by this build.
    const sessionsAfterListing = await readStore<RawSessionRow & { id: string }>(page, 'drawing-sessions');
    const futureRow = sessionsAfterListing.find((row) => row.id === futureId)!;
    expect(futureRow.schemaVersion).toBe(5);

    // The other session is still fully openable and usable, confirming the
    // unreadable one didn't take the whole listing down with it.
    await page.locator('.saved-work-row', { hasText: 'future-ok' }).locator('.saved-work-open').click();
    await expect(page.locator('.creative-toolbar')).toBeVisible();
  });
});
