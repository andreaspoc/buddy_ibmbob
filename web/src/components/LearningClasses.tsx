import { useEffect, useRef, useState } from 'react';
import { learningUserName } from '../lib/learningIdentity';
import { LessonContent } from './LessonContent';
import './LearningClasses.css';
import LearningCourseCompletion from './LearningCourseCompletion';
import { ClassDocumentField } from './ClassDocumentField';
import { draftLessonFromDocument, type DraftOutcome } from '../lib/classDocumentDraft';
import { LearningConfirmDialog } from './LearningConfirmDialog';

type Person = { username: string; display_name?: string };
type ClassSummary = { id: string; title: string; description: string; revision: number; can_manage: boolean; can_delete?: boolean; archived?: boolean; teacher_username?: string; teacher_display_name?: string; can_assign_teacher?: boolean; folder_id: string };
type Announcement = { id: string; title: string; body: string; revision: number; created_at?: string };
type ClassSession = { id: string; title: string; description: string; starts_at: string; ends_at: string; section: string; revision: number };
type Submission = Person & { id: string; text: string; revision: number; submitted_at: string; assignment_revision?: number; assignment_snapshot?: {title?:string;instructions?:string}; reviewed_at?: string | null; feedback?: string; mark?: number | null; max_mark?: number | null };
type ResourceType = 'none' | 'book' | 'lesson' | 'quiz';
type Resource = { id: string; title: string; status?: string };
type Resources = { books: Resource[]; lessons: Resource[]; quizzes: Resource[] };
type Assignment = { id: string; title: string; instructions: string; section: string; due_at: string | null; resource_type: ResourceType; resource_id: string | null; resource_version?: number | null; allow_late: boolean; required: boolean; minimum_score_percent: number; revision: number; submission_count?: number; my_submission?: Submission | null };
type Editor = { kind: 'class' | 'announcement' | 'session' | 'assignment'; id?: string; revision?: number; title: string; description?: string; body?: string; starts_at?: string; ends_at?: string; section?: string; instructions?: string; due_at?: string; resource_type?: ResourceType; resource_id?: string; allow_late?: boolean; required?: boolean; minimum_score_percent?: number; archived?: boolean; teacher_username?: string };

