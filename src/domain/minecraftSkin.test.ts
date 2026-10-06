import { describe, expect, it } from 'vitest';
import {
  ALL_BODY_PARTS,
  ALL_BOX_FACES,
  ALL_SKIN_LAYERS,
  getSkinUVRect,
  isDefaultTransparentLayer,
  isPixelInsideDefinedRegion,
  listSkinRegions,
  SKIN_TEXTURE_SIZE,
  type SkinVariant,
} from './minecraftSkin';

// Golden fixture: 公式Mojang 64×64レイアウトの既知座標(複数の独立実装
// (skinview3d等)・公開資料で一致する値)。このテストが落ちたら、座標表自体が
// 変わったということなので、2D/3D双方の描画結果がズレる前に必ず気づけるようにする。
describe('getSkinUVRect — known Mojang 64x64 coordinates', () => {
  it('head (base layer)', () => {
    expect(getSkinUVRect('head', 'top', 'base')).toEqual({ x: 8, y: 0, width: 8, height: 8 });
    expect(getSkinUVRect('head', 'bottom', 'base')).toEqual({ x: 16, y: 0, width: 8, height: 8 });
    expect(getSkinUVRect('head', 'right', 'base')).toEqual({ x: 0, y: 8, width: 8, height: 8 });
    expect(getSkinUVRect('head', 'front', 'base')).toEqual({ x: 8, y: 8, width: 8, height: 8 });
    expect(getSkinUVRect('head', 'left', 'base')).toEqual({ x: 16, y: 8, width: 8, height: 8 });
    expect(getSkinUVRect('head', 'back', 'base')).toEqual({ x: 24, y: 8, width: 8, height: 8 });
  });

  it('head (overlay/hat layer)', () => {
    expect(getSkinUVRect('head', 'top', 'overlay')).toEqual({ x: 40, y: 0, width: 8, height: 8 });
    expect(getSkinUVRect('head', 'right', 'overlay')).toEqual({ x: 32, y: 8, width: 8, height: 8 });
    expect(getSkinUVRect('head', 'back', 'overlay')).toEqual({ x: 56, y: 8, width: 8, height: 8 });
  });

  it('body (base layer)', () => {
    expect(getSkinUVRect('body', 'top', 'base')).toEqual({ x: 20, y: 16, width: 8, height: 4 });
    expect(getSkinUVRect('body', 'front', 'base')).toEqual({ x: 20, y: 20, width: 8, height: 12 });
    expect(getSkinUVRect('body', 'right', 'base')).toEqual({ x: 16, y: 20, width: 4, height: 12 });
    expect(getSkinUVRect('body', 'back', 'base')).toEqual({ x: 32, y: 20, width: 8, height: 12 });
  });

  it('body (overlay/jacket layer)', () => {
    expect(getSkinUVRect('body', 'front', 'overlay')).toEqual({ x: 20, y: 36, width: 8, height: 12 });
  });

  it('right arm — classic (base layer)', () => {
    expect(getSkinUVRect('rightArm', 'top', 'base', 'classic')).toEqual({ x: 44, y: 16, width: 4, height: 4 });
    expect(getSkinUVRect('rightArm', 'front', 'base', 'classic')).toEqual({ x: 44, y: 20, width: 4, height: 12 });
    expect(getSkinUVRect('rightArm', 'right', 'base', 'classic')).toEqual({ x: 40, y: 20, width: 4, height: 12 });
    expect(getSkinUVRect('rightArm', 'back', 'base', 'classic')).toEqual({ x: 52, y: 20, width: 4, height: 12 });
  });

  it('right arm — slim only narrows width, not depth', () => {
    expect(getSkinUVRect('rightArm', 'front', 'base', 'slim')).toEqual({ x: 44, y: 20, width: 3, height: 12 });
    // side faces use depth (4), unaffected by slim
    expect(getSkinUVRect('rightArm', 'right', 'base', 'slim')).toEqual({ x: 40, y: 20, width: 4, height: 12 });
  });

  it('right leg (base layer)', () => {
    expect(getSkinUVRect('rightLeg', 'front', 'base')).toEqual({ x: 4, y: 20, width: 4, height: 12 });
    expect(getSkinUVRect('rightLeg', 'right', 'base')).toEqual({ x: 0, y: 20, width: 4, height: 12 });
  });

  it('left leg lives in its own v=48 region, not mirrored from right leg', () => {
    expect(getSkinUVRect('leftLeg', 'front', 'base')).toEqual({ x: 20, y: 52, width: 4, height: 12 });
    expect(getSkinUVRect('leftLeg', 'front', 'overlay')).toEqual({ x: 4, y: 52, width: 4, height: 12 });
  });

  it('left arm lives in its own v=48 region, not mirrored from right arm', () => {
    expect(getSkinUVRect('leftArm', 'front', 'base', 'classic')).toEqual({ x: 36, y: 52, width: 4, height: 12 });
    expect(getSkinUVRect('leftArm', 'front', 'overlay', 'classic')).toEqual({ x: 52, y: 52, width: 4, height: 12 });
  });
});

