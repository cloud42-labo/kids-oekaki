import { test, expect } from '@playwright/test';

// OEK-05-S04-T05 Codexレビュー指摘: スタンプ作成UI廃止より前に保存された
// セッションは settings.mode:'stamp' をそのまま持っている可能性がある。
// stamp分岐を削除したことで、そのまま復元するとツールバーはどのボタンも
// 選択されて見えないのに、以前選んでいたbrush(消しゴム・ぼかし等の
// 危険な可能性がある)でCanvasStageのpointerdownが描画してしまう。
// 復元時にmode:'stamp'を安全なブラシ(ペン)へ正規化することを確認する。

test('mode:stampを持つ旧セッションを復元すると、安全なペンへ正規化される', async ({ page }) => {
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
        { id: layerId, name: 'せんが', visible: true, locked: false, opacity: 1, objects: [] },
      ],
    };
    const history = { past: [], present: document, future: [] };
    const session = {
      schemaVersion: 2,
      id,
      name: 'legacy stamp mode',
      savedAt: new Date().toISOString(),
      history,
      // スタンプUI廃止前の保存データを模す: mode:'stamp'のまま、
      // 直前に選んでいたbrushは危険なeraserになっている。
      settings: { mode: 'stamp', brush: 'eraser', stampKind: 'heart', color: '#111111', size: 8 },
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
  await page.locator('.saved-work-open').first().click();
  await expect(page.locator('.canvas-frame canvas')).toBeVisible();

  // 復元直後、ツールバーの「ペン」が選択された状態に正規化されている
  // (=eraserのまま復元されていない)。
  await expect(page.getByRole('button', { name: 'ペン', exact: true })).toHaveAttribute('aria-pressed', 'true');
});
