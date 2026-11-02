// Synthetic UI only: no account, backend, or model connection.
import { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AppDialog, appAlert, appConfirm } from '../src/components/AppDialog';
import '../src/styles.css';
import '../src/brandLight.css';
import '../src/copilotKitTheme.css';
import '../src/workspaceFinish.css';
import '../src/carbonFoundation.scss';

document.documentElement.dataset.designSystem = 'carbon';
document.documentElement.dataset.uiTheme = 'copilotkit';

function Fixture() {
  const host = useRef<HTMLDialogElement>(null);
  const [result, setResult] = useState('');
  async function queue() {
    const first = appConfirm('First synthetic confirmation');
    const second = appConfirm('Second synthetic confirmation');
    setResult(JSON.stringify([await first, await second]));
  }
  return <>
    <AppDialog />
    <button onClick={() => void queue()}>Queue confirmations</button>
    <button onClick={() => void appAlert('Synthetic temporary notice', 'info')}>Show notice</button>
    <button onClick={() => host.current?.showModal()}>Open host dialog</button>
    <output aria-label="Confirmation results">{result}</output>
    <dialog ref={host} aria-label="Synthetic host dialog">
      <button onClick={() => void appAlert('Synthetic persistent error', 'error')}>Show persistent error</button>
      <button onClick={() => host.current?.close()}>Close host dialog</button>
    </dialog>
  </>;
}

createRoot(document.getElementById('root')!).render(<Fixture />);
