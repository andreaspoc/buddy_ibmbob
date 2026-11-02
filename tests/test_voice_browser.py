"""Synthetic speech-recognition/audio fixtures exercise the real chat and voice controls."""
import asyncio,json
from urllib.parse import urlsplit
from playwright.async_api import async_playwright,expect

async def main():
 async with async_playwright() as p:
  browser=await p.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox','--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--autoplay-policy=no-user-gesture-required'])
  page=await browser.new_page(viewport={'width':1280,'height':1000})
  errors,sent,spoken=[],[],[]
  page.on('pageerror',lambda e:errors.append(str(e)))
  await page.add_init_script('''
    sessionStorage.setItem('buddy-welcome-v1:voice-fixture','seen');
    window.noteChanges=0;window.addEventListener('buddy-notes-changed',()=>window.noteChanges++);
    window.voiceSockets=[];window.voiceTexts=[];window.capturedBytes=0;window.stoppedBuffers=0;window.voiceTracks=[];
    const nativeFetch=window.fetch;
    window.fetch=async (input,options)=>{
      if(input==='/chat/stream'){
        window.lastVoicePayload=JSON.parse(options.body);
        return new Response(new ReadableStream({start(controller){
          const encoder=new TextEncoder();
          const route={job_id:'voice-job-fixture',workspace_id:lastVoicePayload.workspace_id,correlation_id:lastVoicePayload.correlation_id,user_message_id:lastVoicePayload.user_message_id,assistant_message_id:lastVoicePayload.assistant_message_id};
          controller.enqueue(encoder.encode(JSON.stringify({...route,type:'app_action',action:'notes_changed',note_id:41})+'\\n'+JSON.stringify({...route,type:'start'})+'\\n'+JSON.stringify({...route,type:'delta',text:'The synthetic voice response is ready.\\n\\n```bobquestion\\n{"question":"Which next?","options":["One","Two"]}\\n```'})+'\\n'));
          window.finishVoiceResponse=()=>{controller.enqueue(encoder.encode(JSON.stringify({...route,type:'done'})+'\\n'));controller.close();};
          options.signal?.addEventListener('abort',()=>controller.error(new DOMException('Aborted','AbortError')));
        }}),{headers:{'Content-Type':'application/x-ndjson','X-Bob-Job-Id':'voice-job-fixture'}});
      }
      return nativeFetch(input,options);
    };
    const nativeMedia=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia=async options=>{const stream=await nativeMedia(options);window.voiceTracks.push(...stream.getTracks());return stream;};
    const nativeStop=AudioBufferSourceNode.prototype.stop;
    AudioBufferSourceNode.prototype.stop=function(...args){window.stoppedBuffers++;return nativeStop.apply(this,args);};
    const NativeWebSocket=window.WebSocket;
    window.WebSocket=class {
      static OPEN=1;
      constructor(url,protocols){
        url=String(url);
        if(!url.includes('/voice/'))return new NativeWebSocket(url,protocols);
        this.url=url;this.readyState=1;this.bufferedAmount=0;window.voiceSockets.push(this);
        setTimeout(()=>{this.onopen?.({});if(url.includes('/listen'))this.emit({type:'ready'});},30);
      }
      emit(data){if(this.readyState===1)this.onmessage?.({data:JSON.stringify(data)});}
      send(raw){
        if(raw instanceof ArrayBuffer){window.capturedBytes+=raw.byteLength;return;}
        const data=JSON.parse(raw);
        if(data.voice_id){setTimeout(()=>this.emit({type:'ready'}),10);return;}
        if(data.text){
          window.voiceTexts.push(data.text);
          if(!this.sentAudio){this.sentAudio=true;setTimeout(()=>{if(this.readyState===1)this.onmessage?.({data:new Int16Array(24000*20).buffer});},20);}
        }
        if(data.done)setTimeout(()=>this.emit({type:'done'}),40);
      }
      close(){this.readyState=3;this.onclose?.({});}
    };
    window.sayFixture=text=>{const socket=voiceSockets.findLast(s=>s.url.includes('/listen')&&s.readyState===1);socket.emit({type:'partial',text});socket.emit({type:'transcript',text});};
  ''')
  async def route(r):
   path=urlsplit(r.request.url).path
   if path=='/' or path.startswith(('/assets/','/static/')):
    await r.continue_();return
   data=[]
   if path=='/auth/status':data={'user':{'username':'voice-fixture','display_name':'Voice Fixture','is_admin':False}}
   elif path=='/personalization/tutorials':data={'disabled':True}
   elif path=='/sessions':data={'id':'voice-session'} if r.request.method=='POST' else [{'id':'voice-session','title':'Voice fixture','updated_at':1}]
   elif path.endswith('/history'):data=[{'type':'request','prompt':'Fixture request','mode':'agent'},{'type':'delta','text':'A synthetic saved answer.'},{'type':'done'}]
   elif path.endswith('/cancel'):data={'status':'cancelled'}
   elif path=='/presentation/intent':data={'presentation':False,'templates':[],'format':None,'slide_count':None}
   elif path=='/voice/voices':data={'voices':[{'id':'fixture-voice','name':'Fixture Voice'}],'default_voice_id':'fixture-voice'}
   elif path=='/voice/speech':
    raise AssertionError('Live mode must stream over WebSockets, not buffer an HTTP audio reply')
   elif path=='/chat/stream':
    sent.append(r.request.post_data_json)
    await r.fulfill(content_type='application/x-ndjson',body='\n'.join(json.dumps(e) for e in [{'type':'start'},{'type':'delta','text':'The synthetic voice response is ready.\n\n```bobquestion\n{"question":"Which next?","options":["One","Two"]}\n```'},{'type':'done','tokens':1}])+'\n');return
   elif path.startswith('/auth/microsoft'):data={'configured':False,'connected':False}
   elif path.endswith('/files'):data={'files':[]}
   await r.fulfill(json=data)
  await page.route('**/*',route)
  await page.goto('http://127.0.0.1:8080/?conversation=voice-session')
  await expect(page.locator('.message.assistant')).to_be_visible()
  await page.get_by_role('button',name='Voice chat',exact=True).click()
  await page.get_by_role('button',name='Start conversation',exact=True).click()
  status=page.locator('.voice-chat-heading [role=status]')
  await expect(status).to_have_text('Listening')
  await page.evaluate("sayFixture('Explain the synthetic fixture')")
  try:
   await expect(status).to_have_text('Speaking',timeout=15000)
  except Exception:
   print('Voice debug',await page.evaluate('({texts:voiceTexts,sockets:voiceSockets.map(s=>({url:s.url,state:s.readyState})),payload:lastVoicePayload})'),flush=True)
   print('Assistant debug',await page.locator('.message.assistant').all_inner_texts(),errors,flush=True)
   raise
  payload=await page.evaluate('lastVoicePayload')
  assert payload['prompt']=='Explain the synthetic fixture',payload
  assert payload['voice_mode'] is True,payload
  assert isinstance(payload['client_timezone'],str) and payload['client_timezone']
  assert await page.evaluate('noteChanges>0'), 'Successful app actions must refresh the Notes UI'
  await expect(page.locator('.stop-button')).to_be_visible()  # Speech begins before Buddy finishes generating.
  texts=await page.evaluate("voiceTexts.join(' ')")
  assert 'synthetic voice response is ready' in texts,texts
  assert 'bobquestion' not in texts and 'Which next' not in texts,texts
  assert await page.evaluate('voiceTracks.at(-1).enabled'), 'Microphone stays available for automatic interruption'
  await page.wait_for_function('capturedBytes>0')
  await page.evaluate("voiceSockets.findLast(s=>s.url.includes('/listen')&&s.readyState===1).emit({type:'partial',text:'Let me interrupt'})")
  await expect(status).to_have_text('Listening')
  assert await page.evaluate('stoppedBuffers>0'), 'Speaking must stop automatically on user speech'
  await page.get_by_role('button',name='Mute',exact=True).click()
  assert not await page.evaluate('voiceTracks.at(-1).enabled')
  await page.get_by_role('button',name='Unmute',exact=True).click()
  assert await page.evaluate('voiceTracks.at(-1).enabled')
  await page.get_by_role('button',name='End conversation',exact=True).click()
  assert await page.evaluate("voiceTracks.every(t=>t.readyState==='ended')")
  await page.get_by_role('button',name='Read aloud',exact=True).last.click()
  await expect(status).to_have_text('Speaking')
  await page.get_by_role('button',name='Stop audio',exact=True).click()
  await expect(status).to_have_text('Ready')
  await page.set_viewport_size({'width':390,'height':844})
  await page.wait_for_timeout(400)  # Let the existing sidebar's responsive transition finish before capture.
  box=await page.locator('.voice-chat-panel').bounding_box()
  assert box['x']>=0 and box['x']+box['width']<=391,box
  await page.screenshot(path='/tmp/buddy-voice-mobile.png')
  assert not await page.evaluate('document.documentElement.scrollWidth>innerWidth+1')
  await page.get_by_role('button',name='Start conversation',exact=True).click()
  await expect(status).to_have_text('Listening')
  await page.get_by_role('button',name='Close voice chat',exact=True).click()
  assert await page.evaluate("voiceTracks.every(t=>t.readyState==='ended')")
  assert not errors,errors
  print('PASS: real microphone capture/worklet, streamed PCM playback, voice discussion flag, no spoken follow-up forms, automatic interruption, mute/unmute, read aloud, mobile layout, and cleanup; synthetic provider fixtures, no browser errors')
  await browser.close()
asyncio.run(main())
