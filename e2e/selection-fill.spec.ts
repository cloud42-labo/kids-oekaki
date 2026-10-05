import { test, expect, type Page } from '@playwright/test';

// OEK-05-S04-T06: 投げ縄選択で囲んだ範囲だけを現在の色で塗る機能の回帰テスト。
//
// - 範囲の外は塗りの影響を受けない(受け入れ基準: 選択範囲外のピクセルは
//   絶対に変更しない)
// - 塗りはUndo/Redoの通常の履歴単位として扱われる
// - 選択はかいじょ(deselect)ボタンで取りやめられ、取りやめた後も再度
//   選択→塗りが行える
// - ドラッグ中(未確定)から境界線が見える
//
// 実機のスタイラス/タッチ入力そのものはこの環境で検証できない
// (page.mouseはpointerType:'mouse'のイベントとして送られる)。CanvasStageの
// 投げ縄選択の開始/移動/終了はpointerType('pen'/'touch'限定の分岐である
// shouldIgnorePointerのpalm-rejectionロジックを除けば)既存のペン/消しゴムと
// 同じ経路を通るため、ここではロジックそのものをmouseで検証し、実機での
// スタイラス/指操作の最終確認は別途実機QAに委ねる(リポジトリCLAUDE.mdの
// 「実機Gate」参照)。

type Box = { x: number; y: number; width: number; height: number };

async function startBlankDrawing(page: Page, orientation: 'たて' | 'よこ' = 'よこ') {
  await page.goto('/');
  await page.getByRole('button', { name: /まっしろ/ }).click();
  await page.getByRole('button', { name: new RegExp(orientation) }).click();
}

// 中央を囲む菱形の投げ縄選択を描く。waypointsは最後に呼び出し側が
// page.mouse.up()するまでは指を離さない(呼び出し側の責任)。
async function dragLasso(page: Page, box: Box, waypoints: Array<[number, number]>) {
  const toPoint = ([xRatio, yRatio]: [number, number]) => ({
    x: box.x + box.width * xRatio,
    y: box.y + box.height * yRatio,
  });
  const first = toPoint(waypoints[0]);
  await page.mouse.move(first.x, first.y);
  await page.mouse.down();
  for (const waypoint of waypoints.slice(1)) {
    const point = toPoint(waypoint);
    await page.mouse.move(point.x, point.y);
  }
}

const DIAMOND_WAYPOINTS: Array<[number, number]> = [
  [0.5, 0.2],
  [0.8, 0.5],
  [0.5, 0.8],
  [0.2, 0.5],
  [0.5, 0.2],
];

