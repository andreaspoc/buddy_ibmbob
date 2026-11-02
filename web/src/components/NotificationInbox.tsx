import { Toolbar } from './Toolbar';
import { useEffect, useRef, useState } from 'react';
import { WorkspaceSectionHeader } from './WorkspaceSectionHeader';
import { t, getLocale } from '../lib/i18n';
import './Notifications.css';
interface Notice { room_id?: number; room_kind?: string; id: string; kind: string; title: string; status: string; occurred_at: string; read_at: string | null; job_id: string | null; session_id: string; document_id?: string; owner?: string; review_due?: string | null }
export function NotificationInbox({onClose,onTask,onConversation,onResearch}: {onClose:()=>void;onTask:(id:string)=>void;onConversation:(id:string)=>void;onResearch?:(id:string)=>void}) {
  const [items,setItems]=useState<Notice[]>([]);
  const [error,setError]=useState('');
  const [loading,setLoading]=useState(true);
  const [unreadOnly,setUnreadOnly]=useState(false);
  const [pending,setPending]=useState<string[]>([]);
  const dialog=useRef<HTMLDialogElement>(null);
  const reload=useRef<()=>void>(()=>{});
  useEffect(()=>{
    const element=dialog.current;
    const opener=document.activeElement instanceof HTMLElement ? document.activeElement : null;
    element?.showModal();
    return ()=>{element?.close();if(opener?.isConnected)opener.focus();};
  },[]);
  useEffect(()=>{
    let active=true;
    let updating=false;
    const controller=new AbortController();
    const load=async()=>{
      if(updating)return;
      updating=true;
      try{const response=await fetch('/notifications',{signal:controller.signal});if(!response.ok)throw new Error('Could not load notifications');const data=await response.json();if(active){setItems(data);setError('');}}
      catch(e){if(active)setError((e as Error).message);}
      finally{updating=false;if(active)setLoading(false);}
    };
    reload.current=()=>void load();
    void load();const timer=window.setInterval(()=>{if(!document.hidden)void load();},10000);
    return ()=>{active=false;controller.abort();window.clearInterval(timer);};
  },[]);
  async function read(item:Notice) {
    if(item.read_at)return true;
    setPending(current=>[...current,item.id]);
    try {const response=await fetch('/notifications/read',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:item.id})});if(!response.ok)throw new Error('Could not mark notification read');setItems(current=>current.map(value=>value.id===item.id?{...value,read_at:new Date().toISOString()}:value));setError('');return true;}
    catch(e){setError((e as Error).message);return false;}
    finally{setPending(current=>current.filter(id=>id!==item.id));}
  }
  const unread=items.filter(item=>!item.read_at).length;
  const visible=items.filter(item=>!unreadOnly || !item.read_at);
  return <dialog ref={dialog} className="notification-inbox buddy-surface" aria-labelledby="notification-inbox-title" onCancel={event=>{event.preventDefault();onClose();}}>
    <WorkspaceSectionHeader titleId="notification-inbox-title" title={t('Notifications')} eyebrow={t('STAY UP TO DATE')} description={t('People messages, assigned-task reminders, task results, approvals, and knowledge updates.')} actions={<button type="button" className="feature-close" onClick={onClose}>{t('Close')}</button>} />
    <Toolbar className="notification-toolbar"><div className="notification-filters" role="group" aria-label={t('Filter notifications')}>
      <button type="button" aria-pressed={!unreadOnly} onClick={()=>setUnreadOnly(false)}>{t('All')} <span>{items.length}</span></button>
      <button type="button" aria-pressed={unreadOnly} onClick={()=>setUnreadOnly(true)}>{t('Unread')} <span>{unread}</span></button>
    </div><button type="button" onClick={()=>reload.current()}>{t('Refresh')}</button></Toolbar>
    {error && <p role="alert" className="notification-error">{t(error)}</p>}
    {loading ? <div className="notification-empty" role="status">{t('Loading notifications…')}</div> : <ul className="notification-list">{visible.map(item=>{
      const source=Boolean(item.document_id && /^[a-f0-9-]{36}$/i.test(item.document_id));
      const destination=Boolean(item.room_id || item.job_id || item.session_id);
      const date=new Date(item.occurred_at);
      return <li key={item.id} className={`notification-card${!item.read_at?' is-unread':''}`}>
        <span className="notification-kind-icon" aria-hidden="true">{item.kind==='missed_call'?'☎':item.room_id?'↗':item.kind==='knowledge'?'▤':item.job_id?'✓':'i'}</span>
        <div className="notification-card-content"><div className="notification-card-heading"><strong>{item.title}</strong>{!item.read_at&&<span className="notification-unread-label">{t('Unread')}</span>}</div>
          <div className="notification-meta"><span>{t(item.kind==='research'?'Research report':item.kind)}</span>{item.status&&<span>{t(item.status)}</span>}<time dateTime={item.occurred_at}>{Number.isNaN(date.getTime())?'—':date.toLocaleString(getLocale())}</time></div>
          {item.kind==='knowledge'&&<p className="notification-owner">{t('Owner')}: {item.owner||'—'}{item.review_due?` · ${t('Review due')}: ${item.review_due}`:''}</p>}
          <div className="notification-card-actions">
            {source?<a href={`/knowledge/${item.document_id}/file`} target="_blank" rel="noopener noreferrer" onClick={()=>void read(item)}>{t('Open source')} ↗</a>:destination&&<button type="button" disabled={pending.includes(item.id)} onClick={async()=>{if(await read(item)){onClose();if(item.room_id)window.dispatchEvent(new CustomEvent('community-open-room',{detail:{roomId:item.room_id,kind:item.room_kind||'direct'}}));else if(item.kind==='research'&&onResearch)onResearch(item.session_id);else if(item.job_id)onTask(item.job_id);else onConversation(item.session_id);}}}>{t(item.kind==='missed_call'?'Open conversation':item.room_id?'Open message':item.job_id?'Open task':'Open conversation')} →</button>}
            {!item.read_at&&<button type="button" disabled={pending.includes(item.id)} onClick={()=>void read(item)}>{t(pending.includes(item.id)?'Saving…':'Mark read')}</button>}
          </div>
        </div>
      </li>;
    })}</ul>}
    {!loading&&!visible.length&&<div className="notification-empty"><span aria-hidden="true">✓</span><strong>{t(unreadOnly?'You’re all caught up':'No notifications yet')}</strong><p>{t('New updates will appear here.')}</p></div>}
  </dialog>;
}
