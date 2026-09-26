import { test, expect, type Page } from '@playwright/test';

// OEK-05-S04-T05: 描画ツールを自然画材中心に整理し、鉛筆・筆を追加、
// スタンプは新規作成できないようにする(ただし既存データの表示互換は保つ)。
//
// canvasはドキュメントの向き(既定たて=800x1131)によりデフォルトの
// デスクトップviewport(720px高)より縦に長くなり得るため、この一連の
// テストではcanvas全体がviewport内に収まるよう広めのviewportへ設定する
// (viewport外の座標へpage.mouseで操作しても実際には届かないため)。

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

async function verticalOpaqueThickness(page: Page, xRatio: number, centerYRatio: number) {
  return page.evaluate(
    ({ xRatio, centerYRatio }) => {
      const canvas = document.querySelector('.canvas-frame canvas') as HTMLCanvasElement;
      const ctx = canvas.getContext('2d')!;
      const x = Math.round(canvas.width * xRatio);
      const centerY = Math.round(canvas.height * centerYRatio);
      const range = 80;
      let count = 0;
      for (let y = Math.max(0, centerY - range); y <= Math.min(canvas.height - 1, centerY + range); y += 1) {
        const d = ctx.getImageData(x, y, 1, 1).data;
        if (d[0] < 200 || d[1] < 200 || d[2] < 200) count += 1;
      }
      return count;
    },
    { xRatio, centerYRatio },
  );
}

async function dragLine(
  page: Page,
  box: { x: number; y: number; width: number; height: number },
  fromXRatio: number,
  toXRatio: number,
  yRatio: number,
  steps = 12,
) {
  const fromX = box.x + box.width * fromXRatio;
  const toX = box.x + box.width * toXRatio;
  const y = box.y + box.height * yRatio;
  await page.mouse.move(fromX, y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i += 1) {
    await page.mouse.move(fromX + ((toX - fromX) * i) / steps, y);
  }
  await page.mouse.up();
}

test.describe('鉛筆・筆ツールの追加とスタンプ作成UIの廃止', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 1400 });
  });

  test('スタンプ作成UIはツールバーに存在せず、鉛筆・筆が選べる', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /まっしろ/ }).click();
    await page.getByRole('button', { name: /たて/ }).click();

    await expect(page.getByRole('button', { name: 'スタンプ' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '鉛筆', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '筆', exact: true })).toBeVisible();
  });

  test('鉛筆で線を引くと色が乗る', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /まっしろ/ }).click();
    await page.getByRole('button', { name: /たて/ }).click();

    const canvas = page.locator('.canvas-frame canvas');
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();
    if (!box) return;

    await page.locator('.compact-size-control input[type="range"]').fill('30');
    await page.getByRole('button', { name: '鉛筆', exact: true }).click();
    await dragLine(page, box, 0.2, 0.8, 0.3);

    const pencilPixel = await pixelAt(page, 0.5, 0.3);
    expect(pencilPixel.r).toBeLessThan(200);
    expect(pencilPixel.a).toBe(255);
  });

  test('筆は穂先へ向けて先細りになり、単なる線幅違いのブラシと区別できる', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /まっしろ/ }).click();
    await page.getByRole('button', { name: /たて/ }).click();

    const canvas = page.locator('.canvas-frame canvas');
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();
    if (!box) return;

    await page.locator('.compact-size-control input[type="range"]').fill('60');
    await page.getByRole('button', { name: '筆', exact: true }).click();
    await dragLine(page, box, 0.2, 0.8, 0.5, 40);

    const startThickness = await verticalOpaqueThickness(page, 0.21, 0.5);
    const middleThickness = await verticalOpaqueThickness(page, 0.5, 0.5);
    const endThickness = await verticalOpaqueThickness(page, 0.79, 0.5);

    // 一定幅のブラシなら始点・中央・終点の太さはほぼ同じになるはず。
    // 筆は穂先(始点・終点付近)で明確に細くなる。
    expect(middleThickness).toBeGreaterThan(startThickness * 2);
    expect(middleThickness).toBeGreaterThan(endThickness * 2);
  });

  test('既存のStampObjectを含む保存データは読み込み・表示できる(後方互換)が、新規タップではスタンプは作られない', async ({ page }) => {
    await page.goto('/');

    await page.evaluate(async () => {
      const id = crypto.randomUUID();
      const layerId = crypto.randomUUID();
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
              { id: crypto.randomUUID(), type: 'stamp', stamp: 'star', x: 400, y: 500, size: 96, color: '#f08c00' },
            ],
          },
        ],
      };
      const history = { past: [], present: document, future: [] };
      const session = {
        schemaVersion: 2,
        id,
        name: 'スタンプ互換テスト',
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
    });

    await page.reload();
    await expect(page.locator('.saved-work-open').first()).toBeVisible();
    await page.locator('.saved-work-open').first().click();

    const canvas = page.locator('.canvas-frame canvas');
    await expect(canvas).toBeVisible();

    // 星スタンプの中心付近に、オレンジ(#f08c00)由来の非白画素があること
    // (=読み込み・表示互換が保たれている)。
    const stampPixel = await pixelAt(page, 400 / 800, 500 / 1131);
    expect(stampPixel.r).toBeGreaterThan(150);
    expect(stampPixel.g).toBeLessThan(230);
    expect(stampPixel.b).toBeLessThan(150);

    // 復元後のツールバーにもスタンプ作成UIは存在しない(=保存データが
    // stamp modeを持っていても、UIから再度スタンプを作る手段はない)。
    await expect(page.getByRole('button', { name: 'スタンプ' })).toHaveCount(0);
  });
});
