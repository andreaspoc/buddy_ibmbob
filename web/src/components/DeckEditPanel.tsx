import { t } from "../lib/i18n";
import React from 'react';
// @ts-ignore
import { textOf, fontSizeOf, boldOf, alignOf, colorOf, normalizeHex, styleOf, xOf, yOf, wOf, hOf } from '../lib/bobdeck.js';

interface Props {
  slide: any;
  selectedIndex: number;
  onSelect: (index: number) => void;
  onChange: (patch: any) => void;
}

export const DeckEditPanel: React.FC<Props> = ({ slide, selectedIndex, onSelect, onChange }) => {
  const elements = slide?.elements || [];
  const index = Math.min(selectedIndex, Math.max(0, elements.length - 1));
  const element = elements[index];
  const style = styleOf(element);
  const changeStyle = (patch: any) => onChange({ style: { ...style, ...patch } });
  const editRows = (rows: any[][], update: (next: any[][]) => void) => (
    <div className="bobdeck-edit-data"><table><tbody>{rows.map((row, ri) => (
      <tr key={ri}>{row.map((value, ci) => <td key={ci}><input
        aria-label={t("Row {0}, column {1}", [ri + 1, ci + 1])} value={String(value)}
        onChange={event => { const next = structuredClone(rows); next[ri][ci] = event.target.value; update(next); }}
      /></td>)}</tr>
    ))}</tbody></table></div>
  );
  return <div className="bobdeck-edit-panel">
    <label>{t("Slide element")}<select aria-label={t("Slide element")} value={index} onChange={event => onSelect(Number(event.target.value))}>
      {elements.map((item: any, i: number) => <option key={i} value={i}>
        {i + 1}. {item.type} {item.type === 'text' ? textOf(item).slice(0, 60) : item.id || ''}
      </option>)}
    </select></label>
    <small>{t("Click text on the slide to select it. Changes appear in the preview and downloads.")}</small>
    {element && <>
      {element.type === 'text' && <>
        <label>{t("Text")}<textarea aria-label={t("Text")} rows={4} value={textOf(element)} onChange={event => onChange({ text: event.target.value, content: event.target.value })} /></label>
        <div className="bobdeck-edit-fields">
          <label>{t("Font size")}<input type="number" min="1" max="200" value={fontSizeOf(element)} onChange={event => { const value = event.target.valueAsNumber; if (value > 0 && value <= 200) onChange({ fontSize: value }); }} /></label>
          <label>{t("Font")}<input value={style.fontFamily || ''} placeholder={t("Theme font")} onChange={event => changeStyle({ fontFamily: event.target.value || undefined })} /></label>
          <label>{t("Color")}<input type="color" value={'#' + normalizeHex(colorOf(element), '1A0A2E')} onChange={event => onChange({ color: event.target.value.slice(1) })} /></label>
          <label>{t("Alignment")}<select value={alignOf(element)} onChange={event => onChange({ align: event.target.value })}>
            <option value="left">{t("Left")}</option><option value="center">{t("Center")}</option><option value="right">{t("Right")}</option>
          </select></label>
          <label>{t("Vertical alignment")}<select value={style.valign || 'mid'} onChange={event => changeStyle({ valign: event.target.value })}>
            <option value="top">{t("Top")}</option><option value="mid">{t("Middle")}</option><option value="bottom">{t("Bottom")}</option>
          </select></label>
          <label className="bobdeck-edit-checkbox"><input type="checkbox" checked={boldOf(element)} onChange={event => onChange({ bold: event.target.checked })} />{t("Bold")}</label>
          <label className="bobdeck-edit-checkbox"><input type="checkbox" checked={style.fontStyle === 'italic'} onChange={event => changeStyle({ fontStyle: event.target.checked ? 'italic' : 'normal' })} />{t("Italic")}</label>
        </div>
      </>}
      <div className="bobdeck-edit-fields">
        {([['x', 'X', xOf(element)], ['y', 'Y', yOf(element)], ['w', t("Width"), wOf(element)], ['h', t("Height"), hOf(element)]] as [string, string, number][]).map(([key, label, value]) => (
          <label key={key}>{label} {t("(in)")}<input type="number" step="0.05" min={key === 'w' || key === 'h' ? 0.01 : 0} value={value}
            onChange={event => { const next = event.target.valueAsNumber; if (Number.isFinite(next) && next >= (key === 'w' || key === 'h' ? 0.01 : 0)) onChange({ [key]: next }); }} /></label>
        ))}
      </div>
      {element.type === 'chart' && <div className="bobdeck-edit-fields">
        {Array.isArray(element.series) && element.series.length ? element.series.map((series: any, si: number) => <fieldset key={si}>
          <legend>{series.name || `Series ${si + 1}`}</legend>
          <label>{t("Series name")}<input value={series.name || ''} onChange={event => { const next = structuredClone(element.series); next[si].name = event.target.value; onChange({ series: next }); }} /></label>
          {(series.values || []).map((value: number, vi: number) => <label key={vi}>{series.labels?.[vi] || element.categories?.[vi] || `Value ${vi + 1}`}
            <input type="number" step="any" value={value} onChange={event => { const value = event.target.valueAsNumber; if (Number.isFinite(value)) { const next = structuredClone(element.series); next[si].values[vi] = value; onChange({ series: next }); } }} />
          </label>)}
        </fieldset>) : (element.data || []).map((item: any, di: number) => <fieldset key={di}>
          <label>{t("Label")}<input value={item.label ?? item.category ?? ''} onChange={event => { const next = structuredClone(element.data); next[di].label = event.target.value; onChange({ data: next }); }} /></label>
          <label>{t("Value")}<input type="number" step="any" value={item.value} onChange={event => { const value = event.target.valueAsNumber; if (Number.isFinite(value)) { const next = structuredClone(element.data); next[di].value = value; onChange({ data: next }); } }} /></label>
        </fieldset>)}
      </div>}
      {element.type === 'table' && editRows(element.rows || [], rows => onChange({ rows }))}
    </>}
  </div>;
};
