import { brandText } from '../lib/brand';
import { useEffect, useRef, useState } from 'react';
import './LearningPeopleAdmin.css';

type Person = { username: string; display_name: string; email?: string; is_admin?: boolean };
type AppGroup = { id: string; name: string; description: string; revision: number; member_count?: number; members?: Person[] };
type TeacherRoster = { role: string; revision: number; items: Person[] };

async function adminRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/admin${path}`, { credentials: 'same-origin', ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof body.detail === 'string' ? body.detail : 'Could not update application groups.');
  return body;
}

function PeoplePicker({ people, selected, onChange, disabled, label }: { people: Person[]; selected: string[]; onChange: (value: string[]) => void; disabled: boolean; label: string }) {
  const [search, setSearch] = useState('');
  const filtered = people.filter(person => `${person.display_name} ${person.email || ''}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  return <fieldset className="learning-people-picker"><legend>{label}</legend>
    <label>Find a person<input type="search" value={search} onChange={event => setSearch(event.target.value)} /></label>
    <p className="learning-muted">{selected.length} selected. Only provisioned {brandText("Buddy")} accounts are listed.</p>
    <div className="learning-people-options">{filtered.map(person => <label key={person.username}>
      <input type="checkbox" disabled={disabled} checked={selected.includes(person.username)} onChange={event => onChange(event.target.checked ? [...selected, person.username] : selected.filter(value => value !== person.username))} />
      <span>{person.display_name || 'User'}{person.email && <small>{person.email}</small>}{person.is_admin && <small>Administrator</small>}</span>
    </label>)}{!filtered.length && <p className="learning-muted">No matching accounts.</p>}</div>
  </fieldset>;
}

