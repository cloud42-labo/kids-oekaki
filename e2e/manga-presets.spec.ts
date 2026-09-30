import { test, expect, type Page } from '@playwright/test';
import { CANVAS_HEIGHT, CANVAS_WIDTH } from '../src/domain/drawing';
import { MANGA_PRESETS, PANEL_OUTER_MARGIN_RATIO } from '../src/domain/templates';

// プリセットのlabelには"+"のような正規表現の特殊文字を含むもの('おおきい1+ちいさい2')が
// あるため、getByRoleのnameへ渡す前に必ずエスケープする。
function labelPattern(label: string) {
  return new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}

// portrait(たて)の作品用紙は800x1131pxで、デスクトップ既定ビューポート(720px高)
// より縦に長い。既定ビューポートのままだとキャンバス下半分がブラウザの表示領域
// (viewport)自体からはみ出し、その部分へのpage.mouse操作が届かない
// (body側でoverflow:hiddenのためスクロールもできない)。コマ全体、特に下段の
// コマへ実際にstrokeを描く検証があるため、キャンバス全体が収まる高さを確保する。
test.use({ viewport: { width: 900, height: 1300 } });

// OEK-05-S04-T04: 絵日記を廃止し、開始画面の主要選択肢を白紙/漫画/LINEスタンプへ
// 整理する。漫画選択後は固定4コマではなく、複数の変則コマ割りプリセットから
// 選べるようにする。
//
// Acceptance Criteria:
//  1. 起動画面から絵日記が消え、白紙/漫画/LINEスタンプの3択になる
//     (LINEスタンプはOEK-05-S04-T03で実装予定のため、ここでは選べない枠のみ)。
//  2. 漫画選択後、固定4コマではなく変則コマ割りプリセットが少なくとも5種類、
//     サムネイル付きで選べる。
//  3. コマ枠は描画（レイヤーのobject）とは独立していて、PNGへは含まれる
//     （renderDocumentは画面用canvasとPNG書き出しの両方で同じ関数のため、
//     画面canvasの画素を読むのが書き出し結果の妥当なproxyになる。
//     e2e/mirror-drawing.spec.tsと同じ前提）。
//  4. 白紙/LINEスタンプ、ズーム/パン、レイヤー、Undo/Redoを壊さない。
//  5. 保存・再開でも選んだプリセットが復元される。

async function goToMangaPresetPicker(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: /^まんが/ }).click();
  const presetGroup = page.getByRole('group', { name: 'コマわりプリセット' });
  await expect(presetGroup).toBeVisible();
  return presetGroup;
}

function presetGroup(page: Page) {
  return page.getByRole('group', { name: 'コマわりプリセット' });
}

async function canvasBox(page: Page) {
  const box = await page.locator('canvas').first().boundingBox();
  expect(box).not.toBeNull();
  if (!box) throw new Error('canvas not found');
  return box;
}

async function toCanvasPoint(page: Page, xRatio: number, yRatio: number) {
  const box = await canvasBox(page);
  return { x: box.x + box.width * xRatio, y: box.y + box.height * yRatio };
}

async function readPixel(page: Page, xRatio: number, yRatio: number) {
  return page.evaluate(
    ([xr, yr]) => {
      const canvas = document.querySelector('canvas') as HTMLCanvasElement;
      const ctx = canvas.getContext('2d')!;
      const x = Math.min(canvas.width - 1, Math.max(0, Math.round(xr * canvas.width)));
      const y = Math.min(canvas.height - 1, Math.max(0, Math.round(yr * canvas.height)));
      return Array.from(ctx.getImageData(x, y, 1, 1).data);
    },
    [xRatio, yRatio],
  );
}

function isDarkLine(pixel: number[]) {
  return pixel[3] > 0 && pixel[0] < 200 && pixel[1] < 200 && pixel[2] < 200;
}

function isBlankWhite(pixel: number[]) {
  return pixel[0] > 250 && pixel[1] > 250 && pixel[2] > 250;
}

async function drawStroke(page: Page, xRatio: number, fromYRatio: number, toYRatio: number) {
  const from = await toCanvasPoint(page, xRatio, fromYRatio);
  const to = await toCanvasPoint(page, xRatio, toYRatio);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x, (from.y + to.y) / 2, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 4 });
  await page.mouse.up();
}

// drawPanelFrames（src/domain/templates.ts）と全く同じ式でコマ矩形をpx換算する。
// 数値を重複定義せず、実装が変わればテスト側も自動的に追従する。
function panelRectPx(panel: { x: number; y: number; w: number; h: number }, width: number, height: number) {
  const outerMargin = Math.min(width, height) * PANEL_OUTER_MARGIN_RATIO;
  const innerW = width - outerMargin * 2;
  const innerH = height - outerMargin * 2;
  return {
    x: outerMargin + panel.x * innerW,
    y: outerMargin + panel.y * innerH,
    w: panel.w * innerW,
    h: panel.h * innerH,
  };
}

