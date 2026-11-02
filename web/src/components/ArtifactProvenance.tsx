import { t, getLocale } from '../lib/i18n';

export type Provenance = {
  origin?: 'generated' | 'manual' | 'restored'; workspace_id?: string; chat_id?: string;
  path?: string; sha256?: string; job_id?: string; correlation_id?: string;
  user_message_id?: string; assistant_message_id?: string; tool_call_id?: string;
  created_at?: string; timestamp?: string; event_id?: number; restored_from?: string;
  source_provenance?: Provenance | null;
};

export function ArtifactProvenance({ provenance, live = false, dirty = false }: { provenance?: Provenance | null; live?: boolean; dirty?: boolean }) {
  const fields: [string, string | number | undefined][] = provenance ? [
    ['Origin', provenance.origin === 'manual' ? t('Manual edit') : provenance.origin === 'restored' ? t('Restored revision') : live ? t('Live draft') : t('Generated artifact')],
    ['Conversation ID', provenance.chat_id || provenance.workspace_id], ['Job ID', provenance.job_id],
    ['Correlation ID', provenance.correlation_id], ['User message ID', provenance.user_message_id],
    ['Assistant message ID', provenance.assistant_message_id], ['Tool call ID', provenance.tool_call_id],
    ['Content SHA-256', provenance.sha256], ['Event ID', provenance.event_id], ['Restored from SHA-256', provenance.restored_from],
  ] : [];
  const timestamp = provenance?.created_at || provenance?.timestamp;
  return <details className="artifact-provenance" style={{padding: '6px 10px', overflowWrap: 'anywhere'}}>
    <summary>{t('Artifact provenance')}{dirty ? ` · ${t('Unsaved changes')}` : live ? ` · ${t('Live draft')}` : ''}</summary>
    {dirty && <p>{t('These details describe the saved content. Unsaved changes have no recorded provenance yet.')}</p>}
    {!provenance ? <p>{t('No recorded origin is available for this revision.')}</p> : <>
      {timestamp && <p>{t('Recorded at')}: <time dateTime={timestamp}>{new Date(timestamp).toLocaleString(getLocale())}</time></p>}
      <dl style={{margin: 0}}>{fields.filter(([, value]) => value !== undefined && value !== '').map(([label, value]) => <div key={label}><dt style={{fontWeight: 600}}>{t(label)}</dt><dd style={{margin: '0 0 6px'}}><code>{value}</code></dd></div>)}</dl>
      {provenance.source_provenance && <ArtifactProvenance provenance={provenance.source_provenance} />}
    </>}
  </details>;
}
