import { test, expect } from '@playwright/test';

// OEK-05-S04-T05 Codexレビュー指摘: ミラー描画で生まれる反転strokeは
// mirrorStrokeAcrossAxisで新しいidを持つ(Undo/Redo単位の都合上)。鉛筆の
// かすれ・濃淡(seededJitter)がidをそのままseedとして使っていたため、
// 反転strokeは元storkeと異なる揺らぎになり、左右対称に見えなかった。
// StrokeObjectへ`seed`を追加しmirrorStrokeAcrossAxisが`...stroke`展開で
// それを引き継ぐようにした結果、保存データ上で元storkeと反転storkeの
// `seed`が一致し(`id`は別のまま)、見た目の対称性が保たれることを確認する。

test('ミラー描画で生まれる鉛筆strokeペアは、idは別だがseedが一致し揺らぎが対称になる', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /まっしろ/ }).click();
  await page.getByRole('button', { name: /たて/ }).click();

  const canvas = page.locator('.canvas-frame canvas');
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  if (!box) return;

  await page.getByRole('button', { name: '鉛筆', exact: true }).click();
  await page.getByTitle('ミラーがき').click();

  const y = box.y + box.height * 0.5;
  await page.mouse.move(box.x + box.width * 0.2, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.3, y);
  await page.mouse.up();

  await page.getByRole('button', { name: /保存/ }).click();
  await expect(page.getByRole('button', { name: /保存済/ })).toBeVisible();

  const objects = await page.evaluate(() => {
    return new Promise<Array<{ id: string; seed?: string; brush: string }>>((resolve, reject) => {
      const req = indexedDB.open('kids-oekaki', 1);
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction('drawing-sessions', 'readonly');
        const getAll = tx.objectStore('drawing-sessions').getAll();
        getAll.onsuccess = () => {
          const sessions = getAll.result as Array<{ history: { present: { layers: Array<{ objects: any[] }> } } }>;
          const latest = sessions[sessions.length - 1];
          const strokes = latest.history.present.layers.flatMap((l) => l.objects).filter((o) => o.type === 'stroke');
          resolve(strokes);
        };
        getAll.onerror = () => reject(getAll.error);
      };
      req.onerror = () => reject(req.error);
    });
  });

  expect(objects).toHaveLength(2);
  const [a, b] = objects;
  expect(a.brush).toBe('pencil');
  expect(b.brush).toBe('pencil');
  // idは別(Undo/Redoの単位・React keyとして区別される)。
  expect(a.id).not.toBe(b.id);
  // seedは共有(=かすれ・濃淡の揺らぎが左右対称になる)。
  expect(a.seed).toBeTruthy();
  expect(a.seed).toBe(b.seed);
});
