import type { BlurObject, DrawingDocument, DrawingLayer, DrawingObject, StrokeObject } from '../domain/drawing';
import { drawTemplate } from '../domain/templates';

type LayerCache = {
  canvas: HTMLCanvasElement;
  layerRef: DrawingLayer | null;
};

const layerSurfaces = new Map<string, LayerCache>();
let draftSurface: HTMLCanvasElement | null = null;
let blurSurface: HTMLCanvasElement | null = null;
let blurMaskSurface: HTMLCanvasElement | null = null;

function getLayerSurface(layer: DrawingLayer, width: number, height: number) {
  let entry = layerSurfaces.get(layer.id);
  if (!entry) {
    entry = { canvas: document.createElement('canvas'), layerRef: null };
    layerSurfaces.set(layer.id, entry);
  }

  if (entry.canvas.width !== width || entry.canvas.height !== height) {
    entry.canvas.width = width;
    entry.canvas.height = height;
    entry.layerRef = null;
  }
  return entry;
}

function getDraftSurface(width: number, height: number) {
  if (!draftSurface) draftSurface = document.createElement('canvas');
  if (draftSurface.width !== width) draftSurface.width = width;
  if (draftSurface.height !== height) draftSurface.height = height;
  return draftSurface;
}

function getBlurSurface(width: number, height: number) {
  if (!blurSurface) blurSurface = document.createElement('canvas');
  if (blurSurface.width !== width) blurSurface.width = width;
  if (blurSurface.height !== height) blurSurface.height = height;
  return blurSurface;
}

function getBlurMaskSurface(width: number, height: number) {
  if (!blurMaskSurface) blurMaskSurface = document.createElement('canvas');
  if (blurMaskSurface.width !== width) blurMaskSurface.width = width;
  if (blurMaskSurface.height !== height) blurMaskSurface.height = height;
  return blurMaskSurface;
}

function rainbowColor(hue: number) {
  return `hsl(${hue}, 90%, 55%)`;
}

function drawRainbowStroke(ctx: CanvasRenderingContext2D, stroke: StrokeObject) {
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = stroke.size;
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;

  if (stroke.points.length === 1) {
    const p = stroke.points[0];
    ctx.beginPath();
    ctx.arc(p.x, p.y, stroke.size / 2, 0, Math.PI * 2);
    ctx.fillStyle = rainbowColor(0);
    ctx.fill();
    ctx.restore();
    return;
  }

  const segments = stroke.points.length - 1;
  for (let i = 0; i < segments; i += 1) {
    ctx.strokeStyle = rainbowColor((i / segments) * 300);
    ctx.beginPath();
    ctx.moveTo(stroke.points[i].x, stroke.points[i].y);
    ctx.lineTo(stroke.points[i + 1].x, stroke.points[i + 1].y);
    ctx.stroke();
  }
  ctx.restore();
}

function drawNeonStroke(ctx: CanvasRenderingContext2D, stroke: StrokeObject) {
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.globalCompositeOperation = 'source-over';

  const tracePath = () => {
    if (stroke.points.length === 1) {
      const p = stroke.points[0];
      ctx.beginPath();
      ctx.arc(p.x, p.y, stroke.size / 2, 0, Math.PI * 2);
      return true;
    }
    ctx.beginPath();
    ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
    for (let i = 1; i < stroke.points.length; i += 1) ctx.lineTo(stroke.points[i].x, stroke.points[i].y);
    return false;
  };

  ctx.shadowColor = stroke.color;
  ctx.shadowBlur = Math.max(8, stroke.size * 1.2);
  ctx.globalAlpha = 0.9;
  ctx.strokeStyle = stroke.color;
  ctx.fillStyle = stroke.color;
  ctx.lineWidth = stroke.size;
  const isDot = tracePath();
  if (isDot) ctx.fill();
  else ctx.stroke();

  ctx.shadowBlur = 0;
  ctx.globalAlpha = 1;
  ctx.strokeStyle = '#ffffff';
  ctx.fillStyle = '#ffffff';
  ctx.lineWidth = Math.max(1, stroke.size * 0.35);
  const isDot2 = tracePath();
  if (isDot2) ctx.fill();
  else ctx.stroke();

  ctx.restore();
}

