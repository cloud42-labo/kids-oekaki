import { useEffect, useRef, useState, type ReactElement } from 'react';
import type { BrushKind, StampKind, ToolSettings } from '../domain/drawing';

const brushes: Array<{ key: BrushKind; icon: string; label: string }> = [
  { key: 'pen', icon: '✏️', label: 'ペン' },
  { key: 'marker', icon: '▰', label: 'マーカー' },
  { key: 'eraser', icon: '⌫', label: '消しゴム' },
  { key: 'blur', icon: '◌', label: 'ぼかし' },
  { key: 'rainbow', icon: '◐', label: '虹' },
  { key: 'neon', icon: '✦', label: 'ネオン' },
];

const stamps: Array<{ key: StampKind; icon: string; label: string }> = [
  { key: 'heart', icon: '♥', label: 'ハート' },
  { key: 'star', icon: '★', label: '星' },
  { key: 'speech', icon: '□', label: 'ふきだし' },
  { key: 'focus', icon: '✺', label: '集中線' },
];

const VIEWPORT_MARGIN = 8;

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
  saveState: SaveState;
};

export function Toolbar({ settings, setSettings, mirrorEnabled, onToggleMirror, canUndo, canRedo, onUndo, onRedo, onReturnToStart, onSaveDraft, onExportPng, saveState }: Props) {
  const toolbarRef = useRef<HTMLElement>(null);
  const stampMenuRef = useRef<HTMLDetailsElement>(null);
  const stampPopoverRef = useRef<HTMLDivElement>(null);
  const [stampPopoverPosition, setStampPopoverPosition] = useState({ top: 76, left: VIEWPORT_MARGIN });
  const isPortrait = useIsPortraitViewport();
  const setBrush = (brush: BrushKind) => setSettings({ ...settings, mode: 'brush', brush });
  const setStamp = (stampKind: StampKind) => {
    setSettings({ ...settings, mode: 'stamp', stampKind });
    if (stampMenuRef.current) stampMenuRef.current.open = false;
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
      <button key="png" className="text-action toolbar-action-png" onClick={onExportPng}>⇩ <span>PNG</span></button>
    ),
  } satisfies Record<'back' | 'undo' | 'redo' | 'save' | 'png', ReactElement>;

  const positionStampPopover = (details: HTMLDetailsElement) => {
    if (!details.open) return;
    const summary = details.querySelector('summary');
    const popover = stampPopoverRef.current;
    if (!summary || !popover) return;

    const anchorRect = summary.getBoundingClientRect();
    const popoverRect = popover.getBoundingClientRect();
    const viewportWidth = window.visualViewport?.width ?? window.innerWidth;
    const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
    const maxLeft = Math.max(VIEWPORT_MARGIN, viewportWidth - popoverRect.width - VIEWPORT_MARGIN);
    const maxTop = Math.max(VIEWPORT_MARGIN, viewportHeight - popoverRect.height - VIEWPORT_MARGIN);
    setStampPopoverPosition({
      left: Math.min(Math.max(anchorRect.left, VIEWPORT_MARGIN), maxLeft),
      top: Math.min(Math.max(anchorRect.bottom + 6, VIEWPORT_MARGIN), maxTop),
    });
  };

  useEffect(() => {
    const reposition = () => {
      const details = stampMenuRef.current;
      if (details?.open) positionStampPopover(details);
    };
    const toolbar = toolbarRef.current;
    window.addEventListener('resize', reposition);
    window.visualViewport?.addEventListener('resize', reposition);
    // OEK-05-S04-BUG02 review fix (3回目): scrollイベントはバブリングしないため、
    // 内側の実スクローラー(.primary-tools、狭幅portraitで横スクロールする)がscrollしても
    // toolbarRef(外側のheader)には届かない（Codexレビュー指摘 comment_id 4138732732）。
    // captureフェーズはバブリングと無関係に子孫まで伝播するため、captureで登録することで
    // どの子要素がスクロールしても検知できるようにする。
    toolbar?.addEventListener('scroll', reposition, { passive: true, capture: true });
    return () => {
      window.removeEventListener('resize', reposition);
      window.visualViewport?.removeEventListener('resize', reposition);
      toolbar?.removeEventListener('scroll', reposition, { capture: true });
    };
  }, []);

  return (
    <header ref={toolbarRef} className="toolbar creative-toolbar" aria-label="描画ツール">
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

        <details ref={stampMenuRef} className="stamp-menu" onToggle={(event) => positionStampPopover(event.currentTarget)}>
          <summary className={settings.mode === 'stamp' ? 'compact-tool active' : 'compact-tool'} title="スタンプ">
            <span className="compact-tool-icon">◆</span>
            <span className="compact-tool-label">スタンプ</span>
          </summary>
          <div ref={stampPopoverRef} className="stamp-popover" style={stampPopoverPosition}>
            {stamps.map((stamp) => (
              <button key={stamp.key} className={settings.mode === 'stamp' && settings.stampKind === stamp.key ? 'active' : ''} onClick={() => setStamp(stamp.key)}>
                <span>{stamp.icon}</span>{stamp.label}
              </button>
            ))}
          </div>
        </details>

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
           する。CSS側（creative-ui.css）にはこの5要素へのorderを一切置かない。 */}
        {(isPortrait ? (['undo', 'redo', 'save', 'png', 'back'] as const) : (['back', 'undo', 'redo', 'save', 'png'] as const)).map((key) => actionButtons[key])}
      </div>
    </header>
  );
}
