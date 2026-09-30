import { test, expect, type Page } from '@playwright/test';

// OEK-05-S04-T05 収束レビュー指摘への回帰テスト。
// 以前の実装(previewSafeDraftObject + MAX_LIVE_TEXTURED_STROKE_PREVIEW_POINTS)は
// 直近48点だけに絞ってはいたが、
//   (a) 毎フレーム、絞った窓(最大48セグメント)を丸ごと再生していたため、
//       トリミング窓に収まる間は処理コストが減らず、フレームあたりの
//       stroke()呼び出し回数が本来必要な量よりずっと多かった
//   (b) 毎フレームcommitted surfaceへ丸ごとリセットしてから直近点だけを
//       再生していたため、48点を超えた瞬間に始点側の線がちらついて
//       消えて見えた
// renderer.tsのrenderIncrementalTexturedStrokeDrafts(ジェスチャー単位の
// アキュムレーションcanvas + 差分区間だけの追記)がこの2つを解消して
// いることを確認する。

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

async function setupPencilCanvas(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: /まっしろ/ }).click();
  await page.getByRole('button', { name: /たて/ }).click();
  const canvas = page.locator('.canvas-frame canvas');
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  if (!box) throw new Error('no canvas box');
  await page.locator('.compact-size-control input[type="range"]').fill('30');
  await page.getByRole('button', { name: '鉛筆', exact: true }).click();
  return box;
}

test('長い鉛筆ドラッグの途中(pointerup前)でも、始点側の線がちらついて消えない', async ({ page }) => {
  const box = await setupPencilCanvas(page);
  const yRatio = 0.3;
  const y = box.y + box.height * yRatio;
  const fromX = box.x + box.width * 0.15;
  const toX = box.x + box.width * 0.85;
  const steps = 80; // 旧MAX_LIVE_TEXTURED_STROKE_PREVIEW_POINTS(48)を大きく超える点数になる

  await page.mouse.move(fromX, y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i += 1) {
    await page.mouse.move(fromX + ((toX - fromX) * i) / steps, y);
  }

  // pointerupせずに、始点付近(既に線が引かれたはず)を読む。
  const startMidDrag = await pixelAt(page, 0.17, yRatio);
  expect(startMidDrag.a).toBe(255);
  expect(startMidDrag.r).toBeLessThan(220);

  // さらに遠くまで動かし続け、点数を大きく増やす
  // (「直近の点」窓に絞る旧実装なら、始点付近はこの窓の外へ落ちる)。
  for (let i = 11; i <= steps; i += 1) {
    await page.mouse.move(fromX + ((toX - fromX) * i) / steps, y);
  }

  // pointerupせずに再び始点付近を読む。旧実装ではここで一瞬白へ戻って
  // 見えていた(ちらつき)。新実装はアキュムレーションcanvasが持続するため
  // 線が引かれたままのはず。
  const startStillMidDrag = await pixelAt(page, 0.17, yRatio);
  expect(startStillMidDrag.a).toBe(255);
  expect(startStillMidDrag.r).toBeLessThan(220);

  await page.mouse.up();
});

test('鉛筆のライブpreviewは、ドラッグが長くなってもフレームあたりのstroke()呼び出しが際限なく増えない', async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __strokeCalls: number }).__strokeCalls = 0;
    const original = CanvasRenderingContext2D.prototype.stroke;
    CanvasRenderingContext2D.prototype.stroke = function (this: CanvasRenderingContext2D, ...args: unknown[]) {
      (window as unknown as { __strokeCalls: number }).__strokeCalls += 1;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (original as any).apply(this, args);
    };
  });

  const box = await setupPencilCanvas(page);
  await page.evaluate(() => { (window as unknown as { __strokeCalls: number }).__strokeCalls = 0; });

  const yRatio = 0.3;
  const y = box.y + box.height * yRatio;
  const fromX = box.x + box.width * 0.15;
  const toX = box.x + box.width * 0.85;
  const steps = 120; // 十分に長いドラッグ(点数はストローク長に比例して増える)

  await page.mouse.move(fromX, y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i += 1) {
    await page.mouse.move(fromX + ((toX - fromX) * i) / steps, y);
  }

  const callsMidDrag = await page.evaluate(
    () => (window as unknown as { __strokeCalls: number }).__strokeCalls,
  );
  await page.mouse.up();

  // 「絞り無し」または「窓を丸ごと毎フレーム再生する」実装なら、120回の
  // pointermoveに対してstroke()呼び出しの累計は数千回に達する
  // (実測: 旧previewSafeDraftObject実装で約4,600回)。差分だけを描く
  // 実装なら、120回のpointermoveに対しては新規セグメント + 末尾の
  // 再描画(TEXTURED_STROKE_RETOUCH_SEGMENTS分)ぶんだけで済むため、
  // ずっと少ない(実測: 新実装で約900回)。
  expect(callsMidDrag).toBeLessThan(2000);
});

test('鉛筆のライブpreviewは、pointerup後(確定後)と同じ濃さで表示される(描き直しで濃くならない)', async ({ page }) => {
  // Codex指摘: 鉛筆はセグメントごとにalpha<1で描くため、増分previewが直近の
  // セグメントを毎フレーム重ねて描き直すと、preview中だけ線が濃くなり、
  // pointerupで確定した(各セグメントを1回だけ描く)見た目が急に薄く変わる。
  const box = await setupPencilCanvas(page);
  const yRatio = 0.3;
  const y = box.y + box.height * yRatio;
  const fromX = box.x + box.width * 0.15;
  const toX = box.x + box.width * 0.85;
  const steps = 60;

  await page.mouse.move(fromX, y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i += 1) {
    await page.mouse.move(fromX + ((toX - fromX) * i) / steps, y);
  }

  // 終端の影響を避けるため、ストロークの中ほどを読む。
  const beforeUp = await pixelAt(page, 0.4, yRatio);
  await page.mouse.up();
  const afterUp = await pixelAt(page, 0.4, yRatio);

  expect(Math.abs(beforeUp.r - afterUp.r)).toBeLessThanOrEqual(2);
  expect(Math.abs(beforeUp.g - afterUp.g)).toBeLessThanOrEqual(2);
  expect(Math.abs(beforeUp.b - afterUp.b)).toBeLessThanOrEqual(2);
});
