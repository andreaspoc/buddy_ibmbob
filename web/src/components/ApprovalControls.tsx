import { Toolbar } from './Toolbar';
import { t } from "../lib/i18n";
import { redactActivity } from '../lib/redaction';
import { TutorialPreference } from './SkillsGuide';
import type { TutorialPreferenceProps } from './SkillsGuide';
import { useState, useEffect, useLayoutEffect, useRef, useId } from 'react';
import { createPortal } from 'react-dom';
import type { ApprovalPolicy, ActionApproval } from '../types';

import { fetchApprovalRuntime, type ApprovalRuntime } from '../lib/approvalRuntime';
import { DEFAULT_APPROVAL_POLICY, APPROVAL_ACTIONS } from '../lib/approvalPolicy';

export function ApprovalPolicyPicker({ policy, onChange, disabled, unavailableReason }: {
  policy: ApprovalPolicy; onChange: (policy: ApprovalPolicy) => void; disabled: boolean; unavailableReason?: string;
}) {
  const idPrefix = useId();
  return <section className={`approval-policy approval-policy-${policy.mode}`} aria-label={t("Agent approval settings")}>
    <div className="approval-policy-header">
      <span className="approval-policy-icon" aria-hidden="true">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6l-8-3Z" /><path d="m8.5 12 2.5 2.5 4.5-5" />
        </svg>
      </span>
      <div className="approval-policy-heading"><strong>{t("Approval settings")}</strong>
        <span>{t("Tools are approved automatically unless you choose processes to review.")}</span>
      </div>
      <select aria-label={t("Approval policy")} value={policy.mode} disabled={disabled}
        onChange={event => onChange({ ...policy, mode: event.target.value as ApprovalPolicy['mode'] })}>
        <option value="auto">{t("Auto-approve everything")}</option>
        <option value="selected">{t("Choose processes to review")}</option>
      </select>
    </div>
    {unavailableReason && <p className="approval-policy-unavailable" role="status">{t(unavailableReason)}</p>}
    {policy.mode === 'selected' && <details className="approval-policy-details" open>
      <summary><span>{t("Choose processes to auto-approve")}</span></summary>
      <fieldset disabled={disabled}>
        <legend className="sr-only">{t("Automatically approve these processes")}</legend>
        {APPROVAL_ACTIONS.map(([id, label, description]) => <label className="approval-action-option" key={id} htmlFor={`${idPrefix}-${id}`}>
          <span className="sr-only">Process: </span><input id={`${idPrefix}-${id}`} type="checkbox" checked={!policy.actions.includes(id)} onChange={event => onChange({
            ...policy, actions: event.target.checked ? policy.actions.filter(action => action !== id) : [...policy.actions, id],
          })} /><span><strong>{t(label)}</strong><small>{t(description || "")}</small></span>
        </label>)}
      </fieldset>
      <p>{t("Checked processes are approved automatically. Uncheck a process to require review.")}</p>
    </details>}
  </section>;
}

