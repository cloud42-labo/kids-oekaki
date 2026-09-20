import { useState } from 'react';
import type { Orientation, TemplateKind } from '../domain/drawing';
import type { StoredDrawingSession } from '../utils/documentStorage';

const templates: Array<{ key: TemplateKind; icon: string; label: string; note: string }> = [
  { key: 'blank', icon: '🖍️', label: 'まっしろ', note: 'じゆうに かこう' },
  { key: '4koma', icon: '💬', label: '4コマまんが', note: 'おはなしを つくろう' },
  { key: 'diary', icon: '📖', label: 'えにっき', note: 'きょうの おもいで' },
];

const orientations: Array<{ key: Orientation; icon: string; label: string; note: string }> = [
  { key: 'portrait', icon: '📱', label: 'たて', note: 'たてながの かみ' },
  { key: 'landscape', icon: '🖼️', label: 'よこ', note: 'よこながの かみ' },
];

type Props = {
  onStart: (template: TemplateKind, orientation: Orientation) => void;
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

export function StartScreen({ onStart, onContinue, onDelete, onRename, savedSessions, storageError }: Props) {
  const [template, setTemplate] = useState<TemplateKind | null>(null);

  const confirmDelete = (session: StoredDrawingSession) => {
    if (window.confirm(`「${session.name}」を けしても いい？`)) onDelete(session.id);
  };

  const rename = (session: StoredDrawingSession) => {
    const next = window.prompt('この えの なまえは？', session.name);
    if (next === null) return;
    onRename(session.id, next);
  };

  if (!template) {
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
            {templates.map((t) => (
              <button key={t.key} className="template-card" onClick={() => setTemplate(t.key)}>
                <span className="template-icon" aria-hidden="true">{t.icon}</span>
                <strong>{t.label}</strong>
                <small>{t.note}</small>
              </button>
            ))}
          </div>
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
            <button key={o.key} className={`template-card orientation-card orientation-${o.key}`} onClick={() => onStart(template, o.key)}>
              <span className={`orientation-swatch orientation-swatch-${o.key}`} aria-hidden="true" />
              <strong>{o.icon} {o.label}</strong>
              <small>{o.note}</small>
            </button>
          ))}
        </div>
        <button className="back-link" onClick={() => setTemplate(null)}>↩️ かみを えらびなおす</button>
      </div>
    </main>
  );
}
