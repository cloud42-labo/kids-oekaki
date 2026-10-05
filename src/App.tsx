import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { CanvasStage } from './components/CanvasStage';
import { ColorPalette } from './components/ColorPalette';
import { LayerPanel } from './components/LayerPanel';
import { StartScreen } from './components/StartScreen';
import { Toolbar } from './components/Toolbar';
import type { ImageObject, MangaPresetKind, Orientation, TemplateKind, ToolSettings } from './domain/drawing';
import type { SelectionPoint } from './domain/selection';
import { preloadDocumentImages } from './engine/renderer';
import type { ImageBox } from './engine/renderer';
import { useDrawingDocument } from './state/useDrawingDocument';
import { deleteDrawingSession, listDrawingSessions, renameDrawingSession, saveDrawingSession } from './utils/documentStorage';
import type { StoredDrawingSession } from './utils/documentStorage';
import { exportPng } from './utils/exportPng';
import { loadDraftImageFile } from './utils/importImage';
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

// スタンプ作成UIを廃止したため、mode:'stamp'は選択不可能な状態になった。
// しかしstamp UI廃止より前に保存されたセッションはsettings.mode:'stamp'を
// そのまま持っている可能性があり、そのまま復元するとツールバーはどのボタン
// も選択されて見えないのにCanvasStageのpointerdownは(stamp分岐が無くなった
// ため)以前選んでいたbrush(消しゴム・ぼかし等の可能性がある)で描画して
// しまう(Codexレビュー指摘)。復元時にmode:'stamp'を安全なbrushへ
// 正規化する。
function normalizeRestoredSettings(settings: ToolSettings): ToolSettings {
  if (settings.mode !== 'stamp') return settings;
  return { ...settings, mode: 'brush', brush: 'pen' };
}

