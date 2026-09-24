import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// OEK-05-S04-T01: importing a photo/reference image into the draft layer
// ("したがき"), then repositioning/scaling/hiding/deleting it, and having it
// composite into the PNG export like any other layer content.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'sample-photo.png');

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

async function importSamplePhoto(page: Page) {
  await page.locator('input[type="file"]').setInputFiles(FIXTURE_PATH);
  // importImage() sets settings.mode to 'image', which shows the selection
  // handle drawn by engine/renderer.ts's drawImageSelectionChrome.
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
});
