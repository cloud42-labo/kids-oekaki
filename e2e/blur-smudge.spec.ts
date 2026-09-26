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
  steps = 16,
) {
  const fromX = box.x + box.width * fromXRatio;
  const toX = box.x + box.width * toXRatio;
  await page.mouse.move(fromX, y);
  await page.mouse.down();
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

// Codexレビュー(PR #17)指摘: ライブpreview中の毎フレーム全域再計算は
// 低スペックAndroid端末で描画負荷になり得るため、preview中(ドラッグ中)
// だけ直近の点数へ絞って計算するようにした(renderer.tsのMAX_LIVE_BLUR_
// PREVIEW_POINTS)。commit(pointer-up)時は常に完全なpointsを使うため、
// 48点を大きく超える長いドラッグでも、ストロークの始点付近まで含めて
// 最終結果は正しく混色されることを確認する。
test('長いぼかしドラッグ(48点超)でも、始点付近まで含めて最終結果が正しく混色される', async ({ page }) => {
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

  await setSize(page, 60);
  await selectColor(page, '#e03131');
  await dragAcross(page, box, 0.15, 0.85, box.y + box.height * 0.47);
  await selectColor(page, '#1971c2');
  await dragAcross(page, box, 0.15, 0.85, box.y + box.height * 0.53);

  const seamRatio = 565 / dims.h;
  const seamY = box.y + box.height * seamRatio;
  await page.getByRole('button', { name: 'ぼかし' }).click();
  // 60ステップ=61点。MAX_LIVE_BLUR_PREVIEW_POINTS(48)を超える1回の
  // 連続ドラッグにする。
  await dragAcross(page, box, 0.15, 0.85, seamY, 60);

  const nearStart = await pixelAt(page, 0.17, seamRatio);
  const nearEnd = await pixelAt(page, 0.83, seamRatio);
  for (const p of [nearStart, nearEnd]) {
    expect(p.a).toBe(255);
    expect(p.r).toBeGreaterThan(80);
    expect(p.b).toBeGreaterThan(80);
    expect((p.r + p.g + p.b) / 3).toBeLessThan(220);
  }
});

// Codexレビュー(PR #17)指摘: BlurObjectにalgorithmフィールドが無いと、
// このPRより前に保存された作品(=常に旧Gaussian blurを意図している)が、
// 読み込み・再エクスポートのたびに新しいスマッジへ無断で差し替わって
// しまう。algorithmが無い(=legacy)ものは旧実装のまま、明示的に
// algorithm:'smudge'を持つものだけ新実装で描画されることを確認する。
async function seedSessionWithBlur(page: Page, algorithm: 'smudge' | undefined) {
  await page.evaluate(async (algorithm) => {
    const id = crypto.randomUUID();
    const layerId = crypto.randomUUID();
    const blurObject: Record<string, unknown> = {
      id: crypto.randomUUID(),
      type: 'blur',
      size: 200,
      strength: 15,
      points: [
        { x: 100, y: 260, pressure: 0.5 },
        { x: 700, y: 260, pressure: 0.5 },
      ],
    };
    if (algorithm) blurObject.algorithm = algorithm;
    const document = {
      width: 800,
      height: 1131,
      orientation: 'portrait',
      template: 'blank',
      activeLayerId: layerId,
      layers: [
        {
          id: layerId,
          name: 'せんが',
          visible: true,
          locked: false,
          opacity: 1,
          objects: [
            {
              id: crypto.randomUUID(),
              type: 'stroke',
              brush: 'pen',
              color: '#e03131',
              size: 300,
              points: [
                { x: 100, y: 400, pressure: 0.5 },
                { x: 700, y: 400, pressure: 0.5 },
              ],
            },
            blurObject,
          ],
        },
      ],
    };
    const history = { past: [], present: document, future: [] };
    const session = {
      schemaVersion: 2,
      id,
      name: algorithm ?? 'legacy',
      savedAt: new Date().toISOString(),
      history,
    };
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('kids-oekaki', 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('drawing-sessions')) db.createObjectStore('drawing-sessions');
      };
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction('drawing-sessions', 'readwrite');
        tx.objectStore('drawing-sessions').put(session, `draft:${id}`);
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
      request.onerror = () => reject(request.error);
    });
  }, algorithm);
}

test('algorithmフィールドが無い既存のBlurObject(保存済み作品)は旧Gaussian blurのまま描画され、新スマッジへ無断で差し替わらない', async ({ page }) => {
  await page.goto('/');
  await seedSessionWithBlur(page, undefined);
  await page.reload();
  await page.locator('.saved-work-open').first().click();
  await expect(page.locator('.canvas-frame canvas')).toBeVisible();
  // 旧Gaussian blurは、ストロークの外側(元は透明=台紙)へ向けて不透明度が
  // なだらかに下がり、白っぽくフェードする。新スマッジはこの位置では
  // (ストローク本体から離れているため)ほぼ変化がないか、あってもごく
  // 狭い範囲に留まる。
  const legacyFadeZone = await pixelAt(page, 0.5, 230 / 1131);

  await page.evaluate(() => indexedDB.deleteDatabase('kids-oekaki'));
  await page.goto('/');
  await seedSessionWithBlur(page, 'smudge');
  await page.reload();
  await page.locator('.saved-work-open').first().click();
  await expect(page.locator('.canvas-frame canvas')).toBeVisible();
  const smudgeSameSpot = await pixelAt(page, 0.5, 230 / 1131);

  // 同じジオメトリでも、legacy(旧Gaussian)とsmudge(新実装)は明確に
  // 異なる結果になる=algorithmで正しく実装が切り替わっている。
  expect(legacyFadeZone.r + legacyFadeZone.g + legacyFadeZone.b).not.toBeCloseTo(
    smudgeSameSpot.r + smudgeSameSpot.g + smudgeSameSpot.b,
    -1,
  );
});
