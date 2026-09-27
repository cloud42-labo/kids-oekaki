import { useEffect, useRef, useState } from 'react';
import type { MangaPresetKind, Orientation, TemplateKind } from '../domain/drawing';
import { CANVAS_HEIGHT, CANVAS_WIDTH } from '../domain/drawing';
import { drawTemplate, MANGA_PRESETS } from '../domain/templates';
import type { StoredDrawingSession } from '../utils/documentStorage';

// 開始画面の主要選択肢。OEK-05-S04-T04で絵日記を廃止し、白紙/漫画/LINEスタンプの
// 3択へ整理した。LINEスタンプはOEK-05-S04-T03側で別途実装される予定のため、
// ここでは「近日公開」として選択できない枠だけを用意し、後続タスクが有効化
// できるようにする（このタスクではLINEスタンプ機能そのものは実装しない）。
type MainChoice = {
  key: TemplateKind | 'line-sticker';
  icon: string;
  label: string;
  note: string;
  disabled?: boolean;
};

const mainChoices: MainChoice[] = [
  { key: 'blank', icon: '🖍️', label: 'まっしろ', note: 'じゆうに かこう' },
  { key: 'manga', icon: '💬', label: 'まんが', note: 'コマを えらんで つくろう' },
  { key: 'line-sticker', icon: '🏷️', label: 'LINEスタンプ', note: 'ちかぢか つかえます', disabled: true },
];

const orientations: Array<{ key: Orientation; icon: string; label: string; note: string }> = [
  { key: 'portrait', icon: '📱', label: 'たて', note: 'たてながの かみ' },
  { key: 'landscape', icon: '🖼️', label: 'よこ', note: 'よこながの かみ' },
];

const THUMB_WIDTH = 104;
const THUMB_HEIGHT = Math.round((THUMB_WIDTH * CANVAS_HEIGHT) / CANVAS_WIDTH);

type Props = {
  onStart: (template: TemplateKind, orientation: Orientation, mangaPreset?: MangaPresetKind) => void;
  onContinue: (sessionId: string) => void;
  onDelete: (sessionId: string) => void;
  onRename: (sessionId: string, name: string) => void;
  savedSessions: StoredDrawingSession[];
  storageError?: string;
};

function savedAtLabel(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '保存日時不明';
  return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

// 漫画プリセットのサムネイル。実際のコマ枠描画(drawTemplate)をそのまま小さい
// canvasへ描くので、選択肢の見た目と実際にできあがるコマ割りが必ず一致する
// （プレビュー専用の別ロジックを持たない）。
function PresetThumbnail({ presetKey }: { presetKey: MangaPresetKind }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    drawTemplate(ctx, 'manga', canvas.width, canvas.height, presetKey);
  }, [presetKey]);

  return <canvas ref={canvasRef} width={THUMB_WIDTH} height={THUMB_HEIGHT} className="preset-thumbnail" aria-hidden="true" />;
}

type Step = 'main' | 'preset' | 'orientation';

