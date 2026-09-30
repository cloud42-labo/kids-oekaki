import type { BlurObject, DrawingDocument, DrawingLayer, DrawingObject, ImageObject, Point, StrokeObject } from '../domain/drawing';
import { IMAGE_HANDLE_VISUAL_RADIUS } from '../domain/drawing';
import { drawTemplate } from '../domain/templates';

export type ImageBox = { x: number; y: number; width: number; height: number };
// While an image is selected (CanvasStage, 'image' tool mode), its box —
// live values during a drag/resize, or its committed values while idle —
// overrides the committed object and gets a selection outline + handle.
export type ImageSelection = ImageBox & { id: string };

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

// Imported photos are decoded once per src (data URL) and cached here,
// never re-decoded per frame. Unlike layerSurfaces this is keyed by the
// image bytes, not an object/layer id, so re-importing an identical photo
// (or undo/redo across history entries that share the same src string)
// reuses the same decoded element.
const imageElements = new Map<string, HTMLImageElement>();

// The redraw ("onReady") callbacks registered for a src that's still
// decoding — see getImageElement below. Keyed by src, then by the calling
// CanvasRenderingContext2D ("target"): the live editor canvas and an
// offscreen canvas such as documentStorage.ts's createThumbnail() can both
// be waiting on the same still-decoding image at once (e.g. autosave firing
// while a freshly restored photo is still decoding onto the editor), and
// each needs its own redraw to fire when decoding finishes — keying by src
// alone would let the second target's registration silently overwrite the
// first's, leaving that target blank until some unrelated document change.
// The outer Map having an entry for a src also doubles as "a `load`
// listener is already attached for this src", so callers never stack more
// than one *native* listener per source — it fans out to every registered
// target's callback when it fires, rather than adding a native listener per
// target.
const pendingRedraws = new Map<string, Map<CanvasRenderingContext2D, () => void>>();

// Ref-counts srcs that an in-flight preloadDocumentImages() call (PNG export,
// thumbnail generation) still needs, even if nothing in the *live* document
// references them any more by the time pruneImageCache runs. Without this, a
// still-decoding src can be evicted mid-preload by the live editor's own
// ordinary (pruning) render — e.g. the user clears the image, undoes the
// import, or switches documents while an export/thumbnail is awaiting the
// same src — and although the preload's own Image element still resolves
// (its 'load' listener is attached directly to that element, independent of
// this cache), the map entry callers look it up through is already gone.
// The { prune: false } offscreen render that follows then finds no ready
// element, starts a second decode from scratch, and serializes immediately
// without it (Codex review finding on PR #11, reviewed commit c43ce60a45).
// A ref count (not a boolean) is needed because more than one preload
// (export + thumbnail, or two overlapping exports) can be in flight for the
// same src at once. Set/cleared only by preloadDocumentImages() below, in a
// finally, so a rejected/aborted preload still releases its pin.
const pinnedImageSrcs = new Map<string, number>();

function pinImageSrc(src: string) {
  pinnedImageSrcs.set(src, (pinnedImageSrcs.get(src) ?? 0) + 1);
}

function unpinImageSrc(src: string) {
  const count = pinnedImageSrcs.get(src);
  if (count === undefined) return;
  if (count <= 1) pinnedImageSrcs.delete(src);
  else pinnedImageSrcs.set(src, count - 1);
}

function readyImageElement(src: string): HTMLImageElement | undefined {
  const img = imageElements.get(src);
  return img && img.complete && img.naturalWidth > 0 ? img : undefined;
}

// Drops decode-cache entries (and any still-pending redraw callback) for
// sources no longer referenced by any image object in `document`. Without
// this, every successful import/undo/delete/new-drawing leaves its decoded
// HTMLImageElement (up to ~10MB for a max-size photo) and data URL parked
// in imageElements for the rest of the app's lifetime, which adds up over a
// long session. Called on every renderDocument — same pattern as
// pruneLayerCache — so it stays in sync with whatever document is actually
// on screen; undo/redo across a src that's temporarily out of the present
// document just costs a re-decode if it comes back, which is cheap for a
// single reference photo.
//
// The two maps are pruned on *different* conditions, deliberately:
//
// - imageElements (the decoded element) is kept for a pinned src even once
//   it's unreachable from `document`, because an in-flight
//   preloadDocumentImages() consumer (PNG export, thumbnail generation) may
//   still need to find it ready once decoding finishes — see pinnedImageSrcs
//   above.
// - pendingRedraws is pruned by live-reachability alone, ignoring the pin.
//   Its entries are per-*target* "redraw me once ready" callbacks, and the
//   only target that ever registers one is a render that found the image
//   *not yet* decoded (getImageElement's not-ready branch) — a { prune:
//   false } offscreen render never does, because it only ever runs after
//   preloadDocumentImages() has already awaited the same src to readiness.
//   So the only realistic entries here belong to the *live* canvas's own
//   earlier render (e.g. right after resuming a session with a
//   still-decoding photo). If the user then clears/undoes that image before
//   decode finishes, the live canvas's next render no longer iterates over
//   that (now absent) ImageObject at all, so it never re-registers or
//   replaces its stale callback — which still closes over the *old*
//   document snapshot that had the photo. Leaving that stale callback alive
//   (e.g. by pinning it alongside imageElements) would fire it once decoding
//   completes and repaint the removed photo back onto the live canvas, even
//   though the document no longer contains it. Pruning pendingRedraws
//   unconditionally here is what discards that stale callback instead.
function pruneImageCache(document: DrawingDocument) {
  const liveSrcs = new Set<string>();
  for (const layer of document.layers) {
    for (const object of layer.objects) {
      if (object.type === 'image') liveSrcs.add(object.src);
    }
  }
  for (const src of imageElements.keys()) {
    if (!liveSrcs.has(src) && !pinnedImageSrcs.has(src)) {
      imageElements.delete(src);
    }
  }
  for (const src of pendingRedraws.keys()) {
    if (!liveSrcs.has(src)) {
      pendingRedraws.delete(src);
    }
  }
}