const TOP_WIDE_BOTTOM_SPLIT = MANGA_PRESETS.find((p) => p.key === 'top-wide-bottom-split')!;

test.describe('開始画面: 白紙/漫画/LINEスタンプへの整理', () => {
  test('絵日記の選択肢が無く、白紙/まんが/LINEスタンプ(近日公開)の3択になっている', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('button', { name: /まっしろ/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /^まんが/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /LINEスタンプ/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /LINEスタンプ/ })).toBeDisabled();
    await expect(page.getByRole('button', { name: /えにっき/ })).toHaveCount(0);
  });

  test('白紙は従来どおりコマわり選択をスキップしてすぐ向き選択になる', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /まっしろ/ }).click();
    await expect(page.getByRole('heading', { name: 'どちらむき？' })).toBeVisible();
    await expect(presetGroup(page)).toHaveCount(0);
  });
});

test.describe('漫画モード: 変則コマ割りプリセット', () => {
  test('まんが選択後、サムネイル付きのプリセットが5種類以上選べる', async ({ page }) => {
    const group = await goToMangaPresetPicker(page);
    expect(MANGA_PRESETS.length).toBeGreaterThanOrEqual(5);

    const presetButtons = group.getByRole('button');
    await expect(presetButtons).toHaveCount(MANGA_PRESETS.length);

    for (const preset of MANGA_PRESETS) {
      const card = group.getByRole('button', { name: labelPattern(preset.label) });
      await expect(card).toBeVisible();
      await expect(card.locator('canvas.preset-thumbnail')).toHaveCount(1);
    }

    // ACに挙げられている具体例をすべて含むこと。
    const keys = MANGA_PRESETS.map((p) => p.key);
    expect(keys).toEqual(expect.arrayContaining([
      'one-large-two-small',
      'three-rows-five-panels',
      'left-large-right-stack',
      'top-wide-bottom-split',
      'center-large-surround',
    ]));
  });

  test('プリセットを選ぶと対応するコマ枠が描かれ、描画/Undo/Redoも機能する', async ({ page }) => {
    const group = await goToMangaPresetPicker(page);
    await group.getByRole('button', { name: labelPattern(TOP_WIDE_BOTTOM_SPLIT.label) }).click();
    await page.getByRole('button', { name: /たて/ }).click();
    await expect(page.locator('.stamp-menu')).toBeVisible();

    const width = CANVAS_WIDTH;
    const height = CANVAS_HEIGHT;
    const [topPanel, bottomLeft] = TOP_WIDE_BOTTOM_SPLIT.panels.map((panel) => panelRectPx(panel, width, height));

    // 上段パネルの下端(コマ枠の線)は描画前から濃い色で焼き込まれている。
    const borderRatio = { x: (topPanel.x + topPanel.w / 2) / width, y: (topPanel.y + topPanel.h) / height };
    await expect.poll(async () => isDarkLine(await readPixel(page, borderRatio.x, borderRatio.y))).toBe(true);

    // 下段左パネルの内部はまだ白紙。
    const insideBottomLeftRatio = { x: (bottomLeft.x + bottomLeft.w / 2) / width, y: (bottomLeft.y + bottomLeft.h / 2) / height };
    expect(isBlankWhite(await readPixel(page, insideBottomLeftRatio.x, insideBottomLeftRatio.y))).toBe(true);

    // 下段左パネルの中に線を引く。
    await drawStroke(page, insideBottomLeftRatio.x, (bottomLeft.y + bottomLeft.h * 0.3) / height, (bottomLeft.y + bottomLeft.h * 0.7) / height);
    await expect.poll(async () => isDarkLine(await readPixel(page, insideBottomLeftRatio.x, insideBottomLeftRatio.y))).toBe(true);

    // Undoで描いた線だけが消え、コマ枠は残る(コマ枠はレイヤーobjectではないため)。
    await page.getByRole('button', { name: 'ひとつ戻る' }).click();
    await expect.poll(async () => isBlankWhite(await readPixel(page, insideBottomLeftRatio.x, insideBottomLeftRatio.y))).toBe(true);
    expect(isDarkLine(await readPixel(page, borderRatio.x, borderRatio.y))).toBe(true);

    // Redoで線が戻る。
    await page.getByRole('button', { name: 'やり直す' }).click();
    await expect.poll(async () => isDarkLine(await readPixel(page, insideBottomLeftRatio.x, insideBottomLeftRatio.y))).toBe(true);
  });

  test('コマわり選択の「かみをえらびなおす」で漫画の主要選択に戻れる', async ({ page }) => {
    const group = await goToMangaPresetPicker(page);
    await page.getByRole('button', { name: /かみを えらびなおす/ }).click();
    await expect(page.getByRole('heading', { name: 'なにを かく？' })).toBeVisible();
    await expect(group).toHaveCount(0);
  });

  test('PNGエクスポートしてもクラッシュしない（コマ枠を含む同じrenderDocumentの結果）', async ({ page }) => {
    const group = await goToMangaPresetPicker(page);
    await group.getByRole('button', { name: labelPattern(MANGA_PRESETS[0].label) }).click();
    await page.getByRole('button', { name: /たて/ }).click();
    await expect(page.locator('.stamp-menu')).toBeVisible();

    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: /PNG/ }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^oekaki-\d{4}-\d{2}-\d{2}\.png$/);
  });

  test('保存・「つづきから」再開でも選んだプリセットのコマ枠が復元される', async ({ page }) => {
    const group = await goToMangaPresetPicker(page);
    await group.getByRole('button', { name: labelPattern(TOP_WIDE_BOTTOM_SPLIT.label) }).click();
    await page.getByRole('button', { name: /たて/ }).click();
    await expect(page.locator('.stamp-menu')).toBeVisible();

    const width = CANVAS_WIDTH;
    const height = CANVAS_HEIGHT;
    const [topPanel, bottomLeft] = TOP_WIDE_BOTTOM_SPLIT.panels.map((panel) => panelRectPx(panel, width, height));
    const insideBottomLeftRatio = { x: (bottomLeft.x + bottomLeft.w / 2) / width, y: (bottomLeft.y + bottomLeft.h / 2) / height };
    const borderRatio = { x: (topPanel.x + topPanel.w / 2) / width, y: (topPanel.y + topPanel.h) / height };

    await drawStroke(page, insideBottomLeftRatio.x, (bottomLeft.y + bottomLeft.h * 0.3) / height, (bottomLeft.y + bottomLeft.h * 0.7) / height);
    await expect.poll(async () => isDarkLine(await readPixel(page, insideBottomLeftRatio.x, insideBottomLeftRatio.y))).toBe(true);

    await page.getByRole('button', { name: /^⌑ 保存$/ }).click();
    await expect(page.getByRole('button', { name: /保存済/ })).toBeVisible();

    await page.reload();
    const openButton = page.locator('.saved-work-open').first();
    await expect(openButton).toBeVisible();
    await openButton.click();
    await expect(page.locator('.stamp-menu')).toBeVisible();

    await expect.poll(async () => isDarkLine(await readPixel(page, borderRatio.x, borderRatio.y))).toBe(true);
    expect(isDarkLine(await readPixel(page, insideBottomLeftRatio.x, insideBottomLeftRatio.y))).toBe(true);
  });
});

