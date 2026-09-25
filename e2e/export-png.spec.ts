import { test, expect } from '@playwright/test';

// OEK-05-S03-BUG01: Android実機でPNG保存ができない不具合の修正に伴う回帰テスト。
// Capacitor.isNativePlatform()がfalseとなるWeb/PWA環境では、従来どおり
// <a download>によるブラウザのダウンロード機構でPNGが保存されることを確認する。
// ネイティブ（Android）側の保存経路（Filesystem + Share）は実機Gate対象のため
// このテストの対象外。

test('PNG保存ボタンでダウンロードが発生する（Web/PWA）', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /まっしろ/ }).click();
  await page.getByRole('button', { name: /たて/ }).click();

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: /PNG/ }).click();
  const download = await downloadPromise;

  expect(download.suggestedFilename()).toMatch(/^oekaki-\d{4}-\d{2}-\d{2}\.png$/);
});