// Starts (or reuses) decoding `src` and resolves once it can be drawn.
// Used directly by utils/exportPng.ts so export never races a cold cache.
export function preloadImageAsset(src: string): Promise<void> {
  const existing = readyImageElement(src);
  if (existing) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let img = imageElements.get(src);
    if (!img) {
      img = new Image();
      img.decoding = 'async';
      imageElements.set(src, img);
      img.src = src;
    }
    img.addEventListener('load', () => resolve(), { once: true });
    img.addEventListener('error', () => {
      imageElements.delete(src);
      reject(new Error('画像を読み込めませんでした'));
    }, { once: true });
  });
}

export async function preloadDocumentImages(document: DrawingDocument): Promise<void> {
  const sources = new Set<string>();
  for (const layer of document.layers) {
    for (const object of layer.objects) {
      if (object.type === 'image') sources.add(object.src);
    }
  }
  // Pin every source for the whole await below, not just while this
  // function's own promise is pending on it — the live editor's ordinary
  // (pruning) render can run at any point during this await (a user action
  // dispatches a document mutation, e.g. clearing/undoing the image or
  // switching documents, while this caller is still awaiting decode), and
  // without a pin it would evict a src no longer reachable from *that* live
  // document even though the caller here (PNG export, thumbnail generation)
  // still needs it once decoding finishes. See pinnedImageSrcs/
  // pruneImageCache above.
  for (const src of sources) pinImageSrc(src);
  try {
    // One broken image (corrupt data, unlikely but not impossible after a
    // schema-tolerant restore) must not block the rest of the document from
    // exporting/rendering.
    await Promise.all(Array.from(sources).map((src) => preloadImageAsset(src).catch(() => undefined)));
  } finally {
    for (const src of sources) unpinImageSrc(src);
  }
}

// Returns the decoded element if ready, otherwise ensures decoding is under
// way and calls `onReady` once it completes, so the caller can trigger
// exactly one follow-up redraw instead of polling. The underlying Image may
// already have been created by an earlier, unrelated caller — e.g.
// preloadDocumentImages() warming the cache on session resume, whose own
// promise-based listener doesn't touch the canvas — so a redraw callback is
// tracked on every call that finds the src not yet ready, rather than only
// when this call is the one creating the Image (regressing the "restored
// image never redraws" fix). But while a cold image is decoding, every
// render of it reaches this function again — moving the selection chrome
// alone can call it many times a second — so a *native* `load` listener is
// only ever attached once per src (guarded by pendingRedraws already having
// an entry for it); each subsequent call from the *same* target just
// replaces that target's own pending callback with its own, more current
// one. Calls from a *different* target (e.g. the live editor canvas vs.
// documentStorage.ts's createThumbnail() offscreen canvas, both waiting on
// the same still-decoding src) register alongside it instead of overwriting
// it, so every distinct target that asked gets its own redraw fired once
// decoding finishes — without reintroducing a native listener per target.
function getImageElement(target: CanvasRenderingContext2D, src: string, onReady: () => void): HTMLImageElement | undefined {
  const ready = readyImageElement(src);
  if (ready) return ready;
  let img = imageElements.get(src);
  if (!img) {
    img = new Image();
    img.decoding = 'async';
    img.addEventListener('error', () => {
      imageElements.delete(src);
      pendingRedraws.delete(src);
    }, { once: true });
    imageElements.set(src, img);
    img.src = src;
  }
  if (!pendingRedraws.has(src)) {
    pendingRedraws.set(src, new Map());
    img.addEventListener('load', () => {
      const callbacks = pendingRedraws.get(src);
      pendingRedraws.delete(src);
      callbacks?.forEach((callback) => callback());
    }, { once: true });
  }
  pendingRedraws.get(src)!.set(target, onReady);
  return undefined;
}

function drawImageObject(target: CanvasRenderingContext2D, object: ImageObject, box: ImageBox, onReady: () => void) {
  const img = getImageElement(target, object.src, onReady);
  if (!img) return; // not decoded yet — onReady triggers a follow-up render
  target.save();
  target.imageSmoothingEnabled = true;
  target.imageSmoothingQuality = 'high';
  target.drawImage(img, box.x, box.y, box.width, box.height);
  target.restore();
}

