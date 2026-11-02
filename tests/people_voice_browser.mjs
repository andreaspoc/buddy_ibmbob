// Real authenticated signaling and RTCPeerConnection audio; only disposable test accounts and fake microphones.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const {chromium}=await import(process.env.CARBON_PLAYWRIGHT_MODULE || 'playwright');
const fixture=JSON.parse(await readFile(process.env.PEOPLE_VOICE_FIXTURE || '/tmp/people-voice-fixture.json','utf8'));
const base=process.env.CARBON_PREVIEW_URL || 'http://127.0.0.1:3183';
const browser=await chromium.launch({args:['--no-sandbox','--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream','--autoplay-policy=no-user-gesture-required','--disable-features=WebRtcHideLocalIpsWithMdns','--ignore-certificate-errors']});
const pages=[],contexts=[],errors=[];
try {
 for(const user of fixture.users.slice(0,2)){
  const context=await browser.newContext({viewport:{width:1440,height:1000},permissions:['microphone'],ignoreHTTPSErrors:true});contexts.push(context);
  await context.addCookies([{name:user.cookie,value:user.token,url:base,httpOnly:true,secure:base.startsWith('https:'),sameSite:'Lax'}]);
  const page=await context.newPage();pages.push(page);
  page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(({username,relayOnly,relayTcp,relayHost})=>{
   const now=Date.now.bind(Date);Date.now=()=>now()+3600000;
   sessionStorage.setItem(`buddy-approval-guide:${username}`,'seen');sessionStorage.setItem(`buddy-welcome-v1:${username}`,'seen');
   window.voiceTestToneNodes=[];window.voiceTestToneAnalysers=[];
   const ActualAudioContext=window.AudioContext;
   window.AudioContext=class extends ActualAudioContext {
    createOscillator(){const node=super.createOscillator();const record={ended:false};window.voiceTestToneNodes.push(record);node.addEventListener('ended',()=>{record.ended=true;});return node;}
    createGain(){const node=super.createGain();const connect=node.connect.bind(node);node.connect=(target,...args)=>{if(target===this.destination){const analyser=this.createAnalyser();analyser.fftSize=256;window.voiceTestToneAnalysers.push(analyser);connect(analyser);analyser.connect(target);return target;}return connect(target,...args);};return node;}
   };
   window.voiceTestStreams=[];
   const getMedia=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
   navigator.mediaDevices.getUserMedia=async constraints=>{if(constraints.video!==false)throw Error('Voice call requested a camera');const stream=await getMedia(constraints);window.voiceTestStreams.push(stream);return stream;};
   const Original=window.RTCPeerConnection;window.voiceTestPeers=[];
   window.RTCPeerConnection=class extends Original{constructor(configuration){const iceServers=relayTcp||relayHost?configuration.iceServers.map(server=>({...server,urls:[server.urls].flat().filter(url=>(!relayTcp||url.includes('transport=tcp'))&&(!relayHost||url.includes(':'+relayHost+':')))})).filter(server=>server.urls.length):configuration.iceServers;super(relayOnly?{...configuration,iceServers,iceTransportPolicy:'relay'}:configuration);window.voiceTestPeers.push(this);}};
  },{...user,relayOnly:process.env.VOICE_RELAY_ONLY==='1',relayTcp:process.env.VOICE_RELAY_TCP==='1',relayHost:process.env.VOICE_RELAY_HOST||''});
  await page.route('**/personalization/tutorials',route=>route.fulfill({json:{disabled:true}}));
  await page.goto(base);await page.locator('.member-chat-launcher').waitFor();
 }
 const [caller,recipient]=pages;
 // Open only the synthetic conversation, never interact with other members.
 await caller.evaluate(roomId=>window.dispatchEvent(new CustomEvent('community-open-room',{detail:{roomId,kind:'direct'}})),fixture.room_id);
 const callButton=caller.getByRole('button',{name:'Start voice call',exact:true});await callButton.waitFor();
 await caller.waitForFunction(()=>!document.querySelector('.member-chat-call')?.disabled);
 await callButton.click();
 const incoming=recipient.getByRole('region',{name:'Voice call',exact:true});await incoming.waitFor();
 await incoming.getByRole('button',{name:'Answer',exact:true}).waitFor();
 assert.equal(await recipient.evaluate(()=>window.voiceTestPeers.length),0,'No peer connection before Answer');
 assert.equal(await recipient.evaluate(()=>window.voiceTestStreams.length),0,'No microphone access before Answer');
 for(const page of pages){
  const enable=page.getByRole('button',{name:'Enable ringing sound',exact:true});if(await enable.count())await enable.click();
  await page.waitForFunction(()=>window.voiceTestToneAnalysers.some(analyser=>{const samples=new Uint8Array(analyser.fftSize);analyser.getByteTimeDomainData(samples);return samples.some(sample=>Math.abs(sample-128)>1);}));
 }
 await caller.waitForFunction(()=>window.voiceTestToneNodes.length>=4);
 await incoming.getByRole('button',{name:'Answer',exact:true}).waitFor();
 await caller.getByRole('button',{name:'Expand chat',exact:true}).click();
 assert(await caller.getByRole('button',{name:'Hang up',exact:true}).evaluate(button=>{const rect=button.getBoundingClientRect();return button.contains(document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2));}),'Expanded chat must not cover Hang up');
 await incoming.getByRole('button',{name:'Answer',exact:true}).click();
 for(const page of pages){
  await page.getByText('Voice call connected',{exact:true}).waitFor({timeout:30000});
  assert.equal(await page.evaluate(()=>window.voiceTestPeers.at(-1).connectionState),'connected');
  await page.waitForFunction(async()=>{const stats=await window.voiceTestPeers.at(-1).getStats();return [...stats.values()].some(s=>s.type==='inbound-rtp'&&s.kind==='audio'&&s.packetsReceived>0);},{timeout:20000});
 }
 for(const page of pages)await page.waitForFunction(()=>window.voiceTestToneNodes.every(node=>node.ended));
 await caller.getByRole('button',{name:'Mute microphone',exact:true}).click();
 assert(await caller.evaluate(()=>window.voiceTestPeers.at(-1).getSenders().filter(s=>s.track?.kind==='audio').every(s=>!s.track.enabled)));
 await caller.getByRole('button',{name:'Unmute microphone',exact:true}).click();
 assert(await caller.evaluate(()=>window.voiceTestPeers.at(-1).getSenders().filter(s=>s.track?.kind==='audio').every(s=>s.track.enabled)));
 if(process.env.VOICE_RELAY_ONLY==='1')for(const page of pages)assert(await page.evaluate(async()=>{const stats=await window.voiceTestPeers.at(-1).getStats();return [...stats.values()].some(s=>s.type==='candidate-pair'&&s.state==='succeeded'&&s.nominated&&stats.get(s.localCandidateId)?.candidateType==='relay');}));
 if(process.env.VOICE_RELAY_HOST)for(const page of pages){
  const selected=await page.evaluate(async()=>{const stats=await window.voiceTestPeers.at(-1).getStats();return [...stats.values()].filter(s=>s.type==='candidate-pair'&&s.state==='succeeded'&&s.nominated).map(s=>{const c=stats.get(s.localCandidateId);return {type:c?.candidateType,address:c?.address,ip:c?.ip,url:c?.url};});});
  assert(selected.some(c=>(c.address||c.ip)===process.env.VOICE_RELAY_HOST),JSON.stringify(selected));
 }
 await caller.getByRole('button',{name:'Hang up',exact:true}).click();
 await recipient.getByRole('region',{name:'Voice call',exact:true}).waitFor({state:'hidden'});
 for(const page of pages){assert.equal(await page.evaluate(()=>window.voiceTestPeers.at(-1).connectionState),'closed');assert(await page.evaluate(()=>window.voiceTestStreams.every(stream=>stream.getTracks().every(track=>track.readyState==='ended'))));}
 // A second real invitation can be declined without creating a new audio peer.
 await caller.waitForFunction(()=>!document.querySelector('.member-chat-call')?.disabled);await callButton.click();
 await recipient.getByRole('button',{name:'Decline',exact:true}).click();
 await caller.getByRole('region',{name:'Voice call',exact:true}).waitFor({state:'hidden'});
 assert.equal(await recipient.evaluate(()=>window.voiceTestPeers.length),1);
 await caller.waitForFunction(()=>!document.querySelector('.member-chat-call')?.disabled);
 await callButton.click();
 await recipient.getByRole('button',{name:'Decline',exact:true}).waitFor();
 await caller.getByRole('button',{name:'Hang up',exact:true}).click();
 await recipient.getByRole('region',{name:'Voice call',exact:true}).waitFor({state:'hidden'});
 for(const page of pages)await page.waitForFunction(()=>window.voiceTestToneNodes.every(node=>node.ended));
 await caller.waitForFunction(()=>!document.querySelector('.member-chat-call')?.disabled);
 if(process.env.VOICE_FULL_TIMEOUT==='1'){
  await callButton.click();
  await recipient.getByRole('button',{name:'Decline',exact:true}).waitFor();
  const ringingStarted=performance.now();
  await caller.getByText('Call was not answered',{exact:true}).waitFor({timeout:60000});
  assert(performance.now()-ringingStarted>=40000,'An unanswered invitation must not end after one ring');
  await recipient.getByRole('region',{name:'Voice call',exact:true}).waitFor({state:'hidden'});
  assert.equal(await caller.getByText('Call declined',{exact:true}).count(),0);
  await caller.waitForFunction(()=>!document.querySelector('.member-chat-call')?.disabled);
 }
 await caller.evaluate(()=>{navigator.mediaDevices.getUserMedia=async()=>{throw new DOMException('Synthetic denied permission','NotAllowedError');};});
 await callButton.click();
 await caller.getByText('Microphone permission was denied. Allow microphone access to make a voice call.',{exact:true}).waitFor();
 assert.equal(await caller.getByRole('region',{name:'Voice call',exact:true}).count(),0);
 assert.equal(await recipient.getByRole('region',{name:'Voice call',exact:true}).count(),0);
 assert.deepEqual(errors,[]);
 console.log('PASS: audible incoming/outgoing tones, accessible Hang up above expanded chat, cancel while ringing, tone/microphone cleanup, bidirectional WebRTC audio, mute, decline and denied permissions.');
}finally{for(const context of contexts)await context.close();await browser.close();}
