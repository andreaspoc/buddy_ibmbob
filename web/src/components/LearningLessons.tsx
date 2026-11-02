import { brandText } from '../lib/brand';
import { assistantNamePayload } from '../lib/appearance';
import { useEffect, useRef, useState } from 'react';
import './LearningLessons.css';
import { LessonContent } from './LessonContent';
import { LessonBoard, newBoardCard } from './LessonBoard';
import type { Board, BoardCard } from './LessonBoard';
import { animateInterface, uiMotion } from '../lib/motion';
import {
  getLearningLanguage,
  languageLabel,
  orderedLearningLanguages,
  useLearningLanguage,
  type LearningLangCode,
} from '../learningLanguage';
import { LearningConfirmDialog } from './LearningConfirmDialog';
import { untranslatedWarning } from '../lib/untranslatedNotice';

type Step = {
  id: string;
  kind: 'text' | 'reveal' | 'question' | 'video' | 'image' | 'board';
  title: string;
  text: string;
  url: string;
  asset_id: string | null;
  options: string[];
  answer?: number | null;
  feedback?: string;
  teacher_notes?: string;
  board?: Board | null;
};
type LessonTranslation = {
  title: string;
  description: string;
  steps: Step[];
  approved?: boolean;
};
type Spec = {
  title: string;
  description: string;
  steps: Step[];
  language?: string;
  translations?: Record<string, LessonTranslation>;
  approved_languages?: string[];
};
type Summary = {
  id: string;
  title: string;
  status: string;
  version: number;
  is_creator: boolean;
  draft_digest?: string;
  translations?: Record<string, { title?: string; description?: string; approved?: boolean }>;
  approved_languages?: string[];
};
type Lesson = Spec & Summary & { progress?: { step: number; completed: boolean } };

const blankStep = (): Step => ({
  id: crypto.randomUUID(),
  kind: 'text',
  title: 'New section',
  text: '',
  url: '',
  asset_id: null,
  options: [],
  answer: null,
  feedback: '',
  board: null,
});
const activityLabels: Record<Step['kind'], string> = {
  text: 'Learn',
  reveal: 'Discover',
  question: 'Practice',
  video: 'Watch',
  image: 'Visual',
  board: 'Explore',
};
const activityIcons: Record<Step['kind'], string> = {
  text: 'Aa',
  reveal: '✦',
  question: '?',
  video: '▶',
  image: '▧',
  board: '◇',
};
const blank = (): Spec => ({ title: '', description: '', steps: [blankStep()] });