function drawStroke(ctx: CanvasRenderingContext2D, stroke: StrokeObject) {
  if (stroke.points.length === 0) return;
  if (stroke.brush === 'rainbow') return drawRainbowStroke(ctx, stroke);
  if (stroke.brush === 'neon') return drawNeonStroke(ctx, stroke);

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = stroke.size;

  if (stroke.brush === 'eraser') {
    ctx.globalCompositeOperation = 'destination-out';
    ctx.globalAlpha = 1;
    ctx.strokeStyle = '#000';
  } else {
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = stroke.color;
    ctx.globalAlpha = stroke.brush === 'marker' ? 0.3 : 1;
  }

  if (stroke.points.length === 1) {
    const p = stroke.points[0];
    ctx.beginPath();
    ctx.arc(p.x, p.y, stroke.size / 2, 0, Math.PI * 2);
    ctx.fillStyle = stroke.brush === 'eraser' ? '#000' : stroke.color;
    ctx.fill();
    ctx.restore();
    return;
  }

  ctx.beginPath();
  ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
  for (let i = 1; i < stroke.points.length; i += 1) {
    const p = stroke.points[i];
    ctx.lineTo(p.x, p.y);
  }
  ctx.stroke();
  ctx.restore();
}

function drawBlurMask(ctx: CanvasRenderingContext2D, blur: BlurObject, offsetX: number, offsetY: number) {
  if (!blur.points.length) return;
  ctx.save();
  ctx.strokeStyle = '#ffffff';
  ctx.fillStyle = '#ffffff';
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(1, blur.size);

  if (blur.points.length === 1) {
    const p = blur.points[0];
    ctx.beginPath();
    ctx.arc(p.x - offsetX, p.y - offsetY, Math.max(0.5, blur.size / 2), 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.beginPath();
    ctx.moveTo(blur.points[0].x - offsetX, blur.points[0].y - offsetY);
    for (let i = 1; i < blur.points.length; i += 1) {
      ctx.lineTo(blur.points[i].x - offsetX, blur.points[i].y - offsetY);
    }
    ctx.stroke();
  }
  ctx.restore();
}

// 1次元の箱型フィルタ(box blur)。累積和で境界をclampしながら
// [i-radius, i+radius]の合計を返す(O(length))。
function boxSum1D(values: Float32Array, length: number, radius: number): Float32Array {
  const prefix = new Float32Array(length + 1);
  for (let i = 0; i < length; i += 1) prefix[i + 1] = prefix[i] + values[i];
  const out = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    const start = Math.max(0, i - radius);
    const end = Math.min(length - 1, i + radius);
    out[i] = prefix[end + 1] - prefix[start];
  }
  return out;
}

function boxBlur2D(src: Float32Array, width: number, height: number, radius: number): Float32Array {
  const horizontal = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const offset = y * width;
    const row = boxSum1D(src.subarray(offset, offset + width), width, radius);
    horizontal.set(row, offset);
  }
  const result = new Float32Array(width * height);
  const column = new Float32Array(height);
  for (let x = 0; x < width; x += 1) {
    for (let y = 0; y < height; y += 1) column[y] = horizontal[y * width + x];
    const summed = boxSum1D(column, height, radius);
    for (let y = 0; y < height; y += 1) result[y * width + x] = summed[y];
  }
  return result;
}

