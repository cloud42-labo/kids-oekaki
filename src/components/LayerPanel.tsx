import type { DrawingLayer } from '../domain/drawing';

type Props = {
  layers: DrawingLayer[];
  activeLayerId: string;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onDelete: () => void;
  onToggle: (id: string) => void;
  onClear: () => void;
  onMove: (direction: 'up' | 'down') => void;
  onOpacityChange: (opacity: number) => void;
};

export function LayerPanel({ layers, activeLayerId, onSelect, onAdd, onDelete, onToggle, onClear, onMove, onOpacityChange }: Props) {
  const activeIndex = layers.findIndex((layer) => layer.id === activeLayerId);
  const activeLayer = activeIndex >= 0 ? layers[activeIndex] : undefined;
  const activeOpacity = activeLayer?.opacity ?? 1;
  // 配列の並び=描画順（後ろほど手前）。パネルは[...layers].reverse()で表示するため、
  // 「うえへ」＝配列の後ろ側(手前)へ、「したへ」＝配列の前側(奥)へ移動させる。
  const canMoveUp = activeIndex >= 0 && activeIndex < layers.length - 1;
  const canMoveDown = activeIndex > 0;

  return (
    <aside className="layer-panel" aria-label="レイヤー">
      <div className="layer-title"><span>📚 レイヤー</span><button onClick={onAdd}>＋</button></div>
      <div className="layer-list">
        {[...layers].reverse().map((layer) => (
          <div key={layer.id} className={layer.id === activeLayerId ? 'layer-row active' : 'layer-row'}>
            <button className="visibility" onClick={() => onToggle(layer.id)} aria-label={layer.visible ? 'かくす' : 'みせる'}>
              {layer.visible ? '👁️' : '🙈'}
            </button>
            <button className="layer-name" onClick={() => onSelect(layer.id)}>
              {layer.name} · {Math.round((layer.opacity ?? 1) * 100)}%
            </button>
          </div>
        ))}
      </div>
      <div className="layer-actions" aria-label="レイヤーの濃さ">
        <button onClick={() => onOpacityChange(0.35)} disabled={!activeLayer || Math.abs(activeOpacity - 0.35) < 0.01}>🪶 うすく</button>
        <button onClick={() => onOpacityChange(1)} disabled={!activeLayer || activeOpacity >= 0.999}>● ふつう</button>
      </div>
      <div className="layer-actions">
        <button onClick={() => onMove('up')} disabled={!canMoveUp} aria-label="このレイヤーを うえへ">⬆️ うえへ</button>
        <button onClick={() => onMove('down')} disabled={!canMoveDown} aria-label="このレイヤーを したへ">⬇️ したへ</button>
      </div>
      <div className="layer-actions">
        <button onClick={onClear}>🧹 ぜんぶけす</button>
        <button onClick={onDelete} disabled={layers.length <= 1}>🗑️ けす</button>
      </div>
    </aside>
  );
}
