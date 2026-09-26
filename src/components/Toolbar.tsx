import type { BrushKind, ToolSettings } from '../domain/drawing';

const brushes: Array<{ key: BrushKind; icon: string; label: string }> = [
  { key: 'pen', icon: '✏️', label: 'ペン' },
  { key: 'pencil', icon: '✎', label: '鉛筆' },
  { key: 'brush', icon: '🖌️', label: '筆' },
  { key: 'marker', icon: '▰', label: 'マーカー' },
  { key: 'eraser', icon: '⌫', label: '消しゴム' },
  { key: 'blur', icon: '◌', label: 'ぼかし' },
  { key: 'rainbow', icon: '◐', label: '虹' },
  { key: 'neon', icon: '✦', label: 'ネオン' },
];

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

type Props = {
  settings: ToolSettings;
  setSettings: (next: ToolSettings) => void;
  mirrorEnabled: boolean;
  onToggleMirror: () => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onReturnToStart: () => void;
  onSaveDraft: () => void;
  onExportPng: () => void;
  saveState: SaveState;
};

export function Toolbar({ settings, setSettings, mirrorEnabled, onToggleMirror, canUndo, canRedo, onUndo, onRedo, onReturnToStart, onSaveDraft, onExportPng, saveState }: Props) {
  const setBrush = (brush: BrushKind) => setSettings({ ...settings, mode: 'brush', brush });
  const saveLabel = saveState === 'saving' ? '保存中' : saveState === 'saved' ? '保存済' : saveState === 'error' ? '再保存' : '保存';

  return (
    <header className="toolbar creative-toolbar" aria-label="描画ツール">
      <div className="primary-tools" aria-label="ペンの種類">
        {brushes.map((brush) => (
          <button
            key={brush.key}
            className={settings.mode === 'brush' && settings.brush === brush.key ? 'compact-tool active' : 'compact-tool'}
            onClick={() => setBrush(brush.key)}
            aria-pressed={settings.mode === 'brush' && settings.brush === brush.key}
            title={brush.label}
          >
            <span className="compact-tool-icon" aria-hidden="true">{brush.icon}</span>
            <span className="compact-tool-label">{brush.label}</span>
          </button>
        ))}

        <button
          type="button"
          className={mirrorEnabled ? 'compact-tool active' : 'compact-tool'}
          onClick={onToggleMirror}
          aria-pressed={mirrorEnabled}
          title="ミラーがき"
        >
          <span className="compact-tool-icon" aria-hidden="true">⇋</span>
          <span className="compact-tool-label">ミラー</span>
        </button>
      </div>

      <label className="compact-size-control">
        <span>{settings.brush === 'blur' && settings.mode === 'brush' ? 'ぼかす幅' : '太さ'} <strong>{settings.size}</strong></span>
        <input
          type="range"
          min="1"
          max="60"
          value={settings.size}
          onChange={(event) => setSettings({ ...settings, size: Number(event.target.value) })}
        />
      </label>

      <div className="toolbar-spacer" />

      <div className="creative-actions">
        <button className="text-action" onClick={onReturnToStart} disabled={saveState === 'saving'} aria-label="開始画面へ戻る">⌂ <span>もどる</span></button>
        <button className="icon-action" disabled={!canUndo} onClick={onUndo} aria-label="ひとつ戻る" title="戻る">↶</button>
        <button className="icon-action" disabled={!canRedo} onClick={onRedo} aria-label="やり直す" title="やり直す">↷</button>
        <button className="text-action primary" onClick={onSaveDraft} disabled={saveState === 'saving'}>⌑ <span>{saveLabel}</span></button>
        <button className="text-action" onClick={onExportPng}>⇩ <span>PNG</span></button>
      </div>
    </header>
  );
}
