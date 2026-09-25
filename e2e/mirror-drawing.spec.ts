import { test, expect, type Page } from '@playwright/test';

// OEK-05-S04-T02: 中央軸の左右対称ミラー描画モード。
// Acceptance Criteria:
//  1. ミラー描画モードONで、中央に縦のガイド線が表示される。
//  2. 左右どちらから描いても、反対側にライブでミラーされたstrokeが描かれる。
//  3. ミラー描画で生まれる2本(元/反転)のstrokeは、1回のUndoと1回のRedoで
//     まとめて消える/戻る(2回に分かれない)。
//  4. Layer / show-hide / opacity / 保存・再開と組み合わせても壊れない。
//  5. PNG書き出しには対称の絵は含まれるが、中央のガイド線そのものは含まれない。

async function startBlankDrawing(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: /まっしろ/ }).click();
  await page.getByRole('button', { name: /たて/ }).click();
  await expect(page.locator('.stamp-menu')).toBeVisible();
}

function mirrorToggle(page: Page) {
  return page.getByRole('button', { name: 'ミラー', exact: true });
}

function mirrorGuide(page: Page) {
  return page.locator('.mirror-axis-guide');
}

function undoButton(page: Page) {
  return page.getByRole('button', { name: 'ひとつ戻る' });
}

function redoButton(page: Page) {
  return page.getByRole('button', { name: 'やり直す' });
}

async function canvasBox(page: Page) {
  const box = await page.locator('canvas').first().boundingBox();
  expect(box).not.toBeNull();
  if (!box) throw new Error('canvas not found');
  return box;
}

async function toCanvasPoint(page: Page, xRatio: number, yRatio: number) {
  const box = await canvasBox(page);
  return { x: box.x + box.width * xRatio, y: box.y + box.height * yRatio };
}

// document座標(0..1の比率)でcanvasの画素を読む。renderDocumentは画面表示にも
// PNG書き出し(exportPng)にも使われる同一関数なので、画面canvasの画素を読めば
// 書き出し結果に何が含まれるかの妥当なproxyになる。
async function readPixel(page: Page, xRatio: number, yRatio: number) {
  return page.evaluate(
    ([xr, yr]) => {
      const canvas = document.querySelector('canvas') as HTMLCanvasElement;
      const ctx = canvas.getContext('2d')!;
      const x = Math.min(canvas.width - 1, Math.max(0, Math.round(xr * canvas.width)));
      const y = Math.min(canvas.height - 1, Math.max(0, Math.round(yr * canvas.height)));
      return Array.from(ctx.getImageData(x, y, 1, 1).data);
    },
    [xRatio, yRatio],
  );
}

function isDarkStroke(pixel: number[]) {
  return pixel[3] > 0 && pixel[0] < 200 && pixel[1] < 200 && pixel[2] < 200;
}

function isBlankWhite(pixel: number[]) {
  return pixel[0] > 250 && pixel[1] > 250 && pixel[2] > 250;
}

async function drawStroke(page: Page, xRatio: number, fromYRatio: number, toYRatio: number) {
  const from = await toCanvasPoint(page, xRatio, fromYRatio);
  const to = await toCanvasPoint(page, xRatio, toYRatio);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x, (from.y + to.y) / 2, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 4 });
  await page.mouse.up();
}

