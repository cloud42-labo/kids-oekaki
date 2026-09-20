import { useEffect, useRef, useState } from 'react';
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

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

type Props = {
  settings: ToolSettings;
  setSettings: (next: ToolSettings) => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onReturnToStart: () => void;
  onSaveDraft: () => void;
  onExportPng: () => void;
  saveState: SaveState;
};

export function Toolbar({ settings, setSettings, canUndo, canRedo, onUndo, onRedo, onReturnToStart, onSaveDraft, onExportPng, saveState }: Props) {
  const toolbarRef = useRef<HTMLElement>(null);
  const stampMenuRef = useRef<HTMLDetailsElement>(null);
  const stampPopoverRef = useRef<HTMLDivElement>(null);
  const [stampPopoverPosition, setStampPopoverPosition] = useState({ top: 76, left: VIEWPORT_MARGIN });
  const setBrush = (brush: BrushKind) => setSettings({ ...settings, mode: 'brush', brush });
  const setStamp = (stampKind: StampKind) => {
    setSettings({ ...settings, mode: 'stamp', stampKind });
    if (stampMenuRef.current) stampMenuRef.current.open = false;
  };
  const saveLabel = saveState === 'saving' ? '保存中' : saveState === 'saved' ? '保存済' : saveState === 'error' ? '再保存' : '保存';

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
    toolbar?.addEventListener('scroll', reposition, { passive: true });
    return () => {
      window.removeEventListener('resize', reposition);
      window.visualViewport?.removeEventListener('resize', reposition);
      toolbar?.removeEventListener('scroll', reposition);
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
