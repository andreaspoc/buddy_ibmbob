import { useCallback, useRef, useState, type SetStateAction } from 'react';
export type DraftMember = {username: string; display_name: string};
export type PeopleDraft = {body: string; mentioned: DraftMember[]};
export function peopleDraftKey(username: string, roomId: number | null, threadId: number | null) {
  return roomId === null ? '' : `buddy.people.draft.v1:${encodeURIComponent(username)}:${roomId}:${threadId ?? 0}`;
}
export function readPeopleDraft(key: string): PeopleDraft {
  if (!key) return {body:'',mentioned:[]};
  try {
    const value = JSON.parse(sessionStorage.getItem(key) || 'null');
    if (!value || typeof value.body !== 'string') return {body:'',mentioned:[]};
    return {body: value.body.slice(0,20000), mentioned: Array.isArray(value.mentioned) ? value.mentioned.filter((member: DraftMember) => typeof member?.username === 'string' && typeof member?.display_name === 'string').slice(0,100) : []};
  } catch { return {body:'',mentioned:[]}; }
}
export function writePeopleDraft(key: string, value: PeopleDraft) {
  if (!key) return;
  try { if (!value.body) sessionStorage.removeItem(key); else sessionStorage.setItem(key,JSON.stringify(value)); } catch { /* The mounted chat keeps drafts in memory if storage is restricted. */ }
}
export function usePeopleDraft(username: string, roomId: number | null, threadId: number | null) {
  const key = peopleDraftKey(username,roomId,threadId);
  const cache = useRef(new Map<string,PeopleDraft>());
  const [, refresh] = useState(0);
  const draft = cache.current.get(key) ?? readPeopleDraft(key);
  cache.current.set(key,draft);
  // Setters retain their original conversation key, including after an asynchronous send.
  const setBody = useCallback((update: SetStateAction<string>) => {
    if (!key) return;
    const previous = cache.current.get(key) ?? readPeopleDraft(key);
    const next = {...previous,body: (typeof update === 'function' ? update(previous.body) : update).slice(0,20000)};
    cache.current.set(key,next); writePeopleDraft(key,next); refresh(value=>value+1);
  }, [key]);
  const setMentioned = useCallback((update: SetStateAction<DraftMember[]>) => {
    if (!key) return;
    const previous = cache.current.get(key) ?? readPeopleDraft(key);
    const next = {...previous,mentioned: typeof update === 'function' ? update(previous.mentioned) : update};
    cache.current.set(key,next); writePeopleDraft(key,next); refresh(value=>value+1);
  }, [key]);
  return {...draft,setBody,setMentioned};
}
export function messageDayKey(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}` : '';
}
