import type { BlurObject, DrawingDocument, DrawingLayer, DrawingObject, ImageObject, StrokeObject } from '../domain/drawing';
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

function readyImageElement(src: string): HTMLImageElement | undefined {
  const img = imageElements.get(src);
  return img && img.complete && img.naturalWidth > 0 ? img : undefined;
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
  // One broken image (corrupt data, unlikely but not impossible after a
  // schema-tolerant restore) must not block the rest of the document from
  // exporting/rendering.
  await Promise.all(Array.from(sources).map((src) => preloadImageAsset(src).catch(() => undefined)));
}

// Returns the decoded element if ready, otherwise ensures decoding is under
// way and calls `onReady` once it completes, so the caller can trigger
// exactly one follow-up redraw instead of polling. The underlying Image may
// already have been created by an earlier, unrelated caller — e.g.
// preloadDocumentImages() warming the cache on session resume, whose own
// promise-based listener doesn't touch the canvas — so the `onReady`
// listener is attached on every call that finds the src not yet ready
// rather than only when this call is the one creating the Image. `once:
// true` still means each attached listener fires (and is removed) exactly
// once.
function getImageElement(src: string, onReady: () => void): HTMLImageElement | undefined {
  const ready = readyImageElement(src);
  if (ready) return ready;
  let img = imageElements.get(src);
  if (!img) {
    img = new Image();
    img.decoding = 'async';
    img.addEventListener('error', () => imageElements.delete(src), { once: true });
    imageElements.set(src, img);
    img.src = src;
  }
  img.addEventListener('load', onReady, { once: true });
  return undefined;
}

function drawImageObject(target: CanvasRenderingContext2D, object: ImageObject, box: ImageBox, onReady: () => void) {
  const img = getImageElement(object.src, onReady);
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

// ぼかしは「色を重ねる」のではなく、操作時点までの同一レイヤー画素を
// 局所領域だけblurしたコピーに置き換える。effect自体をDocumentへ保持するため、
// 通常表示・Undo/Redo・途中保存・PNG exportで同じ順序を決定論的に再生できる。
function applyBlur(ctx: CanvasRenderingContext2D, blur: BlurObject, canvasWidth: number, canvasHeight: number) {
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

export function renderDocument(
  target: CanvasRenderingContext2D,
  document: DrawingDocument,
  draftObject?: DrawingObject | null,
  imageSelection?: ImageSelection | null,
) {
  pruneLayerCache(document);
  target.clearRect(0, 0, document.width, document.height);
  drawTemplate(target, document.template, document.width, document.height);

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
      drawImageObject(target, object, box, () => renderDocument(target, document, draftObject, imageSelection));
    }

    const surface = renderedLayerSurface(layer, document.width, document.height);
    if (draftObject && layer.id === document.activeLayerId) {
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
      renderObject(previewCtx, draftObject, document.width, document.height);
      target.drawImage(preview, 0, 0);
    } else {
      target.drawImage(surface, 0, 0);
    }
    target.restore();
  }

  if (imageSelection) drawImageSelectionChrome(target, imageSelection);
}
