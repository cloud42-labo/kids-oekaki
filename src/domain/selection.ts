// 選択範囲の共有メカニズム(OEK-05-S04-T06)。
//
// フリーハンド(投げ縄)選択の生成・境界線表示用データ・マスク化を、
// 「範囲だけを色塗り」専用の実装として作るのではなく、ここへ共通部品として
// 切り出す。将来のトリミング・移動・拡縮機能も同じ多角形表現
// (SelectionPoint[])とマスク生成(createSelectionMaskCanvas)を再利用できる
// ようにするための設計(Task本文のDesign note)。
//
// 色塗り自体(engine/renderer.tsのdrawFill)はbuildClosedSelectionPathが返す
// Path2DへCanvasRenderingContext2D.fill()することで実装する。fill()は
// パスの内側だけに描画するというcanvasの基本仕様そのものが
// 「選択範囲の外側のピクセルは絶対に変更しない」という受け入れ基準を
// 保証する(追加のクリップ処理やピクセル単位の判定は不要)。

export type SelectionPoint = { x: number; y: number };

// これ未満の点数・面積は「閉じた範囲」として扱わない(タップや、ほぼ
// 直線なだけのドラッグなど)。呼び出し側はこの判定を「選択なし」として
// 扱い、既存の選択を壊さず無視する。
const MIN_SELECTION_POINTS = 3;
const MIN_SELECTION_EXTENT = 4; // canvas座標系のpx

export function getSelectionBounds(points: SelectionPoint[]) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return { minX, minY, maxX, maxY, width: Math.max(0, maxX - minX), height: Math.max(0, maxY - minY) };
}

// 「色塗りに使える面積を持った閉じた範囲」かどうか。点数だけでなく
// bounding boxの幅・高さの両方がしきい値を超えることを要求するため、
// ほぼ一直線のドラッグ(面積がほぼ0)は選択として確定しない。
export function isSelectionUsable(points: SelectionPoint[]): boolean {
  if (points.length < MIN_SELECTION_POINTS) return false;
  const bounds = getSelectionBounds(points);
  return bounds.width >= MIN_SELECTION_EXTENT && bounds.height >= MIN_SELECTION_EXTENT;
}

// 境界線表示・色塗りの両方で使う「閉じた」Path2Dを作る。最後の点から
// 最初の点へ自動的につながる(closePath)ため、ユーザーが指を離した位置が
// 開始位置からどれだけ離れていても、常に閉じた範囲として扱われる。
export function buildClosedSelectionPath(points: SelectionPoint[]): Path2D {
  const path = new Path2D();
  if (points.length === 0) return path;
  path.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i += 1) path.lineTo(points[i].x, points[i].y);
  path.closePath();
  return path;
}

// 選択範囲を単体のアルファマスク(選択内側=白、外側=透明)として
// オフスクリーンcanvasへ描く。現在の「範囲内を塗る」機能自体は
// buildClosedSelectionPath + ctx.fill(path)で直接実装しており、この
// マスクは使わない。将来のトリミング・移動・拡縮が
// (engine/renderer.tsのdrawBlurMaskと同じ)'destination-in'合成パターンで
// このマスクをそのまま再利用できるよう、共有部品として用意しておく。
export function createSelectionMaskCanvas(points: SelectionPoint[], width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx || points.length < MIN_SELECTION_POINTS) return canvas;
  ctx.fillStyle = '#ffffff';
  ctx.fill(buildClosedSelectionPath(points));
  return canvas;
}
