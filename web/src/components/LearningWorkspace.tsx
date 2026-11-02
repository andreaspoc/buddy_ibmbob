import { brandLogoUrl, brandText } from '../lib/brand';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ClassDocumentField } from './ClassDocumentField';
import { draftLessonFromDocument } from '../lib/classDocumentDraft';
import {
  getLearningLanguage,
  languageLabel,
  LearningLanguageSelector,
  orderedLearningLanguages,
  useLearningLanguage,
  type LearningLangCode,
} from '../learningLanguage';
import { LearningAssistant } from './LearningAssistant';
import { FloatingLearningAssistant } from './FloatingLearningAssistant';
import './LearningBrand.css';
import './LearningWorkspace.css';
import { learningUserName } from '../lib/learningIdentity';
import { parseLearningUrl, learningPath } from '../lib/learningUrl';
import { LearningLessons } from './LearningLessons';
import { LearningNextSteps } from './LearningNextSteps';
import { LearningClasses } from './LearningClasses';
import LearningCourseCompletion from './LearningCourseCompletion';
import LearningPeopleAdmin from './LearningPeopleAdmin';
import { LearningBookPages } from './LearningBookPages';
import { QuizGradingState, QuizReport, QuizStatistics } from './LearningQuizResults';
import type { QuizSubmission, ResultQuestion } from './LearningQuizResults';
import { LearningConfirmDialog } from './LearningConfirmDialog';
import {
  ChapterStickyNotesStrip,
  LearningNoteEditorModal,
  LearningStickyNotesBoard,
  type ClassNote,
  type StickyNoteColor,
} from './LearningStickyNotes';
import { untranslatedWarning } from '../lib/untranslatedNotice';

type Folder = {
  id: string;
  name: string;
  parent_id?: string | null;
  is_class?: boolean;
  description?: string;
  teacher_username?: string | null;
  teacher_display_name?: string | null;
  can_manage?: boolean;
  can_delete?: boolean;
  lesson_count?: number;
  completed_lesson_count?: number;
  quiz_count?: number;
  submitted_quiz_count?: number;
  book_count?: number;
  note_count?: number;
  member_count?: number;
  has_certificate?: boolean;
  translations?: Record<string, { name?: string; description?: string; approved?: boolean }>;
  approved_languages?: string[];
};
type Book = { id: string; title: string; author?: string; extension?: string; lesson_id?: string | null };
type QuizSummary = {
  id: string;
  title: string;
  status: 'draft' | 'published' | 'closed';
  version: number;
  submitted?: boolean;
  is_creator?: boolean;
  can_view_results?: boolean;
  lesson_id?: string | null;
  book_id?: string | null;
  question_count?: number;
  score?: number | null;
  max_score?: number | null;
  pending_manual?: boolean;
  translations?: Record<string, { title?: string; questions?: Question[]; approved?: boolean }>;
  approved_languages?: string[];
};
type LessonSummary = {
  id: string;
  title: string;
  status: string;
  version?: number;
  is_creator?: boolean;
  ordinal?: number;
  description?: string;
  step_count?: number;
  completed?: boolean;
  current_step?: number;
  started?: boolean;
  translations?: Record<string, { title?: string; description?: string; approved?: boolean }>;
  approved_languages?: string[];
};
type Question = ResultQuestion;
type Quiz = QuizSummary & {
  source_truncated?: boolean;
  questions: Question[];
  book_id?: string | null;
  lesson_id?: string | null;
  result?: Submission | null;
};

const folderName = (f: Folder | null | undefined, lang: string): string =>
  (f?.translations?.[lang]?.name && f.translations[lang].name!.trim()) || f?.name || '';
const folderDesc = (f: Folder | null | undefined, lang: string): string =>
  (f?.translations?.[lang]?.description && f.translations[lang].description!.trim()) || f?.description || '';
const lessonTitle = (l: LessonSummary, lang: string): string =>
  (l.translations?.[lang]?.title && l.translations[lang].title!.trim()) || l.title;
const lessonDesc = (l: LessonSummary, lang: string): string =>
  (l.translations?.[lang]?.description && l.translations[lang].description!.trim()) || l.description || '';
const quizTitle = (q: QuizSummary, lang: string): string =>
  (q.translations?.[lang]?.title && q.translations[lang].title!.trim()) || q.title;
type Answers = Record<string, string | number[]>;
type Chapter = { id: string; title: string };
type Bookmark = { chapter_id: string; label: string };
type ReaderNote = { id: string; chapter_id: string; page: number; color: 'yellow' | 'purple' | 'blue' | 'green'; text: string };
type ReaderBook = Book & { chapters: Chapter[]; progress?: { chapter_id?: string; page?: number; bookmarks?: Bookmark[] } };
type Submission = QuizSubmission;
type Results = { items: Submission[]; questions: Question[] };

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch('/api/learning' + path, {
    ...options,
    headers: {
      'X-Learning-Language': getLearningLanguage(),
      ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...options.headers,
    },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    if (response.status === 401) throw new Error(brandText('Your session has expired. Return to Buddy to sign in again.'));
    if (response.status === 404 && body.detail === 'Not Found' && /\/my-result(?:\/grade)?(?:\?|$)/.test(path)) {
      throw new Error('Your answers are saved, but this Learning service needs an update before it can show results. Please contact an administrator.');
    }
    throw new Error(typeof body.detail === 'string' ? body.detail : `Unable to complete this request (${response.status}).`);
  }
  return response.status === 204 ? undefined as T : response.json();
}
const json = (value: unknown) => JSON.stringify(value);
const newQuestion = (): Question => ({ id: crypto.randomUUID(), type: 'single', question: '', options: ['', ''], answer: [], points: 1 });
const errorText = (error: unknown) => error instanceof Error ? error.message : 'Something went wrong. Please retry.';

function Dialog({ title, onClose, children, wide = false }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  const { t } = useLearningLanguage();
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); return () => ref.current?.close(); }, []);
  return (
    <dialog ref={ref} className={`learning-dialog ${wide ? 'learning-dialog-wide' : ''}`} onCancel={event => { event.preventDefault(); onClose(); }}>
      <header>
        <h2>{title}</h2>
        <button className="learning-icon-button" onClick={onClose} aria-label={t('Close dialog')}>×</button>
      </header>
      {children}
    </dialog>
  );
}

function EbookReader({ bookId, onClose }: { bookId: string; onClose: () => void }) {
  const { t } = useLearningLanguage();
  const [book, setBook] = useState<ReaderBook | null>(null);
  const [chapterId, setChapterId] = useState('');
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [fontSize, setFontSize] = useState(18);
  const [page, setPage] = useState(0);
  const [pageCount, setPageCount] = useState(1);
  const [notesOpen, setNotesOpen] = useState(false);
  const [notes, setNotes] = useState<ReaderNote[]>([]);
  const [draftNote, setDraftNote] = useState('');
  const [noteColor, setNoteColor] = useState<ReaderNote['color']>('yellow');
  const [noteBusy, setNoteBusy] = useState(false);
  const requestedPage = useRef(0);

  const [turnDirection, setTurnDirection] = useState<'forward' | 'backward' | null>(null);
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const [searchResults, setSearchResults] = useState<{ chapter_id: string; title: string; excerpt: string }[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [saving, setSaving] = useState(false);
  const saveEpoch = useRef(0);

  useEffect(() => {
    let active = true;
    api<ReaderBook>(`/books/${bookId}`)
      .then(result => {
        if (!active) return;
        setBook(result);
        setChapterId(result.chapters.some(chapter => chapter.id === result.progress?.chapter_id) ? result.progress!.chapter_id! : result.chapters[0]?.id || '');
        setBookmarks(result.progress?.bookmarks || []);
        const params = new URLSearchParams(window.location.search);
        const linkedChapter = params.get('chapter');
        if (linkedChapter && result.chapters.some(chapter => chapter.id === linkedChapter)) setChapterId(linkedChapter);
        requestedPage.current = linkedChapter ? Math.max(0, Math.min(100000, Number(params.get('page')) || 0)) : result.progress?.page || 0;
        setPage(requestedPage.current);
      })
      .catch(error => {
        if (active) setError(errorText(error));
      });
    api<{items: ReaderNote[]}>(`/books/${bookId}/notes`).then(result => { if (active) setNotes(result.items); }).catch(error => { if (active) setError(errorText(error)); });
    return () => { active = false; };
  }, [bookId]);

  useEffect(() => {
    if (!chapterId) return;
    const url = new URL(window.location.href);
    url.searchParams.set('chapter', chapterId); url.searchParams.set('page', String(page));
    window.history.replaceState(window.history.state, '', url);
  }, [chapterId, page]);

  const storeProgress = async (chapter: string, marks: Bookmark[], position = page) => {
    const epoch = ++saveEpoch.current;
    setSaving(true);
    setSaved('');
    try {
      await api(`/books/${bookId}/progress`, { method: 'PUT', body: json({ chapter_id: chapter, page: position, bookmarks: marks }) });
      if (epoch === saveEpoch.current) setSaved('Reading position saved');
    } catch (error) {
      if (epoch === saveEpoch.current) setError(errorText(error));
    } finally {
      if (epoch === saveEpoch.current) setSaving(false);
    }
  };

  const goTo = (id: string, direction?: 'forward' | 'backward', position = 0) => {
    if (saving || !book) return;
    if (id === chapterId) {
      const next = Math.min(Math.max(0, position), pageCount - 1);
      setPage(next); requestedPage.current = next;
      void storeProgress(id, bookmarks, next); return;
    }
    const oldIdx = book.chapters.findIndex(c => c.id === chapterId);
    const newIdx = book.chapters.findIndex(c => c.id === id);
    const dir = direction || (newIdx >= oldIdx ? 'forward' : 'backward');
    setTurnDirection(dir);
    setChapterId(id);
    requestedPage.current = position;
    setPage(Math.max(0, position));
    setPageCount(1);
    setError('');
    void storeProgress(id, bookmarks, Math.max(0, position));
  };

  const current = book?.chapters.findIndex(chapter => chapter.id === chapterId) ?? -1;

  const turnPage = (direction: number) => {
    if (saving || !book) return;
    const target = page + direction;
    if (target >= 0 && target < pageCount) {
      setTurnDirection(direction > 0 ? 'forward' : 'backward');
      setPage(target); requestedPage.current = target;
      void storeProgress(chapterId, bookmarks, target);
    } else if (direction > 0 && current < book.chapters.length - 1) {
      goTo(book.chapters[current + 1].id, 'forward');
    } else if (direction < 0 && current > 0) {
      goTo(book.chapters[current - 1].id, 'backward', -1);
    }
  };
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement)?.closest('input,textarea,select,[contenteditable="true"]')) return;
      if (['ArrowRight','PageDown','ArrowLeft','PageUp'].includes(event.key)) {
        event.preventDefault(); turnPage(['ArrowRight','PageDown'].includes(event.key) ? 1 : -1);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [book, current, saving, page, pageCount]);

  const saveNote = async () => {
    if (!draftNote.trim() || noteBusy) return;
    setNoteBusy(true); setError('');
    try {
      const note = await api<ReaderNote>(`/books/${bookId}/notes`, {method:'POST', body:json({chapter_id:chapterId,page,color:noteColor,text:draftNote})});
      setNotes(previous => [note, ...previous]); setDraftNote('');
    } catch (error) { setError(errorText(error)); }
    finally { setNoteBusy(false); }
  };
  const deleteNote = async (id: string) => {
    setNoteBusy(true); setError('');
    try { await api(`/books/${bookId}/notes/${id}`, {method:'DELETE'}); setNotes(previous => previous.filter(note => note.id !== id)); }
    catch (error) { setError(errorText(error)); }
    finally { setNoteBusy(false); }
  };

  const toggleBookmark = () => {
    if (saving) return;
    const next = bookmarks.some(mark => mark.chapter_id === chapterId)
      ? bookmarks.filter(mark => mark.chapter_id !== chapterId)
      : [...bookmarks, { chapter_id: chapterId, label: book?.chapters.find(chapter => chapter.id === chapterId)?.title || 'Bookmark' }];
    setBookmarks(next);
    void storeProgress(chapterId, next);
  };

  return (
    <section className="learning-reader" aria-label="Document reader">
      <header className="learning-reader-header">
        <button className="learning-reader-back-btn" onClick={onClose}>{t('← Library')}</button>
        <div className="learning-reader-title-block">
          <h2>{book?.title || 'Opening document…'}</h2>
          <span>{book?.author}</span>
        </div>
        <a className="learning-document-download" href={`/api/learning/books/${bookId}/download`}>{t('Download original')}</a>
        <div className="learning-font-controls">
          <label htmlFor="learning-font-size">{t('Text size')}</label>
          <input id="learning-font-size" type="range" min="14" max="30" value={fontSize} onChange={event => setFontSize(Number(event.target.value))} />
          <span>{fontSize}px</span>
        </div>
      </header>
      {error && <div className="learning-alert" role="alert">{error}</div>}
      {book ? (
        <div className={`learning-reader-layout ${notesOpen ? 'has-notes' : ''}`}>
          <aside className="learning-toc">
            <h3>{t('Contents')}</h3>
            <form
              className="learning-reader-search"
              onSubmit={event => {
                event.preventDefault();
                if (!search.trim()) { setSearchResults(null); return; }
                setSearching(true);
                setError('');
                void api<{ items: { chapter_id: string; title: string; excerpt: string }[] }>(`/books/${bookId}/search?q=${encodeURIComponent(search.trim())}`)
                  .then(result => setSearchResults(result.items))
                  .catch(error => setError(errorText(error)))
                  .finally(() => setSearching(false));
              }}
            >
              <input
                aria-label="Search this document"
                placeholder={t('Search this document…')}
                minLength={2}
                maxLength={100}
                value={search}
                onChange={event => {
                  setSearch(event.target.value);
                  if (!event.target.value) setSearchResults(null);
                }}
              />
              <button disabled={searching} type="submit">{searching ? 'Searching…' : t('Search')}</button>
            </form>
            {searchResults && (
              <section className="learning-search-results" aria-label="Document search results">
                <p>{searchResults.length ? `${searchResults.length} matching chapters` : t('No matches found.')}</p>
                {searchResults.map((result, index) => (
                  <button disabled={saving} key={`${result.chapter_id}:${index}`} onClick={() => goTo(result.chapter_id)}>
                    <strong>{result.title}</strong>
                    <small>{result.excerpt}</small>
                  </button>
                ))}
                <button onClick={() => { setSearchResults(null); setSearch(''); }}>{t('Clear search')}</button>
              </section>
            )}
            <nav aria-label="Document sections">
              {book.chapters.map((chapter, index) => (
                <button
                  key={chapter.id}
                  disabled={saving}
                  className={chapter.id === chapterId ? 'is-active' : ''}
                  aria-current={chapter.id === chapterId ? 'page' : undefined}
                  onClick={() => goTo(chapter.id)}
                >
                  <span>{index + 1}</span>
                  {chapter.title}
                </button>
              ))}
            </nav>
            {bookmarks.length > 0 && (
              <>
                <h3>{t('Bookmarks')}</h3>
                {bookmarks.map(mark => (
                  <button className="learning-bookmark" key={mark.chapter_id} disabled={saving} onClick={() => goTo(mark.chapter_id)}>
                    ◇ {mark.label}
                  </button>
                ))}
              </>
            )}
          </aside>
          <div className="learning-page">
            <div className="learning-reader-tools">
              <div className="learning-reader-page-info">
                <span className="learning-page-badge" aria-live="polite">Chapter {Math.max(0, current + 1)} / {book.chapters.length} · Page {page + 1} / {pageCount}</span>
                <span className="learning-page-heading">{book.chapters.find(c => c.id === chapterId)?.title}</span>
              </div>
              <button aria-expanded={notesOpen} aria-controls="learning-reader-notes" onClick={() => setNotesOpen(value => !value)}>{t('Notes palette')}</button>
              <button disabled={!chapterId || saving} aria-pressed={bookmarks.some(mark => mark.chapter_id === chapterId)} onClick={toggleBookmark}>
                {bookmarks.some(mark => mark.chapter_id === chapterId) ? '◆ Bookmarked' : '◇ Bookmark chapter'}
              </button>
            </div>
            <div className="learning-book-viewport">
              <button
                className="learning-paddle learning-paddle-prev"
                disabled={(current <= 0 && page <= 0) || saving}
                onClick={() => turnPage(-1)}
                title={t('Previous page (←)')}
                aria-label={t('Previous page')}
              >
                ‹
              </button>
              <div
                className={`learning-page-frame ${turnDirection ? `page-slide-${turnDirection}` : ''}`}
                
                onAnimationEnd={() => setTurnDirection(null)}
              >
                {chapterId ? (
                  <LearningBookPages key={chapterId}
                    src={`/api/learning/books/${bookId}/chapters/${encodeURIComponent(chapterId)}?font_size=${fontSize}`}
                    fontSize={fontSize} page={page} onTurn={turnPage}
                    onLayout={count => {
                      setPageCount(count);
                      const lastPage = requestedPage.current < 0;
                      const next = lastPage ? count - 1 : Math.min(requestedPage.current, count - 1);
                      setPage(next); requestedPage.current = next;
                      if (lastPage) void storeProgress(chapterId, bookmarks, next);
                    }} />
                ) : (
                  <p className="learning-empty">This document has no readable sections.</p>
                )}
              </div>
              <button
                className="learning-paddle learning-paddle-next"
                disabled={current < 0 || (current >= book.chapters.length - 1 && page >= pageCount - 1) || saving}
                onClick={() => turnPage(1)}
                title={t('Next page (→)')}
                aria-label={t('Next page')}
              >
                ›
              </button>
            </div>
            <div className="learning-progress-bar-track">
              <div
                className="learning-progress-bar-fill"
                style={{ width: `${book.chapters.length ? ((current + (page + 1) / pageCount) / book.chapters.length) * 100 : 0}%` }}
              />
            </div>
            <footer>
              <button disabled={(current <= 0 && page <= 0) || saving} onClick={() => turnPage(-1)}>{t('← Previous')}</button>
              <span className="learning-footer-pos" role="status">
                {saving ? 'Saving reading position…' : (saved || `${Math.round(book.chapters.length ? ((current + (page + 1) / pageCount) / book.chapters.length) * 100 : 0)}% completed`)}
              </span>
              <button disabled={current < 0 || (current >= book.chapters.length - 1 && page >= pageCount - 1) || saving} onClick={() => turnPage(1)}>{t('Next →')}</button>
            </footer>
          </div>
          {notesOpen && <aside className="learning-reader-notes" id="learning-reader-notes" aria-label="Reading notes">
            <header><h3>{t('My reading notes')}</h3><button onClick={() => setNotesOpen(false)} aria-label="Close notes palette">×</button></header>
            <p>{t('Private notes, saved with this book.')}</p>
            <fieldset disabled={noteBusy}><legend>{t('Note color')}</legend><div className="learning-note-colors">
              {(['yellow','purple','blue','green'] as const).map(color => <button key={color} className={`learning-note-color note-${color}`} aria-label={`${color} note`} aria-pressed={noteColor === color} onClick={() => setNoteColor(color)} />)}
            </div></fieldset>
            <label>{t('New note')}<textarea value={draftNote} maxLength={5000} rows={4} onChange={event => setDraftNote(event.target.value)} placeholder={t('Write your thoughts about this page…')} /></label>
            <button disabled={noteBusy || !draftNote.trim()} onClick={() => void saveNote()}>{noteBusy ? t('Saving…') : t('Save note')}</button>
            <div className="learning-note-list">{!notes.length && <p>{t('No notes yet.')}</p>}{notes.map(note => <article key={note.id} className={`learning-reader-note note-${note.color}`}>
              <button disabled={saving} onClick={() => goTo(note.chapter_id, undefined, note.page)}>{book.chapters.find(chapter => chapter.id === note.chapter_id)?.title} · Page {note.page + 1}</button>
              <p>{note.text}</p><button disabled={noteBusy} onClick={() => void deleteNote(note.id)}>{t('Delete note')}</button>
            </article>)}</div>
          </aside>}
        </div>
      ) : (
        !error && <p className="learning-loading" role="status">Opening your document…</p>
      )}
    </section>
  );
}

