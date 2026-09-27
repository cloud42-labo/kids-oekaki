import { test, expect, type Page, type Locator } from '@playwright/test';

// OEK-05-S04-BUG02: 2026-09-26実機確認で、縦向き(portrait)ではペン太さスライダーが
// 常時操作できないことが発見された。個別ボタンの幅調整ではなく、
// portraitのツールバー情報設計を2段構成へ変更した回帰テスト。
//
//   1段目 = 描画ツール（primary-tools: ペン種類・スタンプ・ミラー）
//   2段目 = 太さ・Undo/Redo・保存・PNG・戻る
//
// landscapeは既存の1段構成（safe-area-inset対応込み）を維持する。
// e2e/safe-area.spec.tsが横持ちのinset対応そのものを検証しているため、
// ここではlandscapeが1段のままであること・回転後も必須操作がclip/横
// スクロールで隠れないことを中心に確認する。

const PORTRAIT_VIEWPORTS = [
  { width: 360, height: 780 },
  { width: 412, height: 915 },
  { width: 540, height: 960 },
  { width: 600, height: 1024 },
  { width: 700, height: 1200 },
];

async function startBlankDrawing(page: Page, orientationLabel: 'たて' | 'よこ' = 'たて') {
  await page.goto('/');
  await page.getByRole('button', { name: /まっしろ/ }).click();
  await page.getByRole('button', { name: new RegExp(orientationLabel) }).click();
  await expect(page.locator('.creative-toolbar')).toBeVisible();
}

function row2Controls(page: Page): Record<string, Locator> {
  return {
    sizeSlider: page.locator('.compact-size-control input[type="range"]'),
    undo: page.locator('.toolbar-action-undo'),
    redo: page.locator('.toolbar-action-redo'),
    save: page.locator('.toolbar-action-save'),
    png: page.locator('.toolbar-action-png'),
    back: page.locator('.toolbar-action-back'),
  };
}

async function assertReachableWithoutScroll(page: Page, locator: Locator) {
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  const viewport = page.viewportSize();
  expect(box).not.toBeNull();
  expect(viewport).not.toBeNull();
  if (!box || !viewport) return;
  // clipなし: ビューポート内に完全に収まっている(+-1pxはサブピクセル誤差許容)
  expect(box.x).toBeGreaterThanOrEqual(-1);
  expect(box.y).toBeGreaterThanOrEqual(-1);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
}

async function drawStroke(page: Page) {
  const canvasBox = await page.locator('.canvas-frame canvas').first().boundingBox();
  if (!canvasBox) throw new Error('canvas not found');
  const fromX = canvasBox.x + canvasBox.width * 0.2;
  const toX = canvasBox.x + canvasBox.width * 0.8;
  const y = canvasBox.y + canvasBox.height * 0.5;
  await page.mouse.move(fromX, y);
  await page.mouse.down();
  await page.mouse.move(toX, y);
  await page.mouse.up();
}

async function assertNoHorizontalScrollNeeded(page: Page) {
  const toolbar = page.locator('.creative-toolbar');
  const info = await toolbar.evaluate((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }));
  // 横スクロールしなくても全幅が収まっている(1pxはサブピクセル誤差許容)
  expect(info.scrollWidth).toBeLessThanOrEqual(info.clientWidth + 1);
}

