// Synthetic UI fixture; no production accounts, metrics or services.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { InstalledApps } from '../src/components/InstalledApps';
import { setLanguage, type Language } from '../src/lib/i18n';
import type { WorkspaceApp } from '../src/lib/appRegistry';
import '../src/styles.css';
const core: WorkspaceApp[] = [{ id: 'notes', name: 'Notes', description: 'Your notes and collections', kind: 'core', desktop_only: false, launch: { kind: 'notes' } }];
const addons: WorkspaceApp[] = [
  { id: 'office', name: 'Office Suite', description: 'Documents, spreadsheets and presentations', kind: 'installed', desktop_only: true, launch: { kind: 'office' } },
  { id: 'people', name: 'Member chat', description: 'Messages, channels and collaboration', kind: 'installed', desktop_only: false, launch: { kind: 'people' } },
  { id: 'fixture-portal', name: 'Fixture portal', description: 'Synthetic test app', kind: 'installed', desktop_only: false, launch: { kind: 'link', url: 'https://example.com/' } }
];
function Fixture() {
  const [open, setOpen] = useState(false), [installed, setInstalled] = useState(false), [desktop, setDesktop] = useState(true), [last, setLast] = useState('');
  return <><button id="launch" onClick={() => setOpen(true)}>Open apps fixture</button><button id="install" onClick={() => setInstalled(value => !value)}>Toggle installed fixture</button><button id="device" onClick={() => setDesktop(value => !value)}>Toggle device fixture</button><select aria-label="Fixture language" onChange={event => setLanguage(event.target.value as Language)}>{['en','el','hi','mt'].map(language => <option key={language}>{language}</option>)}</select><output id="last">{last}</output>{open && <InstalledApps apps={installed ? [...core, ...addons] : core} loaded error={false} desktop={desktop} onRefresh={() => {}} onClose={() => setOpen(false)} onOpen={app => setLast(app.id)} />}</>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><Fixture /></React.StrictMode>);