// 近傍の不透明画素だけを対象にした色の重み付き平均(=alphaで重み付けした
// box blur)を計算する。透明画素はweight 0として扱われるため、境界の
// 「何も無い場所」の色(≒台紙の白)を混ぜ込むことがない。
// alpha(不透明度)は、既存の不透明画素では絶対に下げない
// (max(元のalpha, 近傍alphaの単純平均))。指でこすって隣の色を
// 引きずり込むスマッジ本来の動きとして、境界のすぐ隣の透明画素へ
// alphaが少しだけ広がることは許容するが、それは常に周囲の実際の絵の具の
// 色で埋まるのであって、透明=白として混ぜ込まれるのではない。
function smudgeColors(imageData: ImageData, radius: number) {
  const { data, width, height } = imageData;
  const n = width * height;
  const weightedR = new Float32Array(n);
  const weightedG = new Float32Array(n);
  const weightedB = new Float32Array(n);
  const alphaFrac = new Float32Array(n);
  const ones = new Float32Array(n).fill(1);
  for (let i = 0; i < n; i += 1) {
    const o = i * 4;
    const a = data[o + 3] / 255;
    weightedR[i] = data[o] * a;
    weightedG[i] = data[o + 1] * a;
    weightedB[i] = data[o + 2] * a;
    alphaFrac[i] = a;
  }

  const sumR = boxBlur2D(weightedR, width, height, radius);
  const sumG = boxBlur2D(weightedG, width, height, radius);
  const sumB = boxBlur2D(weightedB, width, height, radius);
  const sumAlpha = boxBlur2D(alphaFrac, width, height, radius);
  const windowCount = boxBlur2D(ones, width, height, radius);

  const mixedR = new Uint8ClampedArray(n);
  const mixedG = new Uint8ClampedArray(n);
  const mixedB = new Uint8ClampedArray(n);
  const mixedAlpha = new Uint8ClampedArray(n);
  for (let i = 0; i < n; i += 1) {
    if (sumAlpha[i] > 0.0001) {
      mixedR[i] = sumR[i] / sumAlpha[i];
      mixedG[i] = sumG[i] / sumAlpha[i];
      mixedB[i] = sumB[i] / sumAlpha[i];
    } else {
      const o = i * 4;
      mixedR[i] = data[o];
      mixedG[i] = data[o + 1];
      mixedB[i] = data[o + 2];
    }
    const averageAlpha = windowCount[i] > 0 ? sumAlpha[i] / windowCount[i] : 0;
    mixedAlpha[i] = Math.max(alphaFrac[i], averageAlpha) * 255;
  }
  return { mixedR, mixedG, mixedB, mixedAlpha };
}

// このPR(OEK-05-S04-BUG03)より前に保存されたBlurObjectには algorithm
// フィールドが無い。それらは以前と全く同じ見た目で読み込み・再エクスポート
// できるよう、旧Gaussian blur実装をそのまま残して使い続ける
// (Codexレビュー指摘: 新アルゴリズムへ暗黙に差し替えると既存作品の
// 見た目とサムネイルが無断で変わってしまう)。
function applyBlurGaussianLegacy(ctx: CanvasRenderingContext2D, blur: BlurObject, canvasWidth: number, canvasHeight: number) {
  if (!blur.points.length) return;
  const strength = Math.max(1, Math.min(20, blur.strength));
  const margin = blur.size / 2 + strength * 3 + 2;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of blur.points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }

  const sx = Math.max(0, Math.floor(minX - margin));
  const sy = Math.max(0, Math.floor(minY - margin));
  const ex = Math.min(canvasWidth, Math.ceil(maxX + margin));
  const ey = Math.min(canvasHeight, Math.ceil(maxY + margin));
  const width = Math.max(1, ex - sx);
  const height = Math.max(1, ey - sy);

  const blurred = getBlurSurface(width, height);
  const blurCtx = blurred.getContext('2d');
  const mask = getBlurMaskSurface(width, height);
  const maskCtx = mask.getContext('2d');
  if (!blurCtx || !maskCtx) return;

  blurCtx.save();
  blurCtx.clearRect(0, 0, width, height);
  blurCtx.globalAlpha = 1;
  blurCtx.globalCompositeOperation = 'source-over';
  blurCtx.filter = `blur(${strength}px)`;
  blurCtx.drawImage(ctx.canvas, sx, sy, width, height, 0, 0, width, height);
  blurCtx.filter = 'none';
  blurCtx.restore();

  maskCtx.clearRect(0, 0, width, height);
  drawBlurMask(maskCtx, blur, sx, sy);

  // ぼかしたコピーをブラシ形状だけ残す。
  blurCtx.save();
  blurCtx.globalCompositeOperation = 'destination-in';
  blurCtx.globalAlpha = 1;
  blurCtx.drawImage(mask, 0, 0);
  blurCtx.restore();

  // 元画素も同じマスクで消してから、ぼかした結果で置き換える。
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'destination-out';
  ctx.drawImage(mask, sx, sy);
  ctx.globalCompositeOperation = 'source-over';
  ctx.drawImage(blurred, sx, sy);
  ctx.restore();
}

