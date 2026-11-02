/* Exercise the actual Office HTML runtime in an opaque, sandboxed iframe. */
import { buildOfficeHtmlRuntime } from '../../src/lib/officeHtmlRuntime';

const channel = 'office-browser-test';
const frame = document.createElement('iframe');
frame.title = 'Office runtime';
frame.setAttribute('sandbox', 'allow-scripts');
document.getElementById('root')!.append(frame);
const browserWindow = window as unknown as {
  setOffice: (html: string) => void;
  officeWarnings: string[];
  officeReady: boolean;
};
browserWindow.officeWarnings = [];
browserWindow.officeReady = false;
window.addEventListener('message', event => {
  if (event.source !== frame.contentWindow || event.data?.bridge !== 'bob-html-runtime' || event.data.channel !== channel) return;
  if (event.data.type === 'ready') browserWindow.officeReady = true;
  if (event.data.type === 'warning') browserWindow.officeWarnings.push(String(event.data.value));
});
browserWindow.setOffice = html => {
  browserWindow.officeWarnings = [];
  browserWindow.officeReady = false;
  frame.srcdoc = buildOfficeHtmlRuntime(html, channel);
};
