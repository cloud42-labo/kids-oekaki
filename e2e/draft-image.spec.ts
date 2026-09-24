import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// OEK-05-S04-T01: importing a photo/reference image into the draft layer
// ("したがき"), then repositioning/scaling/hiding/deleting it, and having it
// composite into the PNG export like any other layer content.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'sample-photo.png');
// A non-square 480x60 (8:1) flat-color fixture, used only by the resize
// aspect-ratio test below — the square fixture above can never exercise
// that bug because a square box hits IMAGE_MIN_SIZE on both sides at once.
const PANORAMA_FIXTURE_PATH = path.join(__dirname, 'fixtures', 'sample-photo-panorama.png');

// Matches createInitialDocument's portrait size (domain/drawing.ts
// CANVAS_WIDTH/CANVAS_HEIGHT) for the 'たて' (portrait) orientation used by
// every test below — the coordinate space importImage() places the photo
// in and CanvasStage's pointer handling both operate in these units,
// independent of on-screen/CSS canvas size or viewport zoom.
const DOC_WIDTH = 800;
const DOC_HEIGHT = 1131;

// The fixture is a flat #e03131 (224, 49, 49) square. JPEG re-encoding
// (utils/importImage.ts downscales+re-encodes on import) preserves a solid
// color almost exactly, so a generous tolerance still safely distinguishes
// "red" from the white canvas/template background.
const RED = { r: 224, g: 49, b: 49 };

async function startBlankDrawing(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: /まっしろ/ }).click();
  await page.getByRole('button', { name: /たて/ }).click();
  await expect(page.locator('.stamp-menu')).toBeVisible();
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

// Tolerant match — JPEG re-encoding (utils/importImage.ts) and PNG
// re-encoding of that JPEG (for the export test) both introduce a few
// levels of rounding even on a flat-color fixture.
function isCloseToRed(color: { r: number; g: number; b: number }, tolerance = 25) {
  return Math.abs(color.r - RED.r) <= tolerance && Math.abs(color.g - RED.g) <= tolerance && Math.abs(color.b - RED.b) <= tolerance;
}

// #1971c2 — used as a stand-in "existing line art" stroke color in the
// legacy-document regression test below, distinct enough from RED/white to
// assert on confidently.
const BLUE = { r: 25, g: 113, b: 194 };

function isCloseToColor(color: { r: number; g: number; b: number }, target: { r: number; g: number; b: number }, tolerance = 25) {
  return Math.abs(color.r - target.r) <= tolerance && Math.abs(color.g - target.g) <= tolerance && Math.abs(color.b - target.b) <= tolerance;
}

// Writes a StoredDrawingSession (utils/documentStorage.ts) straight into
// IndexedDB, bypassing the app's own save path entirely, so the document
// shape can be pinned to exactly what createInitialDocument produced
// *before* draft layers (kind: 'draft') existed: schemaVersion 2 (unchanged
// by this PR — kind is an optional field, not a schema bump) but no layer
// anywhere carries `kind: 'draft'`. Must run (via page.evaluate) after a
// navigation has let the app open the 'kids-oekaki' DB at least once, and a
// page.reload() afterwards is what makes App's mount-time
// listDrawingSessions() (App.tsx) actually pick the seeded row up.
async function seedLegacyDrawingSession(page: Page, id: string) {
  await page.evaluate((sessionId) => {
    const sketchId = 'legacy-sketch';
    const colorId = 'legacy-color';
    const lineId = 'legacy-line';
    const session = {
      schemaVersion: 2,
      id: sessionId,
      name: 'legacy',
      savedAt: new Date().toISOString(),
      history: {
        past: [],
        future: [],
        present: {
          width: 800,
          height: 1131,
          orientation: 'portrait',
          template: 'blank',
          // Active layer is せんが (line art), not したがき — this is what
          // makes the pre-fix fallback (activeLayerId) misplace an imported
          // photo onto the user's line art instead of the sketch layer.
          activeLayerId: lineId,
          layers: [
            { id: sketchId, name: 'したがき', visible: true, locked: false, opacity: 1, objects: [] },
            { id: colorId, name: 'いろぬり', visible: true, locked: false, opacity: 1, objects: [] },
            {
              id: lineId,
              name: 'せんが',
              visible: true,
              locked: false,
              opacity: 1,
              // Stands in for the user's real line art, to prove the fix
              // doesn't disturb it.
              objects: [
                {
                  id: 'legacy-stroke',
                  type: 'stroke',
                  brush: 'pen',
                  color: '#1971c2',
                  size: 20,
                  points: [
                    { x: 100, y: 80, pressure: 1 },
                    { x: 700, y: 80, pressure: 1 },
                  ],
                },
              ],
            },
          ],
          // Intentionally no `kind: 'draft'` on any layer above — the exact
          // shape ensureDraftLayer() (domain/drawing.ts) must migrate.
        },
      },
    };

    return new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('kids-oekaki', 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('drawing-sessions')) db.createObjectStore('drawing-sessions');
      };
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction('drawing-sessions', 'readwrite');
        tx.objectStore('drawing-sessions').put(session, `draft:${sessionId}`);
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => reject(tx.error ?? new Error('failed to seed legacy session'));
      };
      request.onerror = () => reject(request.error ?? new Error('failed to open db'));
    });
  }, id);
}

