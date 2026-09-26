import { test, expect, type Page } from '@playwright/test';

// OEK-05-S04-T05 Codexレビュー指摘: 鉛筆・筆を追加してツール数が9個(ペン
// 種類8+ミラー)に増えたことで、幅の狭いportrait viewportでは
// 保存/PNGボタンがビューポート外へクリップされ、.primary-toolsが
// flex:0 0 auto(伸縮しない)だったため押せなくなっていた。
// .primary-toolsだけを縮小可能・横スクロール可能にし、.creative-actions
// (もどる/戻す/やり直す/保存/PNG)は常に画面内に収まることを確認する。

async function startBlankDrawing(page: Page, orientation: 'たて' | 'よこ' = 'たて') {
  await page.goto('/');
  await page.getByRole('button', { name: /まっしろ/ }).click();
  await page.getByRole('button', { name: new RegExp(orientation) }).click();
}

test.describe('狭幅viewportでも保存/PNGボタンが常に押せる', () => {
  for (const width of [320, 360, 390, 480, 540, 600, 650]) {
    test(`portrait ${width}px幅で保存/PNGボタンがビューポート内に収まる`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await startBlankDrawing(page, 'たて');
      const pngButton = page.locator('.creative-actions .text-action').last();
      const box = await pngButton.boundingBox();
      expect(box).not.toBeNull();
      if (!box) return;
      expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
      await expect(pngButton).toBeInViewport();
    });
  }

  test('landscape 844x390でも保存/PNGボタンがビューポート内に収まる', async ({ page }) => {
    await page.setViewportSize({ width: 844, height: 390 });
    await startBlankDrawing(page, 'よこ');
    const pngButton = page.locator('.creative-actions .text-action').last();
    const box = await pngButton.boundingBox();
    expect(box).not.toBeNull();
    if (!box) return;
    expect(box.x + box.width).toBeLessThanOrEqual(845);
  });

  test('幅が足りない場合、primary-toolsを横スクロールしてミラーボタンまで到達・操作できる', async ({ page }) => {
    await page.setViewportSize({ width: 480, height: 900 });
    await startBlankDrawing(page, 'たて');
    const primaryTools = page.locator('.primary-tools');
    await primaryTools.evaluate((el) => { el.scrollLeft = el.scrollWidth; });
    const mirrorButton = page.getByTitle('ミラーがき');
    await expect(mirrorButton).toBeInViewport();
    await mirrorButton.click();
    await expect(mirrorButton).toHaveAttribute('aria-pressed', 'true');
  });
});
