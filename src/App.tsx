import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { CanvasStage } from './components/CanvasStage';
import { ColorPalette } from './components/ColorPalette';
import { LayerPanel } from './components/LayerPanel';
import { StartScreen } from './components/StartScreen';
import { Toolbar } from './components/Toolbar';
import type { Orientation, TemplateKind, ToolSettings } from './domain/drawing';
import { useDrawingDocument } from './state/useDrawingDocument';
import { deleteDrawingSession, listDrawingSessions, renameDrawingSession, saveDrawingSession } from './utils/documentStorage';
import type { StoredDrawingSession } from './utils/documentStorage';
import { exportPng } from './utils/exportPng';
import './save-resume.css';
import './creative-ui.css';

type SaveState = 'idle' | 'saving' | 'saved' | 'error';
const RECENT_COLORS_KEY = 'kids-oekaki-recent-colors';
const DEFAULT_SETTINGS: ToolSettings = {
  mode: 'brush',
  brush: 'pen',
  stampKind: 'heart',
  color: '#111111',
  size: 8,
};

function componentHex(value: number) {
  return Math.max(0, Math.min(255, value)).toString(16).padStart(2, '0');
}

export default function App() {
  const [started, setStarted] = useState(false);
  const [savedSessions, setSavedSessions] = useState<StoredDrawingSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [storageError, setStorageError] = useState<string>();
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const [recentColors, setRecentColors] = useState<string[]>(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(RECENT_COLORS_KEY) ?? '[]');
      return Array.isArray(stored) ? stored.filter((value): value is string => typeof value === 'string').slice(0, 8) : [];
    } catch {
      return [];
    }
  });
  const [settings, setSettings] = useState<ToolSettings>(DEFAULT_SETTINGS);
  const drawing = useDrawingDocument();

  useEffect(() => {
    try { localStorage.setItem(RECENT_COLORS_KEY, JSON.stringify(recentColors)); } catch { /* localStorage is optional */ }
  }, [recentColors]);

  useEffect(() => {
    let cancelled = false;
    void listDrawingSessions()
      .then((sessions) => {
        if (!cancelled) setSavedSessions(sessions);
      })
      .catch((error: unknown) => {
        if (!cancelled) setStorageError(error instanceof Error ? error.message : '保存した作品を読めませんでした');
      });
    return () => { cancelled = true; };
  }, []);

  const saveCurrent = (showProgress = true): Promise<boolean> => {
    if (!activeSessionId) return Promise.resolve(false);

    const sessionId = activeSessionId;
    const historySnapshot = drawing.historySnapshot;
    const settingsSnapshot = settings;
    const existingName = savedSessions.find((session) => session.id === sessionId)?.name;
    if (showProgress) setSaveState('saving');

    const operation = async () => {
      try {
        const session = await saveDrawingSession(sessionId, historySnapshot, settingsSnapshot, existingName);
        setSavedSessions((current) => [session, ...current.filter((item) => item.id !== session.id)]);
        setStorageError(undefined);
        if (showProgress) setSaveState('saved');
        return true;
      } catch {
        if (showProgress) setSaveState('error');
        setStorageError('保存できませんでした。いまの作品はそのままです。');
        return false;
      }
    };

    const queued = saveQueueRef.current.then(operation, operation);
    saveQueueRef.current = queued.then(() => undefined, () => undefined);
    return queued;
  };

  useEffect(() => {
    if (!started || !activeSessionId) return;
    setSaveState((current) => current === 'error' ? current : 'idle');
    const timer = window.setTimeout(() => { void saveCurrent(false); }, 1200);
    return () => window.clearTimeout(timer);
  }, [started, activeSessionId, drawing.historySnapshot, settings]);

  const start = (template: TemplateKind, orientation: Orientation) => {
    drawing.reset(template, orientation);
    setSettings(DEFAULT_SETTINGS);
    setActiveSessionId(crypto.randomUUID());
    setSaveState('idle');
    setStarted(true);
  };

  const continueSaved = (sessionId: string) => {
    const session = savedSessions.find((item) => item.id === sessionId);
    if (!session) return;
    drawing.restoreHistory(session.history);
    setSettings(session.settings ?? DEFAULT_SETTINGS);
    setActiveSessionId(session.id);
    setSaveState('saved');
    setStarted(true);
  };

  const returnToStart = async () => {
    if (!activeSessionId) {
      setStarted(false);
      return;
    }
    const saved = await saveCurrent(true);
    if (saved) setStarted(false);
  };

  const deleteSaved = async (sessionId: string) => {
    try {
      await deleteDrawingSession(sessionId);
      setSavedSessions((current) => current.filter((session) => session.id !== sessionId));
      if (activeSessionId === sessionId) setActiveSessionId(null);
      setStorageError(undefined);
    } catch {
      setStorageError('作品を削除できませんでした。');
    }
  };

  const renameSaved = async (sessionId: string, name: string) => {
    try {
      const renamed = await renameDrawingSession(sessionId, name);
      if (!renamed) return;
      setSavedSessions((current) => current.map((session) => session.id === sessionId ? renamed : session));
      setStorageError(undefined);
    } catch {
      setStorageError('作品の名前を変更できませんでした。');
    }
  };

  const applyColor = (color: string) => {
    const next = color.toLowerCase();
    setSettings((current) => ({
      ...current,
      color: next,
      mode: current.mode === 'eyedropper' ? 'brush' : current.mode,
      brush: current.brush === 'eraser' ? 'pen' : current.brush,
    }));
    setRecentColors((current) => [next, ...current.filter((item) => item.toLowerCase() !== next)].slice(0, 8));
  };

  const handleColorPick = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (settings.mode !== 'eyedropper') return;
    const target = event.target;
    if (!(target instanceof HTMLCanvasElement)) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = target.getBoundingClientRect();
    const x = Math.max(0, Math.min(target.width - 1, Math.floor(((event.clientX - rect.left) / rect.width) * target.width)));
    const y = Math.max(0, Math.min(target.height - 1, Math.floor(((event.clientY - rect.top) / rect.height) * target.height)));
    const ctx = target.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;
    const pixel = ctx.getImageData(x, y, 1, 1).data;
    const picked = pixel[3] === 0 ? '#ffffff' : `#${componentHex(pixel[0])}${componentHex(pixel[1])}${componentHex(pixel[2])}`;
    applyColor(picked);
  };

  if (!started) {
    return (
      <StartScreen
        onStart={start}
        onContinue={continueSaved}
        onDelete={(sessionId) => void deleteSaved(sessionId)}
        onRename={(sessionId, name) => void renameSaved(sessionId, name)}
        savedSessions={savedSessions}
        storageError={storageError}
      />
    );
  }

  return (
    <div className="app-shell creative-shell">
      <Toolbar
        settings={settings}
        setSettings={setSettings}
        canUndo={drawing.canUndo}
        canRedo={drawing.canRedo}
        onUndo={drawing.undo}
        onRedo={drawing.redo}
        onReturnToStart={() => void returnToStart()}
        onSaveDraft={() => void saveCurrent(true)}
        onExportPng={() => void exportPng(drawing.document)}
        saveState={saveState}
      />
      {storageError && <div className="save-error-banner" role="alert">⚠️ {storageError}</div>}
      <div className="workspace creative-workspace" onPointerDownCapture={handleColorPick}>
        <ColorPalette
          color={settings.color}
          recentColors={recentColors}
          eyedropperActive={settings.mode === 'eyedropper'}
          onColorChange={applyColor}
          onEyedropper={() => setSettings((current) => ({ ...current, mode: current.mode === 'eyedropper' ? 'brush' : 'eyedropper' }))}
        />
        <CanvasStage
          document={drawing.document}
          settings={settings}
          onCommitStroke={drawing.commitStroke}
          onCommitBlur={drawing.commitBlur}
          onCommitStamp={drawing.commitStamp}
        />
        <LayerPanel
          layers={drawing.document.layers}
          activeLayerId={drawing.document.activeLayerId}
          onSelect={drawing.selectLayer}
          onAdd={drawing.addLayer}
          onDelete={drawing.deleteActiveLayer}
          onToggle={drawing.toggleLayer}
          onClear={drawing.clearActiveLayer}
          onMove={drawing.moveActiveLayer}
          onOpacityChange={drawing.setActiveLayerOpacity}
        />
      </div>
    </div>
  );
}
