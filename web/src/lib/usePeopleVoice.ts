import { brandText } from './brand';
import { PeopleSocketAudio } from './peopleSocketAudio';
import { PeopleCallSounds } from './peopleCallSounds';
import { useEffect, useRef, useState } from 'react';

interface ServerCall { id: string; room_id: number; status: 'ringing' | 'accepted' | 'active' | 'ended'; role: 'caller' | 'callee'; owned: boolean; caller_name: string; callee_name: string; reason?: string; created_at: string; ring_remaining_ms?: number; accepted_at?: string | null; transport?: 'websocket' | 'webrtc' }
export interface VoiceCall { id?: string; roomId: number; name: string; phase: 'preparing' | 'incoming' | 'ringing' | 'connecting' | 'connected'; muted: boolean }
const names: Record<string, string> = { declined: 'Call declined', timeout: 'Call was not answered or could not connect', disconnected: 'The other member disconnected', access_removed: 'Call ended because conversation access changed', connection_failed: 'The audio connection could not be established', media_error: 'The other member could not access their microphone', cancelled: 'Call cancelled', hangup: 'Call ended' };

export function usePeopleVoice(username: string) {
  const [call, setCall] = useState<VoiceCall | null>(null), [ready, setReady] = useState(false), [notice, setNotice] = useState('');
  const socketAudio = useRef<PeopleSocketAudio | null>(null), audioContext = useRef<AudioContext | null>(null), clientId = useRef(''), configuredTransport = useRef('webrtc'), audioConnected = useRef(false);
  const [playbackBlocked,setPlaybackBlocked] = useState(false);
  const primeCallAudio = () => { if(configuredTransport.current==='websocket' || info.current?.transport==='websocket'){if(!audioContext.current || audioContext.current.state==='closed')audioContext.current=new AudioContext();void audioContext.current.resume().catch(()=>setPlaybackBlocked(true));} };
  const sounds = useRef<PeopleCallSounds | null>(null);
  if (!sounds.current) sounds.current = new PeopleCallSounds();
  const [soundBlocked, setSoundBlocked] = useState(false);
  const [remote, setRemote] = useState<MediaStream | null>(null);
  const socket = useRef<WebSocket | null>(null), info = useRef<ServerCall | null>(null), view = useRef<VoiceCall | null>(null);
  const local = useRef<MediaStream | null>(null), peer = useRef<RTCPeerConnection | null>(null), servers = useRef<RTCIceServer[]>([]);
  const localCandidateTypes = useRef(new Set<string>()), iceErrorCodes = useRef(new Set<number>());
  const candidates = useRef<RTCIceCandidateInit[]>([]), offered = useRef(false), generation = useRef(0), pendingStart = useRef(false);
  const timeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined), disconnected = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const handler = useRef<(value: any) => Promise<void>>(async () => {});
  const update = (value: VoiceCall | null) => { view.current = value; setCall(value); };
  const send = (value: object) => {
    if (socket.current?.readyState !== WebSocket.OPEN) throw new Error('Voice signaling is reconnecting. Please retry.');
    socket.current.send(JSON.stringify(value));
  };
  const cleanup = () => {
    sounds.current?.stop(); setSoundBlocked(false);
    socketAudio.current?.stop(); socketAudio.current=null;audioConnected.current=false;
    const playback=audioContext.current;audioContext.current=null;if(playback && playback.state!=='closed')void playback.close().catch(()=>{});setPlaybackBlocked(false);
    generation.current++; pendingStart.current = false;
    clearTimeout(timeout.current); clearTimeout(disconnected.current);
    const connection = peer.current; peer.current = null; connection?.close();
    local.current?.getTracks().forEach(track => track.stop()); local.current = null;
    localCandidateTypes.current.clear(); iceErrorCodes.current.clear();
    candidates.current = []; offered.current = false; info.current = null;
    setRemote(null); update(null);
  };
  const endCall = (reason = 'hangup', message = '') => {
    const connection = peer.current;
    const diagnostics = connection ? {connection_state:connection.connectionState,ice_state:connection.iceConnectionState,gathering_state:connection.iceGatheringState,local_candidate_types:[...localCandidateTypes.current],ice_error_codes:[...iceErrorCodes.current]} : undefined;
    try {
      if (info.current) send(info.current.role === 'callee' && !info.current.owned && info.current.status === 'ringing' ? {action: 'end', call_id: info.current.id, reason: reason === 'hangup' ? 'cancelled' : reason} : {action: 'end', call_id: info.current.id, reason, ...(diagnostics ? {diagnostics} : {})});
      else if (pendingStart.current) socket.current?.close();
    } catch { /* Local microphone cleanup does not depend on the connection. */ }
    cleanup(); setNotice(message);
  };
  const microphone = async (version: number) => {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new Error('Voice calls need HTTPS and a browser with microphone access.');
    const stream = await navigator.mediaDevices.getUserMedia({audio: {echoCancellation: true, noiseSuppression: true, autoGainControl: true}, video: false});
    if (version !== generation.current) { stream.getTracks().forEach(track => track.stop()); return null; }
    local.current = stream; return stream;
  };
  const start = async (roomId: number, name: string) => {
    if (view.current || !ready) return;
    void sounds.current?.prime(); primeCallAudio();
    setNotice(''); const version = ++generation.current;
    update({roomId, name, phase: 'preparing', muted: false});
    try {
      if (!await microphone(version)) return;
      pendingStart.current = true;
      send({action: 'start', room_id: roomId});
    } catch (error) { if (version === generation.current) endCall('media_error', mediaError(error)); }
  };
  const answer = async () => {
    const current = info.current; if (!current || view.current?.phase !== 'incoming') return;
    sounds.current?.stop(); void sounds.current?.prime(); primeCallAudio();
    const version = ++generation.current; setNotice(''); update({...view.current, phase: 'preparing'});
    try {
      if (!await microphone(version)) return;
      send({action: 'accept', call_id: current.id});
    } catch (error) {
      if (version === generation.current) { try { send({action: 'end', call_id: current.id, reason: 'media_error'}); } catch {} cleanup(); setNotice(mediaError(error)); }
    }
  };
  const decline = () => {
    if (info.current) { try { send({action: 'decline', call_id: info.current.id}); } catch {} }
    cleanup(); setNotice('Call declined');
  };
  const mute = () => {
    if (!local.current || !view.current) return;
    const muted = !view.current.muted;
    local.current.getAudioTracks().forEach(track => { track.enabled = !muted; });
    update({...view.current, muted});
  };
  const makePeer = (current: ServerCall) => {
    if (peer.current) return peer.current;
    if (!local.current) throw new Error('Microphone is not ready. Please call again.');
    const connection = new RTCPeerConnection({iceServers: servers.current}); peer.current = connection;
    local.current.getTracks().forEach(track => connection.addTrack(track, local.current!));
    connection.onicecandidate = event => {
      if (event.candidate?.type && peer.current === connection) localCandidateTypes.current.add(event.candidate.type);
      if (event.candidate && peer.current === connection && info.current?.id === current.id) {
        try { send({action: 'ice', call_id: current.id, candidate: event.candidate.toJSON()}); } catch { endCall('connection_failed', 'Voice signaling disconnected'); }
      }
    };
    connection.onicecandidateerror = event => { if (peer.current === connection && event.errorCode >= 100 && event.errorCode <= 999 && iceErrorCodes.current.size < 8) iceErrorCodes.current.add(event.errorCode); };
    connection.ontrack = event => {
      if (peer.current === connection) setRemote(event.streams[0] || new MediaStream([event.track]));
    };
    connection.onconnectionstatechange = () => {
      if (peer.current !== connection) return;
      if (connection.connectionState === 'connected') {
        clearTimeout(timeout.current); clearTimeout(disconnected.current);
        if (view.current) update({...view.current, phase: 'connected'});
        try { send({action: 'connected', call_id: current.id}); } catch { endCall('connection_failed', 'Voice signaling disconnected'); }
      } else if (connection.connectionState === 'failed') {
        const configured = servers.current.some(server => [server.urls].flat().some(url => /^turns?:/.test(url)));
        endCall('connection_failed', !configured ? 'An audio relay is not configured for this connection.' : localCandidateTypes.current.has('relay') ? 'The audio connection failed after reaching the relay. Please try calling again.' : 'The audio relay could not be reached from this network. Check your VPN or network connection.');
      }
      else if (connection.connectionState === 'disconnected') {
        clearTimeout(disconnected.current);
        disconnected.current = setTimeout(() => { if (peer.current === connection && connection.connectionState !== 'connected') endCall('connection_failed', 'Audio connection was lost'); }, 10000);
      }
    };
    return connection;
  };
  const flushIce = async (connection: RTCPeerConnection) => {
    if (!connection.remoteDescription) return;
    for (const candidate of candidates.current.splice(0)) await connection.addIceCandidate(candidate);
  };
  handler.current = async event => {
    if (event.type === 'call_ready') { servers.current = event.ice_servers || [];clientId.current=event.client_id||clientId.current;configuredTransport.current=event.audio_transport||'webrtc'; setReady(true); return; }
    if (event.type === 'call_ping') { send({action: 'ping'}); return; }
    if (event.type === 'call_error') { endCall('connection_failed', event.message || 'The call could not be completed'); return; }
    if (event.type === 'call_state') {
      const current: ServerCall = event.call;
      if (current.status === 'ended') {
        window.dispatchEvent(new Event('community-call-ended'));
        if (info.current?.id === current.id) { cleanup(); setNotice(current.role === 'callee' && !current.accepted_at && ['timeout', 'cancelled', 'disconnected', 'hangup'].includes(current.reason || '') ? `Missed voice call from ${current.caller_name}` : current.reason === 'timeout' ? current.accepted_at ? 'The audio connection timed out' : 'Call was not answered' : names[current.reason || ''] || 'Call ended'); }
        return;
      }
      if (current.role === 'caller' && !current.owned) return;
      if (current.role === 'callee' && current.status !== 'ringing' && !current.owned) {
        if (info.current?.id === current.id) { cleanup(); setNotice('Call answered in another tab'); }
        return;
      }
      if (info.current && info.current.id !== current.id) return;
      const fresh = !info.current; info.current = current; pendingStart.current = false;
      if (fresh) setNotice('');
      const name = current.role === 'caller' ? current.callee_name : current.caller_name;
      if (fresh && current.role === 'callee') { generation.current++; local.current?.getTracks().forEach(track => track.stop()); local.current = null; }
      const phase = current.status === 'ringing' ? current.role === 'caller' ? 'ringing' : 'incoming' : audioConnected.current || peer.current?.connectionState === 'connected' ? 'connected' : 'connecting';
      // Repeated heartbeat snapshots must not interrupt a microphone permission prompt.
      if (!(view.current?.phase === 'preparing' && !fresh && current.status === 'ringing')) update({id: current.id, roomId: current.room_id, name, phase, muted: view.current?.muted || false});
      if (fresh || current.status !== 'ringing' && !peer.current && !socketAudio.current) {
        clearTimeout(timeout.current);
        timeout.current = setTimeout(() => endCall('timeout', current.status === 'ringing' ? 'Call was not answered' : 'The audio connection timed out'), current.status === 'ringing' ? Math.max(1, Math.min(45000, current.ring_remaining_ms ?? 45000)) : 40000);
      }
      if (current.status === 'accepted' || current.status === 'active') {
        if(current.transport==='websocket'){
          if(!socketAudio.current){
            if(!local.current || !clientId.current)throw new Error('Microphone is not ready. Please call again.');
            primeCallAudio();
            const engine=new PeopleSocketAudio(audioContext.current!,local.current,current.id,clientId.current,current.role,{
              connected:()=>{if(socketAudio.current!==engine)return;audioConnected.current=true;clearTimeout(timeout.current);if(view.current)update({...view.current,phase:'connected'});try{send({action:'connected',call_id:current.id});}catch{endCall('connection_failed',brandText('Buddy’s audio connection disconnected'));}},
              error:message=>{if(socketAudio.current===engine)endCall('connection_failed',message);},
              blocked:setPlaybackBlocked,
            });
            socketAudio.current=engine;void engine.start();
          }
          return;
        }
        const connection = makePeer(current);
        if (current.role === 'caller' && !offered.current) {
          offered.current = true;
          const offer = await connection.createOffer();
          if (peer.current !== connection) return;
          await connection.setLocalDescription(offer);
          if (peer.current === connection) send({action: 'offer', call_id: current.id, sdp: connection.localDescription!.sdp});
        }
      }
      return;
    }
    if (event.type !== 'call_signal' || !info.current || event.call_id !== info.current.id) return;
    if(info.current.transport==='websocket')return;
    const current = info.current, connection = makePeer(current);
    if (event.action === 'ice') {
      if (connection.remoteDescription) await connection.addIceCandidate(event.candidate);
      else if (candidates.current.length < 100) candidates.current.push(event.candidate);
    } else if (event.action === 'offer' && current.role === 'callee') {
      await connection.setRemoteDescription({type: 'offer', sdp: event.sdp}); await flushIce(connection);
      const answer = await connection.createAnswer(); await connection.setLocalDescription(answer);
      if (peer.current === connection) send({action: 'answer', call_id: current.id, sdp: connection.localDescription!.sdp});
    } else if (event.action === 'answer' && current.role === 'caller') {
      await connection.setRemoteDescription({type: 'answer', sdp: event.sdp}); await flushIce(connection);
    }
  };
  useEffect(() => {
    const phase = call?.phase;
    if (phase === 'ringing' || phase === 'incoming') setSoundBlocked(!sounds.current!.play(phase === 'ringing' ? 'outgoing' : 'incoming'));
    else { sounds.current?.stop(); setSoundBlocked(false); }
    return () => sounds.current?.stop();
  }, [call?.phase]);
  const enableSound = async () => {
    const enabled = await sounds.current!.prime();
    const phase = view.current?.phase;
    if (phase === 'ringing' || phase === 'incoming') setSoundBlocked(!enabled || !sounds.current!.play(phase === 'ringing' ? 'outgoing' : 'incoming'));
  };
  useEffect(() => {
    let stopped = false, reconnect: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      if (stopped) return;
      const connection = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/community/calls/ws?audio=1`);
      socket.current = connection; let chain = Promise.resolve();
      connection.onmessage = event => {
        chain = chain.then(async () => {
          if (stopped || socket.current !== connection) return;
          try { await handler.current(JSON.parse(event.data)); } catch (error) { endCall('connection_failed', error instanceof Error ? error.message : 'Voice connection failed'); }
        });
      };
      connection.onclose = () => {
        if (socket.current !== connection) return;
        setReady(false);
        if (view.current) { cleanup(); setNotice('Voice signaling disconnected. Please call again.'); }
        if (!stopped) reconnect = setTimeout(connect, 3000);
      };
    };
    connect();
    return () => { stopped = true; clearTimeout(reconnect); socket.current?.close(); socket.current = null; cleanup(); sounds.current?.dispose(); };
    // The socket belongs to the account, not the selected conversation or minimized panel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [username]);
  return {call, ready, notice, remote, playbackBlocked, resumeAudio:async()=>{await audioContext.current?.resume();setPlaybackBlocked(audioContext.current?.state!=='running');}, soundBlocked, enableSound, start, answer, decline, mute, hangup: () => endCall('hangup', 'Call ended'), dismiss: () => setNotice('')};
}
function mediaError(error: unknown): string {
  if (error instanceof DOMException && error.name === 'NotAllowedError') return 'Microphone permission was denied. Allow microphone access to make a voice call.';
  if (error instanceof DOMException && error.name === 'NotFoundError') return 'No microphone was found.';
  return error instanceof Error ? error.message : 'Could not access your microphone.';
}
export type PeopleVoice = ReturnType<typeof usePeopleVoice>;
