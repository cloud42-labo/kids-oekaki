import { useEffect, useRef, useState, type ReactElement } from 'react';
import type { ChangeEvent } from 'react';
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

// OEK-05-S04-BUG02 review fix (2回目): CSSのorderだけで視覚順を変えると、
// DOM順（=キーボード/スイッチ操作のタブ順）は変わらないため、portrait用に
// orderを使えばlandscapeのタブ順がずれ、landscape用に使えばportraitの
// タブ順がずれるというイタチごっこになった（Codexレビュー指摘
// PRRT_kwDOUiR8RM6mYwYx, comment_id 4138644275）。
// portrait/landscapeで求める視覚順そのものが異なる
// （landscape: 戻る→Undo→Redo→保存→PNG、portrait: Undo→Redo→保存→PNG→戻る）
// ため、単一の静的なDOM順とCSS orderの組み合わせでは両方のタブ順を同時に
// 正しくできない。実際の画面の向き（viewport orientation）をJSで検知し、
// DOM順そのものを向きごとに並べ替えることで、どちらの向きでも
// 「DOM順 = 視覚順 = タブ順」を保証する。
function useIsPortraitViewport(): boolean {
  const getMatches = () => (typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia('(orientation: portrait)').matches : true);
  const [isPortrait, setIsPortrait] = useState(getMatches);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia('(orientation: portrait)');
    const handleChange = () => setIsPortrait(mql.matches);
    handleChange();
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', handleChange);
      return () => mql.removeEventListener('change', handleChange);
    }
    // 古いSafari向けフォールバック
    mql.addListener(handleChange);
    return () => mql.removeListener(handleChange);
  }, []);

  return isPortrait;
}

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
  onImportImage: (file: File) => void;
  hasDraftImage: boolean;
  isExportingPng: boolean;
  saveState: SaveState;
};

export function Toolbar({
  settings,
  setSettings,
  mirrorEnabled,
  onToggleMirror,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onReturnToStart,
  onSaveDraft,
  onExportPng,
  onImportImage,
  hasDraftImage,
  isExportingPng,
  saveState,
}: Props) {
  const isPortrait = useIsPortraitViewport();
  const imageInputRef = useRef<HTMLInputElement>(null);
  const setBrush = (brush: BrushKind) => setSettings({ ...settings, mode: 'brush', brush });
  const handleImageInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = ''; // allow re-selecting the same file next time
    if (file) onImportImage(file);
  };
  // Once a photo already exists on the draft layer, choosing any other tool
  // (a pen, a stamp, ...) moves settings.mode away from 'image' — after
  // that, without this branch, the only control this button had was "open
  // the file picker", so the already-imported photo could never be
  // reselected/moved/resized again short of importing a brand new one. When
  // one already exists, tapping the button instead just re-enters image
  // mode; opening the picker to import an *additional* photo is still one
  // tap away by tapping it again once already in that mode.
  const canReactivateImageMode = hasDraftImage && settings.mode !== 'image';
  const handleImageButtonClick = () => {
    if (canReactivateImageMode) {
      setSettings({ ...settings, mode: 'image' });
      return;
    }
    imageInputRef.current?.click();
  };
  const saveLabel = saveState === 'saving' ? '保存中' : saveState === 'saved' ? '保存済' : saveState === 'error' ? '再保存' : '保存';

  const actionButtons = {
    back: (
      <button key="back" className="text-action toolbar-action-back" onClick={onReturnToStart} disabled={saveState === 'saving'} aria-label="開始画面へ戻る">⌂ <span>もどる</span></button>
    ),
    undo: (
      <button key="undo" className="icon-action toolbar-action-undo" disabled={!canUndo} onClick={onUndo} aria-label="ひとつ戻る" title="戻る">↶</button>
    ),
    redo: (
      <button key="redo" className="icon-action toolbar-action-redo" disabled={!canRedo} onClick={onRedo} aria-label="やり直す" title="やり直す">↷</button>
    ),
    save: (
      <button key="save" className="text-action primary toolbar-action-save" onClick={onSaveDraft} disabled={saveState === 'saving'}>⌑ <span>{saveLabel}</span></button>
    ),
    png: (
      <button key="png" className="text-action toolbar-action-png" onClick={onExportPng} disabled={isExportingPng} aria-busy={isExportingPng}>
        {isExportingPng ? '⏳' : '⇩'} <span>{isExportingPng ? '保存中…' : 'PNG'}</span>
      </button>
    ),
  } satisfies Record<'back' | 'undo' | 'redo' | 'save' | 'png', ReactElement>;

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
          className={settings.mode === 'image' ? 'compact-tool active' : 'compact-tool'}
          onClick={handleImageButtonClick}
          title={canReactivateImageMode ? 'しゃしんをうごかす' : 'しゃしんをとりこむ'}
          aria-label={canReactivateImageMode ? 'したがきのしゃしんをうごかす' : 'したがきに しゃしんをとりこむ'}
        >
          <span className="compact-tool-icon" aria-hidden="true">🖼️</span>
          <span className="compact-tool-label">しゃしん</span>
        </button>
        <input
          ref={imageInputRef}
          type="file"
          accept="image/*"
          onChange={handleImageInputChange}
          style={{ display: 'none' }}
          aria-hidden="true"
          tabIndex={-1}
        />
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
        {/* OEK-05-S04-BUG02 review fix (2回目): portrait/landscapeで求める
           視覚順が異なる（landscape: 戻る→Undo→Redo→保存→PNG、
           portrait: Undo→Redo→保存→PNG→戻る）ため、CSSのorderで見た目だけ
           入れ替えるとどちらか一方のタブ順が必ず視覚順とずれる
           （Codexレビュー指摘 PRRT_kwDOUiR8RM6mYwYx, comment_id 4138644275）。
           useIsPortraitViewportで実際のviewport向きを検知し、DOM順そのものを
           向きごとに並べ替えることで、DOM順=視覚順=タブ順を両方の向きで保証
           する。CSS側（creative-ui.css）にはこの5要素へのorderを一切置かない。
           PNGボタンのisExportingPng対応(disabled/aria-busy/ラベル切替、
           OEK-05-S04-BUG01 #18でmain側に追加)はactionButtons.png側に統合済み。 */}
        {(isPortrait ? (['undo', 'redo', 'save', 'png', 'back'] as const) : (['back', 'undo', 'redo', 'save', 'png'] as const)).map((key) => actionButtons[key])}
      </div>
    </header>
  );
}