// Delays every `HTMLImageElement.src` assignment on the page by `delayMs`
// before it actually reaches the native setter (so `.complete` stays false
// and no decode/load starts until then), without changing any other Image
// behavior. Must be installed via page.addInitScript before navigation, so
// it's in place for every script the page runs, including after a reload.
//
// Real JPEG data-URL decode in Chromium is fast enough (helped along by the
// small, flat-color fixture used everywhere in this file) that a real
// reload-then-resume alone doesn't reliably land CanvasStage's mount before
// decode completes, and it's the ordering *around that race* — not decode
// speed itself — that finding 1 (P1) is about. This makes the race
// deterministic: an image resume in this window always starts out
// "not yet ready" long enough to observe whether the app notices when it
// finally becomes ready, without any other timing hack (CPU throttling still
// leaves this susceptible to flakiness, since decode completion is
// governed by the browser process, not the throttled main thread).
async function installDelayedImageDecoding(page: Page, delayMs: number) {
  await page.addInitScript((delay) => {
    const NativeImage = window.Image;
    const nativeSrcDescriptor = Object.getOwnPropertyDescriptor(NativeImage.prototype, 'src')!;
    class DelayedImage extends NativeImage {}
    Object.defineProperty(DelayedImage.prototype, 'src', {
      configurable: true,
      get() {
        return nativeSrcDescriptor.get!.call(this);
      },
      set(value: string) {
        setTimeout(() => nativeSrcDescriptor.set!.call(this, value), delay);
      },
    });
    // @ts-expect-error test-only monkeypatch of the global Image constructor
    window.Image = DelayedImage;
  }, delayMs);
}

async function importSamplePhoto(page: Page) {
  await page.locator('input[type="file"]').setInputFiles(FIXTURE_PATH);
  // importImage() sets settings.mode to 'image', which shows the selection
  // handle drawn by engine/renderer.ts's drawImageSelectionChrome.
  await expect.poll(async () => isCloseToRed(await canvasColorAt(page, DOC_WIDTH / 2, DOC_HEIGHT / 2))).toBe(true);
}

