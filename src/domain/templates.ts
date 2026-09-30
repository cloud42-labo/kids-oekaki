import type { MangaPresetKind, TemplateKind } from './drawing';

// コマ矩形は、外枠マージンを引いた「内側の作画エリア」に対する0..1の比率で
// 表現する。実ピクセルへの変換(outerMargin込み)はdrawPanelFramesで一箇所に
// まとめて行うため、プリセットの追加・調整はここの数値を変えるだけでよい。
export type PanelRect = { x: number; y: number; w: number; h: number };

export type MangaPresetDefinition = {
  key: MangaPresetKind;
  label: string;
  note: string;
  panels: PanelRect[];
};

// 外枠までの余白・コマ間のすき間の比率。drawPanelFrames（実際の描画）と
// e2eテスト（期待するコマ境界の位置を同じ式で再計算する）の両方から
// 参照される値なので、ここでexportしてどちらも重複定義しない。
export const PANEL_OUTER_MARGIN_RATIO = 0.045;
export const PANEL_LINE_WIDTH_RATIO = 0.006;
export const PANEL_LINE_WIDTH_MIN = 1.5;

// 少なくとも5種類の変則コマ割り + 従来の固定4コマ相当('grid-4')。
// AC記載の例（大1+小2、3段5コマ、左大+右上下、上横長+下左右、中央大+周囲小）を
// すべて含む。
export const MANGA_PRESETS: MangaPresetDefinition[] = [
  {
    key: 'grid-4',
    label: '4コマ',
    note: 'いつもの まんが',
    panels: [
      { x: 0, y: 0, w: 1, h: 0.2275 },
      { x: 0, y: 0.2575, w: 1, h: 0.2275 },
      { x: 0, y: 0.515, w: 1, h: 0.2275 },
      { x: 0, y: 0.7725, w: 1, h: 0.2275 },
    ],
  },
  {
    key: 'one-large-two-small',
    label: 'おおきい1+ちいさい2',
    note: 'だいじな ばめんを おおきく',
    panels: [
      { x: 0, y: 0, w: 1, h: 0.58 },
      { x: 0, y: 0.62, w: 0.48, h: 0.38 },
      { x: 0.52, y: 0.62, w: 0.48, h: 0.38 },
    ],
  },
  {
    key: 'three-rows-five-panels',
    label: '3だん5コマ',
    note: 'ながい おはなしに',
    panels: [
      { x: 0, y: 0, w: 0.48, h: 0.31 },
      { x: 0.52, y: 0, w: 0.48, h: 0.31 },
      { x: 0, y: 0.345, w: 1, h: 0.31 },
      { x: 0, y: 0.69, w: 0.48, h: 0.31 },
      { x: 0.52, y: 0.69, w: 0.48, h: 0.31 },
    ],
  },
  {
    key: 'left-large-right-stack',
    label: 'ひだり おおきい',
    note: 'みぎに 2つ',
    panels: [
      { x: 0, y: 0, w: 0.62, h: 1 },
      { x: 0.66, y: 0, w: 0.34, h: 0.48 },
      { x: 0.66, y: 0.52, w: 0.34, h: 0.48 },
    ],
  },
  {
    key: 'top-wide-bottom-split',
    label: 'うえ よこなが',
    note: 'したは 2つに わかれる',
    panels: [
      { x: 0, y: 0, w: 1, h: 0.46 },
      { x: 0, y: 0.5, w: 0.48, h: 0.5 },
      { x: 0.52, y: 0.5, w: 0.48, h: 0.5 },
    ],
  },
  {
    key: 'center-large-surround',
    label: 'まんなか おおきい',
    note: 'まわりを かこむ',
    panels: [
      { x: 0.24, y: 0, w: 0.52, h: 0.22 },
      { x: 0.24, y: 0.78, w: 0.52, h: 0.22 },
      { x: 0, y: 0.24, w: 0.22, h: 0.52 },
      { x: 0.78, y: 0.24, w: 0.22, h: 0.52 },
      { x: 0.26, y: 0.26, w: 0.48, h: 0.48 },
    ],
  },
];

export const DEFAULT_MANGA_PRESET: MangaPresetKind = 'grid-4';

export function getMangaPreset(key?: MangaPresetKind): MangaPresetDefinition {
  return MANGA_PRESETS.find((preset) => preset.key === key) ?? MANGA_PRESETS[0];
}

// コマ枠は、ユーザーが描く各レイヤーのobject（Undo/Redo・保存の対象）とは
// 完全に独立させ、renderDocument内でdrawTemplateとして毎回焼き込む。これにより
// 通常表示・PNG書き出し(exportPng)・サムネイル生成(documentStorage)のいずれでも
// 同じ枠線が出て、ユーザーの描画（消しゴム等）でコマ枠自体が消えることもない。
export function drawPanelFrames(ctx: CanvasRenderingContext2D, panels: PanelRect[], width: number, height: number) {
  const outerMargin = Math.min(width, height) * PANEL_OUTER_MARGIN_RATIO;
  const innerX = outerMargin;
  const innerY = outerMargin;
  const innerW = width - outerMargin * 2;
  const innerH = height - outerMargin * 2;

  ctx.lineWidth = Math.max(PANEL_LINE_WIDTH_MIN, Math.min(width, height) * PANEL_LINE_WIDTH_RATIO);
  for (const panel of panels) {
    ctx.strokeRect(
      innerX + panel.x * innerW,
      innerY + panel.y * innerH,
      panel.w * innerW,
      panel.h * innerH,
    );
  }
}

export function drawTemplate(
  ctx: CanvasRenderingContext2D,
  template: TemplateKind,
  width: number,
  height: number,
  mangaPreset?: MangaPresetKind,
) {
  ctx.save();
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = '#2a2530';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (template === 'manga') {
    drawPanelFrames(ctx, getMangaPreset(mangaPreset).panels, width, height);
  }

  // '4koma'は移行前(OEK-05-S04-T04以前)に保存された旧作品の後方互換値。
  // 新規作成では選べない。過去に保存済みの作品は、すでに描かれたstrokeが
  // 当時のfixed-50pxジオメトリのコマ位置を前提に保存されているため、
  // 'grid-4'の比率ベースdrawPanelFramesに乗せ換えると枠が絵とズレる
  // （移行前と移行後で外枠マージン・コマ間隔が変わるため）。
  // そのため'4koma'だけは、このタスク以前の実装と完全に同じ固定pxの
  // 描画式をそのまま残す(pixel-identicalであることが目的なので、
  // 将来ここを触るときもこの計算式自体は変更しないこと)。
  if (template === '4koma') {
    const margin = 50;
    const boxHeight = (height - margin * 5) / 4;
    ctx.lineWidth = 4;
    for (let i = 0; i < 4; i += 1) {
      ctx.strokeRect(margin, margin + (boxHeight + margin) * i, width - margin * 2, boxHeight);
    }
  }

  // 'diary'も同様に、絵日記モード廃止(OEK-05-S04-T04)前の旧作品を壊さないための
  // 後方互換のみの分岐。開始画面からは選べない。
  if (template === 'diary') {
    const margin = 50;
    const pictureHeight = height * 0.5;
    ctx.lineWidth = 4;
    ctx.strokeRect(margin, margin, width - margin * 2, pictureHeight);
    ctx.lineWidth = 2;
    for (let y = margin + pictureHeight + 50; y < height - margin; y += 60) {
      ctx.beginPath();
      ctx.moveTo(margin, y);
      ctx.lineTo(width - margin, y);
      ctx.stroke();
    }
  }

  ctx.restore();
}