export function StartScreen({ onStart, onContinue, onDelete, onRename, savedSessions, storageError }: Props) {
  const [step, setStep] = useState<Step>('main');
  const [template, setTemplate] = useState<TemplateKind | null>(null);
  const [mangaPreset, setMangaPreset] = useState<MangaPresetKind | null>(null);

  const confirmDelete = (session: StoredDrawingSession) => {
    if (window.confirm(`「${session.name}」を けしても いい？`)) onDelete(session.id);
  };

  const rename = (session: StoredDrawingSession) => {
    const next = window.prompt('この えの なまえは？', session.name);
    if (next === null) return;
    onRename(session.id, next);
  };

  const selectMain = (choice: MainChoice) => {
    if (choice.disabled || choice.key === 'line-sticker') return;
    setTemplate(choice.key);
    setStep(choice.key === 'manga' ? 'preset' : 'orientation');
  };

  const selectPreset = (preset: MangaPresetKind) => {
    setMangaPreset(preset);
    setStep('orientation');
  };

  const backFromOrientation = () => {
    setStep(template === 'manga' ? 'preset' : 'main');
  };

  const backFromPreset = () => {
    setTemplate(null);
    setStep('main');
  };

  if (step === 'main') {
    return (
      <main className="start-screen">
        <div className="start-card">
          <div className="mascot" aria-hidden="true">🎨</div>
          <h1>なにを かく？</h1>
          <p>すきな かみを えらんでね</p>
          {savedSessions.length > 0 && (
            <section className="saved-work-section" aria-label="保存した作品">
              <strong className="saved-work-title">▶️ つづきから</strong>
              <div className="saved-work-list">
                {savedSessions.map((session) => (
                  <div className="saved-work-row" key={session.id}>
                    <button className="saved-work-open" onClick={() => onContinue(session.id)}>
                      <span className="saved-work-thumbnail" aria-hidden="true">
                        {session.thumbnail ? <img src={session.thumbnail} alt="" /> : <span>🎨</span>}
                      </span>
                      <span className="saved-work-meta">
                        <strong>{session.name}</strong>
                        <small>{session.history.present.orientation === 'landscape' ? 'よこ' : 'たて'} ・ {savedAtLabel(session.savedAt)}</small>
                      </span>
                    </button>
                    <button className="saved-work-rename" onClick={() => rename(session)} aria-label={`${session.name}の名前を変更`} title="なまえを かえる">✏️</button>
                    <button className="saved-work-delete" onClick={() => confirmDelete(session)} aria-label={`${session.name}を削除`} title="けす">×</button>
                  </div>
                ))}
              </div>
            </section>
          )}
          {storageError && <p className="storage-error" role="alert">⚠️ {storageError}</p>}
          <div className="template-grid">
            {mainChoices.map((choice) => (
              <button
                key={choice.key}
                type="button"
                className={choice.disabled ? 'template-card template-card-disabled' : 'template-card'}
                onClick={() => selectMain(choice)}
                disabled={choice.disabled}
                aria-disabled={choice.disabled}
              >
                <span className="template-icon" aria-hidden="true">{choice.icon}</span>
                <strong>{choice.label}</strong>
                <small>{choice.note}</small>
              </button>
            ))}
          </div>
        </div>
      </main>
    );
  }

  if (step === 'preset') {
    return (
      <main className="start-screen start-screen-preset">
        <div className="start-card">
          <div className="mascot" aria-hidden="true">💬</div>
          <h1>どの コマわり？</h1>
          <p>すきな コマわりを えらんでね</p>
          <div className="template-grid preset-grid" role="group" aria-label="コマわりプリセット">
            {MANGA_PRESETS.map((preset) => (
              <button key={preset.key} type="button" className="template-card preset-card" onClick={() => selectPreset(preset.key)}>
                <PresetThumbnail presetKey={preset.key} />
                <strong>{preset.label}</strong>
                <small>{preset.note}</small>
              </button>
            ))}
          </div>
          <button className="back-link" onClick={backFromPreset}>↩️ かみを えらびなおす</button>
        </div>
      </main>
    );
  }

  return (
    <main className="start-screen">
      <div className="start-card">
        <div className="mascot" aria-hidden="true">📐</div>
        <h1>どちらむき？</h1>
        <p>かみの むきを えらんでね</p>
        <div className="template-grid orientation-grid">
          {orientations.map((o) => (
            <button
              key={o.key}
              className={`template-card orientation-card orientation-${o.key}`}
              onClick={() => onStart(template ?? 'blank', o.key, mangaPreset ?? undefined)}
            >
              <span className={`orientation-swatch orientation-swatch-${o.key}`} aria-hidden="true" />
              <strong>{o.icon} {o.label}</strong>
              <small>{o.note}</small>
            </button>
          ))}
        </div>
        <button className="back-link" onClick={backFromOrientation}>↩️ かみを えらびなおす</button>
      </div>
    </main>
  );
}
