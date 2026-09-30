import { test, expect, type Page } from '@playwright/test';

// OEK-05-S04-BUG03 収束レビュー指摘への回帰テスト。
// 以前の実装(previewSafeDraftObject + MAX_LIVE_BLUR_PREVIEW_POINTS)は、
// 直近48点だけに絞ってはいたが、
//   (a) 絞りは点の"個数"だけで、領域(bounding box)そのものの大きさは
//       絞っていなかったため、フレームあたりの処理コストはストローク
//       全体の長さに応じて際限なく増え得た
//   (b) 毎フレームcommitted surfaceへ丸ごとリセットしてから直近点だけを
//       再生していたため、48点を超えた瞬間に始点側の混色がちらついて
//       消えて見えた
// renderer.tsのrenderIncrementalBlurDraft(ジェスチャー単位のアキュムレー
// ションcanvas + 差分区間だけの追記)がこの2つを解消していることを確認する。

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

async function paintRedBlueSeam(page: Page, box: { x: number; y: number; width: number; height: number }, dimsH: number) {
  await setSize(page, 60);
  await selectColor(page, '#e03131');
  await dragAcross(page, box, 0.15, 0.85, box.y + box.height * 0.47);
  await selectColor(page, '#1971c2');
  await dragAcross(page, box, 0.15, 0.85, box.y + box.height * 0.53);
  return 565 / dimsH;
}

test('長いぼかしドラッグの途中(pointerup前)でも、始点側の混色がちらついて消えない', async ({ page }) => {
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

  const seamRatio = await paintRedBlueSeam(page, box, dims.h);
  const seamY = box.y + box.height * seamRatio;
  await page.getByRole('button', { name: 'ぼかし' }).click();

  const fromX = box.x + box.width * 0.15;
  const toX = box.x + box.width * 0.85;
  const steps = 80; // 旧MAX_LIVE_BLUR_PREVIEW_POINTS(48)を大きく超える点数になる

  await page.mouse.move(fromX, seamY);
  await page.mouse.down();
  for (let i = 1; i <= 10; i += 1) {
    await page.mouse.move(fromX + ((toX - fromX) * i) / steps, seamY);
  }

  // pointerupせずに、始点付近(既に混色されたはず)を読む。
  const startMidDrag = await pixelAt(page, 0.17, seamRatio);
  expect(startMidDrag.a).toBe(255);
  expect(startMidDrag.g).toBeLessThan(startMidDrag.r);
  expect(startMidDrag.g).toBeLessThan(startMidDrag.b);

  // さらに遠くまで動かし続け、点数を大きく増やす
  // (「直近の点」窓に絞る旧実装なら、始点付近はこの窓の外へ落ちる)。
  for (let i = 11; i <= steps; i += 1) {
    await page.mouse.move(fromX + ((toX - fromX) * i) / steps, seamY);
  }

  // pointerupせずに再び始点付近を読む。旧実装ではここで一瞬白へ戻って
  // 見えていた(ちらつき)。新実装はアキュムレーションcanvasが持続するため
  // 混色されたままのはず。
  const startStillMidDrag = await pixelAt(page, 0.17, seamRatio);
  expect(startStillMidDrag.a).toBe(255);
  expect(startStillMidDrag.g).toBeLessThan(startStillMidDrag.r);
  expect(startStillMidDrag.g).toBeLessThan(startStillMidDrag.b);
  expect((startStillMidDrag.r + startStillMidDrag.g + startStillMidDrag.b) / 3).toBeLessThan(200);

  await page.mouse.up();
});

