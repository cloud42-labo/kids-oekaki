import { test, expect, type Page } from '@playwright/test';
import { CANVAS_HEIGHT, CANVAS_WIDTH } from '../src/domain/drawing';

// portrait(たて)の作品用紙(800x1131)がデスクトップ既定ビューポート(720px高)より
// 縦に長いのはmanga-presets.spec.tsと同じ事情。この用紙全体がviewportへ収まる
// 高さを確保する。
test.use({ viewport: { width: 900, height: 1300 } });

// Codexレビュー指摘(P1, comment_id 4114080719): OEK-05-S04-T04以前に保存された
// template === '4koma' の旧作品は、当時のfixed-50pxジオメトリ(margin=50,
// boxHeight=(height-margin*5)/4)でコマ枠を描いていた。このPRでdrawTemplateへ
// 追加された比率ベースのdrawPanelFrames/'grid-4'プリセットへ乗せ換えると、
// 外枠マージンやコマ間隔が変わり、すでに描かれ保存済みのstrokeとコマ枠の
// 位置がズレる。'4koma'は新規作成では選べない後方互換専用の値なので、
// 常にOLDの固定pxジオメトリで描き続けなければならない
// (src/domain/templates.tsのコメント参照)。
//
// このテストは、旧スキーマ(schemaVersion: 2, template: '4koma')の保存データを
// IndexedDBへ直接書き込み(documentStorage.tsが実際に使う"kids-oekaki"DB /
// "drawing-sessions"ストア / "draft:"キー接頭辞と同じ形)、「つづきから」で
// 再読込したときに描かれるコマ枠が、新しい比率ベースの'grid-4'ではなく
// 旧来のfixed-50pxジオメトリのy座標と一致することを、実際のcanvas画素で検証する。

const DB_NAME = 'kids-oekaki';
const DB_VERSION = 1;
const STORE_NAME = 'drawing-sessions';
const DRAFT_PREFIX = 'draft:';
const SCHEMA_VERSION = 2;

type SeedResult = { id: string; name: string };

async function seedLegacy4KomaSession(page: Page): Promise<SeedResult> {
  return page.evaluate(
    ({ dbName, dbVersion, storeName, draftPrefix, schemaVersion, width, height }) => {
      return new Promise<{ id: string; name: string }>((resolve, reject) => {
        const openRequest = indexedDB.open(dbName, dbVersion);
        openRequest.onupgradeneeded = () => {
          const db = openRequest.result;
          if (!db.objectStoreNames.contains(storeName)) db.createObjectStore(storeName);
        };
        openRequest.onsuccess = () => {
          const db = openRequest.result;
          const id = crypto.randomUUID();
          const sketchId = crypto.randomUUID();
          const colorId = crypto.randomUUID();
          const lineId = crypto.randomUUID();
          const session = {
            schemaVersion,
            id,
            name: '旧4コマ作品',
            savedAt: new Date().toISOString(),
            history: {
              past: [],
              future: [],
              present: {
                width,
                height,
                orientation: 'portrait',
                template: '4koma',
                activeLayerId: lineId,
                layers: [
                  { id: sketchId, name: 'したがき', visible: true, locked: false, opacity: 1, objects: [] },
                  { id: colorId, name: 'いろぬり', visible: true, locked: false, opacity: 1, objects: [] },
                  { id: lineId, name: 'せんが', visible: true, locked: false, opacity: 1, objects: [] },
                ],
              },
            },
          };
          const transaction = db.transaction(storeName, 'readwrite');
          transaction.objectStore(storeName).put(session, `${draftPrefix}${id}`);
          transaction.oncomplete = () => {
            db.close();
            resolve({ id, name: session.name });
          };
          transaction.onerror = () => reject(transaction.error ?? new Error('seed failed'));
        };
        openRequest.onerror = () => reject(openRequest.error ?? new Error('open failed'));
      });
    },
    { dbName: DB_NAME, dbVersion: DB_VERSION, storeName: STORE_NAME, draftPrefix: DRAFT_PREFIX, schemaVersion: SCHEMA_VERSION, width: CANVAS_WIDTH, height: CANVAS_HEIGHT },
  );
}

async function readPixel(page: Page, x: number, y: number) {
  return page.evaluate(
    ([px, py]) => {
      const canvas = document.querySelector('canvas') as HTMLCanvasElement;
      const ctx = canvas.getContext('2d')!;
      return Array.from(ctx.getImageData(Math.round(px), Math.round(py), 1, 1).data);
    },
    [x, y],
  );
}

function isDarkLine(pixel: number[]) {
  return pixel[3] > 0 && pixel[0] < 200 && pixel[1] < 200 && pixel[2] < 200;
}

// OLD(このPR以前)のfixed-50pxジオメトリ。src/domain/templates.tsの'4koma'分岐が
// 今もこれと同じ式を使っていることを検証する（意図的に定数を重複定義し、実装側の
// 式を書き換えてもテストが気づかず追従してしまわないようにする）。
function legacyPanelTopYs(height: number) {
  const margin = 50;
  const boxHeight = (height - margin * 5) / 4;
  return [0, 1, 2, 3].map((i) => margin + (boxHeight + margin) * i);
}

// このPRで追加された'grid-4'プリセット(比率ベース)のy座標。旧pxジオメトリとは
// 意図的にズレる値になっているはずで、もし'4koma'がこちらに乗せ換わって
// しまっていたら(回帰)、legacyの座標では線が検出できなくなる。
function newGrid4PanelTopYs(width: number, height: number) {
  const outerMarginRatio = 0.045;
  const outerMargin = Math.min(width, height) * outerMarginRatio;
  const innerY = outerMargin;
  const innerH = height - outerMargin * 2;
  const rowStarts = [0, 0.2575, 0.515, 0.7725];
  return rowStarts.map((y) => innerY + y * innerH);
}

test.describe('後方互換: template === "4koma" の旧作品', () => {
  test('再読込してもコマ枠は旧fixed-50pxジオメトリのまま描かれる(新しい比率ベースgrid-4に乗せ換わらない)', async ({ page }) => {
    await page.goto('/');
    // 起動画面(listDrawingSessionsがIndexedDBを開く)を待ってからseedする。
    await expect(page.getByRole('button', { name: /まっしろ/ })).toBeVisible();
    await seedLegacy4KomaSession(page);

    await page.reload();
    const openButton = page.locator('.saved-work-open').first();
    await expect(openButton).toBeVisible();
    await openButton.click();
    await expect(page.locator('.stamp-menu')).toBeVisible();

    const width = CANVAS_WIDTH;
    const height = CANVAS_HEIGHT;
    const centerX = width / 2;

    const legacyTops = legacyPanelTopYs(height);
    const newTops = newGrid4PanelTopYs(width, height);

    // 新旧の各パネル上端が誤差(線幅)の範囲で衝突しないことを先に確認しておく。
    // これが崩れていたらこのテスト自体の判定力が無くなるため、テストの前提として明示する。
    for (let i = 0; i < 4; i += 1) {
      expect(Math.abs(legacyTops[i] - newTops[i])).toBeGreaterThan(6);
    }

    for (let i = 0; i < 4; i += 1) {
      // 旧fixed-50pxジオメトリの位置には、コマ枠の線が実際に描かれている。
      await expect
        .poll(async () => isDarkLine(await readPixel(page, centerX, legacyTops[i])))
        .toBe(true);

      // 新しい比率ベース'grid-4'の位置には、線が無い(=乗せ換わっていない)。
      expect(isDarkLine(await readPixel(page, centerX, newTops[i]))).toBe(false);
    }
  });
});