function drawImageSelectionChrome(target: CanvasRenderingContext2D, box: ImageBox) {
  target.save();
  target.globalAlpha = 1;
  target.setLineDash([10, 8]);
  target.lineWidth = 3;
  target.strokeStyle = '#3b82f6';
  target.strokeRect(box.x, box.y, box.width, box.height);
  target.setLineDash([]);

  target.beginPath();
  target.arc(box.x + box.width, box.y + box.height, IMAGE_HANDLE_VISUAL_RADIUS, 0, Math.PI * 2);
  target.fillStyle = '#3b82f6';
  target.fill();
  target.lineWidth = 3;
  target.strokeStyle = '#ffffff';
  target.stroke();
  target.restore();
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

// stroke.id由来の決定論的な擬似乱数(-1〜1)。Math.random()は使わない
// (通常表示・Undo/Redo・保存/再開・PNG exportのたびにDocumentから
// 再生されるため、都度違う値になると再生結果が一致しなくなる)。
function seededJitter(seed: string, index: number): number {
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) h = (h * 31 + seed.charCodeAt(i)) | 0;
  h = (h * 31 + index) | 0;
  h ^= h << 13;
  h ^= h >>> 17;
  h ^= h << 5;
  return ((h >>> 0) / 0xffffffff) * 2 - 1;
}

