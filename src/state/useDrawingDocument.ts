import { useCallback, useState } from 'react';
import type { BlurObject, DrawingDocument, DrawingLayer, ImageObject, Orientation, StampObject, StrokeObject, TemplateKind } from '../domain/drawing';
import { createInitialDocument, ensureDraftLayer } from '../domain/drawing';

const MAX_HISTORY = 60;

export type DrawingHistory = {
  past: DrawingDocument[];
  present: DrawingDocument;
  future: DrawingDocument[];
};

function push(history: DrawingHistory, next: DrawingDocument): DrawingHistory {
  return {
    past: [...history.past, history.present].slice(-MAX_HISTORY),
    present: next,
    future: [],
  };
}

export function useDrawingDocument(initialTemplate: TemplateKind = 'blank') {
  const [history, setHistory] = useState<DrawingHistory>(() => ({
    past: [],
    present: createInitialDocument(initialTemplate),
    future: [],
  }));

  const reset = useCallback((template: TemplateKind, orientation: Orientation = 'portrait') => {
    setHistory({ past: [], present: createInitialDocument(template, orientation), future: [] });
  }, []);

  // Every past/present/future snapshot is migrated the same way (not just
  // present): undo/redo can bring back a pre-migration snapshot from a
  // document saved before draft layers existed, and importDraftImage always
  // reads h.present at call time, so an unmigrated snapshot reached via undo
  // would reintroduce the same misplaced-import bug. ensureDraftLayer is a
  // no-op for documents that already have a kind:'draft' layer.
  const restoreHistory = useCallback((saved: DrawingHistory) => {
    setHistory({
      past: saved.past.slice(-MAX_HISTORY).map(ensureDraftLayer),
      present: ensureDraftLayer(saved.present),
      future: saved.future.slice(0, MAX_HISTORY).map(ensureDraftLayer),
    });
  }, []);

  const selectLayer = useCallback((layerId: string) => {
    setHistory((h) => ({ ...h, present: { ...h.present, activeLayerId: layerId } }));
  }, []);

  // 複数のobjectを1回のhistory push(=1 Undo/Redo単位)でまとめて追加する。
  // ミラー描画で生成される「元のstroke」と「反転したstroke」のペアは、
  // これを使って1回のUndo/Redoで同時に消える/戻るようにする。
  const appendObjectsToActiveLayer = useCallback((objects: Array<StrokeObject | BlurObject | StampObject>) => {
    if (objects.length === 0) return;
    setHistory((h) => {
      const active = h.present.layers.find((layer) => layer.id === h.present.activeLayerId);
      if (!active || active.locked || !active.visible) return h;
      const layers = h.present.layers.map((layer) =>
        layer.id === h.present.activeLayerId ? { ...layer, objects: [...layer.objects, ...objects] } : layer,
      );
      return push(h, { ...h.present, layers });
    });
  }, []);

  const appendToActiveLayer = useCallback(
    (object: StrokeObject | BlurObject | StampObject) => appendObjectsToActiveLayer([object]),
    [appendObjectsToActiveLayer],
  );

  const commitStroke = useCallback((stroke: StrokeObject) => appendToActiveLayer(stroke), [appendToActiveLayer]);
  const commitBlur = useCallback((blur: BlurObject) => appendToActiveLayer(blur), [appendToActiveLayer]);
  const commitStamp = useCallback((stamp: StampObject) => appendToActiveLayer(stamp), [appendToActiveLayer]);
  // ミラー描画モード用: strokeとその反転strokeを1 Undo/Redo単位でコミットする。
  const commitMirroredStroke = useCallback(
    (stroke: StrokeObject, mirroredStroke: StrokeObject) => appendObjectsToActiveLayer([stroke, mirroredStroke]),
    [appendObjectsToActiveLayer],
  );

  // Imported photos always land in the layer marked kind:'draft' (the
  // したがき/"draft" layer created by createInitialDocument), regardless of
  // which layer is currently active — that's the layer meant to be traced
  // over. If it was deleted (a user can delete any layer down to the last
  // one), fall back to the active layer so import never silently no-ops.
  // The target layer is also made visible and selected so the new image
  // and its existing opacity/show-hide/delete controls are immediately at
  // hand (LayerPanel already exposes those per-layer, nothing new needed).
  const importDraftImage = useCallback((image: ImageObject) => {
    setHistory((h) => {
      const draftLayer = h.present.layers.find((layer) => layer.kind === 'draft');
      const targetId = draftLayer?.id ?? h.present.activeLayerId;
      const target = h.present.layers.find((layer) => layer.id === targetId);
      if (!target || target.locked) return h;
      const layers = h.present.layers.map((layer) =>
        layer.id === targetId ? { ...layer, visible: true, objects: [...layer.objects, image] } : layer,
      );
      return push(h, { ...h.present, layers, activeLayerId: targetId });
    });
  }, []);

  // Commits a reposition/scale gesture once it ends (see CanvasStage's
  // image-drag handling) — not on every pointermove, so dragging an image
  // around doesn't flood the undo stack with near-duplicate history entries
  // that would each carry a copy of its (already downscaled) data URL.
  const updateImageObject = useCallback((imageId: string, patch: Pick<ImageObject, 'x' | 'y' | 'width' | 'height'>) => {
    setHistory((h) => {
      let changed = false;
      const layers = h.present.layers.map((layer) => {
        if (!layer.objects.some((object) => object.id === imageId && object.type === 'image')) return layer;
        changed = true;
        return {
          ...layer,
          objects: layer.objects.map((object) =>
            object.id === imageId && object.type === 'image' ? { ...object, ...patch } : object,
          ),
        };
      });
      if (!changed) return h;
      return push(h, { ...h.present, layers });
    });
  }, []);

  const addLayer = useCallback(() => {
    setHistory((h) => {
      const layer: DrawingLayer = {
        id: crypto.randomUUID(),
        name: `レイヤー${h.present.layers.length + 1}`,
        visible: true,
        locked: false,
        opacity: 1,
        objects: [],
      };
      return push(h, {
        ...h.present,
        layers: [...h.present.layers, layer],
        activeLayerId: layer.id,
      });
    });
  }, []);

  const deleteActiveLayer = useCallback(() => {
    setHistory((h) => {
      if (h.present.layers.length <= 1) return h;
      const index = h.present.layers.findIndex((layer) => layer.id === h.present.activeLayerId);
      const layers = h.present.layers.filter((layer) => layer.id !== h.present.activeLayerId);
      const next = layers[Math.min(Math.max(index - 1, 0), layers.length - 1)];
      return push(h, { ...h.present, layers, activeLayerId: next.id });
    });
  }, []);

  const clearActiveLayer = useCallback(() => {
    setHistory((h) => {
      const active = h.present.layers.find((layer) => layer.id === h.present.activeLayerId);
      if (!active || active.objects.length === 0) return h;
      const layers = h.present.layers.map((layer) =>
        layer.id === h.present.activeLayerId ? { ...layer, objects: [] } : layer,
      );
      return push(h, { ...h.present, layers });
    });
  }, []);

  const toggleLayer = useCallback((layerId: string) => {
    setHistory((h) => {
      const layers = h.present.layers.map((layer) =>
        layer.id === layerId ? { ...layer, visible: !layer.visible } : layer,
      );
      return push(h, { ...h.present, layers });
    });
  }, []);

  const setActiveLayerOpacity = useCallback((opacity: number) => {
    setHistory((h) => {
      const nextOpacity = Math.max(0.1, Math.min(1, opacity));
      const active = h.present.layers.find((layer) => layer.id === h.present.activeLayerId);
      if (!active || Math.abs((active.opacity ?? 1) - nextOpacity) < 0.001) return h;
      const layers = h.present.layers.map((layer) =>
        layer.id === h.present.activeLayerId ? { ...layer, opacity: nextOpacity } : layer,
      );
      return push(h, { ...h.present, layers });
    });
  }, []);

  // 選択中レイヤーを配列内で1段前後へ入れ替える。配列の並びがそのまま
  // renderer/exportPngの描画順（後ろほど手前）になるため、これだけで
  // キャンバス上・PNG書き出しの両方に前後関係が反映される。
  const moveActiveLayer = useCallback((direction: 'up' | 'down') => {
    setHistory((h) => {
      const index = h.present.layers.findIndex((layer) => layer.id === h.present.activeLayerId);
      if (index < 0) return h;
      const targetIndex = direction === 'up' ? index + 1 : index - 1;
      if (targetIndex < 0 || targetIndex >= h.present.layers.length) return h;
      const layers = [...h.present.layers];
      [layers[index], layers[targetIndex]] = [layers[targetIndex], layers[index]];
      return push(h, { ...h.present, layers });
    });
  }, []);

  const undo = useCallback(() => {
    setHistory((h) => {
      if (!h.past.length) return h;
      const previous = h.past[h.past.length - 1];
      return { past: h.past.slice(0, -1), present: previous, future: [h.present, ...h.future] };
    });
  }, []);

  const redo = useCallback(() => {
    setHistory((h) => {
      if (!h.future.length) return h;
      const next = h.future[0];
      return {
        past: [...h.past, h.present].slice(-MAX_HISTORY),
        present: next,
        future: h.future.slice(1),
      };
    });
  }, []);

  return {
    document: history.present,
    historySnapshot: history,
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
    reset,
    restoreHistory,
    selectLayer,
    commitStroke,
    commitBlur,
    commitStamp,
    commitMirroredStroke,
    importDraftImage,
    updateImageObject,
    addLayer,
    deleteActiveLayer,
    clearActiveLayer,
    toggleLayer,
    setActiveLayerOpacity,
    moveActiveLayer,
    undo,
    redo,
  };
}
