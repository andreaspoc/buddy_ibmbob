import { WorkspaceSectionHeader } from './WorkspaceSectionHeader';
import { t } from "../lib/i18n";
import { appConfirm } from './AppDialog';
import React, { useState, useEffect } from 'react';
import type { A2AAgent } from '../types';

interface AgentEditModalProps {
  agent: A2AAgent | null;
  isOpen: boolean;
  onClose: () => void;
  onSave: (slug: string, updates: Partial<A2AAgent>) => Promise<void>;
  onDelete: (slug: string) => Promise<void>;
}

export const AgentEditModal: React.FC<AgentEditModalProps> = ({
  agent,
  isOpen,
  onClose,
  onSave,
  onDelete,
}) => {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [apiKeyHeader, setApiKeyHeader] = useState('x-api-key');
  const [cardUrl, setCardUrl] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (agent) {
      setName(agent.name || '');
      setDescription(agent.description || '');
      setEndpoint(agent.endpoint || '');
      setApiKey(agent.api_key || '');
      setApiKeyHeader(agent.api_key_header || 'x-api-key');
      setCardUrl(agent.card_url || '');
      setError('');
    }
  }, [agent]);

  if (!isOpen || !agent) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await onSave(agent.slug, {
        name,
        description,
        endpoint,
        api_key: apiKey,
        api_key_header: apiKeyHeader,
        card_url: cardUrl,
      });
      onClose();
    } catch (err: any) {
      setError(err.message || 'Failed to update agent');
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!await appConfirm(`Are you sure you want to delete "${agent.name || agent.slug}"?`)) return;
    setError('');
    setLoading(true);
    try {
      await onDelete(agent.slug);
      onClose();
    } catch (err: any) {
      setError(err.message || 'Failed to delete agent');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-backdrop">
      <button type="button" className="agent-edit-backdrop" aria-label={t("Close")} onClick={onClose} />
      <div
        className="create-dialog buddy-surface agent-edit-dialog"
        style={{ display: 'block', maxWidth: '580px', margin: 'auto' }}
      >
        <form onSubmit={handleSubmit}>
          <WorkspaceSectionHeader compact title={t("Edit A2A Agent")} eyebrow={t("A2A AGENT CONFIGURATION")} actions={<button
              type="button"
              className="dialog-close"
              onClick={onClose}
              aria-label={t("Close")}
            >
              ×
            </button>} />
          <p className="dialog-intro">
            {t("Update the endpoint URL, display settings, and API authentication for this agent.")}</p>

          <label>
            {t("Agent Identifier (Slug)")}<input
              value={agent.slug}
              readOnly
              style={{ opacity: 0.7, cursor: 'not-allowed' }}
            />
          </label>

          <label>
            {t("Display Name")}<input
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              placeholder={t("Kubernetes Guy")}
            />
          </label>

          <label>
            {t("Description")}<textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              placeholder={t("What does this agent do?")}
            />
          </label>

          <label>
            {t("JSON-RPC Endpoint URL")}<input
              type="url"
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
              required
              placeholder="https://..."
            />
          </label>

          <label>
            {t("API Key (optional)")}<input
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={t("Paste API key (e.g. for Langflow)")} /></label>

          <label>
            {t("API Key Header Name")}<input
              value={apiKeyHeader}
              onChange={(e) => setApiKeyHeader(e.target.value)}
              placeholder="x-api-key"
            />
          </label>

          <label>
            {t("Agent Card URL (optional)")}<input
              type="url"
              value={cardUrl}
              onChange={(e) => setCardUrl(e.target.value)}
              placeholder="https://..."
            />
          </label>

          {error && <div className="form-error" role="alert">{t(error)}</div>}

          <div className="dialog-actions">
            <button
              type="button"
              className="cancel-button"
              onClick={handleDelete}
              disabled={loading}
              style={{
                marginRight: 'auto',
                color: '#ff7875',
                borderColor: 'rgba(255, 120, 117, 0.4)',
              }}
            >
              {t("Delete")}</button>
            <button
              type="button"
              className="cancel-button"
              onClick={onClose}
              disabled={loading}
            >
              {t("Cancel")}</button>
            <button
              type="submit"
              className="save-button"
              disabled={loading}
            >
              {loading ? t("Saving…") : t("Save Changes")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