export default function App() {
  const [started, setStarted] = useState(false);
  const [savedSessions, setSavedSessions] = useState<StoredDrawingSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [storageError, setStorageError] = useState<string>();
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  // OEK-05-S04-BUG01: 下書き画像を含むPNG生成は数秒かかることがあり、その
  // 間タップしても画面に反応が無いため連打されやすい。処理中はボタンを
  // disabledにして多重実行を防ぐ。成功・失敗いずれもfinallyで必ず解除する。
  const [isExportingPng, setIsExportingPng] = useState(false);
  const [recentColors, setRecentColors] = useState<string[]>(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(RECENT_COLORS_KEY) ?? '[]');
      return Array.isArray(stored) ? stored.filter((value): value is string => typeof value === 'string').slice(0, 8) : [];
    } catch {
      return [];
    }
  });
  const [settings, setSettings] = useState<ToolSettings>(DEFAULT_SETTINGS);
  const [selectedImageId, setSelectedImageId] = useState<string | null>(null);
  // 投げ縄選択(settings.mode === 'selection')の確定済み範囲。mirrorEnabledと
  // 同じく、その場のUI状態としてのみ扱う(保存データのschemaには含めない)。
  // 選択を使って確定した色塗りだけがFillObjectとしてdrawing.documentへ残る。
  const [selectionPath, setSelectionPath] = useState<SelectionPoint[] | null>(null);
  const [imageImportError, setImageImportError] = useState<string>();
  // importImage() below decodes a picked photo asynchronously; if the user
  // returns to the start screen and opens/starts a different document before
  // that finishes, the stale result must not land in whatever document
  // happens to be active when it resolves. A ref (not the `activeSessionId`
  // captured in importImage's own closure) is required here because we need
  // the *latest* value at resolution time, not the value from when the
  // import began.
  //
  // The ref must not rely solely on this effect to stay current: React does
  // not flush passive effects synchronously after `setActiveSessionId`, so a
  // decode that resolves in the gap between that state update and this
  // effect running would still read the stale ref value and pass the
  // isStale() check. Every place that changes the active session therefore
  // also writes `activeSessionIdRef.current` synchronously (see
  // `setActiveSession` below); this effect remains only as a defensive
  // backstop for updates that might bypass that helper.
  const activeSessionIdRef = useRef(activeSessionId);
  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);
  // Sets `activeSessionId` state while also updating the ref synchronously
  // in the same call, so `importImage`'s stale check can never observe a
  // window where the state has moved on but the ref still holds the
  // previous session id.
  const setActiveSession = (sessionId: string | null) => {
    activeSessionIdRef.current = sessionId;
    setActiveSessionId(sessionId);
  };
  // ミラー描画モードはdocument/settingsの一部ではなく、その場のUI操作の
  // 状態としてのみ扱う(保存データのschemaには影響しない)。新規作成・
  // 続きから、どちらでも既定はOFFに戻す。
  const [mirrorEnabled, setMirrorEnabled] = useState(false);
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

  const start = (template: TemplateKind, orientation: Orientation, mangaPreset?: MangaPresetKind) => {
    drawing.reset(template, orientation, mangaPreset);
    setSettings(DEFAULT_SETTINGS);
    setSelectedImageId(null);
    setSelectionPath(null);
    setMirrorEnabled(false);
    setActiveSession(crypto.randomUUID());
    setSaveState('idle');
    setStarted(true);
  };

  const continueSaved = (sessionId: string) => {
    const session = savedSessions.find((item) => item.id === sessionId);
    if (!session) return;
    drawing.restoreHistory(session.history);
    setSettings(normalizeRestoredSettings(session.settings ?? DEFAULT_SETTINGS));
    setSelectedImageId(null);
    setSelectionPath(null);
    setMirrorEnabled(false);
    setActiveSession(session.id);
    setSaveState('saved');
    setStarted(true);
    // Warm the decode cache so any draft-layer photo is ready to paint on
    // the very first frame instead of popping in a moment later.
    void preloadDocumentImages(session.history.present);
  };

  const importImage = async (file: File) => {
    // Snapshot which document this import is for. Decoding is async (file
    // read + downscale), so the user can return to the start screen and
    // open/start a different document while it's in flight; importDraftImage
    // always applies to whatever document is current *when it's called*, so
    // without this check a slow decode could silently insert (and then
    // autosave) one session's chosen photo into an unrelated session.
    const sessionAtImport = activeSessionId;
    const isStale = () => activeSessionIdRef.current !== sessionAtImport;
    try {
      setImageImportError(undefined);
      const decoded = await loadDraftImageFile(file);
      if (isStale()) return;
      const maxWidth = drawing.document.width * 0.8;
      const maxHeight = drawing.document.height * 0.8;
      const scale = Math.min(maxWidth / decoded.naturalWidth, maxHeight / decoded.naturalHeight, 1);
      const width = decoded.naturalWidth * scale;
      const height = decoded.naturalHeight * scale;
      const image: ImageObject = {
        id: crypto.randomUUID(),
        type: 'image',
        src: decoded.src,
        x: (drawing.document.width - width) / 2,
        y: (drawing.document.height - height) / 2,
        width,
        height,
      };
      drawing.importDraftImage(image);
      setSelectedImageId(image.id);
      setSettings((current) => ({ ...current, mode: 'image' }));
    } catch (error) {
      if (isStale()) return;
      setImageImportError(error instanceof Error ? error.message : '画像をとりこめませんでした。');
    }
  };

  const updateImage = (id: string, box: ImageBox) => {
    drawing.updateImageObject(id, box);
  };

  // 投げ縄選択で確定した範囲(selectionPath)を現在の色で塗る。strokeや
  // blurと同じく1回のhistory push(=1 Undo/Redo単位)としてcommitFillへ
  // 渡すだけ。選択自体はFillを押した後も保持する(同じ範囲へ色を変えて
  // 重ね塗りできるよう、意図的に解除しない)――解除は「かいじょ」ボタン
  // (deselectSelection)でのみ行う。
  const fillSelection = () => {
    if (!selectionPath) return;
    drawing.commitFill({
      id: crypto.randomUUID(),
      type: 'fill',
      color: settings.color,
      path: selectionPath,
    });
  };

  const deselectSelection = () => setSelectionPath(null);

  // Whether the current document already has an imported photo anywhere —
  // drives Toolbar's photo button: once one exists, the button re-enters
  // image-edit mode to reselect/move/resize it instead of always reopening
  // the file picker (see Toolbar's onImportImage/hasDraftImage handling).
  const hasDraftImage = drawing.document.layers.some((layer) => layer.objects.some((object) => object.type === 'image'));

  const returnToStart = async () => {
    if (!activeSessionId) {
      setStarted(false);
      return;
    }
    const saved = await saveCurrent(true);
    if (saved) setStarted(false);
  };

  const handleExportPng = async () => {
    if (isExportingPng) return;
    setIsExportingPng(true);
    // exportPng()の最初の一歩(renderDocumentでcanvasへ描く処理)は同期実行
    // であり、下書き画像や長いストロークが多い作品では体感できるほど
    // 時間がかかることがある。setIsExportingPng(true)の直後にそのまま
    // exportPngへ入ると、ブラウザがdisabled/「保存中…」の再描画を行う
    // 前にその同期処理が走ってしまい、処理中表示が意味をなさない
    // (Codexレビュー指摘)。rAFを2回挟んで1描画フレーム分待ち、
    // 「保存中…」が実際に画面へ反映されてからexportPngへ入る。
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
    try {
      await exportPng(drawing.document);
    } finally {
      setIsExportingPng(false);
    }
  };

  const deleteSaved = async (sessionId: string) => {
    try {
      await deleteDrawingSession(sessionId);
      setSavedSessions((current) => current.filter((session) => session.id !== sessionId));
      if (activeSessionId === sessionId) setActiveSession(null);
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
        mirrorEnabled={mirrorEnabled}
        onToggleMirror={() => setMirrorEnabled((current) => !current)}
        canUndo={drawing.canUndo}
        canRedo={drawing.canRedo}
        onUndo={drawing.undo}
        onRedo={drawing.redo}
        onReturnToStart={() => void returnToStart()}
        onSaveDraft={() => void saveCurrent(true)}
        onExportPng={() => void handleExportPng()}
        isExportingPng={isExportingPng}
        onImportImage={(file) => void importImage(file)}
        hasDraftImage={hasDraftImage}
        saveState={saveState}
        hasSelection={!!selectionPath}
        onFillSelection={fillSelection}
        onDeselectSelection={deselectSelection}
      />
      {storageError && <div className="save-error-banner" role="alert">⚠️ {storageError}</div>}
      {imageImportError && <div className="save-error-banner" role="alert">⚠️ {imageImportError}</div>}
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
          mirrorEnabled={mirrorEnabled}
          onCommitStroke={drawing.commitStroke}
          onCommitBlur={drawing.commitBlur}
          onCommitMirroredStroke={drawing.commitMirroredStroke}
          selectedImageId={selectedImageId}
          onSelectImage={setSelectedImageId}
          onUpdateImage={updateImage}
          selectionPath={selectionPath}
          onSelectionChange={setSelectionPath}
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
