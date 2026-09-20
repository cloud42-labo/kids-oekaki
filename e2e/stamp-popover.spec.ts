import { test, expect, type Page } from '@playwright/test';

// OEK-04-S01-REG: automated regression coverage for the stamp popover fix
// (PR #114 — details/open is closed on stamp selection; popover position is
// clamped to the viewport). Replaces the Human-only re-check that
// OEK-04-S01-REG's Approach Decision (2026-09-06) moved to AI automation.

async function startBlankDrawing(page: Page, orientation: 'たて' | 'よこ' = 'たて') {
  await page.goto('/');
  await page.getByRole('button', { name: /まっしろ/ }).click();
  await page.getByRole('button', { name: new RegExp(orientation) }).click();
  await expect(page.locator('.stamp-menu')).toBeVisible();
}

function stampMenu(page: Page) {
  return page.locator('.stamp-menu');
}

function stampSummary(page: Page) {
  return stampMenu(page).locator('summary');
}

function stampPopover(page: Page) {
  return page.locator('.stamp-popover');
}

async function openStampPopover(page: Page) {
  await stampSummary(page).click();
  await expect(stampPopover(page)).toBeVisible();
}

async function assertPopoverWithinViewport(page: Page) {
  const box = await stampPopover(page).boundingBox();
  expect(box).not.toBeNull();
  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();
  if (!box || !viewport) return;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1); // +1: sub-pixel rounding
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
}

test.describe('stamp popover', () => {
  test('① viewport内に収まる（デスクトップ既定サイズ）', async ({ page }) => {
    await startBlankDrawing(page);
    await openStampPopover(page);
    await assertPopoverWithinViewport(page);
  });

  test('② スタンプ選択直後にポップアップが閉じる', async ({ page }) => {
    await startBlankDrawing(page);
    await openStampPopover(page);

    await page.getByRole('button', { name: 'ハート' }).click();

    await expect(stampMenu(page)).not.toHaveJSProperty('open', true);
    await expect(stampPopover(page)).toBeHidden();
  });

  test('③ キャンバスへ配置した後もポップアップは残留しない', async ({ page }) => {
    await startBlankDrawing(page);
    await openStampPopover(page);
    await page.getByRole('button', { name: '星' }).click();
    await expect(stampPopover(page)).toBeHidden();

    const canvas = page.locator('canvas').first();
    const canvasBox = await canvas.boundingBox();
    expect(canvasBox).not.toBeNull();
    if (!canvasBox) return;
    await page.mouse.click(canvasBox.x + canvasBox.width / 2, canvasBox.y + canvasBox.height / 2);

    await expect(stampPopover(page)).toBeHidden();
    await expect(stampMenu(page)).not.toHaveJSProperty('open', true);
  });

  test('④ 縦向きviewportで収まる', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await startBlankDrawing(page, 'たて');
    await openStampPopover(page);
    await assertPopoverWithinViewport(page);
  });

  test('④ 横向きviewportで収まる', async ({ page }) => {
    await page.setViewportSize({ width: 844, height: 390 });
    await startBlankDrawing(page, 'よこ');
    await openStampPopover(page);
    await assertPopoverWithinViewport(page);
  });

  test('⑤ 画面端（狭幅viewport）でも収まる', async ({ page }) => {
    // Toolbar buttons compress at narrow widths (see creative-ui.css media
    // queries); the stamp button ends up close to the viewport edge.
    await page.setViewportSize({ width: 320, height: 640 });
    await startBlankDrawing(page);
    await openStampPopover(page);
    await assertPopoverWithinViewport(page);
  });

  test('⑥ ツールバーを横スクロールした後も位置がずれない', async ({ page }) => {
    // Narrow viewport so the toolbar (many compact-tool buttons) overflows
    // horizontally (.toolbar has overflow-x: auto from styles.css).
    await page.setViewportSize({ width: 360, height: 700 });
    await startBlankDrawing(page);

    const toolbar = page.locator('header.toolbar');
    await toolbar.evaluate((el) => { el.scrollLeft = el.scrollWidth; });
    await expect.poll(async () => toolbar.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);

    await openStampPopover(page);
    await assertPopoverWithinViewport(page);
  });
});