// ぼかしは「透明度を薄めて台紙を透かす」のではなく、指でこすって隣接色
// 同士を混ぜる「スマッジ」として実装する。同一レイヤーの画素だけを対象に
// (他レイヤー・台紙はrenderLayerの時点で分離済み)、不透明画素の色だけを
// alpha加重平均で混ぜ、各画素自身のalpha(不透明度)は変えない。そのため
// 赤と青の境界をなぞると中間色(紫)が生まれる一方、透明領域や白い台紙が
// 色として混ぜ込まれたり、境界が白っぽく薄まったりすることがない。
// effect自体をDocumentへ保持するため、通常表示・Undo/Redo・途中保存・
// PNG exportで同じ結果を決定論的に再生できる。
function applyBlurSmudge(ctx: CanvasRenderingContext2D, blur: BlurObject, canvasWidth: number, canvasHeight: number) {
  if (!blur.points.length) return;
  const strength = Math.max(1, Math.min(20, blur.strength));
  const margin = blur.size / 2 + strength * 3 + 2;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of blur.points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }

  const sx = Math.max(0, Math.floor(minX - margin));
  const sy = Math.max(0, Math.floor(minY - margin));
  const ex = Math.min(canvasWidth, Math.ceil(maxX + margin));
  const ey = Math.min(canvasHeight, Math.ceil(maxY + margin));
  const width = Math.max(1, ex - sx);
  const height = Math.max(1, ey - sy);

  const mask = getBlurMaskSurface(width, height);
  const maskCtx = mask.getContext('2d');
  if (!maskCtx) return;
  maskCtx.clearRect(0, 0, width, height);
  drawBlurMask(maskCtx, blur, sx, sy);
  const maskData = maskCtx.getImageData(0, 0, width, height).data;

  const region = ctx.getImageData(sx, sy, width, height);
  const { mixedR, mixedG, mixedB, mixedAlpha } = smudgeColors(region, strength);

  const out = region.data;
  const pixelCount = width * height;
  for (let i = 0; i < pixelCount; i += 1) {
    const maskAlpha = maskData[i * 4 + 3] / 255;
    if (maskAlpha <= 0) continue;
    const o = i * 4;
    out[o] = out[o] + (mixedR[i] - out[o]) * maskAlpha;
    out[o + 1] = out[o + 1] + (mixedG[i] - out[o + 1]) * maskAlpha;
    out[o + 2] = out[o + 2] + (mixedB[i] - out[o + 2]) * maskAlpha;
    // alphaはmixedAlpha(=max(元のalpha, 近傍alphaの平均))へ寄せる。
    // 既存の不透明画素のalphaが下がることはなく、境界のすぐ隣の透明
    // 画素にだけ周囲の絵の具のalphaがにじむ。
    out[o + 3] = out[o + 3] + (mixedAlpha[i] - out[o + 3]) * maskAlpha;
  }
  ctx.putImageData(region, sx, sy);
}