function QuizEditor({ folderId, initial, defaultLessonId, sources = [], onClose, onSaved, onReviewDraft, onQuizCreated }: { folderId: string; initial?: Quiz; defaultLessonId?: string | null; sources?: Array<{ id: string; title: string; kind?: 'document' | 'lesson' }>; onClose: () => void; onSaved: () => void; onReviewDraft: (id: string) => Promise<void>; onQuizCreated: () => void }) {
  const { language, t } = useLearningLanguage();
  const [authorLang, setAuthorLang] = useState<LearningLangCode>(() => getLearningLanguage());
  const initialLangData = initial?.translations?.[getLearningLanguage()];
  const [title, setTitle] = useState(initialLangData?.title || initial?.title || '');
  const [lessonId, setLessonId] = useState<string>(initial?.lesson_id || defaultLessonId || '');
  const [questions, setQuestions] = useState<Question[]>(
    initialLangData?.questions && initialLangData.questions.length === initial?.questions.length
      ? initialLangData.questions
      : initial?.questions || [newQuestion()]
  );
  const [translations, setTranslations] = useState<
    Record<string, { title: string; questions: Question[]; approved?: boolean }>
  >(() => {
    const map: Record<string, { title: string; questions: Question[]; approved?: boolean }> = {};
    if (initial?.translations) {
      for (const [k, v] of Object.entries(initial.translations)) {
        if (v && v.title && Array.isArray(v.questions)) {
          map[k] = { title: v.title, questions: v.questions, approved: v.approved };
        }
      }
    }
    return map;
  });
  const [approvedLanguages, setApprovedLanguages] = useState<string[]>(initial?.approved_languages || []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [i18nNotice, setI18nNotice] = useState('');
  const lessonOptions = sources.filter(s => s.kind === 'lesson');
  const orderedLangs = orderedLearningLanguages(language);

  const edit = (id: string, changes: Partial<Question>) =>
    setQuestions(items => items.map(question => (question.id === id ? { ...question, ...changes } : question)));

  const switchAuthorLang = (nextLang: LearningLangCode) => {
    const nextMap = {
      ...translations,
      [authorLang]: {
        title,
        questions,
        approved: approvedLanguages.includes(authorLang),
      },
    };
    const target = nextMap[nextLang];
    if (target && Array.isArray(target.questions) && target.questions.length === questions.length) {
      setTitle(target.title || title);
      setQuestions(target.questions);
    } else {
      nextMap[nextLang] = {
        title,
        questions: structuredClone(questions),
        approved: false,
      };
    }
    setTranslations(nextMap);
    setAuthorLang(nextLang);
  };

  const toggleApproveLang = (langCode: LearningLangCode) => {
    const nextApproved = new Set(approvedLanguages);
    if (nextApproved.has(langCode)) nextApproved.delete(langCode);
    else nextApproved.add(langCode);
    setApprovedLanguages(Array.from(nextApproved));
  };

  const generateAllThreeQuizLanguages = async () => {
    if (!title.trim()) {
      setError('Enter a quiz title and questions before generating all 3 languages.');
      return;
    }
    setBusy(true);
    setError('');
    setI18nNotice('');
    try {
      const order = orderedLearningLanguages(language);
      const primary = order[0];
      const baseEntry = {
        title: title.trim(),
        questions: structuredClone(questions),
        approved: approvedLanguages.includes(primary),
      };
      const nextMap: Record<string, { title: string; questions: Question[]; approved?: boolean }> = {
        ...translations,
        [primary]: baseEntry,
      };
      for (const targetLang of order.slice(1)) {
        const res = await api<{
          language: string;
          translated: { title?: string; questions?: Question[] };
        }>('/translate-content', {
          method: 'POST',
          body: json({
            kind: 'quiz',
            source_language: primary,
            target_language: targetLang,
            payload: { title: baseEntry.title, questions: baseEntry.questions },
          }),
        });
        nextMap[targetLang] = {
          title: res.translated.title || baseEntry.title,
          questions:
            Array.isArray(res.translated.questions) && res.translated.questions.length === baseEntry.questions.length
              ? res.translated.questions
              : structuredClone(baseEntry.questions),
          approved: false,
        };
      }
      setTranslations(nextMap);
      const activeEntry = nextMap[authorLang] || baseEntry;
      setTitle(activeEntry.title);
      setQuestions(activeEntry.questions);
      setI18nNotice(
        `Generated ${languageLabel(order[0])} first, followed by ${languageLabel(order[1])} and ${languageLabel(order[2])}. Review and approve all 3 languages.`
      );
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const saveInternal = async (approveAllAndFinish = false) => {
    setError('');
    if (!title.trim() || questions.some(question => !question.question.trim() || (question.type !== 'text' && (!question.options?.every(option => option.trim()) || !Array.isArray(question.answer) || !question.answer.length)) || (question.type === 'text' && (typeof question.answer !== 'string' || !question.answer.trim() || !question.rubric?.trim())))) {
      setError('Enter a title, complete every question, and provide its correct answer, or a reference answer and marking guidance for written questions.');
      return;
    }
    setBusy(true);
    try {
      const hasTranslations = Object.keys(translations).length > 0 || approveAllAndFinish;
      let finalTitle = title.trim();
      let finalQuestions = questions;
      let extraPayload: Record<string, unknown> = {};
      if (hasTranslations) {
        const nextMap = {
          ...translations,
          [authorLang]: {
            title: title.trim(),
            questions,
            approved: approveAllAndFinish ? true : approvedLanguages.includes(authorLang),
          },
        };
        if (approveAllAndFinish) {
          for (const code of ['en', 'el', 'hi'] as const) {
            const existing = nextMap[code];
            nextMap[code] = {
              title: existing?.title || title.trim(),
              questions: existing?.questions?.length === questions.length ? existing.questions : questions,
              approved: true,
            };
          }
        }
        const enEntry = nextMap.en;
        if (enEntry?.title && enEntry?.questions?.length === questions.length) {
          finalTitle = enEntry.title;
          finalQuestions = enEntry.questions;
        }
        extraPayload = {
          translations: nextMap,
          approved_languages: approveAllAndFinish ? ['en', 'el', 'hi'] : approvedLanguages,
        };
      }
      const saved = await api<{ id?: string }>(initial ? `/quizzes/${initial.id}` : `/folders/${folderId}/quizzes`, {
        method: initial ? 'PUT' : 'POST',
        body: json({
          title: finalTitle,
          book_id: initial?.book_id || null,
          lesson_id: lessonId || null,
          questions: finalQuestions,
          ...extraPayload,
        }),
      });
      if (approveAllAndFinish) {
        const targetId = initial?.id || saved?.id;
        if (targetId) {
          await api(`/quizzes/${targetId}/publish`, { method: 'POST', body: '{}' });
        }
      }
      onSaved();
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    await saveInternal(false);
  };

  return (
    <Dialog title={initial ? t('Edit quiz draft') : t('Create a quiz')} onClose={() => { if (!busy) onClose(); }} wide>
      <form onSubmit={event => void save(event)} className="learning-editor">
        <p className="learning-muted">Your draft is private until you approve and publish it. Only you, its creator, can edit or approve it. Saving a draft never publishes it. Answer keys and explanations are shown to learners only after they submit. Choice answers are scored automatically; {brandText("Buddy")} grades written responses using your reference answer and marking guidance. Publishing a new version opens a new attempt for each learner and preserves previous submissions.</p>
        {initial?.source_truncated && <p className="learning-alert" role="status">{brandText("Buddy")} used bounded excerpts rather than the complete book. Review every question and reference answer against the source before publishing.</p>}
        {i18nNotice && <p className="learning-notice" role="status">{i18nNotice}</p>}

        {/* 3-Language Generation & Approval Bar */}
        <div className="learning-i18n-approval-bar" role="region" aria-label="3-Language Content Approval">
          <div className="learning-i18n-bar-top">
            <div>
              <strong>{t('3-Language Content Approval')}</strong>
              <span className="learning-i18n-order-hint">
                Generation order: {orderedLangs.map((c, idx) => `${idx + 1}. ${languageLabel(c)}`).join(' → ')}
              </span>
            </div>
            <div className="learning-i18n-bar-actions">
              <button
                type="button"
                className="learning-secondary-btn"
                disabled={busy}
                onClick={() => void generateAllThreeQuizLanguages()}
              >
                ✦ {t('Generate 3 Languages')} ({orderedLangs.map(c => c.toUpperCase()).join(' → ')})
              </button>
              <button
                type="button"
                className="learning-primary"
                disabled={busy}
                onClick={() => void saveInternal(true)}
              >
                ✓ {t('Approve All 3 Languages & Finish Draft')}
              </button>
            </div>
          </div>
          <div className="learning-i18n-lang-tabs">
            {orderedLangs.map((code, idx) => {
              const isApproved = approvedLanguages.includes(code) || Boolean(translations[code]?.approved);
              const hasContent = Boolean(code === authorLang ? title.trim() : translations[code]?.title?.trim());
              return (
                <div
                  key={code}
                  className={`learning-i18n-lang-pill ${authorLang === code ? 'is-active' : ''} ${
                    isApproved ? 'is-approved' : ''
                  }`}
                >
                  <button
                    type="button"
                    className="learning-i18n-tab-select"
                    onClick={() => switchAuthorLang(code)}
                  >
                    <span className="learning-i18n-step-num">{idx + 1}</span>
                    <span>{languageLabel(code)}</span>
                    <small>{hasContent ? (isApproved ? '✓ Approved' : 'Ready') : 'Draft'}</small>
                  </button>
                  <button
                    type="button"
                    className={`learning-i18n-approve-toggle ${isApproved ? 'is-approved' : ''}`}
                    onClick={() => toggleApproveLang(code)}
                  >
                    {isApproved ? '✓' : 'Approve'}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
        <div className="learning-editor-row">
          <label>
            {t('Quiz title')}
            <input required maxLength={200} value={title} onChange={event => setTitle(event.target.value)} />
          </label>
          {lessonOptions.length > 0 && (
            <label>
              Chapter (Interactive Class)
              <select value={lessonId} onChange={event => setLessonId(event.target.value)}>
                <option value="">General Class Quiz</option>
                {lessonOptions.map((lesson, idx) => (
                  <option key={lesson.id} value={lesson.id}>
                    Chapter {idx + 1}: {lesson.title}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        {questions.map((question, index) => (
          <fieldset className="learning-question-editor" key={question.id}>
            <legend>Question {index + 1}</legend>
            <div className="learning-editor-row">
              <label>
                {t('Question type')}
                <select value={question.type} onChange={event => { const type = event.target.value as Question['type']; edit(question.id, { type, options: type === 'text' ? undefined : ['', ''], answer: type === 'text' ? '' : [] }); }}>
                  <option value="single">{t('Single choice')}</option>
                  <option value="multiple">{t('Multiple choice')}</option>
                  <option value="dropdown">{t('Dropdown')}</option>
                  <option value="text">{t('Written answer')}</option>
                </select>
              </label>
              <label>
                {t('Points')}
                <input type="number" required min="1" max="100" value={question.points} onChange={event => edit(question.id, { points: Number(event.target.value) })} />
              </label>
              <button type="button" className="learning-danger" disabled={questions.length === 1 || busy} onClick={() => setQuestions(items => items.filter(item => item.id !== question.id))}>
                {t('Remove question')}
              </button>
            </div>
            <label>
              {t('Question')}
              <textarea required maxLength={2000} value={question.question} onChange={event => edit(question.id, { question: event.target.value })} />
            </label>
            <label>Answer explanation<textarea maxLength={5000} value={question.explanation || ''} onChange={event => edit(question.id, { explanation: event.target.value })} placeholder="Explain why the correct answer is correct. Learners see this after submitting." /></label>
            <div className="learning-editor-row">
              <label>Study topic<input maxLength={200} value={question.study_topic || ''} onChange={event => edit(question.id, { study_topic: event.target.value })} placeholder="Concept this question assesses" /></label>
              <label>Further reading<input maxLength={1000} value={question.reading || ''} onChange={event => edit(question.id, { reading: event.target.value })} placeholder="Source chapter, section or author-provided reading reference" /></label>
            </div>
            {question.type === 'text' ? (
              <>
                <label>{t('Reference answer')}<textarea required maxLength={6000} value={typeof question.answer === 'string' ? question.answer : ''} onChange={event => edit(question.id, { answer: event.target.value })} /></label>
                <label>{t('Marking guidance')}<textarea required maxLength={5000} value={question.rubric || ''} onChange={event => edit(question.id, { rubric: event.target.value })} /></label>
              </>
            ) : (
              <div className="learning-option-editor">
                <p>Select the correct {question.type === 'multiple' ? 'answers' : 'answer'}.</p>
                {question.options?.map((option, optionIndex) => (
                  <div key={optionIndex}>
                    <input
                      aria-label={`Question ${index + 1}, option ${optionIndex + 1} is correct`}
                      type={question.type === 'multiple' ? 'checkbox' : 'radio'}
                      name={`correct-${question.id}`}
                      checked={Array.isArray(question.answer) && question.answer.includes(optionIndex)}
                      onChange={() => edit(question.id, { answer: question.type === 'multiple' ? Array.isArray(question.answer) && question.answer.includes(optionIndex) ? question.answer.filter(value => value !== optionIndex) : [...(Array.isArray(question.answer) ? question.answer : []), optionIndex] : [optionIndex] })}
                    />
                    <input
                      aria-label={`Question ${index + 1}, option ${optionIndex + 1}`}
                      required
                      maxLength={1000}
                      value={option}
                      onChange={event => edit(question.id, { options: question.options!.map((value, i) => i === optionIndex ? event.target.value : value) })}
                    />
                    <button type="button" aria-label={`Remove option ${optionIndex + 1}`} disabled={question.options!.length <= 2} onClick={() => edit(question.id, { options: question.options!.filter((_, i) => i !== optionIndex), answer: (Array.isArray(question.answer) ? question.answer : []).filter(value => value !== optionIndex).map(value => value > optionIndex ? value - 1 : value) })}>×</button>
                  </div>
                ))}
                <button type="button" disabled={(question.options?.length || 0) >= 8} onClick={() => edit(question.id, { options: [...(question.options || []), ''] })}>{t('+ Add option')}</button>
              </div>
            )}
          </fieldset>
        ))}
        <button type="button" disabled={busy || questions.length >= 30} onClick={() => setQuestions(items => [...items, newQuestion()])}>{t('+ Add question')}</button>
        {error && <p className="learning-alert" role="alert">{error}</p>}
        <footer className="learning-dialog-actions">
          <button type="button" disabled={busy} onClick={onClose}>{t('Cancel')}</button>
          <button type="submit" className="learning-primary" disabled={busy}>{busy ? 'Saving…' : t('Save draft')}</button>
        </footer>
      </form>
      <details open className="learning-editor-assistant">
        <summary>{t('Ask Buddy')}</summary>
        <p className="learning-muted">{initial ? t('Buddy uses the saved quiz. Save your draft first to include recent edits.') : t('Save your draft first to discuss its questions. You can also ask Buddy to create a separate new draft.')}</p>
        <LearningAssistant key={initial?.id || 'new'} folderId={folderId} quizId={initial?.id} bookId={initial?.book_id || undefined} lessonId={initial?.lesson_id || undefined} sources={sources} canCreate onReviewDraft={onReviewDraft} onQuizCreated={onQuizCreated} />
      </details>
    </Dialog>
  );
}

function TakeQuiz({ quizId, onClose, onSubmitted }: { quizId: string; onClose: () => void; onSubmitted: () => void }) {
  const { language, t } = useLearningLanguage();
  const [quiz, setQuiz] = useState<Quiz | null>(null);
  const [answers, setAnswers] = useState<Answers>({});
  const [questionIndex, setQuestionIndex] = useState(0);
  const [reviewing, setReviewing] = useState(false);
  const questionHeading = useRef<HTMLLegendElement>(null);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [result, setResult] = useState<Submission | null>(null);
  const [resultLoading, setResultLoading] = useState(false);
  const requestId = useRef(crypto.randomUUID());

  useEffect(() => {
    let active = true;
    api<Quiz>(`/quizzes/${quizId}`).then(async quiz => {
      if (!active) return;
      if (quiz.status === 'published' && !quiz.submitted) {
        await api(`/quizzes/${quizId}/start`, { method: 'POST', body: '{}' });
      }
      if (active) {
        setQuiz(quiz);
        setSubmitted(!!quiz.submitted);
        setResult(quiz.result || null);
      }
    }).catch(error => {
      if (active) setError(errorText(error));
    });
    return () => { active = false; };
  }, [quizId]);

  useEffect(() => {
    if (reviewing) reviewHeading.current?.focus();
    else questionHeading.current?.focus();
  }, [questionIndex, reviewing, quiz]);

  const activeQuestions =
    quiz &&
    quiz.translations?.[language]?.questions &&
    quiz.translations[language].questions!.length === quiz.questions.length
      ? quiz.translations[language].questions!
      : quiz?.questions || [];
  const activeQuizTitle = quiz ? quizTitle(quiz, language) : 'Opening quiz…';

  const answered = activeQuestions.filter(question => typeof answers[question.id] === 'string' ? (answers[question.id] as string).trim().length > 0 : (answers[question.id] as number[] | undefined)?.length).length || 0;
  const loadResult = async () => {
    setResultLoading(true);
    setError('');
    try { setResult(await api<Submission>(`/quizzes/${quizId}/my-result?version=${quiz?.version}`)); }
    catch (error) { setError(errorText(error)); }
    finally { setResultLoading(false); }
  };
  useEffect(() => {
    if (!submitted || !quiz || result) return;
    let active = true;
    api<Submission>(`/quizzes/${quizId}/my-result?version=${quiz.version}`)
      .then(result => { if (active) setResult(result); })
      .catch(error => { if (active) setError(errorText(error)); });
    return () => { active = false; };
  }, [submitted, quizId, quiz, result]);
  const retryGrading = async () => {
    setBusy(true);
    setError('');
    try { setResult(await api<Submission>(`/quizzes/${quizId}/my-result/grade?version=${quiz?.version}`, { method: 'POST', body: '{}' })); }
    catch (error) { setError(errorText(error)); }
    finally { setBusy(false); }
  };
  const currentQuestion = activeQuestions[questionIndex];
  const currentAnswer = currentQuestion ? answers[currentQuestion.id] : undefined;
  const currentAnswered = typeof currentAnswer === 'string' ? currentAnswer.trim().length > 0 : !!currentAnswer?.length;
  const isLastQuestion = !!quiz && questionIndex === activeQuestions.length - 1;
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!quiz || !currentAnswered || busy) return;
    if (!reviewing && !isLastQuestion) {
      setQuestionIndex(index => index + 1);
      return;
    }
    if (answered !== activeQuestions.length) return;
    if (!reviewing) {
      setReviewing(true);
      return;
    }
    setBusy(true);
    setError('');
    try {
      const response = await api<{ submitted: boolean; result?: Submission }>(`/quizzes/${quizId}/submit`, { method: 'POST', body: json({ version: quiz.version, answers, request_id: requestId.current }) });
      setResult(response.result || null);
      setSubmitted(true);
      setAnswers({});
      onSubmitted();
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title={activeQuizTitle} onClose={() => { if (!busy) onClose(); }} wide>
      {error && <p className="learning-alert" role="alert">{error}</p>}
      {(busy && !submitted) || (submitted && !result && !error) ? (
        <div className="learning-results"><QuizGradingState saved={submitted} /></div>
      ) : submitted ? (
        <div className="learning-results">
          <p className="learning-notice" role="status">{!result && error ? 'We could not load your results. Your saved attempt has not been changed.' : 'Your answers were submitted. Your results are shown below.'}</p>
          {result && <QuizReport submission={result} />}
          {result?.pending_manual && <div className="learning-grading-pending"><p>Some written answers still need grading. You can retry automatic grading or check back after an administrator reviews them.</p><button disabled={busy} onClick={() => void retryGrading()}>{busy ? 'Grading written answers…' : 'Retry automatic grading'}</button></div>}
          <footer className="learning-dialog-actions">
            <button disabled={busy || resultLoading} onClick={() => void loadResult()}>Refresh results</button>
            <button className="learning-primary" disabled={busy} onClick={onClose}>{t('Back to folder')}</button>
          </footer>
        </div>
      ) : (
        quiz && (
          <form className="learning-take-quiz" onSubmit={event => void submit(event)}>
            <p className="learning-muted">Take one question at a time. You can go back to change your answers before submitting your single attempt.</p>
            <div className="learning-quiz-progress">
              <div className="learning-quiz-progress-head">
                <span aria-live="polite">{reviewing ? 'Review your attempt' : `Question ${questionIndex + 1} of ${activeQuestions.length}`} · {answered} of {activeQuestions.length} answered</span>
                <span className="learning-quiz-progress-pill">{Math.round((answered / Math.max(1, activeQuestions.length)) * 100)}% complete</span>
              </div>
              <progress aria-label="Questions answered" value={answered} max={activeQuestions.length} />
              <div className="learning-quiz-stepper" aria-label="Question progress">
                {activeQuestions.map((q, idx) => {
                  const val = answers[q.id];
                  const isAns = typeof val === 'string' ? val.trim().length > 0 : Array.isArray(val) && val.length > 0;
                  const isCurr = !reviewing && idx === questionIndex;
                  return (
                    <span
                      key={q.id}
                      className={`learning-quiz-step-dot ${isAns ? 'is-answered' : ''} ${isCurr ? 'is-current' : ''}`}
                      title={`Question ${idx + 1}: ${isAns ? 'Answered' : 'Not answered yet'}`}
                    >
                      {isAns ? '✓' : ''} Q{idx + 1}
                    </span>
                  );
                })}
              </div>
            </div>
            {reviewing ? (
              <section className="learning-quiz-review" aria-labelledby="quiz-review-heading">
                <h3 id="quiz-review-heading" ref={reviewHeading} tabIndex={-1}>Ready to submit?</h3>
                <p>You have answered all {activeQuestions.length} questions. You can revisit any question below. Once submitted, your answers cannot be changed.</p>
                <div className="learning-quiz-question-nav" aria-label="Review questions">
                  {activeQuestions.map((question, index) => (
                    <button type="button" key={question.id} onClick={() => { setQuestionIndex(index); setReviewing(false); }} aria-label={`Review question ${index + 1}, answered`}>✓ {index + 1}</button>
                  ))}
                </div>
                <div className="learning-quiz-review-list">
                  {activeQuestions.map((question, index) => {
                    const val = answers[question.id];
                    const formattedAnswer = typeof val === 'string'
                      ? val.trim()
                      : Array.isArray(val) && val.length
                      ? val.map(optIdx => question.options?.[optIdx] ?? `Option ${optIdx + 1}`).join(', ')
                      : 'No answer selected';
                    return (
                      <div key={question.id} className="learning-quiz-review-item">
                        <div className="learning-quiz-review-item-main">
                          <div className="learning-quiz-review-item-top">
                            <span className="learning-quiz-review-qbadge">Question {index + 1}</span>
                            <span className="learning-quiz-review-answered-badge">✓ Answered · {question.points} {question.points === 1 ? 'pt' : 'pts'}</span>
                          </div>
                          <strong>{question.question}</strong>
                          <div className="learning-quiz-review-chosen">
                            <small>Your answer:</small> <span>{formattedAnswer}</span>
                          </div>
                        </div>
                        <button type="button" className="learning-chapter-mini-btn" onClick={() => { setQuestionIndex(index); setReviewing(false); }}>
                          Change
                        </button>
                      </div>
                    );
                  })}
                </div>
                <p className="learning-muted">After submitting, you and administrators can see your score, correct answers, explanations and personal study plan.</p>
              </section>
            ) : activeQuestions.slice(questionIndex, questionIndex + 1).map(question => (
              <fieldset className="learning-take-question" key={question.id}>
                <div className="learning-take-question-meta">
                  <span className="learning-take-question-type">
                    {question.type === 'multiple' ? 'Multiple choice' : question.type === 'dropdown' ? 'Dropdown choice' : question.type === 'text' ? 'Written answer' : 'Single choice'} · {question.points} {question.points === 1 ? 'point' : 'points'}
                  </span>
                  {currentAnswered && <span className="learning-take-question-answered">✓ Answer recorded</span>}
                </div>
                <legend ref={questionHeading} tabIndex={-1}><span>{questionIndex + 1}</span> {question.question}</legend>
                {question.type === 'text' ? (
                  <textarea aria-label={`Answer question ${questionIndex + 1}`} required maxLength={10000} disabled={busy} value={typeof answers[question.id] === 'string' ? answers[question.id] as string : ''} onChange={event => setAnswers(values => ({ ...values, [question.id]: event.target.value }))} />
                ) : question.type === 'dropdown' ? (
                  <select aria-label={`Answer question ${questionIndex + 1}`} required disabled={busy} value={(answers[question.id] as number[] | undefined)?.[0] ?? ''} onChange={event => setAnswers(values => ({ ...values, [question.id]: event.target.value === '' ? [] : [Number(event.target.value)] }))}>
                    <option value="">{t('Choose an answer…')}</option>
                    {question.options?.map((option, optionIndex) => <option key={optionIndex} value={optionIndex}>{option}</option>)}
                  </select>
                ) : (
                  <div className="learning-answer-options">
                    {question.type === 'multiple' && <small>{t('Select all that apply.')}</small>}
                    {question.options?.map((option, optionIndex) => {
                      const isChecked = Array.isArray(answers[question.id]) && (answers[question.id] as number[]).includes(optionIndex);
                      return (
                        <label key={optionIndex} className={isChecked ? 'is-selected' : ''}>
                          <input disabled={busy} type={question.type === 'multiple' ? 'checkbox' : 'radio'} name={`answer-${question.id}`} checked={isChecked} onChange={() => setAnswers(values => ({ ...values, [question.id]: question.type === 'multiple' ? Array.isArray(values[question.id]) && (values[question.id] as number[]).includes(optionIndex) ? (values[question.id] as number[]).filter(value => value !== optionIndex) : [...(Array.isArray(values[question.id]) ? values[question.id] as number[] : []), optionIndex] : [optionIndex] }))} />
                          <span className="learning-option-letter" aria-hidden="true">{String.fromCharCode(65 + optionIndex)}</span>
                          <span className="learning-option-label-text">{option}</span>
                          {isChecked && <span className="learning-option-selected-pill">✓ Selected</span>}
                        </label>
                      );
                    })}
                  </div>
                )}
              </fieldset>
            ))}
            <footer className="learning-dialog-actions">
              <button type="button" disabled={busy} onClick={onClose}>{t('Close')}</button>
              <button type="button" disabled={busy || (!reviewing && questionIndex === 0)} onClick={() => { if (reviewing) setReviewing(false); else setQuestionIndex(index => index - 1); }}>{reviewing ? 'Back to questions' : t('← Previous')}</button>
              <button type="submit" className="learning-primary" disabled={busy || !currentAnswered || (isLastQuestion && answered !== activeQuestions.length)}>{busy ? 'Submitting and grading…' : reviewing ? t('Submit answers') : isLastQuestion ? 'Review answers' : t('Next →')}</button>
            </footer>
          </form>
        )
      )}
    </Dialog>
  );
}

function ResultsPanel({ quizId, title, onClose }: { quizId: string; title: string; onClose: () => void }) {
  const [results, setResults] = useState<Results | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [grades, setGrades] = useState<Record<string, { score: number; feedback: string }>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [gradeNotice, setGradeNotice] = useState('');

  const loadRequest = useRef(0);
  const load = useCallback(async (signal?: AbortSignal) => {
    const request = ++loadRequest.current;
    try {
      const response = await api<Results>(`/quizzes/${quizId}/results`, { signal });
      if (request === loadRequest.current && !signal?.aborted) setResults(response);
    } catch (error) {
      if (request === loadRequest.current && !signal?.aborted) setError(errorText(error));
    }
  }, [quizId]);
  useEffect(() => {
    const controller = new AbortController();
    let inFlight = false;
    const refresh = async () => {
      if (inFlight || document.visibilityState === 'hidden') return;
      inFlight = true;
      try { await load(controller.signal); } finally { inFlight = false; }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    window.addEventListener('focus', refresh);
    return () => { controller.abort(); window.clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, [load]);

  const item = results?.items.find(result => result.id === selected);
  const select = (submission: Submission) => {
    if (busy) return;
    setGradeNotice('');
    setError('');
    setSelected(submission.id);
    setGrades(Object.fromEntries((submission.questions || results?.questions || []).filter(question => question.type === 'text').map(question => [question.id, { score: submission.grades?.[question.id]?.score ?? 0, feedback: submission.grades?.[question.id]?.feedback || '' }])));
  };

  const saveGrades = async () => {
    if (!item) return;
    setBusy(true);
    setError('');
    try {
      await api(`/submissions/${item.id}/grade`, { method: 'PUT', body: json({ grades }) });
      await load();
      setSelected(null);
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  };

  const suggestGrades = async () => {
    if (!item || busy) return;
    setBusy(true);
    setSuggesting(true);
    setError('');
    try {
      const suggestions = await api<{ grades: Record<string, { score: number; feedback: string }>; review_required: boolean }>(`/submissions/${item.id}/suggest-grades`, { method: 'POST', body: json({ language: getLearningLanguage() }) });
      setGrades(values => ({ ...values, ...suggestions.grades }));
      setGradeNotice(brandText('Buddy’s suggested marks are not saved. Review each score and note, then select Save marking.'));
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
      setSuggesting(false);
    }
  };

  const answerLabel = (question: Question, answer: string | number[] | undefined) => typeof answer === 'string' ? answer : Array.isArray(answer) ? answer.map(index => question.options?.[index] || String(index)).join(', ') : 'No answer';

  return (
    <Dialog title={`Results · ${title}`} onClose={() => { if (!busy) onClose(); }} wide>
      <div className="learning-results">
        <p className="learning-muted">Choice answers are scored automatically. {brandText("Buddy")} grades written answers against the published reference and rubric. Review individual reports and adjust written marks when needed.</p>
        {results && <QuizStatistics submissions={results.items} />}
        <div className="learning-results-updates"><a className="learning-button" href={`/api/learning/quizzes/${quizId}/results.csv`}>Download CSV</a><span className="learning-muted">Updates automatically every 5 seconds</span></div>
        {error && <p className="learning-alert" role="alert">{error}</p>}
        {results && !results.items.length && <p className="learning-empty">No submissions yet.</p>}
        {results && !!results.items.length && (
          <div className="learning-table-wrap">
            <table>
              <thead>
                <tr><th>User</th><th>Submitted</th><th>Score</th><th>Review</th></tr>
              </thead>
              <tbody>
                {results.items.map(submission => (
                  <tr key={submission.id}>
                    <td>{learningUserName(submission)}{submission.quiz_version && <small>Version {submission.quiz_version}</small>}</td>
                    <td>{new Date(submission.submitted_at).toLocaleString()}</td>
                    <td>{submission.score} / {submission.max_score}{submission.pending_manual && <small> · Marking pending</small>}</td>
                    <td><button disabled={busy} onClick={() => select(submission)}>View answers</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {item && (
          <section className="learning-submission">
            <h3>{learningUserName(item)} · Learning report</h3>
            <QuizReport key={item.id} submission={{ ...item, questions: item.questions || results?.questions }} administrator />
            {(item.questions || results?.questions || []).some(question => question.type === 'text') && (
              <div className="learning-suggest-grades">
                <button disabled={busy} onClick={() => void suggestGrades()}>{suggesting ? brandText('Buddy is grading…') : brandText('Ask Buddy to grade written answers')}</button>
                <p className="learning-muted">{brandText("Buddy")} can suggest marks using the reference answers and marking guidance. An administrator reviews and saves the final marks.</p>
              </div>
            )}
            {gradeNotice && <p className="learning-notice" role="status">{gradeNotice}</p>}
            {(item.questions || results?.questions || []).filter(question => question.type === 'text').map((question, index) => (
              <div className="learning-result-answer" key={question.id}>
                <h4>{index + 1}. {question.question}</h4>
                <p><strong>Submitted:</strong> {answerLabel(question, item.answers[question.id])}</p>
                <p><strong>Reference answer:</strong> {answerLabel(question, question.answer)}</p>
                {question.rubric && <p><strong>Marking guidance:</strong> {question.rubric}</p>}
                {question.type === 'text' && (
                  <div className="learning-editor-row">
                    <label>Score (0–{question.points})<input disabled={busy} type="number" min="0" max={question.points} step="1" value={grades[question.id]?.score ?? 0} onChange={event => setGrades(values => ({ ...values, [question.id]: { ...values[question.id], score: Number(event.target.value) } }))} /></label>
                    <label>Feedback for learner<input disabled={busy} maxLength={5000} value={grades[question.id]?.feedback || ''} onChange={event => setGrades(values => ({ ...values, [question.id]: { ...values[question.id], feedback: event.target.value } }))} /></label>
                  </div>
                )}
              </div>
            ))}
            {(item.questions || results?.questions || []).some(question => question.type === 'text') && (
              <button disabled={busy || (item.questions || results?.questions || []).some(question => question.type === 'text' && (!Number.isFinite(grades[question.id]?.score) || grades[question.id].score < 0 || grades[question.id].score > question.points))} className="learning-primary" onClick={() => void saveGrades()}>
                {busy && !suggesting ? 'Saving…' : 'Save marking'}
              </button>
            )}
          </section>
        )}
      </div>
    </Dialog>
  );
}

function FolderTree({ folders, selected, onSelect, canRename, onRename }: { folders: Folder[]; selected: string; onSelect: (id: string) => void; canRename?: boolean; onRename?: (folder: Folder) => void }) {
  const { language, t } = useLearningLanguage();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const ids = new Set(folders.map(folder => folder.id));
  const children = (id: string | null) => folders.filter(folder => id === null ? !folder.parent_id || !ids.has(folder.parent_id) : folder.parent_id === id);

  const render = (parent: string | null, depth = 0): React.ReactNode => depth > 30 ? null : children(parent).map(folder => {
    const nested = children(folder.id).length > 0;
    const displayName = folderName(folder, language);
    return (
      <div className="learning-folder-node" key={folder.id}>
        <div style={{ paddingInlineStart: depth * 14 }} className="learning-folder-row">
          {nested ? (
            <button
              type="button"
              className="learning-tree-toggle"
              aria-label={`${collapsed.has(folder.id) ? t('Expand folder') : t('Collapse folder')}: ${displayName}`}
              aria-expanded={!collapsed.has(folder.id)}
              onClick={() => setCollapsed(current => {
                const next = new Set(current);
                if (next.has(folder.id)) next.delete(folder.id); else next.add(folder.id);
                return next;
              })}
            >
              {collapsed.has(folder.id) ? '▸' : '▾'}
            </button>
          ) : (
            <span className="learning-tree-spacer" />
          )}
          <button
            type="button"
            className={`learning-folder-choice ${selected === folder.id ? 'is-active' : ''}`}
            aria-current={selected === folder.id ? 'page' : undefined}
            onClick={() => onSelect(folder.id)}
          >
            <span className="learning-folder-icon" aria-hidden="true">▤</span>
            <span className="learning-folder-name">{displayName}</span>
          </button>
          {canRename && onRename && selected === folder.id && (
            <button
              type="button"
              className="learning-tree-action-btn"
              title={t('Rename folder')}
              aria-label={`${t('Rename folder')}: ${displayName}`}
              onClick={(e) => {
                e.stopPropagation();
                onRename(folder);
              }}
            >
              ✎
            </button>
          )}
        </div>
        {nested && !collapsed.has(folder.id) && render(folder.id, depth + 1)}
      </div>
    );
  });
  return <nav className="learning-folder-tree" aria-label={t('Learning folders')}>{render(null)}</nav>;
}

function OfficeImportDialog({ folderId, onClose, onImported }: { folderId: string; onClose: () => void; onImported: () => void }) {
  const { t } = useLearningLanguage();
  const [files, setFiles] = useState<{ id: string; name: string; extension: string }[]>([]);
  const [query, setQuery] = useState('');
  const [activeQuery, setActiveQuery] = useState('');
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [selected, setSelected] = useState('');
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState('');
  const epoch = useRef(0);

  const load = async (offset = 0, term = activeQuery) => {
    const attempt = ++epoch.current;
    setLoading(true);
    setError('');
    try {
      const data = await api<{ items: { id: string; name: string; extension: string }[]; next_offset?: number | null }>(`/office-files?query=${encodeURIComponent(term)}&offset=${offset}&limit=25`);
      if (attempt !== epoch.current) return;
      setFiles(current => offset ? [...current, ...data.items] : data.items);
      setNextOffset(data.next_offset ?? null);
    } catch (error) {
      if (attempt === epoch.current) setError(errorText(error));
    } finally {
      if (attempt === epoch.current) setLoading(false);
    }
  };

  useEffect(() => { void load(0, ''); return () => { epoch.current += 1; }; }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const importFile = async () => {
    if (!selected || importing) return;
    setImporting(true);
    setError('');
    try {
      await api(`/folders/${folderId}/import-office`, { method: 'POST', body: json({ file_id: selected }) });
      onImported();
    } catch (error) {
      setError(errorText(error));
    } finally {
      setImporting(false);
    }
  };

  return (
    <Dialog title={t('Import from Office Suite')} onClose={() => { if (!importing) onClose(); }}>
      <div className="learning-editor">
        <p className="learning-muted">{t('Import an accessible Office file as a separate learning document. The original Office file is preserved and later edits are not synchronized.')}</p>
        <form className="learning-import-search" onSubmit={event => { event.preventDefault(); setActiveQuery(query.trim()); setSelected(''); void load(0, query.trim()); }}>
          <input aria-label={t('Search Office files…')} placeholder={t('Search Office files…')} maxLength={200} value={query} onChange={event => setQuery(event.target.value)} />
          <button type="submit" disabled={loading || importing}>{t('Search')}</button>
        </form>
        {error && <p className="learning-alert" role="alert">{error}</p>}
        <div className="learning-office-list">
          {files.map(file => (
            <label key={file.id}>
              <input type="radio" name="learning-office-import" value={file.id} disabled={importing} checked={selected === file.id} onChange={() => setSelected(file.id)} />
              <span>{file.name}<small>{file.extension.toUpperCase()}</small></span>
            </label>
          ))}
        </div>
        {loading && <p className="learning-muted" role="status">{t('Loading…')}</p>}
        {!loading && !files.length && <p className="learning-empty">{t('No accessible Office files found.')}</p>}
        {nextOffset !== null && <button disabled={loading || importing} onClick={() => void load(nextOffset)}>{t('Load more')}</button>}
        <footer className="learning-dialog-actions">
          <button disabled={importing} onClick={onClose}>{t('Cancel')}</button>
          <button className="learning-primary" disabled={importing || !selected} onClick={() => void importFile()}>{importing ? t('Importing…') : t('Import document')}</button>
        </footer>
      </div>
    </Dialog>
  );
}

export default function LearningWorkspace() {
  const { language, t } = useLearningLanguage();
  const [lessonToOpen, setLessonToOpen] = useState<string | null>(() => new URLSearchParams(window.location.search).get('lesson'));
  const [lessonEditorMode, setLessonEditorMode] = useState(false);
  const [createNewLessonTrigger, setCreateNewLessonTrigger] = useState(false);
  const [user, setUser] = useState<{ username: string; display_name?: string; is_admin: boolean; can_create_quizzes?: boolean; teacher_group?: string } | null>(null);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [folderId, setFolderId] = useState(() => parseLearningUrl().folderId);
  const [books, setBooks] = useState<Book[]>([]);
  const [quizzes, setQuizzes] = useState<QuizSummary[]>([]);
  const [notes, setNotes] = useState<ClassNote[]>([]);
  const [tab, setTab] = useState<'chapters' | 'notes' | 'library' | 'quizzes' | 'lessons' | 'classes' | 'completion'>(() => {
    const tParam = new URLSearchParams(window.location.search).get('tab');
    return tParam === 'chapters'
      ? 'chapters'
      : tParam === 'notes'
      ? 'notes'
      : tParam === 'classes'
      ? 'classes'
      : tParam === 'completion'
      ? 'completion'
      : tParam === 'lessons'
      ? 'lessons'
      : parseLearningUrl().quizId || tParam === 'quizzes'
      ? 'quizzes'
      : 'library';
  });
  const [bookId, setBookId] = useState<string | null>(() => parseLearningUrl().bookId);
  const [quizId, setQuizId] = useState<string | null>(() => parseLearningUrl().quizId);
  const [editor, setEditor] = useState<Quiz | 'new' | null>(null);
  const [quizDefaultLessonId, setQuizDefaultLessonId] = useState<string | null>(null);
  const [uploadTargetLessonId, setUploadTargetLessonId] = useState<string | null>(null);
  const [lessons, setLessons] = useState<LessonSummary[]>([]);
  const [resultsQuiz, setResultsQuiz] = useState<QuizSummary | null>(null);
  const [noteEditorOpen, setNoteEditorOpen] = useState(false);
  const [editingNote, setEditingNote] = useState<ClassNote | null>(null);
  const [noteDefaultLessonId, setNoteDefaultLessonId] = useState<string | null>(null);
  const [membersOpen, setMembersOpen] = useState(false);
  const [directory, setDirectory] = useState<{ username: string; display_name: string }[]>([]);
  const [members, setMembers] = useState<string[]>([]);
  const [groups, setGroups] = useState<string[]>([]);
  const [groupDirectory, setGroupDirectory] = useState<string[]>([]);
  const [appGroupDirectory, setAppGroupDirectory] = useState<{ id: string; name: string; description?: string; member_count?: number }[]>([]);
  const [selectedAppGroups, setSelectedAppGroups] = useState<string[]>([]);
  const [teacherDirectory, setTeacherDirectory] = useState<{ username: string; display_name: string }[]>([]);
  const [classTeacher, setClassTeacher] = useState<string>('');
  const [peopleAdminOpen, setPeopleAdminOpen] = useState(false);
  const [certificatesOpen, setCertificatesOpen] = useState(false);
  const [myCertificates, setMyCertificates] = useState<Array<{ id: string; class_id: string; recipient_name: string; course_title: string; instructor_name: string; issued_at: string; revoked_at?: string | null; email_status?: string; email_recipient?: string | null }>>([]);
  const [previewCertId, setPreviewCertId] = useState<string | null>(null);
  const [groupPath, setGroupPath] = useState('');
  const [directoryNote, setDirectoryNote] = useState('');
  const [parentFolder, setParentFolder] = useState<string>('');
  const [inheritedAccess, setInheritedAccess] = useState<Folder[]>([]);
  const [officeImport, setOfficeImport] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [newFolder, setNewFolder] = useState<string | null>(null);
  const [newFolderDesc, setNewFolderDesc] = useState<string>('');
  const [newFolderDocument, setNewFolderDocument] = useState<File | null>(null);
  const [newFolderBrief, setNewFolderBrief] = useState('');
  const [renamingFolder, setRenamingFolder] = useState<Folder | null>(null);
  const [deletingBook, setDeletingBook] = useState<Book | null>(null);
  const [deletingQuiz, setDeletingQuiz] = useState<QuizSummary | null>(null);
  const [deletingClass, setDeletingClass] = useState<Folder | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const contentEpoch = useRef(0);

  const hasRichClasses = folders.some(f => Boolean(f.is_class));
  const draftDeleteButton = (quiz: QuizSummary) => quiz.is_creator && quiz.status === 'draft' && quiz.version === 0
    ? <button type="button" className="learning-button-danger" disabled={busy} onClick={() => setDeletingQuiz(quiz)}>{t('Delete draft')}</button>
    : null;

  const routeReady = useRef(false);
  useEffect(() => {
    const sync = () => {
      const route = parseLearningUrl();
      const tParam = new URLSearchParams(window.location.search).get('tab');
      setFolderId(route.folderId); setBookId(route.bookId); setQuizId(route.quizId);
      setTab(
        tParam === 'chapters'
          ? 'chapters'
          : tParam === 'notes'
          ? 'notes'
          : tParam === 'classes'
          ? 'classes'
          : tParam === 'completion'
          ? 'completion'
          : tParam === 'lessons'
          ? 'lessons'
          : route.quizId || tParam === 'quizzes'
          ? 'quizzes'
          : tParam === 'library'
          ? 'library'
          : folders.some(f => Boolean(f.is_class))
          ? 'chapters'
          : 'library'
      );
      setEditor(null); setResultsQuiz(null); setLessonToOpen(new URLSearchParams(window.location.search).get('lesson'));
    };
    window.addEventListener('popstate', sync);
    return () => window.removeEventListener('popstate', sync);
  }, [folders]);
  useEffect(() => {
    if (loading) return;
    const target = new URL(learningPath(folderId, bookId, quizId, tab), window.location.origin);
    if (bookId && window.location.pathname === target.pathname) {
      const current = new URLSearchParams(window.location.search);
      for (const key of ['chapter','page']) if (current.has(key)) target.searchParams.set(key, current.get(key)!);
    }
    if (target.pathname + target.search !== window.location.pathname + window.location.search) {
      window.history[routeReady.current ? 'pushState' : 'replaceState']({}, '', target);
    }
    routeReady.current = true;
  }, [folderId, bookId, quizId, tab, loading]);

  // Sidebar resize controls matching main Buddy
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    try {
      const saved = localStorage.getItem('bob_learning_sidebar_width') || localStorage.getItem('bob_sidebar_width');
      if (saved) {
        const val = Number(saved);
        if (val >= 260 && val <= 850) return val;
      }
    } catch {}
    return 300;
  });
  const [isResizing, setIsResizing] = useState(false);

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
  };

  const setSidebarWidthAndPersist = (newWidth: number) => {
    setSidebarWidth(newWidth);
    try {
      localStorage.setItem('bob_learning_sidebar_width', String(newWidth));
    } catch {}
  };

  const handleResetWidth = () => {
    setSidebarWidthAndPersist(300);
  };

  useEffect(() => {
    if (!isResizing) return;
    const handleMouseMove = (e: MouseEvent) => {
      const minWidth = 260;
      const maxWidth = Math.min(850, window.innerWidth * 0.65);
      const newWidth = Math.max(minWidth, Math.min(maxWidth, e.clientX));
      setSidebarWidth(Math.round(newWidth));
    };
    const handleMouseUp = () => {
      setIsResizing(false);
      try {
        localStorage.setItem('bob_learning_sidebar_width', String(sidebarWidth));
      } catch {}
    };
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    document.body.classList.add('resizing-sidebar');
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      document.body.classList.remove('resizing-sidebar');
    };
  }, [isResizing, sidebarWidth]);

  const activeFolder = folders.find(folder => folder.id === folderId);
  const [canManageClassState, setCanManageClassState] = useState<boolean | null>(null);
  const buildClassTranslations = async (name: string, description: string) => {
    const langs = orderedLearningLanguages(language);
    const source = langs[0];
    const translations: Record<string, { name: string; description: string }> = { [source]: { name, description } };
    for (const target of langs.slice(1)) {
      try {
        const out = await api<{ translated: { name?: string; description?: string } }>('/translate-content', {
          method: 'POST',
          body: json({ kind: 'class', source_language: source, target_language: target, payload: { name, description } }),
        });
        translations[target] = { name: out.translated?.name || name, description: out.translated?.description ?? description };
      } catch {
        translations[target] = { name, description };
      }
    }
    return { translations, approved_languages: [...langs] };
  };
  const canManageClass = Boolean(
    user?.is_admin ||
      (user?.can_create_quizzes &&
        (canManageClassState ??
          activeFolder?.can_manage ??
          (!hasRichClasses || activeFolder?.teacher_username === user?.username)))
  );

  const refreshFolders = async () => {
    try {
      const folderData = await api<{ items: Folder[] }>('/folders');
      setFolders(folderData.items);
    } catch {}
  };

  useEffect(() => {
    let active = true;
    Promise.all([
      api<{ username: string; display_name?: string; is_admin: boolean; can_create_quizzes?: boolean; teacher_group?: string }>('/me'),
      api<{ items: Folder[] }>('/folders'),
    ]).then(([userData, folderData]) => {
      if (active) {
        setUser(userData);
        setFolders(folderData.items);
        const rich = folderData.items.some(f => Boolean(f.is_class));
        const urlHasTab = new URLSearchParams(window.location.search).has('tab');
        const urlHasQuiz = Boolean(parseLearningUrl().quizId);
        const urlHasBook = Boolean(parseLearningUrl().bookId);
        setFolderId(previous => {
          if (previous && folderData.items.some(folder => folder.id === previous)) {
            if (rich && !urlHasTab && !urlHasQuiz && !urlHasBook) {
              setTab('chapters');
            }
            return previous;
          }
          // In real sessions (rich classes), land on the All Classes Catalog when no class is in the URL.
          if (rich) {
            return '';
          }
          return folderData.items[0]?.id || '';
        });
      }
    }).catch(error => {
      if (active) setError(errorText(error));
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, []);

  const reload = async () => {
    if (!folderId) return;
    const epoch = ++contentEpoch.current;
    try {
      const result = await api<{
        books: Book[];
        quizzes: QuizSummary[];
        lessons?: LessonSummary[];
        notes?: ClassNote[];
        can_manage_class?: boolean;
      }>(`/folders/${folderId}/contents`);
      if (epoch === contentEpoch.current) {
        setBooks(result.books);
        setQuizzes(result.quizzes);
        setLessons(result.lessons || []);
        setNotes(result.notes || []);
        setCanManageClassState(
          typeof result.can_manage_class === 'boolean' ? result.can_manage_class : null
        );
      }
    } catch (error) {
      if (epoch === contentEpoch.current) {
        setBooks([]);
        setQuizzes([]);
        setLessons([]);
        setNotes([]);
        setCanManageClassState(null);
        setError(errorText(error));
      }
    }
  };

  useEffect(() => {
    setBooks([]);
    setQuizzes([]);
    setLessons([]);
    setNotes([]);
    setCanManageClassState(null);
    setSearch('');
    setNotice('');
    setError('');
    void reload();
    return () => { contentEpoch.current += 1; };
  }, [folderId]); // eslint-disable-line react-hooks/exhaustive-deps

  const action = async (work: () => Promise<void>) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await work();
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  };

  const upload = (file: File | undefined, targetLessonId: string | null = uploadTargetLessonId) => {
    setUploadTargetLessonId(null);
    if (!file || !folderId) return;
    void action(async () => {
      const body = new FormData();
      body.append('file', file);
      const query = targetLessonId ? `?lesson_id=${encodeURIComponent(targetLessonId)}` : '';
      await api(`/folders/${folderId}/books${query}`, { method: 'POST', body });
      await reload();
      void refreshFolders();
      setNotice(targetLessonId ? 'Document uploaded and attached to chapter.' : 'Document uploaded.');
    });
  };

  const assignBookToChapter = (bookIdToUpdate: string, newLessonId: string | null) => {
    void action(async () => {
      await api(`/books/${bookIdToUpdate}`, {
        method: 'PATCH',
        body: json({ lesson_id: newLessonId }),
      });
      await reload();
      setNotice(newLessonId ? 'Document assigned to chapter.' : 'Document moved to general class resources.');
    });
  };

  const assignQuizToChapter = (quizIdToUpdate: string, newLessonId: string | null) => {
    void action(async () => {
      await api(`/quizzes/${quizIdToUpdate}/chapter`, {
        method: 'PATCH',
        body: json({ lesson_id: newLessonId }),
      });
      await reload();
      setNotice(newLessonId ? 'Quiz assigned to chapter.' : 'Quiz moved to general class resources.');
    });
  };

  const reorderChapters = (fromIndex: number, toIndex: number) => {
    if (toIndex < 0 || toIndex >= lessons.length || busy) return;
    const next = [...lessons];
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved);
    setLessons(next);
    void action(async () => {
      await api(`/folders/${folderId}/lessons/order`, {
        method: 'PUT',
        body: json({ lesson_ids: next.map(l => l.id) }),
      });
      await reload();
      setNotice('Chapter order updated.');
    });
  };

  const saveClassNote = async (payload: {
    id?: string;
    title: string;
    body: string;
    color: StickyNoteColor;
    tags: string[];
    favorite: boolean;
    lesson_id: string | null;
  }) => {
    setBusy(true);
    try {
      if (payload.id) {
        await api(`/notes/${payload.id}`, {
          method: 'PATCH',
          body: json({
            title: payload.title,
            body: payload.body,
            color: payload.color,
            tags: payload.tags,
            favorite: payload.favorite,
            lesson_id: payload.lesson_id,
          }),
        });
      } else {
        await api(`/folders/${folderId}/notes`, {
          method: 'POST',
          body: json({
            title: payload.title,
            body: payload.body,
            color: payload.color,
            tags: payload.tags,
            favorite: payload.favorite,
            lesson_id: payload.lesson_id,
          }),
        });
      }
      setNoteEditorOpen(false);
      setEditingNote(null);
      setNoteDefaultLessonId(null);
      await reload();
      void refreshFolders();
      setNotice(payload.id ? 'Sticky note updated.' : brandText('Sticky note pinned to class and synced with your Buddy Notes.'));
    } finally {
      setBusy(false);
    }
  };

  const toggleNoteFavorite = async (note: ClassNote) => {
    await action(async () => {
      await api(`/notes/${note.id}`, {
        method: 'PATCH',
        body: json({ favorite: !note.favorite }),
      });
      await reload();
    });
  };

  const deleteClassNote = async (noteId: string) => {
    await action(async () => {
      await api(`/notes/${noteId}`, { method: 'DELETE' });
      await reload();
      void refreshFolders();
      setNotice('Sticky note deleted.');
    });
  };

  const selectClass = (id: string) => {
    setFolderId(id);
    setBookId(null);
    setQuizId(null);
    if (hasRichClasses) {
      setTab('chapters');
    }
    setSidebarOpen(false);
  };

  const manageMembersForFolder = (targetFolderId = folderId) => void action(async () => {
    if (!targetFolderId) return;
    if (targetFolderId !== folderId) setFolderId(targetFolderId);
    const [users, access, knownGroups, appGroups, teachers] = await Promise.all([
      api<{ items: { username: string; display_name: string }[]; directory_note?: string }>('/users'),
      api<{ items: { username: string }[]; groups: string[]; app_groups?: string[]; teacher_username?: string | null; inherited_from?: Folder[] }>(`/folders/${targetFolderId}/members`),
      api<{ items: { path: string }[]; note?: string }>('/groups'),
      api<{ items: { id: string; name: string; description?: string; member_count?: number }[] }>('/admin/app-groups').catch(() => ({ items: [] })),
      api<{ items: { username: string; display_name: string }[] }>(`/folders/${targetFolderId}/class-teachers`).catch(() => ({ items: [] })),
    ]);
    setDirectory(users.items);
    setMembers(access.items.map(item => item.username));
    setGroups(access.groups || []);
    setSelectedAppGroups(access.app_groups || []);
    setAppGroupDirectory(appGroups.items || []);
    setTeacherDirectory(teachers.items || []);
    setClassTeacher(access.teacher_username || '');
    setInheritedAccess(access.inherited_from || []);
    setGroupDirectory([...new Set([...knownGroups.items.map(item => item.path), ...(access.groups || [])])]);
    setDirectoryNote(users.directory_note || 'This directory contains users provisioned through verified Keycloak sign-in.');
    setGroupPath('');
    setMembersOpen(true);
  });

  const manageMembers = () => manageMembersForFolder(folderId);

  const openCertificates = () => void action(async () => {
    const result = await api<{ items: Array<{ id: string; class_id: string; recipient_name: string; course_title: string; instructor_name: string; issued_at: string; revoked_at?: string | null; email_status?: string; email_recipient?: string | null }> }>('/certificates');
    setMyCertificates(result.items || []);
    setPreviewCertId(null);
    setCertificatesOpen(true);
  });

  const reviewDraft = async (id: string) => {
    const draft = await api<Quiz>(`/quizzes/${id}`);
    setEditor(draft);
    await reload();
  };

  return (
    <div className="shell learning-shell">
      {/* Mobile backdrop */}
      {sidebarOpen && (
        <div
          className="sidebar-backdrop"
          onClick={() => setSidebarOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Main Buddy-Matching Sidebar */}
      <aside
        className={`sidebar learning-sidebar ${sidebarOpen ? 'open' : ''}`}
        id="workspace-sidebar"
        aria-label={t('Workspace sidebar')}
        style={{ '--sidebar-width': `${sidebarWidth}px`, width: `${sidebarWidth}px` } as React.CSSProperties}
      >
        {/* Draggable Resize Handle */}
        <div
          className={`sidebar-resize-handle ${isResizing ? 'is-active' : ''}`}
          role="slider" tabIndex={0} aria-orientation="horizontal" aria-valuemin={260} aria-valuemax={Math.max(260, Math.min(850, Math.floor(window.innerWidth * 0.65)))} aria-valuenow={sidebarWidth}
          onMouseDown={handleMouseDown}
          onDoubleClick={handleResetWidth}
          onKeyDown={event => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const max = Math.max(260, Math.min(850, Math.floor(window.innerWidth * 0.65)));
            const next = event.key === 'Home' ? 260 : event.key === 'End' ? max : sidebarWidth + (event.key === 'ArrowLeft' ? -10 : 10);
            setSidebarWidthAndPersist(Math.max(260, Math.min(max, next)));
          }}
          title={t('Drag to resize sidebar width · Double-click to reset (300px)')}
          aria-label={t('Resize sidebar width')}
        />

        {/* Brand Header */}
        <a
          className="brand brand-home"
          href="/"
          aria-label={brandText(`${t('Buddy')} — ${t('Back to main app')}`)}
          title={t('Back to main app')}
        >
          <div className="brand-mark" aria-hidden="true">
            <img src={brandLogoUrl()} width="40" height="40" alt="" />
          </div>
          <div>
            <div className="brand-name">
              {t('Buddy')}
            </div>
            <div className="brand-subtitle">{t('Learning Workspace')}</div>
          </div>
        </a>

        {/* Account Info */}
        <div className="account-row">
          <span>
            {user ? learningUserName(user) : t('Not signed in')}
            {(user?.is_admin || user?.can_create_quizzes) && (
              <b className="learning-user-role-badge">
                {user?.is_admin ? t('Administrator') : t('Teacher')}
              </b>
            )}
          </span>
          {user && (
            <a href="/" className="learning-account-back-link" title={t('Back to main app')}>
              {t('Main app')}
            </a>
          )}
        </div>

        {/* Prominent Back to Main App Button */}
        <a
          className="new-chat learning-back-btn"
          href="/"
          title={t('Return to Buddy')}
        >
          <span aria-hidden="true">←</span> {t('Back to main app')}
        </a>

        {/* Scrollable Sidebar Content for all Learning Options */}
        <div className="sidebar-sections learning-sidebar-sections">
          {/* Navigation Section */}
          <nav className="sidebar-nav" aria-label={t('Navigation')}>
            <div className="sidebar-group-label">{t('Class Contents')}</div>

            {/* All Classes Catalog Button */}
            <button
              className={`tasks-nav ${!folderId && !bookId ? 'active' : ''}`}
              type="button"
              onClick={() => {
                setFolderId('');
                setBookId(null);
                setQuizId(null);
                setSidebarOpen(false);
              }}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M3 4h8v7H3zM13 4h8v7h-8zM3 13h8v7H3zM13 13h8v7h-8z" />
              </svg>
              <span className="sidebar-nav-label">All Classes</span>
              <span className="sidebar-nav-badge">{folders.length}</span>
            </button>

            {activeFolder && (
              <>
                <button
                  className={`tasks-nav ${tab === 'chapters' && !bookId ? 'active' : ''}`}
                  type="button"
                  onClick={() => {
                    setTab('chapters');
                    setBookId(null);
                    setSidebarOpen(false);
                  }}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M4 6h16M4 12h16M4 18h10" />
                  </svg>
                  <span className="sidebar-nav-label">Chapters</span>
                  <span className="sidebar-nav-badge">{lessons.length}</span>
                </button>

                <button
                  className={`tasks-nav ${tab === 'notes' && !bookId ? 'active' : ''}`}
                  type="button"
                  onClick={() => {
                    setTab('notes');
                    setBookId(null);
                    setSidebarOpen(false);
                  }}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M12 17v5M8 3h8l-1.5 6 3.5 3.5V14H6v-1.5L9.5 9 8 3z" />
                  </svg>
                  <span className="sidebar-nav-label">Sticky Notes</span>
                  <span className="sidebar-nav-badge">{notes.length}</span>
                </button>

                <button
                  className={`tasks-nav ${tab === 'lessons' && !bookId ? 'active' : ''}`}
                  type="button"
                  onClick={() => {
                    setTab('lessons');
                    setBookId(null);
                    setSidebarOpen(false);
                  }}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 10 7-10 7V5Z" /></svg>
                  <span className="sidebar-nav-label">{t('Lessons')}</span>
                  <span className="sidebar-nav-badge">{lessons.length}</span>
                </button>

                {/* Library Tab */}
                <button
                  className={`tasks-nav ${tab === 'library' && !bookId ? 'active' : ''}`}
                  type="button"
                  onClick={() => { setTab('library'); setBookId(null); setSidebarOpen(false); }}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M12 5v15M12 5C9 3 5 3 3 4v14c3-1 6-1 9 2 3-3 6-3 9-2V4c-2-1-6-1-9 1Z" />
                  </svg>
                  <span className="sidebar-nav-label">{t('Library')}</span>
                  <span className="sidebar-nav-badge">{books.length}</span>
                </button>

                {/* Quizzes Tab */}
                <button
                  className={`tasks-nav ${tab === 'quizzes' && !bookId ? 'active' : ''}`}
                  type="button"
                  onClick={() => { setTab('quizzes'); setBookId(null); setSidebarOpen(false); }}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="m4 12 5 5 11-11" />
                  </svg>
                  <span className="sidebar-nav-label">{t('Quizzes')}</span>
                  <span className="sidebar-nav-badge">{quizzes.length}</span>
                </button>

                <button
                  className={`tasks-nav ${tab === 'completion' && !bookId ? 'active' : ''}`}
                  type="button"
                  onClick={() => { setTab('completion'); setBookId(null); setSidebarOpen(false); }}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2l3 6 6 .9-4.3 4.2 1 6-5.7-3-5.7 3 1-6L3 8.9 9 8z" /></svg>
                  <span className="sidebar-nav-label">{t('Certificates & completion')}</span>
                </button>
              </>
            )}

            {/* Ask Buddy Toggle */}
            {activeFolder && (
              <button
                className={`tasks-nav ${assistantOpen ? 'active' : ''}`}
                type="button"
                onClick={() => { setAssistantOpen(open => !open); setSidebarOpen(false); }}
                aria-expanded={assistantOpen}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z" />
                </svg>
                <span className="sidebar-nav-label">Learning Coach</span>
                <span className={`sidebar-nav-badge ${assistantOpen ? 'badge-on' : ''}`}>
                  {assistantOpen ? 'ON' : 'OFF'}
                </span>
              </button>
            )}
          </nav>

          {/* Learning Actions Section */}
          <div className="sidebar-group-label sidebar-library-label">
            {t('Learning Actions')}
          </div>
          <div className="learning-quick-actions">
            <button
              type="button"
              className="tasks-nav learning-action-btn"
              disabled={busy}
              onClick={openCertificates}
              title={t('My certificates')}
            >
              <span className="learning-action-icon" aria-hidden="true">★</span>
              <span className="sidebar-nav-label">{t('My certificates')}</span>
            </button>
            {activeFolder && (
              <button
                type="button"
                className="tasks-nav learning-action-btn"
                disabled={busy}
                onClick={() => {
                  setEditingNote(null);
                  setNoteDefaultLessonId(null);
                  setNoteEditorOpen(true);
                }}
                title="New sticky note"
              >
                <span className="learning-action-icon" aria-hidden="true">📌</span>
                <span className="sidebar-nav-label">New sticky note</span>
              </button>
            )}
            {user?.is_admin && activeFolder && (
              <button
                type="button"
                className="tasks-nav learning-action-btn"
                disabled={busy}
                onClick={() => {
                  setUploadTargetLessonId(null);
                  fileInput.current?.click();
                }}
                title={t('Upload document')}
              >
                <span className="learning-action-icon" aria-hidden="true">↑</span>
                <span className="sidebar-nav-label">{t('Upload document')}</span>
              </button>
            )}
            {user?.can_create_quizzes && activeFolder && (
              <button
                type="button"
                className="tasks-nav learning-action-btn"
                disabled={busy}
                onClick={() => {
                  setQuizDefaultLessonId(null);
                  setEditor('new');
                }}
                title={t('New quiz')}
              >
                <span className="learning-action-icon" aria-hidden="true">＋</span>
                <span className="sidebar-nav-label">{t('New quiz')}</span>
              </button>
            )}
            {user?.is_admin && activeFolder && (
              <button
                type="button"
                className="tasks-nav learning-action-btn"
                disabled={busy}
                onClick={() => setOfficeImport(true)}
                title={t('Office Suite import')}
              >
                <span className="learning-action-icon" aria-hidden="true">⇪</span>
                <span className="sidebar-nav-label">{t('Office Suite import')}</span>
              </button>
            )}
            {user?.is_admin && activeFolder && (
              <button
                type="button"
                className="tasks-nav learning-action-btn"
                disabled={busy}
                onClick={manageMembers}
                title={t('Enroll & class access')}
              >
                <span className="learning-action-icon" aria-hidden="true">👥</span>
                <span className="sidebar-nav-label">{t('Enroll & class access')}</span>
              </button>
            )}
            {user?.is_admin && (
              <button
                type="button"
                className="tasks-nav learning-action-btn"
                disabled={busy}
                onClick={() => setPeopleAdminOpen(true)}
                title={t('Manage groups & teachers')}
              >
                <span className="learning-action-icon" aria-hidden="true">⚙</span>
                <span className="sidebar-nav-label">{t('Groups & teachers')}</span>
              </button>
            )}
          </div>

          {/* Hidden File Input for Document Upload */}
          <input
            ref={fileInput}
            hidden
            type="file"
            accept=".epub,.pdf,.docx,.pptx,.xlsx,.csv,.html,.htm,.txt,.md"
            onChange={event => {
              upload(event.target.files?.[0]);
              event.target.value = '';
            }}
          />

          {/* Classes Section with Add Class button */}
          <div className="section-heading learning-folders-heading">
            <span className="section-heading-title">
              <span>{t('LEARNING CLASSES')}</span>
            </span>
            {user?.is_admin && (
              <button
                className="add-item"
                type="button"
                disabled={busy}
                aria-label={t('Create learning folder')}
                title={t('Create learning class')}
                onClick={(e) => {
                  e.stopPropagation();
                  setParentFolder(folderId);
                  setNewFolder('');
                  setNewFolderDesc('');
                }}
              >
                ＋
              </button>
            )}
          </div>

          {/* Folder Tree */}
          <div className="learning-tree-container">
            <FolderTree
              folders={folders}
              selected={folderId}
              canRename={!!user?.is_admin}
              onRename={folder => setRenamingFolder(folder)}
              onSelect={id => selectClass(id)}
            />
            {!folders.length && !loading && (
              <p className="sidebar-empty">
                {user?.is_admin ? 'Create your first class to get started.' : 'No classes have been assigned to you yet.'}
              </p>
            )}
          </div>

          {/* Sidebar Note */}
          <div className="sidebar-hint learning-sidebar-hint">
            <span>◇ </span>
            {user?.is_admin
              ? 'Organize classes into chapters with interactive lessons, quizzes, documents, and sticky notes.'
              : 'Your learning space is private. Complete chapters and quizzes at your own pace.'}
          </div>
        </div>

        {/* Sidebar Width Presets matching main screen */}
        <div className="sidebar-width-controls" title={t('Adjust sidebar width')}>
          <span className="sidebar-width-label">{t('Width:')}</span>
          <div className="sidebar-width-btns">
            <button
              type="button"
              className={`sidebar-width-btn ${sidebarWidth === 300 ? 'active' : ''}`}
              onClick={() => setSidebarWidthAndPersist(300)}
              title={t('Standard width (300px)')}
            >
              {t('Std')}
            </button>
            <button
              type="button"
              className={`sidebar-width-btn ${sidebarWidth === 460 ? 'active' : ''}`}
              onClick={() => setSidebarWidthAndPersist(460)}
              title={t('Wide width (460px)')}
            >
              {t('Wide')}
            </button>
            <button
              type="button"
              className={`sidebar-width-btn ${sidebarWidth === 580 ? 'active' : ''}`}
              onClick={() => setSidebarWidthAndPersist(580)}
              title={t('Maximum width (580px)')}
            >
              {t('Max')}
            </button>
          </div>
        </div>

        {/* Footer Status */}
        <div className="sidebar-bottom">
          <span className="status-dot ready" />
          <span>{t('Learning Buddy · {{ORGANIZATION}} ACP')}</span>
        </div>
      </aside>

      {/* Main Canvas Area */}
      <div className="main learning-main-wrap">
        {bookId ? (
          <EbookReader key={bookId} bookId={bookId} onClose={() => setBookId(null)} />
        ) : (
          <>
            {/* Topbar Header matching main Buddy style */}
            <header className="topbar learning-topbar buddy-toolbar">
              <button
                className="mobile-menu learning-mobile-toggle"
                aria-label={t('Toggle navigation menu')}
                onClick={() => setSidebarOpen(open => !open)}
              >
                ☰
              </button>
              <div className="topbar-heading">
                <div className="learning-topbar-title-row">
                  {activeFolder && (
                    <button
                      type="button"
                      className="learning-back-to-classes-pill"
                      onClick={() => {
                        setFolderId('');
                        setBookId(null);
                        setQuizId(null);
                      }}
                      title="Back to All Classes"
                    >
                      ← {t('All Classes')}
                    </button>
                  )}
                  <h1>{activeFolder ? folderName(activeFolder, language) : t('All Online Classes')}</h1>
                  {user?.is_admin && activeFolder && (
                    <button
                      type="button"
                      className="learning-inline-action-btn"
                      title={t('Rename folder')}
                      aria-label={`${t('Rename folder')}: ${folderName(activeFolder, language)}`}
                      onClick={() => setRenamingFolder(activeFolder)}
                    >
                      ✎
                    </button>
                  )}
                </div>
                <p>
                  {activeFolder
                    ? folderDesc(activeFolder, language) || 'Structured chapters with interactive lessons, quizzes, documents, and sticky notes'
                    : t('Select a class to access its structured chapters, interactive lectures, study materials, quizzes, and your personal sticky notes.')}
                </p>
              </div>

              <div className="topbar-actions">
                {user && (
                  <div className="learning-topbar-identity-group">
                    <span className="learning-topbar-user" aria-label={`Signed in as ${learningUserName(user)}`}>
                      {learningUserName(user)}
                    </span>
                    <LearningLanguageSelector compact />
                  </div>
                )}
                {!user && <LearningLanguageSelector compact />}
                <div className="learning-topbar-search-wrap">
                  <input
                    className="learning-topbar-search"
                    aria-label={!activeFolder ? 'Search classes…' : tab === 'library' ? t('Search documents…') : tab === 'lessons' || tab === 'chapters' ? 'Search chapters…' : t('Search quizzes…')}
                    placeholder={!activeFolder ? 'Search classes…' : tab === 'library' ? t('Search documents…') : tab === 'lessons' || tab === 'chapters' ? 'Search chapters…' : t('Search quizzes…')}
                    value={search}
                    onChange={event => setSearch(event.target.value)}
                  />
                  {search && (
                    <button
                      type="button"
                      className="learning-search-clear"
                      onClick={() => setSearch('')}
                      aria-label={t('Clear search')}
                    >
                      ×
                    </button>
                  )}
                </div>

                <button className="topbar-deck-btn" disabled={busy} onClick={openCertificates}>
                  <span aria-hidden="true">★</span> {t('My certificates')}
                </button>

                {user?.is_admin && activeFolder && (
                  <button className="topbar-deck-btn" disabled={busy} onClick={manageMembers}>
                    <span aria-hidden="true">♙</span> {t('♙ Manage access')}
                  </button>
                )}

                <button
                  type="button"
                  className="learning-refresh-btn"
                  disabled={busy}
                  onClick={() => {
                    void reload();
                    void refreshFolders();
                  }}
                  title={t('Refresh')}
                  aria-label={t('Refresh')}
                >
                  ↻
                </button>
              </div>
            </header>

            {/* Main Content Area */}
            <main className="learning-main">
              {error && <div className="learning-alert" role="alert">{error}</div>}
              {notice && <div className="learning-notice" role="status">{notice}</div>}
              {loading && <p className="learning-loading" role="status">Loading your learning space…</p>}

              {!activeFolder && !loading && (
                <section className="learning-catalog-section" aria-label="All Classes">
                  <div className="learning-catalog-hero">
                    <div>
                      <span className="learning-catalog-eyebrow">LEARNING ACADEMY</span>
                      <h2>Choose a Class</h2>
                      <p>
                        Open any class to progress chapter by chapter through interactive lessons, documents, knowledge quizzes, and your personal sticky notes.
                      </p>
                    </div>
                    <div className="learning-catalog-hero-actions">
                      {user?.is_admin && (
                        <>
                          <button
                            type="button"
                            className="learning-primary"
                            onClick={() => {
                              setParentFolder('');
                              setNewFolder('');
                              setNewFolderDesc('');
                            }}
                          >
                            + Create New Class
                          </button>
                          <button type="button" onClick={() => setPeopleAdminOpen(true)}>
                            ⚙ Groups & Teachers
                          </button>
                        </>
                      )}
                    </div>
                  </div>

                  {folders.length === 0 ? (
                    <div className="learning-empty">
                      <span>▤</span>
                      <h2>No classes yet</h2>
                      <p>
                        {user?.is_admin
                          ? 'Create your first class to add chapters, interactive lessons, documents, and quizzes.'
                          : 'No classes have been assigned to you yet.'}
                      </p>
                      {user?.is_admin && (
                        <button
                          type="button"
                          className="learning-primary"
                          onClick={() => {
                            setParentFolder('');
                            setNewFolder('');
                            setNewFolderDesc('');
                          }}
                        >
                          + Create First Class
                        </button>
                      )}
                    </div>
                  ) : (
                    <div className="learning-catalog-grid">
                      {folders
                        .filter(cls =>
                          `${folderName(cls, language)} ${folderDesc(cls, language)} ${cls.name} ${cls.description || ''} ${cls.teacher_display_name || ''}`
                            .toLowerCase()
                            .includes(search.toLowerCase())
                        )
                        .map((cls, index) => {
                          const totalChapters = cls.lesson_count ?? 0;
                          const doneChapters = cls.completed_lesson_count ?? 0;
                          const totalQuizzes = cls.quiz_count ?? 0;
                          const doneQuizzes = cls.submitted_quiz_count ?? 0;
                          const totalItems = totalChapters + totalQuizzes;
                          const doneItems = doneChapters + doneQuizzes;
                          const progressPct = totalItems > 0 ? Math.round((doneItems / totalItems) * 100) : 0;

                          return (
                            <article
                              key={cls.id}
                              className={`learning-class-catalog-card accent-${index % 4}`}
                            >
                              <div className="learning-class-catalog-top">
                                <span className="learning-class-badge">{t('ONLINE CLASS')}</span>
                                {cls.has_certificate && (
                                  <span className="learning-class-cert-badge">★ Certificate Earned</span>
                                )}
                              </div>

                              <div
                                className="learning-class-catalog-body"
                                onClick={() => selectClass(cls.id)}
                                role="button"
                                tabIndex={0}
                                onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && selectClass(cls.id)}
                              >
                                <h3>{folderName(cls, language)}</h3>
                                <p>
                                  {folderDesc(cls, language) ||
                                    'Structured chapters with interactive lessons, reading materials, chapter quizzes, and sticky notes.'}
                                </p>
                              </div>

                              <div className="learning-class-catalog-metrics">
                                <span>
                                  <strong>{totalChapters}</strong> {totalChapters === 1 ? t('Chapter') : t('Chapters')}
                                </span>
                                <span>
                                  <strong>{totalQuizzes}</strong> {totalQuizzes === 1 ? 'Quiz' : t('Quizzes')}
                                </span>
                                <span>
                                  <strong>{cls.book_count ?? 0}</strong> {cls.book_count === 1 ? 'Document' : 'Documents'}
                                </span>
                                <span>
                                  <strong>{cls.note_count ?? 0}</strong> {t('Sticky Notes')}
                                </span>
                              </div>

                              <div className="learning-class-catalog-progress">
                                <div className="learning-class-progress-labels">
                                  <span>
                                    {doneChapters}/{totalChapters} {t('chapters')} · {doneQuizzes}/{totalQuizzes} {t('quizzes')}
                                  </span>
                                  <strong>{progressPct}%</strong>
                                </div>
                                <div className="learning-class-progress-track">
                                  <div
                                    className="learning-class-progress-fill"
                                    style={{ width: `${progressPct}%` }}
                                  />
                                </div>
                              </div>

                              <div className="learning-class-catalog-footer">
                                <div className="learning-class-instructor">
                                  {cls.teacher_display_name ? (
                                    <span>Instructor: <strong>{cls.teacher_display_name}</strong></span>
                                  ) : (
                                    <span>Self-paced online class</span>
                                  )}
                                </div>
                                <div className="learning-class-card-actions">
                                  {cls.can_delete && <button type="button" className="learning-button-danger" disabled={busy} onClick={() => setDeletingClass(cls)}>{t('Delete class')}</button>}
                                  {user?.is_admin && (
                                    <>
                                      <button
                                        type="button"
                                        className="learning-card-secondary-btn"
                                        onClick={() => manageMembersForFolder(cls.id)}
                                        title="Enroll learners & assign teacher"
                                      >
                                        {t('Access')}
                                      </button>
                                      <button
                                        type="button"
                                        className="learning-card-secondary-btn"
                                        onClick={() => setRenamingFolder(cls)}
                                        title="Edit class name & description"
                                      >
                                        Edit
                                      </button>
                                    </>
                                  )}
                                  <button
                                    type="button"
                                    className="learning-primary"
                                    onClick={() => selectClass(cls.id)}
                                  >
                                    {t('Enter Class →')}
                                  </button>
                                </div>
                              </div>
                            </article>
                          );
                        })}
                    </div>
                  )}
                </section>
              )}

              {activeFolder && (
                <>
                  {!bookId && !quizId && <LearningNextSteps
                    lessons={lessons.map(lesson => ({ ...lesson, title: lessonTitle(lesson, language) }))}
                    quizzes={quizzes.map(quiz => ({ ...quiz, title: quizTitle(quiz, language) }))}
                    onLesson={id => { setTab('lessons'); setLessonToOpen(id); }}
                    onQuiz={id => { setTab('quizzes'); setQuizId(id); }}
                  />}
                  {/* Tabs Bar with Tool Actions */}
                  <div className="learning-tabs-bar">
                    <div className="learning-tabs" role="tablist" aria-label="Folder contents">
                      {hasRichClasses && (
                        <button
                          role="tab"
                          aria-selected={tab === 'chapters'}
                          aria-controls="learning-chapters"
                          id="learning-chapters-tab"
                          onClick={() => {
                            void reload();
                            void refreshFolders();
                            setTab('chapters');
                          }}
                        >
                          Chapters <span>{lessons.length}</span>
                        </button>
                      )}
                      {hasRichClasses && (
                        <button
                          role="tab"
                          aria-selected={tab === 'notes'}
                          aria-controls="learning-notes"
                          id="learning-notes-tab"
                          onClick={() => setTab('notes')}
                        >
                          Sticky Notes <span>{notes.length}</span>
                        </button>
                      )}
                      <button
                        role="tab"
                        aria-selected={tab === 'library'}
                        aria-controls="learning-library"
                        id="learning-library-tab"
                        onClick={() => setTab('library')}
                      >
                        {t('Library')} <span>{books.length}</span>
                      </button>
                      <button
                        role="tab"
                        aria-selected={tab === 'quizzes'}
                        aria-controls="learning-quizzes"
                        id="learning-quizzes-tab"
                        onClick={() => setTab('quizzes')}
                      >
                        {t('Quizzes')} <span>{quizzes.length}</span>
                      </button>
                      <button
                        role="tab"
                        aria-selected={tab === 'lessons'}
                        aria-controls="learning-lessons"
                        id="learning-lessons-tab"
                        onClick={() => setTab('lessons')}
                      >
                        {t('Lessons')} <span>{lessons.length}</span>
                      </button>
                      <button role="tab" aria-selected={tab === 'completion'} aria-controls="learning-completion" id="learning-completion-tab" onClick={() => setTab('completion')}>{t('Certificates & completion')}</button>
                    </div>

                    <div className="learning-tab-actions">
                      {tab === 'chapters' && (
                        <>
                          {canManageClass && (
                            <button
                              type="button"
                              className="learning-primary"
                              disabled={busy}
                              onClick={() => {
                                setLessonToOpen(null);
                                setLessonEditorMode(false);
                                setCreateNewLessonTrigger(true);
                                setTab('lessons');
                              }}
                            >
                              + Add Chapter
                            </button>
                          )}
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => {
                              setEditingNote(null);
                              setNoteDefaultLessonId(null);
                              setNoteEditorOpen(true);
                            }}
                          >
                            + Sticky Note
                          </button>
                        </>
                      )}
                      {tab === 'notes' && (
                        <button
                          type="button"
                          className="learning-primary"
                          disabled={busy}
                          onClick={() => {
                            setEditingNote(null);
                            setNoteDefaultLessonId(null);
                            setNoteEditorOpen(true);
                          }}
                        >
                          + New Sticky Note
                        </button>
                      )}
                      {tab === 'library' && user?.is_admin && (
                        <>
                          <button
                            className="learning-primary"
                            disabled={busy}
                            onClick={() => {
                              setUploadTargetLessonId(null);
                              fileInput.current?.click();
                            }}
                          >
                            {busy ? 'Working…' : t('+ Upload document')}
                          </button>
                          <button disabled={busy} onClick={() => setOfficeImport(true)}>
                            {t('Import from Office Suite')}
                          </button>
                        </>
                      )}
                      {tab === 'quizzes' && user?.can_create_quizzes && (
                        <button
                          className="learning-primary"
                          disabled={busy}
                          onClick={() => {
                            setQuizDefaultLessonId(null);
                            setEditor('new');
                          }}
                        >
                          {t('+ Create quiz')}
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Tab Panels */}
                  {tab === 'chapters' ? (
                    <section
                      role="tabpanel"
                      id="learning-chapters"
                      aria-labelledby="learning-chapters-tab"
                      className="learning-chapters-view"
                    >
                      {/* Class Overview Hero Banner */}
                      <div className="learning-course-hero">
                        <div className="learning-course-hero-main">
                          <div className="learning-course-hero-badges">
                            <span className="learning-class-badge">{t('ONLINE CLASS')}</span>
                            {activeFolder.teacher_display_name && (
                              <span className="learning-instructor-pill">
                                Instructor: {activeFolder.teacher_display_name}
                              </span>
                            )}
                            {activeFolder.has_certificate && (
                              <span className="learning-class-cert-badge">★ Certificate Earned</span>
                            )}
                          </div>
                          <h2>{folderName(activeFolder, language)}</h2>
                          <p>
                            {folderDesc(activeFolder, language) ||
                              t('Follow each chapter in order: start with the interactive lecture, study the attached readings, and complete the chapter quiz.')}
                          </p>
                        </div>

                        <div className="learning-course-hero-stats">
                          <div className="learning-course-stat-box">
                            <strong>
                              {lessons.filter(l => l.completed).length} / {lessons.length}
                            </strong>
                            <span>{t('Chapters')} {t('Completed')}</span>
                          </div>
                          <div className="learning-course-stat-box">
                            <strong>
                              {quizzes.filter(q => q.submitted).length} / {quizzes.filter(q => q.status === 'published' || q.is_creator).length}
                            </strong>
                            <span>{t('Quizzes')}</span>
                          </div>
                          <div className="learning-course-stat-box">
                            <strong>{books.length}</strong>
                            <span>Documents</span>
                          </div>
                          <div className="learning-course-stat-box">
                            <strong>{notes.length}</strong>
                            <span>{t('Sticky Notes')}</span>
                          </div>
                        </div>
                      </div>

                      {/* Chapter-by-Chapter Stream */}
                      {lessons.length === 0 ? (
                        <div className="learning-empty" style={{ marginTop: 20 }}>
                          <span>▶</span>
                          <h2>No chapters in this class yet</h2>
                          <p>
                            {user?.is_admin || user?.can_create_quizzes
                              ? 'Create your first Chapter (Interactive Class) to organize lessons, documents, quizzes, and sticky notes.'
                              : 'Your instructor is preparing the chapters for this class.'}
                          </p>
                          {(user?.is_admin || user?.can_create_quizzes) && (
                            <button
                              type="button"
                              className="learning-primary"
                              onClick={() => {
                                setLessonToOpen(null);
                                setLessonEditorMode(false);
                                setCreateNewLessonTrigger(true);
                                setTab('lessons');
                              }}
                            >
                              + Create Chapter 1
                            </button>
                          )}
                        </div>
                      ) : (
                        <div className="learning-chapters-list">
                          {lessons
                            .filter(lesson =>
                              `${lessonTitle(lesson, language)} ${lessonDesc(lesson, language)} ${lesson.title} ${lesson.description || ''}`
                                .toLowerCase()
                                .includes(search.toLowerCase())
                            )
                            .map((lesson, idx) => {
                              const chapterNumber = idx + 1;
                              const chapterQuizzes = quizzes.filter(q => q.lesson_id === lesson.id);
                              const chapterBooks = books.filter(b => b.lesson_id === lesson.id);
                              const chapterNotes = notes.filter(n => n.lesson_id === lesson.id);
                              const unlinkedBooks = books.filter(b => !b.lesson_id);
                              const isStarted = Boolean(lesson.started || (lesson.current_step ?? 0) > 0);
                              const stoppedSection = Math.min(
                                (lesson.current_step ?? 0) + 1,
                                Math.max(1, lesson.step_count || (lesson.current_step ?? 0) + 1)
                              );
                              const localChapterTitle = lessonTitle(lesson, language);
                              const localChapterDesc = lessonDesc(lesson, language);

                              return (
                                <article
                                  key={lesson.id}
                                  className={`learning-chapter-card ${
                                    lesson.completed
                                      ? 'is-chapter-completed'
                                      : isStarted
                                      ? 'is-chapter-in-progress'
                                      : ''
                                  }`}
                                >
                                  {/* Chapter Header */}
                                  <header className="learning-chapter-header">
                                    <div className="learning-chapter-title-wrap">
                                      <div className="learning-chapter-eyebrow-row">
                                        <span className="learning-chapter-pill">
                                          {t('Chapter').toUpperCase()} {chapterNumber}
                                        </span>
                                        {lesson.completed ? (
                                          <span className="learning-chapter-status is-done">
                                            ✓ {t('Completed')}
                                          </span>
                                        ) : isStarted ? (
                                          <span className="learning-chapter-status is-progress">
                                            {t('In progress')} · Stopped at Section {stoppedSection} of {lesson.step_count || '?'}
                                          </span>
                                        ) : (
                                          <span className={`learning-status status-${lesson.status}`}>
                                            {lesson.status}
                                          </span>
                                        )}
                                      </div>
                                      <h3>
                                        {t('Chapter')} {chapterNumber}: {localChapterTitle}
                                      </h3>
                                      {localChapterDesc && (
                                        <p className="learning-chapter-desc">{localChapterDesc}</p>
                                      )}
                                    </div>

                                    <div className="learning-chapter-admin-controls">
                                      {canManageClass &&
                                        !search &&
                                        lessons.length > 1 && (
                                          <div className="lesson-reorder-controls">
                                            <button
                                              type="button"
                                              className="lesson-order-btn"
                                              disabled={busy || idx === 0}
                                              onClick={() => reorderChapters(idx, idx - 1)}
                                              title="Move chapter earlier"
                                              aria-label={`Move ${localChapterTitle} earlier`}
                                            >
                                              ▲
                                            </button>
                                            <button
                                              type="button"
                                              className="lesson-order-btn"
                                              disabled={busy || idx === lessons.length - 1}
                                              onClick={() => reorderChapters(idx, idx + 1)}
                                              title="Move chapter later"
                                              aria-label={`Move ${localChapterTitle} later`}
                                            >
                                              ▼
                                            </button>
                                          </div>
                                        )}
                                      {lesson.is_creator && (
                                        <button
                                          type="button"
                                          className="learning-chapter-mini-btn"
                                          onClick={() => {
                                            setLessonEditorMode(true);
                                            setLessonToOpen(lesson.id);
                                            setTab('lessons');
                                          }}
                                        >
                                          ✎ {t('Edit Chapter')}
                                        </button>
                                      )}
                                    </div>
                                  </header>

                                  {/* 3-Column Chapter Content Modules */}
                                  <div className="learning-chapter-modules-grid">
                                    {/* 1. Interactive Class Module */}
                                    <div className="learning-chapter-module module-interactive">
                                      <div className="learning-module-head">
                                        <span className="learning-module-icon">
                                          {lesson.completed ? '✓' : '▶'}
                                        </span>
                                        <div>
                                          <strong>{t('Interactive Class')}</strong>
                                          <small>
                                            {lesson.completed
                                              ? `✓ ${t('Completed')} (${lesson.step_count || 1} ${t('sections')})`
                                              : isStarted
                                              ? `Saved at Section ${stoppedSection} of ${lesson.step_count || '?'}`
                                              : lesson.step_count
                                              ? `${lesson.step_count} ${t('sections')}`
                                              : 'Interactive slides, boards & practice'}
                                          </small>
                                        </div>
                                      </div>
                                      <p className="learning-module-copy">
                                        {lesson.completed
                                          ? 'You have completed all sections of this interactive class. You can review any section at any time.'
                                          : isStarted
                                          ? `You left off at Section ${stoppedSection} of ${lesson.step_count || '?'}. Resume right where you stopped.`
                                          : 'Step-by-step interactive walkthrough with explanations, decision boards, and practice checks.'}
                                      </p>
                                      <div className="learning-module-actions">
                                        <button
                                          type="button"
                                          className="learning-primary"
                                          onClick={() => {
                                            setLessonEditorMode(false);
                                            setLessonToOpen(lesson.id);
                                            setTab('lessons');
                                          }}
                                        >
                                          {lesson.completed
                                            ? `✓ ${t('Completed')} · ${t('Review Chapter →')}`
                                            : isStarted
                                            ? `Resume at Section ${stoppedSection} →`
                                            : t('Start Chapter →')}
                                        </button>
                                        {lesson.is_creator && (
                                          <button
                                            type="button"
                                            onClick={() => {
                                              setLessonEditorMode(true);
                                              setLessonToOpen(lesson.id);
                                              setTab('lessons');
                                            }}
                                          >
                                            Edit
                                          </button>
                                        )}
                                      </div>
                                    </div>

                                    {/* 2. Chapter Quiz Module */}
                                    <div className="learning-chapter-module module-quiz">
                                      <div className="learning-module-head">
                                        <span className="learning-module-icon">✓</span>
                                        <div>
                                          <strong>{t('Chapter')} {chapterNumber} Quiz</strong>
                                          <small>
                                            {chapterQuizzes.length
                                              ? `${chapterQuizzes.length} ${chapterQuizzes.length === 1 ? 'assessment' : 'assessments'}`
                                              : 'Knowledge check'}
                                          </small>
                                        </div>
                                      </div>

                                      {chapterQuizzes.length === 0 ? (
                                        <p className="learning-module-empty">
                                          No quiz attached to this chapter yet.
                                        </p>
                                      ) : (
                                        <div className="learning-module-item-list">
                                          {chapterQuizzes.map(q => (
                                            <div key={q.id} className="learning-module-item">
                                              <div className="learning-module-item-info">
                                                <strong>{quizTitle(q, language)}</strong>
                                                <span>
                                                  <b className={`learning-status status-${q.status}`}>{q.status}</b>
                                                  {q.question_count ? ` · ${q.question_count} questions` : ''}
                                                  {q.submitted && q.score != null && q.max_score != null
                                                    ? ` · Score: ${q.score}/${q.max_score}`
                                                    : q.submitted
                                                    ? ' · Submitted'
                                                    : ''}
                                                </span>
                                              </div>
                                              <div className="learning-module-item-actions">
                                                {(q.status === 'published' || q.submitted) && (
                                                  <button
                                                    type="button"
                                                    className={q.submitted ? '' : 'learning-primary'}
                                                    onClick={() => setQuizId(q.id)}
                                                  >
                                                    {q.submitted ? `${t('My Results')} →` : t('Start Quiz →')}
                                                  </button>
                                                )}
                                                {draftDeleteButton(q)}
                                                {q.is_creator && q.status !== 'published' && (
                                                  <>
                                                    <button
                                                      type="button"
                                                      disabled={busy}
                                                      onClick={() =>
                                                        void action(async () =>
                                                          setEditor(await api<Quiz>(`/quizzes/${q.id}`))
                                                        )
                                                      }
                                                    >
                                                      {t('Edit draft')}
                                                    </button>
                                                    <button
                                                      type="button"
                                                      className="learning-primary"
                                                      disabled={busy}
                                                      onClick={() =>
                                                        void action(async () => {
                                                          await api(`/quizzes/${q.id}/publish`, {
                                                            method: 'POST',
                                                            body: '{}',
                                                          });
                                                          await reload();
                                                          setNotice('Chapter quiz published.');
                                                        })
                                                      }
                                                    >
                                                      Publish
                                                    </button>
                                                  </>
                                                )}
                                                {(user?.is_admin || q.can_view_results || (canManageClass && q.is_creator)) && (
                                                  <button
                                                    type="button"
                                                    disabled={busy}
                                                    onClick={() => setResultsQuiz(q)}
                                                  >
                                                    {t('Results')}
                                                  </button>
                                                )}
                                              </div>
                                            </div>
                                          ))}
                                        </div>
                                      )}

                                      {canManageClass && (
                                        <div className="learning-module-footer-actions">
                                          <button
                                            type="button"
                                            className="learning-chapter-mini-btn"
                                            disabled={busy}
                                            onClick={() =>
                                              void action(async () => {
                                                const draft = await api<
                                                  QuizSummary & { source_truncated?: boolean; untranslated?: string[] }
                                                >(`/lessons/${lesson.id}/quiz-draft`, {
                                                  method: 'POST',
                                                  body: json({
                                                    title: `${lesson.title} · Chapter Quiz`,
                                                    count: 10,
                                                    language: getLearningLanguage(),
                                                  }),
                                                });
                                                const complete = await api<Quiz>(`/quizzes/${draft.id}`);
                                                await reload();
                                                setEditor({
                                                  ...complete,
                                                  source_truncated: draft.source_truncated,
                                                });
                                                setNotice(brandText('Chapter quiz draft created by Buddy.') + untranslatedWarning(draft.untranslated));
                                              })
                                            }
                                          >
                                            ✦ Draft Quiz with {brandText("Buddy")}
                                          </button>
                                          <button
                                            type="button"
                                            className="learning-chapter-mini-btn"
                                            disabled={busy}
                                            onClick={() => {
                                              setQuizDefaultLessonId(lesson.id);
                                              setEditor('new');
                                            }}
                                          >
                                            + Create Quiz
                                          </button>
                                        </div>
                                      )}
                                    </div>

                                    {/* 3. Chapter Documents Module */}
                                    <div className="learning-chapter-module module-docs">
                                      <div className="learning-module-head">
                                        <span className="learning-module-icon">▤</span>
                                        <div>
                                          <strong>Chapter {chapterNumber} Documents</strong>
                                          <small>
                                            {chapterBooks.length
                                              ? `${chapterBooks.length} reading ${chapterBooks.length === 1 ? 'material' : 'materials'}`
                                              : 'Slides, PDFs & reference books'}
                                          </small>
                                        </div>
                                      </div>

                                      {chapterBooks.length === 0 ? (
                                        <p className="learning-module-empty">
                                          No reading documents attached to this chapter yet.
                                        </p>
                                      ) : (
                                        <div className="learning-module-item-list">
                                          {chapterBooks.map(book => (
                                            <div key={book.id} className="learning-module-item">
                                              <div className="learning-module-item-info">
                                                <strong>{book.title}</strong>
                                                <span>
                                                  {(book.extension || 'epub').toUpperCase()}
                                                  {book.author ? ` · ${book.author}` : ''}
                                                </span>
                                              </div>
                                              <div className="learning-module-item-actions">
                                                <button
                                                  type="button"
                                                  className="learning-primary"
                                                  onClick={() => setBookId(book.id)}
                                                >
                                                  Read →
                                                </button>
                                                <a
                                                  className="learning-button"
                                                  href={`/api/learning/books/${encodeURIComponent(book.id)}/download`}
                                                >
                                                  Download
                                                </a>
                                                {canManageClass && (
                                                  <button
                                                    type="button"
                                                    title="Move back to general class library"
                                                    onClick={() => assignBookToChapter(book.id, null)}
                                                  >
                                                    Unlink
                                                  </button>
                                                )}
                                              </div>
                                            </div>
                                          ))}
                                        </div>
                                      )}

                                      {canManageClass && (
                                        <div className="learning-module-footer-actions">
                                          {user?.is_admin && (
                                            <button
                                              type="button"
                                              className="learning-chapter-mini-btn"
                                              disabled={busy}
                                              onClick={() => {
                                                setUploadTargetLessonId(lesson.id);
                                                fileInput.current?.click();
                                              }}
                                            >
                                              ↑ Upload Document
                                            </button>
                                          )}
                                          {unlinkedBooks.length > 0 && (
                                            <select
                                              className="learning-chapter-assign-select"
                                              value=""
                                              onChange={e => {
                                                if (e.target.value) {
                                                  assignBookToChapter(e.target.value, lesson.id);
                                                }
                                              }}
                                              aria-label={`Attach existing document to Chapter ${chapterNumber}`}
                                            >
                                              <option value="">+ Attach existing document…</option>
                                              {unlinkedBooks.map(b => (
                                                <option key={b.id} value={b.id}>
                                                  {b.title} ({(b.extension || 'epub').toUpperCase()})
                                                </option>
                                              ))}
                                            </select>
                                          )}
                                        </div>
                                      )}
                                    </div>
                                  </div>

                                  {/* Chapter Sticky Notes Strip */}
                                  <ChapterStickyNotesStrip
                                    chapterId={lesson.id}
                                    chapterNumber={chapterNumber}
                                    chapterTitle={lesson.title}
                                    notes={chapterNotes}
                                    onAddNote={lid => {
                                      setEditingNote(null);
                                      setNoteDefaultLessonId(lid);
                                      setNoteEditorOpen(true);
                                    }}
                                    onEditNote={note => {
                                      setEditingNote(note);
                                      setNoteDefaultLessonId(note.lesson_id || null);
                                      setNoteEditorOpen(true);
                                    }}
                                    onOpenAllNotes={() => setTab('notes')}
                                  />
                                </article>
                              );
                            })}
                        </div>
                      )}

                      {/* Unassigned / General Class Resources */}
                      {(books.some(b => !b.lesson_id) ||
                        quizzes.some(q => !q.lesson_id && q.status !== 'closed')) && (
                        <section className="learning-general-resources">
                          <header className="learning-general-resources-head">
                            <div>
                              <h3>General Class Library & Quizzes</h3>
                              <p>
                                Class-wide reference materials and assessments not tied to a single chapter.
                                {(user?.is_admin || user?.can_create_quizzes) && lessons.length > 0
                                  ? ' Use the chapter selector on any item to move it into a specific chapter.'
                                  : ''}
                              </p>
                            </div>
                          </header>

                          <div className="learning-general-grid">
                            {books
                              .filter(b => !b.lesson_id)
                              .map(book => (
                                <div key={book.id} className="learning-general-card">
                                  <div>
                                    <span className="learning-general-kind">
                                      DOCUMENT · {(book.extension || 'epub').toUpperCase()}
                                    </span>
                                    <h4>{book.title}</h4>
                                    <p>{book.author || 'Digital reference document'}</p>
                                  </div>
                                  <div className="learning-general-card-actions">
                                    <button
                                      type="button"
                                      className="learning-primary"
                                      onClick={() => setBookId(book.id)}
                                    >
                                      Read Document →
                                    </button>
                                    {(user?.is_admin || user?.can_create_quizzes) &&
                                      lessons.length > 0 && (
                                        <select
                                          className="learning-chapter-assign-select"
                                          value=""
                                          onChange={e => {
                                            if (e.target.value) {
                                              assignBookToChapter(book.id, e.target.value);
                                            }
                                          }}
                                        >
                                          <option value="">Assign to Chapter…</option>
                                          {lessons.map((l, idx) => (
                                            <option key={l.id} value={l.id}>
                                              Chapter {idx + 1}: {l.title}
                                            </option>
                                          ))}
                                        </select>
                                      )}
                                  </div>
                                </div>
                              ))}

                            {quizzes
                              .filter(q => !q.lesson_id && q.status !== 'closed')
                              .map(quiz => (
                                <div key={quiz.id} className="learning-general-card">
                                  <div>
                                    <span className="learning-general-kind">
                                      QUIZ · {quiz.status.toUpperCase()}
                                    </span>
                                    <h4>{quizTitle(quiz, language)}</h4>
                                    <p>
                                      {quiz.submitted
                                        ? 'Submitted'
                                        : quiz.status === 'published'
                                        ? 'Ready to complete'
                                        : 'Draft quiz'}
                                    </p>
                                  </div>
                                  <div className="learning-general-card-actions">
                                    {draftDeleteButton(quiz)}
                                    {(quiz.status === 'published' || quiz.submitted) && (
                                      <button
                                        type="button"
                                        className={quiz.submitted ? '' : 'learning-primary'}
                                        onClick={() => setQuizId(quiz.id)}
                                      >
                                        {quiz.submitted ? 'View My Results →' : 'Start Quiz →'}
                                      </button>
                                    )}
                                    {(user?.is_admin || quiz.can_view_results || (canManageClass && quiz.is_creator)) && (
                                      <button type="button" onClick={() => setResultsQuiz(quiz)}>
                                        Results
                                      </button>
                                    )}
                                    {(user?.is_admin || quiz.is_creator) && lessons.length > 0 && (
                                      <select
                                        className="learning-chapter-assign-select"
                                        value=""
                                        onChange={e => {
                                          if (e.target.value) {
                                            assignQuizToChapter(quiz.id, e.target.value);
                                          }
                                        }}
                                      >
                                        <option value="">Assign to Chapter…</option>
                                        {lessons.map((l, idx) => (
                                          <option key={l.id} value={l.id}>
                                            Chapter {idx + 1}: {l.title}
                                          </option>
                                        ))}
                                      </select>
                                    )}
                                  </div>
                                </div>
                              ))}
                          </div>
                        </section>
                      )}
                    </section>
                  ) : tab === 'notes' ? (
                    <section
                      role="tabpanel"
                      id="learning-notes"
                      aria-labelledby="learning-notes-tab"
                    >
                      <LearningStickyNotesBoard
                        classTitle={activeFolder.name}
                        notes={notes}
                        chapters={lessons.map((l, idx) => ({
                          id: l.id,
                          title: l.title,
                          ordinal: idx,
                        }))}
                        onCreateNote={defaultLid => {
                          setEditingNote(null);
                          setNoteDefaultLessonId(defaultLid || null);
                          setNoteEditorOpen(true);
                        }}
                        onEditNote={note => {
                          setEditingNote(note);
                          setNoteDefaultLessonId(note.lesson_id || null);
                          setNoteEditorOpen(true);
                        }}
                        onToggleFavorite={toggleNoteFavorite}
                        onDeleteNote={deleteClassNote}
                      />
                    </section>
                  ) : tab === 'completion' ? (
                    <section role="tabpanel" id="learning-completion" aria-labelledby="learning-completion-tab">
                      <LearningCourseCompletion key={folderId} classId={folderId} canManage={canManageClass} />
                    </section>
                  ) : tab === 'classes' ? (
                    <LearningClasses key={folderId} folderId={folderId} canCreate={!!(user?.is_admin || user?.can_create_quizzes)} canAssignTeacher={!!user?.is_admin} search={search}
                      onDeleted={folderDeleted => { if (folderDeleted) { setFolderId(''); setBookId(null); setQuizId(null); } void refreshFolders(); }}
                      onOpenResource={(kind, id) => {
                        if (kind === 'book') { setBookId(id); setQuizId(null); setTab('library'); }
                        else if (kind === 'quiz') { setQuizId(id); setBookId(null); setTab('quizzes'); }
                        else { setLessonToOpen(id); setBookId(null); setTab('lessons'); }
                      }} />
                  ) : tab === 'lessons' ? (
                    <LearningLessons
                      key={folderId}
                      folderId={folderId}
                      openLessonId={lessonToOpen}
                      openLessonEditor={lessonEditorMode}
                      createNewLesson={createNewLessonTrigger}
                      onLessonOpened={() => {
                        setLessonToOpen(null);
                        setLessonEditorMode(false);
                        setCreateNewLessonTrigger(false);
                      }}
                      onBackToChapters={
                        hasRichClasses
                          ? () => {
                              void reload();
                              void refreshFolders();
                              setTab('chapters');
                            }
                          : undefined
                      }
                      canCreate={!!(user?.is_admin || user?.can_create_quizzes)}
                      search={search}
                      onLessonsChange={(items) => {
                        setLessons(prev =>
                          items.map(i => {
                            const existing = prev.find(p => p.id === i.id);
                            return { ...existing, id: i.id, title: i.title, status: i.status, version: i.version, is_creator: i.is_creator, translations: (i as any).translations ?? existing?.translations };
                          })
                        );
                      }}
                      onProgressChange={(lessonId, prog) => {
                        setLessons(prev => prev.map(l => l.id === lessonId
                          ? { ...l, current_step: prog.step, completed: l.completed || prog.completed, started: true }
                          : l));
                        setFolders(prev => prev.map(f => f.id === folderId ? { ...f, started: true } : f));
                      }}
                      onDraftQuiz={async (item) => {
                        await action(async () => {
                          const draft = await api<QuizSummary & { source_truncated?: boolean; untranslated?: string[] }>(`/lessons/${item.id}/quiz-draft`, {
                            method: 'POST',
                            body: json({ title: `${item.title} · Knowledge quiz`, count: 10, language: getLearningLanguage() }),
                          });
                          const complete = await api<Quiz>(`/quizzes/${draft.id}`);
                          await reload();
                          setEditor({ ...complete, source_truncated: draft.source_truncated });
                          setNotice((draft.source_truncated ? 'A draft based on partial lesson excerpts is ready. Review its coverage before publishing.' : 'A lesson-based draft is ready for your review.') + untranslatedWarning(draft.untranslated));
                        });
                      }}
                    />
                  ) : tab === 'library' ? (
                    <section role="tabpanel" id="learning-library" aria-labelledby="learning-library-tab">
                      <div className="learning-book-grid">
                        {books
                          .filter(book => `${book.title} ${book.author || ''}`.toLowerCase().includes(search.toLowerCase()))
                          .map((book, index) => (
                            <article className="learning-book-card" key={book.id}>
                              <button
                                className={`learning-book-cover cover-${index % 4}`}
                                onClick={() => setBookId(book.id)}
                                aria-label={`Read ${book.title}`}
                              >
                                <span>{(book.extension || 'epub').toUpperCase()}</span>
                                <strong>{book.title}</strong>
                                <small>{book.author || 'Your digital library'}</small>
                                <i>Open document ↗</i>
                              </button>
                              <div className="learning-book-details">
                                <h2>{book.title}</h2>
                                <p>{book.author || 'Author not listed'}</p>
                                <div>
                                  <button className="learning-text-button" onClick={() => setBookId(book.id)}>
                                    {t('Read document →')}
                                  </button>
                                  {user?.can_create_quizzes && (
                                    <button
                                      className="learning-text-button"
                                      disabled={busy}
                                      onClick={() => void action(async () => {
                                        const draft = await api<QuizSummary & { source_truncated?: boolean; untranslated?: string[] }>(`/books/${book.id}/quiz-draft`, {
                                          method: 'POST',
                                          body: json({ title: `${book.title} · Knowledge quiz`, count: 10, language: getLearningLanguage() }),
                                        });
                                        const complete = await api<Quiz>(`/quizzes/${draft.id}`);
                                        await reload();
                                        setEditor({ ...complete, source_truncated: draft.source_truncated });
                                        setNotice((draft.source_truncated ? 'A draft based on partial book excerpts is ready. Review its coverage before publishing.' : 'A source-based draft is ready for your review.') + untranslatedWarning(draft.untranslated));
                                      })}
                                    >
                                      {t('Draft quiz with Buddy')}
                                    </button>
                                  )}
                                </div>
                                {user?.is_admin && (
                                  <button
                                    className="learning-text-button learning-danger"
                                    disabled={busy}
                                    onClick={() => setDeletingBook(book)}
                                  >
                                    {t('Delete document')}
                                  </button>
                                )}
                              </div>
                            </article>
                          ))}
                      </div>
                      {!books.length && (
                        <div className="learning-empty">
                          <span>▤</span>
                          <h2>Your library starts here</h2>
                          <p>
                            {user?.is_admin
                              ? 'Upload EPUB books or PDF, Word, PowerPoint, Excel, CSV, HTML, text, or Markdown documents for this folder’s members.'
                              : 'Your administrator will add documents to this folder.'}
                          </p>
                        </div>
                      )}
                    </section>
                  ) : (
                    <section role="tabpanel" id="learning-quizzes" aria-labelledby="learning-quizzes-tab">
                      <div>
                        <div>
                          <div className="learning-quiz-list">
                            {quizzes
                              .filter(quiz => quiz.title.toLowerCase().includes(search.toLowerCase()))
                              .map(quiz => (
                                <article className="learning-quiz-card" key={quiz.id}>
                                  <span className="learning-quiz-symbol">✓</span>
                                  <div>
                                    <div className="learning-quiz-title">
                                      <h2>{quizTitle(quiz, language)}</h2>
                                      <span className={`learning-status status-${quiz.status}`}>{quiz.status}</span>
                                    </div>
                                    <p>
                                      Version {quiz.version}
                                      {quiz.submitted
                                        ? ' · Answers submitted'
                                        : quiz.status === 'published'
                                        ? ' · Ready to complete'
                                        : quiz.status === 'draft'
                                        ? ' · Private draft · creator approval required'
                                        : ' · Submissions closed'}
                                    </p>
                                  </div>
                                  <div className="learning-card-actions">
                                    {draftDeleteButton(quiz)}
                                    {user?.is_admin || quiz.is_creator === true ? (
                                      <>
                                        {quiz.is_creator === true && quiz.status !== 'published' && (
                                          <>
                                            <button disabled={busy} onClick={() => void action(async () => setEditor(await api<Quiz>(`/quizzes/${quiz.id}`)))}>
                                              {t('Edit draft')}
                                            </button>
                                            <button
                                              className="learning-primary"
                                              disabled={busy}
                                              onClick={() => void action(async () => {
                                                await api(`/quizzes/${quiz.id}/publish`, { method: 'POST', body: '{}' });
                                                await reload();
                                                setNotice(quiz.status === 'closed' ? 'A new quiz version is published. Learners have a new attempt; earlier submissions are preserved.' : 'Quiz published. Assigned learners can now complete it.');
                                              })}
                                            >
                                              {quiz.status === 'closed' ? t('Approve new version') : t('Approve & publish')}
                                            </button>
                                          </>
                                        )}
                                        {quiz.status === 'published' && (
                                          <button disabled={busy} onClick={() => void action(async () => {
                                            await api(`/quizzes/${quiz.id}/close`, { method: 'POST', body: '{}' });
                                            await reload();
                                          })}>
                                            {t('Close quiz')}
                                          </button>
                                        )}
                                        {(quiz.status === 'published' || quiz.submitted) && (
                                          <button
                                            className={quiz.submitted ? '' : 'learning-primary'}
                                            disabled={quiz.status !== 'published' && !quiz.submitted}
                                            onClick={() => setQuizId(quiz.id)}
                                          >
                                            {quiz.submitted ? 'View my results →' : 'Start quiz →'}
                                          </button>
                                        )}
                                        {(user?.is_admin || quiz.can_view_results || (canManageClass && quiz.is_creator)) && (
                                          <button disabled={busy} onClick={() => setResultsQuiz(quiz)}>
                                            {t('Results')}
                                          </button>
                                        )}
                                      </>
                                    ) : (
                                      <button
                                        className={quiz.submitted ? '' : 'learning-primary'}
                                        disabled={quiz.status !== 'published' && !quiz.submitted}
                                        onClick={() => setQuizId(quiz.id)}
                                      >
                                        {quiz.submitted ? 'View my results →' : 'Start quiz →'}
                                      </button>
                                    )}
                                  </div>
                                </article>
                              ))}
                          </div>
                          {!quizzes.length && (
                            <div className="learning-empty">
                              <span>✓</span>
                              <h2>No quizzes yet</h2>
                              <p>
                                {user?.can_create_quizzes
                                  ? brandText('Create a quiz, or ask Buddy to draft one from a document in the Library.')
                                  : 'Published quizzes will appear here when your administrator makes them available.'}
                              </p>
                            </div>
                          )}
                        </div>


                      </div>
                    </section>
                  )}
                </>
              )}
            </main>
          </>
        )}
      </div>

      {user && folderId && <FloatingLearningAssistant
        key={folderId}
        open={assistantOpen}
        onOpenChange={setAssistantOpen}
        folderId={folderId}
        bookId={bookId || undefined}
        sources={[
          ...books.map(b => ({ id: b.id, title: b.title, kind: 'document' as const })),
          ...lessons.map(l => ({ id: l.id, title: l.title, kind: 'lesson' as const }))
        ]}
        canCreate={!!(user.is_admin || user.can_create_quizzes)}
        onQuizCreated={() => { void reload(); }}
        onReviewDraft={reviewDraft}
      />}

      {/* Dialogs */}
      {newFolder !== null && (
        <Dialog title={t('Create learning folder')} onClose={() => { if (!busy) setNewFolder(null); }}>
          <form
            className="learning-editor"
            onSubmit={event => {
              event.preventDefault();
              void action(async () => {
                const folder = await api<Folder>('/folders', {
                  method: 'POST',
                  body: json({
                    name: newFolder.trim(),
                    parent_id: parentFolder || null,
                    ...(newFolderDesc.trim() ? { description: newFolderDesc.trim() } : {}),
                    ...(await buildClassTranslations(newFolder.trim(), newFolderDesc.trim())),
                  }),
                });
                setFolders(items => [...items, folder]);
                const drafted = newFolderDocument ? await draftLessonFromDocument(folder.id, newFolderDocument, newFolderBrief) : null;
                selectClass(folder.id);
                setNewFolder(null);
                setNewFolderDesc('');
                setNewFolderDocument(null);
                setNewFolderBrief('');
                if (drafted) setNotice(drafted.message);
              });
            }}
          >
            <label>
              {t('Folder name')}
              <input required maxLength={190} value={newFolder} onChange={event => setNewFolder(event.target.value)} />
            </label>
            <label>
              Class description (optional)
              <textarea
                maxLength={2000}
                rows={3}
                placeholder="What will learners master in this class?"
                value={newFolderDesc}
                onChange={event => setNewFolderDesc(event.target.value)}
              />
            </label>
            <label>
              {t('Parent folder')}
              <select value={parentFolder} onChange={event => setParentFolder(event.target.value)}>
                <option value="">{t('Top-level folder')}</option>
                {folders.map(folder => (
                  <option key={folder.id} value={folder.id}>{folder.name}</option>
                ))}
              </select>
            </label>
            <p className="learning-muted">{t('New subfolders inherit access granted on their parent folders.')}</p>
            <ClassDocumentField file={newFolderDocument} brief={newFolderBrief} busy={busy} onFile={setNewFolderDocument} onBrief={setNewFolderBrief} />
            {error && <p role="alert" className="learning-alert">{error}</p>}
            <footer className="learning-dialog-actions">
              <button type="button" disabled={busy} onClick={() => setNewFolder(null)}>{t('Cancel')}</button>
              <button type="submit" className="learning-primary" disabled={busy || !newFolder.trim()}>{t('Create folder')}</button>
            </footer>
          </form>
        </Dialog>
      )}

      {renamingFolder && (
        <Dialog title={t('Rename folder')} onClose={() => { if (!busy) setRenamingFolder(null); }}>
          <form
            className="learning-editor"
            onSubmit={event => {
              event.preventDefault();
              void action(async () => {
                const updated = await api<Folder>(`/folders/${renamingFolder.id}`, {
                  method: 'PATCH',
                  body: json({
                    name: renamingFolder.name.trim(),
                    ...(renamingFolder.description !== undefined ? { description: renamingFolder.description } : {}),
                    ...(await buildClassTranslations(renamingFolder.name.trim(), renamingFolder.description || '')),
                  }),
                });
                setFolders(items => items.map(f => f.id === updated.id ? { ...f, ...updated, name: updated.name } : f));
                setRenamingFolder(null);
                setNotice(t('Folder renamed successfully.'));
              });
            }}
          >
            <label>
              {t('Folder name')}
              <input
                required
                maxLength={190}
                value={renamingFolder.name}
                onChange={event => setRenamingFolder(current => current ? { ...current, name: event.target.value } : null)}
              />
            </label>
            <label>
              Class description
              <textarea
                maxLength={2000}
                rows={3}
                placeholder="What will learners master in this class?"
                value={renamingFolder.description || ''}
                onChange={event => setRenamingFolder(current => current ? { ...current, description: event.target.value } : null)}
              />
            </label>
            {error && <p role="alert" className="learning-alert">{error}</p>}
            <footer className="learning-dialog-actions">
              <button type="button" disabled={busy} onClick={() => setRenamingFolder(null)}>{t('Cancel')}</button>
              <button type="submit" className="learning-primary" disabled={busy || !renamingFolder.name.trim()}>{t('Save')}</button>
            </footer>
          </form>
        </Dialog>
      )}

      {deletingQuiz && <LearningConfirmDialog title={t('Delete draft quiz')} message={`Delete “${quizTitle(deletingQuiz, language)}”? Only an unused, unpublished draft can be deleted.`}
        confirmLabel={t('Delete')} cancelLabel={t('Cancel')} danger onCancel={() => setDeletingQuiz(null)} onConfirm={() => {
          const target = deletingQuiz; setDeletingQuiz(null);
          void action(async () => {
            await api(`/quizzes/${target.id}`, { method: 'DELETE' });
            if (quizId === target.id) setQuizId(null);
            if (editor !== 'new' && editor?.id === target.id) setEditor(null);
            await reload(); await refreshFolders(); setNotice(t('Draft quiz deleted.'));
          });
        }} />}
      {deletingClass && <LearningConfirmDialog title={t('Delete class')} message={`Delete “${folderName(deletingClass, language)}”? Deletion is blocked once learners have started. Class materials will be removed from view.`}
        confirmLabel={t('Delete')} cancelLabel={t('Cancel')} danger onCancel={() => setDeletingClass(null)} onConfirm={() => {
          const target = deletingClass; setDeletingClass(null);
          void action(async () => {
            await api(`/classes/${target.id}`, { method: 'DELETE' });
            if (folderId === target.id) { setFolderId(''); setBookId(null); setQuizId(null); setEditor(null); }
            await refreshFolders(); setNotice(t('Class deleted.'));
          });
        }} />}
      {deletingBook && (
        <LearningConfirmDialog
          title={t('Delete document')}
          message={`Are you sure you want to delete “${deletingBook.title}” from this folder?`}
          confirmLabel={t('Delete')}
          cancelLabel={t('Cancel')}
          danger
          onCancel={() => setDeletingBook(null)}
          onConfirm={() => {
            const toDelete = deletingBook;
            setDeletingBook(null);
            void action(async () => {
              await api(`/books/${toDelete.id}`, { method: 'DELETE' });
              if (bookId === toDelete.id) setBookId(null);
              await reload();
              void refreshFolders();
              setNotice(t('Document deleted.'));
            });
          }}
        />
      )}

      {membersOpen && (
        <Dialog title={`Folder access · ${activeFolder?.name || ''}`} onClose={() => { if (!busy) setMembersOpen(false); }}>
          <div className="learning-access">
            <p className="learning-muted">{t('Enroll learners and grant permissions on this class (and its nested classes). Selected users and groups can access interactive lectures, documents, quizzes, and earn certificates.')}</p>
            {inheritedAccess.length > 0 && (
              <p className="learning-inherited-access">
                {t('Inherited access from:')} {inheritedAccess.map(folder => folder.name).join(', ')}. {t('Removing a direct grant here does not remove access inherited from a parent folder.')}
              </p>
            )}
            {teacherDirectory.length > 0 && (
              <div style={{ marginBottom: 12 }}>
                <label style={{ display: 'grid', gap: 4 }}>
                  <strong>{t('Lead teacher')}</strong>
                  <select value={classTeacher} onChange={event => setClassTeacher(event.target.value)}>
                    <option value="">{t('Keep current lead teacher')}</option>
                    {teacherDirectory.map(teacher => (
                      <option key={teacher.username} value={teacher.username}>{learningUserName(teacher)} (@{teacher.username})</option>
                    ))}
                  </select>
                </label>
              </div>
            )}
            <h3 className="learning-access-section">{t('Enrolled users')}</h3>
            {directory.map(person => (
              <label key={person.username}>
                <input
                  type="checkbox"
                  checked={members.includes(person.username)}
                  onChange={event => setMembers(items => event.target.checked ? [...items, person.username] : items.filter(username => username !== person.username))}
                />
                <span>{learningUserName(person)}</span>
              </label>
            ))}
            {!directory.length && <p>No users available.</p>}
            <p className="learning-muted">{directoryNote}</p>
            {appGroupDirectory.length > 0 && (
              <>
                <h3 className="learning-access-section">{t('Application groups')}</h3>
                <p className="learning-muted">{t('Grant class access and enroll all members of an application-managed group.')}</p>
                {appGroupDirectory.map(group => (
                  <label key={group.id}>
                    <input
                      type="checkbox"
                      checked={selectedAppGroups.includes(group.id)}
                      onChange={event => setSelectedAppGroups(items => event.target.checked ? [...items, group.id] : items.filter(id => id !== group.id))}
                    />
                    <span>{group.name}{group.member_count != null ? ` (${group.member_count})` : ''}</span>
                  </label>
                ))}
              </>
            )}
            <h3 className="learning-access-section">{t('Keycloak groups')}</h3>
            <p className="learning-muted">Grant access to an exact Keycloak group path. Group membership refreshes when a user signs in and requires the configured groups claim mapper.</p>
            {groupDirectory.map(path => (
              <label key={path}>
                <input
                  type="checkbox"
                  checked={groups.includes(path)}
                  onChange={event => setGroups(items => event.target.checked ? [...items, path] : items.filter(group => group !== path))}
                />
                <span>{path}</span>
              </label>
            ))}
            <div className="learning-group-add">
              <label>
                {t('Full group path')}
                <input placeholder="/Department/Team" value={groupPath} onChange={event => setGroupPath(event.target.value)} />
              </label>
              <button
                disabled={busy || !groupPath.trim().startsWith('/')}
                onClick={() => {
                  const path = groupPath.trim();
                  setGroupDirectory(items => [...new Set([...items, path])]);
                  setGroups(items => [...new Set([...items, path])]);
                  setGroupPath('');
                }}
              >
                {t('Add group')}
              </button>
            </div>
            {error && <p role="alert" className="learning-alert">{error}</p>}
            <footer className="learning-dialog-actions">
              <button disabled={busy} onClick={() => setMembersOpen(false)}>{t('Cancel')}</button>
              <button className="learning-primary" disabled={busy} onClick={() => void action(async () => {
                await api(`/folders/${folderId}/members`, {
                  method: 'PUT',
                  body: json({
                    usernames: members,
                    groups,
                    app_groups: selectedAppGroups,
                    ...(classTeacher ? { teacher_username: classTeacher } : {}),
                  }),
                });
                setMembersOpen(false);
                void refreshFolders();
                setNotice('Folder access updated.');
              })}>
                {busy ? 'Saving…' : t('Save access')}
              </button>
            </footer>
          </div>
        </Dialog>
      )}

      {peopleAdminOpen && (
        <Dialog title={t('Application groups & Learning teachers')} wide onClose={() => { if (!busy) setPeopleAdminOpen(false); }}>
          <div style={{ padding: '4px 0' }}>
            <LearningPeopleAdmin />
          </div>
        </Dialog>
      )}

      {certificatesOpen && (
        <Dialog title={t('My {{ORGANIZATION}} course certificates')} wide onClose={() => { if (!busy) setCertificatesOpen(false); }}>
          <div className="learning-access" style={{ display: 'grid', gap: 14 }}>
            <p className="learning-muted">
              {t('Certificates earned upon completing all requirements in a class are immediately available here on the platform, and are sent by email when SMTP is enabled.')}
            </p>
            {!myCertificates.length && (
              <p className="learning-empty">{t('You have not earned any course completion certificates yet. Complete the interactive lectures, quizzes, and required assignments in your classes to earn your certificate.')}</p>
            )}
            {myCertificates.map(cert => (
              <article key={cert.id} className="learning-card" style={{ padding: 14, borderRadius: 12, border: '1px solid rgba(148,163,184,0.28)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
                  <div>
                    <h3 style={{ margin: '0 0 4px' }}>{cert.course_title}</h3>
                    <p style={{ margin: 0 }}>
                      <strong>{cert.revoked_at ? 'Revoked' : 'Issued'}</strong> · {cert.recipient_name} · {new Date(cert.issued_at).toLocaleDateString()} · Instructor: {cert.instructor_name}
                    </p>
                    {!cert.revoked_at && (
                      <p className="learning-muted" style={{ margin: '4px 0 0' }}>
                        {cert.email_status === 'sent'
                          ? `Sent by email to ${cert.email_recipient || 'recipient'}`
                          : 'Available on platform · Email delivery queued until SMTP is enabled'}
                      </p>
                    )}
                  </div>
                  <div className="learning-actions" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <a className="learning-button" href={`/api/learning/certificates/${encodeURIComponent(cert.id)}/download?format=pdf`}>Download certificate PDF</a>
                    <a className="learning-button" href={`/api/learning/certificates/${encodeURIComponent(cert.id)}/download?format=html`}>Download printable certificate</a>
                    <button type="button" onClick={() => setPreviewCertId(previewCertId === cert.id ? null : cert.id)}>
                      {previewCertId === cert.id ? 'Hide preview' : 'Preview'}
                    </button>
                    {!cert.revoked_at && (
                      <button type="button" disabled={busy} onClick={() => void action(async () => {
                        const res = await api<{ delivery?: { status?: string; recipient?: string; error?: string } }>(`/certificates/${encodeURIComponent(cert.id)}/send-email`, { method: 'POST', body: '{}' });
                        await openCertificates();
                        if (res.delivery?.status === 'sent') setNotice(`Certificate emailed to ${res.delivery.recipient || 'recipient'}.`);
                        else setNotice('Certificate is available on the platform. Email delivery will be sent when SMTP is enabled.');
                      })}>
                        Send by email
                      </button>
                    )}
                  </div>
                </div>
                {previewCertId === cert.id && (
                  <div style={{ marginTop: 12, border: '1px solid rgba(148,163,184,0.35)', borderRadius: 12, overflow: 'hidden', background: '#fff' }}>
                    <iframe
                      title={`Certificate preview for ${cert.course_title}`}
                      src={`/api/learning/certificates/${encodeURIComponent(cert.id)}/download?format=html&inline=1`}
                      style={{ width: '100%', height: 500, border: 0, display: 'block' }}
                    />
                  </div>
                )}
              </article>
            ))}
          </div>
        </Dialog>
      )}

      {editor && (
        <QuizEditor
          key={editor === 'new' ? 'new' : editor.id}
          folderId={folderId}
          defaultLessonId={quizDefaultLessonId}
          sources={[
            ...books.map(b => ({ id: b.id, title: b.title, kind: 'document' as const })),
            ...lessons.map(l => ({ id: l.id, title: l.title, kind: 'lesson' as const }))
          ]}
          onReviewDraft={reviewDraft}
          onQuizCreated={() => { void reload(); }}
          initial={editor === 'new' ? undefined : editor}
          onClose={() => {
            setEditor(null);
            setQuizDefaultLessonId(null);
          }}
          onSaved={() => {
            setEditor(null);
            setQuizDefaultLessonId(null);
            if (!hasRichClasses) setTab('quizzes');
            void reload();
            void refreshFolders();
            setNotice('Private quiz draft saved. Only its creator can review, approve, and publish it.');
          }}
        />
      )}

      {noteEditorOpen && activeFolder && (
        <LearningNoteEditorModal
          open={noteEditorOpen}
          classTitle={activeFolder.name}
          chapters={lessons.map((l, idx) => ({ id: l.id, title: l.title, ordinal: idx }))}
          initialNote={editingNote}
          defaultLessonId={noteDefaultLessonId}
          busy={busy}
          onClose={() => {
            if (!busy) {
              setNoteEditorOpen(false);
              setEditingNote(null);
              setNoteDefaultLessonId(null);
            }
          }}
          onSave={saveClassNote}
        />
      )}

      {officeImport && (
        <OfficeImportDialog
          folderId={folderId}
          onClose={() => setOfficeImport(false)}
          onImported={() => {
            setOfficeImport(false);
            void reload();
            void refreshFolders();
            setNotice(t('Document imported from Office Suite.'));
          }}
        />
      )}

      {quizId && <TakeQuiz key={quizId} quizId={quizId} onClose={() => setQuizId(null)} onSubmitted={() => { void reload(); void refreshFolders(); }} />}
      {resultsQuiz && <ResultsPanel quizId={resultsQuiz.id} title={resultsQuiz.title} onClose={() => setResultsQuiz(null)} />}
      {busy && <div className="learning-working" role="status">{brandText("Buddy")} is working…</div>}
    </div>
  );
}
