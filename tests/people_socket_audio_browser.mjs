// Real Buddy HTTPS/WSS with disposable members and test microphones; WebRTC is deliberately forbidden.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const {chromium}=await import(process.env.CARBON_PLAYWRIGHT_MODULE||'playwright');
const fixture=JSON.parse(await readFile('/tmp/people-voice-fixture.json','utf8'));
const base=process.env.CARBON_PREVIEW_URL||'https://192.0.2.10';
const browser=await chromium.launch({args:['--no-sandbox','--ignore-certificate-errors','--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream','--autoplay-policy=no-user-gesture-required']});
const contexts=[],pages=[],errors=[];
try{
 for(const user of fixture.users.slice(0,2)){
  const context=await browser.newContext({viewport:{width:1440,height:1000},ignoreHTTPSErrors:true,permissions:['microphone']});contexts.push(context);
  await context.addCookies([{name:user.cookie,value:user.token,url:base,httpOnly:true,secure:base.startsWith('https:'),sameSite:'Lax'}]);
  const page=await context.newPage();pages.push(page);page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(user=>{
   sessionStorage.setItem(`buddy-approval-guide:${user.username}`,'seen');sessionStorage.setItem(`buddy-welcome-v1:${user.username}`,'seen');
   window.voiceTestStreams=[];window.voiceTestSockets=[];window.voiceTestFrames=[];window.voiceTestPlayback=[];
   const getMedia=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
   navigator.mediaDevices.getUserMedia=async constraints=>{if(constraints.video!==false)throw Error('Camera requested');const stream=await getMedia(constraints);window.voiceTestStreams.push(stream);return stream;};
   window.RTCPeerConnection=class{constructor(){throw Error('WebRTC must not be used in 443-only calls');}};
   const Socket=window.WebSocket;window.WebSocket=class extends Socket{constructor(...args){super(...args);window.voiceTestSockets.push(String(args[0]));}send(data){if(data instanceof ArrayBuffer)window.voiceTestFrames.push(data.byteLength);return super.send(data);}};
   const Context=window.AudioContext;window.AudioContext=class extends Context{createBufferSource(){const source=super.createBufferSource();const start=source.start.bind(source);source.start=(...args)=>{if(source.buffer?.sampleRate===16000){const energy=Math.max(...source.buffer.getChannelData(0).map(Math.abs));const record={energy,ended:false};window.voiceTestPlayback.push(record);source.addEventListener('ended',()=>record.ended=true);}return start(...args);};return source;}};
  },user);
  await page.route('**/personalization/tutorials',r=>r.fulfill({json:{disabled:true}}));
  await page.goto(base);await page.locator('.member-chat-launcher').waitFor();
 }
 const [caller,recipient]=pages;
 await caller.evaluate(roomId=>window.dispatchEvent(new CustomEvent('community-open-room',{detail:{roomId,kind:'direct'}})),fixture.room_id);
 const phone=caller.getByRole('button',{name:'Start voice call',exact:true});await phone.waitFor();await caller.waitForFunction(()=>!document.querySelector('.member-chat-call')?.disabled);
 await phone.click();await recipient.getByRole('button',{name:'Answer',exact:true}).waitFor();
 assert.equal(await recipient.evaluate(()=>window.voiceTestStreams.length),0);
 await recipient.getByRole('button',{name:'Answer',exact:true}).click();
 for(const page of pages){
  await page.getByText('Voice call connected',{exact:true}).waitFor({timeout:30000});
  await page.waitForFunction(()=>window.voiceTestPlayback.some(frame=>frame.energy>.0001),undefined,{timeout:20000});
  assert(await page.evaluate(()=>window.voiceTestFrames.length>0&&window.voiceTestFrames.every(bytes=>bytes===4124)),'Audio frames must include nonce and authentication tag');
  const urls=await page.evaluate(()=>window.voiceTestSockets.filter(url=>url.includes('/api/community')));
  assert(urls.some(url=>/\/calls\/[^/]+\/audio$/.test(new URL(url).pathname)));
  for(const url of urls){const u=new URL(url),expected=new URL(base);assert.equal(u.host,expected.host);assert.equal(u.protocol,expected.protocol==='https:'?'wss:':'ws:');if(expected.protocol==='https:')assert(['','443'].includes(u.port));}
 }
 await caller.getByRole('button',{name:'Mute microphone',exact:true}).click();assert(await caller.evaluate(()=>window.voiceTestStreams.at(-1).getAudioTracks().every(track=>!track.enabled)));
 await caller.getByRole('button',{name:'Unmute microphone',exact:true}).click();assert(await caller.evaluate(()=>window.voiceTestStreams.at(-1).getAudioTracks().every(track=>track.enabled)));
 await caller.getByRole('button',{name:'Hang up',exact:true}).click();await recipient.getByRole('region',{name:'Voice call',exact:true}).waitFor({state:'hidden'});
 for(const page of pages){assert(await page.evaluate(()=>window.voiceTestStreams.every(stream=>stream.getTracks().every(track=>track.readyState==='ended'))));}
 assert.deepEqual(errors,[]);
 console.log('PASS: bidirectional encrypted audio and decoded sound using only Buddy HTTPS/WSS on 443; no WebRTC, TURN or additional ports; consent, mute/unmute and hang-up cleanup.');
}finally{for(const context of contexts)await context.close();await browser.close();}