test('ぼかしのライブpreviewは、ドラッグが長くなっても1フレームあたりの処理領域が増え続けない', async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __blurGetImageDataAreas: number[] }).__blurGetImageDataAreas = [];
    const original = CanvasRenderingContext2D.prototype.getImageData;
    CanvasRenderingContext2D.prototype.getImageData = function (
      this: CanvasRenderingContext2D,
      sx: number,
      sy: number,
      sw: number,
      sh: number,
      ...rest: unknown[]
    ) {
      (window as unknown as { __blurGetImageDataAreas: number[] }).__blurGetImageDataAreas.push(sw * sh);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (original as any).call(this, sx, sy, sw, sh, ...rest);
    };
  });

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

  const seamRatio = await paintRedBlueSeam(page, box, dims.h);
  const seamY = box.y + box.height * seamRatio;
  await page.getByRole('button', { name: 'ぼかし' }).click();

  // 計測を、これから始める1回の長いぼかしドラッグだけに絞る。
  await page.evaluate(() => {
    (window as unknown as { __blurGetImageDataAreas: number[] }).__blurGetImageDataAreas = [];
  });

  const fromX = box.x + box.width * 0.15;
  const toX = box.x + box.width * 0.85;
  const steps = 120; // 十分に長いドラッグ(点数はストローク長に比例して増える)

  await page.mouse.move(fromX, seamY);
  await page.mouse.down();
  for (let i = 1; i <= steps; i += 1) {
    await page.mouse.move(fromX + ((toX - fromX) * i) / steps, seamY);
    // 一定間隔ごとに、その時点までの最大処理領域を記録する。
  }
  await page.mouse.up();

  const areas: number[] = await page.evaluate(
    () => (window as unknown as { __blurGetImageDataAreas: number[] }).__blurGetImageDataAreas,
  );
  expect(areas.length).toBeGreaterThan(steps / 2);

  // ライブpreview中(pointerup前)に発生した呼び出しはコミット呼び出しより
  // ずっと多いはずなので、末尾のコミット1回分(最大領域になり得る)を除いた
  // 「preview中の呼び出し」だけで比較する。
  const previewAreas = areas.slice(0, -2);
  const median = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  };
  const early = previewAreas.slice(0, Math.floor(previewAreas.length / 4));
  const late = previewAreas.slice(-Math.floor(previewAreas.length / 4));
  const medianEarly = median(early);
  const medianLate = median(late);

  // 「点の個数」だけで直近区間へ絞る実装(旧previewSafeDraftObject)は、
  // 絞りの上限に達するまでは処理領域がストローク長に応じて増え続け、
  // 上限に達した後もその上限区間ぶん(この設定では中央値 約3万px²)を
  // 定常的に処理し続ける。区間の"index"を絞ってその区間の実際の
  // bounding boxだけを処理する実装は、ジェスチャーのどの時点でも
  // 新しく増えた分の小さな領域(1点あたりのマージン程度)しか処理しない。
  // そのため定常状態(ドラッグ後半)の処理領域の中央値は、ドラッグ
  // 前半の中央値からほぼ変わらないはず。
  expect(medianLate).toBeLessThan(medianEarly * 1.5);
  // 絶対値としても、点数トリミングの定常状態で必要な領域(約3万px²)より
  // 明確に小さい、1点ぶんの増分に近い領域に収まっている。
  expect(medianLate).toBeLessThan(15000);
});

// OEK-05-S04-BUG03 収束再レビュー(PR #17)指摘への回帰テスト。
// renderIncrementalBlurDraftは各フレームの新規区間をアキュムレーション
// canvas(gctx)自身から読んで(=既に自分が書き込んだ結果を入力にして)
// smudgeを計算していたため、連続するpointer移動がブラシ径より近い(=新規
// 区間が前フレームの処理済み領域と重なる)と、同じ領域がフレームを重ねる
// たびに繰り返し平均化されて過剰に混ざっていった。pointer-up時のcommitは
// 常に確定済みレイヤーから1回だけ計算するため、この「重ね掛け」された
// ライブpreviewはcommit結果と食い違い、pointer-upの瞬間に見た目が
// 大きく変わって(スナップして)見えていた。
// applyBlurSmudgeへsourceCtx(変更されない確定済みレイヤー)を渡し、
// 近傍色のサンプリングを常にそこから行うことで、区間・呼び出し回数に
// よらず計算結果が安定し、この「重ね掛け」による発散が起きないことを
// 確認する。
test('ブラシ径より近い間隔で重ねてなぞっても、ライブpreviewがcommit結果と食い違わない', async ({ page }) => {
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

  const seamRatio = await paintRedBlueSeam(page, box, dims.h);
  const seamY = box.y + box.height * seamRatio;
  await page.getByRole('button', { name: 'ぼかし' }).click();

  // ブラシ径(60px)よりずっと近い間隔(往復16px)で、同じ場所を繰り返し
  // なぞる(pointerupせず)。
  const centerX = box.x + box.width * 0.5;
  const span = 8;
  await page.mouse.move(centerX - span, seamY);
  await page.mouse.down();
  for (let i = 0; i < 60; i += 1) {
    const x = i % 2 === 0 ? centerX + span : centerX - span;
    await page.mouse.move(x, seamY);
  }

  const midDrag = await pixelAt(page, 0.5, seamRatio);
  await page.mouse.up();
  const committed = await pixelAt(page, 0.5, seamRatio);

  const totalChannelDiff = Math.abs(midDrag.r - committed.r)
    + Math.abs(midDrag.g - committed.g)
    + Math.abs(midDrag.b - committed.b)
    + Math.abs(midDrag.a - committed.a);
  // 「重ね掛け」する旧実装ではここで約90(チャンネル合計)の食い違いが
  // 生じていた。sourceCtxから読む実装では、同じ区間を何度処理しても
  // 結果が安定するため、pointer-up前後でほぼ変わらないはず。
  expect(totalChannelDiff).toBeLessThan(30);
});

