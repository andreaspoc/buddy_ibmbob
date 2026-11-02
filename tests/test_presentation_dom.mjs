import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {transpile} from './frontend_transpile.mjs';
const {syncPresentationDocument} = await import(`data:text/javascript;base64,${Buffer.from(transpile(readFileSync(new URL('../web/src/lib/presentationDom.ts',import.meta.url),'utf8'))).toString('base64')}`);
// A DOM contract fixture deliberately uses no browser Element constructor:
// documents in an iframe belong to a different realm than their parent editor.
class Node {
  constructor(name, attrs={}, text=null) {this.nodeName=name;this.tagName=name;this.nodeType=text===null?1:3;this.nodeValue=text;this.attrs={...attrs};this.childNodes=[];this.parentNode=null;this.scrollTop=0;this.scrollLeft=0;}
  get attributes(){return Object.entries(this.attrs).map(([name,value])=>({name,value}));}
  get children(){return this.childNodes.filter(node=>node.nodeType===1);}
  get firstChild(){return this.childNodes[0]||null;}
  get nextSibling(){return this.parentNode?.childNodes[this.parentNode.childNodes.indexOf(this)+1]||null;}
  get id(){return this.attrs.id||'';}
  get src(){return this.attrs.src||'';}
  get isConnected(){return this.root||!!this.parentNode?.isConnected;}
  get textContent(){return this.nodeType===3?this.nodeValue:this.childNodes.map(child=>child.textContent).join('');}
  set textContent(value){this.childNodes=[];if(value)this.insertBefore(new Node('#text',{},value),null);}
  getAttribute(name){return this.attrs[name]??null;}
  hasAttribute(name){return name in this.attrs;}
  setAttribute(name,value){this.attrs[name]=value;}
  removeAttribute(name){delete this.attrs[name];}
  insertBefore(node,before){node.remove();const index=before?this.childNodes.indexOf(before):this.childNodes.length;this.childNodes.splice(index,0,node);node.parentNode=this;return node;}
  remove(){if(this.parentNode){this.parentNode.childNodes.splice(this.parentNode.childNodes.indexOf(this),1);this.parentNode=null;}}
  replaceWith(node){const parent=this.parentNode;parent.insertBefore(node,this);this.remove();}
  replaceChild(node,old){old.replaceWith(node);}
  querySelectorAll(selector){const result=[];for(const child of this.children){if(selector==='*'||child.tagName===selector.toUpperCase())result.push(child);result.push(...child.querySelectorAll(selector));}return result;}
  clone(){const node=new Node(this.nodeName,this.attrs,this.nodeType===3?this.nodeValue:null);for(const child of this.childNodes)node.insertBefore(child.clone(),null);return node;}
}
const el=(tag,id,text)=>{const node=new Node(tag.toUpperCase(),id?{id}:{});if(text)node.textContent=text;return node;};
function document(body) {
  const root=el('html');root.root=true;const head=el('head');root.insertBefore(head,null);root.insertBefore(body,null);
  const doc={documentElement:root,head,body,querySelectorAll:selector=>root.querySelectorAll(selector),importNode:node=>node.clone(),createElement:tag=>el(tag),defaultView:{scrollX:5,scrollY:80,scrollTo(x,y){this.scrollX=x;this.scrollY=y;}}};return doc;
}
const body=el('body');const frame=el('div','frame');const title=el('h2','title','Before');const chart=el('canvas','chart');chart.setAttribute('width','900');chart.context={rendered:true};frame.insertBefore(title,null);frame.insertBefore(chart,null);body.insertBefore(frame,null);const footer=el('p','footer','Footer');body.insertBefore(footer,null);frame.scrollTop=120;
const doc=document(body);const script=el('script','init','window.boots++');doc.head.insertBefore(script,null);
let incoming;
globalThis.DOMParser=class {parseFromString(){return incoming;}};
const nextBody=el('body');const nextFrame=el('div','frame');nextFrame.insertBefore(el('h2','title','After'),null);nextFrame.insertBefore(el('canvas','chart'),null);nextFrame.insertBefore(el('img','photo'),null);nextBody.insertBefore(el('p','footer','Updated footer'),null);nextBody.insertBefore(nextFrame,null);incoming=document(nextBody);incoming.head.insertBefore(el('script','init','window.boots++'),null);
syncPresentationDocument(doc,'snapshot');
assert.equal(doc.body,body);assert.equal(body.children[1],frame,'Keyed frame reordering preserves identity');assert.equal(frame.children[0],title);assert.equal(title.textContent,'After');assert.equal(frame.children[1],chart);assert.ok(chart.context.rendered);assert.equal(chart.getAttribute('width'),'900');assert.equal(frame.scrollTop,120);assert.equal(doc.defaultView.scrollY,80);assert.equal(doc.head.children[0],script,'Existing scripts must not restart');assert.equal(frame.children[2].id,'photo');
const same=incoming;syncPresentationDocument(doc,'same snapshot');assert.equal(frame.children[1],chart);
nextFrame.children[2].remove();incoming=same;syncPresentationDocument(doc,'remove photo');assert.equal(frame.children.length,2);assert.equal(frame.children[0],title);
console.log('Incremental DOM updates preserve frame, text, chart, script, and scroll state.');
