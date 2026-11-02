import { brandLogoUrl, brandText } from '../lib/brand';
import { Toolbar } from './Toolbar';
import { t, useLanguage } from "../lib/i18n";
import { useEffect, useRef, useState } from 'react';
import './SkillsGuideNotes.css';
import { LanguageSelector } from './LanguageSelector';
import type { Mode, Skill } from '../types';

export interface TutorialPreferenceProps {
  tutorialsDisabled: boolean;
  tutorialSaving: boolean;
  tutorialError: string;
  onTutorialPreference: (disabled: boolean) => Promise<void>;
}
export function TutorialPreference({ tutorialsDisabled, tutorialSaving, tutorialError, onTutorialPreference }: TutorialPreferenceProps) {
  return <><label className="tutorial-preference"><input type="checkbox" checked={tutorialsDisabled} disabled={tutorialSaving} onChange={event => void onTutorialPreference(event.target.checked)} />{t("Don’t show tutorials on future logins")}</label>{tutorialSaving && <p role="status">{t("Saving preference…")}</p>}{tutorialError && <p className="form-error" role="alert">{t(tutorialError)}</p>}</>;
}
function WelcomeBrandMark() {
  return <img className="welcome-brand-mark" src={brandLogoUrl()} width="48" height="48" alt="" aria-hidden="true" />;
}
const screenshots = {
  workspace: { caption: "Your workspace at a glance", instruction: "", alt: "Your workspace at a glance" },
  ask: { caption: "Write your request here", instruction: "Click the highlighted message field, type your request, then press Send.", alt: "Screenshot of the chat composer" },
  guide: { caption: "Choose a mode here", instruction: "Open the highlighted slash menu, then choose a mode.", alt: "Screenshot of mode controls" },
  attach: { caption: "Attach a document here", instruction: "Click the highlighted paperclip, select a document, and wait for preparation.", alt: "Screenshot of document attachment controls" },
  approvals: { caption: "Set your approval policy here", instruction: brandText("Open Buddy, find Approvals, then choose your policy from this menu."), alt: "Screenshot of approval settings" },
  a2a: { caption: "Choose A2A agents for your conversation", instruction: "Switch to A2A agents in the top toolbar. Use Choose agents to select an activated agent, or Manage agents to open the catalogue.", alt: "Screenshot of the A2A conversation workspace" },
  tools: { caption: "Replay the tutorial here", instruction: brandText("Open Buddy, choose Memory & presets, then select Replay welcome tutorial."), alt: brandText("Screenshot of the Buddy menu") },
};
type Chapter = { title: string; text: string; label: string; icon: string; screenshot?: keyof typeof screenshots };
const chapters: Chapter[] = [
  { title: "Meet your new working partner", text: "Turn a question, a document, or an idea into something you can use. Let’s take a quick tour of your workspace.", label: "Welcome", icon: "✦", screenshot: "workspace" },
  { title: "A great result starts with a clear request", text: brandText("Tell Buddy what you need, add the context, and describe the format. Try building a request below—nothing will be sent."), label: "Ask", icon: "↗", screenshot: "ask" },
  { title: brandText("Choose how Buddy works"), text: brandText("Modes shape how Buddy approaches your request. Skills provide instructions for a specific task. You can change either in the chat or sidebar when you need them."), label: "Guide", icon: "◎", screenshot: "guide" },
  { title: "Bring your own context", text: "Attach a document to your conversation, wait for preparation, then ask questions about it. Keep related conversations and files together in a project.", label: "Explore", icon: "▤", screenshot: "attach" },
  { title: "Stay in control", text: "Auto-approve is enabled by default. Open Approval settings to choose which actions need your review. During a task, you can approve one action or the remaining actions for that task.", label: "Control", icon: "✓", screenshot: "approvals" },
  { title: "Keep the ideas worth coming back to", text: brandText("Ask Buddy to make notes from an answer or a search. Save a sticky note and watch it fly to Notes in the top toolbar. Your notes open in their own workspace at /notes."), label: "Notes", icon: "▤" },
  { title: "Your files, ready for the next step", text: brandText("Keep documents, spreadsheets, PDFs, and presentations together in Office Suite. Upload files from your computer, edit with Buddy, or open a presentation on your desktop."), label: "Office Suite", icon: "▦" },
  { title: "Work with A2A agents", text: "A2A agents are separate assistants your administrator makes available. Open Settings → Connections → Add agents to view the catalogue. Activate an agent you can access, then select it for your conversation.", label: "A2A", icon: "↗", screenshot: "a2a" },
  { title: "Your workspace is ready", text: "Would you like to see this tutorial again on future logins? You can always replay it from Memory & presets.", label: "Ready", icon: "✦", screenshot: "tools" },
];
export function SkillsGuide({ saving, error, onDisable, onClose }: {
  skills: Skill[]; modes: Mode[]; selectedMode: string; selectedSkill: string;
  onSkill: (name: string) => void; onMode: (mode: string) => void;
  disabled: boolean; saving: boolean; error: string; onDisable: (disabled: boolean) => Promise<boolean>; onClose: () => void;
}) {
  const language = useLanguage();
  const [step, setStep] = useState(0);
  const [goal, setGoal] = useState("Summarize this document");
  const [format, setFormat] = useState("in five bullet points");
  const [review, setReview] = useState(false);
  const [practiceSaved, setPracticeSaved] = useState(false);
  const [practiceOfficeType, setPracticeOfficeType] = useState("html");
  const [practiceOfficeSaved, setPracticeOfficeSaved] = useState(false);
  const dialog = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const chapter = chapters[step];
  const screenshot = chapter.screenshot ? screenshots[chapter.screenshot] : null;
  const last = step === chapters.length - 1;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  useEffect(() => { heading.current?.focus(); }, [step]);
  const finish = async (disable: boolean) => { if (await onDisable(disable)) onClose(); };
  return <div className="welcome-overlay"><section ref={dialog} tabIndex={-1} className="welcome-tour" lang={language} role="dialog" aria-modal="true" aria-labelledby="skills-guide-title" onKeyDown={event => {
    if (event.key === "Escape" && !saving) setStep(chapters.length - 1);
    if (event.key === "Tab") {
      const controls = dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href]');
      if (!controls?.length) return;
      const first = controls[0], lastControl = controls[controls.length - 1];
      if (event.shiftKey && (document.activeElement === first || !Array.from(controls).includes(document.activeElement as HTMLElement))) { event.preventDefault(); lastControl.focus(); }
      else if (!event.shiftKey && (document.activeElement === lastControl || !Array.from(controls).includes(document.activeElement as HTMLElement))) { event.preventDefault(); first.focus(); }
    }
  }}>
    <Toolbar as="header" className="welcome-top"><div className="welcome-brand"><WelcomeBrandMark /><div><strong><span>{brandText("Buddy")}</span></strong><small>{t("Enterprise AI Workspace")}</small></div></div><span className="welcome-header-label">{t("Your workspace, introduced")}</span><div className="welcome-header-actions"><LanguageSelector />{!last && <button type="button" onClick={() => setStep(chapters.length - 1)}>{t("Skip tour")}</button>}</div></Toolbar>
    <Toolbar as="nav" className="welcome-progress welcome-progress-with-notes" aria-label={t("Tutorial chapters")}>{chapters.map((item, index) => <button type="button" key={item.label} disabled={saving} aria-current={index === step ? 'step' : undefined} onClick={() => setStep(index)}><span>{index < step ? '✓' : `0${index + 1}`}</span>{t(item.label)}</button>)}</Toolbar>
    <div className="welcome-body">
      <div className="welcome-copy"><span className="welcome-eyebrow">{t("A LITTLE TOUR. A LOT OF POSSIBILITIES.")}</span><h1 ref={heading} tabIndex={-1} id="skills-guide-title">{t(chapter.title)}</h1><p>{t(chapter.text)}</p>{!last && <p className="welcome-tip">{t(step === 1 ? "Try changing the goal and format in the practice area." : step === 6 ? "Try the practice controls. No real file is uploaded or saved." : step === 5 ? "Try saving the practice note. Nothing is added to your real collection." : step === 4 ? "Try the review switch in the illustration. Your real settings stay unchanged." : "Explore at your own pace. You can come back anytime.")}</p>}</div>
      <div className="welcome-stage" key={step}>
        <span className="welcome-stage-label">{t("INTERACTIVE PREVIEW · NO TASKS ARE RUN")}</span>
        {step === 0 && <div className="welcome-orbit"><span className="welcome-emblem" aria-hidden="true"><img src={brandLogoUrl()} width="42" height="42" alt="" /></span><span>{t("Ask a question")}</span><span>{t("Explore a document")}</span><span>{t("Create something useful")}</span></div>}
        {step === 1 && <div className="welcome-practice"><label>{t("Your goal")}<input value={goal === "Summarize this document" ? t(goal) : goal} onChange={e => setGoal(e.target.value)} maxLength={160} /></label><label>{t("Your format")}<select value={format} onChange={e => setFormat(e.target.value)}>{["in five bullet points", "as a step-by-step plan", "in a comparison table"].map(value => <option key={value} value={value}>{t(value)}</option>)}</select></label><div className="welcome-request"><span>{t("Your practice request")}</span><p>{goal ? (goal === "Summarize this document" ? t(goal) : goal) : t("Describe your goal")} {t(format)}.</p></div></div>}
        {step === 2 && <div className="welcome-path"><div><span>01</span><strong>{t("Choose your approach")}</strong><p>{t("Pick a mode that suits the work.")}</p></div><div><span>02</span><strong>{t("Add a skill when useful")}</strong><p>{t("Use task-specific guidance when you need it.")}</p></div><div><span>03</span><strong>{t("Make your request")}</strong><p>{t("Your choices guide the next message.")}</p></div></div>}
        {step === 3 && <div className="welcome-path"><div><span>▤</span><strong>{t("Attach your document")}</strong><p>{t("Use the attachment control beside your message.")}</p></div><div><span>◎</span><strong>{t("Wait until it is ready")}</strong><p>{t("Buddy prepares the document for questions.")}</p></div><div className="welcome-request"><p>{t("What are the key takeaways from this document?")}</p></div></div>}
        {step === 4 && <div className="welcome-practice"><span className="welcome-emblem">✓</span><button type="button" className="welcome-review" aria-pressed={review} onClick={() => setReview(!review)}>{t(review ? "Review before acting" : "Auto-approve")} <span>{review ? '●' : '○'}</span></button><p>{t(review ? "Buddy pauses for your decision when an action requires approval." : "Buddy continues without pausing for each action.")}</p><small>{t("Practice only. Change your actual policy in Approval settings.")}</small></div>}
        {step === 5 && <div className="welcome-notes-practice" data-tutorial-notes>
          <div className="welcome-notes-toolbar"><span>{brandText("Buddy")}</span><span className={`welcome-notes-target ${practiceSaved ? 'is-saved' : ''}`} aria-label={t("Notes in the top toolbar")}>▤ {t("Notes")}{practiceSaved && <small>1</small>}</span></div>
          <div className="welcome-notes-request">“{t("Make me notes from your previous answer.")}”</div>
          <div className={`welcome-note-demo ${practiceSaved ? 'is-saved' : ''}`}><small>{t("PRACTICE NOTE")}</small><strong>{t("Keep a useful thought")}</strong><p>{t("A short takeaway, ready when you need it.")}</p><button type="button" onClick={() => setPracticeSaved(true)} disabled={practiceSaved}>{t(practiceSaved ? "Saved to Notes" : "Save to Notes")} {practiceSaved ? '✓' : '↗'}</button></div>
          <p className="welcome-notes-result" role="status">{t(practiceSaved ? "Your practice note has landed. Find real saved notes in the toolbar." : "Click Save to Notes to try the paper-plane animation.")}</p>
          <button className="welcome-notes-replay" type="button" onClick={() => setPracticeSaved(false)}>{t("Try the animation again")}</button>
        </div>}
        {step === 6 && <div className="welcome-practice" data-tutorial-office>
          <label>{t("Choose a practice file")}<select value={practiceOfficeType} onChange={event => { setPracticeOfficeType(event.target.value); setPracticeOfficeSaved(false); }}>
            <option value="docx">{t("Word document (.docx)")}</option><option value="xlsx">{t("Excel workbook (.xlsx)")}</option><option value="pptx">{t("PowerPoint presentation (.pptx)")}</option><option value="pdf">{t("PDF document (.pdf)")}</option><option value="html">{t("HTML presentation (.html)")}</option>
          </select></label>
          <div className="welcome-request"><span>{t("PRACTICE FILE")}</span><p>▤ practice.{practiceOfficeType}</p><button type="button" className="welcome-primary" disabled={practiceOfficeSaved} onClick={() => setPracticeOfficeSaved(true)}>{t(practiceOfficeSaved ? "Practice file saved" : "Save practice file")} {practiceOfficeSaved ? '✓' : '↗'}</button></div>
          <p role="status">{t(practiceOfficeSaved ? "Your practice file is in the library. Real files appear in Office Suite after you save or upload them." : "Choose a file type, then try saving it to the practice library.")}</p>
          <button type="button" onClick={() => setPracticeOfficeSaved(false)}>{t("Reset practice library")}</button><small>{t("Office Suite is available on desktop. It is hidden on mobile.")}</small>
        </div>}
        {step === 7 && <div className="welcome-path" data-tutorial-a2a>
          <div><span>01</span><strong>{t("Open the agent catalogue")}</strong><p>{t("Use Settings → Connections → Add agents, or Manage agents in the A2A agent picker.")}</p></div>
          <div><span>02</span><strong>{t("Activate an available agent")}</strong><p>{t("Choose Activate. Add private credentials only if the agent requires them, then confirm Activate agent. Ask your administrator if no agents are available.")}</p></div>
          <div><span>03</span><strong>{t("Choose who joins the conversation")}</strong><p>{t("Switch to A2A agents, select your activated agent in the picker, and write your request. Nothing is sent until you press Send.")}</p></div>
        </div>}
        {last && <div className="welcome-finish"><span className="welcome-emblem" aria-hidden="true"><img src={brandLogoUrl()} width="42" height="42" alt="" /></span><h2>{t("Make yourself at home")}</h2><button type="button" disabled={saving} className="welcome-primary" onClick={() => void finish(true)}>{t("No, don’t show it again")}</button><button type="button" disabled={saving} onClick={() => void finish(false)}>{t("Yes, show it on future logins")}</button>{saving && <p role="status">{t("Saving preference…")}</p>}{error && <p role="alert" className="form-error">{t(error)}</p>}</div>}
      </div>
    </div>
    {step === 5 ? <section className="welcome-notes-guide" aria-label={t("Using your Notes workspace")}>
      <div><span>01</span><h2>{t("Find and organize")}</h2><p>{t("Open Notes in the top toolbar. Saved notes are grouped by date; use collections, search, tags, and favorites to find them again.")}</p></div>
      <div><span>02</span><h2>{t("Make it your own")}</h2><p>{t("Choose New note to write one yourself. Edit Markdown, color, and collection, or ask Bob for a revision. Review the suggestion before applying and saving it.")}</p></div>
      <details><summary>{t("More ways to keep a note useful")}</summary><p>{t("Add source links and attachments, review version history, or export notes. Review an earlier version before confirming a restore; delete notes you no longer need.")}</p><small>{t("Practice only. Your real notes and preferences stay unchanged.")}</small></details>
    </section> : step === 6 ? <section className="welcome-notes-guide" aria-label={t("Using Office Suite")}>
      <div><span>01</span><h2>{t("Upload once, keep it together")}</h2><p>{t("On desktop, open Office Suite and use Upload files for Word, Excel, PowerPoint, CSV, PDF, and HTML files.")}</p></div>
      <div><span>02</span><h2>{t("Edit with Buddy, then save")}</h2><p>{t("Open a file, ask Buddy for changes, review the proposal, and save your edits to Office Suite.")}</p></div>
      <details><summary>{t("Present and reuse your work")}</summary><p>{t("Open HTML decks in the live presentation view or use Present for PowerPoint. Completed research reports can be saved to Office Suite as PDF or HTML.")}</p><small>{t("This preview is only practice. Your real files stay unchanged.")}</small></details>
    </section> : screenshot && <figure className="welcome-screenshot">
      <figcaption><span>{t(screenshot.caption)}</span></figcaption>
      {screenshot.instruction && <p className="welcome-screenshot-instruction">{t(screenshot.instruction)}</p>}
    </figure>}

    <footer className="welcome-bottom"><div className="welcome-footer-brand"><span>{brandText("Buddy")}</span><small>{brandText("{{ORGANIZATION}}")}</small></div><span aria-live="polite">{step + 1} / {chapters.length}</span><div>{step > 0 && <button type="button" disabled={saving} onClick={() => setStep(step - 1)}>{t("Back")}</button>}{!last && <button type="button" className="welcome-primary" onClick={() => setStep(step + 1)}>{t(step === 0 ? "Let’s explore" : "Continue")} →</button>}</div></footer>
  </section></div>;
}