// 鉛筆: 単なる細い線ではなく、かすれ・濃淡のある画材感を出す。1本の
// ストロークを短いセグメントへ分割し、筆圧とseed由来の揺らぎで
// セグメントごとに太さ・濃さをわずかに変える(=紙に鉛筆の粒立ちが
// あるように見える)。
// fromSegment/toSegment(両端含む、セグメント番号=points[i]→points[i+1])を
// 絞ることで、ストローク全体ではなく一部の区間だけを描ける。省略時は
// 従来通り全区間(コミット・通常描画で使う経路)。鉛筆は各セグメントが
// seed起因のjitterのみに依存し、他セグメントの内容や合計点数に左右
// されないため、同じセグメントを何度描き直しても結果は変わらない
// (ライブpreviewの差分更新で末尾セグメントを再描画しても無害)。
function drawPencilStroke(
  ctx: CanvasRenderingContext2D,
  stroke: StrokeObject,
  fromSegment = 0,
  toSegment = stroke.points.length - 2,
) {
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.globalCompositeOperation = 'source-over';
  ctx.strokeStyle = stroke.color;
  ctx.fillStyle = stroke.color;

  const baseWidth = Math.max(1, stroke.size * 0.55);

  if (stroke.points.length === 1) {
    if (fromSegment > 0) { ctx.restore(); return; }
    const p = stroke.points[0];
    ctx.globalAlpha = 0.7;
    ctx.beginPath();
    ctx.arc(p.x, p.y, baseWidth / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }

  const start = Math.max(0, fromSegment);
  const end = Math.min(toSegment, stroke.points.length - 2);
  for (let i = start; i <= end; i += 1) {
    const a = stroke.points[i];
    const b = stroke.points[i + 1];
    const pressure = (a.pressure + b.pressure) / 2;
    const jitter = seededJitter(stroke.seed ?? stroke.id, i);
    ctx.globalAlpha = Math.max(0.35, Math.min(0.9, 0.55 + pressure * 0.3 + jitter * 0.12));
    ctx.lineWidth = Math.max(0.6, baseWidth * (0.75 + pressure * 0.25) + jitter * baseWidth * 0.15);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
  ctx.restore();
}

// 筆: 一定の線幅ではなく、筆圧に加えてストロークの穂先(始点・終点)へ
// 向けてだんだん細くなる抑揚をつける。単なる線幅違いのブラシと区別する。
// fromSegment/toSegment(両端含む)を絞ることで一部の区間だけを描ける。
// 省略時は従来通り全区間。筆はtaperFactorが「現在の総点数n」に依存する
// ため、末尾付近のセグメントは総点数が増えるたびに見た目(width)が
// 遡って変わり得る(TEXTURED_STROKE_RETOUCH_SEGMENTS参照)。既に
// taperFactorが1に収束した(=どちらの端からも十分離れた)古いセグメントは
// 再描画してもwidthが変わらないため、末尾付近だけを再描画すれば足りる。
function drawBrushStroke(
  ctx: CanvasRenderingContext2D,
  stroke: StrokeObject,
  fromSegment = 0,
  toSegment = stroke.points.length - 2,
) {
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.globalCompositeOperation = 'source-over';
  ctx.strokeStyle = stroke.color;
  ctx.fillStyle = stroke.color;
  ctx.globalAlpha = 1;

  const n = stroke.points.length;
  const baseWidth = Math.max(2, stroke.size);

  if (n === 1) {
    if (fromSegment > 0) { ctx.restore(); return; }
    const p = stroke.points[0];
    const width = baseWidth * (0.35 + p.pressure * 0.65);
    ctx.beginPath();
    ctx.arc(p.x, p.y, width / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }

  const taperPoints = Math.min(6, Math.max(2, Math.floor(n / 4)));
  const lastSegment = n - 2;
  const start = Math.max(0, fromSegment);
  const end = Math.min(toSegment, lastSegment);
  for (let i = start; i <= end; i += 1) {
    const a = stroke.points[i];
    const b = stroke.points[i + 1];
    const pressure = (a.pressure + b.pressure) / 2;
    const startTaper = Math.min(1, i / taperPoints);
    const endTaper = Math.min(1, (lastSegment - i) / taperPoints);
    const taperFactor = Math.min(startTaper, endTaper);
    const width = Math.max(1, baseWidth * (0.35 + pressure * 0.65) * (0.25 + 0.75 * taperFactor));
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
  ctx.restore();
}

function drawStroke(ctx: CanvasRenderingContext2D, stroke: StrokeObject) {
  if (stroke.points.length === 0) return;
  if (stroke.brush === 'rainbow') return drawRainbowStroke(ctx, stroke);
  if (stroke.brush === 'neon') return drawNeonStroke(ctx, stroke);
  if (stroke.brush === 'pencil') return drawPencilStroke(ctx, stroke);
  if (stroke.brush === 'brush') return drawBrushStroke(ctx, stroke);

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

// pointsを絞ることで、ストローク全体ではなく一部の区間だけのマスクを
// 描ける。ライブpreviewの差分更新(renderIncrementalBlurDraft参照)は、
// 既に処理済みの区間を毎フレーム描き直さないため、またその区間を空間的に
// 小さなchunkへ分割するために、blur.pointsの部分配列(あるいは補間点を
// 混ぜた一時配列)をここへ渡す。省略時は従来通りblur.points全体
// (コミット・旧保存データの再描画で使う経路、下のapplyBlur参照)。
function drawBlurMask(ctx: CanvasRenderingContext2D, points: Point[], size: number, offsetX: number, offsetY: number) {
  if (points.length === 0) return;
  ctx.save();
  ctx.strokeStyle = '#ffffff';
  ctx.fillStyle = '#ffffff';
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(1, size);

  if (points.length === 1) {
    const p = points[0];
    ctx.beginPath();
    ctx.arc(p.x - offsetX, p.y - offsetY, Math.max(0.5, size / 2), 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.beginPath();
    ctx.moveTo(points[0].x - offsetX, points[0].y - offsetY);
    for (let i = 1; i < points.length; i += 1) {
      ctx.lineTo(points[i].x - offsetX, points[i].y - offsetY);
    }
    ctx.stroke();
  }
  ctx.restore();
}

// pointsのbounding boxから処理対象の矩形(canvas座標のsx/sy + 幅高さ)を
// 計算する。pointsを絞るほど、ライブpreview1フレームあたりの処理量が
// その区間のbounding boxだけに収まる(ストローク全体の長さに比例しない)。
function computeBlurRegion(
  points: { x: number; y: number }[],
  size: number,
  strength: number,
  canvasWidth: number,
  canvasHeight: number,
) {
  const margin = size / 2 + strength * 3 + 2;
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

  const sx = Math.max(0, Math.floor(minX - margin));
  const sy = Math.max(0, Math.floor(minY - margin));
  const ex = Math.min(canvasWidth, Math.ceil(maxX + margin));
  const ey = Math.min(canvasHeight, Math.ceil(maxY + margin));
  return { sx, sy, width: Math.max(1, ex - sx), height: Math.max(1, ey - sy) };
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
function applyBlurGaussianLegacy(
  ctx: CanvasRenderingContext2D,
  points: Point[],
  size: number,
  rawStrength: number,
  canvasWidth: number,
  canvasHeight: number,
) {
  if (points.length === 0) return;
  const strength = Math.max(1, Math.min(20, rawStrength));
  const { sx, sy, width, height } = computeBlurRegion(points, size, strength, canvasWidth, canvasHeight);

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
  drawBlurMask(maskCtx, points, size, sx, sy);

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
function applyBlurSmudge(
  ctx: CanvasRenderingContext2D,
  points: Point[],
  size: number,
  rawStrength: number,
  canvasWidth: number,
  canvasHeight: number,
  // 近傍色のサンプリング元。省略時はctx自身(コミット時の1回限りの
  // 全区間処理はこれで従来通り)。ライブpreviewの差分更新では、書き込み
  // 先(ctx=アキュムレーションcanvas)とは別の、確定済みレイヤーの
  // 変更されないコピーを渡す(下のコメント参照)。
  sourceCtx: CanvasRenderingContext2D = ctx,
) {
  if (points.length === 0) return;
  const strength = Math.max(1, Math.min(20, rawStrength));
  const { sx, sy, width, height } = computeBlurRegion(points, size, strength, canvasWidth, canvasHeight);

  const mask = getBlurMaskSurface(width, height);
  const maskCtx = mask.getContext('2d');
  if (!maskCtx) return;
  maskCtx.clearRect(0, 0, width, height);
  drawBlurMask(maskCtx, points, size, sx, sy);
  const maskData = maskCtx.getImageData(0, 0, width, height).data;

  // 近傍色は常にsourceCtx(変更されない基準)から読む。書き込み先ctx自身
  // から読むと、既に自分が書き込んだ結果を次の入力にしてしまい、連続する
  // pointer移動がブラシ径より近い(=区間が重なる)ときにフレームを重ねる
  // たびに同じ領域が繰り返し平均化されて過剰に混ざっていく
  // (Codexレビュー指摘: pointer-up時のcommitは常に元のレイヤーから1回だけ
  // 計算するため、この「重ね掛け」されたpreviewはcommit結果と食い違い、
  // pointer-upの瞬間に見た目が大きく変わって見える)。sourceCtxから読んで
  // 計算した結果は区間・呼び出し回数によらず安定するため、同じ区間へ
  // 複数回書いても発散しない。
  const sourceRegion = sourceCtx.getImageData(sx, sy, width, height);
  const { mixedR, mixedG, mixedB, mixedAlpha } = smudgeColors(sourceRegion, strength);

  // ブレンド先は書き込み先ctxの「現在の」画素(他区間で既に描かれた結果を
  // 消さないため)。ctxとsourceCtxが同じ場合(コミット経路)は同じ
  // ImageDataを使い回して余分な読み出しを避ける。
  const target = ctx === sourceCtx ? sourceRegion : ctx.getImageData(sx, sy, width, height);
  const out = target.data;
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
  ctx.putImageData(target, sx, sy);
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

function applyBlur(
  ctx: CanvasRenderingContext2D,
  blur: BlurObject,
  canvasWidth: number,
  canvasHeight: number,
  // 省略時はblur.points全体(コミット・通常描画の経路)。ライブpreviewの
  // 差分更新では、blur.pointsの部分配列、あるいはそれに補間点を混ぜた
  // 一時配列を渡す(renderIncrementalBlurDraft参照)。渡す配列が実際の
  // blur.pointsと違っていても、size/strength/algorithmは常にblurオブジェクト
  // 自身の値を使う。
  points: Point[] = blur.points,
  sourceCtx: CanvasRenderingContext2D = ctx,
) {
  // 旧Gaussian blur実装はライブpreviewの差分更新から呼ばれることが無い
  // (新規draftは常にalgorithm:'smudge'。CanvasStage参照)ため、sourceCtxは
  // smudge側にのみ渡す。
  if (blur.algorithm === 'smudge') applyBlurSmudge(ctx, points, blur.size, blur.strength, canvasWidth, canvasHeight, sourceCtx);
  else applyBlurGaussianLegacy(ctx, points, blur.size, blur.strength, canvasWidth, canvasHeight);
}

function renderObject(ctx: CanvasRenderingContext2D, object: DrawingObject, width: number, height: number) {
  if (object.type === 'stroke') drawStroke(ctx, object);
  else if (object.type === 'blur') applyBlur(ctx, object, width, height);
  else if (object.type === 'stamp') drawStamp(ctx, object);
  // 'image' objects are intentionally never rasterized into the cached
  // layer surface — see the image-drawing loop in renderDocument below.
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

// ドラッグ中のライブpreviewは指の動きのたびにrenderDocumentが呼ばれる。
// ぼかし(スマッジ)はO(領域サイズ)のJS convolutionであり、ネイティブの
// canvas filterと違ってGPU合成されない。以前は毎フレームpreviewを
// committed surfaceへ丸ごとリセットしてから「直近の点に絞った」draftを
// 再生していたが、これは2つの問題を残した(Codexレビュー指摘、収束
// 再レビュー分):
//   (a) 「直近の点」は点の"個数"で絞っているだけで、1点あたりの移動距離
//       (=領域サイズ)は無制限のため、速く/大きく動かすフレームは依然
//       重くなり得る。
//   (b) 毎フレームcommitted surfaceへ戻すため、直近の点より前に既に
//       スマッジ済みだった部分が一瞬消えてから復元される「ちらつき」が
//       見える。
// そこで、ジェスチャー(1回のpointerdown〜pointerup)単位で永続する
// アキュムレーションcanvas(blurGestureCanvas)を持ち、フレームごとに
// 「前回まで処理済みの点数」から「今回までの点数」までの区間だけを
// applyBlur(range引数)で追記する。区間の始点は直前に処理した最後の点を
// 1つ含める(fromIndex = 前回処理済み点数 - 1)ことで、マスクの線が
// 前の区間と視覚的につながる。これにより1フレームあたりの処理量は
// その区間のbounding boxだけに比例し(ストローク全体の長さに依存せず)、
// かつ既に処理済みの見た目はアキュムレーションcanvas上に残り続けるため
// ちらつかない。commit時(onCommitBlur)は常にこのpreview経路を経由せず、
// layerSurfacesのキャッシュ無効化から完全なpointsで1回だけ再計算される
// ため、このインクリメンタル処理は最終的な見た目・保存結果に影響しない。
let blurGestureCanvas: HTMLCanvasElement | null = null;
function getBlurGestureCanvas(width: number, height: number) {
  if (!blurGestureCanvas) blurGestureCanvas = document.createElement('canvas');
  if (blurGestureCanvas.width !== width) blurGestureCanvas.width = width;
  if (blurGestureCanvas.height !== height) blurGestureCanvas.height = height;
  return blurGestureCanvas;
}

type BlurGestureState = {
  id: string;
  layerId: string;
  pointCount: number;
};
let blurGestureState: BlurGestureState | null = null;

// 1回のpointermoveイベントには、coalesced events(高精度スタイラス等)や、
// 低スペック端末でサンプリング間隔が空いた場合、まばらで互いに遠い点が
// 一度にまとめて追加され得る。新規区間[fromIndex,currentCount)をそのまま
// 1回のapplyBlurへ渡すと、その区間のbounding boxがcanvas全体に近い大きさ
// へ育つことがあり得る(Codexレビュー指摘: 新規点数は絞っていても、区間の
// 空間的な広がり自体は絞っていない)。
//
// 実点どうしの間隔がmaxExtentを超える場合、実点のindexで区切るだけでは
// 分割できない(間に他の点が無いため)。そこでまず区間全体を、隣接する
// 実点間の距離がmaxExtentを超える箇所へ補間点を挿入した折れ線
// (waypoints)へ展開してから、そのwaypoints列をbounding boxがmaxExtentを
// 超えないchunkへ分割する。補間点はマスク描画(このchunkの処理範囲を
// 区切るためだけ)に使う一時的な座標であり、blur.points(実際に保存される
// 座標列)自体には追加されない。chunk境界は前後で1点overlapさせ、
// フレーム間の継ぎ目(renderIncrementalBlurDraftのfromIndex参照)と同じ
// 考え方でマスクの線がchunk間で途切れないようにする。
const MAX_BLUR_PREVIEW_CHUNK_EXTENT = 300;

function buildInterpolatedWaypoints(points: Point[], fromIndex: number, toIndex: number, maxExtent: number): Point[] {
  const waypoints: Point[] = [points[fromIndex]];
  for (let i = fromIndex + 1; i < toIndex; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    const distance = Math.hypot(b.x - a.x, b.y - a.y);
    const steps = Math.max(1, Math.ceil(distance / maxExtent));
    for (let step = 1; step <= steps; step += 1) {
      waypoints.push(step === steps ? b : { ...b, x: a.x + (b.x - a.x) * (step / steps), y: a.y + (b.y - a.y) * (step / steps) });
    }
  }
  return waypoints;
}

function splitPointRangeIntoChunks(points: Point[], fromIndex: number, toIndex: number, maxExtent: number): Point[][] {
  if (toIndex <= fromIndex) return [];
  const waypoints = buildInterpolatedWaypoints(points, fromIndex, toIndex, maxExtent);

  const chunks: Point[][] = [];
  let chunkStart = 0;
  let minX = waypoints[0].x;
  let maxX = waypoints[0].x;
  let minY = waypoints[0].y;
  let maxY = waypoints[0].y;

  for (let i = 1; i < waypoints.length; i += 1) {
    const p = waypoints[i];
    const nextMinX = Math.min(minX, p.x);
    const nextMaxX = Math.max(maxX, p.x);
    const nextMinY = Math.min(minY, p.y);
    const nextMaxY = Math.max(maxY, p.y);
    if (nextMaxX - nextMinX > maxExtent || nextMaxY - nextMinY > maxExtent) {
      chunks.push(waypoints.slice(chunkStart, i));
      // 次のchunkは直前のwaypoint(i-1)と1点overlapさせて始める。
      chunkStart = i - 1;
      minX = Math.min(waypoints[chunkStart].x, p.x);
      maxX = Math.max(waypoints[chunkStart].x, p.x);
      minY = Math.min(waypoints[chunkStart].y, p.y);
      maxY = Math.max(waypoints[chunkStart].y, p.y);
    } else {
      minX = nextMinX;
      maxX = nextMaxX;
      minY = nextMinY;
      maxY = nextMaxY;
    }
  }
  chunks.push(waypoints.slice(chunkStart));
  return chunks;
}

// draftObjects(1件、blur型)を、進行中ジェスチャーのアキュムレーション
// canvasへ差分だけ追記して返す。呼び出し側はこのcanvasをそのまま
// (あるいは他のdraftObjectと合成してから)targetへdrawImageする。
function renderIncrementalBlurDraft(
  blurDraft: BlurObject,
  layerId: string,
  committedSurface: HTMLCanvasElement,
  width: number,
  height: number,
): HTMLCanvasElement {
  const canvas = getBlurGestureCanvas(width, height);
  const gctx = canvas.getContext('2d');
  // committedSurfaceはこのジェスチャー中ずっと変更されない(コミット済み
  // objectだけをrenderedLayerSurfaceがキャッシュしたもの)。近傍色を必ず
  // ここから読むことで、smudgeColorsの計算結果はどの区間・何回目の呼び出し
  // かによらず安定する(applyBlurSmudgeのsourceCtxコメント参照)。
  const sourceCtx = committedSurface.getContext('2d');
  if (!gctx || !sourceCtx) return committedSurface;

  const isSameGesture = blurGestureState?.id === blurDraft.id && blurGestureState.layerId === layerId;
  if (!isSameGesture) {
    gctx.clearRect(0, 0, width, height);
    gctx.globalCompositeOperation = 'source-over';
    gctx.globalAlpha = 1;
    gctx.drawImage(committedSurface, 0, 0);
    blurGestureState = { id: blurDraft.id, layerId, pointCount: 0 };
  }

  const previousCount = blurGestureState!.pointCount;
  const currentCount = blurDraft.points.length;
  if (currentCount > previousCount) {
    const fromIndex = Math.max(0, previousCount - 1);
    const chunks = splitPointRangeIntoChunks(blurDraft.points, fromIndex, currentCount, MAX_BLUR_PREVIEW_CHUNK_EXTENT);
    for (const chunkPoints of chunks) {
      applyBlur(gctx, blurDraft, width, height, chunkPoints, sourceCtx);
    }
    blurGestureState!.pointCount = currentCount;
  }
  return canvas;
}

// 鉛筆・筆はセグメントごとに太さ・濃さを変えるため、1本のstrokeを
// beginPath/stroke呼び出し複数回に分けて描く(通常のpen/markerは
// 1回のstroke呼び出しで済む)。ドラッグ中のライブpreviewは指の動きの
// たびにrenderDocumentが呼ばれる。以前は毎フレーム蓄積済みの全pointsを
// (直近の点数へ絞った上で)再生していたが、これは2つの問題を残した
// (Codexレビュー収束再レビュー指摘、renderer.tsのrenderIncrementalBlurDraft
// と同種の問題):
//   (a) 絞りは点の"個数"だけなので、トリミング窓に収まる間は依然として
//       毎フレーム最大48セグメント分を再描画しており、ストロークが伸びる
//       ほど処理コストが増え続けた。
//   (b) 毎フレームpreviewをcommitted surfaceへ丸ごとリセットしてから
//       トリミング後の点だけを再生するため、48点を超えた瞬間に始点側の
//       線が消えて見える(ちらつき)。
// ジェスチャー(1回のpointerdown〜pointerup)単位で永続するアキュムレー
// ションcanvas(texturedStrokeGestureCanvas)を持ち、フレームごとに
// 「前回までに描画済みのセグメント」から「今回までのセグメント」の
// 差分区間だけを追記する。筆はtaperFactorが現在の総点数に依存し末尾の
// 見た目が遡って変わり得るため、末尾付近(TEXTURED_STROKE_RETOUCH_
// SEGMENTS分)は毎フレーム描き直す。ただし描き直すのは筆(alpha=1)だけで、
// 鉛筆はセグメントごとにalpha<1で描くため重ね描きすると濃くなるので
// 描き直さない。commit時(onCommitStroke)は常にこのpreview経路を
// 経由せず、layerSurfacesのキャッシュ無効化から完全なpointsで1回だけ
// 再計算されるため、このインクリメンタル処理は最終的な見た目・保存結果
// に影響しない。
const TEXTURED_STROKE_RETOUCH_SEGMENTS = 6;

function isTexturedStrokeDraft(object: DrawingObject): object is StrokeObject {
  return object.type === 'stroke' && (object.brush === 'pencil' || object.brush === 'brush');
}

let texturedStrokeGestureCanvas: HTMLCanvasElement | null = null;
function getTexturedStrokeGestureCanvas(width: number, height: number) {
  if (!texturedStrokeGestureCanvas) texturedStrokeGestureCanvas = document.createElement('canvas');
  if (texturedStrokeGestureCanvas.width !== width) texturedStrokeGestureCanvas.width = width;
  if (texturedStrokeGestureCanvas.height !== height) texturedStrokeGestureCanvas.height = height;
  return texturedStrokeGestureCanvas;
}

type TexturedStrokeGestureState = {
  layerId: string;
  idsKey: string;
  pointCounts: Map<string, number>;
};
let texturedStrokeGestureState: TexturedStrokeGestureState | null = null;

// draftObjects中の鉛筆/筆draft(通常1件、ミラー描画モードでは元と反転の
// 2件)を、進行中ジェスチャーのアキュムレーションcanvasへ差分だけ追記して
// 返す。呼び出し側はこのcanvasをそのままtargetへdrawImageする。
function renderIncrementalTexturedStrokeDrafts(
  drafts: StrokeObject[],
  layerId: string,
  committedSurface: HTMLCanvasElement,
  width: number,
  height: number,
): HTMLCanvasElement {
  const canvas = getTexturedStrokeGestureCanvas(width, height);
  const gctx = canvas.getContext('2d');
  if (!gctx) return committedSurface;

  const idsKey = drafts.map((draft) => draft.id).sort().join(',');
  const isSameGesture = texturedStrokeGestureState?.layerId === layerId && texturedStrokeGestureState.idsKey === idsKey;
  if (!isSameGesture) {
    gctx.clearRect(0, 0, width, height);
    gctx.globalCompositeOperation = 'source-over';
    gctx.globalAlpha = 1;
    gctx.drawImage(committedSurface, 0, 0);
    texturedStrokeGestureState = { layerId, idsKey, pointCounts: new Map() };
  }

  for (const draft of drafts) {
    const previousCount = texturedStrokeGestureState!.pointCounts.get(draft.id) ?? 0;
    const currentCount = draft.points.length;
    if (currentCount <= previousCount) continue;
    if (currentCount < 2) continue; // 1点だけではまだセグメントが無い(commit時のみ点として描かれる)
    // 鉛筆はセグメントごとにalpha<1で描くため、描いた区間を重ねて描き直すと
    // preview中だけ線が濃くなり、確定時(各セグメントを1回だけ描く)に急に
    // 薄く変わってしまう。描き直すのは、alpha=1でtaperだけが変わる筆に限る。
    const retouchSegments = draft.brush === 'brush' ? TEXTURED_STROKE_RETOUCH_SEGMENTS : 0;
    const fromSegment = previousCount < 2 ? 0 : Math.max(0, (previousCount - 1) - retouchSegments);
    const toSegment = currentCount - 2;
    if (draft.brush === 'pencil') drawPencilStroke(gctx, draft, fromSegment, toSegment);
    else drawBrushStroke(gctx, draft, fromSegment, toSegment);
    texturedStrokeGestureState!.pointCounts.set(draft.id, currentCount);
  }
  return canvas;
}

export function renderDocument(
  target: CanvasRenderingContext2D,
  document: DrawingDocument,
  // 通常のdraft(描画中の未コミットobject)は1件だが、ミラー描画モードでは
  // 「元のstroke」と「反転したstroke」の2件を同時にpreviewする必要があるため配列で受け取る。
  // exportPng/サムネイル生成では渡されない(=document layersのみが描かれ、
  // ガイド線などdraft由来の要素は一切含まれない)。
  draftObjects?: DrawingObject[] | null,
  imageSelection?: ImageSelection | null,
  // pruneLayerCache/pruneImageCache key eviction on *this call's* document
  // alone — correct for the live editor canvas (CanvasStage), whose calls
  // always reflect the single document actually on screen, but wrong for a
  // one-off render of some *other* document (documentStorage.ts's
  // createThumbnail(), exportPng.ts): if that other document doesn't
  // reference a src the live editor is still mid-decode on (e.g. a
  // thumbnail regenerated for a different saved session while today's photo
  // import is still decoding), pruning here would evict that src's decode
  // cache entry — and the pending redraw callback registered for it — out
  // from under the live editor, which then never repaints on its own.
  // Callers rendering a document that isn't necessarily "the" live one pass
  // `{ prune: false }` to opt out; the live editor's own calls (both here in
  // CanvasStage's render effect) keep the default so normal eviction still
  // happens on every real document mutation.
  options?: { prune?: boolean },
) {
  if (options?.prune !== false) {
    pruneLayerCache(document);
    pruneImageCache(document);
  }
  target.clearRect(0, 0, document.width, document.height);
  drawTemplate(target, document.template, document.width, document.height, document.mangaPreset);

  for (const layer of document.layers) {
    if (!layer.visible) continue;
    target.save();
    target.globalAlpha = Math.max(0.1, Math.min(1, layer.opacity ?? 1));

    // Images draw fresh every frame, under this layer's other (rasterized)
    // content — a stroke drawn in the same layer, e.g. tracing directly on
    // top of an imported reference, should stay visible above it. This also
    // means a selected image can be dragged/resized (imageSelection
    // override) without re-rendering the layer's cached bitmap at all.
    for (const object of layer.objects) {
      if (object.type !== 'image') continue;
      const box: ImageBox = imageSelection && imageSelection.id === object.id ? imageSelection : object;
      // Forward `options` (in particular `prune`) to the follow-up redraw
      // this schedules once a cold src finishes decoding — otherwise a
      // { prune: false } caller (createThumbnail/exportPng) would still
      // prune with the default (true) once its callback eventually fires,
      // reintroducing the exact eviction race this option exists to avoid,
      // just deferred until decode completes instead of immediately.
      drawImageObject(target, object, box, () => renderDocument(target, document, draftObjects, imageSelection, options));
    }

    const surface = renderedLayerSurface(layer, document.width, document.height);
    const isActiveLayer = layer.id === document.activeLayerId;
    const blurDraft = isActiveLayer
      ? draftObjects?.find((object): object is BlurObject => object.type === 'blur')
      : undefined;
    const texturedDrafts = isActiveLayer ? (draftObjects?.filter(isTexturedStrokeDraft) ?? []) : [];

    if (blurDraft || texturedDrafts.length > 0) {
      // 進行中のジェスチャーはblurか鉛筆/筆のどちらか一方。どちらも、専用の
      // アキュムレーションcanvasへ差分だけ追記する増分previewを使う。
      // 残りのdraftObjects（ミラー描画の反転側など）は、その上から通常通り重ねる。
      let otherDrafts: DrawingObject[];
      let gestureCanvas: HTMLCanvasElement;
      if (blurDraft) {
        otherDrafts = draftObjects?.filter((object) => object !== blurDraft) ?? [];
        gestureCanvas = renderIncrementalBlurDraft(blurDraft, layer.id, surface, document.width, document.height);
      } else {
        otherDrafts = draftObjects?.filter((object) => !isTexturedStrokeDraft(object)) ?? [];
        gestureCanvas = renderIncrementalTexturedStrokeDrafts(texturedDrafts, layer.id, surface, document.width, document.height);
      }

      if (otherDrafts.length > 0) {
        const preview = getDraftSurface(document.width, document.height);
        const previewCtx = preview.getContext('2d');
        if (previewCtx) {
          previewCtx.clearRect(0, 0, document.width, document.height);
          previewCtx.globalCompositeOperation = 'source-over';
          previewCtx.globalAlpha = 1;
          previewCtx.drawImage(gestureCanvas, 0, 0);
          for (const other of otherDrafts) renderObject(previewCtx, other, document.width, document.height);
          target.drawImage(preview, 0, 0);
        } else {
          target.drawImage(gestureCanvas, 0, 0);
        }
      } else {
        target.drawImage(gestureCanvas, 0, 0);
      }
    } else {
      // このレイヤーで進行中だったblur / 鉛筆・筆ジェスチャーが無くなった
      // (コミット/キャンセルされた)ら、次回のブレを避けるため蓄積状態を破棄する。
      if (isActiveLayer && blurGestureState?.layerId === layer.id) blurGestureState = null;
      if (isActiveLayer && texturedStrokeGestureState?.layerId === layer.id) texturedStrokeGestureState = null;

      if (draftObjects && draftObjects.length > 0 && isActiveLayer) {
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
          renderObject(previewCtx, draftObject, document.width, document.height);
        }
        target.drawImage(preview, 0, 0);
      } else {
        target.drawImage(surface, 0, 0);
      }
    }
    target.restore();
  }

  if (imageSelection) drawImageSelectionChrome(target, imageSelection);
}