// Imports the 480x60 panorama fixture. Fit-to-80%-of-canvas math in
// App.tsx#importImage never upscales (scale is capped at 1), and 480x60 is
// well within 80% of the portrait canvas on both axes, so it lands at its
// native 480x60 size, centered: x:[160,640] y:[535.5,595.5].
async function importPanoramaPhoto(page: Page) {
  await page.locator('input[type="file"]').setInputFiles(PANORAMA_FIXTURE_PATH);
  await expect.poll(async () => isCloseToRed(await canvasColorAt(page, DOC_WIDTH / 2, 565))).toBe(true);
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

// The canvas renders at 1:1 (document pixels = CSS pixels, no downscale) at
// this doc size, so it needs a viewport tall enough that pointer drags
// anywhere on it — including near its bottom edge, e.g. the resize handle —
// land on real, visible coordinates instead of past the viewport edge.
test.use({ viewport: { width: 1000, height: 1300 } });

test.describe('draft layer image import', () => {
  test('① 画像をしたがきレイヤーへ取り込み、キャンバスに表示される', async ({ page }) => {
    await startBlankDrawing(page);
    // importSamplePhoto() already polls until the centered 300x300 photo
    // (App.tsx#importImage's fit-to-80% math never upscales a 300x300
    // fixture) is painted, i.e. AC "select and import as a draft layer".
    await importSamplePhoto(page);

    // Landed in the したがき layer specifically (kind: 'draft'), and that
    // layer became active — same layer the app pre-creates for tracing.
    await expect(page.locator('.layer-row', { hasText: 'したがき' })).toHaveClass(/active/);
  });

  test('② ドラッグで移動できる', async ({ page }) => {
    await startBlankDrawing(page);
    await importSamplePhoto(page);

    // Drag from the image's center (far from the resize handle) to a new
    // spot; the whole 300x300 box should translate with it.
    await dragImage(page, { x: DOC_WIDTH / 2, y: DOC_HEIGHT / 2 }, { x: DOC_WIDTH / 2 + 120, y: DOC_HEIGHT / 2 - 120 });

    await expect.poll(async () => isCloseToRed(await canvasColorAt(page, 260, 425))).toBe(false); // old top-left corner, now empty
    await expect.poll(async () => isCloseToRed(await canvasColorAt(page, DOC_WIDTH / 2 + 100, DOC_HEIGHT / 2 - 100))).toBe(true); // moved-to area
  });

  test('③ ハンドルをドラッグして拡大縮小できる', async ({ page }) => {
    await startBlankDrawing(page);
    await importSamplePhoto(page);

    // Default box is x:[250,550] y:[415.5,715.5]. Drag the bottom-right
    // resize handle in to (450, 615.5): uniform scale from the fixed
    // top-left anchor shrinks it to a 200x200 box.
    await dragImage(page, { x: 550, y: 715.5 }, { x: 450, y: 615.5 });

    await expect.poll(async () => isCloseToRed(await canvasColorAt(page, 300, 470))).toBe(true); // still inside the shrunk box
    await expect.poll(async () => isCloseToRed(await canvasColorAt(page, 500, 650))).toBe(false); // was inside the original box, now outside
  });

  test('④ レイヤーの「うすく」「かくす」「けす」が画像にも効く', async ({ page }) => {
    await startBlankDrawing(page);
    await importSamplePhoto(page);

    // Same layer-level controls every other layer already has — no
    // per-object image controls were added, by design.
    await page.getByRole('button', { name: '🪶 うすく' }).click();
    const dimmed = await canvasColorAt(page, DOC_WIDTH / 2, DOC_HEIGHT / 2);
    expect(dimmed.r).toBeGreaterThan(RED.r); // blended toward the white background, so it lightens
    expect(isCloseToRed(dimmed)).toBe(false);
    await page.getByRole('button', { name: '● ふつう' }).click();
    await expect.poll(async () => isCloseToRed(await canvasColorAt(page, DOC_WIDTH / 2, DOC_HEIGHT / 2))).toBe(true);

    const draftRow = page.locator('.layer-row', { hasText: 'したがき' });
    await draftRow.getByRole('button', { name: 'かくす' }).click();
    await expect.poll(async () => isCloseToRed(await canvasColorAt(page, DOC_WIDTH / 2, DOC_HEIGHT / 2))).toBe(false);
    await draftRow.getByRole('button', { name: 'みせる' }).click();
    await expect.poll(async () => isCloseToRed(await canvasColorAt(page, DOC_WIDTH / 2, DOC_HEIGHT / 2))).toBe(true);

    await page.getByRole('button', { name: '🧹 ぜんぶけす' }).click();
    await expect.poll(async () => isCloseToRed(await canvasColorAt(page, DOC_WIDTH / 2, DOC_HEIGHT / 2))).toBe(false);
  });

  test('⑤ 保存して再開しても画像が残る', async ({ page }) => {
    await startBlankDrawing(page);
    await importSamplePhoto(page);
    await page.getByRole('button', { name: /保存/ }).click();
    await expect(page.getByRole('button', { name: /保存済/ })).toBeVisible();

    // "もどる" is the visible label but aria-label is the accessible name.
    await page.getByRole('button', { name: '開始画面へ戻る' }).click();

    // Resume the just-saved session from the start screen.
    await page.locator('.saved-work-open').first().click();

    await expect.poll(async () => isCloseToRed(await canvasColorAt(page, DOC_WIDTH / 2, DOC_HEIGHT / 2))).toBe(true);
  });

  test('⑥ PNG書き出しに画像が合成される', async ({ page }) => {
    await startBlankDrawing(page);
    await importSamplePhoto(page);

    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: /PNG/ }).click();
    const download = await downloadPromise;
    const downloadPath = await download.path();
    expect(downloadPath).not.toBeNull();
    const bytes = readFileSync(downloadPath!);
    const dataUrl = `data:image/png;base64,${bytes.toString('base64')}`;

    const [r, g, b] = await page.evaluate(async ({ dataUrl, x, y }) => {
      const img = new Image();
      img.src = dataUrl;
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      const data = ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data;
      return [data[0], data[1], data[2]];
    }, { dataUrl, x: DOC_WIDTH / 2, y: DOC_HEIGHT / 2 });

    expect(isCloseToRed({ r, g, b })).toBe(true);
  });

  // Codex review findings on PR #11 (P1/P2), fixed in a follow-up commit:
  // engine/renderer.ts's getImageElement() and CanvasStage.tsx's resize/
  // selection logic.

  test('⑦ ページを再読み込みしてから再開すると、追加操作なしに画像が表示される', async ({ page }) => {
    // Regression test for the P1 finding: preloadDocumentImages() (called
    // from continueSaved()) can start decoding a src that getImageElement()
    // has *also* already started an Image() for, in which case the old code
    // never attached a redraw ("onReady") listener to that Image at all —
    // the photo silently never appeared until some unrelated document
    // mutation forced another render. Test ⑤ above can't catch this: its
    // "戻る" → resume flow never leaves the page, so engine/renderer.ts's
    // module-level `imageElements` decode cache is already warm from the
    // initial import and every read hits the already-ready fast path. A
    // real reload clears that in-memory cache, forcing a fresh decode that
    // races CanvasStage's first mount — which is what the finding is about
    // — but real decode of this small fixture is fast enough that the race
    // isn't reliably lost without help; installDelayedImageDecoding()
    // widens it deterministically instead of relying on that timing.
    await installDelayedImageDecoding(page, 300);

    await startBlankDrawing(page);
    await importSamplePhoto(page);
    await page.getByRole('button', { name: /保存/ }).click();
    await expect(page.getByRole('button', { name: /保存済/ })).toBeVisible();

    await page.reload();
    await page.locator('.saved-work-open').first().click();

    // Resuming lands CanvasStage's mount well inside the artificial ~300ms
    // "not yet decoded" window, so this reproduces the race deterministically
    // instead of depending on real decode speed. No further clicks/edits
    // here — once the delayed decode completes, the fix must repaint on its
    // own; if this needs another interaction to paint, the fix regressed.
    // (Against the pre-fix code, this assertion times out: the image never
    // appears without an unrelated mutation forcing another render.)
    await expect.poll(async () => isCloseToRed(await canvasColorAt(page, DOC_WIDTH / 2, DOC_HEIGHT / 2))).toBe(true);
  });

  test('⑧ 横長の画像を縮小しても縦横比が保たれる', async ({ page }) => {
    // Regression test for the P2 aspect-ratio finding: dragging the resize
    // handle used to clamp width and height to IMAGE_MIN_SIZE independently,
    // distorting a non-square box's aspect ratio once one side hit the
    // floor before the other. The square sample-photo.png fixture can't
    // exercise this (both sides would hit the floor together), so this test
    // uses the 480x60 (8:1) panorama fixture instead.
    await startBlankDrawing(page);
    await importPanoramaPhoto(page);

    // Box starts at x:[160,640] y:[535.5,595.5] (see importPanoramaPhoto).
    // Drag the bottom-right handle far in, past what a naive per-axis
    // IMAGE_MIN_SIZE clamp or an unclamped raw scale would allow, forcing
    // the scale-based floor (IMAGE_MIN_SIZE / shorter side = 40/60 ≈ 0.667)
    // to dominate. That yields width 480*0.667≈320, height 60*0.667=40 —
    // still 8:1. The old independent-clamp code instead let width shrink
    // toward the raw (unfloored) request while forcing height straight to
    // 40, landing width well under 300.
    await dragImage(page, { x: 640, y: 595.5 }, { x: 170, y: 545 });

    // Inside the correctly-scaled ~320-wide box, but outside anything the
    // old distorted (much narrower) box would have produced.
    await expect.poll(async () => isCloseToRed(await canvasColorAt(page, 300, 555))).toBe(true);
    // Outside the correctly-scaled box's right edge (x≈480) — confirms the
    // fix isn't simply skipping the floor/clamp altogether.
    await expect.poll(async () => isCloseToRed(await canvasColorAt(page, 495, 555))).toBe(false);
    // Height stayed at the IMAGE_MIN_SIZE floor (40), i.e. just below the
    // box's bottom edge is background again.
    await expect.poll(async () => isCloseToRed(await canvasColorAt(page, 300, 585))).toBe(false);
  });

  test('⑨ レイヤーを「かくす」と選択がはずれ、隠れた画像はハンドルで動かせない', async ({ page }) => {
    // Regression test for the P2 selection finding: the selected-image
    // lookup used to ignore layer.visible, so hiding the したがき layer left
    // the blue outline/resize handle drawn and still draggable even though
    // the image itself was invisible and the layer said "hidden".
    await startBlankDrawing(page);
    await importSamplePhoto(page);

    // Default box (see test ③): x:[250,550] y:[415.5,715.5], handle at
    // (550, 715.5).
    const draftRow = page.locator('.layer-row', { hasText: 'したがき' });
    await draftRow.getByRole('button', { name: 'かくす' }).click();
    await expect.poll(async () => isCloseToRed(await canvasColorAt(page, 300, 470))).toBe(false);

    // Attempt the exact same handle drag test ③ uses to shrink the image.
    // With the layer hidden, this must be a no-op: no stale selection to
    // hit-test against, and findImageAt() itself already skips hidden
    // layers, so the pointer-down neither grabs the handle nor re-selects
    // anything.
    await dragImage(page, { x: 550, y: 715.5 }, { x: 450, y: 615.5 });

    await draftRow.getByRole('button', { name: 'みせる' }).click();

    // Box is exactly as it was before the drag attempt — still 300x300, not
    // shrunk to the 200x200 box test ③ produces with a real resize.
    await expect.poll(async () => isCloseToRed(await canvasColorAt(page, 300, 470))).toBe(true);
    await expect.poll(async () => isCloseToRed(await canvasColorAt(page, 500, 650))).toBe(true);
  });

  // Codex review findings on the follow-up commit (reviewed commit
  // 32d8d65a33), fixed in a second follow-up commit: domain/drawing.ts's
  // new ensureDraftLayer() migration, and engine/renderer.ts's redraw
  // coalescing / decode-cache pruning.

  test('⑩ kind:draftのない旧形式の保存データを開いて画像を取り込んでも、したがきレイヤーへ入る', async ({ page }) => {
    // Regression test for the P1 finding: every session saved before this
    // PR has no layer with kind: 'draft' at all (the field didn't exist
    // yet), so importDraftImage's `layers.find(l => l.kind === 'draft')`
    // used to find nothing and fall back to activeLayerId — here
    // deliberately seeded as せんが (the "existing line art" layer) — so an
    // imported photo's opacity/visibility/clear/delete would then also
    // apply to the user's real line art. ensureDraftLayer() must infer and
    // tag the したがき layer by name on restore so the import still lands
    // in the right place.
    await page.goto('/');
    await seedLegacyDrawingSession(page, 'legacy-session-1');
    await page.reload();

    await page.locator('.saved-work-open').first().click();
    await expect(page.locator('.stamp-menu')).toBeVisible();

    // The seeded "line art" (blue stroke on せんが) survived the restore
    // untouched.
    await expect.poll(async () => isCloseToColor(await canvasColorAt(page, 400, 80), BLUE)).toBe(true);

    await importSamplePhoto(page);

    // Landed on したがき — not on せんが, which was the active layer at
    // import time and is exactly where the pre-fix fallback would have put
    // it.
    await expect(page.locator('.layer-row', { hasText: 'したがき' })).toHaveClass(/active/);

    // Hiding せんが (the pre-existing line-art layer) must NOT hide the
    // photo — before the fix, the photo would have been appended to this
    // very layer's objects, so hiding it would have hidden the photo too.
    const lineRow = page.locator('.layer-row', { hasText: 'せんが' });
    await lineRow.getByRole('button', { name: 'かくす' }).click();
    await expect.poll(async () => isCloseToColor(await canvasColorAt(page, 400, 80), BLUE)).toBe(false); // stroke hidden
    await expect.poll(async () => isCloseToRed(await canvasColorAt(page, DOC_WIDTH / 2, DOC_HEIGHT / 2))).toBe(true); // photo unaffected
    await lineRow.getByRole('button', { name: 'みせる' }).click();

    // Hiding したがき (where the photo actually landed) DOES hide the
    // photo, and leaves the unrelated line-art layer's content untouched.
    const draftRow = page.locator('.layer-row', { hasText: 'したがき' });
    await draftRow.getByRole('button', { name: 'かくす' }).click();
    await expect.poll(async () => isCloseToRed(await canvasColorAt(page, DOC_WIDTH / 2, DOC_HEIGHT / 2))).toBe(false);
    await expect.poll(async () => isCloseToColor(await canvasColorAt(page, 400, 80), BLUE)).toBe(true);
  });

  test('⑪ 読み込み中に何度も再描画されても、デコード完了後に一度だけ正しく表示される', async ({ page }) => {
    // Regression test for the P2 redraw-coalescing finding: getImageElement
    // used to attach a fresh `load` listener on every render call made
    // while a src was still decoding, so lots of renders during a slow
    // decode (here: repeatedly toggling the layer's opacity while the
    // artificially-delayed decode is in flight) would queue up many
    // listeners that all fire synchronously once decoding finishes. This
    // can't directly observe listener count from outside the module, but it
    // does confirm the coalesced callback still fires reliably exactly
    // when needed — the fix must not trade the frame-stall away for a
    // missed redraw (the P1 regression from the *previous* review round,
    // covered by test ⑦).
    await installDelayedImageDecoding(page, 300);

    await startBlankDrawing(page);
    await importSamplePhoto(page);
    await page.getByRole('button', { name: /保存/ }).click();
    await expect(page.getByRole('button', { name: /保存済/ })).toBeVisible();

    await page.reload();
    await page.locator('.saved-work-open').first().click();

    // Force several extra renders (each one re-enters getImageElement while
    // the src is still "not yet ready") during the ~300ms decode window,
    // instead of the single render test ⑦ relies on.
    for (let i = 0; i < 5; i += 1) {
      await page.getByRole('button', { name: '🪶 うすく' }).click();
      await page.getByRole('button', { name: '● ふつう' }).click();
    }

    // Once decoding finishes, the photo must still appear on its own —
    // no further interaction here forces a redraw.
    await expect.poll(async () => isCloseToRed(await canvasColorAt(page, DOC_WIDTH / 2, DOC_HEIGHT / 2))).toBe(true);
  });

  test('⑫ 画像をけしてから別の画像を取り込んでも問題なく表示される（デコードキャッシュの破棄後の再取り込み）', async ({ page }) => {
    // Regression test for the P2 unbounded-decode-cache finding: pruneImageCache()
    // (engine/renderer.ts) now drops an image src from the module-level
    // decode cache once nothing in the current document references it any
    // more (e.g. after ぜんぶけす clears the layer it was on). Real-device
    // long-session memory behavior is a Human Gate item and isn't asserted
    // here — this instead confirms the functional side: importing a new
    // photo after the old one's cache entry was pruned still decodes and
    // displays correctly (i.e. pruning doesn't leave the renderer in a
    // broken state for the next import).
    await startBlankDrawing(page);
    await importSamplePhoto(page);
    await expect.poll(async () => isCloseToRed(await canvasColorAt(page, DOC_WIDTH / 2, DOC_HEIGHT / 2))).toBe(true);

    // したがき is active post-import (see test ①); clearing it drops the
    // ImageObject from the document, making its src unreachable and
    // eligible for pruning on the next render.
    await page.getByRole('button', { name: '🧹 ぜんぶけす' }).click();
    // pruneImageCache() runs inside renderDocument on every document
    // mutation, so by the time this poll observes the clear having taken
    // effect on screen, the old src is already unreachable from the
    // document and eligible for eviction.
    await expect.poll(async () => isCloseToRed(await canvasColorAt(page, DOC_WIDTH / 2, DOC_HEIGHT / 2))).toBe(false);

    // A different photo (non-square panorama fixture) imports and displays
    // correctly after the prune — nothing about evicting the old cache
    // entry breaks decoding a new one.
    await importPanoramaPhoto(page);
    await expect.poll(async () => isCloseToRed(await canvasColorAt(page, DOC_WIDTH / 2, 565))).toBe(true);
  });
});