export function ApprovalCard({ approval, onDecide, disabled }: {
  approval: ActionApproval; onDecide: (approval: ActionApproval, decision: 'approve' | 'approve_task' | 'reject') => Promise<void>; disabled: boolean;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const decide = async (decision: 'approve' | 'approve_task' | 'reject') => {
    setPending(true); setError('');
    try { await onDecide(approval, decision); }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not submit decision'); }
    finally { setPending(false); }
  };
  return <section className={`approval-card approval-card-${approval.status}`} aria-label={t("Action approval")}>
    <div className="approval-card-heading"><span className="approval-card-dot" aria-hidden="true" />
      <strong>{approval.status === 'pending' ? (disabled ? t("Action no longer awaiting review") : t("Your approval is needed")) : approval.status === 'approved' ? (approval.scope === 'task' ? t("Approved for this task") : t("Action approved")) : t("Action rejected")}</strong>
      {pending && <span>{t("Submitting…")}</span>}
    </div>
    <p className="approval-card-title">{redactActivity(approval.title)}</p>
    {approval.detail != null && <details className="approval-card-details"><summary>{t("Review action details")}</summary>
      <pre>{typeof approval.detail === 'string' ? redactActivity(approval.detail) : JSON.stringify(redactActivity(approval.detail), null, 2)}</pre>
    </details>}
    {approval.status === 'pending' && <div className="approval-card-actions">
      <span>{t("Approval applies only to this exact action and expires after five minutes.")}</span>
      <button type="button" className="approval-reject" disabled={disabled || pending} onClick={() => void decide('reject')}>{t(approval.personal_data?.length ? "Don't send" : "Reject")}</button>
      <button type="button" className="approval-approve" disabled={disabled || pending} onClick={() => void decide('approve')}>{t(approval.personal_data?.length ? "Send anyway" : "Approve once")}</button>
    </div>}
    {error && <p className="approval-card-error" role="alert">{t(error)}</p>}
  </section>;
}

export function ApprovalSettingsMenu({ policy, onChange, disabled, status, error, onExplain, unavailableReason, inline = false }: {
  policy: ApprovalPolicy; onChange: (policy: ApprovalPolicy) => void; disabled: boolean; status?: string; error?: string; onExplain?: () => void; unavailableReason?: string; inline?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState({ left: 12, top: 12, width: 300, maxHeight: 300 });
  useLayoutEffect(() => {
    if (!open) return;
    const position = () => {
      const anchor = triggerRef.current?.getBoundingClientRect();
      if (!anchor) return;
      const viewport = window.visualViewport;
      const leftEdge = (viewport?.offsetLeft ?? 0) + 12;
      const topEdge = (viewport?.offsetTop ?? 0) + 12;
      const width = Math.min(520, (viewport?.width ?? innerWidth) - 24);
      const bottomEdge = topEdge + (viewport?.height ?? innerHeight) - 24;
      const below = bottomEdge - anchor.bottom - 8;
      const above = anchor.top - 8 - topEdge;
      const useAbove = below < 160 && above > below;
      const maxHeight = Math.max(0, useAbove ? above : below);
      const top = useAbove ? Math.max(topEdge, anchor.top - 8 - Math.min((panelRef.current?.scrollHeight ?? maxHeight) * (Number(getComputedStyle(document.documentElement).getPropertyValue('--ui-scale')) || 1), maxHeight)) : Math.max(topEdge, anchor.bottom + 8);
      const scale = Number(getComputedStyle(document.documentElement).getPropertyValue('--ui-scale')) || 1;
      setPlacement({ left: Math.max(leftEdge, Math.min(anchor.left, leftEdge + (viewport?.width ?? innerWidth) - 24 - width)) / scale, top: top / scale, width: width / scale, maxHeight: maxHeight / scale });
    };
    position();
    panelRef.current?.querySelector<HTMLSelectElement>('select')?.focus();
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    window.visualViewport?.addEventListener('resize', position);
    window.visualViewport?.addEventListener('scroll', position);
    return () => {
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', position, true);
      window.visualViewport?.removeEventListener('resize', position);
      window.visualViewport?.removeEventListener('scroll', position);
    };
  }, [open]);
  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node) && !panelRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && open) { setOpen(false); triggerRef.current?.focus(); }
    };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => { document.removeEventListener('pointerdown', closeOutside); document.removeEventListener('keydown', closeOnEscape); };
  }, [open]);
  if (inline) return <div className="approval-inline">
    <ApprovalPolicyPicker policy={policy} onChange={onChange} disabled={disabled} unavailableReason={unavailableReason} />
    {status && <small role="status">{status}</small>}{error && <small role="alert">{t(error)}</small>}
    <button type="button" data-keep-open disabled={disabled} onClick={() => onChange({mode:'selected', actions: APPROVAL_ACTIONS.map(([id]) => id)})}>{t("Ask before all processes")}</button>
    {onExplain && <button type="button" onClick={onExplain}>{t("How approvals work")}</button>}
  </div>;
  return <div className="approval-settings-menu" ref={menuRef}>
    <button type="button" className="approval-settings-trigger" ref={triggerRef} aria-label={t("Approval settings")}
      aria-expanded={open} onClick={() => setOpen(value => !value)}>
      {t("Approvals")}<span>{policy.mode === 'auto' ? t("Auto") : t("Custom")}</span><span aria-hidden="true">⌄</span>
    </button>
    {status && <small className="approval-runtime-status" role="status">{status}</small>}
    {error && <small className="approval-card-error" role="alert">{t(error)}</small>}
    {open && createPortal(<Toolbar menu ref={panelRef} className="approval-settings-panel" style={placement}>
      <ApprovalPolicyPicker policy={policy} onChange={onChange} disabled={disabled} unavailableReason={unavailableReason} />
      <div className="approval-policy-presets"><button type="button" disabled={disabled} onClick={() => onChange({mode:'selected', actions: APPROVAL_ACTIONS.map(([id]) => id)})}>{t("Ask before all processes")}</button>{onExplain && <button type="button" onClick={onExplain}>{t("How approvals work")}</button>}</div>
    </Toolbar>, document.body)}
  </div>;
}