describe('isDefaultTransparentLayer', () => {
  it('overlay defaults to transparent, base does not', () => {
    expect(isDefaultTransparentLayer('overlay')).toBe(true);
    expect(isDefaultTransparentLayer('base')).toBe(false);
  });
});

describe('listSkinRegions — structural invariants', () => {
  const variants: SkinVariant[] = ['classic', 'slim'];

  it.each(variants)('%s: covers every part × layer × face exactly once', (variant) => {
    const regions = listSkinRegions(variant);
    expect(regions).toHaveLength(ALL_BODY_PARTS.length * ALL_SKIN_LAYERS.length * ALL_BOX_FACES.length);
    const keys = new Set(regions.map((r) => `${r.part}/${r.layer}/${r.face}`));
    expect(keys.size).toBe(regions.length);
  });

  it.each(variants)('%s: every rect stays within the 64x64 canvas', (variant) => {
    for (const { rect, part, face, layer } of listSkinRegions(variant)) {
      expect(rect.x, `${part}/${layer}/${face} x`).toBeGreaterThanOrEqual(0);
      expect(rect.y, `${part}/${layer}/${face} y`).toBeGreaterThanOrEqual(0);
      expect(rect.x + rect.width, `${part}/${layer}/${face} right edge`).toBeLessThanOrEqual(SKIN_TEXTURE_SIZE);
      expect(rect.y + rect.height, `${part}/${layer}/${face} bottom edge`).toBeLessThanOrEqual(SKIN_TEXTURE_SIZE);
      expect(rect.width, `${part}/${layer}/${face} width`).toBeGreaterThan(0);
      expect(rect.height, `${part}/${layer}/${face} height`).toBeGreaterThan(0);
    }
  });

  it('slim narrows only the arm depth-facing width, and never touches head/body/leg', () => {
    const classic = listSkinRegions('classic');
    const slim = listSkinRegions('slim');
    for (let i = 0; i < classic.length; i += 1) {
      const c = classic[i];
      const s = slim[i];
      const isArm = c.part === 'rightArm' || c.part === 'leftArm';
      if (!isArm) {
        expect(s.rect).toEqual(c.rect);
        continue;
      }
      // 'right' face is measured from the box origin (u, v+depth) and never
      // shifts with width, so it is the one anatomical face slim/classic share
      // byte-for-byte — any drift here would mean the UV formula itself broke.
      if (c.face === 'right') {
        expect(s.rect).toEqual(c.rect);
        continue;
      }
      // Every other face is positioned or sized from width, which differs
      // between slim(3) and classic(4); height always stays 12 regardless.
      expect(s.rect.height).toBe(c.rect.height);
      expect(s.rect).not.toEqual(c.rect);
    }
  });

  it('arm front face width matches the variant arm width (classic=4, slim=3)', () => {
    for (const part of ['rightArm', 'leftArm'] as const) {
      expect(getSkinUVRect(part, 'front', 'base', 'classic').width).toBe(4);
      expect(getSkinUVRect(part, 'front', 'base', 'slim').width).toBe(3);
    }
  });
});

describe('isPixelInsideDefinedRegion', () => {
  it('a pixel inside the head front face is defined', () => {
    expect(isPixelInsideDefinedRegion(10, 10, 'classic')).toBe(true);
  });

  it('the far top-right corner (outside every box) is undefined/unused space', () => {
    expect(isPixelInsideDefinedRegion(63, 0, 'classic')).toBe(false);
  });

  it('every defined rect corner pixel resolves as inside for both variants', () => {
    for (const variant of ['classic', 'slim'] as SkinVariant[]) {
      for (const { rect } of listSkinRegions(variant)) {
        expect(isPixelInsideDefinedRegion(rect.x, rect.y, variant)).toBe(true);
      }
    }
  });
});
