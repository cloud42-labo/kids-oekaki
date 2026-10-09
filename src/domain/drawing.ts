export const CANVAS_WIDTH = 800;
export const CANVAS_HEIGHT = 1131;

// 作品用紙の向き。端末の物理的な向きとは独立で、作品データ(Document)側が持つ。
// 端末を回転させても、これが変わらない限り描いた内容は回転・変形しない。
export type Orientation = 'portrait' | 'landscape';

// 'manga'が現行の漫画モード（複数の変則コマ割りプリセットから選択、mangaPresetで
// どのプリセットかを保持する）。'4koma'と'diary'は移行前に保存された旧作品を
// 読み込めるようにするためだけに残す後方互換値で、開始画面からは選べない
// （OEK-05-S04-T04: 絵日記を廃止し、固定4コマだったものをプリセットの1つ
// [MangaPresetKind = 'grid-4'] へ格上げした）。
// 'line-sticker'はLINEスタンプモード（OEK-05-S04-T03）で、背景を描かず透明PNGにする。
export type TemplateKind = 'blank' | 'manga' | '4koma' | 'diary' | 'line-sticker';

// 漫画モードのコマ割りプリセット。少なくとも5種類の変則コマ割り
// （+ 従来の固定4コマ相当の'grid-4'）を用意する。各プリセットの実際の
// コマ矩形定義はsrc/domain/templates.tsのMANGA_PRESETSにある
// （描画・サムネイル生成・エクスポートPNG・e2eテストが同じ定義を共有する）。
export type MangaPresetKind =
  | 'grid-4'
  | 'one-large-two-small'
  | 'three-rows-five-panels'
  | 'left-large-right-stack'
  | 'top-wide-bottom-split'
  | 'center-large-surround';

// LINEスタンプモード専用の判定。Owner確認(2026-09-26)のとおり、これは
// 「白背景を検出して透明化する」のではなく「このテンプレートでは背景レイヤー
// そのものを一切描画しない」という設計。未描画部分はcanvasをclearRectした
// ままのalpha=0を保つ。ユーザーが実際に白色で描いた線・文字・スタンプは
// 通常のsource-over描画でalpha=1の不透明な白として乗るため、透明化の対象には
// ならない（対象はあくまで「描かれていない領域」だけ）。
export function isTransparentBackgroundTemplate(template: TemplateKind): boolean {
  return template === 'line-sticker';
}
export type BrushKind = 'pen' | 'pencil' | 'brush' | 'marker' | 'eraser' | 'blur' | 'rainbow' | 'neon';

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
  // 鉛筆・筆のかすれ・抑揚はseededJitter(renderer.ts)でこの値から決定論的に
  // 導出する。idではなくseedを使う理由: ミラー描画で生まれる反転strokeは
  // Undo/Redo単位を揃えるため別idを持つ(mirrorStrokeAcrossAxis)が、
  // 見た目の対称性を保つには元storkeと同じ揺らぎパターンを共有する必要が
  // あるため。mirrorStrokeAcrossAxisは`...stroke`を展開するのでseedは
  // 自動的に引き継がれる。
  seed?: string;
};

// algorithmは新規ストロークではCanvasStage側で必ず'smudge'を設定する。
// このPRより前に保存されたDocumentのBlurObjectにはこのフィールドが無く、
// undefinedのまま読み込まれる。undefinedは明示的に「旧Gaussian blur実装」
// を指すものとして扱い、既存作品の見た目・再エクスポート結果を変えない
// (renderer.tsのapplyBlur参照)。
export type BlurObject = {
  id: string;
  type: 'blur';
  size: number;
  strength: number;
  points: Point[];
  algorithm?: 'gaussian' | 'smudge';
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
  // An "asset:<hash>" reference into IMAGE_ASSETS_STORE (utils/importImage.ts
  // stores the downscaled bytes there once via utils/imageAssetStore.ts), or
  // — for a document saved before that store existed — a legacy inline data
  // URL, which documentStorage.ts migrates into the asset store the next
  // time that session loads. Either way, resolve this through
  // utils/imageAssetStore.ts's resolveImageSrc() before treating it as
  // something an <img> element can decode directly (engine/renderer.ts
  // already does this).
  src: string;
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
  // template === 'manga' のときだけ意味を持つ。schema上は追加のoptionalフィールド
  // なのでSCHEMA_VERSIONは上げない（旧保存データにこのフィールドが無くても
  // documentStorage側は問題なく読める）。
  mangaPreset?: MangaPresetKind;
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

// ミラー描画モード: 中央軸(axisX、既定は canvas幅/2)を挟んで点を反転する。
// プレビュー(ライブ描画)とコミット(Undo/Redo履歴・保存・PNG書き出し)の
// 両方で必ずこの関数を通すことで、画面表示と保存結果が食い違わないようにする。
export function mirrorPointAcrossAxis(point: Point, axisX: number): Point {
  return { ...point, x: 2 * axisX - point.x };
}

export function mirrorStrokeAcrossAxis(stroke: StrokeObject, axisX: number): StrokeObject {
  return {
    ...stroke,
    id: id(),
    points: stroke.points.map((point) => mirrorPointAcrossAxis(point, axisX)),
  };
}

export function createInitialDocument(
  template: TemplateKind,
  orientation: Orientation = 'portrait',
  mangaPreset?: MangaPresetKind,
): DrawingDocument {
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
    mangaPreset: template === 'manga' ? (mangaPreset ?? 'grid-4') : undefined,
    activeLayerId: lineId,
    layers: [
      { id: sketchId, name: 'したがき', visible: true, locked: false, opacity: 1, objects: [], kind: 'draft' },
      { id: colorId, name: 'いろぬり', visible: true, locked: false, opacity: 1, objects: [] },
      { id: lineId, name: 'せんが', visible: true, locked: false, opacity: 1, objects: [] },
    ],
  };
}

// Documents saved before the draft-image-import feature landed have no
// layer carrying kind:'draft' at all (the field didn't exist yet), so a
// naive `layers.find(l => l.kind === 'draft')` fails for every one of them.
// Layer names are fixed at creation (createInitialDocument only, no rename
// UI — see components/LayerPanel.tsx) and never change afterward, so
// matching the したがき name is a reliable signal even after the user has
// reordered layers (moveActiveLayer swaps array positions) or deleted
// others.
//
// If that named layer itself was deleted (the user can delete any layer
// down to the last one), we deliberately do NOT tag any other layer as the
// draft — the bottom remaining layer could be genuine artwork the user
// drew, and tagging it kind:'draft' would let a later photo import's
// opacity/visibility/clear/delete controls corrupt that artwork, the exact
// class of bug this migration exists to prevent, just from a different
// angle. Leaving the marker absent is safe: importDraftImage already falls
// back to whichever layer is active at import time when it finds no
// kind:'draft' layer, so the photo still lands somewhere sensible without
// silently annexing an unrelated layer as if it were the draft layer.
// Called at every restore/resume so it applies regardless of when the
// document was originally saved; a no-op once a layer already carries
// kind: 'draft' (including brand-new documents).
export function ensureDraftLayer(document: DrawingDocument): DrawingDocument {
  if (document.layers.some((layer) => layer.kind === 'draft')) return document;
  const target = document.layers.find((layer) => layer.name === 'したがき');
  if (!target) return document;
  return {
    ...document,
    layers: document.layers.map((layer) => (layer.id === target.id ? { ...layer, kind: 'draft' as const } : layer)),
  };
}
