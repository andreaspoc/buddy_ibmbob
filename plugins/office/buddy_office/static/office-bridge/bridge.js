/* Fixed Office tools: model output is data, never executable code. */
(function () {
  'use strict';
  var channel = null, documentKind = null, queue = Promise.resolve(), ready = false, stalled = false;
  function send(data) { window.top.postMessage(Object.assign({ bridge: 'buddy-office', channel: channel }, data), location.origin); }
  function fail(message) { throw new Error(message); }
  function object(value, keys) { if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Expected object'); Object.keys(value).forEach(function (key) { if (keys.indexOf(key) < 0) fail('Unknown field: ' + key); }); }
  function str(value, max) { if (typeof value !== 'string' || value.length > max) fail('Invalid text'); }
  function bool(value) { if (value !== undefined && value !== null && typeof value !== 'boolean') fail('Invalid boolean'); }
  function alignment(value) { if (value !== undefined && ['left', 'center', 'right'].indexOf(value) < 0) fail('Invalid alignment'); }
  function range(value, maxRows, maxCols) {
    str(value, 25); var m = /^\$?([A-Z]{1,3})\$?([1-9][0-9]{0,6})(?::\$?([A-Z]{1,3})\$?([1-9][0-9]{0,6}))?$/.exec(value);
    if (!m) fail('Invalid cell range');
    function col(s) { return s.split('').reduce(function (v, c) { return v * 26 + c.charCodeAt(0) - 64; }, 0); }
    var c = col(m[1]), r = +m[2], c2 = col(m[3] || m[1]), r2 = +(m[4] || m[2]);
    if (c2 < c || r2 < r || c2 > 16384 || r2 > 1048576 || c2 - c >= (maxCols||30) || r2 - r >= (maxRows||200)) fail('Cell range exceeds editing limits');
    return [r2 - r + 1, c2 - c + 1];
  }
  function chartRange(value) {
    str(value, 80); var m = /^(?:'[^'\[\]:*?/\\]{1,31}'!|[A-Za-z0-9_.\-]{1,31}!)?\$?([A-Z]{1,3})\$?([1-9][0-9]{0,6})(?::\$?([A-Z]{1,3})\$?([1-9][0-9]{0,6}))?$/.exec(value);
    if (!m) fail('Invalid chart range');
    function col(s) { return s.split('').reduce(function (v, c) { return v * 26 + c.charCodeAt(0) - 64; }, 0); }
    var c = col(m[1]), r = +m[2], c2 = col(m[3] || m[1]), r2 = +(m[4] || m[2]);
    if (c2 < c || r2 < r || c2 > 16384 || r2 > 1048576) fail('Chart range exceeds sheet limits');
    return [r2 - r + 1, c2 - c + 1];
  }
  function colors(value, keys) {
    keys.forEach(function(key) { if(value[key] !== undefined && value[key] !== null && (typeof value[key] !== 'string' || !/^#[0-9a-f]{6}$/i.test(value[key]))) fail('Invalid color'); });
  }
  function blocks(list) {
    if (!Array.isArray(list) || !list.length || list.length > 120) fail('Invalid document blocks');
    list.forEach(function (b) {
      if (['paragraph', 'heading', 'title'].indexOf(b.type) >= 0) {
        object(b, ['type','text','level','bold','italic','alignment','font_color','fill']); str(b.text, 12000); colors(b,['font_color','fill']); bool(b.bold); bool(b.italic); alignment(b.alignment);
        if (b.level !== undefined && (!Number.isInteger(b.level) || b.level < 1 || b.level > 6)) fail('Invalid heading level');
      } else if (b.type === 'table') {
        object(b, ['type','rows','header','font_color','fill','header_font_color','header_fill','alternate_fill']); colors(b,['font_color','fill','header_font_color','header_fill','alternate_fill']); bool(b.header);
        if (!Array.isArray(b.rows) || !b.rows.length || b.rows.length > 30 || !Array.isArray(b.rows[0]) || !b.rows[0].length || b.rows[0].length > 12) fail('Invalid table');
        b.rows.forEach(function (row) { if (!Array.isArray(row) || row.length !== b.rows[0].length) fail('Uneven table'); row.forEach(function (v) { str(v, 2000); }); });
      } else if (b.type === 'page_break') object(b, ['type']); else fail('Unsupported block');
    });
  }
  function toolAction(a, kind) {
    function number(v,min,max) { if(typeof v!=='number'||!Number.isFinite(v)||v<min||v>max)fail('Invalid tool number'); }
    function choice(v,items) { if(items.indexOf(v)<0)fail('Unsupported tool option'); }
    function index(v,max) { number(v,1,max);if(!Number.isInteger(v))fail('Invalid tool index'); }
    function operator(v) { choice(v,['between','not_between','equal','not_equal','greater','less','greater_equal','less_equal']); }
    if(['word','cell','slide'].indexOf(kind)>=0&&a.type==='edit_chart'){
      object(a,['type','chart_index','sheet','slide_index','title','legend','x_axis_title','y_axis_title','show_values','width','height']);index(a.chart_index,30);
      if(a.sheet!=null)str(a.sheet,31);if(a.slide_index!=null)index(a.slide_index,200);
      ['title','x_axis_title','y_axis_title'].forEach(function(k){if(a[k]!=null)str(a[k],k==='title'?200:120);});
      if(a.legend!=null)choice(a.legend,['bottom','top','left','right','none']);bool(a.show_values);
      if(a.width!=null||a.height!=null){number(a.width,30,320);number(a.height,20,220);}return true;
    }
    if(kind==='word'&&a.type==='add_word_chart'){
      object(a,['type','position','width','height','chart_type','categories','series_names','data','title','legend','style']);
      choice(a.position,['end','cursor']);number(a.width,30,300);number(a.height,20,220);choice(a.chart_type,['bar','barStacked','horizontalBar','line','pie','doughnut','area']);str(a.title,200);choice(a.legend,['bottom','top','left','right','none']);index(a.style,48);
      if(!Array.isArray(a.categories)||!a.categories.length||a.categories.length>30||!Array.isArray(a.series_names)||!a.series_names.length||a.series_names.length>10||!Array.isArray(a.data)||a.data.length!==a.series_names.length)fail('Invalid Word chart data');
      a.categories.concat(a.series_names).forEach(function(v){str(v,120);});a.data.forEach(function(row){if(!Array.isArray(row)||row.length!==a.categories.length)fail('Chart dimensions mismatch');row.forEach(function(v){number(v,-Number.MAX_VALUE,Number.MAX_VALUE);});});return true;
    }
    if(kind==='cell'){
      if(['sort_range','filter_range','create_table','set_validation','conditional_format','freeze_panes','range_dimensions','sheet_options'].indexOf(a.type)<0)return false;
      if(a.sheet!==undefined&&a.sheet!==null)str(a.sheet,31);
      var dimensions=a.range?range(a.range,100000,100):null;
      if(a.type==='sort_range'){
        object(a,['type','sheet','range','keys','headers']);bool(a.headers);
        if(!Array.isArray(a.keys)||a.keys.length<1||a.keys.length>3)fail('Invalid sort keys');
        a.keys.forEach(function(k){object(k,['column','order']);index(k.column,dimensions[1]);choice(k.order,['ascending','descending']);});
      }else if(a.type==='filter_range'){
        object(a,['type','sheet','range','field','criteria','operator','criteria2','clear']);bool(a.clear);
        if(a.field!==undefined&&a.field!==null)index(a.field,dimensions[1]);
        if(a.criteria!==undefined&&a.criteria!==null){if(!a.field)fail('Filter field required');if(Array.isArray(a.criteria)){if(a.criteria.length>50)fail('Too many filter values');a.criteria.forEach(function(v){str(v,200);});}else str(a.criteria,200);}
        if(a.criteria2!==undefined&&a.criteria2!==null)str(a.criteria2,200);
        if(a.operator!==undefined&&a.operator!==null)choice(a.operator,['xlAnd','xlOr','xlFilterValues','xlTop10Items','xlTop10Percent','xlBottom10Items','xlBottom10Percent']);
      }else if(a.type==='create_table'){
        object(a,['type','sheet','range']);if(dimensions[0]<2)fail('A table needs a header and data row');
      }else if(a.type==='freeze_panes'){
        object(a,['type','sheet','rows','columns','unfreeze']);number(a.rows,0,200);number(a.columns,0,30);if(!Number.isInteger(a.rows)||!Number.isInteger(a.columns))fail('Invalid freeze counts');bool(a.unfreeze);
      }else if(a.type==='range_dimensions'){
        object(a,['type','sheet','range','column_width','row_height']);if(a.column_width==null&&a.row_height==null)fail('Choose dimensions to change');if(a.column_width!==undefined&&a.column_width!==null)number(a.column_width,.1,100);if(a.row_height!==undefined&&a.row_height!==null)number(a.row_height,.1,409);
      }else if(a.type==='sheet_options'){
        object(a,['type','sheet','gridlines','headings','print_gridlines','orientation']);if(a.gridlines==null&&a.headings==null&&a.print_gridlines==null&&a.orientation==null)fail('Choose worksheet options to change');['gridlines','headings','print_gridlines'].forEach(function(k){bool(a[k]);});if(a.orientation!==undefined&&a.orientation!==null)choice(a.orientation,['portrait','landscape']);
      }else if(a.type==='set_validation'){
        object(a,['type','sheet','range','rule','operator','formula1','formula2','options']);choice(a.rule,['list','whole','decimal','date','text_length','custom','remove']);operator(a.operator);
        str(a.formula1,500);str(a.formula2,500);
        if(!Array.isArray(a.options)||a.options.length>50)fail('Invalid validation choices');a.options.forEach(function(v){str(v,80);if(!v||/[,"\n]/.test(v))fail('Use a source range for complex dropdown values');});if(a.options.join(',').length>253)fail('Dropdown choices exceed native limits');
        if(a.rule!=='remove'&&!a.formula1&&!(a.rule==='list'&&a.options.length))fail('Validation source required');
      }else{
        object(a,['type','sheet','range','rule','operator','formula1','formula2','fill']);choice(a.rule,['cell_value','expression']);operator(a.operator);str(a.formula1,500);str(a.formula2,500);colors(a,['fill']);if(!a.fill||!a.formula1)fail('Conditional rule and fill required');
      }
      if(['sort_range','filter_range','create_table','range_dimensions','set_validation','conditional_format'].indexOf(a.type)>=0&&!dimensions)fail('Tool range required');
      return true;
    }
    if(kind!=='slide'||['slide_operation','add_slide_table','add_slide_chart','add_slide_shape','replace_slide_text','slide_object'].indexOf(a.type)<0)return false;
    index(a.slide_index,200);
    if(a.type==='slide_operation'){
      object(a,['type','slide_index','operation','position','notes']);choice(a.operation,['duplicate','move','delete','hide','show','notes']);if(a.position!==undefined&&a.position!==null)index(a.position,200);str(a.notes,4000);if(a.operation==='move'&&!a.position)fail('Destination position required');
    }else if(a.type==='replace_slide_text'){
      object(a,['type','slide_index','shape_index','old_text','text']);index(a.shape_index,200);str(a.old_text,12000);str(a.text,12000);
    }else if(a.type==='slide_object'){
      object(a,['type','slide_index','shape_index','operation','x','y','width','height']);index(a.shape_index,200);choice(a.operation,['move','resize','delete']);['x','y','width','height'].forEach(function(k){if(a[k]!==undefined&&a[k]!==null)number(a[k],k==='x'||k==='y'?0:.1,1000);});if(a.operation==='move'&&(a.x==null||a.y==null)||a.operation==='resize'&&(a.width==null||a.height==null))fail('Object geometry required');
    }else{
      ['x','y','width','height'].forEach(function(k){number(a[k],k==='x'||k==='y'?0:.1,1000);});
      var placement=['type','slide_index','x','y','width','height'];
      if(a.type==='add_slide_table'){
        object(a,placement.concat(['rows']));if(!Array.isArray(a.rows)||a.rows.length<1||a.rows.length>20||!Array.isArray(a.rows[0])||a.rows[0].length<1||a.rows[0].length>12)fail('Invalid slide table');a.rows.forEach(function(row){if(!Array.isArray(row)||row.length!==a.rows[0].length)fail('Uneven slide table');row.forEach(function(v){str(v,500);});});
      }else if(a.type==='add_slide_shape'){
        object(a,placement.concat(['shape','text','fill','line_color']));choice(a.shape,['rect','roundRect','ellipse','rightArrow','chevron']);str(a.text,4000);colors(a,['fill','line_color']);
      }else{
        object(a,placement.concat(['chart_type','categories','series_names','data','title','legend','style']));choice(a.chart_type,['bar','barStacked','horizontalBar','line','pie','doughnut','area']);str(a.title,200);choice(a.legend,['bottom','top','left','right','none']);index(a.style,48);
        if(!Array.isArray(a.categories)||!a.categories.length||a.categories.length>30||!Array.isArray(a.series_names)||!a.series_names.length||a.series_names.length>10||!Array.isArray(a.data)||a.data.length!==a.series_names.length)fail('Invalid chart data');a.categories.concat(a.series_names).forEach(function(v){str(v,120);});a.data.forEach(function(row){if(!Array.isArray(row)||row.length!==a.categories.length)fail('Chart dimensions mismatch');row.forEach(function(v){number(v,-Number.MAX_VALUE,Number.MAX_VALUE);});});
      }
    }
    return true;
  }
  function validate(plan) {
    object(plan, ['version','kind','reply','actions','create_form']);
    // Older sidebar responses include null for this optional, server-only operation.
    if (plan.create_form != null) fail('Create new forms through the reviewed form preview, not document edits');
    if (plan.version !== 1 || ['word','cell','slide','pdf'].indexOf(plan.kind) < 0) fail('Invalid plan version or kind'); str(plan.reply, 16000);
    if (!Array.isArray(plan.actions) || plan.actions.length > 40 || JSON.stringify(plan).length > 250000) fail('Plan too large');
    plan.actions.forEach(function (a) {
      if (!a || typeof a !== 'object') fail('Invalid action');
      if(toolAction(a,plan.kind))return;
      if (plan.kind === 'word') {
        if (a.type === 'insert_blocks') { object(a,['type','position','blocks']); if (['end','cursor','replace_selection'].indexOf(a.position) < 0) fail('Invalid insertion position'); blocks(a.blocks); }
        else if (a.type === 'replace_document') { object(a,['type','blocks']); blocks(a.blocks); }
        else if (a.type === 'set_header' || a.type === 'set_footer') { object(a, a.type === 'set_footer' ? ['type','text','alignment','page_numbers','font_color','fill'] : ['type','text','alignment','font_color','fill']); str(a.text, 4000); colors(a,['font_color','fill']); alignment(a.alignment); bool(a.page_numbers); }
        else if (a.type === 'set_page_layout') { object(a,['type','size','orientation','margins_mm']); if (['a4','letter'].indexOf(a.size) < 0 || ['portrait','landscape'].indexOf(a.orientation) < 0) fail('Invalid page layout'); if (typeof a.margins_mm !== 'number' || !Number.isFinite(a.margins_mm) || a.margins_mm < 10 || a.margins_mm > 50) fail('Invalid page margins'); }
        else fail('Unsupported Word action');
      } else if (plan.kind === 'pdf') {
        if (!Number.isInteger(a.page) || a.page < 1 || a.page > 200) fail('Invalid PDF page');
        if (a.type === 'pdf_add_text') {
          object(a,['type','page','x','y','width','height','text','font_size']); str(a.text,12000);
          ['x','y','width','height'].forEach(function(k){if(typeof a[k]!=='number'||!Number.isFinite(a[k])||a[k]<(k==='x'||k==='y'?0:1)||a[k]>1000)fail('Invalid PDF coordinates');});
        } else if (a.type === 'pdf_rotate_page') {
          object(a,['type','page','angle']); if(!Number.isInteger(a.angle)||[0,90,180,270].indexOf(a.angle)<0)fail('Invalid PDF rotation');
        } else if (a.type === 'pdf_update_text') {
          object(a,['type','page','object_index','old_text','text','font_size']);
          if(!Number.isInteger(a.object_index)||a.object_index<1||a.object_index>2000)fail('Invalid PDF text object'); str(a.old_text,12000);str(a.text,12000);
        } else fail('Unsupported PDF action');
        if(a.font_size!==undefined&&(typeof a.font_size!=='number'||!Number.isFinite(a.font_size)||a.font_size<6||a.font_size>96))fail('Invalid PDF font size');
      } else if (plan.kind === 'slide') {
        if (a.type === 'clear_slides') { object(a, ['type']); return; }
        if (a.type === 'add_slide' || a.type === 'update_slide') {
          object(a, a.type === 'update_slide' ? ['type','slide_index','title','subtitle','bullets','notes','background'] : ['type','title','subtitle','bullets','notes','background']);
          if (a.type === 'update_slide' && a.slide_index !== undefined && (!Number.isInteger(a.slide_index) || a.slide_index < 1 || a.slide_index > 200)) fail('Invalid slide index');
          if (a.title !== undefined) str(a.title, 500);
          if (a.subtitle !== undefined) str(a.subtitle, 1000);
          if (a.bullets !== undefined) {
            if (!Array.isArray(a.bullets) || a.bullets.length > 25) fail('Invalid slide bullets');
            a.bullets.forEach(function (b) { str(b, 2000); });
          }
          if (a.notes !== undefined) str(a.notes, 4000);
          if (a.background !== undefined && a.background !== null && !/^#[0-9a-f]{6}$/i.test(a.background)) fail('Invalid slide background color');
        } else fail('Unsupported presentation action');
      } else {
        if (a.type === 'add_sheet') { object(a,['type','name']); str(a.name,31); if (!a.name || /[\\/?*\[\]:]/.test(a.name)) fail('Invalid sheet name'); return; }
        if (a.sheet !== null && a.sheet !== undefined) str(a.sheet,31);
        if (a.type === 'set_cells') { object(a,['type','sheet','range','values']); var shape = range(a.range); if (!Array.isArray(a.values) || a.values.length !== shape[0]) fail('Cell dimensions mismatch'); a.values.forEach(function(row) { if (!Array.isArray(row) || row.length !== shape[1]) fail('Cell dimensions mismatch'); row.forEach(function(v) { if (v !== null && typeof v !== 'string' && typeof v !== 'boolean' && !(typeof v === 'number' && Number.isFinite(v))) fail('Invalid cell value'); if (typeof v === 'string') str(v,12000); }); }); }
        else if (a.type === 'format_range') { object(a,['type','sheet','range','bold','italic','fill','font_color','number_format']); range(a.range); bool(a.bold); bool(a.italic); ['fill','font_color'].forEach(function(k){if(a[k] !== undefined && a[k] !== null && !/^#[0-9a-f]{6}$/i.test(a[k])) fail('Invalid color');}); if (a.number_format !== undefined && a.number_format !== null) str(a.number_format,100); }
        else if (a.type === 'set_print_header_footer') { object(a,['type','sheet','header','footer','page_numbers']); str(a.header,4000); str(a.footer,4000); bool(a.page_numbers); }
        else if (a.type === 'add_chart') {
          object(a,['type','sheet','range','chart_type','title','x_axis_title','y_axis_title','legend','from_col','from_row','width_mm','height_mm','plot_by_rows']);
          chartRange(a.range);
          if (a.chart_type !== undefined && ['bar','barStacked','horizontalBar','line','lineNormal','pie','doughnut','area','scatter'].indexOf(a.chart_type) < 0) fail('Invalid chart type');
          if (a.title !== undefined) str(a.title, 200);
          if (a.x_axis_title !== undefined) str(a.x_axis_title, 120);
          if (a.y_axis_title !== undefined) str(a.y_axis_title, 120);
          if (a.legend !== undefined && ['bottom','top','left','right','none'].indexOf(a.legend) < 0) fail('Invalid chart legend');
          if (a.from_col !== undefined && (!Number.isInteger(a.from_col) || a.from_col < 0 || a.from_col > 50)) fail('Invalid chart column');
          if (a.from_row !== undefined && (!Number.isInteger(a.from_row) || a.from_row < 0 || a.from_row > 500)) fail('Invalid chart row');
          if (a.width_mm !== undefined && (typeof a.width_mm !== 'number' || !Number.isFinite(a.width_mm) || a.width_mm < 60 || a.width_mm > 320)) fail('Invalid chart width');
          if (a.height_mm !== undefined && (typeof a.height_mm !== 'number' || !Number.isFinite(a.height_mm) || a.height_mm < 45 || a.height_mm > 220)) fail('Invalid chart height');
          bool(a.plot_by_rows);
        }
        else if (a.type === 'autofit_columns') {
          object(a,['type','sheet','range']);
          if (a.range !== undefined) range(a.range);
        }
        else fail('Unsupported spreadsheet action');
      }
    });
  }
  // Executed by ONLYOFFICE in its API sandbox; no closure or model supplied code.
  function officeCommand() {
    try {
      var request = Asc.scope.buddyOfficeRequest, kind = request.kind;
      function need(obj, methods) { if (!obj) throw new Error('Office object unavailable'); methods.forEach(function(m){if(typeof obj[m] !== 'function') throw new Error('This editor does not support ' + m);}); return obj; }
      function fingerprint(value) { var a=2166136261,b=5381; for(var i=0;i<value.length;i++){a=Math.imul(a^value.charCodeAt(i),16777619);b=Math.imul(b,33)^value.charCodeAt(i);}return value.length+':'+(a>>>0)+':'+(b>>>0); }
      function textOf(content) { if (!content) return ''; return need(content,['GetAllParagraphs']).GetAllParagraphs().map(function(p){return p.GetText();}).join('\n'); }
      function columnName(index) { var name='';for(;index>0;index=Math.floor((index-1)/26))name=String.fromCharCode(65+(index-1)%26)+name;return name; }
      function matrix(value) { return Array.isArray(value)?value:[[value]]; }
      function workbookContext(active) {
        var sheets=Api.GetSheets(),activeName=active.GetName();
        var ordered=[active].concat(sheets.filter(function(s){return s.GetName()!==activeName;})).slice(0,20);
        var workbook=[],revisionParts=[],sampleBytes=0;
        ordered.forEach(function(s,index){
          var used=need(s,['GetUsedRange']).GetUsedRange();
          var address=used?used.GetAddress(false,false,'xlA1',false):null;
          var match=address&&/^\$?([A-Z]{1,3})\$?([1-9][0-9]*)(?::\$?([A-Z]{1,3})\$?([1-9][0-9]*))?$/.exec(address);
          var entry={name:s.GetName(),used_range:address,range:null,values:[],display_values:[],number_formats:[],truncated:true,rows:used?used.GetRowsCount():0,columns:used?used.GetColumnsCount():0};
          revisionParts.push([entry.name,address,entry.rows,entry.columns]);
          if(index===0&&match){
            var firstColumn=match[1].split('').reduce(function(v,c){return v*26+c.charCodeAt(0)-64;},0),firstRow=+match[2];
            var rowCount=Math.min(entry.rows,40),colCount=Math.min(entry.columns,20),formats={},numericFormats={};
            entry.truncated=entry.rows>rowCount||entry.columns>colCount;
            // Read at most one bounded 20-cell row at a time, never the whole used range.
            for(var row=0;row<rowCount;row++){
              var rowNumber=firstRow+row,rowRange=s.GetRange(columnName(firstColumn)+rowNumber+':'+columnName(firstColumn+colCount-1)+rowNumber);
              var raw=matrix(rowRange.GetValue())[0],shown=typeof rowRange.GetText==='function'?matrix(rowRange.GetText())[0]:raw;
              var formulas=typeof rowRange.GetFormula==='function'?rowRange.GetFormula():null;
              revisionParts.push(fingerprint(JSON.stringify([rowNumber,raw,shown,formulas])));
              var values=[],display=[];
              for(var col=0;col<colCount;col++){
                var value=raw[col]===undefined?null:raw[col],label=shown[col]===undefined?'':String(shown[col]);
                if(typeof value==='string'&&value.length>256){value=value.slice(0,256);entry.truncated=true;}
                if(label.length>256){label=label.slice(0,256);entry.truncated=true;}
                values.push(value);display.push(label);
                if(raw[col]!==''&&raw[col]!==null&&raw[col]!==undefined&&(!formats[col]||!numericFormats[col]&&(typeof raw[col]==='number'||row>0))){
                  var cell=s.GetRange(columnName(firstColumn+col)+rowNumber);
                  if(typeof cell.GetNumberFormat==='function'){var format=cell.GetNumberFormat();if(typeof format==='string')formats[col]=format.slice(0,100);}
                  if(typeof raw[col]==='number'||row>0)numericFormats[col]=true;
                }
              }
              var bytes=JSON.stringify([values,display]).length;
              if(sampleBytes+bytes>22000&&entry.values.length){entry.truncated=true;break;}
              entry.values.push(values);entry.display_values.push(display);sampleBytes+=bytes;
            }
            Object.keys(formats).forEach(function(col){entry.number_formats.push({column:columnName(firstColumn+(+col)),format:formats[col]});});
            entry.range=entry.values.length?columnName(firstColumn)+firstRow+':'+columnName(firstColumn+colCount-1)+(firstRow+entry.values.length-1):null;
            revisionParts.push(entry.number_formats);
          }
          workbook.push(entry);
        });
        // Extra sheets remain available by name, without unbounded cell reads.
        return {workbook:workbook,revision:fingerprint(JSON.stringify(revisionParts))};
      }
      var doc, sheet, pres, snapshot;
      if (kind === 'word') {
        doc = Api.GetDocument(); var selected = doc.GetRangeBySelect();
        var selectionText=selected?selected.GetText():'';
        if(selectionText.length>12000)throw new Error('Select less text (maximum 12000 characters).');
        var section = doc.GetFinalSection();
        var fullText=textOf(doc);
        var fullHeader=textOf(section.GetHeader('default',false)),fullFooter=textOf(section.GetFooter('default',false));
        var cursor='';if(selected&&typeof selected.GetStartPos==='function')cursor=selected.GetStartPos()+':'+selected.GetEndPos();else if(typeof doc.GetCurrentParagraph==='function'){var current=doc.GetCurrentParagraph();if(current&&typeof current.GetRange==='function'){var currentRange=current.GetRange();if(currentRange&&typeof currentRange.GetStartPos==='function')cursor='paragraph:'+currentRange.GetStartPos();}}
        snapshot = {kind:'word',revision:fingerprint(fullText+'\u0000'+fullHeader+'\u0000'+fullFooter),cursor:cursor,truncated:fullText.length>30000||fullHeader.length>4000||fullFooter.length>4000,text:fullText.slice(0,30000),selection:selectionText,header:fullHeader.slice(0,4000),footer:fullFooter.slice(0,4000)};
      } else if (kind === 'pdf') {
        try {doc=typeof Api.GetDocument==='function'?Api.GetDocument():null;}catch(pdfApiError){doc=null;}
        doc=doc||{};
        var pdfPages=[],pdfRevision=[],pdfText=[],pdfSelection=[],capabilities=[];
        var pageCount=typeof doc.GetPagesCount==='function'?doc.GetPagesCount():0;
        if(!Number.isInteger(pageCount)||pageCount<0||pageCount>200)throw new Error('PDF context supports at most 200 pages.');
        var canAdd=pageCount>0,canRotate=pageCount>0,canUpdate=false,completeText=pageCount>0,pdfObjectBudget=8000,pdfTruncated=pageCount>60;
        for(var pi=0;pi<pageCount;pi++){
          var pg=need(doc,['GetPage']).GetPage(pi),pageText='',pageSelection='',objects=[],drawingRevision=[],pageTextAvailable=false;
          var drawings=[],drawingsAvailable=false;
          try {if(typeof pg.GetAllDrawings==='function'){drawings=pg.GetAllDrawings()||[];drawingsAvailable=true;}}catch(drawingsError){}
          if(drawings.length>2000)throw new Error('PDF page contains too many drawing objects.');
          drawings.forEach(function(d,di){
            var dc=null,dt='';
            try {dc=typeof d.GetContent==='function'?d.GetContent():null;dt=dc?textOf(dc):'';}catch(drawingContentError){dc=null;}
            var editable=!!(dc&&typeof dc.RemoveAllElements==='function'&&typeof dc.GetElement==='function'&&dt.length<=12000);
            if(dt&&pi<60&&objects.length<100&&dt.length<=pdfObjectBudget){objects.push({object_index:di+1,text:dt,editable:editable});pdfObjectBudget-=dt.length;if(editable)canUpdate=true;}else if(dt)pdfTruncated=true;
            var geom={};['GetPosition','GetWidth','GetHeight','GetRotation'].forEach(function(m){if(typeof d[m]==='function')geom[m]=d[m]();});
            drawingRevision.push([di,dt,geom]);
          });
          try {if(typeof pg.GetText==='function'){pageText=pg.GetText();pageTextAvailable=typeof pageText==='string';}else completeText=false;}catch(readError){completeText=false;}
          if(typeof pageText!=='string'){pageText='';completeText=false;}
          if(!pageText)pageText=drawingRevision.map(function(o){return o[1];}).filter(Boolean).join('\n');
          try {if(typeof pg.GetSelectedText==='function')pageSelection=pg.GetSelectedText()||'';}catch(selectionError){}
          if(pageSelection.length>12000)throw new Error('Select less PDF text (maximum 12000 characters).');
          if(pageSelection)pdfSelection.push(pageSelection);
          var rotation=typeof pg.GetRotation==='function'?pg.GetRotation():null;
          var annotRevision=[];try {if(typeof pg.GetAllAnnots==='function')annotRevision=pg.GetAllAnnots().map(function(an){return typeof an.GetContents==='function'?an.GetContents():null;});}catch(annotationError){}
          pdfRevision.push([pi,pageText,rotation,drawingRevision,annotRevision]);
          var entry={page:pi+1,rotation:rotation,text_available:pageTextAvailable,objects:objects};
          if(pi<60)pdfPages.push(entry);pdfText.push('Page '+(pi+1)+':\n'+pageText);
          canAdd=canAdd&&drawingsAvailable&&typeof pg.AddObject==='function';canRotate=canRotate&&drawingsAvailable&&typeof pg.SetRotation==='function';
        }
        if(canAdd&&['CreateShape','CreateNoFill','CreateStroke'].every(function(m){return typeof Api[m]==='function';}))capabilities.push('pdf_add_text');
        if(canRotate)capabilities.push('pdf_rotate_page');if(canUpdate)capabilities.push('pdf_update_text');
        var combinedSelection=pdfSelection.join('\n');if(combinedSelection.length>12000)throw new Error('Select less PDF text (maximum 12000 characters).');
        snapshot={kind:'pdf',revision:fingerprint(JSON.stringify(pdfRevision)),text:pdfText.join('\n\n').slice(0,30000),selection:combinedSelection,page_count:pageCount,pages:pdfPages,capabilities:capabilities,text_available:completeText,text_complete:completeText,truncated:pdfTruncated||!completeText||pdfText.join('\n\n').length>30000};
        if(JSON.stringify(snapshot).length>50000)throw new Error('PDF context is too large. Use a smaller PDF.');
      } else if (kind === 'slide') {
        pres = need(Api, ['GetPresentation']).GetPresentation();
        var sCount = typeof pres.GetSlidesCount === 'function' ? pres.GetSlidesCount() : 0;
        var curIdx = typeof pres.GetCurSlideIndex === 'function' ? pres.GetCurSlideIndex() : 0;
        var slideLines = [],shapeSnapshots=[],shapeBytes=0,selectedShapes=[];
        if(typeof Api.GetSelection==='function'){var nativeSelection=Api.GetSelection();if(nativeSelection&&typeof nativeSelection.GetShapes==='function')selectedShapes=nativeSelection.GetShapes()||[];}
        function shapeFacts(shape){
          if(typeof shape.GetInternalId==='function')return 'id:'+shape.GetInternalId();
          if(typeof shape.ToJSON==='function'){try{return 'json:'+JSON.stringify(shape.ToJSON());}catch(ignore){}}
          var dc=typeof shape.GetDocContent==='function'?shape.GetDocContent():typeof shape.GetContent==='function'?shape.GetContent():null;
          var text=dc?textOf(dc):'',metrics=['GetPosX','GetPosY','GetWidth','GetHeight'].map(function(name){return typeof shape[name]==='function'?shape[name]():null;});
          return text||metrics.some(function(value){return value!==null;})?JSON.stringify([text,metrics]):null;
        }
        function shapeSelected(shape,all){return selectedShapes.some(function(selected){
          if(selected===shape)return true;
          var key=shapeFacts(shape);return key!==null&&shapeFacts(selected)===key&&all.filter(function(candidate){return shapeFacts(candidate)===key;}).length===1;
        });}
        for (var si = 0; si < Math.min(sCount, 60); si++) {
          var sl = pres.GetSlideByIndex(si);
          if (!sl) continue;
          var shapes = typeof sl.GetAllShapes === 'function' ? sl.GetAllShapes() : [];
          var sTexts = [];
          for (var shi = 0; shi < shapes.length; shi++) {
            var dc = typeof shapes[shi].GetDocContent === 'function' ? shapes[shi].GetDocContent() : (typeof shapes[shi].GetContent === 'function' ? shapes[shi].GetContent() : null);
            var st = dc ? textOf(dc).trim() : '';
            if (st) sTexts.push(st);
            function metric(name){var value=typeof shapes[shi][name]==='function'?shapes[shi][name]():null;return typeof value==='number'&&Number.isFinite(value)?value/36000:null;}
            var entry={slide_index:si+1,shape_index:shi+1,text:st.slice(0,2000),text_truncated:st.length>2000,selected:si===curIdx&&shapeSelected(shapes[shi],shapes),x:metric('GetPosX'),y:metric('GetPosY'),width:metric('GetWidth'),height:metric('GetHeight')};
            var entryBytes=JSON.stringify(entry).length;
            if(shapeSnapshots.length<120&&shapeBytes+entryBytes<18000){shapeSnapshots.push(entry);shapeBytes+=entryBytes;}

          }
          slideLines.push('Slide ' + (si + 1) + (si === curIdx ? ' (current)' : '') + ':\n' + (sTexts.length ? sTexts.join('\n') : '(blank)'));
        }
        var selText = '';
        if (typeof Api.GetSelection === 'function') {
          var sel = Api.GetSelection();
          if (sel && typeof sel.GetShapes === 'function') {
            var selShapes = sel.GetShapes() || [];
            selText = selShapes.map(function (sh) {
              var dc = typeof sh.GetDocContent === 'function' ? sh.GetDocContent() : (typeof sh.GetContent === 'function' ? sh.GetContent() : null);
              return dc ? textOf(dc).trim() : '';
            }).filter(Boolean).join('\n');
          }
        }
        var presText = slideLines.join('\n\n').slice(0, 30000);
        snapshot = {kind:'slide',revision:fingerprint(presText+'\u0000'+sCount+'\u0000'+curIdx),text:presText,truncated:sCount>60||slideLines.join('\n\n').length>30000||selText.length>12000,selection:selText.slice(0,12000),slide_count:sCount,current_slide:curIdx+1,slide_shapes:shapeSnapshots,slide_width:pres.GetWidth()/36000,slide_height:pres.GetHeight()/36000};
        snapshot.revision=fingerprint(snapshot.revision+JSON.stringify(shapeSnapshots));
      } else {
        sheet = Api.GetActiveSheet(); var selection = sheet.GetSelection();
        // Never read a whole-column selection into a giant array.
        var rows=selection.GetRowsCount(),columns=selection.GetColumnsCount();
        if(rows>200||columns>30)throw new Error('Select fewer cells (maximum 200 rows and 30 columns).');
        var values = selection.GetValue();
        if (!Array.isArray(values)) values = [[values]];
        if(JSON.stringify(values).length>15000)throw new Error('Select fewer cells (the selected content is too large).');
        var book=workbookContext(sheet);
        snapshot = {kind:'cell',workbook:book.workbook,revision:book.revision,text:JSON.stringify(values).slice(0,30000),selection:JSON.stringify(values).slice(0,12000),sheets:Api.GetSheets().map(function(s){return s.GetName();}),range:selection.GetAddress(false,false,'xlA1',false),values:values,sheet:sheet.GetName()};
      }
      snapshot.charts=[];
      var chartContainer=kind==='word'?doc:kind==='cell'?sheet:kind==='slide'?pres.GetSlideByIndex(snapshot.current_slide-1):null;
      if(chartContainer&&typeof chartContainer.GetAllCharts==='function'){
        (chartContainer.GetAllCharts()||[]).slice(0,30).forEach(function(chart,index){
          var selected=false;
          if(kind==='slide'&&typeof Api.GetSelection==='function'){var selectionObject=Api.GetSelection();if(selectionObject&&typeof selectionObject.GetCharts==='function')selected=(selectionObject.GetCharts()||[]).some(function(item){return item===chart||typeof item.GetInternalId==='function'&&typeof chart.GetInternalId==='function'&&item.GetInternalId()===chart.GetInternalId();});}
          if(kind==='cell'&&typeof sheet.GetSelectedDrawings==='function')selected=(sheet.GetSelectedDrawings()||[]).some(function(item){return item===chart||typeof item.GetInternalId==='function'&&typeof chart.GetInternalId==='function'&&item.GetInternalId()===chart.GetInternalId();});
          var title=typeof chart.GetTitle==='function'?chart.GetTitle():null,type=typeof chart.GetChartType==='function'?chart.GetChartType():null;
          var width=typeof chart.GetWidth==='function'?chart.GetWidth()/36000:null,height=typeof chart.GetHeight==='function'?chart.GetHeight()/36000:null;
          snapshot.charts.push({chart_index:index+1,sheet:kind==='cell'?sheet.GetName():null,slide_index:kind==='slide'?snapshot.current_slide:null,selected:selected,title:typeof title==='string'?title.slice(0,200):null,chart_type:typeof type==='string'?type.slice(0,50):null,width:typeof width==='number'&&Number.isFinite(width)?width:null,height:typeof height==='number'&&Number.isFinite(height)?height:null});
        });
        snapshot.revision=fingerprint((snapshot.revision||snapshot.text||'')+JSON.stringify(snapshot.charts));
      }
      snapshot.editor_capabilities=[];
      function can(obj,methods){return !!obj&&methods.every(function(method){return typeof obj[method]==='function';});}
      function capability(name,available){if(available)snapshot.editor_capabilities.push(name);}
      capability('edit_chart',!!chartContainer&&typeof chartContainer.GetAllCharts==='function');
      if(kind==='word')capability('add_word_chart',can(Api,['CreateChart','CreateParagraph']));
      if(kind==='cell'){
        var probe=sheet.GetSelection();
        capability('sort_range',can(probe,['SetSort']));capability('filter_range',can(probe,['SetAutoFilter']));capability('create_table',can(sheet,['FormatAsTable']));
        capability('set_validation',can(probe,['GetValidation']));capability('conditional_format',can(probe,['GetFormatConditions']));capability('freeze_panes',can(sheet,['GetFreezePanes']));
        capability('range_dimensions',can(probe,['SetColumnWidth','SetRowHeight']));capability('sheet_options',can(sheet,['SetDisplayGridlines','SetDisplayHeadings','SetPrintGridlines','SetPageOrientation']));
      }else if(kind==='slide'){
        var current=pres.GetSlideByIndex(snapshot.current_slide-1);
        ['duplicate','move','delete','hide','show','notes'].forEach(function(op){capability('slide_operation:'+op,can(current,[{duplicate:'Duplicate',move:'MoveTo',delete:'Delete',hide:'SetVisible',show:'SetVisible',notes:'AddNotesText'}[op]]));});
        capability('add_slide_table',can(Api,['CreateTable'])&&can(current,['AddObject']));capability('add_slide_chart',can(Api,['CreateChart'])&&can(current,['AddObject']));capability('add_slide_shape',can(Api,['CreateShape'])&&can(current,['AddObject']));
        capability('replace_slide_text',can(current,['GetAllShapes']));capability('slide_object',can(current,['GetAllShapes','RemoveObject']));
      }
      if (request.command === 'context') return {ok:true,value:snapshot};
      var expected = request.payload.expectedContext;
      if (!expected || ['kind','text','selection','header','footer','range','sheet','revision','cursor'].some(function(key){return (snapshot[key] || '') !== (expected[key] || '');})) throw new Error('Document changed since this draft. Ask Bob again before applying.');
      var actions = request.payload.plan.actions, prepared = [];
      function wordColors(target, font, fill) {
        function rgb(value) { return [parseInt(value.slice(1,3),16),parseInt(value.slice(3,5),16),parseInt(value.slice(5,7),16)]; }
        function apply(method, value, shading) {
          if(!value)return;
          need(target,[method]);
          var c=rgb(value), result;
          // Docs 9.3 uses RGB channels; newer editors accept an ApiColor.
          if(typeof Api.HexColor==='function')result=shading?target[method]('clear',Api.HexColor(value)):target[method](Api.HexColor(value));
          else result=shading?target[method]('clear',c[0],c[1],c[2],false):target[method](c[0],c[1],c[2]);
          if(result===false)throw new Error('Editor rejected document color');
        }
        apply('SetColor',font,false); apply('SetShd',fill,true);
      }
      function paragraph(b) {
        var p=Api.CreateParagraph();
        if(b.type==='page_break'){p.AddPageBreak();return p;}
        p.AddText(b.text);
        if(b.type==='heading'||b.type==='title'){var style=doc.GetStyle(b.type==='title'?'Title':'Heading '+(b.level||1));if(!style)throw new Error('Heading style unavailable');p.SetStyle(style);}
        if(b.bold===true||b.type==='paragraph'&&b.bold!==undefined)p.SetBold(b.bold);
        if(b.italic===true||b.type==='paragraph'&&b.italic!==undefined)p.SetItalic(b.italic);
        p.SetJc(b.alignment||'left'); wordColors(p,b.font_color,b.fill); return p;
      }
      function makeBlocks(list) { return list.map(function(b){
        if(b.type!=='table')return paragraph(b);
        var t=Api.CreateTable(b.rows[0].length,b.rows.length);
        b.rows.forEach(function(row,r){row.forEach(function(value,c){
          var cell=t.GetRow(r).GetCell(c),content=cell.GetContent(),p=content.GetElement(0);
          p.AddText(value);
          var header=r===0&&b.header!==false,bodyIndex=r-(b.header!==false?1:0);
          if(header)p.SetBold(true);
          wordColors(p,header?(b.header_font_color||b.font_color):b.font_color,null);
          wordColors(cell,null,header?(b.header_fill||b.fill):(b.alternate_fill&&bodyIndex%2===1?b.alternate_fill:b.fill));
        });}); return t;
      }); }
      function populateSlide(targetSlide, a) {
        var sw = (typeof pres.GetWidth === 'function' ? pres.GetWidth() : 0) || 9144000;
        var sh = (typeof pres.GetHeight === 'function' ? pres.GetHeight() : 0) || 6858000;
        if (typeof targetSlide.RemoveAllObjects === 'function') targetSlide.RemoveAllObjects();
        if (a.background && typeof Api.CreateRGBColor === 'function' && typeof Api.CreateSolidFill === 'function' && typeof targetSlide.SetBackground === 'function') {
          var bgFill = Api.CreateSolidFill(Api.CreateRGBColor(parseInt(a.background.slice(1,3),16), parseInt(a.background.slice(3,5),16), parseInt(a.background.slice(5,7),16)));
          targetSlide.SetBackground(bgFill);
        }
        var noFill = typeof Api.CreateNoFill === 'function' ? Api.CreateNoFill() : null;
        var noStroke = (typeof Api.CreateStroke === 'function' && noFill) ? Api.CreateStroke(0, noFill) : null;
        var marginX = Math.round(sw * 0.07);
        var boxW = sw - marginX * 2;
        var curY = Math.round(sh * 0.09);
        if (a.title) {
          var titleH = a.bullets && a.bullets.length ? Math.round(sh * 0.16) : Math.round(sh * 0.24);
          var titleShape = Api.CreateShape('rect', boxW, titleH, noFill, noStroke);
          titleShape.SetPosition(marginX, curY);
          var tDoc = titleShape.GetDocContent();
          tDoc.RemoveAllElements();
          var tp = Api.CreateParagraph();
          var tr = tp.AddText(a.title);
          if (tr && typeof tr.SetBold === 'function') tr.SetBold(true);
          if (tr && typeof tr.SetFontSize === 'function') tr.SetFontSize(a.bullets && a.bullets.length ? 56 : 68);
          tDoc.Push(tp);
          targetSlide.AddObject(titleShape);
          curY += titleH + Math.round(sh * 0.02);
        }
        if (a.subtitle) {
          var subH = Math.round(sh * 0.11);
          var subShape = Api.CreateShape('rect', boxW, subH, noFill, noStroke);
          subShape.SetPosition(marginX, curY);
          var sDoc = subShape.GetDocContent();
          sDoc.RemoveAllElements();
          var sp = Api.CreateParagraph();
          var sr = sp.AddText(a.subtitle);
          if (sr && typeof sr.SetFontSize === 'function') sr.SetFontSize(36);
          sDoc.Push(sp);
          targetSlide.AddObject(subShape);
          curY += subH + Math.round(sh * 0.03);
        }
        if (Array.isArray(a.bullets) && a.bullets.length) {
          var bodyH = Math.max(Math.round(sh * 0.25), sh - curY - Math.round(sh * 0.08));
          var bodyShape = Api.CreateShape('rect', boxW, bodyH, noFill, noStroke);
          bodyShape.SetPosition(marginX, curY);
          var bDoc = bodyShape.GetDocContent();
          bDoc.RemoveAllElements();
          a.bullets.forEach(function (line) {
            var bp = Api.CreateParagraph();
            var br = bp.AddText('•  ' + line);
            if (br && typeof br.SetFontSize === 'function') br.SetFontSize(36);
            if (typeof bp.GetParaPr === 'function') {
              var ppr = bp.GetParaPr();
              if (ppr && typeof ppr.SetSpacingAfter === 'function') ppr.SetSpacingAfter(160);
            }
            bDoc.Push(bp);
          });
          targetSlide.AddObject(bodyShape);
        }
        if (a.notes && typeof targetSlide.AddNotesText === 'function') {
          targetSlide.AddNotesText(a.notes);
        }
      }
      var cellTools=['sort_range','filter_range','create_table','set_validation','conditional_format','freeze_panes','range_dimensions','sheet_options'];
      var slideTools=['slide_operation','add_slide_table','add_slide_chart','add_slide_shape','replace_slide_text','slide_object'];
      var plannedSlideCount=kind==='slide'?pres.GetSlidesCount():0;
      function prepareTool(a,item) {
        if(a.type==='edit_chart'){
          item.tool=true;
          var container=kind==='word'?doc:kind==='cell'?(a.sheet?Api.GetSheet(a.sheet):sheet):(a.slide_index?pres.GetSlideByIndex(a.slide_index-1):null);
          item.chart=need(container,['GetAllCharts']).GetAllCharts()[a.chart_index-1];
          if(!item.chart)throw new Error('Chart no longer exists');
          [['title','SetTitle'],['legend','SetLegendPos'],['x_axis_title','SetHorAxisTitle'],['y_axis_title','SetVerAxisTitle'],['show_values','SetShowDataLabels'],['width','SetSize']].forEach(function(pair){if(a[pair[0]]!=null)need(item.chart,[pair[1]]);});return true;
        }
        if(kind==='word'&&a.type==='add_word_chart'){
          item.tool=true;need(Api,['CreateChart','CreateParagraph']);need(doc,[a.position==='end'?'Push':'InsertContent']);
          if(a.position==='cursor'&&snapshot.selection)throw new Error('Deselect text before inserting a chart at the cursor');
          var chart=Api.CreateChart(a.chart_type==='line'?'lineNormal':a.chart_type,a.data,a.series_names,a.categories,Math.round(a.width*36000),Math.round(a.height*36000),a.style,a.series_names.map(function(){return 'General';}));
          if(a.title)need(chart,['SetTitle']).SetTitle(a.title,16);need(chart,['SetLegendPos']).SetLegendPos(a.legend);
          item.paragraph=Api.CreateParagraph();need(item.paragraph,['AddDrawing']).AddDrawing(chart);return true;
        }
        if(kind==='cell'&&cellTools.indexOf(a.type)>=0){
          item.tool=true;item.sheet=a.sheet?Api.GetSheet(a.sheet):sheet;
          var target=item.sheet||plannedSheets[a.sheet]&&sheet;
          if(!target)throw new Error('Worksheet not found');
          var r=a.range?need(target,['GetRange']).GetRange(a.range):null;
          if(a.type==='sort_range')need(r,['SetSort']);
          else if(a.type==='filter_range'){if(a.clear)need(need(target,['GetAutoFilter']).GetAutoFilter(),['ShowAllData']);else need(r,['SetAutoFilter']);}
          else if(a.type==='create_table')need(target,['FormatAsTable']);
          else if(a.type==='set_validation')need(need(r,['GetValidation']).GetValidation(),[a.rule==='remove'?'Delete':'Add']);
          else if(a.type==='conditional_format'){need(need(r,['GetFormatConditions']).GetFormatConditions(),['Add']);need(Api,['CreateColorFromRGB']);}
          else if(a.type==='freeze_panes')need(need(target,['GetFreezePanes']).GetFreezePanes(),[a.unfreeze||!a.rows&&!a.columns?'Unfreeze':a.rows&&a.columns?'FreezeAt':a.rows?'FreezeRows':'FreezeColumns']);
          else if(a.type==='range_dimensions'){if(a.column_width!=null)need(r,['SetColumnWidth']);if(a.row_height!=null)need(r,['SetRowHeight']);}
          else {if(a.gridlines!=null)need(target,['SetDisplayGridlines']);if(a.headings!=null)need(target,['SetDisplayHeadings']);if(a.print_gridlines!=null)need(target,['SetPrintGridlines']);if(a.orientation)need(target,['SetPageOrientation']);}
          return true;
        }
        if(kind!=='slide'||slideTools.indexOf(a.type)<0)return false;
        item.tool=true;
        if(a.slide_index>plannedSlideCount)throw new Error('Slide does not exist; read the current presentation before editing');
        item.slide=pres.GetSlideByIndex(a.slide_index-1);
        var targetSlide=item.slide;
        if(a.type==='slide_operation'){
          if(!targetSlide)throw new Error('Manage an existing slide before adding new slides');
          if(a.operation==='delete'){if(plannedSlideCount<=1)throw new Error('Keep at least one slide');need(targetSlide,['Delete']);plannedSlideCount--;}
          else if(a.operation==='duplicate'){need(targetSlide,['Duplicate']);if(a.position&&a.position>plannedSlideCount+1)throw new Error('Duplicate destination does not exist');plannedSlideCount++;}
          else if(a.operation==='move'){need(targetSlide,['MoveTo']);if(a.position>plannedSlideCount)throw new Error('Move destination does not exist');}
          else need(targetSlide,[a.operation==='notes'?'AddNotesText':'SetVisible']);
        }else if(a.type==='replace_slide_text'||a.type==='slide_object'){
          if(!targetSlide)throw new Error('Read the slide objects before changing them');
          item.shape=need(targetSlide,['GetAllShapes']).GetAllShapes()[a.shape_index-1];
          if(!item.shape)throw new Error('Selected shape no longer exists');
          if(a.type==='replace_slide_text'){
            item.content=typeof item.shape.GetDocContent==='function'?item.shape.GetDocContent():need(item.shape,['GetContent']).GetContent();
            if(textOf(item.content).trim()!==a.old_text)throw new Error('Slide text changed since the draft');
            need(item.content,['RemoveAllElements','GetElement','Push']);
            item.paragraphs=a.text.split('\n').map(function(line){var p=Api.CreateParagraph();p.AddText(line);return p;});
          }else if(a.operation==='move')need(item.shape,['SetPosition']);else if(a.operation==='resize')need(item.shape,['SetSize']);else need(targetSlide,['RemoveObject']);
        }else{
          var sw=pres.GetWidth(),sh=pres.GetHeight();
          if((a.x+a.width)*36000>sw+1||(a.y+a.height)*36000>sh+1)throw new Error('Object extends beyond slide; use the reported slide dimensions');
          if(targetSlide)need(targetSlide,['AddObject']);
          if(a.type==='add_slide_table'){
            item.drawing=need(Api,['CreateTable']).CreateTable(a.rows[0].length,a.rows.length);
            a.rows.forEach(function(row,r){row.forEach(function(value,c){item.drawing.GetRow(r).GetCell(c).GetContent().GetElement(0).AddText(value);});});
            need(item.drawing,['SetSize']).SetSize(Math.round(a.width*36000),Math.round(a.height*36000));
          }else if(a.type==='add_slide_chart'){
            item.drawing=need(Api,['CreateChart']).CreateChart(a.chart_type==='line'?'lineNormal':a.chart_type,a.data,a.series_names,a.categories,Math.round(a.width*36000),Math.round(a.height*36000),a.style,a.series_names.map(function(){return 'General';}));
            if(a.title)need(item.drawing,['SetTitle']).SetTitle(a.title,16);
            need(item.drawing,['SetLegendPos']).SetLegendPos(a.legend);
          }else{
            need(Api,['CreateShape','CreateNoFill','CreateStroke','CreateSolidFill','CreateRGBColor']);
            function fill(value){return value?Api.CreateSolidFill(Api.CreateRGBColor(parseInt(value.slice(1,3),16),parseInt(value.slice(3,5),16),parseInt(value.slice(5,7),16))):Api.CreateNoFill();}
            item.drawing=Api.CreateShape(a.shape,Math.round(a.width*36000),Math.round(a.height*36000),fill(a.fill),Api.CreateStroke(a.line_color?12700:0,fill(a.line_color)));
            if(a.text){var dc=typeof item.drawing.GetDocContent==='function'?item.drawing.GetDocContent():item.drawing.GetContent();dc.GetElement(0).AddText(a.text);}
          }
          need(item.drawing,['SetPosition']).SetPosition(Math.round(a.x*36000),Math.round(a.y*36000));
        }
        return true;
      }
      function applyTool(item) {
        var a=item.action;
        function checked(value){if(value===false||value===null)throw new Error('Editor rejected '+a.type);return value;}
        if(a.type==='edit_chart'){
          if(a.title!=null)checked(item.chart.SetTitle(a.title,16));if(a.legend!=null)checked(item.chart.SetLegendPos(a.legend));
          if(a.x_axis_title!=null)checked(item.chart.SetHorAxisTitle(a.x_axis_title,12));if(a.y_axis_title!=null)checked(item.chart.SetVerAxisTitle(a.y_axis_title,12));
          if(a.show_values!=null)checked(item.chart.SetShowDataLabels(false,false,a.show_values,false));if(a.width!=null)checked(item.chart.SetSize(Math.round(a.width*36000),Math.round(a.height*36000)));return;
        }
        if(kind==='word'){if(a.position==='end')checked(doc.Push(item.paragraph));else checked(doc.InsertContent([item.paragraph],true));return;}
        if(kind==='cell'){
          var target=item.sheet||(a.sheet?Api.GetSheet(a.sheet):sheet),r=a.range?target.GetRange(a.range):null;
          var ops={between:'xlBetween',not_between:'xlNotBetween',equal:'xlEqual',not_equal:'xlNotEqual',greater:'xlGreater',less:'xlLess',greater_equal:'xlGreaterEqual',less_equal:'xlLessEqual'};
          if(a.type==='sort_range'){
            var match=/^\$?([A-Z]+)\$?(\d+)(?::\$?([A-Z]+)\$?(\d+))?$/.exec(a.range);
            var col=match[1].split('').reduce(function(n,c){return n*26+c.charCodeAt(0)-64;},0);
            var args=[];for(var i=0;i<3;i++){var key=a.keys[i];args.push(key?columnName(col+key.column-1)+match[2]+':'+columnName(col+key.column-1)+(match[4]||match[2]):null,key&&key.order==='descending'?'xlDescending':'xlAscending');}
            args.push(a.headers?'xlYes':'xlNo','xlSortColumns');checked(r.SetSort.apply(r,args));
          }else if(a.type==='filter_range'){
            if(a.clear)checked(target.GetAutoFilter().ShowAllData());else if(a.field)checked(r.SetAutoFilter(a.field,a.criteria==null?undefined:a.criteria,a.operator||(Array.isArray(a.criteria)?'xlFilterValues':undefined),a.criteria2==null?undefined:a.criteria2,true));else checked(r.SetAutoFilter());
          }else if(a.type==='create_table')checked(target.FormatAsTable(a.range));
          else if(a.type==='set_validation'){
            var v=r.GetValidation();if(a.rule==='remove')checked(v.Delete());else{
              var types={list:'xlValidateList',whole:'xlValidateWholeNumber',decimal:'xlValidateDecimal',date:'xlValidateDate',text_length:'xlValidateTextLength',custom:'xlValidateCustom'};
              checked(v.Add(types[a.rule],'xlValidAlertStop',ops[a.operator],a.options.length?'"'+a.options.join(',')+'"':a.formula1,a.formula2||undefined));
              if(a.rule==='list'&&typeof v.SetInCellDropdown==='function')v.SetInCellDropdown(true);
              if(typeof v.SetShowError==='function')v.SetShowError(true);
            }
          }else if(a.type==='conditional_format'){
            var condition=checked(r.GetFormatConditions().Add(a.rule==='expression'?'xlExpression':'xlCellValue',ops[a.operator],a.formula1,a.formula2||undefined));
            checked(need(condition,['SetFillColor']).SetFillColor(Api.CreateColorFromRGB(parseInt(a.fill.slice(1,3),16),parseInt(a.fill.slice(3,5),16),parseInt(a.fill.slice(5,7),16))));
          }else if(a.type==='freeze_panes'){
            var panes=target.GetFreezePanes();if(a.unfreeze||!a.rows&&!a.columns)panes.Unfreeze();else if(a.rows&&a.columns)panes.FreezeAt(target.GetRange('A1:'+columnName(a.columns)+a.rows));else if(a.rows)panes.FreezeRows(a.rows);else panes.FreezeColumns(a.columns);
          }else if(a.type==='range_dimensions'){if(a.column_width!=null)checked(r.SetColumnWidth(a.column_width));if(a.row_height!=null)checked(r.SetRowHeight(a.row_height));}
          else {if(a.gridlines!=null)checked(target.SetDisplayGridlines(a.gridlines));if(a.headings!=null)checked(target.SetDisplayHeadings(a.headings));if(a.print_gridlines!=null)checked(target.SetPrintGridlines(a.print_gridlines));if(a.orientation)checked(target.SetPageOrientation(a.orientation));}
        }else{
          var slide=item.slide||pres.GetSlideByIndex(a.slide_index-1);
          if(!slide)throw new Error('Target slide was removed');
          if(a.type==='slide_operation'){
            if(a.operation==='duplicate')checked(slide.Duplicate(a.position?a.position-1:pres.GetSlidesCount()));
            else if(a.operation==='move')checked(slide.MoveTo(a.position-1));
            else if(a.operation==='delete')checked(slide.Delete());
            else if(a.operation==='notes')checked(slide.AddNotesText(a.notes));
            else checked(slide.SetVisible(a.operation==='show'));
          }else if(a.type==='replace_slide_text'){
            checked(item.content.RemoveAllElements());
            var first=item.content.GetElement(0);if(first){first.AddText(a.text.split('\n')[0]);item.paragraphs.slice(1).forEach(function(p){item.content.Push(p);});}else item.paragraphs.forEach(function(p){item.content.Push(p);});
          }else if(a.type==='slide_object'){
            if(a.operation==='move')checked(item.shape.SetPosition(Math.round(a.x*36000),Math.round(a.y*36000)));else if(a.operation==='resize')checked(item.shape.SetSize(Math.round(a.width*36000),Math.round(a.height*36000)));else checked(slide.RemoveObject(item.shape));
          }else checked(slide.AddObject(item.drawing));
        }
      }
      var plannedSheets = {};
      actions.forEach(function(a){
        var item={action:a};
        if(prepareTool(a,item)){prepared.push(item);return;}
        if(kind==='slide'&&a.type==='add_slide')plannedSlideCount++;
        if(kind==='slide'&&a.type==='clear_slides')plannedSlideCount=1;
        if(kind==='word') {
          if(a.type==='insert_blocks'||a.type==='replace_document') { item.blocks=makeBlocks(a.blocks); if(a.type==='replace_document')need(doc,['RemoveAllElements','Push','RemoveElement']);else if(a.position==='end')need(doc,['Push']);else {need(doc,['InsertContent']);if(a.position==='replace_selection'){if(!snapshot.selection)throw new Error('Select text to replace first');}else if(snapshot.selection)throw new Error('Deselect text before inserting at cursor');} }
          if(a.type==='set_header'||a.type==='set_footer') { need(section,[a.type==='set_header'?'GetHeader':'GetFooter']); var old = section[a.type==='set_header'?'GetHeader':'GetFooter']('default',false); if(old)need(old,['RemoveAllElements','Push','RemoveElement']); var p=paragraph({text:a.text,alignment:a.alignment,font_color:a.font_color,fill:a.fill});if(a.page_numbers){need(p,['AddPageNumber']);p.AddText(' ');p.AddPageNumber();} item.paragraph=p; }
          if(a.type==='set_page_layout')need(section,['SetPageSize','SetPageMargins']);
        } else if (kind === 'pdf') {
          if(snapshot.capabilities.indexOf(a.type)<0)throw new Error('This PDF editor does not support '+a.type);
          if(a.page>snapshot.page_count)throw new Error('PDF page does not exist');
          item.page=doc.GetPage(a.page-1);
          if(a.type==='pdf_rotate_page')need(item.page,['SetRotation']);
          else if(a.type==='pdf_add_text'){
            need(item.page,['AddObject']);need(Api,['CreateShape','CreateNoFill','CreateStroke']);
            item.shape=Api.CreateShape('rect',Math.round(a.width*36000),Math.round(a.height*36000),Api.CreateNoFill(),Api.CreateStroke(0,Api.CreateNoFill()));
            need(item.shape,['SetPosition','GetContent']);item.shape.SetPosition(Math.round(a.x*36000),Math.round(a.y*36000));
            var addedContent=need(item.shape.GetContent(),['GetElement']);var addedParagraph=need(addedContent.GetElement(0),['AddText']);
            if(a.font_size!==undefined)need(addedParagraph,['SetFontSize']).SetFontSize(a.font_size*2);
            addedParagraph.AddText(a.text);
          }else{
            var target=need(item.page,['GetAllDrawings']).GetAllDrawings()[a.object_index-1];
            item.content=need(need(target,['GetContent']).GetContent(),['RemoveAllElements','GetElement','GetAllParagraphs']);
            if(textOf(item.content)!==a.old_text)throw new Error('PDF text object changed. Ask Bob again before applying.');
            need(item.content.GetElement(0),a.font_size===undefined?['AddText']:['AddText','SetFontSize']);
          }
        } else if (kind === 'slide') {
          need(Api, ['GetPresentation', 'CreateSlide', 'CreateShape', 'CreateParagraph']);
        } else {
          if(a.type==='add_sheet'){need(Api,['AddSheet']);if(Api.GetSheet(a.name)||plannedSheets[a.name])throw new Error('Sheet already exists: '+a.name);plannedSheets[a.name]=true;}
          else {
            item.sheet=a.sheet?Api.GetSheet(a.sheet):sheet;
            if(!item.sheet&&!plannedSheets[a.sheet])throw new Error('Sheet not found: '+a.sheet);
            if(item.sheet){
              if(a.type==='set_print_header_footer'){item.setup=need(item.sheet,['GetPageSetup']).GetPageSetup();need(item.setup,['SetCenterHeader','SetCenterFooter']);}
              else if(a.type==='add_chart'){need(item.sheet,['AddChart']);}
              else if(a.type==='autofit_columns'){item.range=item.sheet.GetRange(a.range||'A1:N1');}
              else{item.range=item.sheet.GetRange(a.range);need(item.range,a.type==='set_cells'?['SetValue']:['SetBold','SetItalic','SetFillColor','SetFontColor','SetNumberFormat']);}
            }else if(a.type==='set_print_header_footer')throw new Error('Add the sheet before setting its print headers');
            else if(a.type==='add_chart'){need(sheet,['AddChart']);}
            else if(a.type==='autofit_columns'){need(sheet,['GetRange']);}
            else need(sheet.GetRange(a.range),a.type==='set_cells'?['SetValue']:['SetBold','SetItalic','SetFillColor','SetFontColor','SetNumberFormat']);
          }
        }
        prepared.push(item);
      });
      prepared.forEach(function(item){var a=item.action;
        function checked(result){if(result===false)throw new Error('Editor rejected '+a.type);}
        if(item.tool){applyTool(item);return;}
        if(kind==='word') {
          if(a.type==='replace_document'){doc.RemoveAllElements();item.blocks.forEach(function(b){doc.Push(b);});doc.RemoveElement(0);}
          // Keep the native selection intact: in 9.3 RemoveSelection only clears its highlight.
          else if(a.type==='insert_blocks'){if(a.position==='end')item.blocks.forEach(function(b){doc.Push(b);});else {if(doc.InsertContent(item.blocks,true)===false)throw new Error('Editor rejected content insertion');}}
          else if(a.type==='set_header'||a.type==='set_footer'){var content=section[a.type==='set_header'?'GetHeader':'GetFooter']('default',true);need(content,['RemoveAllElements','Push','RemoveElement']);content.RemoveAllElements();content.Push(item.paragraph);content.RemoveElement(0);}
          else {var size=a.size==='a4'?[11906,16838]:[12240,15840];if(a.orientation==='landscape')size.reverse();checked(section.SetPageSize(size[0],size[1],a.orientation==='portrait'));var m=Math.round(a.margins_mm*1440/25.4);checked(section.SetPageMargins(m,m,m,m));}
        } else if (kind === 'pdf') {
          if(a.type==='pdf_rotate_page')checked(item.page.SetRotation(a.angle));
          else if(a.type==='pdf_add_text')checked(item.page.AddObject(item.shape));
          else {checked(item.content.RemoveAllElements());var pdfParagraph=need(item.content.GetElement(0),['AddText']);if(a.font_size!==undefined)pdfParagraph.SetFontSize(a.font_size*2);checked(pdfParagraph.AddText(a.text));}
        } else if (kind === 'slide') {
          if (a.type === 'clear_slides') {
            var countNow = pres.GetSlidesCount();
            if (countNow > 1 && typeof pres.RemoveSlides === 'function') pres.RemoveSlides(1, countNow - 1);
            var s0 = pres.GetSlideByIndex(0);
            if (s0 && typeof s0.RemoveAllObjects === 'function') s0.RemoveAllObjects();
          } else if (a.type === 'add_slide') {
            var newSlide = Api.CreateSlide();
            pres.AddSlide(newSlide);
            populateSlide(newSlide, a);
          } else if (a.type === 'update_slide') {
            var idx0 = (a.slide_index || 1) - 1;
            var targetSlide = pres.GetSlideByIndex(idx0);
            if (!targetSlide) {
              targetSlide = Api.CreateSlide();
              pres.AddSlide(targetSlide);
            }
            populateSlide(targetSlide, a);
          }
        } else if(a.type==='add_sheet')checked(Api.AddSheet(a.name));
        else {
          var s=item.sheet||Api.GetSheet(a.sheet)||sheet;
          if(a.type==='set_cells')checked((item.range||s.GetRange(a.range)).SetValue(a.values.map(function(row){return row.map(function(v){return v===null?'':v;});})));
          else if(a.type==='set_print_header_footer'){checked(item.setup.SetCenterHeader(a.header));checked(item.setup.SetCenterFooter(a.footer+(a.page_numbers?' &P':'')));}
          else if(a.type==='add_chart'){
            var ctype=a.chart_type==='line'?'lineNormal':(a.chart_type||'bar');
            var sName=s.GetName();
            var dataRange=a.range.indexOf('!')>=0?a.range:("'"+sName.replace(/'/g,"''")+"'!"+a.range);
            var wEmu=Math.round((a.width_mm||160)*36000),hEmu=Math.round((a.height_mm||95)*36000);
            var fCol=typeof a.from_col==='number'?a.from_col:3,fRow=typeof a.from_row==='number'?a.from_row:1;
            var chart=s.AddChart(dataRange,Boolean(a.plot_by_rows),ctype,2,wEmu,hEmu,fCol,0,fRow,0);
            if(!chart)throw new Error('Editor could not create chart');
            if(a.title&&typeof chart.SetTitle==='function')chart.SetTitle(a.title,12);
            if(a.x_axis_title&&typeof chart.SetHorAxisTitle==='function')chart.SetHorAxisTitle(a.x_axis_title,10);
            if(a.y_axis_title&&typeof chart.SetVerAxisTitle==='function')chart.SetVerAxisTitle(a.y_axis_title,10);
            if(a.legend&&typeof chart.SetLegendPos==='function')chart.SetLegendPos(a.legend);
          }
          else if(a.type==='autofit_columns'){
            var afRange=item.range||s.GetRange(a.range||'A1:N1');
            if(afRange&&typeof afRange.AutoFit==='function')afRange.AutoFit(false,true);
          }
          else {var r=item.range||s.GetRange(a.range);if(a.bold!==undefined&&a.bold!==null)checked(r.SetBold(a.bold));if(a.italic!==undefined&&a.italic!==null)checked(r.SetItalic(a.italic));function color(v){return Api.CreateColorFromRGB(parseInt(v.slice(1,3),16),parseInt(v.slice(3,5),16),parseInt(v.slice(5,7),16));}if(a.fill)checked(r.SetFillColor(color(a.fill)));if(a.font_color)checked(r.SetFontColor(color(a.font_color)));if(a.number_format)checked(r.SetNumberFormat(a.number_format));}
        }
      });
      return {ok:true,value:{applied:actions.length}};
    } catch(e) { return {ok:false,error:String(e.message||e)}; }
  }
  function run(message) {
    return new Promise(function(resolve,reject){
      if(stalled){reject(new Error('Editor command timed out. Reopen this document before applying more changes.'));return;}
      var kind=documentKind||window.Asc.plugin.info.editorType;
      if(['word','cell','slide','pdf'].indexOf(kind)<0){reject(new Error('Unsupported editor'));return;}
      if(message.command==='present') {
        if(kind!=='slide'||typeof window.Asc.plugin.executeMethod!=='function'){reject(new Error('This editor cannot start a slide show.'));return;}
        var showTimer=setTimeout(function(){reject(new Error('The slide show did not confirm. Use the editor Slide Show menu.'));},15000);
        window.Asc.plugin.executeMethod('StartSlideShow',[],function(){clearTimeout(showTimer);resolve({ok:true});});
        return;
      }
      if(message.command==='apply') { try { object(message.payload,['plan','expectedContext']);validate(message.payload.plan);if(message.payload.plan.kind!==kind)fail('Wrong document type'); if(!message.payload.expectedContext)fail('Preview context required'); }catch(e){reject(e);return;} }
      Asc.scope.buddyOfficeRequest={command:message.command,kind:kind,payload:message.payload};
      var timer=setTimeout(function(){stalled=true;reject(new Error('Editor did not respond. Reopen the document before trying again.'));},30000);
      window.Asc.plugin.callCommand(officeCommand,false,message.command==='apply',function(result){clearTimeout(timer);if(!result||!result.ok)reject(new Error(result&&result.error||'Editor command failed'));else resolve(result.value);});
    });
  }
  window.addEventListener('message',function(event){
    if(event.source!==window.top||event.origin!==location.origin)return;
    var m=event.data;if(!m||m.bridge!=='buddy-office'||!ready)return;
    if(m.type==='connect'){if(typeof m.channel!=='string'||m.channel.length<16||m.channel.length>200)return;documentKind=m.kind==='pdf'&&['word','pdf'].indexOf(window.Asc.plugin.info.editorType)>=0?'pdf':null;channel=m.channel;send({type:'connected'});return;}
    if(m.type!=='request'||m.channel!==channel||!channel||typeof m.id!=='string'||m.id.length>100||['context','apply','present'].indexOf(m.command)<0)return;
    var requestChannel=channel;
    queue=queue.then(function(){return run(m);}).then(function(result){if(channel===requestChannel)send({type:'result',id:m.id,result:result});},function(e){if(channel===requestChannel)send({type:'result',id:m.id,error:String(e.message||e)});});
  });
  window.Asc.plugin.init=function(){ready=true;send({type:'hello'});};
  setInterval(function(){if(ready&&!channel)send({type:'hello'});},1500);
})();