async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const headers: Record<string, string> = { 'X-Learning-Language': getLearningLanguage() };
  if (!(body instanceof FormData)) headers['Content-Type'] = 'application/json';
  const response = await fetch('/api/learning' + path, {
    method,
    headers,
    body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(
      typeof data.detail === 'string'
        ? data.detail
        : `Unable to complete this request (${response.status}). Check the lesson fields.`
    );
  return data;
}
const message = (e: unknown) => (e instanceof Error ? e.message : 'Unable to complete this request.');


export function LearningLessons({
  folderId,
  canCreate,
  search,
  onDraftQuiz,
  onLessonsChange,
  onProgressChange,
  openLessonId,
  openLessonEditor,
  createNewLesson,
  onLessonOpened,
  onBackToChapters,
}: {
  folderId: string;
  canCreate: boolean;
  search: string;
  onDraftQuiz?: (lesson: Summary) => Promise<void>;
  onLessonsChange?: (items: Summary[]) => void;
  onProgressChange?: (lessonId: string, progress: { step: number; completed: boolean; started: boolean }) => void;
  openLessonId?: string | null;
  openLessonEditor?: boolean;
  createNewLesson?: boolean;
  onLessonOpened?: () => void;
  onBackToChapters?: () => void;
}) {
  const { language, t } = useLearningLanguage();
  const [items, setItems] = useState<Summary[]>([]);
  const [lesson, setLesson] = useState<Lesson | null>(null);
  const [draft, setDraft] = useState<Spec | null>(null);
  const [authorLang, setAuthorLang] = useState<LearningLangCode>(() => getLearningLanguage());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingDigest, setEditingDigest] = useState<string | null>(null);
  const [position, setPosition] = useState(0);
  const [completed, setCompleted] = useState(false);
  const [completionOpen, setCompletionOpen] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [furthest, setFurthest] = useState(0);
  const activityPanel = useRef<HTMLDivElement>(null);
  const [selection, setSelection] = useState<number | null>(null);
  const [feedback, setFeedback] = useState<{ correct: boolean; feedback: string } | null>(null);
  const [answeredSteps, setAnsweredSteps] = useState<
    Record<string, { choice: number; correct: boolean; feedback: string }>
  >({});
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [buddyBrief, setBuddyBrief] = useState('');
  const [proposal, setProposal] = useState<Spec | null>(null);
  const [confirmModal, setConfirmModal] = useState<{
    title: string;
    message: string;
    confirmLabel?: string;
    cancelLabel?: string;
    danger?: boolean;
    onConfirm: () => void | Promise<void>;
  } | null>(null);
  const dirty = useRef(false);

  const orderedLangs = orderedLearningLanguages(language);

  const reload = async () => {
    const data = await api<{ items: Summary[] }>(`/folders/${folderId}/lessons`);
    setItems(data.items);
    onLessonsChange?.(data.items);
  };

  const reorder = async (fromIndex: number, toIndex: number) => {
    if (toIndex < 0 || toIndex >= items.length || busy) return;
    const next = [...items];
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved);
    setItems(next);
    onLessonsChange?.(next);
    try {
      await api(`/folders/${folderId}/lessons/order`, 'PUT', { lesson_ids: next.map(l => l.id) });
      setNotice('Lesson order updated.');
    } catch (e) {
      setError(message(e));
      await reload();
    }
  };

  useEffect(() => {
    let active = true;
    api<{ items: Summary[] }>(`/folders/${folderId}/lessons`)
      .then(data => {
        if (active) {
          setItems(data.items);
          onLessonsChange?.(data.items);
        }
      })
      .catch(e => {
        if (active) setError(message(e));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [folderId]);

  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => {
      if (dirty.current) {
        event.preventDefault();
      }
    };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, []);

  const latestSessionRef = useRef<{
    id: string;
    version: number;
    status: string;
    step: number;
    completed: boolean;
    previewing: boolean;
  } | null>(null);

  useEffect(() => {
    if (lesson && !previewing && lesson.status === 'published') {
      latestSessionRef.current = {
        id: lesson.id,
        version: lesson.version,
        status: lesson.status,
        step: position,
        completed,
        previewing,
      };
    } else {
      latestSessionRef.current = null;
    }
  }, [lesson, position, completed, previewing]);

  useEffect(() => {
    return () => {
      const s = latestSessionRef.current;
      if (s && !s.previewing && s.status === 'published') {
        onProgressChange?.(s.id, { step: s.step, completed: s.completed, started: true });
        void api(`/lessons/${s.id}/progress`, 'PUT', {
          version: s.version,
          step: s.step,
          completed: s.completed,
        }).catch(() => {});
      }
    };
  }, []);

  const action = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await work();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  const edit = (change: Partial<Spec>) => {
    dirty.current = true;
    setDraft(value => {
      if (!value) return value;
      const updated: Spec = { ...value, ...change };
      if (value.translations && value.translations[authorLang]) {
        updated.translations = {
          ...value.translations,
          [authorLang]: {
            ...value.translations[authorLang],
            title: updated.title,
            description: updated.description,
            steps: updated.steps,
          },
        };
      }
      return updated;
    });
  };

  const editStep = (index: number, change: Partial<Step>) => {
    if (draft) edit({ steps: draft.steps.map((s, i) => (i === index ? { ...s, ...change } : s)) });
  };

  const switchAuthorLang = (nextLang: LearningLangCode) => {
    if (!draft) {
      setAuthorLang(nextLang);
      return;
    }
    const existingTranslations = draft.translations ? { ...draft.translations } : {};
    existingTranslations[authorLang] = {
      title: draft.title,
      description: draft.description,
      steps: draft.steps,
      approved: Boolean(existingTranslations[authorLang]?.approved || draft.approved_languages?.includes(authorLang)),
    };
    const target = existingTranslations[nextLang];
    if (target && Array.isArray(target.steps) && target.steps.length) {
      setDraft({
        ...draft,
        title: target.title || draft.title,
        description: target.description ?? draft.description,
        steps: target.steps,
        translations: existingTranslations,
      });
    } else {
      existingTranslations[nextLang] = {
        title: draft.title,
        description: draft.description,
        steps: structuredClone(draft.steps),
        approved: false,
      };
      setDraft({
        ...draft,
        translations: existingTranslations,
      });
    }
    setAuthorLang(nextLang);
  };

  const toggleLanguageApproval = (langCode: LearningLangCode) => {
    if (!draft) return;
    dirty.current = true;
    const currentApproved = new Set(draft.approved_languages || []);
    const willApprove = !currentApproved.has(langCode);
    if (willApprove) currentApproved.add(langCode);
    else currentApproved.delete(langCode);
    const nextTranslations = { ...(draft.translations || {}) };
    nextTranslations[langCode] = {
      title: langCode === authorLang ? draft.title : nextTranslations[langCode]?.title || draft.title,
      description:
        langCode === authorLang ? draft.description : nextTranslations[langCode]?.description ?? draft.description,
      steps: langCode === authorLang ? draft.steps : nextTranslations[langCode]?.steps || draft.steps,
      approved: willApprove,
    };
    setDraft({
      ...draft,
      translations: nextTranslations,
      approved_languages: Array.from(currentApproved),
    });
  };

  const generateAllThreeLanguages = async () => {
    if (!draft) return;
    const order = orderedLearningLanguages(language);
    const primary = order[0];
    let baseSpec: LessonTranslation = {
      title: draft.title,
      description: draft.description,
      steps: draft.steps,
      approved: true,
    };
    if (buddyBrief.trim() && !draft.title.trim()) {
      const current = draft.title.trim() ? draft : null;
      const result = await api<{ draft: Spec; source_truncated: boolean; untranslated?: string[] }>(`/folders/${folderId}/lesson-draft`, 'POST', {
        message: buddyBrief,
        language: primary,
        current,
        ...assistantNamePayload(),
      });
      baseSpec = {
        title: result.draft.title,
        description: result.draft.description,
        steps: result.draft.steps,
        approved: false,
      };
      if (result.draft.translations && Object.keys(result.draft.translations).length === 3) {
        dirty.current = true;
        setAuthorLang(primary);
        setDraft({
          ...draft,
          title: result.draft.translations[primary]?.title || result.draft.title,
          description: result.draft.translations[primary]?.description ?? result.draft.description,
          steps: result.draft.translations[primary]?.steps || result.draft.steps,
          language: primary,
          translations: result.draft.translations,
          approved_languages: result.draft.approved_languages || [],
        });
        setNotice(
          `Generated ${languageLabel(order[0])} first, followed by ${languageLabel(order[1])} and ${languageLabel(order[2])}. Review and approve all 3 languages.` + untranslatedWarning(result.untranslated)
        );
        return;
      }
    }
    if (!baseSpec.title.trim()) {
      throw new Error(brandText('Add a lesson title or generate a Buddy draft first before translating into all 3 languages.'));
    }
    const nextTranslations: Record<string, LessonTranslation> = {
      ...(draft.translations || {}),
      [primary]: baseSpec,
    };
    for (const targetLang of order.slice(1)) {
      const res = await api<{
        language: string;
        translated: { title?: string; description?: string; steps?: Step[] };
      }>('/translate-content', 'POST', {
        kind: 'lesson',
        source_language: primary,
        target_language: targetLang,
        payload: {
          title: baseSpec.title,
          description: baseSpec.description,
          steps: baseSpec.steps,
        },
      });
      if (!res?.translated) throw new Error('The translation service did not return a translation. Try again.');
      nextTranslations[targetLang] = {
        title: res.translated.title || baseSpec.title,
        description: res.translated.description ?? baseSpec.description,
        steps:
          Array.isArray(res.translated.steps) && res.translated.steps.length === baseSpec.steps.length
            ? res.translated.steps
            : structuredClone(baseSpec.steps),
        approved: false,
      };
    }
    dirty.current = true;
    const activeView = nextTranslations[authorLang] || baseSpec;
    setDraft({
      ...draft,
      title: activeView.title,
      description: activeView.description,
      steps: activeView.steps,
      language: primary,
      translations: nextTranslations,
      approved_languages: draft.approved_languages || [],
    });
    setNotice(
      `Generated in ${languageLabel(order[0])} first, then ${languageLabel(order[1])} and ${languageLabel(order[2])}. Approve all 3 languages to finish draft.`
    );
  };

  const open = async (item: Pick<Summary, 'id'>, editor = false) => {
    const data = await api<Lesson>(`/lessons/${item.id}`);
    if (editor) {
      const currentLang = getLearningLanguage();
      setAuthorLang(currentLang);
      const langData = data.translations?.[currentLang];
      setDraft({
        title: langData?.title || data.title,
        description: langData?.description ?? data.description,
        steps: langData?.steps?.length === data.steps.length ? langData.steps : data.steps,
        ...(data.language ? { language: data.language } : {}),
        ...(data.translations ? { translations: data.translations } : {}),
        ...(data.approved_languages ? { approved_languages: data.approved_languages } : {}),
      });
      setEditingId(data.id);
      setEditingDigest(data.draft_digest || null);
      dirty.current = false;
      setLesson(null);
      setPreviewing(false);
    } else {
      setPreviewing(false);
      setCompletionOpen(false);
      setFurthest(data.progress?.step || 0);
      setLesson(data);
      setPosition(Math.min(data.progress?.step || 0, data.steps.length - 1));
      setCompleted(!!data.progress?.completed);
      setFeedback(null);
      setSelection(null);
      setAnsweredSteps({});
    }
  };

  useEffect(() => {
    if (createNewLesson) {
      setAuthorLang(getLearningLanguage());
      setDraft(blank());
      setEditingId(null);
      setEditingDigest(null);
      setLesson(null);
      setPreviewing(false);
      dirty.current = false;
      onLessonOpened?.();
      return;
    }
    if (!openLessonId) return;
    void action(async () => {
      await open({ id: openLessonId }, Boolean(openLessonEditor));
      onLessonOpened?.();
    });
  }, [openLessonId, openLessonEditor, createNewLesson]);

  const copyLesson = async (item: Summary) => {
    const data = await api<Lesson>(`/lessons/${item.id}`);
    setDraft({
      title: `${data.title.slice(0, 193)} (copy)`,
      description: data.description,
      steps: data.steps.map(step => ({ ...structuredClone(step), id: crypto.randomUUID() })),
    });
    setEditingId(null);
    setEditingDigest(null);
    setLesson(null);
    setPreviewing(false);
    dirty.current = true;
    setNotice('Independent lesson copy created. Edit and save it as a new draft; the original stays available.');
  };

  const exportDraft = () => {
    if (!draft) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(draft, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'lesson-draft.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  const doLeave = () => {
    if (lesson && !previewing && lesson.status === 'published') {
      const savedStep = position;
      const savedDone = completed;
      onProgressChange?.(lesson.id, { step: savedStep, completed: savedDone, started: true });
      void api(`/lessons/${lesson.id}/progress`, 'PUT', {
        version: lesson.version,
        step: savedStep,
        completed: savedDone,
      }).catch(() => {});
    }
    setPreviewing(false);
    setCompletionOpen(false);
    setProposal(null);
    setDraft(null);
    setLesson(null);
    setEditingId(null);
    setEditingDigest(null);
    dirty.current = false;
    setError('');
    setNotice('');
    onBackToChapters?.();
  };

  const leave = () => {
    if (draft && dirty.current) {
      setConfirmModal({
        title: 'Discard unsaved changes?',
        message: 'You have unsaved changes in this lesson. Are you sure you want to discard them?',
        confirmLabel: 'Discard',
        danger: true,
        onConfirm: () => {
          setConfirmModal(null);
          doLeave();
        },
      });
      return;
    }
    doLeave();
  };

  const save = async (andPublish = false, approveAllLanguages = false) => {
    if (!draft) return;
    let payloadToSave: Spec = { ...draft };
    if (payloadToSave.translations || approveAllLanguages) {
      const nextTranslations = { ...(payloadToSave.translations || {}) };
      nextTranslations[authorLang] = {
        title: payloadToSave.title,
        description: payloadToSave.description,
        steps: payloadToSave.steps,
        approved: approveAllLanguages ? true : Boolean(nextTranslations[authorLang]?.approved),
      };
      if (approveAllLanguages) {
        for (const code of ['en', 'el', 'hi'] as const) {
          const existing = nextTranslations[code];
          nextTranslations[code] = {
            title: existing?.title || payloadToSave.title,
            description: existing?.description ?? payloadToSave.description,
            steps: existing?.steps?.length ? existing.steps : payloadToSave.steps,
            approved: true,
          };
        }
      }
      const enEntry = nextTranslations.en;
      payloadToSave = {
        ...payloadToSave,
        title: enEntry?.title || payloadToSave.title,
        description: enEntry?.description ?? payloadToSave.description,
        steps: enEntry?.steps?.length === payloadToSave.steps.length ? enEntry.steps : payloadToSave.steps,
        translations: nextTranslations,
        approved_languages: approveAllLanguages
          ? ['en', 'el', 'hi']
          : Array.from(new Set(payloadToSave.approved_languages || [])),
      };
    }

    let targetId = editingId;
    let latestDigest = editingDigest;
    if (editingId) {
      const saved = await api<{ draft_digest: string }>(`/lessons/${editingId}`, 'PUT', {
        ...payloadToSave,
        expected_digest: editingDigest,
      });
      setEditingDigest(saved.draft_digest);
      latestDigest = saved.draft_digest;
    } else {
      const row = await api<{ id: string; draft_digest?: string }>(`/folders/${folderId}/lessons`, 'POST', payloadToSave);
      targetId = row.id;
      setEditingId(row.id);
      latestDigest = row.draft_digest || null;
      setEditingDigest(latestDigest);
    }
    if (andPublish && targetId) {
      await api(`/lessons/${targetId}/publish`, 'POST', { expected_digest: latestDigest });
      dirty.current = false;
      setNotice(
        approveAllLanguages
          ? 'All 3 languages (English, Ελληνικά, हिन्दी) approved and lesson published.'
          : 'Lesson saved and published.'
      );
    } else {
      dirty.current = false;
      setNotice('Draft saved.');
    }
    await reload();
  };

  const promptPublish = (item: Summary) => {
    const localTitle = item.translations?.[language]?.title || item.title;
    setConfirmModal({
      title: 'Publish lesson',
      message: `Publish “${localTitle}” to everyone with access to this folder?`,
      confirmLabel: 'Approve & publish',
      onConfirm: async () => {
        setConfirmModal(null);
        await action(async () => {
          await api(`/lessons/${item.id}/publish`, 'POST');
          await reload();
          setNotice('Lesson published successfully.');
        });
      },
    });
  };

  const promptDelete = (item: Summary) => {
    const localTitle = item.translations?.[language]?.title || item.title;
    setConfirmModal({
      title: 'Delete lesson',
      message: `Are you sure you want to delete “${localTitle}”? This action cannot be undone.`,
      confirmLabel: 'Delete lesson',
      danger: true,
      onConfirm: async () => {
        setConfirmModal(null);
        await action(async () => {
          await api(`/lessons/${item.id}`, 'DELETE');
          await reload();
          setNotice('Lesson deleted.');
        });
      },
    });
  };

  const importFile = async (file: File) => {
    if (file.size > 50 * 1024 * 1024) throw new Error('Upload a document no larger than 50 MB.');
    let imported: Spec;
    if (file.name.toLowerCase().endsWith('.json')) {
      if (file.size > 1024 * 1024) throw new Error('Lesson JSON must be no larger than 1 MB.');
      const parsed = JSON.parse(await file.text()) as Spec;
      if (
        !parsed ||
        typeof parsed.title !== 'string' ||
        !Array.isArray(parsed.steps) ||
        !parsed.steps.length ||
        parsed.steps.length > 100 ||
        parsed.steps.some(step => !step || typeof step.title !== 'string' || typeof step.kind !== 'string')
      )
        throw new Error('Import a lesson draft with a title and 1–100 activity sections.');
      imported = {
        title: parsed.title,
        description: parsed.description || '',
        steps: parsed.steps.map(step => ({ ...blankStep(), ...step, id: crypto.randomUUID() })),
      };
    } else {
      const body = new FormData();
      body.append('file', file);
      imported = await api<Spec>(`/folders/${folderId}/lesson-import`, 'POST', body);
    }
    const combined = draft
      ? [...draft.steps.filter(s => s.title !== 'New section' || s.text.trim()), ...imported.steps]
      : imported.steps;
    if (combined.length > 100)
      throw new Error('A lesson supports up to 100 sections. Split this material into smaller lessons.');
    dirty.current = true;
    setDraft({ title: draft?.title || imported.title, description: draft?.description || '', steps: combined });
    setNotice(
      'Material imported into editable sections. Review it and add your activities before publishing. Document layouts are extracted as text; JSON media references require access to assets in this folder.'
    );
  };

  const uploadMedia = async (index: number, file: File) => {
    if (file.size > 50 * 1024 * 1024) throw new Error('Upload media no larger than 50 MB.');
    const body = new FormData();
    body.append('file', file);
    const asset = await api<{ id: string; mime: string }>(`/folders/${folderId}/lesson-assets`, 'POST', body);
    const expected = draft?.steps[index].kind === 'image' ? 'image/' : 'video/';
    if (!asset.mime.startsWith(expected)) throw new Error('Choose a file matching this section type.');
    editStep(index, { asset_id: asset.id, url: '' });
    setNotice(`Uploaded ${file.name}. Save the draft to preview it.`);
  };

  const move = (index: number, direction: number) => {
    if (!draft || index + direction < 0 || index + direction >= draft.steps.length) return;
    const steps = [...draft.steps];
    [steps[index], steps[index + direction]] = [steps[index + direction], steps[index]];
    edit({ steps });
  };

  const navigate = async (step: number, finish = false) => {
    if (!lesson) return;
    await api(`/lessons/${lesson.id}/progress`, 'PUT', { version: lesson.version, step, completed: finish });
    const isDone = completed || finish;
    setPosition(step);
    setFurthest(value => Math.max(value, step));
    const targetStep = lesson.steps[step];
    const savedAnswer = targetStep ? answeredSteps[targetStep.id] : undefined;
    setSelection(savedAnswer ? savedAnswer.choice : null);
    setFeedback(savedAnswer ? { correct: savedAnswer.correct, feedback: savedAnswer.feedback } : null);
    onProgressChange?.(lesson.id, { step, completed: isDone, started: true });
    if (finish) {
      setCompletionOpen(true);
      setCompleted(true);
      setNotice('Lesson completed. Your progress is saved.');
    } else setNotice('Progress saved.');
  };

  const activeTranslation = lesson?.translations?.[language];
  const displayLessonTitle =
    (activeTranslation?.title && activeTranslation.title.trim() ? activeTranslation.title : lesson?.title) || '';
  const displayLessonDescription = activeTranslation?.description ?? lesson?.description ?? '';
  const displaySteps =
    lesson && activeTranslation?.steps && activeTranslation.steps.length === lesson.steps.length
      ? activeTranslation.steps
      : lesson?.steps || [];

  const current = displaySteps[position];
  const isUnsavedPreview = previewing || (lesson ? lesson.status !== 'published' : false);

  useEffect(() => {
    if (!activityPanel.current) return;
    const animation = animateInterface(
      activityPanel.current,
      [
        { opacity: 0, transform: 'translateY(8px)' },
        { opacity: 1, transform: 'translateY(0)' },
      ],
      { duration: uiMotion.enter, easing: uiMotion.entrance }
    );
    activityPanel.current.querySelector<HTMLElement>('h3')?.focus({ preventScroll: true });
    return () => animation.cancel();
  }, [current?.id, completionOpen, language]);

  const goTo = async (index: number) => {
    if (!lesson) return;
    const targetStep = lesson.steps[index];
    const savedAnswer = targetStep ? answeredSteps[targetStep.id] : undefined;
    if (isUnsavedPreview) {
      setPosition(index);
      setSelection(savedAnswer ? savedAnswer.choice : null);
      setFeedback(savedAnswer ? { correct: savedAnswer.correct, feedback: savedAnswer.feedback } : null);
    } else await navigate(index);
  };

  const previewDraft = () => {
    if (!draft) return;
    setLesson({ ...draft, id: editingId || 'unsaved-preview', status: 'draft', version: 0, is_creator: true });
    setPosition(0);
    setCompleted(false);
    setCompletionOpen(false);
    setFeedback(null);
    setSelection(null);
    setPreviewing(true);
  };

  const addActivity = (kind: Step['kind']) => {
    if (!draft || draft.steps.length >= 100) return;
    edit({
      steps: [
        ...draft.steps,
        {
          ...blankStep(),
          kind,
          title: '',
          ...(kind === 'question' ? { options: ['', ''], answer: 0 } : {}),
          ...(kind === 'board' ? { board: { layout: 'cards', cards: [newBoardCard(), newBoardCard()] } as Board } : {}),
        },
      ],
    });
  };

  return (
    <section className="learning-lessons" role="tabpanel" id="learning-lessons" aria-labelledby="learning-lessons-tab">
      {error && (
        <p role="alert" className="learning-alert">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="learning-notice">
          {notice}
        </p>
      )}

      {draft && !previewing ? (
        <form
          onSubmit={e => {
            e.preventDefault();
            void action(() => save(false));
          }}
          className="lesson-editor"
        >
          <header>
            <h2>{editingId ? t('Edit lesson') : t('Create lesson')}</h2>
            <div className="lesson-editor-header-actions">
              <button type="button" disabled={busy} onClick={() => void action(() => save(false))}>
                Save draft
              </button>
              <button
                type="button"
                className="learning-primary"
                disabled={busy}
                onClick={() => void action(() => save(true))}
              >
                Save & Publish
              </button>
              <button type="button" disabled={busy} onClick={previewDraft}>
                Preview lesson
              </button>
              <button type="button" disabled={busy} onClick={exportDraft}>
                Export editable lesson
              </button>
              <button type="button" disabled={busy} onClick={leave}>
                Back to lessons
              </button>
            </div>
          </header>
          <p>
            Write your lesson here, import your materials, then review and publish it. Practice questions provide
            immediate feedback and are separate from graded quizzes.
          </p>

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
                  onClick={() => void action(generateAllThreeLanguages)}
                >
                  ✦ {t('Generate 3 Languages')} ({orderedLangs.map(c => c.toUpperCase()).join(' → ')})
                </button>
                <button
                  type="button"
                  className="learning-primary"
                  disabled={busy}
                  onClick={() => void action(() => save(true, true))}
                >
                  ✓ {t('Approve All 3 Languages & Finish Draft')}
                </button>
              </div>
            </div>
            <div className="learning-i18n-lang-tabs">
              {orderedLangs.map((code, idx) => {
                const isApproved = Boolean(
                  draft.approved_languages?.includes(code) || draft.translations?.[code]?.approved
                );
                const hasContent = Boolean(
                  code === authorLang ? draft.title.trim() : draft.translations?.[code]?.title?.trim()
                );
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
                      onClick={() => toggleLanguageApproval(code)}
                      title={isApproved ? `Approved (${languageLabel(code)})` : `Approve ${languageLabel(code)}`}
                    >
                      {isApproved ? '✓' : 'Approve'}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="lesson-author-summary">
            <span>{draft.steps.length} sections</span>
            <span>{draft.steps.filter(s => s.kind === 'question').length} practice activities</span>
            <span>{draft.steps.filter(s => s.kind === 'board').length} interactive boards</span>
          </div>
          <fieldset disabled={busy}>
            <label>
              Lesson title
              <input required maxLength={200} value={draft.title} onChange={e => edit({ title: e.target.value })} />
            </label>
            <label>
              Introduction
              <textarea
                maxLength={2000}
                value={draft.description}
                onChange={e => edit({ description: e.target.value })}
              />
            </label>
            <label>
              Import document
              <input
                type="file"
                accept=".json,.pdf,.pptx,.docx,.epub,.txt,.md,.html,.htm,.xlsx,.csv"
                onChange={e => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (file) void action(() => importFile(file));
                }}
              />
            </label>
            <small>Up to 50 MB. PDF, PowerPoint, Word and other supported documents become editable text sections.</small>
            <section className="lesson-section lesson-buddy">
              <h3>Ask {brandText("Buddy")} to help</h3>
              <p>
                Describe the lesson you need, or import a document above and ask {brandText("Buddy")} to improve its structure, add
                examples, or create practice questions, interactive boards, or branching scenarios. You review every
                change.
              </p>
              <label>
                Instructions for {brandText("Buddy")}
                <textarea
                  maxLength={6000}
                  value={buddyBrief}
                  placeholder="Build a visual lesson with a clickable concept board, a realistic decision scenario, and practice questions…"
                  onChange={e => setBuddyBrief(e.target.value)}
                />
              </label>
              <button
                type="button"
                disabled={!buddyBrief.trim() || busy}
                onClick={() =>
                  void action(async () => {
                    const current = draft.title.trim() ? draft : null;
                    const primaryLang = getLearningLanguage();
                    const result = await api<{ draft: Spec; source_truncated: boolean; untranslated?: string[] }>(
                      `/folders/${folderId}/lesson-draft`,
                      'POST',
                      { message: buddyBrief, language: primaryLang, current, ...assistantNamePayload() }
                    );
                    setProposal(result.draft);
                    setNotice(
                      (result.source_truncated
                        ? brandText('Buddy used part of your source material. Review coverage before applying.')
                        : brandText('Buddy’s proposal is ready for your review.')) + untranslatedWarning(result.untranslated)
                    );
                  })
                }
              >
                {busy ? brandText('Buddy is working…') : brandText('Draft with Buddy')}
              </button>
              {proposal && (
                <div className="lesson-proposal">
                  <h4>{proposal.title}</h4>
                  <LessonContent text={proposal.description} />
                  <ol>
                    {proposal.steps.map(section => (
                      <li key={section.id}>
                        <strong>{section.title}</strong>
                        <LessonContent text={section.text} />
                        {section.kind === 'board' && section.board && (
                          <LessonBoard key={section.id} board={section.board} />
                        )}
                        {section.kind === 'question' && (
                          <>
                            <ul>
                              {section.options.map((choice, i) => (
                                <li key={i}>
                                  {choice}
                                  {i === section.answer ? ' (correct)' : ''}
                                </li>
                              ))}
                            </ul>
                            <LessonContent text={section.feedback || ''} />
                          </>
                        )}
                      </li>
                    ))}
                  </ol>
                  <p>Applying replaces the editable text and activities. Uploaded media sections are retained.</p>
                  <button
                    type="button"
                    onClick={() => {
                      const media = draft.steps.filter(s => s.kind === 'video' || s.kind === 'image');
                      if (proposal.steps.length + media.length > 100) {
                        setError('Split this lesson into smaller lessons before applying.');
                        return;
                      }
                      edit({
                        ...proposal,
                        steps: [...proposal.steps, ...media.map(s => ({ ...s, id: crypto.randomUUID() }))],
                      });
                      setProposal(null);
                      setNotice(brandText('Buddy’s proposal applied to your unsaved draft. Review and save it before publishing.'));
                    }}
                  >
                    Apply {brandText("Buddy")} proposal
                  </button>
                  <button type="button" onClick={() => setProposal(null)}>
                    Discard proposal
                  </button>
                </div>
              )}
            </section>
            {draft.steps.map((step, index) => (
              <article className="lesson-section" key={step.id}>
                <header>
                  <h3>Section {index + 1}</h3>
                  <div>
                    <button
                      type="button"
                      aria-label={`Move section ${index + 1} up`}
                      disabled={index === 0}
                      onClick={() => move(index, -1)}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      aria-label={`Move section ${index + 1} down`}
                      disabled={index === draft.steps.length - 1}
                      onClick={() => move(index, 1)}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      aria-label={`Duplicate section ${index + 1}`}
                      disabled={draft.steps.length >= 100}
                      onClick={() => {
                        const copy = {
                          ...structuredClone(step),
                          id: crypto.randomUUID(),
                          title: `${step.title} (copy)`,
                        };
                        edit({
                          steps: [...draft.steps.slice(0, index + 1), copy, ...draft.steps.slice(index + 1)],
                        });
                      }}
                    >
                      Duplicate
                    </button>
                    <button
                      type="button"
                      disabled={draft.steps.length === 1}
                      onClick={() => edit({ steps: draft.steps.filter((_, i) => i !== index) })}
                    >
                      Remove
                    </button>
                  </div>
                </header>
                <label>
                  Section title
                  <input
                    required
                    maxLength={200}
                    value={step.title}
                    onChange={e => editStep(index, { title: e.target.value })}
                  />
                </label>
                <label>
                  Activity type
                  <select
                    value={step.kind}
                    onChange={e => {
                      const kind = e.target.value as Step['kind'];
                      editStep(index, {
                        kind,
                        board: kind === 'board' ? { layout: 'cards', cards: [newBoardCard(), newBoardCard()] } : null,
                        options: kind === 'question' ? ['Choice 1', 'Choice 2'] : [],
                        answer: kind === 'question' ? 0 : null,
                        feedback: '',
                        url: '',
                        asset_id: null,
                      });
                    }}
                  >
                    <option value="text">Explanation</option>
                    <option value="board">Interactive board / decision path</option>
                    <option value="reveal">Click to reveal</option>
                    <option value="question">Practice question</option>
                    <option value="video">Video</option>
                    <option value="image">Image</option>
                  </select>
                </label>
                <small>Content supports Markdown and safe HTML: headings, lists, tables, links and expandable details.</small>
                <label>
                  {step.kind === 'reveal'
                    ? 'Hidden explanation'
                    : step.kind === 'image'
                      ? 'Image description (alternative text)'
                      : 'Content / instructions'}
                  <textarea
                    maxLength={20000}
                    value={step.text}
                    onChange={e => editStep(index, { text: e.target.value })}
                  />
                </label>
                <details>
                  <summary>Private teacher notes</summary>
                  <label>
                    Teaching guidance, discussion prompts, or timing
                    <textarea
                      maxLength={10000}
                      value={step.teacher_notes || ''}
                      onChange={e => editStep(index, { teacher_notes: e.target.value })}
                    />
                  </label>
                  <small>Only the lesson creator can read these notes. They are excluded from learner content.</small>
                </details>
                {step.kind === 'board' && step.board && (
                  <section className="lesson-board-editor">
                    <label>
                      Board style
                      <select
                        value={step.board.layout}
                        onChange={e =>
                          editStep(index, {
                            board: {
                              ...step.board!,
                              layout: e.target.value as Board['layout'],
                              cards: step.board!.cards.map(card => ({ ...card, next_ids: [] })),
                            },
                          })
                        }
                      >
                        <option value="cards">Clickable concept cards</option>
                        <option value="path">Branching decision scenario</option>
                      </select>
                    </label>
                    <p>
                      {step.board.layout === 'path'
                        ? 'The first card starts the scenario. Connect each card to its choices; leave ending cards without connections.'
                        : 'Learners reveal each card to explore the topic.'}
                    </p>
                    {step.board.cards.map((card, cardIndex) => {
                      const updateCard = (change: Partial<BoardCard>) =>
                        editStep(index, {
                          board: {
                            ...step.board!,
                            cards: step.board!.cards.map((value, i) =>
                              i === cardIndex ? { ...value, ...change } : value
                            ),
                          },
                        });
                      return (
                        <article className="lesson-section" key={card.id}>
                          <h4>Card {cardIndex + 1}</h4>
                          <label>
                            Card title
                            <input
                              required
                              maxLength={120}
                              value={card.title}
                              onChange={e => updateCard({ title: e.target.value })}
                            />
                          </label>
                          <label>
                            Card content
                            <textarea
                              required
                              maxLength={5000}
                              value={card.body}
                              onChange={e => updateCard({ body: e.target.value })}
                            />
                          </label>
                          <label>
                            Card color
                            <select
                              value={card.color}
                              onChange={e => updateCard({ color: e.target.value as BoardCard['color'] })}
                            >
                              <option value="violet">Violet</option>
                              <option value="blue">Blue</option>
                              <option value="green">Green</option>
                              <option value="amber">Amber</option>
                            </select>
                          </label>
                          {step.board!.layout === 'path' && (
                            <fieldset>
                              <legend>Choices from this card (up to four)</legend>
                              {step.board!.cards
                                .filter(target => target.id !== card.id)
                                .map(target => (
                                  <label className="lesson-choice" key={target.id}>
                                    <input
                                      type="checkbox"
                                      checked={card.next_ids.includes(target.id)}
                                      disabled={card.next_ids.length >= 4 && !card.next_ids.includes(target.id)}
                                      onChange={e =>
                                        updateCard({
                                          next_ids: e.target.checked
                                            ? [...card.next_ids, target.id]
                                            : card.next_ids.filter(id => id !== target.id),
                                        })
                                      }
                                    />
                                    {target.title}
                                  </label>
                                ))}
                            </fieldset>
                          )}
                          <button
                            type="button"
                            disabled={step.board!.cards.length <= 2}
                            onClick={() =>
                              editStep(index, {
                                board: {
                                  ...step.board!,
                                  cards: step.board!.cards
                                    .filter(value => value.id !== card.id)
                                    .map(value => ({
                                      ...value,
                                      next_ids: value.next_ids.filter(id => id !== card.id),
                                    })),
                                },
                              })
                            }
                          >
                            Remove card
                          </button>
                        </article>
                      );
                    })}
                    <button
                      type="button"
                      disabled={step.board.cards.length >= 12}
                      onClick={() =>
                        editStep(index, {
                          board: { ...step.board!, cards: [...step.board!.cards, newBoardCard()] },
                        })
                      }
                    >
                      + Add learning card
                    </button>
                    <h4>Learner preview</h4>
                    <LessonBoard key={step.id + step.board.layout} board={step.board} />
                  </section>
                )}
                {step.kind === 'question' && (
                  <>
                    {step.options.map((option, choice) => (
                      <label key={choice}>
                        Choice {choice + 1}
                        <input
                          required
                          maxLength={1000}
                          value={option}
                          onChange={e =>
                            editStep(index, {
                              options: step.options.map((v, i) => (i === choice ? e.target.value : v)),
                            })
                          }
                        />
                      </label>
                    ))}
                    <div>
                      <button
                        type="button"
                        disabled={step.options.length >= 8}
                        onClick={() => editStep(index, { options: [...step.options, ''] })}
                      >
                        Add choice
                      </button>
                      <button
                        type="button"
                        disabled={step.options.length <= 2}
                        onClick={() => editStep(index, { options: step.options.slice(0, -1), answer: 0 })}
                      >
                        Remove last choice
                      </button>
                    </div>
                    <label>
                      Correct choice
                      <select
                        value={step.answer ?? 0}
                        onChange={e => editStep(index, { answer: Number(e.target.value) })}
                      >
                        {step.options.map((_, choice) => (
                          <option key={choice} value={choice}>
                            Choice {choice + 1}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Feedback after checking
                      <textarea
                        maxLength={5000}
                        value={step.feedback || ''}
                        onChange={e => editStep(index, { feedback: e.target.value })}
                      />
                    </label>
                  </>
                )}
                {step.kind === 'video' && (
                  <label>
                    YouTube or Vimeo URL
                    <input
                      type="url"
                      value={step.url}
                      placeholder="https://…"
                      onChange={e => editStep(index, { url: e.target.value, asset_id: null })}
                    />
                  </label>
                )}
                {(step.kind === 'image' || step.kind === 'video') && (
                  <label>
                    {step.kind === 'video' ? 'Or upload MP4 / WebM' : 'Upload image'} (up to 50 MB)
                    <input
                      type="file"
                      accept={
                        step.kind === 'image' ? 'image/png,image/jpeg,image/gif,image/webp' : 'video/mp4,video/webm'
                      }
                      onChange={e => {
                        const file = e.target.files?.[0];
                        e.target.value = '';
                        if (file) void action(() => uploadMedia(index, file));
                      }}
                    />
                    {step.asset_id && <small>Media attached</small>}
                  </label>
                )}
              </article>
            ))}
            <section className="lesson-activity-toolbox">
              <h3>Add an activity</h3>
              <p>Mix explanations, discovery and practice to keep your lesson engaging.</p>
              <div>
                {(['text', 'reveal', 'question', 'board', 'video', 'image'] as Step['kind'][]).map(kind => (
                  <button type="button" key={kind} disabled={draft.steps.length >= 100} onClick={() => addActivity(kind)}>
                    <span aria-hidden="true">{activityIcons[kind]}</span>
                    {activityLabels[kind]}
                  </button>
                ))}
              </div>
            </section>
            <button
              type="button"
              disabled={draft.steps.length >= 100}
              onClick={() => edit({ steps: [...draft.steps, blankStep()] })}
            >
              + Add section
            </button>
            <div className="lesson-editor-footer-actions">
              <button type="button" disabled={busy} onClick={() => void action(() => save(false))}>
                {busy ? 'Saving…' : 'Save draft'}
              </button>
              <button
                type="button"
                className="learning-primary"
                disabled={busy}
                onClick={() => void action(() => save(true))}
              >
                {busy ? 'Saving…' : 'Save & Publish'}
              </button>
            </div>
          </fieldset>
        </form>
      ) : lesson && current ? (
        <article className="lesson-player">
          <header className="lesson-player-header">
            <div>
              <p className="lesson-eyebrow">
                {isUnsavedPreview ? 'AUTHOR PREVIEW' : completed ? 'COMPLETED LESSON' : 'YOUR LEARNING JOURNEY'}
              </p>
              <h2>{displayLessonTitle || 'Untitled lesson'}</h2>
              <LessonContent text={displayLessonDescription} />
            </div>
            <div className="lesson-player-header-actions">
              {lesson.is_creator && (
                <button type="button" disabled={busy} onClick={() => void action(() => open(lesson, true))}>
                  Edit lesson
                </button>
              )}
              <button
                disabled={busy}
                onClick={() => {
                  if (previewing) {
                    setPreviewing(false);
                    setLesson(null);
                  } else leave();
                }}
              >
                {previewing ? 'Back to editor' : 'Back to lessons'}
              </button>
            </div>
          </header>
          {completionOpen ? (
            <section className="lesson-completion" aria-label="Lesson completion">
              <span className="lesson-completion-mark" aria-hidden="true">
                ✓
              </span>
              <p className="lesson-eyebrow">A STEP FORWARD</p>
              <h3>{t('Lesson complete')}</h3>
              <p>
                You finished {displayLessonTitle}. Your progress is saved, and you can revisit any section.
              </p>
              <div className="lesson-author-summary">
                <span>
                  {displaySteps.length} {t('sections')}
                </span>
                <span>{displaySteps.filter(s => s.kind === 'question').length} practice activities</span>
                <span>{displaySteps.filter(s => s.kind === 'board').length} interactive boards</span>
              </div>
              <div className="lesson-actions">
                <button
                  disabled={busy}
                  onClick={() =>
                    void action(async () => {
                      await goTo(0);
                      setCompletionOpen(false);
                    })
                  }
                >
                  {t('Review lesson')}
                </button>
                <button className="learning-primary" onClick={leave}>
                  {t('Explore more lessons')}
                </button>
              </div>
            </section>
          ) : (
            <>
              <div className="lesson-progress-bar">
                <span>
                  Section {position + 1} of {displaySteps.length}
                </span>
                <span>
                  {activityLabels[current.kind]}
                  {completed ? ` · ${t('Completed')}` : ''}
                </span>
                <progress value={position + 1} max={displaySteps.length} aria-label="Lesson position" />
              </div>
              <div className="lesson-experience-layout">
                <nav className="lesson-outline" aria-label="Lesson sections">
                  <p className="lesson-eyebrow">YOUR PATH</p>
                  <ol>
                    {displaySteps.map((step, index) => {
                      const stepAns = answeredSteps[step.id];
                      const isStepDone = completed || index < furthest || Boolean(stepAns?.correct);
                      return (
                        <li key={step.id}>
                          <button
                            type="button"
                            className={isStepDone ? 'is-step-done' : ''}
                            disabled={busy || (!lesson.is_creator && !completed && index > furthest)}
                            aria-current={index === position ? 'step' : undefined}
                            onClick={() => void action(() => goTo(index))}
                          >
                            <span className="lesson-outline-number">{isStepDone ? '✓' : index + 1}</span>
                            <span>
                              <strong>{step.title || 'Untitled section'}</strong>
                              <small>
                                {activityLabels[step.kind]}
                                {stepAns ? (stepAns.correct ? ' · ✓ Answered' : ' · Needs review') : ''}
                              </small>
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ol>
                </nav>
                <div className={`lesson-activity-card activity-${current.kind}`} ref={activityPanel}>
                  <div className="lesson-activity-label">
                    <span aria-hidden="true">{activityIcons[current.kind]}</span>
                    {activityLabels[current.kind]}
                  </div>
                  <h3 tabIndex={-1}>{current.title || 'Untitled section'}</h3>
                  {current.kind === 'reveal' ? (
                    <details className="lesson-reveal" key={current.id + '-' + language}>
                      <summary>
                        <span aria-hidden="true">✦</span> Reveal explanation
                      </summary>
                      <LessonContent text={current.text} />
                    </details>
                  ) : (
                    <LessonContent text={current.text} />
                  )}
                  {current.kind === 'board' && current.board && (
                    <LessonBoard key={current.id + '-' + language} board={current.board} />
                  )}
                  {previewing && !editingId && current.asset_id && (
                    <p className="learning-notice">Save your draft to preview uploaded media.</p>
                  )}
                  {current.kind === 'image' && current.asset_id && (!previewing || !!editingId) && (
                    <img
                      src={`/api/learning/lessons/${lesson.id}/assets/${current.asset_id}`}
                      alt={current.text || current.title}
                    />
                  )}
                  {current.kind === 'video' &&
                    (!current.asset_id || !previewing || !!editingId) &&
                    (current.asset_id ? (
                      <video
                        key={current.id}
                        controls
                        preload="metadata"
                        src={`/api/learning/lessons/${lesson.id}/assets/${current.asset_id}`}
                      />
                    ) : (
                      <iframe
                        key={current.id}
                        src={current.url}
                        title={current.title}
                        sandbox="allow-scripts allow-same-origin allow-presentation"
                        allow="fullscreen; picture-in-picture"
                        allowFullScreen
                        referrerPolicy="strict-origin-when-cross-origin"
                      />
                    ))}
                  {current.kind === 'question' && (
                    <fieldset disabled={busy}>
                      <legend>{t('Choose an answer')}</legend>
                      {current.options.map((option, index) => {
                        const isSelected = selection === index;
                        const choiceTone =
                          isSelected && feedback ? (feedback.correct ? 'is-correct-choice' : 'is-wrong-choice') : '';
                        return (
                          <label
                            key={index}
                            className={`lesson-choice ${isSelected ? 'is-selected' : ''} ${choiceTone}`}
                          >
                            <input
                              type="radio"
                              name={current.id}
                              checked={isSelected}
                              onChange={() => {
                                setSelection(index);
                                setFeedback(null);
                              }}
                            />
                            <span className="lesson-choice-letter" aria-hidden="true">
                              {String.fromCharCode(65 + index)}
                            </span>
                            <span className="lesson-choice-text">{option}</span>
                            {isSelected && feedback && (
                              <span className={`lesson-choice-status ${feedback.correct ? 'is-ok' : 'is-retry'}`}>
                                {feedback.correct ? '✓ Correct' : '✕ Try again'}
                              </span>
                            )}
                            {isSelected && !feedback && <span className="lesson-choice-status is-picked">Selected</span>}
                          </label>
                        );
                      })}
                      <button
                        className="learning-primary"
                        disabled={selection === null}
                        onClick={() =>
                          void action(async () => {
                            const res = isUnsavedPreview
                              ? { correct: selection === current.answer, feedback: current.feedback || '' }
                              : await api<{ correct: boolean; feedback: string }>(`/lessons/${lesson.id}/check`, 'POST', {
                                  version: lesson.version,
                                  step_id: current.id,
                                  answer: selection,
                                });
                            setFeedback(res);
                            if (selection !== null) {
                              setAnsweredSteps(prev => ({
                                ...prev,
                                [current.id]: { choice: selection, correct: res.correct, feedback: res.feedback },
                              }));
                            }
                          })
                        }
                      >
                        {t('Check answer')}
                      </button>
                      {feedback ? (
                        <div
                          className={`lesson-practice-feedback ${feedback.correct ? 'is-correct' : 'is-retry'}`}
                          role="status"
                        >
                          <div className="lesson-practice-feedback-head">
                            <strong>{feedback.correct ? '✓ Correct. Well done!' : 'Not quite. Take another look.'}</strong>
                            {selection !== null && (
                              <span className="lesson-practice-your-choice">
                                Your answer: Option {String.fromCharCode(65 + selection)} ({current.options[selection]})
                              </span>
                            )}
                          </div>
                          <LessonContent text={feedback.feedback} />
                          {!feedback.correct && (
                            <p className="lesson-practice-coach">
                              <strong>How to improve:</strong> Use the explanation above to rethink the key concept,
                              then select a different option and click <em>Check answer</em> again.
                            </p>
                          )}
                        </div>
                      ) : (
                        <p className="lesson-practice-hint">Check your answer to see feedback before continuing.</p>
                      )}
                    </fieldset>
                  )}
                  <footer className="lesson-player-controls">
                    <button disabled={busy || position === 0} onClick={() => void action(() => goTo(position - 1))}>
                      {t('Previous')}
                    </button>
                    <div>
                      {position < displaySteps.length - 1 && (
                        <small>Up next: {displaySteps[position + 1].title}</small>
                      )}
                      <button
                        className="learning-primary"
                        disabled={
                          busy ||
                          (!isUnsavedPreview &&
                            (lesson.status !== 'published' || (current.kind === 'question' && !feedback)))
                        }
                        onClick={() =>
                          void action(async () => {
                            if (position < displaySteps.length - 1) await goTo(position + 1);
                            else if (!isUnsavedPreview) await navigate(position, true);
                            else setNotice('End of author preview.');
                          })
                        }
                      >
                        {busy
                          ? 'Saving…'
                          : position < displaySteps.length - 1
                            ? t('Save & continue')
                            : isUnsavedPreview
                              ? t('Finish preview')
                              : t('Complete lesson')}
                      </button>
                    </div>
                  </footer>
                </div>
              </div>
            </>
          )}
        </article>
      ) : (
        <>
          <header>
            <div>
              <h2>Interactive lessons</h2>
              <p>{t('Human-authored lessons, activities and videos. Resume where you left off.')}</p>
            </div>
            {canCreate && (
              <button
                className="learning-primary"
                onClick={() => {
                  setAuthorLang(getLearningLanguage());
                  setDraft(blank());
                  setEditingId(null);
                  dirty.current = false;
                }}
              >
                + Create lesson
              </button>
            )}
          </header>
          {loading && <p role="status">Loading lessons…</p>}
          <div className="lesson-grid">
            {items
              .filter(item => {
                const localTitle = item.translations?.[language]?.title || item.title;
                return (
                  localTitle.toLowerCase().includes(search.toLowerCase()) ||
                  item.title.toLowerCase().includes(search.toLowerCase())
                );
              })
              .map((item, index) => {
                const localTitle = item.translations?.[language]?.title || item.title;
                return (
                  <article className="lesson-section" key={item.id}>
                    <div className="lesson-card-header">
                      <span className="lesson-order-badge">Lesson {index + 1}</span>
                      {canCreate && !search && items.length > 1 && (
                        <div className="lesson-reorder-controls">
                          <button
                            type="button"
                            className="lesson-order-btn"
                            disabled={busy || index === 0}
                            onClick={() => void reorder(index, index - 1)}
                            title="Move earlier (first)"
                            aria-label={`Move ${localTitle} earlier`}
                          >
                            ▲
                          </button>
                          <span className="lesson-order-num">{index + 1}</span>
                          <button
                            type="button"
                            className="lesson-order-btn"
                            disabled={busy || index === items.length - 1}
                            onClick={() => void reorder(index, index + 1)}
                            title="Move later (second)"
                            aria-label={`Move ${localTitle} later`}
                          >
                            ▼
                          </button>
                        </div>
                      )}
                    </div>
                    <h3>{localTitle}</h3>
                    <p>
                      {item.status} · Version {item.version}
                    </p>
                    <div className="lesson-actions">
                      {(item.status !== 'draft' || item.is_creator) && (
                        <button disabled={busy} onClick={() => void action(() => open(item))}>
                          {item.is_creator ? t('Preview') : t('Open lesson')}
                        </button>
                      )}
                      {item.is_creator && (
                        <button disabled={busy} onClick={() => void action(() => open(item, true))}>
                          {t('Edit lesson')}
                        </button>
                      )}
                      {item.is_creator && (
                        <button disabled={busy} onClick={() => void action(() => copyLesson(item))}>
                          {t('Copy as new lesson')}
                        </button>
                      )}
                      {canCreate && onDraftQuiz && (
                        <button type="button" disabled={busy} onClick={() => void action(() => onDraftQuiz(item))}>
                          {t('Draft Quiz')}
                        </button>
                      )}
                      {item.is_creator && item.status !== 'published' && (
                        <button className="learning-primary" disabled={busy} onClick={() => promptPublish(item)}>
                          {t('Approve & publish')}
                        </button>
                      )}
                      {item.is_creator && (
                        <button
                          className="learning-text-button learning-danger"
                          disabled={busy}
                          onClick={() => promptDelete(item)}
                        >
                          {t('Delete')}
                        </button>
                      )}
                    </div>
                  </article>
                );
              })}
          </div>
          {!loading && !items.length && (
            <p>
              No lessons yet.
              {canCreate
                ? ' Create a lesson, write your content or import a document, and add activities.'
                : ' Your assigned lessons will appear here when published.'}
            </p>
          )}
        </>
      )}

      {confirmModal && (
        <LearningConfirmDialog
          title={confirmModal.title}
          message={confirmModal.message}
          confirmLabel={confirmModal.confirmLabel}
          cancelLabel={confirmModal.cancelLabel}
          danger={confirmModal.danger}
          onConfirm={() => void confirmModal.onConfirm()}
          onCancel={() => setConfirmModal(null)}
        />
      )}
    </section>
  );
}
