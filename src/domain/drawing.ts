export const CANVAS_WIDTH = 800;
export const CANVAS_HEIGHT = 1131;

// 作品用紙の向き。端末の物理的な向きとは独立で、作品データ(Document)側が持つ。
// 端末を回転させても、これが変わらない限り描いた内容は回転・変形しない。
export type Orientation = 'portrait' | 'landscape';

export type TemplateKind = 'blank' | '4koma' | 'diary';
export type BrushKind = 'pen' | 'marker' | 'eraser' | 'blur' | 'rainbow' | 'neon';

export type Point = {
  x: number;
  y: number;
  pressure: number;
};

export type StrokeObject = {
  id: string;
  type: 'stroke';
  brush: Exclude<BrushKind, 'blur'>;
  color: string;
  size: number;
  points: Point[];
};

export type BlurObject = {
  id: string;
  type: 'blur';
  size: number;
  strength: number;
  points: Point[];
};

export type StampKind = 'heart' | 'star' | 'speech' | 'focus';

export type StampObject = {
  id: string;
  type: 'stamp';
  stamp: StampKind;
  x: number;
  y: number;
  size: number;
  color: string;
};

// A photo/reference picture imported into a layer to trace over. Unlike
// strokes/stamps it is never rasterized into the layer's cached bitmap
// (see engine/renderer.ts) so it can be repositioned/scaled after import
// without re-rendering brush content. x/y is the top-left corner and
// width/height the displayed size, all in canvas coordinate space (same
// space as Point/StampObject) — independent of CanvasStage's viewport
// zoom/pan, which only affects how that space is presented on screen.
export type ImageObject = {
  id: string;
  type: 'image';
  src: string; // downscaled data URL — see utils/importImage.ts
  x: number;
  y: number;
  width: number;
  height: number;
};

export type DrawingObject = StrokeObject | BlurObject | StampObject | ImageObject;

export type ToolMode = 'brush' | 'stamp' | 'eyedropper' | 'image';

export const STAMP_SIZE = 96;
export const DEFAULT_BLUR_STRENGTH = 6;

// On-canvas resize handle for a selected ImageObject (engine/renderer.ts
// draws it, components/CanvasStage.tsx hit-tests against it). The hit
// radius is larger than the visual one for touch-friendliness.
export const IMAGE_HANDLE_VISUAL_RADIUS = 22;
export const IMAGE_HANDLE_HIT_RADIUS = 34;
export const IMAGE_MIN_SIZE = 40;

export type DrawingLayer = {
  id: string;
  name: string;
  visible: boolean;
  locked: boolean;
  opacity: number;
  objects: DrawingObject[];
  // Marks the layer new photo imports land in (see
  // useDrawingDocument#importDraftImage). Optional so older saved documents
  // (no layer had this field) still load — they fall back to whichever
  // layer is active at import time.
  kind?: 'draft';
};

export type DrawingDocument = {
  width: number;
  height: number;
  orientation: Orientation;
  template: TemplateKind;
  activeLayerId: string;
  layers: DrawingLayer[];
};

export type ToolSettings = {
  mode: ToolMode;
  brush: BrushKind;
  stampKind: StampKind;
  color: string;
  size: number;
};

const id = () => crypto.randomUUID();

export function createInitialDocument(template: TemplateKind, orientation: Orientation = 'portrait'): DrawingDocument {
  const sketchId = id();
  const colorId = id();
  const lineId = id();
  // portraitの短辺・長辺をlandscapeでは入れ替えるだけ。テンプレートの描画
  // (drawTemplate)はwidth/heightを引数で受け取る比例レイアウトのため、
  // 向きに関わらずそのまま適応する。
  const width = orientation === 'landscape' ? CANVAS_HEIGHT : CANVAS_WIDTH;
  const height = orientation === 'landscape' ? CANVAS_WIDTH : CANVAS_HEIGHT;

  return {
    width,
    height,
    orientation,
    template,
    activeLayerId: lineId,
    layers: [
      { id: sketchId, name: 'したがき', visible: true, locked: false, opacity: 1, objects: [], kind: 'draft' },
      { id: colorId, name: 'いろぬり', visible: true, locked: false, opacity: 1, objects: [] },
      { id: lineId, name: 'せんが', visible: true, locked: false, opacity: 1, objects: [] },
    ],
  };
}
