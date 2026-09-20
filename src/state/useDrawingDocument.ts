import { useCallback, useState } from 'react';
import type { BlurObject, DrawingDocument, DrawingLayer, Orientation, StampObject, StrokeObject, TemplateKind } from '../domain/drawing';
import { createInitialDocument } from '../domain/drawing';

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

  const restoreHistory = useCallback((saved: DrawingHistory) => {
    setHistory({
      past: saved.past.slice(-MAX_HISTORY),
      present: saved.present,
      future: saved.future.slice(0, MAX_HISTORY),
    });
  }, []);

  const selectLayer = useCallback((layerId: string) => {
    setHistory((h) => ({ ...h, present: { ...h.present, activeLayerId: layerId } }));
  }, []);

  const appendToActiveLayer = useCallback((object: StrokeObject | BlurObject | StampObject) => {
    setHistory((h) => {
      const active = h.present.layers.find((layer) => layer.id === h.present.activeLayerId);
      if (!active || active.locked || !active.visible) return h;
      const layers = h.present.layers.map((layer) =>
        layer.id === h.present.activeLayerId ? { ...layer, objects: [...layer.objects, object] } : layer,
      );
      return push(h, { ...h.present, layers });
    });
  }, []);

  const commitStroke = useCallback((stroke: StrokeObject) => appendToActiveLayer(stroke), [appendToActiveLayer]);
  const commitBlur = useCallback((blur: BlurObject) => appendToActiveLayer(blur), [appendToActiveLayer]);
  const commitStamp = useCallback((stamp: StampObject) => appendToActiveLayer(stamp), [appendToActiveLayer]);

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
