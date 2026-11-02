/* Mounts the real preview component for the cross-browser dashboard check. */
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ArtifactPreview } from '../../src/components/ArtifactPreview';

function App() {
  const [state, set] = useState({ html: '', live: false });
  (window as unknown as { setPreview: (html: string, live?: boolean) => void }).setPreview = (html, live = false) => set({ html, live });
  return <ArtifactPreview html={state.html} live={state.live} />;
}
createRoot(document.getElementById('root')!).render(<App />);