// Codexレビュー指摘(P1, comment_id 4114080721): 760px以下の幅では6プリセットが
// 2列3段になり、見出し・マスコット・もどるボタンを含めた合計高さが一般的な
// スマートフォンのビューポート高さ(640〜720px程度)を超える。html/body/#rootの
// overflow:hiddenとこの画面自体にスクロール手段が無いと、下段のプリセットや
// もどるボタンに到達できなくなる回帰。このdescribeだけ、ファイル先頭の
// test.use({viewport:900x1300})を上書きしてスマホサイズの高さで検証する。
test.describe('コマわりプリセット選択画面: スマホサイズの高さでもスクロールで全項目に到達できる', () => {
  test.use({ viewport: { width: 375, height: 667 } });

  test('6プリセット全部と「かみをえらびなおす」ボタンにスクロールで到達できる', async ({ page }) => {
    const group = await goToMangaPresetPicker(page);
    const presetButtons = group.getByRole('button');
    await expect(presetButtons).toHaveCount(MANGA_PRESETS.length);

    // .start-screen-preset自体がスクロールコンテナになっている前提
    // (src/styles.cssの.start-screen-preset)。overflow:hiddenのまま
    // スクロール手段が無い回帰が起きていれば、ここでfalseになる。
    const scrollContainer = page.locator('.start-screen-preset');
    await expect(scrollContainer).toBeVisible();
    await expect
      .poll(() => scrollContainer.evaluate((el) => el.scrollHeight > el.clientHeight + 1))
      .toBe(true);

    for (const preset of MANGA_PRESETS) {
      const card = group.getByRole('button', { name: labelPattern(preset.label) });
      await card.scrollIntoViewIfNeeded();
      await expect(card).toBeInViewport();
    }

    const backButton = page.getByRole('button', { name: /かみを えらびなおす/ });
    await backButton.scrollIntoViewIfNeeded();
    await expect(backButton).toBeInViewport();
    await backButton.click();
    await expect(page.getByRole('heading', { name: 'なにを かく？' })).toBeVisible();
  });
});