test.describe('ミラー描画モード', () => {
  test('① ONで中央にガイド線が表示され、OFFで消える', async ({ page }) => {
    await startBlankDrawing(page);
    await expect(mirrorGuide(page)).toBeHidden();

    await mirrorToggle(page).click();
    await expect(mirrorToggle(page)).toHaveAttribute('aria-pressed', 'true');
    await expect(mirrorGuide(page)).toBeVisible();

    await mirrorToggle(page).click();
    await expect(mirrorToggle(page)).toHaveAttribute('aria-pressed', 'false');
    await expect(mirrorGuide(page)).toBeHidden();
  });

  test('② 左側から描くと右側にミラーされ、ガイド自体は書き込まれない', async ({ page }) => {
    await startBlankDrawing(page);
    await mirrorToggle(page).click();

    await drawStroke(page, 0.2, 0.3, 0.5);

    await expect.poll(async () => isDarkStroke(await readPixel(page, 0.2, 0.4))).toBe(true);
    expect(isDarkStroke(await readPixel(page, 0.8, 0.4))).toBe(true);
    // 中心(ガイド線があるはずの列)はcanvasには何も描かれていない。
    expect(isBlankWhite(await readPixel(page, 0.5, 0.4))).toBe(true);
  });

  test('③ 右側から描くと左側にミラーされる', async ({ page }) => {
    await startBlankDrawing(page);
    await mirrorToggle(page).click();

    await drawStroke(page, 0.8, 0.3, 0.5);

    await expect.poll(async () => isDarkStroke(await readPixel(page, 0.8, 0.4))).toBe(true);
    expect(isDarkStroke(await readPixel(page, 0.2, 0.4))).toBe(true);
  });

  test('④ ミラーで生まれた2本のstrokeは1回のUndo/Redoでまとめて消える・戻る', async ({ page }) => {
    await startBlankDrawing(page);
    await mirrorToggle(page).click();
    await expect(undoButton(page)).toBeDisabled();

    await drawStroke(page, 0.2, 0.3, 0.5);
    await expect.poll(async () => isDarkStroke(await readPixel(page, 0.2, 0.4))).toBe(true);
    expect(isDarkStroke(await readPixel(page, 0.8, 0.4))).toBe(true);
    await expect(undoButton(page)).toBeEnabled();

    // Undoを1回押すだけで両方消える。
    await undoButton(page).click();
    await expect.poll(async () => isBlankWhite(await readPixel(page, 0.2, 0.4))).toBe(true);
    expect(isBlankWhite(await readPixel(page, 0.8, 0.4))).toBe(true);
    // 2本分の履歴が残っていれば、もう一度Undoできてしまうはず。
    await expect(undoButton(page)).toBeDisabled();

    await expect(redoButton(page)).toBeEnabled();
    // Redoを1回押すだけで両方戻る。
    await redoButton(page).click();
    await expect.poll(async () => isDarkStroke(await readPixel(page, 0.2, 0.4))).toBe(true);
    expect(isDarkStroke(await readPixel(page, 0.8, 0.4))).toBe(true);
    await expect(redoButton(page)).toBeDisabled();
  });

  test('⑤ ミラーOFF中は通常どおり片側にしか描かれない(既存の通常描画への回帰なし)', async ({ page }) => {
    await startBlankDrawing(page);
    await mirrorToggle(page).click();
    await mirrorToggle(page).click(); // すぐOFFに戻す

    await drawStroke(page, 0.2, 0.3, 0.5);

    await expect.poll(async () => isDarkStroke(await readPixel(page, 0.2, 0.4))).toBe(true);
    expect(isBlankWhite(await readPixel(page, 0.8, 0.4))).toBe(true);
  });

  test('⑥ レイヤーの表示切替と組み合わせても壊れない', async ({ page }) => {
    await startBlankDrawing(page);
    await mirrorToggle(page).click();
    await drawStroke(page, 0.2, 0.3, 0.5);
    await expect.poll(async () => isDarkStroke(await readPixel(page, 0.2, 0.4))).toBe(true);

    // アクティブレイヤー(せんが)を非表示にすると、ミラーで描いた2本とも消える。
    const activeLayerToggle = page.locator('.layer-row.active button').first();
    await activeLayerToggle.click();
    await expect.poll(async () => isBlankWhite(await readPixel(page, 0.2, 0.4))).toBe(true);
    expect(isBlankWhite(await readPixel(page, 0.8, 0.4))).toBe(true);

    // 再表示すると両方戻る。
    await activeLayerToggle.click();
    await expect.poll(async () => isDarkStroke(await readPixel(page, 0.2, 0.4))).toBe(true);
    expect(isDarkStroke(await readPixel(page, 0.8, 0.4))).toBe(true);
  });

  test('⑦ PNGエクスポートを実行してもクラッシュせず、ガイド線はcanvas上に焼き込まれない', async ({ page }) => {
    await startBlankDrawing(page);
    await mirrorToggle(page).click();
    await drawStroke(page, 0.2, 0.3, 0.5);
    await expect.poll(async () => isDarkStroke(await readPixel(page, 0.2, 0.4))).toBe(true);

    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: /PNG/ }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.png$/);

    // 表示用canvas(PNG書き出しと同じrenderDocumentを使う)の中心列には
    // ガイド線の色が焼き込まれていない。
    expect(isBlankWhite(await readPixel(page, 0.5, 0.2))).toBe(true);
    expect(isBlankWhite(await readPixel(page, 0.5, 0.8))).toBe(true);
  });
});
