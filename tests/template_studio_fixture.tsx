// Synthetic catalog and network responses for isolated browser verification.
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {TemplatePickerModal} from '../web/src/components/TemplatePickerModal';
import {defaultTemplateDesign} from '../web/src/lib/templateDesign';
import type {PresentationTemplate} from '../web/src/types';
import {setLanguage, t} from '../web/src/lib/i18n';
import '../web/src/styles.css';
const starterConfig={...defaultTemplateDesign,title:'Synthetic starter',brand:'Synthetic brand',design:{shape:'ellipse',decoration:'sidebar',cardBorderWidth:3}};
const starter:PresentationTemplate={...starterConfig,id:'synthetic-starter',themeId:'synthetic-starter',slidesCount:3,slidePreviews:[],colors:{...starterConfig.colors,chartPalette:[]}};
const catalog: PresentationTemplate[]=[starter];
const realFetch=window.fetch.bind(window);
(window as any).fixtureState={failSave:true,requests:[],confirmed:[],briefs:[]};
(window as any).setTemplateLanguage=setLanguage;
(window as any).translateTemplateText=t;
window.fetch=async(input,init)=>{
 const path=typeof input==='string'?input:input instanceof URL?input.pathname:input.url;
 if(path==='/presentation/templates/synthetic-starter') return new Response(JSON.stringify({metadata:{studioConfig:starterConfig},theme:{colors:starterConfig.colors}}),{headers:{'Content-Type':'application/json'}});
 if(path==='/presentation/template-drafts?session_id=synthetic-studio') {
  if((window as any).fixtureState.draftDelay) await new Promise(resolve=>setTimeout(resolve,(window as any).fixtureState.draftDelay));
  if((window as any).fixtureState.failDrafts) return new Response('{}',{status:503,headers:{'Content-Type':'application/json'}});
  return new Response(JSON.stringify({drafts:[{path:'synthetic.bobtemplate.json',config:{...defaultTemplateDesign,title:'Synthetic Bob draft'}}]}),{headers:{'Content-Type':'application/json'}});
 }
 if(path==='/presentation/templates'){
  if(init?.method==='POST'){
   const body=JSON.parse(String(init.body));
   (window as any).fixtureState.requests.push(body);
   if((window as any).fixtureState.failSave) return new Response(JSON.stringify({detail:'Synthetic save failure: please retry'}),{status:503,headers:{'Content-Type':'application/json'}});
   const template={...body,id:'custom-fixture-theme',themeId:'custom-fixture-theme',slidesCount:3,slidePreviews:[],colors:{...body.colors,chartPalette:[body.colors.primary,body.colors.secondary,body.colors.accent]}};
   catalog.push(template);
   return new Response(JSON.stringify(template),{status:201,headers:{'Content-Type':'application/json'}});
  }
  return new Response(JSON.stringify(catalog),{headers:{'Content-Type':'application/json'}});
 }
 return realFetch(input,init);
};
function Fixture(){
 const [templates,setTemplates]=useState<PresentationTemplate[]>([starter]);
 const [selected,setSelected]=useState('');
 const [prompt,setPrompt]=useState('Synthetic presentation fixture');
 const [format,setFormat]=useState<'html'|'pptx'>('html');
 const [count,setCount]=useState(3);
 return <TemplatePickerModal isOpen initialStudioOpen sessionId="synthetic-studio" onAskBob={brief=>{(window as any).fixtureState.briefs.push(brief)}} templates={templates} selectedTemplateId={selected} onSelect={setSelected} slideCount={count} onSlideCountChange={setCount} prompt={prompt} onPromptChange={setPrompt} format={format} onFormatChange={setFormat} onClose={()=>{}} onTemplateSaved={template=>{setTemplates(previous=>[...previous,template]);setSelected(template.id)}} onConfirm={()=>{(window as any).fixtureState.confirmed.push({format,selected})}}/>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