function drawStamp(ctx: CanvasRenderingContext2D, object: Extract<DrawingObject, { type: 'stamp' }>) {
  ctx.save();
  ctx.translate(object.x, object.y);
  ctx.strokeStyle = object.color;
  ctx.fillStyle = object.color;
  ctx.lineWidth = Math.max(4, object.size * 0.08);

  if (object.stamp === 'heart') {
    const s = object.size / 2;
    ctx.beginPath();
    ctx.moveTo(0, s * 0.75);
    ctx.bezierCurveTo(-s * 1.3, 0, -s, -s, 0, -s * 0.3);
    ctx.bezierCurveTo(s, -s, s * 1.3, 0, 0, s * 0.75);
    ctx.fill();
  } else if (object.stamp === 'star') {
    const outer = object.size / 2;
    const inner = outer * 0.45;
    ctx.beginPath();
    for (let i = 0; i < 10; i += 1) {
      const r = i % 2 === 0 ? outer : inner;
      const angle = -Math.PI / 2 + (Math.PI * i) / 5;
      const x = Math.cos(angle) * r;
      const y = Math.sin(angle) * r;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fill();
  } else if (object.stamp === 'speech') {
    const w = object.size;
    const h = object.size * 0.65;
    ctx.beginPath();
    ctx.roundRect(-w / 2, -h / 2, w, h, 24);
    ctx.moveTo(w * 0.2, h / 2);
    ctx.lineTo(w * 0.05, h * 0.82);
    ctx.lineTo(-w * 0.02, h / 2);
    ctx.stroke();
  } else {
    const outer = object.size / 2;
    const inner = outer * 0.15;
    const lineCount = 16;
    ctx.lineWidth = Math.max(3, object.size * 0.04);
    for (let i = 0; i < lineCount; i += 1) {
      const angle = (Math.PI * 2 * i) / lineCount;
      const len = i % 2 === 0 ? outer : outer * 0.7;
      ctx.beginPath();
      ctx.moveTo(Math.cos(angle) * inner, Math.sin(angle) * inner);
      ctx.lineTo(Math.cos(angle) * len, Math.sin(angle) * len);
      ctx.stroke();
    }
  }
  ctx.restore();
}

function applyBlur(ctx: CanvasRenderingContext2D, blur: BlurObject, canvasWidth: number, canvasHeight: number) {
  if (blur.algorithm === 'smudge') applyBlurSmudge(ctx, blur, canvasWidth, canvasHeight);
  else applyBlurGaussianLegacy(ctx, blur, canvasWidth, canvasHeight);
}

function renderObject(ctx: CanvasRenderingContext2D, object: DrawingObject, width: number, height: number) {
  if (object.type === 'stroke') drawStroke(ctx, object);
  else if (object.type === 'blur') applyBlur(ctx, object, width, height);
  else drawStamp(ctx, object);
}

function renderLayer(ctx: CanvasRenderingContext2D, layer: DrawingLayer, width: number, height: number) {
  for (const object of layer.objects) renderObject(ctx, object, width, height);
}

function renderedLayerSurface(layer: DrawingLayer, width: number, height: number) {
  const entry = getLayerSurface(layer, width, height);
  if (entry.layerRef !== layer) {
    const ctx = entry.canvas.getContext('2d');
    if (ctx) {
      ctx.clearRect(0, 0, width, height);
      renderLayer(ctx, layer, width, height);
      entry.layerRef = layer;
    }
  }
  return entry.canvas;
}

function pruneLayerCache(document: DrawingDocument) {
  const liveIds = new Set(document.layers.map((layer) => layer.id));
  for (const layerId of layerSurfaces.keys()) {
    if (!liveIds.has(layerId)) layerSurfaces.delete(layerId);
  }
}

// ドラッグ中のライブpreviewは指の動きのたびにrenderDocumentが呼ばれ、
// そのたびに毎回previewCtxをまっさら(committed surfaceのコピー)から
// draftObjectsを再生する。ぼかし(スマッジ)はO(領域サイズ)のJS convolution
// であり、ネイティブのcanvas filterと違ってGPU合成されないため、ストローク
// が伸びるほど領域が育ち続けると指を動かすたびに際限なく重くなる
// (Codexレビュー指摘)。previewの間だけ、直近の点に絞った小さな領域で
// 計算する。commit時(onCommitBlur)には常に完全なpointsを使うため、
// 最終的な見た目・保存結果はこのトリミングの影響を受けない。
const MAX_LIVE_BLUR_PREVIEW_POINTS = 48;

function previewSafeDraftObject(object: DrawingObject): DrawingObject {
  if (object.type !== 'blur' || object.points.length <= MAX_LIVE_BLUR_PREVIEW_POINTS) return object;
  return { ...object, points: object.points.slice(-MAX_LIVE_BLUR_PREVIEW_POINTS) };
}

export function renderDocument(
  target: CanvasRenderingContext2D,
  document: DrawingDocument,
  // 通常のdraft(描画中の未コミットobject)は1件だが、ミラー描画モードでは
  // 「元のstroke」と「反転したstroke」の2件を同時にpreviewする必要があるため配列で受け取る。
  // exportPng/サムネイル生成では渡されない(=document layersのみが描かれ、
  // ガイド線などdraft由来の要素は一切含まれない)。
  draftObjects?: DrawingObject[] | null,
) {
  pruneLayerCache(document);
  target.clearRect(0, 0, document.width, document.height);
  drawTemplate(target, document.template, document.width, document.height);

  for (const layer of document.layers) {
    if (!layer.visible) continue;
    const surface = renderedLayerSurface(layer, document.width, document.height);
    target.save();
    target.globalAlpha = Math.max(0.1, Math.min(1, layer.opacity ?? 1));

    if (draftObjects && draftObjects.length > 0 && layer.id === document.activeLayerId) {
      const preview = getDraftSurface(document.width, document.height);
      const previewCtx = preview.getContext('2d');
      if (!previewCtx) {
        target.restore();
        continue;
      }
      previewCtx.clearRect(0, 0, document.width, document.height);
      previewCtx.globalCompositeOperation = 'source-over';
      previewCtx.globalAlpha = 1;
      previewCtx.drawImage(surface, 0, 0);
      for (const draftObject of draftObjects) {
        renderObject(previewCtx, previewSafeDraftObject(draftObject), document.width, document.height);
      }
      target.drawImage(preview, 0, 0);
    } else {
      target.drawImage(surface, 0, 0);
    }
    target.restore();
  }
}
