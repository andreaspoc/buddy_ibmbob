import './TemplatePickerModal.scss';
import { WorkspaceSectionHeader } from './WorkspaceSectionHeader';
import { t, useLanguage } from "../lib/i18n";
import { SlideCountPicker } from './SlideCountPicker';
import React, { useState, useEffect } from 'react';
import { PresentationTemplateStudio } from './PresentationTemplateStudio';
import type { PresentationTemplate } from '../types';

interface TemplatePickerModalProps {
  isOpen: boolean;
  slideCount: number;
  onSlideCountChange: (count: number) => void;
  templates: PresentationTemplate[];
  selectedTemplateId: string;
  onSelect: (templateId: string) => void;
  prompt: string;
  onPromptChange: (prompt: string) => void;
  format?: 'pptx' | 'html';
  onFormatChange: (format: 'pptx' | 'html') => void;
  onConfirm: () => void;
  onClose: () => void;
  onTemplateSaved?: (template: PresentationTemplate) => void;
  initialStudioOpen?: boolean;
  sessionId?: string;
  onAskBob?: (brief: string) => void;
  bobBusy?: boolean;
}

export const TemplatePickerModal: React.FC<TemplatePickerModalProps> = ({
  isOpen, slideCount, onSlideCountChange, templates, selectedTemplateId,
  onSelect, prompt, onPromptChange, format, onFormatChange, onConfirm, onClose,
  onTemplateSaved, initialStudioOpen = false, sessionId, onAskBob, bobBusy,
}) => {
  useLanguage();
  const [studioOpen, setStudioOpen] = useState(initialStudioOpen);
  useEffect(() => { if (isOpen) setStudioOpen(initialStudioOpen); }, [isOpen, initialStudioOpen]);
  if (!isOpen) return null;
  const selected = templates.find(template => template.id === selectedTemplateId);
  return <div className="modal-backdrop" onClick={onClose} style={{ zIndex: 99999 }}>
    <form className="presentation-modal-card template-picker-card buddy-surface" role="dialog" aria-modal="true" aria-labelledby="presentation-setup-title"
      onClick={event => event.stopPropagation()} onSubmit={event => { event.preventDefault(); if (!studioOpen && selected && format && prompt.trim()) onConfirm(); }}>
      <WorkspaceSectionHeader compact title={studioOpen ? t("Create a reusable template") : t("Set up your presentation")} eyebrow={t("PRESENTATION STUDIO")} titleId="presentation-setup-title" actions={<button type="button" className="dialog-close" onClick={onClose} aria-label={t("Close presentation setup")}>×</button>} />
      {studioOpen ? <PresentationTemplateStudio templates={templates} sessionId={sessionId} onAskBob={onAskBob} bobBusy={bobBusy}
        onCancel={() => setStudioOpen(false)} onSaved={template => { onTemplateSaved?.(template); onSelect(template.id); setStudioOpen(false); }} /> : <>
      <p className="dialog-intro">{t("Choose a template and output format. Your slides will open beside chat as Buddy creates them.")}</p>
 <label className="presentation-request-label">{t("Presentation request")}<textarea aria-label={t("Presentation request")} value={prompt} maxLength={20000} onChange={event => onPromptChange(event.target.value)} placeholder={t("What should the presentation cover?")} required /></label>
      <fieldset className="presentation-output-format"><legend>{t("Output format")}</legend>
        <label><input type="radio" name="presentation-format" checked={format === 'html'} onChange={() => onFormatChange('html')} />{t("Interactive HTML")}</label>
        <label><input type="radio" name="presentation-format" checked={format === 'pptx'} onChange={() => onFormatChange('pptx')} />{t("PowerPoint")}</label>
      </fieldset>
      <SlideCountPicker value={slideCount} onChange={onSlideCountChange} />
      <div className="template-catalog-heading"><h3>{t("Available templates")}</h3>
        <button type="button" onClick={() => setStudioOpen(true)}>{t("Create template")}</button>
      </div>
      {!templates.length && <p role="status">{t("No presentation templates are available. Add a template to the catalog before creating slides.")}</p>}
      <div className="template-grid" role="group" aria-label={t("Presentation templates")}>
        {templates.map(template => <button type="button" key={template.id}
          className={`template-card ${template.id === selectedTemplateId ? 'selected' : ''}`}
          aria-pressed={template.id === selectedTemplateId} onClick={() => onSelect(template.id)}>
          <div className="template-preview" style={{ background: template.titleSlideColors?.background || template.colors.background, color: template.titleSlideColors?.text || template.colors.text }}>
            <div className="template-preview-bar"><span className="template-brand-tag">{template.brand}</span>{template.id === selectedTemplateId && <span className="template-selected-badge">{t("Selected")}</span>}</div>
            <div className="template-title-preview">{template.title}</div>
          </div>
          <div className="template-info">
            <div className="template-header"><strong>{template.title}{template.custom && <small className="template-personal-badge">{t("Saved")}</small>}</strong><span className="template-badge">{template.slidesCount} {t("layouts")}</span></div>
            <div className="template-swatches">{[template.colors.primary, template.colors.secondary, template.colors.accent, template.colors.text].map((color, index) => <span key={index} className="template-swatch" style={{ background: color }} title={color} />)}</div>
            <div className="template-compat-row">{template.fonts.heading} · {template.fonts.body}</div>
          </div>
        </button>)}
      </div>
      <div className="presentation-setup-footer">
        <span>{selected ? selected.title : t("Select a template to continue")}</span>
        <button type="button" onClick={onClose}>{t("Cancel")}</button>
        <button type="submit" disabled={!selected || !format || !prompt.trim()}>{t("Create presentation")}</button>
      </div>
      </>}
    </form>
  </div>;
};
