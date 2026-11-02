import { t } from "../lib/i18n";
export function SlideCountPicker({ value, onChange, disabled = false }: { value: number; onChange: (count: number) => void; disabled?: boolean }) {
  return <label className="slide-count-picker">
    {t("Number of slides")}<select aria-label={t("Number of slides")} value={value} onChange={event => onChange(Number(event.target.value))} disabled={disabled}>
      {Array.from({ length: 50 }, (_, index) => index + 1).map(count => <option key={count} value={count}>{count} {count === 1 ? 'slide' : 'slides'}</option>)}
    </select>
    <small>{t("Includes the title and closing slides.")}</small>
  </label>;
}
