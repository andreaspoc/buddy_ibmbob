import { brandText } from '../lib/brand';
import { themeCssValue } from '../lib/themeColor';
import React, { useMemo, useState } from 'react';
import { LessonContent } from './LessonContent';
import './StickyNotes.css';

export type StickyNoteColor = 'butter' | 'rose' | 'lavender' | 'mint' | 'sky';

export interface ClassNote {
  id: string;
  folder_id: string;
  lesson_id?: string | null;
  lesson_title?: string | null;
  lesson_ordinal?: number | null;
  title: string;
  body: string;
  color: StickyNoteColor;
  tags: string[];
  favorite: boolean;
  bob_note_id?: number | null;
  created_at: string;
  updated_at: string;
}

export interface ChapterOption {
  id: string;
  title: string;
  ordinal?: number;
}

export const NOTE_COLORS: { id: StickyNoteColor; label: string; hex: string; border: string }[] = [
  { id: 'butter', label: 'Warm yellow', hex: '#fff3bd', border: '#ebd88c' },
  { id: 'rose', label: 'Soft rose', hex: '#fce0e7', border: '#efc5d1' },
  { id: 'lavender', label: 'Lavender', hex: '#eee3ff', border: '#dbcaee' },
  { id: 'mint', label: 'Fresh mint', hex: '#dff3e8', border: '#bcdcca' },
  { id: 'sky', label: 'Sky blue', hex: '#e0effc', border: '#bed7ee' },
];

function PinIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 17v5" />
      <path d="M8 3h8l-1.5 6 3.5 3.5V14H6v-1.5L9.5 9 8 3z" />
    </svg>
  );
}

interface EditorModalProps {
  open: boolean;
  classTitle: string;
  chapters: ChapterOption[];
  initialNote?: ClassNote | null;
  defaultLessonId?: string | null;
  busy?: boolean;
  onClose: () => void;
  onSave: (payload: {
    id?: string;
    title: string;
    body: string;
    color: StickyNoteColor;
    tags: string[];
    favorite: boolean;
    lesson_id: string | null;
  }) => Promise<void>;
}

