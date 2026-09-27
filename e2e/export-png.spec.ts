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

// OEK-05-S04-BUG01: 下書き画像を含むPNG生成はAndroid実機で保存UI表示まで
// 数秒かかることがあり、待ち時間中の画面反応がないためPNG保存ボタンを
// 連打しやすい。処理中はボタンをdisabledにし、export/saveは1回のみ実行
// されることを確認する。テスト環境ではPNG生成そのものは一瞬で終わるため、
// canvas.toBlobを意図的に遅延させ、実機での「処理に数秒かかる」状況を
// 再現したうえで多重タップを検証する。
test('PNG保存中は連打してもエクスポートは1回だけ実行され、完了後は再実行できる', async ({ page }) => {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function toBlobWithArtificialDelay(
      this: HTMLCanvasElement,
      callback: BlobCallback,
      ...rest: unknown[]
    ) {
      setTimeout(() => (original as (...args: unknown[]) => void).call(this, callback, ...rest), 300);
    };
  });

  const downloads: string[] = [];
  page.on('download', (download) => downloads.push(download.suggestedFilename()));

  await page.goto('/');
  await page.getByRole('button', { name: /まっしろ/ }).click();
  await page.getByRole('button', { name: /たて/ }).click();

  const pngButton = page.getByRole('button', { name: /PNG|保存中/ });

  await pngButton.click();
  // 処理中はボタンがdisabledになり、連打してもクリックは通らない。
  await expect(pngButton).toBeDisabled();
  await expect(pngButton).toHaveText(/保存中/);
  await pngButton.click({ force: true }).catch(() => undefined);
  await pngButton.click({ force: true }).catch(() => undefined);

  await expect.poll(() => downloads.length).toBe(1);
  // 成功後はfinallyで処理中状態が解除され、ボタンは再度押せる。
  await expect(pngButton).toBeEnabled();
  await expect(pngButton).toHaveText(/PNG/);

  // 再実行も独立して1回だけ動く(disabledのまま固まらない)。
  await pngButton.click();
  await expect.poll(() => downloads.length).toBe(2);
  await expect(pngButton).toBeEnabled();
});

// OEK-05-S04-BUG01 Codexレビュー指摘: exportPng()の最初の一歩
// (renderDocumentでcanvasへ描く処理)は同期実行であり、下書き画像や
// 長いストロークが多い作品では体感できるほど時間がかかることがある。
// setIsExportingPng(true)の直後にそのままexportPngへ入ると、Reactが
// disabled/「保存中…」をDOMへ反映する前にその同期処理が始まってしまい、
// 処理中表示が意味をなさない。上のテストは非同期のtoBlobだけを遅延させる
// ため、この「同期区間そのものが長い」regressionを検出できない。
// ここではrenderDocumentの内部で必ず呼ばれるCanvasRenderingContext2D.
// clearRectをフックし、exportPng呼び出し直前に武装したうえで、その
// clearRectが実際に呼ばれた瞬間(=同期描画処理が始まった瞬間)の
// ボタンのdisabled状態をDOMから直接読み取って記録する。Reactの状態更新が
// この時点までにDOMへcommitされていなければdisabled===falseのまま
// 観測されるはずで、rAFで1描画フレーム分待ってからexportPngへ入る
// fixが無いと必ず失敗する(実際に確認済み)。
test('PNG保存中の同期描画処理が始まる前に、処理中表示がDOMへ反映されている', async ({ page }) => {
  await page.addInitScript(() => {
    const proto = CanvasRenderingContext2D.prototype;
    const original = proto.clearRect;
    let armed = false;
    (window as unknown as { __armExportProbe: () => void }).__armExportProbe = () => { armed = true; };
    (window as unknown as { __disabledAtBlockStart: boolean | null }).__disabledAtBlockStart = null;
    proto.clearRect = function clearRectWithProbe(this: CanvasRenderingContext2D, ...args: Parameters<typeof original>) {
      if (armed) {
        armed = false;
        const button = document.querySelector('.creative-actions .text-action:last-child') as HTMLButtonElement | null;
        (window as unknown as { __disabledAtBlockStart: boolean | null }).__disabledAtBlockStart = button ? button.disabled : null;
      }
      return original.apply(this, args);
    };
  });

  await page.goto('/');
  await page.getByRole('button', { name: /まっしろ/ }).click();
  await page.getByRole('button', { name: /たて/ }).click();

  const downloadPromise = page.waitForEvent('download');
  await page.evaluate(() => (window as unknown as { __armExportProbe: () => void }).__armExportProbe());
  await page.getByRole('button', { name: /PNG/ }).click();
  await downloadPromise;

  const disabledAtBlockStart = await page.evaluate(
    () => (window as unknown as { __disabledAtBlockStart: boolean | null }).__disabledAtBlockStart,
  );
  expect(disabledAtBlockStart).toBe(true);
});
