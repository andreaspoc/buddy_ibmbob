import { WorkspaceSectionHeader } from './WorkspaceSectionHeader';
import { t } from "../lib/i18n";
import { SlideCountPicker } from './SlideCountPicker';
import React from 'react';

interface DeckFormatChoiceModalProps {
  isOpen: boolean;
  slideCount: number;
  onSlideCountChange: (count: number) => void;
  onClose: () => void;
  onChoosePptx: () => void;
  onChooseHtml: () => void;
}

export const DeckFormatChoiceModal: React.FC<DeckFormatChoiceModalProps> = ({
  isOpen,
  slideCount,
  onSlideCountChange,
  onClose,
  onChoosePptx,
  onChooseHtml,
}) => {
  if (!isOpen) return null;

  return (
    <div className="modal-backdrop" style={{ zIndex: 99999 }}>
      <button type="button" className="agent-edit-backdrop" aria-label={t("Close")} onClick={onClose} />
      <div
        className="presentation-modal-card format-choice-card buddy-surface agent-edit-dialog"
      >
        <WorkspaceSectionHeader compact title={t("Choose Presentation Format")} eyebrow={t("PRESENTATION STUDIO")} actions={<button
            type="button"
            className="dialog-close"
            onClick={onClose}
            aria-label={t("Close")}
          >
            ×
          </button>} />

        <p className="dialog-intro">
          {t("Select how you would like Buddy to build your executive deck:")}</p>

        <SlideCountPicker value={slideCount} onChange={onSlideCountChange} />

        <div className="format-choice-grid">
          {/* OPTION 1: POWERPOINT */}
          <div
            className="format-card format-card-pptx"
            onClick={() => {
              onChoosePptx();
              onClose();
            }}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === ' ') {
                onChoosePptx();
                onClose();
              }
            }}
          >
            <div>
              <div className="format-card-icon" aria-hidden="true">📊</div>
              <h3 className="format-card-title">{t("PowerPoint (.pptx)")}</h3>
              <span className="format-card-subtitle">
                {t("Standard BobDeck Template")}</span>
              <p className="format-card-desc">
                {t("Generates a 16:9 executive presentation ready for Microsoft PowerPoint &amp; ONLYOFFICE. Includes native Office DrawingML charts, editable in Excel.")}</p>
              <div className="format-feature-tags">
                <span className="format-feature-tag">{t("16:9 Widescreen")}</span>
                <span className="format-feature-tag">{t("Office DrawingML")}</span>
                <span className="format-feature-tag">{t("Excel Editable")}</span>
              </div>
            </div>
            <div className="format-card-btn">
              {t("Generate .bobdeck &amp; PPTX →")}</div>
          </div>

          {/* OPTION 2: INTERACTIVE HTML */}
          <div
            className="format-card format-card-html"
            onClick={() => {
              onChooseHtml();
              onClose();
            }}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === ' ') {
                onChooseHtml();
                onClose();
              }
            }}
          >
            <div>
              <div className="format-card-icon" aria-hidden="true">⚡</div>
              <h3 className="format-card-title">{t("Interactive Web (.html)")}</h3>
              <span className="format-card-subtitle">
                {t("Live Interactive Architecture")}</span>
              <p className="format-card-desc">
                {t("Creates interactive slides with scenario controls, live comparisons, calculators, and clickable drill-downs where useful. Explore the content directly and export as standalone HTML.")}</p>
              <div className="format-feature-tags">
                <span className="format-feature-tag">{t("Interactive slides")}</span>
                <span className="format-feature-tag">{t("Live scenarios")}</span>
                <span className="format-feature-tag">{t("Standalone HTML")}</span>
              </div>
            </div>
            <div className="format-card-btn">
              {t("Generate Live Interactive HTML →")}</div>
          </div>
        </div>
      </div>
    </div>
  );
};