export function LearningNoteEditorModal({
  open,
  classTitle,
  chapters,
  initialNote,
  defaultLessonId = null,
  busy = false,
  onClose,
  onSave,
}: EditorModalProps) {
  const [title, setTitle] = useState(initialNote?.title || '');
  const [body, setBody] = useState(initialNote?.body || '');
  const [color, setColor] = useState<StickyNoteColor>(initialNote?.color || 'butter');
  const [tagsText, setTagsText] = useState((initialNote?.tags || []).join(', '));
  const [favorite, setFavorite] = useState(Boolean(initialNote?.favorite));
  const [lessonId, setLessonId] = useState<string>(
    initialNote?.lesson_id ?? defaultLessonId ?? ''
  );
  const [tab, setTab] = useState<'write' | 'preview'>('write');
  const [err, setErr] = useState('');

  React.useEffect(() => {
    if (open) {
      setTitle(initialNote?.title || '');
      setBody(initialNote?.body || '');
      setColor(initialNote?.color || 'butter');
      setTagsText((initialNote?.tags || []).join(', '));
      setFavorite(Boolean(initialNote?.favorite));
      setLessonId(initialNote?.lesson_id ?? defaultLessonId ?? '');
      setTab('write');
      setErr('');
    }
  }, [open, initialNote, defaultLessonId]);

  if (!open) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!body.trim()) {
      setErr('Write a note before saving.');
      return;
    }
    setErr('');
    const parsedTags = tagsText
      .split(',')
      .map((t) => t.trim().replace(/^#+/, '').toLowerCase())
      .filter(Boolean);
    try {
      await onSave({
        id: initialNote?.id,
        title: title.trim(),
        body: body.trim(),
        color,
        tags: parsedTags,
        favorite,
        lesson_id: lessonId || null,
      });
    } catch (ex: any) {
      setErr(ex?.message || 'Could not save sticky note');
    }
  };

  return (
    <div
      className="learning-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={initialNote ? 'Edit sticky note' : 'New sticky note'}
    >
      <button type="button" className="learning-note-backdrop-close" aria-label="Close" onClick={onClose} />
      <div className="learning-note-editor-card learning-note-editor-dialog">
        <div className="learning-note-editor-header">
          <div>
            <div className="learning-catalog-eyebrow">
              {classTitle.toUpperCase()} · STICKY NOTE
            </div>
            <h2>{initialNote ? 'Edit sticky note' : 'New class sticky note'}</h2>
          </div>
          <button
            type="button"
            className="learning-icon-button"
            onClick={onClose}
            aria-label="Close note editor"
          >
            ×
          </button>
        </div>

        {err && (
          <div className="learning-alert" style={{ marginBottom: 14 }}>
            {err}
          </div>
        )}

        <form onSubmit={handleSubmit} className="learning-note-editor-form">
          <div className="learning-note-editor-grid">
            <label className="learning-note-field">
              <span>Title</span>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Key takeaway, formula, or question..."
                maxLength={240}
              />
            </label>
            <label className="learning-note-field">
              <span>Chapter</span>
              <select
                value={lessonId}
                onChange={(e) => setLessonId(e.target.value)}
              >
                <option value="">General Class Note (All Chapters)</option>
                {chapters.map((ch, idx) => (
                  <option key={ch.id} value={ch.id}>
                    Chapter {idx + 1}: {ch.title}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="learning-note-editor-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'write'}
              onClick={() => setTab('write')}
            >
              Write
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'preview'}
              onClick={() => setTab('preview')}
            >
              Preview
            </button>
            <span>Markdown supported · Synced with your {brandText("Buddy")} Notes</span>
          </div>

          {tab === 'write' ? (
            <textarea
              className="learning-note-textarea"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Write your study note, summary, code snippet, or flashcard points..."
            />
          ) : (
            <div
              className="learning-note-preview sticky-note-copy"
              data-note-color={color}
            >
              {body.trim() ? (
                <LessonContent text={body} />
              ) : (
                <p>Nothing to preview yet.</p>
              )}
            </div>
          )}

          <div className="learning-note-editor-meta-row">
            <label className="learning-note-field" style={{ flex: 1 }}>
              <span>Tags</span>
              <input
                value={tagsText}
                onChange={(e) => setTagsText(e.target.value)}
                placeholder="exam, chapter-1, definitions, follow-up"
              />
              <small>Comma-separated tags help you filter notes across chapters.</small>
            </label>

            <div className="learning-note-color-picker">
              <span className="learning-note-field-label">Paper color</span>
              <div className="learning-note-color-dots" role="group" aria-label="Choose sticky note color">
                {NOTE_COLORS.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    className={`learning-color-swatch swatch-${c.id} ${color === c.id ? 'is-selected' : ''}`}
                    style={{ backgroundColor: c.hex, borderColor: c.border }}
                    aria-pressed={color === c.id}
                    title={c.label}
                    onClick={() => setColor(c.id)}
                  >
                    {color === c.id ? '✓' : ''}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <label className="learning-note-favorite-check">
            <input
              type="checkbox"
              checked={favorite}
              onChange={(e) => setFavorite(e.target.checked)}
            />
            <span>Pin to favorites (★)</span>
          </label>

          <div className="learning-dialog-actions">
            <button type="button" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button
              type="submit"
              className="learning-primary"
              disabled={busy || !body.trim()}
            >
              {busy
                ? 'Saving...'
                : initialNote
                ? 'Save changes'
                : 'Save sticky note'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

interface BoardProps {
  classTitle: string;
  notes: ClassNote[];
  chapters: ChapterOption[];
  onCreateNote: (defaultLessonId?: string | null) => void;
  onEditNote: (note: ClassNote) => void;
  onToggleFavorite: (note: ClassNote) => Promise<void>;
  onDeleteNote: (noteId: string) => Promise<void>;
}

export function LearningStickyNotesBoard({
  classTitle,
  notes,
  chapters,
  onCreateNote,
  onEditNote,
  onToggleFavorite,
  onDeleteNote,
}: BoardProps) {
  const [selectedChapter, setSelectedChapter] = useState<string>('ALL');
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [selectedColor, setSelectedColor] = useState<StickyNoteColor | 'ALL'>('ALL');
  const [selectedTag, setSelectedTag] = useState<string>('');
  const [search, setSearch] = useState('');
  const [expandedIds, setExpandedIds] = useState<Record<string, boolean>>({});
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const chapterIndexMap = useMemo(() => {
    const map: Record<string, { index: number; title: string }> = {};
    chapters.forEach((ch, idx) => {
      map[ch.id] = { index: idx + 1, title: ch.title };
    });
    return map;
  }, [chapters]);

  const allTags = useMemo(() => {
    const counts: Record<string, number> = {};
    notes.forEach((n) => {
      (n.tags || []).forEach((t) => {
        counts[t] = (counts[t] || 0) + 1;
      });
    });
    return Object.entries(counts).sort((a, b) => b[1] - a[1]);
  }, [notes]);

  const filteredNotes = useMemo(() => {
    return notes.filter((n) => {
      if (favoritesOnly && !n.favorite) return false;
      if (selectedChapter === 'UNASSIGNED' && n.lesson_id) return false;
      if (
        selectedChapter !== 'ALL' &&
        selectedChapter !== 'UNASSIGNED' &&
        n.lesson_id !== selectedChapter
      ) {
        return false;
      }
      if (selectedColor !== 'ALL' && n.color !== selectedColor) return false;
      if (selectedTag && !(n.tags || []).includes(selectedTag)) return false;
      if (search.trim()) {
        const q = search.trim().toLowerCase();
        const inTitle = (n.title || '').toLowerCase().includes(q);
        const inBody = (n.body || '').toLowerCase().includes(q);
        const inTags = (n.tags || []).some((t) => t.toLowerCase().includes(q));
        if (!inTitle && !inBody && !inTags) return false;
      }
      return true;
    });
  }, [notes, favoritesOnly, selectedChapter, selectedColor, selectedTag, search]);

  return (
    <div className="learning-notes-board">
      <div className="learning-course-hero learning-notes-hero">
        <div className="learning-course-hero-main">
          <div className="learning-catalog-eyebrow">
            {classTitle.toUpperCase()} · STUDY NOTES
          </div>
          <h2>Class Sticky Notes</h2>
          <p>
            Pin key concepts, formulas, and chapter summaries on colorful sticky notes. Your class notes automatically sync with your main {brandText("Buddy")} Notes library.
          </p>
          <div className="learning-notes-hero-actions">
            <span className="learning-instructor-pill">
              📌 {notes.length} {notes.length === 1 ? 'sticky note' : 'sticky notes'} in this class
            </span>
            <button
              type="button"
              className="learning-primary"
              onClick={() =>
                onCreateNote(
                  selectedChapter !== 'ALL' && selectedChapter !== 'UNASSIGNED'
                    ? selectedChapter
                    : null
                )
              }
            >
              + New Sticky Note
            </button>
          </div>
        </div>
        <div className="notes-hero-art" aria-hidden="true" style={{ height: 150, flexBasis: 185, marginRight: 8 }}>
          <div className="notes-art-back" style={{ width: 132, height: 132 }} />
          <div className="notes-art-front" style={{ width: 132, height: 132 }}>
            <PinIcon />
            <i />
            <i />
            <i />
            <span>CHAPTER NOTES</span>
          </div>
        </div>
      </div>

      <div className="learning-notes-layout">
        <aside className="learning-notes-sidebar" aria-label="Chapter note filters">
          <div className="learning-notes-sidebar-heading">CHAPTERS</div>
          <button
            type="button"
            className={`learning-notes-filter-btn ${selectedChapter === 'ALL' && !favoritesOnly ? 'is-active' : ''}`}
            aria-pressed={selectedChapter === 'ALL' && !favoritesOnly}
            onClick={() => {
              setSelectedChapter('ALL');
              setFavoritesOnly(false);
            }}
          >
            <span>All class notes</span>
            <small>{notes.length}</small>
          </button>
          <button
            type="button"
            className={`learning-notes-filter-btn ${favoritesOnly ? 'is-active' : ''}`}
            aria-pressed={favoritesOnly}
            onClick={() => setFavoritesOnly((f) => !f)}
          >
            <span>★ Favorites</span>
            <small>{notes.filter((n) => n.favorite).length}</small>
          </button>
          {chapters.map((ch, idx) => {
            const count = notes.filter((n) => n.lesson_id === ch.id).length;
            const active = selectedChapter === ch.id;
            return (
              <button
                key={ch.id}
                type="button"
                className={`learning-notes-filter-btn ${active ? 'is-active' : ''}`}
                aria-pressed={active}
                onClick={() => setSelectedChapter(ch.id)}
                title={`Chapter ${idx + 1}: ${ch.title}`}
              >
                <span>
                  Ch. {idx + 1} · {ch.title}
                </span>
                <small>{count}</small>
              </button>
            );
          })}
          {notes.some((n) => !n.lesson_id) && (
            <button
              type="button"
              className={`learning-notes-filter-btn ${selectedChapter === 'UNASSIGNED' ? 'is-active' : ''}`}
              aria-pressed={selectedChapter === 'UNASSIGNED'}
              onClick={() => setSelectedChapter('UNASSIGNED')}
            >
              <span>General notes</span>
              <small>{notes.filter((n) => !n.lesson_id).length}</small>
            </button>
          )}

          {allTags.length > 0 && (
            <>
              <div className="learning-notes-sidebar-heading" style={{ marginTop: 18 }}>
                TAGS
              </div>
              {allTags.map(([tag, count]) => (
                <button
                  key={tag}
                  type="button"
                  className={`learning-notes-filter-btn ${selectedTag === tag ? 'is-active' : ''}`}
                  aria-pressed={selectedTag === tag}
                  onClick={() => setSelectedTag((prev) => (prev === tag ? '' : tag))}
                >
                  <span>#{tag}</span>
                  <small>{count}</small>
                </button>
              ))}
            </>
          )}
        </aside>

        <div className="learning-notes-main">
          <div className="learning-notes-toolbar">
            <label className="learning-notes-search">
              <span className="sr-only">Search class sticky notes</span>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="11" cy="11" r="8" />
                <path d="m21 21-4.3-4.3" />
              </svg>
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search class sticky notes, chapters, or #tags..."
              />
            </label>

            <div className="learning-notes-color-bar" role="group" aria-label="Filter by paper color">
              <button
                type="button"
                className={`learning-color-all-btn ${selectedColor === 'ALL' ? 'is-active' : ''}`}
                aria-pressed={selectedColor === 'ALL'}
                onClick={() => setSelectedColor('ALL')}
              >
                All colors
              </button>
              {NOTE_COLORS.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className={`learning-color-swatch swatch-${c.id} ${selectedColor === c.id ? 'is-selected' : ''}`}
                  style={{ backgroundColor: c.hex, borderColor: c.border }}
                  aria-pressed={selectedColor === c.id}
                  title={c.label}
                  onClick={() =>
                    setSelectedColor((prev) => (prev === c.id ? 'ALL' : c.id))
                  }
                >
                  {selectedColor === c.id ? '✓' : ''}
                </button>
              ))}
            </div>
          </div>

          {filteredNotes.length === 0 ? (
            <div className="learning-empty" style={{ background: '#ffffff', borderRadius: 16, border: `1px solid ${themeCssValue('#e4daf2')}`, padding: '48px 24px' }}>
              <span>📌</span>
              <h2>No sticky notes here yet</h2>
              <p>
                Capture key takeaways while studying a chapter, or jot down reminders and study cards for this class.
              </p>
              <button
                type="button"
                className="learning-primary"
                style={{ marginTop: 12 }}
                onClick={() =>
                  onCreateNote(
                    selectedChapter !== 'ALL' && selectedChapter !== 'UNASSIGNED'
                      ? selectedChapter
                      : null
                  )
                }
              >
                + Create your first sticky note
              </button>
            </div>
          ) : (
            <div className="sticky-notes-grid notes-saved-grid">
              {filteredNotes.map((note, idx) => {
                const chMeta = note.lesson_id ? chapterIndexMap[note.lesson_id] : null;
                const isExpanded = Boolean(expandedIds[note.id]);
                const isLong = (note.body || '').length > 280;
                return (
                  <article
                    key={note.id}
                    className={`sticky-note learning-sticky-note-card notes-saved-card ${isExpanded ? 'is-expanded' : ''}`}
                    data-note-color={note.color || 'butter'}
                  >
                    <div className="sticky-note-tape" aria-hidden="true" />
                    <div className="sticky-note-topline">
                      <span className="sticky-note-number">
                        NOTE {String(idx + 1).padStart(2, '0')}
                      </span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        <button
                          type="button"
                          className="learning-note-fav-btn"
                          aria-pressed={note.favorite}
                          title={note.favorite ? 'Remove from favorites' : 'Pin to favorites'}
                          onClick={() => onToggleFavorite(note)}
                        >
                          {note.favorite ? '★' : '☆'}
                        </button>
                        <PinIcon />
                      </div>
                    </div>

                    <button type="button"
                      className="notes-card-collection"
                      disabled={!note.lesson_id}
                      onClick={() => note.lesson_id && setSelectedChapter(note.lesson_id)}
                    >
                      {chMeta
                        ? `▱ Chapter ${chMeta.index} · ${chMeta.title}`
                        : note.lesson_title
                        ? `▱ ${note.lesson_title}`
                        : `▱ ${classTitle} · General`}
                    </button>

                    <h3>{note.title}</h3>

                    <div className="sticky-note-copy notes-saved-body">
                      <LessonContent text={note.body} />
                    </div>

                    {(note.tags || []).length > 0 && (
                      <div className="notes-card-tags">
                        {note.tags.map((t) => (
                          <button
                            key={t}
                            type="button"
                            className="learning-note-tag-pill"
                            onClick={() =>
                              setSelectedTag((prev) => (prev === t ? '' : t))
                            }
                          >
                            #{t}
                          </button>
                        ))}
                      </div>
                    )}

                    <div className="sticky-note-footer">
                      {confirmDeleteId === note.id ? (
                        <div className="notes-delete-confirm">
                          <strong>Remove this sticky note?</strong>
                          <span>This removes it from this class and your {brandText("Buddy")} Notes.</span>
                          <div>
                            <button
                              type="button"
                              className="learning-note-action-btn"
                              onClick={() => setConfirmDeleteId(null)}
                            >
                              Cancel
                            </button>
                            <button
                              type="button"
                              className="learning-button-danger"
                              onClick={async () => {
                                await onDeleteNote(note.id);
                                setConfirmDeleteId(null);
                              }}
                            >
                              Delete
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="notes-card-actions">
                          {isLong && (
                            <button
                              type="button"
                              className="learning-note-action-btn"
                              onClick={() =>
                                setExpandedIds((prev) => ({
                                  ...prev,
                                  [note.id]: !prev[note.id],
                                }))
                              }
                            >
                              {isExpanded ? 'Collapse' : 'Full note'}
                            </button>
                          )}
                          <button
                            type="button"
                            className="learning-note-action-btn"
                            onClick={() => onEditNote(note)}
                          >
                            Edit note
                          </button>
                          <button
                            type="button"
                            className="learning-note-action-btn is-danger"
                            title="Delete note"
                            onClick={() => setConfirmDeleteId(note.id)}
                          >
                            Delete
                          </button>
                        </div>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

interface StripProps {
  chapterId: string;
  chapterNumber: number;
  chapterTitle: string;
  notes: ClassNote[];
  onAddNote: (lessonId: string) => void;
  onEditNote: (note: ClassNote) => void;
  onOpenAllNotes: () => void;
}

export function ChapterStickyNotesStrip({
  chapterId,
  chapterNumber,
  notes,
  onAddNote,
  onEditNote,
  onOpenAllNotes,
}: StripProps) {
  return (
    <div className="learning-chapter-notes-section">
      <div className="learning-chapter-subhead">
        <div>
          <span className="learning-chapter-subicon">📌</span>
          <strong>Chapter {chapterNumber} Sticky Notes</strong>
          <span className="learning-chapter-subcount">{notes.length}</span>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {notes.length > 0 && (
            <button type="button" className="learning-link-btn" onClick={onOpenAllNotes}>
              Open Notes Board →
            </button>
          )}
          <button
            type="button"
            className="learning-chapter-mini-btn"
            onClick={() => onAddNote(chapterId)}
          >
            + Add Sticky Note
          </button>
        </div>
      </div>

      {notes.length === 0 ? (
        <div className="learning-chapter-notes-empty">
          <span>No sticky notes for Chapter {chapterNumber} yet.</span>
          <button type="button" onClick={() => onAddNote(chapterId)}>
            + Pin a sticky note for this chapter
          </button>
        </div>
      ) : (
        <div className="learning-chapter-notes-row">
          {notes.map((note) => (
            <div
              key={note.id}
              className="sticky-note learning-sticky-note-card learning-mini-sticky-note"
              data-note-color={note.color || 'butter'}
              onClick={() => onEditNote(note)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onEditNote(note)}
            >
              <div className="sticky-note-tape" aria-hidden="true" />
              <div className="sticky-note-topline" style={{ marginBottom: 6 }}>
                <span className="sticky-note-number">
                  {note.favorite ? '★ FAVORITE' : 'STICKY NOTE'}
                </span>
                <PinIcon />
              </div>
              <h3 style={{ fontSize: 15, marginBottom: 6 }}>{note.title}</h3>
              <div
                className="sticky-note-copy"
                style={{
                  fontSize: 12.5,
                  lineHeight: 1.55,
                  maxHeight: 88,
                  overflow: 'hidden',
                }}
              >
                <LessonContent text={note.body} />
              </div>
              {(note.tags || []).length > 0 && (
                <div className="notes-card-tags" style={{ marginTop: 8 }}>
                  {note.tags.slice(0, 3).map((t) => (
                    <span key={t} className="learning-note-tag-pill">
                      #{t}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
