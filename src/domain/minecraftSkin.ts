// Minecraftスキン編集(OEK-05-S04-T10a)の基礎データモデル。
// Mojang公式の64×64スキンテクスチャが使う「ボックスの6面をUV上に展開する」
// 規則(top/bottom/right/front/left/back)をそのままコード化したもの。
// classic(腕4px幅)とslim(腕3px幅)の差分は腕のwidthだけで、
// 奥行き(depth)・高さ(height)・他の部位は共通。
//
// 2D(お絵かきcanvas)・3D(将来のビュー)の両方がこのモジュールの
// getSkinUVRect / listSkinRegions だけを参照し、座標表を別々に持たない。

export const SKIN_TEXTURE_SIZE = 64;

export type SkinVariant = 'classic' | 'slim';
export type SkinLayer = 'base' | 'overlay';
export type BodyPart = 'head' | 'body' | 'rightArm' | 'leftArm' | 'rightLeg' | 'leftLeg';
export type BoxFace = 'top' | 'bottom' | 'right' | 'front' | 'left' | 'back';

export const ALL_BODY_PARTS: readonly BodyPart[] = ['head', 'body', 'rightArm', 'leftArm', 'rightLeg', 'leftLeg'];
export const ALL_SKIN_LAYERS: readonly SkinLayer[] = ['base', 'overlay'];
export const ALL_BOX_FACES: readonly BoxFace[] = ['top', 'bottom', 'right', 'front', 'left', 'back'];

// overlay(帽子/ジャケット/半袖)は、ユーザーが明示的に描かない限り
// alpha=0のまま保つ。base layerと二重管理せず、layer種別だけで判定する。
export function isDefaultTransparentLayer(layer: SkinLayer): boolean {
  return layer === 'overlay';
}

export type UVRect = { x: number; y: number; width: number; height: number };

type BoxUV = { u: number; v: number; width: number; height: number; depth: number };

// Mojangの「箱の6面をテクスチャへ展開する」標準レイアウト。
// (u, v)を箱の左上原点として、以下の相対配置で6面が並ぶ:
//   行1: [ ][top   ][bottom][ ]
//   行2: [right][front][left][back]
// この並びはhead/body/arm/legすべてで共通で、widthとdepthの比率だけが
// 部位ごとに変わる(腕脚はdepth=4一定、widthだけclassic/slimで変わる)。
function faceRectsForBox({ u, v, width, height, depth }: BoxUV): Record<BoxFace, UVRect> {
  return {
    top: { x: u + depth, y: v, width, height: depth },
    bottom: { x: u + width + depth, y: v, width, height: depth },
    right: { x: u, y: v + depth, width: depth, height },
    front: { x: u + depth, y: v + depth, width, height },
    left: { x: u + width + depth, y: v + depth, width: depth, height },
    back: { x: u + width + depth * 2, y: v + depth, width, height },
  };
}

const ARM_DEPTH = 4;
const ARM_HEIGHT = 12;
const LEG_WIDTH = 4;
const LEG_HEIGHT = 12;
const LEG_DEPTH = 4;

function armWidth(variant: SkinVariant): number {
  return variant === 'slim' ? 3 : 4;
}

// 64×64スキンの各箱の(u, v, width, height, depth)。座標はMojang公式配置
// (Java版 EntityModel / 多くのビューワ実装と同一)。
function boxFor(part: BodyPart, layer: SkinLayer, variant: SkinVariant): BoxUV {
  const isBase = layer === 'base';
  switch (part) {
    case 'head':
      return { u: isBase ? 0 : 32, v: 0, width: 8, height: 8, depth: 8 };
    case 'body':
      return { u: 16, v: isBase ? 16 : 32, width: 8, height: 12, depth: 4 };
    case 'rightArm':
      return { u: 40, v: isBase ? 16 : 32, width: armWidth(variant), height: ARM_HEIGHT, depth: ARM_DEPTH };
    case 'leftArm':
      // classic/slim 64×64新フォーマットの左腕は右腕の鏡像ではなく、
      // 専用領域(v=48)を持つ。baseはu=32、overlayはu=48。
      return { u: isBase ? 32 : 48, v: 48, width: armWidth(variant), height: ARM_HEIGHT, depth: ARM_DEPTH };
    case 'rightLeg':
      return { u: 0, v: isBase ? 16 : 32, width: LEG_WIDTH, height: LEG_HEIGHT, depth: LEG_DEPTH };
    case 'leftLeg':
      // 左脚も同様に専用領域(v=48)。baseはu=16、overlayはu=0。
      return { u: isBase ? 16 : 0, v: 48, width: LEG_WIDTH, height: LEG_HEIGHT, depth: LEG_DEPTH };
    default: {
      const neverPart: never = part;
      throw new Error(`unknown body part: ${String(neverPart)}`);
    }
  }
}

export function getSkinUVRect(part: BodyPart, face: BoxFace, layer: SkinLayer, variant: SkinVariant = 'classic'): UVRect {
  return faceRectsForBox(boxFor(part, layer, variant))[face];
}

export type SkinRegion = { part: BodyPart; layer: SkinLayer; face: BoxFace; rect: UVRect };

// 2D/3D双方が「このvariantで塗れる領域は何か」を同じ一覧から得るための
// 単一の入口。座標表をコンポーネント側に複製させない。
export function listSkinRegions(variant: SkinVariant): SkinRegion[] {
  const regions: SkinRegion[] = [];
  for (const part of ALL_BODY_PARTS) {
    for (const layer of ALL_SKIN_LAYERS) {
      for (const face of ALL_BOX_FACES) {
        regions.push({ part, layer, face, rect: getSkinUVRect(part, face, layer, variant) });
      }
    }
  }
  return regions;
}

// テクスチャ上の1pxが、定義済みのどの面にも属さない「未使用領域」かどうか。
// 未使用領域は常に透明(未描画)として扱う(base/overlayに関わらず)。
export function isPixelInsideDefinedRegion(x: number, y: number, variant: SkinVariant): boolean {
  return listSkinRegions(variant).some(
    ({ rect }) => x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height,
  );
}