test.describe('ツールバーのportrait 2段レスポンシブ化 (OEK-05-S04-BUG02)', () => {
  for (const viewport of PORTRAIT_VIEWPORTS) {
    test(`portrait ${viewport.width}px: 1段目=描画ツール／2段目=太さ・Undo/Redo・保存・PNG・戻るが横スクロール無しで操作できる`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await startBlankDrawing(page);

      const primaryBox = await page.locator('.primary-tools').boundingBox();
      const sizeControlBox = await page.locator('.compact-size-control').boundingBox();
      expect(primaryBox).not.toBeNull();
      expect(sizeControlBox).not.toBeNull();
      if (!primaryBox || !sizeControlBox) return;

      // 2段構成: 太さコントロール(2段目)は描画ツール(1段目)より下にある
      expect(sizeControlBox.y).toBeGreaterThan(primaryBox.y + primaryBox.height - 4);

      // ツールバー自体が横スクロールを要求しない(必須操作を横スクロールの奥へ
      // 追いやらない)
      await assertNoHorizontalScrollNeeded(page);

      // 1段目: 描画ツールの先頭(ペン)・末尾(ミラー)がclip/横スクロール無しで
      // 到達できる
      await assertReachableWithoutScroll(page, page.getByRole('button', { name: 'ペン' }));
      await assertReachableWithoutScroll(page, page.getByRole('button', { name: 'ミラー' }));

      // 2段目: 太さ・Undo/Redo・保存・PNG・戻るがすべてclip/横スクロール無しで
      // 到達できる
      const controls = row2Controls(page);
      for (const locator of Object.values(controls)) {
        await assertReachableWithoutScroll(page, locator);
      }

      // ペン太さスライダーは実際に操作可能(disabledでなく、値を変更できる)
      await expect(controls.sizeSlider).toBeEnabled();
      await controls.sizeSlider.fill('42');
      await expect(controls.sizeSlider).toHaveValue('42');
    });
  }

  test('portrait: 太さスライダーからのTab順が視覚順（太さ→Undo→Redo→保存→PNG→戻る）と一致する（Codexレビュー指摘 PRRT_kwDOUiR8RM6mYwYx）', async ({ page }) => {
    await page.setViewportSize({ width: 412, height: 915 });
    await startBlankDrawing(page);

    // Undo/Redoともに有効化しておく(disabledなボタンはTab順に現れないため)。
    // 2回描いてからUndoを1回押すことで、Undo(過去が残っている)・Redo(取り消し
    // 済みが1件ある)の両方をenabledにする。
    await drawStroke(page);
    await drawStroke(page);
    const controls = row2Controls(page);
    await controls.undo.click();
    await expect(controls.undo).toBeEnabled();
    await expect(controls.redo).toBeEnabled();

    await controls.sizeSlider.focus();
    await expect(controls.sizeSlider).toBeFocused();

    // DOM順（=視覚順・タブ順）どおりにUndo→Redo→保存→PNG→戻るへ進むこと。
    // 以前はCSSのorderだけで戻るを末尾へ視覚移動しており、DOM/タブ順は
    // 戻るが先頭のままだったため、ここでスライダーの次に戻るへ飛んで
    // しまっていた。
    await page.keyboard.press('Tab');
    await expect(controls.undo).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(controls.redo).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(controls.save).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(controls.png).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(controls.back).toBeFocused();
  });

  test('landscape: 現行の1段構成を維持し、safe-area対応も壊れない', async ({ page }) => {
    await page.setViewportSize({ width: 844, height: 390 });
    await startBlankDrawing(page, 'よこ');

    const primaryBox = await page.locator('.primary-tools').boundingBox();
    const sizeControlBox = await page.locator('.compact-size-control').boundingBox();
    expect(primaryBox).not.toBeNull();
    expect(sizeControlBox).not.toBeNull();
    if (!primaryBox || !sizeControlBox) return;

    // 1段構成: 描画ツールと太さコントロールが同じ行にある。align-items:centerで
    // 高さの異なる子要素ごとに数px程度ずれるため、「行が変わった」とみなす閾値
    // (ツールバー全体の高さの半分未満)より十分小さいことで判定する。
    expect(Math.abs(primaryBox.y - sizeControlBox.y)).toBeLessThanOrEqual(20);

    const controls = row2Controls(page);
    for (const locator of Object.values(controls)) {
      await assertReachableWithoutScroll(page, locator);
    }
  });

  test('縦→横→縦の回転後も、必須操作がclip/横スクロールで隠れない', async ({ page }) => {
    await page.setViewportSize({ width: 412, height: 915 });
    await startBlankDrawing(page);

    let controls = row2Controls(page);
    for (const locator of Object.values(controls)) {
      await assertReachableWithoutScroll(page, locator);
    }

    // 実機の回転をviewportサイズ変更でシミュレートする(横向きへ)
    await page.setViewportSize({ width: 844, height: 390 });
    controls = row2Controls(page);
    for (const locator of Object.values(controls)) {
      await assertReachableWithoutScroll(page, locator);
    }
    await assertNoHorizontalScrollNeeded(page);

    // 縦向きに戻す
    await page.setViewportSize({ width: 412, height: 915 });
    controls = row2Controls(page);
    for (const locator of Object.values(controls)) {
      await assertReachableWithoutScroll(page, locator);
    }
    await assertNoHorizontalScrollNeeded(page);

    // 回転を挟んでもペン太さスライダーが操作可能なまま
    await expect(controls.sizeSlider).toBeEnabled();
    await controls.sizeSlider.fill('15');
    await expect(controls.sizeSlider).toHaveValue('15');
  });
});
