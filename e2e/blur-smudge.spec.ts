import { test, expect, type Page } from '@playwright/test';

// OEK-05-S04-BUG03: 「ぼかし」は同一レイヤーの不透明画素の色だけを混ぜる
// スマッジであり、不透明度を下げて白い台紙を透かすGaussian blurではない
// ことを確認する。赤と青の境界をなぞると両方の色味を持つ中間色(紫系)が
// 生まれ、白っぽく薄まらないことをpixelレベルで検証する。

async function pixelAt(page: Page, xRatio: number, yRatio: number) {
  return page.evaluate(
    ({ xRatio, yRatio }) => {
      const canvas = document.querySelector('.canvas-frame canvas') as HTMLCanvasElement;
      const ctx = canvas.getContext('2d')!;
      const x = Math.round(canvas.width * xRatio);
      const y = Math.round(canvas.height * yRatio);
      const data = ctx.getImageData(x, y, 1, 1).data;
      return { r: data[0], g: data[1], b: data[2], a: data[3] };
    },
    { xRatio, yRatio },
  );
}

async function setSize(page: Page, value: number) {
  await page.locator('.compact-size-control input[type="range"]').fill(String(value));
}

async function selectColor(page: Page, hex: string) {
  await page.getByRole('button', { name: `色 ${hex}`, exact: true }).click();
}

async function dragAcross(
  page: Page,
  box: { x: number; y: number; width: number; height: number },
  fromXRatio: number,
  toXRatio: number,
  y: number,
) {
  const fromX = box.x + box.width * fromXRatio;
  const toX = box.x + box.width * toXRatio;
  await page.mouse.move(fromX, y);
  await page.mouse.down();
  const steps = 16;
  for (let i = 1; i <= steps; i += 1) {
    await page.mouse.move(fromX + ((toX - fromX) * i) / steps, y);
  }
  await page.mouse.up();
}

test('ぼかしは赤と青の境界を混色し、白っぽく薄めない', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /まっしろ/ }).click();
  await page.getByRole('button', { name: /たて/ }).click();

  const canvas = page.locator('.canvas-frame canvas');
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  if (!box) return;
  const dims = await page.evaluate(() => {
    const c = document.querySelector('.canvas-frame canvas') as HTMLCanvasElement;
    return { w: c.width, h: c.height };
  });

  // 太い赤帯と、その少し下に太い青帯を描き、境界付近に隙間(素の台紙)を作る。
  await setSize(page, 60);
  await selectColor(page, '#e03131');
  await dragAcross(page, box, 0.15, 0.85, box.y + box.height * 0.47);

  await selectColor(page, '#1971c2');
  await dragAcross(page, box, 0.15, 0.85, box.y + box.height * 0.53);

  // 境界付近(赤帯の裾と青帯の頭の中間)。混色前は台紙のまま透けて見える。
  const seamRatio = 565 / dims.h;
  const seamBefore = await pixelAt(page, 0.5, seamRatio);
  expect(seamBefore.r).toBeGreaterThan(250);
  expect(seamBefore.g).toBeGreaterThan(250);
  expect(seamBefore.b).toBeGreaterThan(250);

  await page.getByRole('button', { name: 'ぼかし' }).click();
  const seamY = box.y + box.height * seamRatio;
  for (let i = 0; i < 3; i += 1) {
    await dragAcross(page, box, 0.15, 0.85, seamY);
  }

  const seam = await pixelAt(page, 0.5, seamRatio);
  // 完全に不透明で、赤・青どちらの色味も残る中間色(紫系)になっている。
  expect(seam.a).toBe(255);
  expect(seam.r).toBeGreaterThan(100);
  expect(seam.r).toBeLessThan(210);
  expect(seam.b).toBeGreaterThan(100);
  expect(seam.b).toBeLessThan(210);
  // 白っぽく(台紙色に)薄まっていないこと。
  expect((seam.r + seam.g + seam.b) / 3).toBeLessThan(200);
  // 赤+青の混色特有に、緑成分だけが際立って低いままであること
  // (単純に白へ近づいたのであればg成分も他と同程度に上がるはず)。
  expect(seam.g).toBeLessThan(seam.r);
  expect(seam.g).toBeLessThan(seam.b);

  // 境界から離れた場所の地の色はスマッジの影響を受けず、元の不透明な
  // 色のまま(=alphaが薄まって台紙が透けて見えたりしない)。
  const deepRed = await pixelAt(page, 0.5, 525 / dims.h);
  expect(deepRed.r).toBeGreaterThan(200);
  expect(deepRed.g).toBeLessThan(80);
  expect(deepRed.a).toBe(255);

  const deepBlue = await pixelAt(page, 0.5, 605 / dims.h);
  expect(deepBlue.b).toBeGreaterThan(150);
  expect(deepBlue.r).toBeLessThan(80);
  expect(deepBlue.a).toBe(255);

  // スマッジの影響範囲外(台紙のまま)は白のまま。
  const farOutside = await pixelAt(page, 0.5, 900 / dims.h);
  expect(farOutside.r).toBeGreaterThan(250);
  expect(farOutside.g).toBeGreaterThan(250);
  expect(farOutside.b).toBeGreaterThan(250);
});
