import { brandText } from '../lib/brand';
import { useEffect, useRef, useState } from 'react';
import './LearningCourseCompletion.css';

type Requirement = { assignment_id: string; title: string; resource_type: string; resource_version: number | null; completed: boolean; status: string; score?: number | null; max_score?: number | null; minimum_score_percent?: number };
type Certificate = { id: string; recipient_name: string; course_title: string; instructor_name: string; version: number; class_revision: number; issued_at: string; revoked_at: string | null; revocation_reason: string | null; email_status?: string; emailed_at?: string | null; email_recipient?: string | null; email_error?: string | null };
type Completion = { username: string; display_name: string; eligible: boolean; requirements: Requirement[]; evidence_digest: string; certificate: Certificate | null };
type CompletionData = { course: { id: string; title: string; revision: number }; can_manage: boolean; items: Completion[] };

function completionStatus(item: Completion) {
  if (item.certificate && !item.certificate.revoked_at) {
    return item.eligible ? 'Completion approved — certificate issued' : 'New required activities added — existing certificate remains valid';
  }
  return item.eligible ? 'Requirements complete — teacher approval required' : 'Course requirements are not complete';
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api/learning${path}`, { credentials: 'same-origin', ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof body.detail === 'string' ? body.detail : 'Could not update course completion.');
  return body;
}

export default function LearningCourseCompletion({ classId, canManage }: { classId: string; canManage: boolean }) {
  const [data, setData] = useState<CompletionData | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [review, setReview] = useState<Completion | null>(null);
  const [recipient, setRecipient] = useState('');
  const [note, setNote] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [revoke, setRevoke] = useState<Certificate | null>(null);
  const [reason, setReason] = useState('');
  const [previewId, setPreviewId] = useState<string | null>(null);
  const generation = useRef(0);
  const load = async () => {
    const sequence = ++generation.current;
    try {
      const result = await request<CompletionData>(`/classes/${encodeURIComponent(classId)}/completion`);
      if (sequence === generation.current) { setData(result); setError(''); }
    } catch (failure) { if (sequence === generation.current) setError((failure as Error).message); }
  };
  useEffect(() => {
    setData(null); setReview(null); setRevoke(null); setPreviewId(null); setError(''); setNotice('');
    void load();
    return () => { generation.current += 1; };
  }, [classId]); // eslint-disable-line react-hooks/exhaustive-deps
  const approve = async () => {
    if (!data || !review || !confirmed || busy) return;
    const sequence = generation.current;
    setBusy(true); setError(''); setNotice('');
    try {
      await request(`/classes/${encodeURIComponent(classId)}/completions/${encodeURIComponent(review.username)}/approve`, {
        method: 'POST', body: JSON.stringify({ expected_revision: data.course.revision,
          evidence_digest: review.evidence_digest, recipient_name: recipient.trim(), note })
      });
      if (sequence !== generation.current) return;
      setReview(null); setNotice(brandText('Course completion approved. The personalized {{ORGANIZATION}} certificate has been issued.'));
      await load();
    } catch (failure) { if (sequence === generation.current) setError((failure as Error).message); }
    finally { setBusy(false); }
  };
  const claimCertificate = async () => {
    if (busy) return;
    const sequence = generation.current;
    setBusy(true); setError(''); setNotice('');
    try {
      await request(`/classes/${encodeURIComponent(classId)}/completion/claim`, { method: 'POST', body: JSON.stringify({}) });
      if (sequence !== generation.current) return;
      setNotice(brandText('Your {{ORGANIZATION}} course completion certificate has been generated and is ready below.'));
      await load();
    } catch (failure) { if (sequence === generation.current) setError((failure as Error).message); }
    finally { setBusy(false); }
  };
  const sendEmail = async (certId: string) => {
    if (busy) return;
    const sequence = generation.current;
    setBusy(true); setError(''); setNotice('');
    try {
      const res = await request<{ delivery?: { status?: string; recipient?: string; error?: string } }>(`/certificates/${encodeURIComponent(certId)}/send-email`, { method: 'POST', body: JSON.stringify({}) });
      if (sequence !== generation.current) return;
      if (res.delivery?.status === 'sent') {
        setNotice(`Certificate emailed to ${res.delivery.recipient || 'recipient'}.`);
      } else if (res.delivery?.status === 'pending_smtp') {
        setNotice('Certificate is available on the platform. Enable SMTP in Admin settings, then send the certificate again.');
      } else {
        setNotice(res.delivery?.error || 'Email delivery status updated.');
      }
      await load();
    } catch (failure) { if (sequence === generation.current) setError((failure as Error).message); }
    finally { setBusy(false); }
  };
  const revokeCertificate = async () => {
    if (!revoke || !reason.trim() || busy) return;
    const sequence = generation.current;
    setBusy(true); setError(''); setNotice('');
    try {
      await request(`/certificates/${encodeURIComponent(revoke.id)}/revoke`, { method: 'POST', body: JSON.stringify({ reason }) });
      if (sequence !== generation.current) return;
      setRevoke(null); setNotice('Certificate revoked. Its historical record is retained.'); await load();
    } catch (failure) { if (sequence === generation.current) setError((failure as Error).message); }
    finally { setBusy(false); }
  };
  const effectiveCanManage = Boolean(data ? data.can_manage : canManage);
  return <section className="learning-course-completion learning-card" aria-label="Course completion and certificates">
    <div className="learning-section-header"><div><h3>{effectiveCanManage ? 'Learner progress & certificates' : 'Course completion & certificates'}</h3>
      <p className="learning-muted">{effectiveCanManage ? 'Certificates are generated automatically upon completing all course requirements, or you can review and issue them manually below. When SMTP is configured, certificates are also sent by email.' : brandText('Complete the interactive lectures, quizzes, and assignments in this class to earn your personalized {{ORGANIZATION}} certificate on the platform (and by email when SMTP is enabled).')}</p></div>
      <button disabled={busy} onClick={() => void load()}>Refresh completion</button>
    </div>
    {error && <p className="learning-error" role="alert">{error}</p>}
    {notice && <p className="learning-notice" role="status">{notice}</p>}
    {!data && !error && <p role="status">Loading course completion…</p>}
    {data && data.items.length === 0 && <p className="learning-empty">Enroll learners to review course completion.</p>}
    {data?.items.map(item => <article key={item.username} className="learning-completion-person">
      <h4>{effectiveCanManage ? item.display_name : 'Your course completion'}</h4>
      {item.requirements.length > 0 && <p>Required activities completed: {item.requirements.filter(requirement => requirement.completed).length} / {item.requirements.length}</p>}
      <p><strong>{completionStatus(item)}</strong></p>
      {!item.requirements.length && <p className="learning-muted">The teacher must configure at least one required assignment, interactive lecture, or quiz before a certificate can be issued.</p>}
      {!!item.requirements.length && <ul className="learning-completion-requirements">{item.requirements.map(requirement => <li key={requirement.assignment_id}>
        <strong>{requirement.completed ? '✓ ' : '○ '}{requirement.title}</strong><span> — {requirement.status === 'completed' ? 'Complete' : requirement.status}</span>
        {requirement.resource_version != null && <small> · Version {requirement.resource_version}</small>}
        {requirement.score != null && <small> · {requirement.score} / {requirement.max_score} points; required {requirement.minimum_score_percent}%</small>}
      </li>)}</ul>}
      {item.certificate && <div className="learning-certificate-record">
        {item.requirements.length > 0 && <p>Required activities completed: {item.requirements.filter(requirement => requirement.completed).length} / {item.requirements.length}</p>}
      <p><strong>{item.certificate.revoked_at ? 'Certificate revoked' : brandText('{{ORGANIZATION}} certificate issued')}</strong> · {item.certificate.recipient_name} · {new Date(item.certificate.issued_at).toLocaleDateString()}</p>
        {!item.certificate.revoked_at && <p className="learning-muted">
          {item.certificate.email_status === 'sent'
            ? `Email delivery: Sent to ${item.certificate.email_recipient || 'learner'}${item.certificate.emailed_at ? ` on ${new Date(item.certificate.emailed_at).toLocaleString()}` : ''}`
            : item.certificate.email_status === 'failed'
              ? `Email delivery failed (${item.certificate.email_error || 'check SMTP settings'}) — available for download on platform`
              : 'Available on platform · Check email delivery settings or send again'}
        </p>}
        {item.certificate.revoked_at && <p>{item.certificate.revocation_reason}</p>}
        {item.certificate.class_revision !== data.course.revision && <p className="learning-muted">This certificate records an earlier course revision. It retains the original approved completion evidence.</p>}
        <div className="learning-actions">
          <a className="learning-button" href={`/api/learning/certificates/${encodeURIComponent(item.certificate.id)}/download?format=pdf`}>Download certificate PDF</a>
          <a className="learning-button" href={`/api/learning/certificates/${encodeURIComponent(item.certificate.id)}/download?format=html`}>Download printable certificate</a>
          <button type="button" disabled={busy} onClick={() => setPreviewId(previewId === item.certificate!.id ? null : item.certificate!.id)}>{previewId === item.certificate.id ? 'Hide certificate preview' : 'Preview certificate'}</button>
          {!item.certificate.revoked_at && <button type="button" disabled={busy} onClick={() => void sendEmail(item.certificate!.id)}>Send by email</button>}
          {effectiveCanManage && !item.certificate.revoked_at && <button disabled={busy} onClick={() => { setRevoke(item.certificate); setReason(''); }}>Revoke certificate</button>}
        </div>
        {previewId === item.certificate.id && <div style={{ marginTop: 12, border: '1px solid rgba(148,163,184,0.35)', borderRadius: 12, overflow: 'hidden', background: '#fff' }}>
          <iframe
            title={`Certificate preview for ${item.certificate.recipient_name}`}
            src={`/api/learning/certificates/${encodeURIComponent(item.certificate.id)}/download?format=html&inline=1`}
            style={{ width: '100%', height: 520, border: 0, display: 'block' }}
          />
        </div>}
      </div>}
      {!effectiveCanManage && item.eligible && (!item.certificate || item.certificate.revoked_at) && <div className="learning-actions" style={{ marginTop: 8 }}>
        <button className="learning-primary" disabled={busy} onClick={() => void claimCertificate()}>{busy ? 'Generating…' : 'Generate certificate'}</button>
      </div>}
      {effectiveCanManage && (!item.certificate || item.certificate.revoked_at || item.certificate.class_revision !== data.course.revision) && <button className="learning-primary" disabled={!item.eligible || busy} onClick={() => {
        setReview(item); setRecipient(item.display_name === 'Learner' ? '' : item.display_name); setConfirmed(false); setNote(''); setError('');
      }}>Review completion &amp; issue certificate</button>}
    </article>)}
    {review && <section className="learning-certificate-approval" aria-label="Confirm course completion approval">
      <h4>Approve {review.display_name} for {data?.course.title}</h4>
      <p>The certificate records the course title, recipient name, your approval and the current completion evidence. Review the recipient’s name before issuing.</p>
      <label>Recipient’s full name<input value={recipient} maxLength={200} disabled={busy} onChange={event => setRecipient(event.target.value)} /></label>
      <label>Private teacher approval note (optional)<textarea value={note} maxLength={2000} disabled={busy} onChange={event => setNote(event.target.value)} /></label>
      <label><input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)} /> I have reviewed this learner’s course completion and approve issuing the {brandText("{{ORGANIZATION}}")} certificate.</label>
      <div className="learning-actions"><button className="learning-primary" disabled={busy || !confirmed || !recipient.trim()} onClick={() => void approve()}>{busy ? 'Issuing…' : 'Approve completion & issue certificate'}</button><button disabled={busy} onClick={() => setReview(null)}>Cancel approval</button></div>
    </section>}
    {revoke && <section aria-label="Confirm certificate revocation" className="learning-certificate-approval"><h4>Revoke {revoke.recipient_name}’s certificate</h4>
      <label>Reason<textarea maxLength={1000} value={reason} disabled={busy} onChange={event => setReason(event.target.value)} /></label>
      <div className="learning-actions"><button disabled={busy || !reason.trim()} onClick={() => void revokeCertificate()}>Confirm revocation</button><button disabled={busy} onClick={() => setRevoke(null)}>Cancel</button></div>
    </section>}
  </section>;
}
