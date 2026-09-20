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

export type DrawingObject = StrokeObject | BlurObject | StampObject;

export type ToolMode = 'brush' | 'stamp' | 'eyedropper';

export const STAMP_SIZE = 96;
export const DEFAULT_BLUR_STRENGTH = 6;

export type DrawingLayer = {
  id: string;
  name: string;
  visible: boolean;
  locked: boolean;
  opacity: number;
  objects: DrawingObject[];
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
      { id: sketchId, name: 'したがき', visible: true, locked: false, opacity: 1, objects: [] },
      { id: colorId, name: 'いろぬり', visible: true, locked: false, opacity: 1, objects: [] },
      { id: lineId, name: 'せんが', visible: true, locked: false, opacity: 1, objects: [] },
    ],
  };
}