/** Changes the worker's durable policy, including permissions already waiting. */
export function RuntimeApprovalSettings({ jobId, onPolicyChange, onExplain, inline = false }: {
  jobId: string; onPolicyChange?: (policy: ApprovalPolicy) => void; onExplain?: () => void; inline?: boolean;
}) {
  const [runtime, setRuntime] = useState<ApprovalRuntime | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('Loading task approvals…');
  const changing = useRef(false);
  const revision = useRef(-1);
  const callback = useRef(onPolicyChange);
  callback.current = onPolicyChange;
  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    revision.current = -1;
    setRuntime(null); setError(''); setStatus('Loading task approvals…');
    const accept = (next: ApprovalRuntime) => {
      if (disposed || changing.current || next.revision < revision.current) return;
      revision.current = next.revision;
      callback.current?.(next.policy);
      setError('');
      setRuntime(previous => !previous || next.revision >= previous.revision ? next : previous);
      setStatus(next.mutable ? 'Changes apply to this task and future actions' : (next.reason || 'This task cannot change approvals while running.'));
    };
    const load = async () => {
      try { accept(await fetchApprovalRuntime(jobId, undefined, controller.signal)); }
      catch (err) { if (!disposed) {setError(err instanceof Error ? err.message : 'Could not load task approvals.');setStatus('');} }
    };
    void load();
    const timer = setInterval(() => { if (!changing.current) void load(); }, 5000);
    const update = (event: Event) => {
      const detail = (event as CustomEvent<ApprovalRuntime & {job_id: string}>).detail;
      if (detail?.job_id === jobId) accept(detail);
    };
    window.addEventListener('buddy-approval-policy', update);
    return () => { disposed = true; controller.abort(); clearInterval(timer); window.removeEventListener('buddy-approval-policy', update); };
  }, [jobId]);
  const change = async (policy: ApprovalPolicy) => {
    if (changing.current || !runtime?.mutable) return;
    changing.current = true; setBusy(true); setError(''); setStatus('Applying task approval settings…');
    try {
      const next = await fetchApprovalRuntime(jobId, policy);
      revision.current = next.revision;
      setRuntime(next); callback.current?.(next.policy);
      setStatus('Applied to this task · future actions use these settings');
      window.dispatchEvent(new CustomEvent('buddy-approval-policy', { detail: {...next, job_id:jobId} }));
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not update task approvals.'); setStatus('Settings were not changed.'); }
    finally { changing.current = false; setBusy(false); }
  };
  return <ApprovalSettingsMenu inline={inline} policy={runtime?.policy || DEFAULT_APPROVAL_POLICY} onChange={policy => void change(policy)}
    disabled={busy || !runtime?.mutable} status={status} error={t(error)} unavailableReason={runtime && !runtime.mutable ? runtime.reason || undefined : undefined} onExplain={onExplain} />;
}

export function ApprovalGuide({ onClose, policy, ...tutorialProps }: {onClose: () => void; policy: ApprovalPolicy} & TutorialPreferenceProps) {
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => { closeButton.current?.focus({preventScroll:true}); }, []);
  return <section className="approval-guide" role="dialog" aria-labelledby="approval-guide-title" onKeyDown={event => {if (event.key === "Escape" && !tutorialProps.tutorialSaving) onClose();}}>
    <button ref={closeButton} type="button" disabled={tutorialProps.tutorialSaving} className="approval-guide-close" aria-label={t("Close approval guide")} onClick={onClose}>×</button>
    <strong id="approval-guide-title">{t("You control approvals")}</strong>
    <p><b>{t("Auto-approve is enabled by default.")}</b> {t("Buddy continues without pausing for each action. You can change this whenever you want using")}<b>{t("Approvals")}</b>.</p>
    {policy.mode !== 'auto' && <p>{t("Your saved settings currently require review for some processes.")}</p>}
    <p><b>{t("Choose processes")}</b> {t("lets you auto-approve file changes or other categories and keep review for the rest. Uncheck a process to make Buddy ask first.")}</p>
    <p>{t("While a task runs, open")}<b>{t("Approvals")}</b> {t("here or in its task details to switch auto-approval on or off. Changes affect waiting and future actions; work already done stays done.")}</p>
    <p><b>{t("Approve once")}</b> {t("allows one action.")}{t("Select Auto-approve everything to allow waiting and future actions in this task.")}</p>
    <TutorialPreference {...tutorialProps} />
    <button type="button" disabled={tutorialProps.tutorialSaving} onClick={onClose}>{t("Got it")}</button>
  </section>;
}
