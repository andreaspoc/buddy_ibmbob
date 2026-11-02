// Run with node tests/test_office_bridge.js. Real browser/Office smoke tests complement these trust-boundary checks.
const vm = require('node:vm');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const source = fs.readFileSync('plugins/office/buddy_office/static/office-bridge/bridge.js', 'utf8');
function fixture(kind='word',cellApi={},pluginMethods={},documentKind) {
  let listener, calls=0, mutations=0, selected=null;
  const messages=[];
  const para=(text='')=>({GetText:()=>text,AddText:v=>{text+=v;},AddDrawing(d){this.drawings=(this.drawings||[]).concat([d]);},SetColor(...rgb){this.fontColor=rgb;},SetShd(...args){this.shading=args;},SetBold(){},SetItalic(){},SetStyle(){},SetJc(){},AddPageBreak(){},AddPageNumber(){text+='[PAGE]';}});
  const content=()=>({items:[],GetElement(i){return this.items[i];},GetAllParagraphs(){return this.items;},RemoveAllElements(){mutations++;this.items=[para()];},RemoveElement(i){mutations++;this.items.splice(i,1);},Push(p){mutations++;this.items.push(p);}});
  const header=content(),footer=content(),doc=content();doc.items=[para('Existing report')];
  Object.assign(doc,{GetRangeBySelect:()=>selected?{GetText:()=>doc.items[0].GetText().slice(selected[0],selected[1]),GetStartPos:()=>selected[0],GetEndPos:()=>selected[1]}:null,RemoveSelection(){selected=null;},InsertContent(blocks){const text=doc.items[0].GetText();const replacement=blocks.map(p=>p.GetText()).join('\n');doc.items[0]=para(selected?text.slice(0,selected[0])+replacement+text.slice(selected[1]):text+replacement);selected=null;mutations++;return true;},GetFinalSection:()=>({GetHeader:()=>header,GetFooter:()=>footer}),GetStyle:n=>n});
  const top={postMessage:m=>messages.push(m)};
  const sandbox={window:{top,addEventListener:(name,fn)=>listener=fn},location:{origin:'https://buddy.test'},Asc:{scope:{},plugin:{...pluginMethods,info:{editorType:kind},callCommand(fn,close,recalc,callback){calls++;callback(fn());}}},Api:{GetDocument:()=>doc,CreateParagraph:()=>para(),CreateTable:(cols,rows)=>{const cells=Array.from({length:rows},()=>Array.from({length:cols},()=>{const c=content();c.items=[para()];return {GetContent:()=>c,SetShd(...args){this.shading=args;}};}));return {cells,GetRow:r=>({GetCell:c=>cells[r][c]})};},...cellApi},setTimeout,clearTimeout,setInterval:()=>0,Promise,console};
  sandbox.window.Asc=sandbox.Asc;vm.createContext(sandbox);vm.runInContext(source,sandbox);sandbox.Asc.plugin.init();
  const emit=(data,origin='https://buddy.test',sender=top)=>listener({source:sender,origin,data:{bridge:'buddy-office',...data}});
  const channel='a'.repeat(32);emit({type:'connect',channel,kind:documentKind});
  async function request(command,payload,extra={}) { const id=String(messages.length);emit({type:'request',channel,id,command,payload,...extra});await new Promise(r=>setImmediate(r));return messages.find(m=>m.id===id); }
  return {request,emit,messages,header,footer,doc,select:(start,end)=>{selected=[start,end];},get calls(){return calls;},get mutations(){return mutations;}};
}
(async()=>{
  const f=fixture();let context=(await f.request('context')).result;
  assert.equal(context.text,'Existing report');assert.equal(context.truncated,false);assert.equal(f.mutations,0);
  const invoiceReplacement=fixture();const replacementContext=(await invoiceReplacement.request('context')).result;
  const replacementPlan={version:1,kind:'word',reply:'Synthetic invoice replacement',actions:[{type:'replace_document',blocks:[{type:'title',text:'Replacement invoice template'},{type:'paragraph',text:'Customer: [Customer name]'}]}]};
  const replacementResult=await invoiceReplacement.request('apply',{plan:replacementPlan,expectedContext:replacementContext});
  assert.equal(replacementResult.result.applied,1);
  assert.deepEqual(invoiceReplacement.doc.items.map(p=>p.GetText()),['Replacement invoice template','Customer: [Customer name]']);
  assert(!invoiceReplacement.doc.items.some(p=>p.GetText().includes('Existing report')),'replacement must remove original body instead of appending');

  const legacyNull=fixture();const legacyContext=(await legacyNull.request('context')).result;
  const nullablePlan={...replacementPlan,create_form:null};
  assert.equal((await legacyNull.request('apply',{plan:nullablePlan,expectedContext:legacyContext})).result.applied,1);
  const actualForm=fixture();const actualContext=(await actualForm.request('context')).result;
  assert.match((await actualForm.request('apply',{plan:{...replacementPlan,actions:[],create_form:{title:'New form'}},expectedContext:actualContext})).error,/reviewed form preview/);
  assert.equal(actualForm.mutations,0);

  const colored=fixture();const coloredContext=(await colored.request('context')).result;
  const coloredPlan={version:1,kind:'word',reply:'Synthetic color preview',actions:[{type:'insert_blocks',position:'end',blocks:[
    {type:'heading',text:'Branded invoice',font_color:'#8A3FFC',fill:'#F6F2FF'},
    {type:'table',rows:[['Description','Total'],['Synthetic item','[Amount]'],['Another item','[Amount]']],header:true,font_color:'#161616',header_font_color:'#FFFFFF',header_fill:'#123456',fill:'#FFFFFF',alternate_fill:'#E0F2F1'}]}]};
  const coloredResult=await colored.request('apply',{plan:coloredPlan,expectedContext:coloredContext});
  assert.equal(coloredResult.error,undefined);
  assert.equal(coloredResult.result.applied,1);
  assert.deepEqual(Array.from(colored.doc.items[1].fontColor),[138,63,252]);
  assert.deepEqual(Array.from(colored.doc.items[1].shading),['clear',246,242,255,false]);
  const coloredCells=colored.doc.items[2].cells;
  assert.deepEqual(Array.from(coloredCells[0][0].shading),['clear',18,52,86,false]);
  assert.deepEqual(Array.from(coloredCells[0][0].GetContent().items[0].fontColor),[255,255,255]);
  assert.deepEqual(Array.from(coloredCells[2][0].shading),['clear',224,242,241,false]);
  const modernColors=fixture('word',{HexColor:value=>({hex:value})});
  const modernContext=(await modernColors.request('context')).result;
  assert.equal((await modernColors.request('apply',{plan:coloredPlan,expectedContext:modernContext})).result.applied,1);
  assert.equal(modernColors.doc.items[1].fontColor[0].hex,'#8A3FFC');
  assert.equal(modernColors.doc.items[1].shading[1].hex,'#F6F2FF');
  const malformed=fixture();const badContext=(await malformed.request('context')).result;
  const badPlan=JSON.parse(JSON.stringify(coloredPlan));badPlan.actions[0].blocks[0].font_color='red;display:none';
  assert((await malformed.request('apply',{plan:badPlan,expectedContext:badContext})).error);
  assert.equal(malformed.mutations,0,'invalid colors must fail before document mutation');
  const large=fixture();large.doc.items=[{GetText:()=> 'x'.repeat(31000)}];
  const partial=(await large.request('context')).result;assert.equal(partial.truncated,true);assert.equal(partial.text.length,30000);
  f.emit({type:'request',channel:'a'.repeat(32),id:'bad',command:'context'},'https://evil.test');assert.equal(f.calls,1);
  const plan={version:1,kind:'word',reply:'Draft',actions:[{type:'set_header',text:'Company',alignment:'left'},{type:'set_footer',text:'Page',page_numbers:true}]};
  assert.equal((await f.request('apply',{plan,expectedContext:context})).result.applied,2);
  assert.equal(f.header.items[0].GetText(),'Company');assert.equal(f.footer.items[0].GetText(),'Page [PAGE]');
  assert.match((await f.request('apply',{plan,expectedContext:context})).error,/changed/);
  const before=f.mutations;plan.actions=[{type:'execute',code:'evil'}];assert.match((await f.request('apply',{plan,expectedContext:context})).error,/Unsupported/);assert.equal(f.mutations,before);
  plan.actions=[{type:'insert_blocks',position:'end',blocks:[{type:'paragraph',text:'hello',code:'evil'}]}];assert.match((await f.request('apply',{plan,expectedContext:context})).error,/Unknown field/);
  assert.match((await f.request('apply',{plan:{version:1,kind:'word',reply:'x',actions:[]}})).error,/context/);
  const g=fixture();g.select(9,15);const selectionContext=(await g.request('context')).result;
  assert.equal(selectionContext.selection,'report');
  const replacement={version:1,kind:'word',reply:'Replace selected text',actions:[{type:'insert_blocks',position:'replace_selection',blocks:[{type:'paragraph',text:'document'}]}]};
  assert.equal((await g.request('apply',{plan:replacement,expectedContext:selectionContext})).result.applied,1);
  assert.equal((await g.request('context')).result.text,'Existing document');
  const h=fixture();h.doc.items=[{GetText:()=> 'x'.repeat(13000)}];h.select(0,13000);
  assert.match((await h.request('context')).error,/Select less text/);
  let amount=100,reads=0;
  function columnIndex(name){return name.split('').reduce((n,c)=>n*26+c.charCodeAt(0)-64,0);}
  const cellValue=(r,c)=>r===7?({4:'Transaction date',5:'Description',6:'Costs',7:'Net profit'}[c]||''):r===8?({4:45550,5:'Synthetic row',6:20,7:amount}[c]||''):'';
  const used={GetAddress:()=> 'D7:ALP1000006',GetRowsCount:()=>1000000,GetColumnsCount:()=>1000};
  const cellSheet={GetName:()=> 'Revenue CY',GetUsedRange:()=>used,GetSelection:()=>cellSheet.GetRange('A1'),GetRange(address){
    const m=/^([A-Z]+)([0-9]+)(?::([A-Z]+)([0-9]+))?$/.exec(address);const left=columnIndex(m[1]),top=+m[2],right=columnIndex(m[3]||m[1]),bottom=+(m[4]||m[2]);
    const collect=(display=false)=>{assert.ok((bottom-top+1)*(right-left+1)<=800);reads++;return Array.from({length:bottom-top+1},(_,r)=>Array.from({length:right-left+1},(_,c)=>display&&top+r===8&&left+c===4?'2024-09-15':cellValue(top+r,left+c)));};
    return {GetAddress:()=>address,GetRowsCount:()=>bottom-top+1,GetColumnsCount:()=>right-left+1,GetValue:()=>collect(),GetText:()=>collect(true),GetFormula:()=>'',GetNumberFormat:()=>left===4&&top>7?'yyyy-mm-dd':'General'};
  }};
  const j=fixture('cell',{GetActiveSheet:()=>cellSheet,GetSheets:()=>[cellSheet]});
  const cellContext=(await j.request('context')).result;
  assert.equal(cellContext.sheet,'Revenue CY');assert.equal(cellContext.range,'A1');
  assert.equal(cellContext.workbook[0].used_range,'D7:ALP1000006');assert.equal(cellContext.workbook[0].range,'D7:W46');
  assert.equal(cellContext.workbook[0].values[0][3],'Net profit');assert.equal(cellContext.workbook[0].display_values[1][0],'2024-09-15');
  assert.equal(cellContext.workbook[0].number_formats.find(f=>f.column==='D').format,'yyyy-mm-dd');
  assert.equal(cellContext.workbook[0].truncated,true);assert.ok(reads<=85);assert.ok(JSON.stringify(cellContext.workbook).length<=30000);
  amount=200;const noOp={version:1,kind:'cell',reply:'No changes',actions:[]};
  assert.match((await j.request('apply',{plan:noOp,expectedContext:cellContext})).error,/changed since/);
  let addedCharts=[];
  const chartSheet={...cellSheet,AddChart:(range,byRows,type,style,w,h,col,colOff,row,rowOff)=>{const c={range,byRows,type,style,w,h,col,row,title:null,legend:null,SetTitle(t){this.title=t;},SetLegendPos(p){this.legend=p;},SetHorAxisTitle(){},SetVerAxisTitle(){}};addedCharts.push(c);return c;}};
  const k=fixture('cell',{GetActiveSheet:()=>chartSheet,GetSheets:()=>[chartSheet],GetSheet:(n)=>n==='Revenue CY'?chartSheet:null});
  const kCtx=(await k.request('context')).result;
  const chartPlan={version:1,kind:'cell',reply:'Chart added',actions:[{type:'add_chart',sheet:'Revenue CY',range:'D7:G8',chart_type:'bar',title:'Net Profit Chart',legend:'bottom',from_col:4,from_row:2,width_mm:160,height_mm:95},{type:'autofit_columns',sheet:'Revenue CY',range:'A1:D1'}]};
  assert.equal((await k.request('apply',{plan:chartPlan,expectedContext:kCtx})).result.applied,2);
  assert.equal(addedCharts.length,1);
  assert.equal(addedCharts[0].title,'Net Profit Chart');
  assert.equal(addedCharts[0].type,'bar');
  chartSheet.GetAllCharts=()=>addedCharts;
  const editChartContext=(await k.request('context')).result;
  assert.equal(editChartContext.charts[0].sheet,'Revenue CY');
  const editChartPlan={version:1,kind:'cell',reply:'Update existing chart',actions:[{type:'edit_chart',chart_index:1,sheet:'Revenue CY',slide_index:null,title:'Updated chart title',legend:'right',x_axis_title:null,y_axis_title:null,show_values:null,width:null,height:null}]};
  assert.equal((await k.request('apply',{plan:editChartPlan,expectedContext:editChartContext})).result.applied,1);
  assert.equal(addedCharts[0].title,'Updated chart title');assert.equal(addedCharts[0].legend,'right');assert.equal(addedCharts.length,1,'editing must not create a duplicate chart');

  // Native spreadsheet operations must preserve source values and target the requested worksheet.
  const toolCalls=[];
  const validation={Add(...args){toolCalls.push(['validation',...args]);return this;},Delete(){toolCalls.push(['validation-delete']);},SetInCellDropdown(){},SetShowError(){}};
  const condition={SetFillColor(c){toolCalls.push(['condition-fill',c]);}};
  const toolSheet={...cellSheet,GetRange(address){const r=cellSheet.GetRange(address);return Object.assign(r,{
    SetSort(...args){toolCalls.push(['sort',address,...args]);},SetAutoFilter(...args){toolCalls.push(['filter',address,...args]);},GetValidation:()=>validation,
    GetFormatConditions:()=>({Add(...args){toolCalls.push(['condition',...args]);return condition;}}),SetColumnWidth(n){toolCalls.push(['width',address,n]);},SetRowHeight(n){toolCalls.push(['height',address,n]);}
  });},GetSelection(){return this.GetRange('A1');},FormatAsTable(a){toolCalls.push(['table',a]);return true;},GetAutoFilter:()=>({ShowAllData(){toolCalls.push(['clear-filter']);}}),GetFreezePanes:()=>({FreezeAt(a){toolCalls.push(['freeze-at',a]);},FreezeRows(n){toolCalls.push(['freeze-rows',n]);},FreezeColumns(n){toolCalls.push(['freeze-cols',n]);},Unfreeze(){toolCalls.push(['unfreeze']);}}),SetDisplayGridlines(v){toolCalls.push(['gridlines',v]);},SetDisplayHeadings(){},SetPrintGridlines(){},SetPageOrientation(v){toolCalls.push(['orientation',v]);}};
  const tools=fixture('cell',{GetActiveSheet:()=>toolSheet,GetSheets:()=>[toolSheet],GetSheet:name=>name==='Revenue CY'?toolSheet:null,CreateColorFromRGB:(...rgb)=>rgb});
  const toolsContext=(await tools.request('context')).result;
  assert(toolsContext.editor_capabilities.includes('set_validation'));
  const toolsPlan={version:1,kind:'cell',reply:'Synthetic native operations',actions:[
    {type:'sort_range',sheet:null,range:'A1:C10',keys:[{column:2,order:'descending'}],headers:true},
    {type:'filter_range',sheet:null,range:'A1:C10',field:2,criteria:['Open'],operator:'xlFilterValues',criteria2:null,clear:false},
    {type:'create_table',sheet:null,range:'A1:C10'},
    {type:'set_validation',sheet:null,range:'C2:C10',rule:'list',operator:'between',formula1:'',formula2:'',options:['Open','Closed']},
    {type:'conditional_format',sheet:null,range:'B2:B10',rule:'cell_value',operator:'greater',formula1:'100',formula2:'',fill:'#123456'},
    {type:'freeze_panes',sheet:null,rows:1,columns:0,unfreeze:false},
    {type:'range_dimensions',sheet:null,range:'A1:C10',column_width:24,row_height:30},
    {type:'sheet_options',sheet:null,gridlines:false,headings:null,print_gridlines:null,orientation:'landscape'}
  ]};
  const toolsResult=await tools.request('apply',{plan:toolsPlan,expectedContext:toolsContext});assert.equal(toolsResult.error,undefined);assert.equal(toolsResult.result.applied,8);
  assert.equal(toolCalls.find(c=>c[0]==='sort')[2],'B1:B10');assert.equal(toolCalls.find(c=>c[0]==='sort')[3],'xlDescending');
  assert.equal(toolCalls.find(c=>c[0]==='validation')[1],'xlValidateList');assert.equal(toolCalls.find(c=>c[0]==='validation')[4],'"Open,Closed"');
  assert.deepEqual(Array.from(toolCalls.find(c=>c[0]==='condition-fill')[1]),[18,52,86]);assert(toolCalls.some(c=>c[0]==='freeze-rows'&&c[1]===1));
  assert.equal(toolCalls.filter(c=>c[0]==='setvalue').length,0,'functional controls never rewrite source data');
  // Native Word charts are actual inline drawing objects.
  const chartArgs=[];
  const wordChart=fixture('word',{CreateChart(...args){chartArgs.push(args);return {SetTitle(){},SetLegendPos(){}};}});
  const wordChartContext=(await wordChart.request('context')).result;
  const wordChartPlan={version:1,kind:'word',reply:'Synthetic native chart',actions:[{type:'add_word_chart',position:'end',width:150,height:90,chart_type:'bar',categories:['A','B'],series_names:['Values'],data:[[2,3]],title:'Synthetic data',legend:'bottom',style:2}]};
  assert.equal((await wordChart.request('apply',{plan:wordChartPlan,expectedContext:wordChartContext})).result.applied,1);assert.equal(wordChart.doc.items[1].drawings.length,1);assert.equal(chartArgs[0][4],150*36000);
  function slideParagraph(text=''){return {text,GetText(){return this.text;},AddText(value){this.text+=value;},SetTextPr(){},SetJc(){}};}
  function slideShape(text='',x=0,y=0,w=1000000,h=500000){
    const dc={items:[slideParagraph(text)],GetAllParagraphs(){return this.items;},GetElement(i){return this.items[i];},RemoveAllElements(){this.items=[slideParagraph()];},Push(p){this.items.push(p);}};
    return {kind:'shape',x,y,w,h,GetDocContent:()=>dc,GetPosX(){return this.x;},GetPosY(){return this.y;},GetWidth(){return this.w;},GetHeight(){return this.h;},SetPosition(x,y){this.x=x;this.y=y;return true;},SetSize(w,h){this.w=w;this.h=h;return true;}};
  }
  const deck=[];
  function slide(label){const s={objects:[slideShape(label)],visible:true,notes:'',GetAllShapes(){return this.objects.filter(o=>o.kind==='shape');},AddObject(o){this.objects.push(o);return true;},RemoveObject(o){this.objects.splice(this.objects.indexOf(o),1);return true;},SetVisible(v){this.visible=v;return true;},AddNotesText(t){this.notes+=t;return true;},Duplicate(pos){const copy=slide('Copied');deck.splice(pos,0,copy);return copy;},MoveTo(pos){deck.splice(deck.indexOf(this),1);deck.splice(pos,0,this);return true;},Delete(){deck.splice(deck.indexOf(this),1);return true;}};return s;}
  deck.push(slide('Selected label'),slide('Unrelated slide'));
  const selectedShape=deck[0].objects[0];
  const pres={GetSlidesCount:()=>deck.length,GetCurSlideIndex:()=>0,GetSlideByIndex:i=>deck[i],GetWidth:()=>254*36000,GetHeight:()=>142*36000};
  const slideApi={GetPresentation:()=>pres,GetSelection:()=>({GetShapes:()=>[selectedShape]}),CreateShape:(type,w,h)=>slideShape('',0,0,w,h),CreateNoFill:()=>null,CreateStroke:()=>({}),CreateRGBColor:(...v)=>v,CreateSolidFill:c=>c,
    CreateChart(){return {kind:'chart',SetPosition(){},SetTitle(){},SetLegendPos(){}};},
    CreateTable(cols,rows){const cells=Array.from({length:rows},()=>Array.from({length:cols},()=>({GetContent:()=>({GetElement:()=>slideParagraph()})})));return {kind:'table',SetPosition(){},SetSize(){},GetRow:r=>({GetCell:c=>cells[r][c]})};}};
  const slides=fixture('slide',slideApi);
  const slideContext=(await slides.request('context')).result;
  assert.equal(slideContext.current_slide,1);assert.equal(slideContext.slide_shapes[0].selected,true);assert.equal(slideContext.slide_shapes[0].text,'Selected label');
  const slidePlan={version:1,kind:'slide',reply:'Synthetic selected slide tools',actions:[
    {type:'replace_slide_text',slide_index:1,shape_index:1,old_text:'Selected label',text:'Updated label'},
    {type:'add_slide_table',slide_index:1,x:20,y:30,width:180,height:90,rows:[['A','B'],['One','Two']]},
    {type:'add_slide_chart',slide_index:1,x:20,y:30,width:180,height:90,chart_type:'bar',categories:['A','B'],series_names:['Values'],data:[[2,3]],title:'Synthetic values',legend:'bottom',style:2},
    {type:'add_slide_shape',slide_index:1,x:20,y:30,width:30,height:20,shape:'rightArrow',text:'Next',fill:'#8A3FFC',line_color:null},
    {type:'slide_operation',slide_index:1,operation:'notes',position:null,notes:'Synthetic speaker notes'},
  ]};
  const slideResult=await slides.request('apply',{plan:slidePlan,expectedContext:slideContext});assert.equal(slideResult.error,undefined);assert.equal(slideResult.result.applied,5);
  assert.equal(selectedShape.GetDocContent().GetAllParagraphs()[0].GetText(),'Updated label');assert.equal(deck[1].objects[0].GetDocContent().GetAllParagraphs()[0].GetText(),'Unrelated slide');assert.equal(deck[0].objects.length,4);assert.equal(deck[0].notes,'Synthetic speaker notes');
  const afterSlideContext=(await slides.request('context')).result;
  assert((await slides.request('apply',{plan:slidePlan,expectedContext:slideContext})).error,'stale object context must reject repeated application');
  const editObject={version:1,kind:'slide',reply:'Move selected shape',actions:[{type:'slide_object',slide_index:1,shape_index:1,operation:'move',x:15,y:20,width:null,height:null}]};
  assert.equal((await slides.request('apply',{plan:editObject,expectedContext:afterSlideContext})).result.applied,1);assert.equal(selectedShape.x,15*36000);
  // Synthetic native PDF objects exercise the bridge contract, not a real editor.
  let pdfOriginal='Original PDF text',rotation=0,pdfMutations=0,shapeArgs;
  function pdfContent(initial='') {
    const c={text:initial,size:null,GetAllParagraphs(){return [{GetText:()=>c.text}];},GetElement(){return {AddText(t){c.text+=t;return true;},SetFontSize(n){c.size=n;return true;}};},RemoveAllElements(){pdfMutations++;c.text='';return true;}};
    return c;
  }
  const originalContent=pdfContent('Editable box');
  const pdfDrawings=[{GetContent:()=>originalContent}];
  const pdfPage={GetAllDrawings:()=>pdfDrawings,GetText:()=>pdfOriginal,GetSelectedText:()=>'',GetRotation:()=>rotation,SetRotation(n){pdfMutations++;rotation=n;return true;},AddObject(s){pdfMutations++;pdfDrawings.push(s);return s;}};
  const pdfApi={GetDocument:()=>({GetPagesCount:()=>1,GetPage:()=>pdfPage}),CreateNoFill:()=>({}),CreateStroke:()=>({}),CreateShape(...args){shapeArgs=args;const c=pdfContent();return {SetPosition(x,y){this.position=[x,y];},GetContent:()=>c};}};
  const disguisedPdf=fixture('word',pdfApi,{},'pdf');
  assert.equal((await disguisedPdf.request('context')).result.kind,'pdf');
  const pdf=fixture('pdf',pdfApi);
  let pc=(await pdf.request('context')).result;
  assert.equal(pc.page_count,1);assert.equal(pc.text,'Page 1:\nOriginal PDF text');assert.equal(pc.pages[0].objects[0].object_index,1);
  assert.deepEqual(Array.from(pc.capabilities),['pdf_add_text','pdf_rotate_page','pdf_update_text']);
  const pdfPlan={version:1,kind:'pdf',reply:'Draft PDF changes',actions:[{type:'pdf_update_text',page:1,object_index:1,old_text:'Editable box',text:'Rewritten box',font_size:12},{type:'pdf_add_text',page:1,x:10,y:15,width:100,height:20,text:'Added text',font_size:10},{type:'pdf_rotate_page',page:1,angle:90}]};
  assert.equal((await pdf.request('apply',{plan:pdfPlan,expectedContext:pc})).result.applied,3);
  assert.equal(originalContent.text,'Rewritten box');assert.equal(originalContent.size,24);assert.equal(rotation,90);
  assert.equal(shapeArgs[1],3600000);assert.deepEqual(Array.from(pdfDrawings[1].position),[360000,540000]);
  assert.equal(pdfDrawings[1].GetContent().text,'Added text');
  assert.match((await pdf.request('apply',{plan:pdfPlan,expectedContext:pc})).error,/changed/);
  pc=(await pdf.request('context')).result;
  const preflightPlan={version:1,kind:'pdf',reply:'Preflight',actions:[{type:'pdf_rotate_page',page:1,angle:180},{type:'pdf_update_text',page:1,object_index:1,old_text:'wrong old text',text:'bad'}]};
  const pm=pdfMutations;
  assert.match((await pdf.request('apply',{plan:preflightPlan,expectedContext:pc})).error,/text object changed/);assert.equal(pdfMutations,pm);
  preflightPlan.actions=[{type:'pdf_rotate_page',page:2,angle:180}];
  assert.match((await pdf.request('apply',{plan:preflightPlan,expectedContext:pc})).error,/does not exist/);assert.equal(pdfMutations,pm);
  preflightPlan.actions=[{type:'pdf_add_text',page:1,x:NaN,y:0,width:100,height:20,text:'invalid'}];
  assert.match((await pdf.request('apply',{plan:preflightPlan,expectedContext:pc})).error,/coordinates/);
  preflightPlan.actions=[{type:'pdf_rotate_page',page:1,angle:45}];
  assert.match((await pdf.request('apply',{plan:preflightPlan,expectedContext:pc})).error,/rotation/);
  // Fingerprint the full native page text even when the model receives a bounded excerpt.
  pdfOriginal='x'.repeat(31000)+'old';pc=(await pdf.request('context')).result;assert.equal(pc.truncated,true);
  pdfOriginal='x'.repeat(31000)+'new';
  preflightPlan.actions=[{type:'pdf_rotate_page',page:1,angle:180}];
  assert.match((await pdf.request('apply',{plan:preflightPlan,expectedContext:pc})).error,/changed/);
  // Community/older editor APIs expose the accessible drawing context honestly.
  pdfPage.GetText=()=>{throw new Error('Paid feature unavailable');};
  pc=(await pdf.request('context')).result;assert.equal(pc.text_available,false);assert.equal(pc.truncated,true);assert.match(pc.text,/Rewritten box/);
  const unavailable=fixture('pdf',{GetDocument:()=>({})});
  const uc=(await unavailable.request('context')).result;assert.equal(uc.page_count,0);assert.equal(uc.capabilities.length,0);
  pdfPage.GetAllDrawings=()=>{throw new Error('Unavailable drawing API');};pdfPage.GetSelectedText=()=>{throw new Error('Unavailable selection API');};
  pc=(await pdf.request('context')).result;assert.equal(pc.capabilities.length,0);assert.equal(pc.text_available,false);
  const noApi=fixture('pdf',{GetDocument:undefined});assert.equal((await noApi.request('context')).result.capabilities.length,0);
  const tooManyPages=fixture('pdf',{GetDocument:()=>({GetPagesCount:()=>201})});assert.match((await tooManyPages.request('context')).error,/at most 200 pages/);
  let slideshowCalls = 0;
  const slideShow = fixture('slide', {}, {executeMethod(method, args, callback) {
    assert.equal(method, 'StartSlideShow'); assert.equal(args.length, 0); slideshowCalls++; callback();
  }});
  assert.equal((await slideShow.request('present')).result.ok, true);
  assert.equal(slideshowCalls, 1);
  assert.equal(slideShow.calls, 0, 'Presentation mode must not execute document commands');
  assert.match((await f.request('present')).error, /cannot start/);
  console.log('Office bridge trust, context, native header/footer, stale edit, selected rewrite, selection limit, bounded workbook metadata, stale samples, native charts, and allowlist checks passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