async function drawAndCommitDiamondSelection(page: Page, box: Box) {
  await dragLasso(page, box, DIAMOND_WAYPOINTS);
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

const isWhite = (p: { r: number; g: number; b: number }) => p.r > 240 && p.g > 240 && p.b > 240;
// #e03131 (QUICK_COLORSの赤)
const isFillRed = (p: { r: number; g: number; b: number }) => p.r > 190 && p.g < 110 && p.b < 110;

test('投げ縄選択で囲んだ範囲だけが塗られ、範囲外は変わらない', async ({ page }) => {
  await startBlankDrawing(page);
  const canvas = page.locator('.canvas-frame canvas');
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  if (!box) return;

  await page.getByRole('button', { name: 'せんたく' }).click();
  await page.getByRole('button', { name: '色 #e03131' }).click();

  const fillButton = page.getByRole('button', { name: 'ぬる' });
  // 選択を確定するまでは塗れない。
  await expect(fillButton).toBeDisabled();

  await drawAndCommitDiamondSelection(page, box);
  await expect(fillButton).toBeEnabled();
  await fillButton.click();

  const inside = await pixelAt(page, '.canvas-frame canvas', 0.5, 0.5);
  expect(isFillRed(inside)).toBe(true);

  // 菱形の外側(四隅)はどこも白いまま。
  const corners: Array<[number, number]> = [[0.05, 0.05], [0.95, 0.05], [0.05, 0.95], [0.95, 0.95]];
  for (const [xRatio, yRatio] of corners) {
    const outside = await pixelAt(page, '.canvas-frame canvas', xRatio, yRatio);
    expect(isWhite(outside)).toBe(true);
  }
});

test('ぬりはUndo/Redoで往復できる', async ({ page }) => {
  await startBlankDrawing(page);
  const canvas = page.locator('.canvas-frame canvas');
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  if (!box) return;

  await page.getByRole('button', { name: 'せんたく' }).click();
  await page.getByRole('button', { name: '色 #e03131' }).click();
  await drawAndCommitDiamondSelection(page, box);
  await page.getByRole('button', { name: 'ぬる' }).click();

  const afterFill = await pixelAt(page, '.canvas-frame canvas', 0.5, 0.5);
  expect(isFillRed(afterFill)).toBe(true);

  await page.locator('.toolbar-action-undo').click();
  const afterUndo = await pixelAt(page, '.canvas-frame canvas', 0.5, 0.5);
  expect(isWhite(afterUndo)).toBe(true);

  await page.locator('.toolbar-action-redo').click();
  const afterRedo = await pixelAt(page, '.canvas-frame canvas', 0.5, 0.5);
  expect(isFillRed(afterRedo)).toBe(true);
});

test('かいじょで選択を取りやめられ、取りやめた後も再選択して塗れる', async ({ page }) => {
  await startBlankDrawing(page);
  const canvas = page.locator('.canvas-frame canvas');
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  if (!box) return;

  await page.getByRole('button', { name: 'せんたく' }).click();
  const fillButton = page.getByRole('button', { name: 'ぬる' });
  const deselectButton = page.getByRole('button', { name: 'かいじょ' });

  // 選択前はどちらも押せない。
  await expect(fillButton).toBeDisabled();
  await expect(deselectButton).toBeDisabled();

  await drawAndCommitDiamondSelection(page, box);
  await expect(fillButton).toBeEnabled();
  await expect(deselectButton).toBeEnabled();

  await deselectButton.click();
  await expect(fillButton).toBeDisabled();
  await expect(deselectButton).toBeDisabled();

  // 取りやめた後でも、もう一度選択して塗れる(選択メカニズム自体は壊れていない)。
  await page.getByRole('button', { name: '色 #1971c2' }).click();
  await drawAndCommitDiamondSelection(page, box);
  await expect(fillButton).toBeEnabled();
  await fillButton.click();

  const inside = await pixelAt(page, '.canvas-frame canvas', 0.5, 0.5);
  // #1971c2 (青)
  expect(inside.b).toBeGreaterThan(150);
  expect(inside.r).toBeLessThan(110);
});

test('ドラッグ中(未確定)から選択の境界線が見える', async ({ page }) => {
  await startBlankDrawing(page);
  const canvas = page.locator('.canvas-frame canvas');
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  if (!box) return;

  await page.getByRole('button', { name: 'せんたく' }).click();

  // 投げ縄の開始点のすぐ近く(破線[10,8]の最初の実線区間内)をサンプルする。
  // 指を離す前(ドラッグ中)でも境界線オーバーレイ(#3b82f6)がキャンバス上に
  // 描かれているはず。
  const start = { x: box.x + box.width * 0.5, y: box.y + box.height * 0.2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 3, start.y);
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.3);

  const samples = await page.evaluate(
    ({ selector, startXRatio, startYRatio }) => {
      const canvas = document.querySelector(selector) as HTMLCanvasElement;
      const ctx = canvas.getContext('2d')!;
      const cx = Math.round(canvas.width * startXRatio);
      const cy = Math.round(canvas.height * startYRatio);
      const out: Array<{ r: number; g: number; b: number }> = [];
      for (let dx = -2; dx <= 2; dx += 1) {
        const data = ctx.getImageData(cx + dx, cy, 1, 1).data;
        out.push({ r: data[0], g: data[1], b: data[2] });
      }
      return out;
    },
    { selector: '.canvas-frame canvas', startXRatio: 0.5, startYRatio: 0.2 },
  );

  await page.mouse.up();

  const hasBlueOverlayPixel = samples.some((p) => p.b > 180 && p.r < 150 && p.g < 180);
  expect(hasBlueOverlayPixel).toBe(true);
});