// OEK-05-S04-BUG03 収束再レビュー(PR #17)指摘への回帰テスト。
// 新規区間[fromIndex,currentCount)をそのまま1回のapplyBlurへ渡すと、
// coalesced events等で1フレームに多数の(あるいは互いに遠い)点が
// まとめて追加された場合、その区間のbounding boxがcanvas全体に近い
// 大きさへ育ち得た。splitPointRangeIntoChunksによる空間的な分割
// (実点間が離れている場合は補間点を挿入してから分割する)が、1回の
// applyBlur呼び出しあたりの処理領域を上限以下に保つことを確認する。
test('coalesced eventsのような大きな1回の移動でも、1回のsmudge計算が処理する領域は上限に収まる', async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __chunkAreas: number[] }).__chunkAreas = [];
    const original = CanvasRenderingContext2D.prototype.getImageData;
    CanvasRenderingContext2D.prototype.getImageData = function (
      this: CanvasRenderingContext2D,
      sx: number,
      sy: number,
      sw: number,
      sh: number,
      ...rest: unknown[]
    ) {
      (window as unknown as { __chunkAreas: number[] }).__chunkAreas.push(sw * sh);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (original as any).call(this, sx, sy, sw, sh, ...rest);
    };
  });

  await page.goto('/');
  await page.getByRole('button', { name: /まっしろ/ }).click();
  await page.getByRole('button', { name: /たて/ }).click();

  const canvas = page.locator('.canvas-frame canvas');
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  if (!box) return;

  await setSize(page, 60);
  await selectColor(page, '#e03131');
  await page.getByRole('button', { name: 'ぼかし' }).click();

  const y = box.y + box.height * 0.5;
  const fromX = box.x + box.width * 0.05;
  const toX = box.x + box.width * 0.95;

  await page.evaluate(() => { (window as unknown as { __chunkAreas: number[] }).__chunkAreas = []; });
  await page.mouse.move(fromX, y);
  await page.mouse.down();
  // 1回のmouse.move呼び出し(=1回のpointermoveイベント、新規点は1点)で
  // canvas幅の9割を一気に移動する。低スペック端末でサンプリング間隔が
  // 空いた場合や、Playwrightのようにイベントの座標間を補間しない環境を
  // 想定した、意図的に極端な「遠い1点」の追加。
  await page.mouse.move(toX, y);

  // pointerupせずに読む: commit(pointer-up)は常に完全なpointsで1回だけ
  // 全区間を計算するため無関係に大きくなり得る(このテストの対象外)。
  // ここで見るのはライブpreview中(pointer-up前)の分割の効果。
  const areas: number[] = await page.evaluate(
    () => (window as unknown as { __chunkAreas: number[] }).__chunkAreas,
  );
  await page.mouse.up();

  const maxArea = Math.max(...areas);
  // 分割しない実装では、この移動1回で約80,800px²(canvas幅の9割ぶんの
  // bounding box)を1回のsmudgeColors呼び出しで処理していた。
  // maxExtent=300pxで分割する実装では、どのchunkもこれよりずっと
  // 小さい領域に収まるはず。
  expect(maxArea).toBeLessThan(50000);
});