export function localClassDate(value?: string | null) {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
export function classDateIso(value: string, label: string) {
  const date = new Date(value);
  if (!value || !Number.isFinite(date.getTime())) throw new Error(`Enter a valid ${label}.`);
  return date.toISOString();
}
export function assignmentResourceOptions(resources: Resources, kind: ResourceType) {
  const list = kind === 'book' ? resources.books : kind === 'lesson' ? resources.lessons : kind === 'quiz' ? resources.quizzes : [];
  return list.filter(resource => kind === 'book' || resource.status === 'published');
}
const displayDate = (value: string) => new Date(value).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
const message = (error: unknown) => error instanceof Error ? error.message : 'Unable to complete this request.';
async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch('/api/learning' + path, { method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof result.detail === 'string' ? result.detail : `Unable to complete this request (${response.status}). Check the fields and your current class access.`);
  return result;
}

export function LearningClasses({ folderId, canCreate, canAssignTeacher = false, search = '', autoOpenFolderClass = false, initialTab, onOpenResource, onDeleted }: {
  folderId: string; canCreate: boolean; canAssignTeacher?: boolean; search?: string;
  autoOpenFolderClass?: boolean; initialTab?: 'overview' | 'calendar' | 'assignments' | 'members' | 'completion';
  onDeleted?: (folderDeleted: boolean) => void;
  onOpenResource?: (kind: 'book' | 'lesson' | 'quiz', id: string) => void;
}) {
  const [classes, setClasses] = useState<ClassSummary[]>([]);
  const [deleting, setDeleting] = useState<ClassSummary | null>(null);
  const [classDocument, setClassDocument] = useState<File | null>(null);
  const [classDocumentBrief, setClassDocumentBrief] = useState('');
  const [selected, setSelected] = useState<ClassSummary | null>(null);
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [sessions, setSessions] = useState<ClassSession[]>([]);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [members, setMembers] = useState<Person[]>([]);
  const [teachers, setTeachers] = useState<Person[]>([]);
  const [candidates, setCandidates] = useState<Person[]>([]);
  const [roster, setRoster] = useState<string[]>([]);
  const [rosterDirty, setRosterDirty] = useState(false);
  const [resources, setResources] = useState<Resources>({ books: [], lessons: [], quizzes: [] });
  const [tab, setTab] = useState<'overview' | 'calendar' | 'assignments' | 'members' | 'completion'>(initialTab || 'overview');
  const [editor, setEditor] = useState<Editor | null>(null);
  const [work, setWork] = useState<Record<string, string>>({});
  const [reviewAssignment, setReviewAssignment] = useState<Assignment | null>(null);
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [feedback, setFeedback] = useState<Record<string, { text: string; mark: string; maxMark: string }>>({});
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const epoch = useRef(0);
  const busyRef = useRef(false);
  const detailRequest = useRef(0);

  useEffect(() => {
    if (initialTab) setTab(initialTab);
  }, [initialTab]);

  const loadList = async () => {
    const currentEpoch = epoch.current;
    const result = await api<{ items: ClassSummary[] }>(`/folders/${folderId}/classes`);
    if (epoch.current === currentEpoch) setClasses(result.items);
  };
  useEffect(() => {
    const sequence = ++epoch.current;
    detailRequest.current += 1;
    setSelected(null); setEditor(null); setReviewAssignment(null); setError(''); setNotice(''); setLoading(true);
    setBusy(false); busyRef.current = false; setTeachers([]);
    if (canAssignTeacher) api<{ items: Person[] }>(`/folders/${folderId}/class-teachers`).then(data => { if (epoch.current === sequence) setTeachers(data.items); }).catch(error => { if (epoch.current === sequence) setError(message(error)); });
    api<{ items: ClassSummary[] }>(`/folders/${folderId}/classes`).then(data => {
      if (epoch.current === sequence) {
        setClasses(data.items);
        if (autoOpenFolderClass && data.items.length > 0) {
          const primary = data.items.find(item => item.id === folderId) || data.items[0];
          void open(primary.id);
        }
      }
    })
      .catch(error => { if (epoch.current === sequence) setError(message(error)); })
      .finally(() => { if (epoch.current === sequence) setLoading(false); });
    return () => { epoch.current += 1; detailRequest.current += 1; };
  }, [folderId, canAssignTeacher, autoOpenFolderClass]); // eslint-disable-line react-hooks/exhaustive-deps

  const open = async (id: string) => {
    const sequence = ++detailRequest.current, currentEpoch = epoch.current;
    const detail = await api<ClassSummary>(`/classes/${id}`);
    const [news, dates, tasks, rosterData, choices, content] = await Promise.all([
      api<{ items: Announcement[] }>(`/classes/${id}/announcements`),
      api<{ items: ClassSession[] }>(`/classes/${id}/sessions`),
      api<{ items: Assignment[] }>(`/classes/${id}/assignments`),
      detail.can_manage ? api<{ items: Person[] }>(`/classes/${id}/members`) : Promise.resolve({ items: [] }),
      detail.can_manage ? api<{ items: Person[] }>(`/classes/${id}/candidates`) : Promise.resolve({ items: [] }),
      detail.can_manage ? api<Resources>(`/folders/${folderId}/contents`) : Promise.resolve({ books: [], lessons: [], quizzes: [] }),
    ]);
    if (sequence !== detailRequest.current || currentEpoch !== epoch.current) return;
    setSelected(detail); setAnnouncements(news.items); setSessions(dates.items); setAssignments(tasks.items);
    setMembers(rosterData.items); setCandidates(choices.items); setRoster(rosterData.items.map(person => person.username)); setRosterDirty(false);
    setResources(content); setWork(Object.fromEntries(tasks.items.map(task => [task.id, task.my_submission?.text || ''])));
  };
  const action = async (operation: () => Promise<void>) => {
    if (busyRef.current) return;
    const sequence = epoch.current;
    busyRef.current = true; setBusy(true); setError(''); setNotice('');
    try { await operation(); } catch (error) { if (epoch.current === sequence) setError(message(error)); }
    finally { if (epoch.current === sequence) { busyRef.current = false; setBusy(false); } }
  };
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (editor || rosterDirty || assignments.some(item => (work[item.id] || '') !== (item.my_submission?.text || ''))) { event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [editor, rosterDirty, work, assignments]);
  const change = (values: Partial<Editor>) => setEditor(previous => previous && ({ ...previous, ...values }));
  const create = (kind: Editor['kind']) => {
    setEditor({ kind, title: '', description: '', body: '', instructions: '', section: '', starts_at: '', ends_at: '', due_at: '', resource_type: 'none', resource_id: '', teacher_username: '', allow_late: true, required: true, minimum_score_percent: 0, archived: false });
    setClassDocument(null); setClassDocumentBrief('');
    setError(''); setNotice('');
  };
  const save = async () => {
    if (!editor) return;
    const currentEpoch = epoch.current;
    let drafted: DraftOutcome | null = null;
    if (editor.kind === 'class') {
      const data = await api<ClassSummary>(editor.id ? `/classes/${editor.id}` : `/folders/${folderId}/classes`, editor.id ? 'PUT' : 'POST', {
        title: editor.title, description: editor.description || '', ...(canAssignTeacher && editor.teacher_username ? { teacher_username: editor.teacher_username } : {}), ...(editor.id ? { expected_revision: editor.revision, archived: !!editor.archived } : {}),
      });
      if (!editor.id && classDocument) drafted = await draftLessonFromDocument(data.folder_id, classDocument, classDocumentBrief);
      if (epoch.current !== currentEpoch) return;
      await loadList(); await open(data.id);
    } else {
      if (!selected) return;
      let body: Record<string, unknown>;
      if (editor.kind === 'announcement') body = { title: editor.title, body: editor.body || '' };
      else if (editor.kind === 'session') body = { title: editor.title, description: editor.description || '', section: editor.section || '', starts_at: classDateIso(editor.starts_at || '', 'session start'), ends_at: classDateIso(editor.ends_at || '', 'session end') };
      else body = { title: editor.title, instructions: editor.instructions || '', section: editor.section || '', due_at: editor.due_at ? classDateIso(editor.due_at, 'due date') : null, resource_type: editor.resource_type, resource_id: editor.resource_type === 'none' ? null : editor.resource_id || null, allow_late: !!editor.allow_late, required: editor.required !== false, minimum_score_percent: editor.minimum_score_percent ?? 0 };
      if (editor.id) body.expected_revision = editor.revision;
      const collection = editor.kind === 'announcement' ? 'announcements' : editor.kind === 'session' ? 'sessions' : 'assignments';
      await api(`/classes/${selected.id}/${collection}${editor.id ? `/${editor.id}` : ''}`, editor.id ? 'PUT' : 'POST', body);
      if (epoch.current !== currentEpoch) return;
      await open(selected.id);
    }
    if (epoch.current !== currentEpoch) return;
    setEditor(null);
    if (drafted && !drafted.ok) setError(drafted.message);
    else setNotice(drafted?.message ?? 'Changes saved.');
  };
  const review = async (assignment: Assignment) => {
    if (!selected) return;
    const currentEpoch = epoch.current;
    const result = await api<{ items: Submission[] }>(`/classes/${selected.id}/assignments/${assignment.id}/submissions`);
    if (epoch.current !== currentEpoch) return;
    setSubmissions(result.items); setReviewAssignment(assignment);
    setFeedback(Object.fromEntries(result.items.map(item => [item.id, { text: item.feedback || '', mark: item.mark == null ? '' : String(item.mark), maxMark: item.max_mark == null ? '' : String(item.max_mark) }])));
  };

  return <section className="learning-classes" aria-label="Classes and assignments">
    {deleting && <LearningConfirmDialog title="Delete class" message={`Delete “${deleting.title}”? Classes with learner activity cannot be deleted.`} confirmLabel="Delete" danger onCancel={() => setDeleting(null)} onConfirm={() => {
      const target = deleting; setDeleting(null);
      void action(async () => {
        const result = await api<{ folder_deleted: boolean }>(`/classes/${target.id}`, 'DELETE');
        detailRequest.current += 1; setSelected(null); setEditor(null); setReviewAssignment(null);
        if (!result.folder_deleted) await loadList();
        onDeleted?.(result.folder_deleted); setNotice('Class deleted.');
      });
    }} />}
    {error && <div className="learning-alert" role="alert">{error}</div>}
    {notice && <div className="learning-notice" role="status">{notice}</div>}
    {loading && <p role="status">Loading classes…</p>}
    {editor ? <form className="learning-class-editor" onSubmit={event => { event.preventDefault(); void action(save); }}>
      <header><div><p className="learning-class-eyebrow">TEACHER WORKSPACE</p><h2>{editor.id ? 'Edit' : 'Create'} {editor.kind}</h2></div><button type="button" disabled={busy} onClick={() => setEditor(null)}>Discard changes</button></header>
      <fieldset disabled={busy}><label>Title<input required maxLength={200} value={editor.title} onChange={event => change({ title: event.target.value })} /></label>
        {editor.kind === 'class' && canAssignTeacher && <label>Lead teacher<select aria-label="Lead teacher" value={editor.teacher_username || ''} onChange={event => change({ teacher_username: event.target.value })}><option value="">{editor.id ? 'Keep the assigned teacher' : 'Assign to myself'}</option>{teachers.map(person => <option key={person.username} value={person.username}>{learningUserName(person)}</option>)}</select><small>Choose a teacher with current access to this folder. This person manages the course and reviews completion.</small></label>}
        {(editor.kind === 'class' || editor.kind === 'session') && <label>Description<textarea aria-label="Description" maxLength={5000} rows={4} value={editor.description || ''} onChange={event => change({ description: event.target.value })} /></label>}
        {editor.kind === 'class' && !editor.id && <ClassDocumentField file={classDocument} brief={classDocumentBrief} busy={busy} onFile={setClassDocument} onBrief={setClassDocumentBrief} />}
        {editor.kind === 'class' && editor.id && <label className="learning-class-check"><input type="checkbox" checked={!!editor.archived} onChange={event => change({ archived: event.target.checked })} />Archive this class</label>}
        {editor.kind === 'announcement' && <label>Announcement<textarea aria-label="Announcement" required rows={7} maxLength={10000} value={editor.body || ''} onChange={event => change({ body: event.target.value })} /></label>}
        {(editor.kind === 'session' || editor.kind === 'assignment') && <label>Course section<input maxLength={160} placeholder="Optional topic or course section" value={editor.section || ''} onChange={event => change({ section: event.target.value })} /></label>}
        {editor.kind === 'session' && <div className="learning-class-columns"><label>Starts at (your local time)<input required type="datetime-local" value={editor.starts_at} onChange={event => change({ starts_at: event.target.value })} /></label><label>Ends at (your local time)<input required type="datetime-local" value={editor.ends_at} onChange={event => change({ ends_at: event.target.value })} /></label></div>}
        {editor.kind === 'assignment' && <>
          <label>Instructions<textarea aria-label="Instructions" required rows={7} maxLength={20000} value={editor.instructions || ''} onChange={event => change({ instructions: event.target.value })} /></label>
          <label>Learning material<select aria-label="Learning material" value={editor.resource_type} onChange={event => change({ resource_type: event.target.value as ResourceType, resource_id: '', minimum_score_percent: 0 })}><option value="none">Written homework without a linked resource</option><option value="book">Reading material</option><option value="lesson">Interactive lesson</option><option value="quiz">Published quiz</option></select></label>
          {editor.resource_type !== 'none' && <label>Choose material<select aria-label="Choose material" required value={editor.resource_id} onChange={event => change({ resource_id: event.target.value })}><option value="">Select material</option>{assignmentResourceOptions(resources, editor.resource_type || 'none').map(resource => <option key={resource.id} value={resource.id}>{resource.title}</option>)}</select><small>Lessons and quizzes must be published in this folder. Their assigned version is recorded.</small></label>}
          <label className="learning-class-check"><input type="checkbox" checked={editor.required !== false} onChange={event => change({ required: event.target.checked })} />Required for course completion</label>
          {editor.resource_type === 'quiz' && <label>Minimum quiz score for completion (%)<input aria-label="Minimum quiz score for completion (%)" type="number" min={0} max={100} step="any" value={editor.minimum_score_percent ?? 0} onChange={event => change({ minimum_score_percent: Number(event.target.value) })} /><small>Automatic quiz marking stays active. A teacher reviews overall course completion before issuing a certificate.</small></label>}
          <label>Due date (your local time)<input type="datetime-local" value={editor.due_at || ''} onChange={event => change({ due_at: event.target.value })} /></label>
          <label className="learning-class-check"><input type="checkbox" checked={!!editor.allow_late} onChange={event => change({ allow_late: event.target.checked })} />Allow late submissions</label>
        </>}
      </fieldset><footer><button type="submit" className="learning-primary" disabled={busy || !editor.title.trim()}>{busy ? 'Saving…' : editor.id ? 'Save changes' : 'Create'}</button></footer>
    </form> : reviewAssignment && selected ? <div>
      <header><div><p className="learning-class-eyebrow">TEACHER FEEDBACK</p><h2>{reviewAssignment.title}</h2></div><button type="button" disabled={busy} onClick={() => setReviewAssignment(null)}>Back to assignments</button></header>
      {!submissions.length && <p>No learners have submitted work yet.</p>}
      {submissions.map(item => {
        const draft = feedback[item.id] || { text: '', mark: '', maxMark: '' };
        return <form key={item.id} className="learning-class-card" onSubmit={event => { event.preventDefault(); void action(async () => {
          const mark = draft.mark.trim() ? Number(draft.mark) : null, maxMark = draft.maxMark.trim() ? Number(draft.maxMark) : null;
          if ((mark !== null && !Number.isFinite(mark)) || (maxMark !== null && !Number.isFinite(maxMark))) throw new Error('Enter finite marks.');
          await api(`/classes/${selected.id}/assignments/${reviewAssignment.id}/submissions/${item.id}/feedback`, 'PUT', { feedback: draft.text, mark, max_mark: maxMark, expected_revision: item.revision });
          await review(reviewAssignment); setNotice('Teacher feedback saved.');
        }); }}>
          <h3>{learningUserName(item)}</h3><p className="learning-muted">Submitted {displayDate(item.submitted_at)}</p><div className="learning-class-work">{item.text}</div>
          {item.assignment_revision !== undefined && item.assignment_revision !== reviewAssignment.revision && <div className="learning-class-feedback"><p>This work was submitted against an earlier assignment revision. Review the original instructions before giving feedback.</p><details><summary>Original assignment instructions</summary><LessonContent text={item.assignment_snapshot?.instructions || 'No original instructions available.'} /></details></div>}
          <fieldset disabled={busy || !!selected.archived}><label>Teacher feedback<textarea aria-label="Teacher feedback" required maxLength={10000} rows={4} value={draft.text} onChange={event => setFeedback(previous => ({ ...previous, [item.id]: { ...draft, text: event.target.value } }))} /></label>
            <div className="learning-class-columns"><label>Mark (optional)<input type="number" step="any" min={0} value={draft.mark} onChange={event => setFeedback(previous => ({ ...previous, [item.id]: { ...draft, mark: event.target.value } }))} /></label><label>Maximum mark<input type="number" step="any" min={0.01} value={draft.maxMark} onChange={event => setFeedback(previous => ({ ...previous, [item.id]: { ...draft, maxMark: event.target.value } }))} /></label></div>
          </fieldset><button type="submit" className="learning-primary" disabled={busy || !!selected.archived || !draft.text.trim()}>Return feedback</button>
        </form>;
      })}
    </div> : selected ? <>
      <header className="learning-class-header"><div><button className="learning-text-button" disabled={busy} onClick={() => { detailRequest.current += 1; setSelected(null); setReviewAssignment(null); }}>← All classes</button><p className="learning-class-eyebrow">{selected.archived ? 'ARCHIVED CLASS' : 'HUMAN-LED CLASSROOM'}</p><h2>{selected.title}</h2><p>{selected.description}</p><p className="learning-class-lead">Lead teacher: {selected.teacher_display_name || 'Assigned teacher'}</p></div>{selected.can_manage && <button disabled={busy} onClick={() => setEditor({ kind: 'class', ...selected })}>Edit class</button>}</header>
      {selected.can_delete && <button type="button" className="learning-button-danger" disabled={busy} onClick={() => setDeleting(selected)}>Delete class</button>}
      {selected.archived && <div className="learning-class-feedback">This class is archived. Its materials and returned feedback remain available; a teacher must reopen it to accept changes.</div>}
      <nav className="learning-class-tabs" aria-label="Class sections">{(['overview', 'calendar', 'assignments', 'completion', ...(selected.can_manage ? ['members'] : [])] as const).map(value => <button key={value} aria-current={tab === value ? 'page' : undefined} className={tab === value ? 'active' : ''} disabled={busy} onClick={() => setTab(value as typeof tab)}>{value === 'overview' ? 'Announcements' : value === 'calendar' ? 'Class calendar' : value === 'assignments' ? 'Assignments' : value === 'completion' ? (selected.can_manage ? 'Learner progress' : 'Course completion') : 'Class members'}</button>)}</nav>
      {tab === 'completion' && <LearningCourseCompletion classId={selected.id} canManage={selected.can_manage} />}
      {tab === 'overview' && <div><div className="learning-class-section-header"><h3>Announcements</h3>{selected.can_manage && !selected.archived && <button className="learning-primary" disabled={busy} onClick={() => create('announcement')}>Add announcement</button>}</div>{!announcements.length && <p>No announcements yet.</p>}{announcements.map(item => <article key={item.id} className="learning-class-card"><header><h3>{item.title}</h3>{selected.can_manage && <button disabled={busy || !!selected.archived} onClick={() => setEditor({ kind: 'announcement', ...item })}>Edit announcement</button>}</header>{item.created_at && <p className="learning-muted">{displayDate(item.created_at)}</p>}<LessonContent text={item.body} /></article>)}</div>}
      {tab === 'calendar' && <div><div className="learning-class-section-header"><h3>Class sessions</h3>{selected.can_manage && !selected.archived && <button className="learning-primary" disabled={busy} onClick={() => create('session')}>Schedule a session</button>}</div>{!sessions.length && <p>No class sessions scheduled.</p>}{[...sessions].sort((a, b) => a.starts_at.localeCompare(b.starts_at)).map(item => <article key={item.id} className="learning-class-card"><header><div><p className="learning-class-eyebrow">{item.section || 'CLASS SESSION'}</p><h3>{item.title}</h3></div>{selected.can_manage && <button disabled={busy || !!selected.archived} onClick={() => setEditor({ kind: 'session', ...item, starts_at: localClassDate(item.starts_at), ends_at: localClassDate(item.ends_at) })}>Edit session</button>}</header><p><time dateTime={item.starts_at}>{displayDate(item.starts_at)}</time> – <time dateTime={item.ends_at}>{displayDate(item.ends_at)}</time></p><LessonContent text={item.description} /></article>)}
        {assignments.some(item => item.due_at) && <><h3>Assignment deadlines</h3>{assignments.filter(item => item.due_at).sort((a, b) => a.due_at!.localeCompare(b.due_at!)).map(item => <article key={item.id} className="learning-class-card"><h4>{item.title}</h4><p><time dateTime={item.due_at!}>{displayDate(item.due_at!)}</time></p><button onClick={() => setTab('assignments')}>View assignments</button></article>)}</>}
      </div>}
      {tab === 'assignments' && <div><div className="learning-class-section-header"><h3>Assignments</h3>{selected.can_manage && !selected.archived && <button className="learning-primary" disabled={busy} onClick={() => create('assignment')}>Create assignment</button>}</div>{!assignments.length && <p>{selected.can_manage ? 'Assign reading, an existing interactive lesson, a quiz, or written homework.' : 'Your teacher has not added assignments yet.'}</p>}{assignments.map(item => <article key={item.id} className="learning-class-card"><header><div><p className="learning-class-eyebrow">{item.section || 'ASSIGNMENT'}</p><h3>{item.title}</h3></div>{selected.can_manage && <button disabled={busy || !!selected.archived} onClick={() => setEditor({ kind: 'assignment', ...item, due_at: localClassDate(item.due_at), resource_id: item.resource_id || '' })}>Edit assignment</button>}</header><LessonContent text={item.instructions} />
        <p className="learning-muted">{item.required !== false ? 'Required for course completion. ' : 'Optional assignment. '}{item.resource_type === 'quiz' && item.minimum_score_percent > 0 ? `Minimum quiz score: ${item.minimum_score_percent}%. ` : ''}{item.due_at ? `Due ${displayDate(item.due_at)}. ${item.allow_late ? 'Late submissions allowed.' : 'Submissions close at the deadline.'}` : 'No deadline.'}{item.resource_version ? ` Assigned material version ${item.resource_version}.` : ''}</p>
        {item.resource_type !== 'none' && item.resource_id && <button onClick={() => onOpenResource ? onOpenResource(item.resource_type as 'book' | 'lesson' | 'quiz', item.resource_id!) : window.location.assign(item.resource_type === 'lesson' ? `/learning/folders/${folderId}?tab=lessons&lesson=${item.resource_id}` : `/learning/folders/${folderId}/${item.resource_type === 'book' ? 'books' : 'quizzes'}/${item.resource_id}`)}>Open assigned {item.resource_type}</button>}
        {!selected.can_manage && item.resource_type === 'quiz' && <p className="learning-muted">Your quiz answers and marks are recorded automatically when you complete the quiz. Send written notes here only if your teacher asks for them.</p>}
        {!selected.can_manage && item.resource_type === 'lesson' && <p className="learning-muted">Your progress is saved in the interactive lesson. Your teacher can also ask for written work or reflection here.</p>}
        {selected.can_manage ? <div className="learning-class-actions"><span>{item.submission_count ?? 0} submitted</span><button disabled={busy} onClick={() => void action(() => review(item))}>Review learner work</button></div> : <>
          {item.my_submission?.reviewed_at ? <div className="learning-class-feedback"><h4>Teacher feedback</h4><p className="learning-class-work">{item.my_submission.feedback}</p>{item.my_submission.mark != null && <p>Mark: {item.my_submission.mark}{item.my_submission.max_mark != null ? ` / ${item.my_submission.max_mark}` : ''}</p>}<details><summary>Your submitted work</summary><p className="learning-class-work">{item.my_submission.text}</p></details></div> : <form onSubmit={event => { event.preventDefault(); void action(async () => {
            await api(`/classes/${selected.id}/assignments/${item.id}/submit`, 'POST', { text: work[item.id] || '', expected_revision: item.revision }); await open(selected.id); setNotice('Your work was submitted to your teacher.');
          }); }}><label>{item.my_submission ? 'Your submitted work (editable until reviewed)' : 'Your work or completion notes'}<textarea aria-label={item.my_submission ? 'Your submitted work (editable until reviewed)' : 'Your work or completion notes'} required maxLength={50000} rows={5} disabled={busy || !!selected.archived} value={work[item.id] || ''} onChange={event => setWork(previous => ({ ...previous, [item.id]: event.target.value }))} /></label><button type="submit" className="learning-primary" disabled={busy || !!selected.archived || !work[item.id]?.trim()}>{item.my_submission ? 'Update submission' : 'Submit work'}</button>{item.my_submission && <p className="learning-muted">Submitted {displayDate(item.my_submission.submitted_at)}. Awaiting teacher feedback.</p>}</form>}
        </>}
      </article>)}</div>}
      {tab === 'members' && selected.can_manage && <div><header><div><h3>Class members</h3><p>Select learners who already have access to this folder.</p></div><span>{members.length} enrolled</span></header><p className="learning-muted">Only users already provisioned through verified sign-in are listed. Enrolment does not grant folder access.</p>{!candidates.length && <p>No eligible learners were found. An administrator must grant folder access first.</p>}<fieldset disabled={busy || !!selected.archived}>{[...candidates, ...members.filter(member => !candidates.some(candidate => candidate.username === member.username))].map(person => <label key={person.username} className="learning-class-check"><input type="checkbox" checked={roster.includes(person.username)} disabled={!candidates.some(candidate => candidate.username === person.username) && !roster.includes(person.username)} onChange={event => { setRosterDirty(true); setRoster(previous => event.target.checked ? [...previous, person.username] : previous.filter(id => id !== person.username)); }} />{learningUserName(person)}{!candidates.some(candidate => candidate.username === person.username) && ' (folder access unavailable)'}</label>)}</fieldset><button className="learning-primary" disabled={busy || !!selected.archived || !rosterDirty} onClick={() => void action(async () => { await api(`/classes/${selected.id}/members`, 'PUT', { usernames: roster }); await open(selected.id); setNotice('Class roster saved.'); })}>Save class members</button></div>}
    </> : !loading && <>
      <header><div><h2>Classes</h2><p>Teacher-led lessons, assignments, and feedback in one place.</p></div>{canCreate && <button className="learning-primary" disabled={busy} onClick={() => create('class')}>Create class</button>}</header>
      {!classes.length && <div className="learning-class-empty"><h3>{canCreate ? 'Create your first class' : 'No classes assigned yet'}</h3><p>{canCreate ? 'Reuse your books, interactive lessons, and quizzes. Add a roster and publish your own class instructions.' : 'Your teacher will add you to a class in this folder.'}</p></div>}
      <div className="learning-class-grid">{classes.filter(item => `${item.title} ${item.description}`.toLowerCase().includes(search.toLowerCase())).map(item => <article className="learning-class-card" key={item.id}><p className="learning-class-eyebrow">{item.archived ? 'ARCHIVED' : item.can_manage ? 'YOUR CLASS' : 'ENROLLED'}</p><h3>{item.title}</h3><p>{item.description}</p><p className="learning-muted">Lead teacher: {item.teacher_display_name || 'Assigned teacher'}</p><button disabled={busy} onClick={() => void action(async () => { await open(item.id); setTab('overview'); })}>Open class</button>{item.can_delete && <button type="button" className="learning-button-danger" disabled={busy} onClick={() => setDeleting(item)}>Delete class</button>}</article>)}</div>
    </>}
  </section>;
}
