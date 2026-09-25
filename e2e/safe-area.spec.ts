import { test, expect } from '@playwright/test';

// OEK-05-S03-BUG02: Android実機で下部操作バー（レイヤーパネル）がシステム/
// ナビゲーションバーに隠れる不具合の回帰テスト。
//
// ChromeのCDP `Emulation.setSafeAreaInsetsOverride` で、ジェスチャー/3ボタン
// ナビゲーションバー相当のsafe-area-inset-*を疑似的に発生させ、
// env(safe-area-inset-*)を使うレイアウトが実際に安全域を避けて
// 描画されることを確認する。

async function overrideSafeAreaInsets(page: import('@playwright/test').Page, insets: { top: number; left: number; bottom: number; right: number }) {
  const client = await page.context().newCDPSession(page);
  await client.send('Emulation.setSafeAreaInsetsOverride', { insets });
}

test.describe('safe-area-inset対応（システムバー回避）', () => {
  test('狭幅縦持ち: レイヤーパネルがナビゲーションバー(inset-bottom)の内側に収まる', async ({ page }) => {
    // 3ボタン/ジェスチャーナビゲーションバー相当のinsetを模擬（下48px、実機の代表値）
    await page.setViewportSize({ width: 390, height: 780 });
    await overrideSafeAreaInsets(page, { top: 32, left: 0, bottom: 48, right: 0 });

    await page.goto('/');
    await page.getByRole('button', { name: /まっしろ/ }).click();
    await page.getByRole('button', { name: /たて/ }).click();

    const layerPanel = page.locator('.layer-panel');
    await expect(layerPanel).toBeVisible();

    const box = await layerPanel.boundingBox();
    const viewport = page.viewportSize();
    expect(box).not.toBeNull();
    expect(viewport).not.toBeNull();
    if (!box || !viewport) return;

    // レイヤーパネルの下端は、ビューポート下端からinset-bottom(48px)+自身のオフセット
    // (8px)=56px前後にあるべき（＝ナビゲーションバーの裏に回り込んでおらず、かつ
    // insetを二重適用して必要以上に浮いてもいない）。下限だけのアサーション
    // （>=48）だと二重適用（実測104px）も通ってしまい回帰を検知できなかったため
    // （OEK-05-S03-BUG02のCodexレビュー指摘）、上限も合わせて確認する。
    const distanceFromBottom = viewport.height - (box.y + box.height);
    expect(distanceFromBottom).toBeGreaterThanOrEqual(48);
    expect(distanceFromBottom).toBeLessThanOrEqual(64);

    // レイヤー追加/表示切替など、パネル内の操作ボタンも同様に安全域の内側にある。
    const addLayerButton = layerPanel.getByRole('button').first();
    const addBox = await addLayerButton.boundingBox();
    expect(addBox).not.toBeNull();
    if (addBox) {
      expect(viewport.height - (addBox.y + addBox.height)).toBeGreaterThanOrEqual(48);
    }
  });

  test('狭幅縦持ち: insetが無い（0px）通常のWeb表示では、従来どおり8pxオフセットのまま', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 780 });
    await overrideSafeAreaInsets(page, { top: 0, left: 0, bottom: 0, right: 0 });

    await page.goto('/');
    await page.getByRole('button', { name: /まっしろ/ }).click();
    await page.getByRole('button', { name: /たて/ }).click();

    const layerPanel = page.locator('.layer-panel');
    const box = await layerPanel.boundingBox();
    const viewport = page.viewportSize();
    expect(box).not.toBeNull();
    expect(viewport).not.toBeNull();
    if (!box || !viewport) return;

    const distanceFromBottom = viewport.height - (box.y + box.height);
    // env()のフォールバックが0pxのため、従来どおり8px前後（+-2pxの誤差許容）
    expect(distanceFromBottom).toBeGreaterThanOrEqual(6);
    expect(distanceFromBottom).toBeLessThanOrEqual(10);
  });

  test('ツールバー全体がinset-topの外側（ステータスバーの裏に回り込まない）にある', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 780 });
    await overrideSafeAreaInsets(page, { top: 32, left: 0, bottom: 48, right: 0 });

    await page.goto('/');
    await page.getByRole('button', { name: /まっしろ/ }).click();
    await page.getByRole('button', { name: /たて/ }).click();

    const toolbar = page.locator('.creative-toolbar');
    const box = await toolbar.boundingBox();
    expect(box).not.toBeNull();
    if (!box) return;

    // ツールバー自体の上端がinset-top(32px)以上、ビューポート上端から離れていること
    expect(box.y).toBeGreaterThanOrEqual(32);

    // 「開始画面へ戻る」（もどる）・undo・redoボタンが表示・操作可能であること。
    // 保存/PNGボタンはこの幅（<=700px）ではラベルspanがdisplay:noneになりアクセシブル
    // ネームから外れる既存仕様のため、role単位の存在確認に留める（BUG02のスコープ外）。
    await expect(page.getByRole('button', { name: /開始画面へ戻る/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /ひとつ戻る/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /やり直す/ })).toBeVisible();
    expect(await toolbar.getByRole('button').count()).toBeGreaterThanOrEqual(5);
  });

  // Codexレビュー指摘（AGENTS.md L19: 実機での回転チェックが必須）: 横向き回転時、
  // ナビゲーションバー/ディスプレイカットアウトがsafe-area-inset-left/rightを
  // 発生させることがある。縦持ち専用だった対応を、横持ちでも同様に検証する。
  test('横持ち回転: ツールバー・カラードック・レイヤーパネルがinset-left/rightの内側に収まる', async ({ page }) => {
    await page.setViewportSize({ width: 780, height: 390 });
    await overrideSafeAreaInsets(page, { top: 0, left: 24, bottom: 0, right: 36 });

    await page.goto('/');
    await page.getByRole('button', { name: /まっしろ/ }).click();
    await page.getByRole('button', { name: /よこ/ }).click();

    const viewport = page.viewportSize();
    expect(viewport).not.toBeNull();
    if (!viewport) return;

    // ツールバー全体（先頭要素）がinset-left/rightの内側にある
    const toolbar = page.locator('.creative-toolbar');
    const toolbarBox = await toolbar.boundingBox();
    expect(toolbarBox).not.toBeNull();
    if (toolbarBox) {
      expect(toolbarBox.x).toBeGreaterThanOrEqual(24);
      expect(viewport.width - (toolbarBox.x + toolbarBox.width)).toBeGreaterThanOrEqual(36);
    }

    // ワークスペース左端のカラードックがinset-leftの内側にある
    const colorDock = page.locator('.color-dock');
    const dockBox = await colorDock.boundingBox();
    expect(dockBox).not.toBeNull();
    if (dockBox) {
      expect(dockBox.x).toBeGreaterThanOrEqual(24);
    }

    // ワークスペース右端のレイヤーパネルがinset-rightの内側にある
    const layerPanel = page.locator('.layer-panel');
    const panelBox = await layerPanel.boundingBox();
    expect(panelBox).not.toBeNull();
    if (panelBox) {
      expect(viewport.width - (panelBox.x + panelBox.width)).toBeGreaterThanOrEqual(36);
    }
  });

  test('横持ち・insetが無い（0px）通常のWeb表示では、従来どおりビューポート端に接したまま', async ({ page }) => {
    await page.setViewportSize({ width: 780, height: 390 });
    await overrideSafeAreaInsets(page, { top: 0, left: 0, bottom: 0, right: 0 });

    await page.goto('/');
    await page.getByRole('button', { name: /まっしろ/ }).click();
    await page.getByRole('button', { name: /よこ/ }).click();

    const colorDock = page.locator('.color-dock');
    const dockBox = await colorDock.boundingBox();
    expect(dockBox).not.toBeNull();
    // env()のフォールバックが0pxのため、従来どおりビューポート左端(0px前後)のまま
    if (dockBox) expect(dockBox.x).toBeLessThanOrEqual(2);
  });
});