export default function LearningPeopleAdmin({ onChanged }: { onChanged?: () => void }) {
  const [groups, setGroups] = useState<AppGroup[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [teachers, setTeachers] = useState<TeacherRoster | null>(null);
  const [teacherSelection, setTeacherSelection] = useState<string[]>([]);
  const [group, setGroup] = useState<AppGroup | null>(null);
  const [members, setMembers] = useState<string[]>([]);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [newGroup, setNewGroup] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmTeachers, setConfirmTeachers] = useState(false);
  const [directoryTruncated, setDirectoryTruncated] = useState(false);
  const generation = useRef(0);
  const load = async () => {
    const sequence = ++generation.current;
    setLoading(true); setError('');
    try {
      const [loadedGroups, directory, roster] = await Promise.all([
        adminRequest<{ items: AppGroup[] }>('/app-groups'),
        adminRequest<{ items: Person[]; truncated: boolean }>('/app-groups/directory'),
        adminRequest<TeacherRoster>('/learning-teachers')
      ]);
      if (sequence !== generation.current) return;
      setGroups(loadedGroups.items); setPeople(directory.items); setDirectoryTruncated(directory.truncated);
      setTeachers(roster); setTeacherSelection(roster.items.map(person => person.username));
    } catch (failure) { if (sequence === generation.current) setError((failure as Error).message); }
    finally { if (sequence === generation.current) setLoading(false); }
  };
  useEffect(() => { void load(); return () => { generation.current += 1; }; }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const selectGroup = async (id: string) => {
    setBusy(true); setError(''); setNotice(''); setNewGroup(false); setConfirmDelete(false);
    try {
      const selected = await adminRequest<AppGroup>(`/app-groups/${encodeURIComponent(id)}`);
      setGroup(selected); setName(selected.name); setDescription(selected.description);
      setMembers((selected.members || []).map(person => person.username));
    } catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  };
  const saveGroup = async () => {
    if (busy || !name.trim()) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const selected = await adminRequest<AppGroup>(group ? `/app-groups/${encodeURIComponent(group.id)}` : '/app-groups', {
        method: group ? 'PUT' : 'POST', body: JSON.stringify({ name, description, ...(group ? { expected_revision: group.revision } : {}) })
      });
      setGroup({ ...selected, members: group?.members || [] }); setNewGroup(false);
      await load(); onChanged?.(); setNotice('Application group saved. Add or review its members below.');
    } catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  };
  const saveMembers = async () => {
    if (!group || busy) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const saved = await adminRequest<AppGroup>(`/app-groups/${encodeURIComponent(group.id)}/members`, {
        method: 'PUT', body: JSON.stringify({ expected_revision: group.revision, usernames: members })
      });
      setGroup(saved); await load(); onChanged?.(); setNotice('Group membership saved. Access changes apply to subsequent requests.');
    } catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  };
  const removeGroup = async () => {
    if (!group || busy || !confirmDelete) return;
    setBusy(true); setError(''); setNotice('');
    try {
      await adminRequest(`/app-groups/${encodeURIComponent(group.id)}?expected_revision=${group.revision}`, { method: 'DELETE' });
      setGroup(null); setNewGroup(false); setConfirmDelete(false); await load(); onChanged?.(); setNotice('Application group deleted. Its group-based access grants are removed.');
    } catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  };
  const saveTeachers = async () => {
    if (!teachers || busy || !confirmTeachers) return;
    setBusy(true); setError(''); setNotice('');
    try {
      await adminRequest('/learning-teachers', { method: 'PUT', body: JSON.stringify({ expected_revision: teachers.revision, usernames: teacherSelection }) });
      setConfirmTeachers(false); await load(); onChanged?.(); setNotice('Learning teacher roles saved. Select a lead teacher for each course separately.');
    } catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  };
  return <section className="learning-people-admin" aria-label="Application groups and Learning teachers">
    <div className="learning-people-admin-heading"><div><h3>People, application groups &amp; teachers</h3>
      <p className="learning-muted">Administrators manage {brandText("Buddy")} groups and Learning teacher roles here. No external identity-provider groups are required. Groups organize people; a teacher role permits authoring, and each course has its own lead teacher.</p></div>
      <button disabled={busy || loading} onClick={() => { setGroup(null); setNewGroup(false); void load(); }}>Refresh people and groups</button>
    </div>
    {error && <p className="learning-error" role="alert">{error}</p>}{notice && <p className="learning-notice" role="status">{notice}</p>}
    {loading && <p role="status">Loading application groups and teacher roles…</p>}
    {directoryTruncated && <p className="learning-notice">The directory is limited to 5,000 accounts. Contact your administrator before replacing a roster containing accounts outside this list.</p>}
    <div className="learning-people-admin-columns"><section>
      <h4>Application groups</h4><p className="learning-muted">Use these groups for folder access and organizing learners. Membership alone does not grant a teacher role.</p>
      <button disabled={busy} onClick={() => { setGroup(null); setNewGroup(true); setName(''); setDescription(''); setMembers([]); setConfirmDelete(false); }}>Create application group</button>
      <ul className="learning-app-group-list">{groups.map(item => <li key={item.id}><button disabled={busy} onClick={() => void selectGroup(item.id)} aria-pressed={item.id === group?.id}><strong>{item.name}</strong><span>{item.member_count ?? 0} members</span></button></li>)}</ul>
      {!groups.length && !loading && <p className="learning-empty">No application groups yet.</p>}
      {(group || newGroup) && <section className="learning-app-group-editor" aria-label="Edit application group">
        <label>Group name<input value={name} maxLength={160} disabled={busy} onChange={event => setName(event.target.value)} /></label>
        <label>Description<textarea value={description} maxLength={2000} disabled={busy} onChange={event => setDescription(event.target.value)} /></label>
        <button disabled={busy || !name.trim()} onClick={() => void saveGroup()}>{group ? 'Save group details' : 'Save new group'}</button>
        {group && <><PeoplePicker people={people} selected={members} onChange={setMembers} disabled={busy} label={`Members of ${group.name}`} />
          <button className="learning-primary" disabled={busy || directoryTruncated} onClick={() => void saveMembers()}>Save group membership</button>
          <button disabled={busy} onClick={() => setConfirmDelete(true)}>Delete group…</button>
          {confirmDelete && <div className="learning-group-delete-confirm" role="group" aria-label="Confirm group deletion"><p>Delete {group.name}? This removes its membership and folder access grants. User accounts and their learning records are retained.</p><button disabled={busy} onClick={() => void removeGroup()}>Confirm group deletion</button><button disabled={busy} onClick={() => setConfirmDelete(false)}>Cancel deletion</button></div>}
        </>}
      </section>}
    </section><section>
      <h4>Learning teachers</h4><p className="learning-muted">Teachers can create learning content and lead assigned courses. Removing this role does not delete their existing content or certificates. Administrators retain their administration permissions.</p>
      <PeoplePicker people={people} selected={teacherSelection} onChange={setTeacherSelection} disabled={busy || loading} label="Accounts assigned the Learning teacher role" />
      <label className="learning-role-confirm"><input type="checkbox" checked={confirmTeachers} disabled={busy} onChange={event => setConfirmTeachers(event.target.checked)} /> I have reviewed the teacher role assignments.</label>
      <button className="learning-primary" disabled={busy || loading || !teachers || !confirmTeachers || directoryTruncated} onClick={() => void saveTeachers()}>Save Learning teacher roles</button>
    </section></div>
  </section>;
}
