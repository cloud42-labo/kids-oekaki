import { test, expect, type Page } from '@playwright/test';

// OEK-05-S04-T03: 起動画面にLINEスタンプモードを追加し、背景透過PNGをワンタップ
// 保存できるようにする。
//
// Owner確認(2026-09-26)の設計はあくまで「LINEスタンプモードではキャンバス背景
// そのものを描画しない」であり、「白背景を検出して透明化する」ではない。
// このテストは、そのちがいを画素レベルで区別できることまで確認する。
//
// Acceptance Criteria(このファイルが担う部分):
//  1. LINEスタンプモードでは未描画部分がalpha=0の透明としてPNG書き出しできる。
//  2. 白色で描いた線はalpha>0の不透明な白として保持される(白色一律削除ではない)。
//  3. 編集画面では透明部分を識別できる表示(チェッカーボード)を持つ。
//  4. 通常の白紙/漫画モードの背景付きPNG保存仕様(不透明)は変更されない。
//
// PNGのデコードは、canvas.toBlob()をフックしてexportPng()が生成したBlobを
// そのままページ内で捕まえ、createImageBitmapで別canvasへ描いて画素を読む。
// Node側でPNGパーサを自作する必要が無く、renderDocumentの実際の出力
// (ブラウザのPNGエンコード/デコード)をそのまま検証できる。

async function armExportedBlobCapture(page: Page) {
  await page.addInitScript(() => {
    (window as unknown as { __lastExportedBlob: Blob | null }).__lastExportedBlob = null;
    const original = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function toBlobWithCapture(
      this: HTMLCanvasElement,
      callback: BlobCallback,
      ...rest: unknown[]
    ) {
      return (original as (...args: unknown[]) => void).call(
        this,
        (blob: Blob | null) => {
          (window as unknown as { __lastExportedBlob: Blob | null }).__lastExportedBlob = blob;
          callback(blob);
        },
        ...rest,
      );
    };
  });
}

async function readExportedPixel(page: Page, xRatio: number, yRatio: number) {
  return page.evaluate(
    async ([xr, yr]) => {
      const blob = (window as unknown as { __lastExportedBlob: Blob | null }).__lastExportedBlob;
      if (!blob) throw new Error('exportPng()のtoBlob()が呼ばれていません');
      const bitmap = await createImageBitmap(blob);
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(bitmap, 0, 0);
      const x = Math.min(canvas.width - 1, Math.max(0, Math.round((xr as number) * canvas.width)));
      const y = Math.min(canvas.height - 1, Math.max(0, Math.round((yr as number) * canvas.height)));
      return Array.from(ctx.getImageData(x, y, 1, 1).data);
    },
    [xRatio, yRatio],
  );
}

async function canvasBox(page: Page) {
  const box = await page.locator('canvas').first().boundingBox();
  expect(box).not.toBeNull();
  if (!box) throw new Error('canvas not found');
  return box;
}

async function drawStroke(page: Page, xRatio: number, fromYRatio: number, toYRatio: number) {
  const box = await canvasBox(page);
  const from = { x: box.x + box.width * xRatio, y: box.y + box.height * fromYRatio };
  const to = { x: box.x + box.width * xRatio, y: box.y + box.height * toYRatio };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x, (from.y + to.y) / 2, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 4 });
  await page.mouse.up();
}

function whiteColorButton(page: Page) {
  return page.getByRole('button', { name: '色 #ffffff' });
}

async function exportPngAndWaitDownload(page: Page) {
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: /PNG/ }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^oekaki-\d{4}-\d{2}-\d{2}\.png$/);
}

test.describe('起動画面: LINEスタンプモードの選択肢', () => {
  test('白紙/まんが/LINEスタンプの3択があり、絵日記は選べない', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('button', { name: /まっしろ/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /まんが/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /LINEスタンプ/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /LINEスタンプ/ })).toBeEnabled();
    await expect(page.getByRole('button', { name: /えにっき/ })).toHaveCount(0);
  });
});

test.describe('LINEスタンプモード: 透過PNG書き出し', () => {
  test('編集画面は透明部分を識別できるチェッカーボード表示を持つ(白紙モードには出ない)', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /LINEスタンプ/ }).click();
    await page.getByRole('button', { name: /たて/ }).click();
    await expect(page.locator('.stamp-menu')).toBeVisible();
    await expect(page.locator('.canvas-frame-transparent')).toBeVisible();

    await page.goto('/');
    await page.getByRole('button', { name: /まっしろ/ }).click();
    await page.getByRole('button', { name: /たて/ }).click();
    await expect(page.locator('.stamp-menu')).toBeVisible();
    await expect(page.locator('.canvas-frame-transparent')).toHaveCount(0);
  });

  test('未描画部分はalpha=0の透明PNGとして書き出され、白色で描いた線はalpha>0の白のまま残る', async ({ page }) => {
    await armExportedBlobCapture(page);
    await page.goto('/');
    await page.getByRole('button', { name: /LINEスタンプ/ }).click();
    await page.getByRole('button', { name: /たて/ }).click();
    await expect(page.locator('.stamp-menu')).toBeVisible();

    // 既定色(黒)のままだと「白色一律削除ではないこと」を確認できないため、
    // 明示的に白を選んでから描く。
    await whiteColorButton(page).click();
    await drawStroke(page, 0.5, 0.3, 0.5);

    await exportPngAndWaitDownload(page);

    // 何も描いていない領域(左上隅寄り)は完全に透明(alpha=0)。
    const untouched = await readExportedPixel(page, 0.05, 0.05);
    expect(untouched[3]).toBe(0);

    // 白色で描いたstrokeの上の画素は、alpha>0の不透明な白として残る
    // (「白背景を透明化する」のではなく「背景そのものを描かない」実装なので、
    // 実際に描かれた白は透明化されない)。
    const drawn = await readExportedPixel(page, 0.5, 0.4);
    expect(drawn[3]).toBeGreaterThan(0);
    expect(drawn[0]).toBeGreaterThan(250);
    expect(drawn[1]).toBeGreaterThan(250);
    expect(drawn[2]).toBeGreaterThan(250);
  });

  test('通常モード（白紙）のPNG書き出しは、背景が不透明(alpha=255)なまま変わらない', async ({ page }) => {
    await armExportedBlobCapture(page);
    await page.goto('/');
    await page.getByRole('button', { name: /まっしろ/ }).click();
    await page.getByRole('button', { name: /たて/ }).click();
    await expect(page.locator('.stamp-menu')).toBeVisible();

    await exportPngAndWaitDownload(page);

    const untouched = await readExportedPixel(page, 0.5, 0.5);
    expect(untouched[3]).toBe(255);
    expect(untouched[0]).toBeGreaterThan(250);
    expect(untouched[1]).toBeGreaterThan(250);
    expect(untouched[2]).toBeGreaterThan(250);
  });

  test('通常モード（まんが=旧4koma）のPNG書き出しも、背景が不透明なまま変わらない', async ({ page }) => {
    await armExportedBlobCapture(page);
    await page.goto('/');
    await page.getByRole('button', { name: /まんが/ }).click();
    await page.getByRole('button', { name: /たて/ }).click();
    await expect(page.locator('.stamp-menu')).toBeVisible();

    await exportPngAndWaitDownload(page);

    // コマ枠の外、コマとコマの間のマージン部分(左上隅寄り)は白紙のまま不透明。
    const untouched = await readExportedPixel(page, 0.02, 0.02);
    expect(untouched[3]).toBe(255);
  });
});
