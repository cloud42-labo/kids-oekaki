import { test, expect, type Page } from '@playwright/test';

// OEK-05-S03-BUG03: ペン入力のレイテンシ改善のため、高速パス（RAFバッチ処理に
// よるインクリメンタル描画）を'eraser'ブラシにも拡張した。低速パス（全体を
// 1回で再描画）と同じ最終結果になることをピクセルレベルで回帰確認する。

async function drawLine(page: Page, canvasBox: { x: number; y: number; width: number; height: number }, fromXRatio: number, toXRatio: number, yRatio: number) {
  const fromX = canvasBox.x + canvasBox.width * fromXRatio;
  const toX = canvasBox.x + canvasBox.width * toXRatio;
  const y = canvasBox.y + canvasBox.height * yRatio;
  await page.mouse.move(fromX, y);
  await page.mouse.down();
  const steps = 10;
  for (let i = 1; i <= steps; i += 1) {
    const x = fromX + ((toX - fromX) * i) / steps;
    await page.mouse.move(x, y);
  }
  await page.mouse.up();
}

async function pixelAt(page: Page, canvasSelector: string, xRatio: number, yRatio: number) {
  return page.evaluate(
    ({ selector, xRatio, yRatio }) => {
      const canvas = document.querySelector(selector) as HTMLCanvasElement;
      const ctx = canvas.getContext('2d')!;
      const x = Math.round(canvas.width * xRatio);
      const y = Math.round(canvas.height * yRatio);
      const data = ctx.getImageData(x, y, 1, 1).data;
      return { r: data[0], g: data[1], b: data[2], a: data[3] };
    },
    { selector: canvasSelector, xRatio, yRatio },
  );
}

test('ペンで線を引いたあと消しゴム（高速パス）で消した部分だけ白に戻る', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /まっしろ/ }).click();
  await page.getByRole('button', { name: /よこ/ }).click();

  const canvas = page.locator('.canvas-frame canvas');
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  if (!box) return;

  // 既定はペンブラシ（#111111）。横一直線を引く。
  await drawLine(page, box, 0.1, 0.9, 0.5);

  const beforeErase = await pixelAt(page, '.canvas-frame canvas', 0.5, 0.5);
  // ペンの色(#111111)が乗っているはず（白 255,255,255 ではない）。
  expect(beforeErase.r).toBeLessThan(200);

  // 消しゴムへ切り替え、中央付近だけ消す。
  await page.getByRole('button', { name: '消しゴム' }).click();
  await drawLine(page, box, 0.45, 0.55, 0.5);

  const afterEraseCenter = await pixelAt(page, '.canvas-frame canvas', 0.5, 0.5);
  const afterEraseLeft = await pixelAt(page, '.canvas-frame canvas', 0.15, 0.5);
  const afterEraseRight = await pixelAt(page, '.canvas-frame canvas', 0.85, 0.5);

  // 消した中央は白（背景）に戻っている。
  expect(afterEraseCenter.r).toBeGreaterThan(240);
  expect(afterEraseCenter.g).toBeGreaterThan(240);
  expect(afterEraseCenter.b).toBeGreaterThan(240);

  // 消していない左右はペンの色のまま残っている。
  expect(afterEraseLeft.r).toBeLessThan(200);
  expect(afterEraseRight.r).toBeLessThan(200);
});
