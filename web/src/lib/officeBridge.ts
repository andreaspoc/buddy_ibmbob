import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';

export type OfficeContext = {
  kind: 'word' | 'cell' | 'slide' | 'pdf' | 'html'; text: string; selection: string;
  sheets?: string[]; range?: string; values?: Array<Array<string | number | boolean | null>>;
  html_nodes?: Array<{index:number; text:string; tag:string}>;
  pages?: Array<{page: number; objects: Array<{object_index: number; text: string; editable: boolean}>}>;
  page_count?: number; capabilities?: string[]; text_available?: boolean; truncated?: boolean;
  slide_count?: number; current_slide?: number; slide_width?: number; slide_height?: number;
  editor_capabilities?: string[];
  charts?: Array<{chart_index:number;sheet:string|null;slide_index:number|null;selected:boolean;title?:string|null;chart_type?:string|null;width?:number|null;height?:number|null}>;
  slide_shapes?: Array<{slide_index:number; shape_index:number; text:string; text_truncated?:boolean; selected:boolean; x?:number|null; y?:number|null; width?:number|null; height?:number|null}>;
  [key: string]: unknown;
};
export type OfficeAction = { type: string; [key: string]: unknown };
export type OfficeFormSpec = { name: string; title: string; description?: string; fields: { name: string; label: string; type?: string; required?: boolean; options?: string[] }[]; folder_id?: string | null };
export type OfficePlan = { create_form?: OfficeFormSpec | null; version: 1; kind: 'word' | 'cell' | 'slide' | 'pdf' | 'html'; reply: string; actions: OfficeAction[] };
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: number };
const BRIDGE = 'buddy-office';
const PLUGIN_ID = 'A58B77D1-3407-4EC8-9282-52C1884E02F4';

function isEditorPlugin(host: HTMLElement | null, source: MessageEventSource | null): boolean {
  const scan = (root: Document | HTMLElement): boolean => {
    for (const frame of root.querySelectorAll('iframe')) {
      try {
        const url = new URL(frame.src, window.location.href);
        if (url.origin !== window.location.origin) continue;
        if ((url.pathname.includes('/static/office-bridge/') || url.pathname.includes(PLUGIN_ID)) && frame.contentWindow === source) return true;
        if (frame.contentDocument && scan(frame.contentDocument)) return true;
      } catch { /* Cross-origin frames cannot be the same-origin editor bridge. */ }
    }
    return false;
  };
  return !!host && scan(host);
}

export function useOfficeBridge(host: RefObject<HTMLDivElement | null>, editorKey: string, editorKind?: OfficeContext['kind']) {
  const [ready, setReady] = useState(false);
  const connected = useRef(false);
  const peer = useRef<Window | null>(null);
  const channel = useRef('');
  const pending = useRef(new Map<string, Pending>());
  const reset = useCallback(() => {
    connected.current = false; peer.current = null; channel.current = ''; setReady(false);
    for (const request of pending.current.values()) {
      window.clearTimeout(request.timer); request.reject(new Error('The editor connection changed. Please retry.'));
    }
    pending.current.clear();
  }, []);
  useEffect(() => { reset(); }, [editorKey, reset]);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.data?.bridge !== BRIDGE) return;
      const data = event.data;
      if (data.type === 'hello') {
        if (!isEditorPlugin(host.current, event.source)) return;
        if (peer.current !== event.source) {
          reset(); peer.current = event.source as Window; channel.current = crypto.randomUUID();
        }
        peer.current?.postMessage({ bridge: BRIDGE, type: 'connect', channel: channel.current, kind: editorKind }, window.location.origin);
        return;
      }
      if (event.source !== peer.current || data.channel !== channel.current || !channel.current) return;
      if (data.type === 'connected') { connected.current = true; setReady(true); return; }
      if (data.type !== 'result' || typeof data.id !== 'string') return;
      const request = pending.current.get(data.id);
      if (!request) return;
      pending.current.delete(data.id); window.clearTimeout(request.timer);
      if (data.error) request.reject(new Error(String(data.error)));
      else request.resolve(data.result);
    };
    window.addEventListener('message', receive);
    return () => { window.removeEventListener('message', receive); reset(); };
  }, [host, reset, editorKind]);
  const call = useCallback(<T,>(command: 'context' | 'apply' | 'present', payload?: unknown): Promise<T> => {
    if (!connected.current || !peer.current) return Promise.reject(new Error('Bob is waiting for the document connection. Please retry shortly.'));
    const id = crypto.randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        pending.current.delete(id);
        reject(new Error('The editor did not confirm this action. Check the document before retrying.'));
      }, command === 'apply' ? 45000 : 15000);
      pending.current.set(id, { resolve: value => resolve(value as T), reject, timer });
      peer.current!.postMessage({ bridge: BRIDGE, type: 'request', channel: channel.current, id, command, payload }, window.location.origin);
    });
  }, []);
  return { ready, present: useCallback(() => call<{ok:boolean}>('present'), [call]), context: useCallback(() => call<OfficeContext>('context'), [call]),
    apply: useCallback((plan: OfficePlan, expectedContext: OfficeContext) => call<{ ok?: boolean; applied?: number; error?: string }>('apply', { plan, expectedContext }), [call]) };
}
export type OfficeBridge = Pick<ReturnType<typeof useOfficeBridge>, 'ready' | 'context' | 'apply'>;
