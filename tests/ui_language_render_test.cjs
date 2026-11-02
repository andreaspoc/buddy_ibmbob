const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('../web/node_modules/typescript');
const React = require('../web/node_modules/react');
const {renderToStaticMarkup} = require('../web/node_modules/react-dom/server');
for (const extension of ['.ts','.tsx']) require.extensions[extension] = (module, filename) => {
  const compiled = ts.transpileModule(fs.readFileSync(filename,'utf8'), {compilerOptions: {module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
  module._compile(compiled,filename);
};
const values = new Map();
global.localStorage = {getItem:key=>values.get(key),setItem:(key,value)=>values.set(key,value)};
global.document = {documentElement:{lang:'en'}};
global.window = {addEventListener:()=>{}};
const {setLanguage,t} = require('../web/src/lib/i18n.ts');
const {Topbar, formatTokens, formatBobcoins} = require('../web/src/components/Topbar.tsx');
const {MCPConnectionCard} = require('../web/src/components/MCPConnectionCard.tsx');
const {ArtifactChangeRequest} = require('../web/src/components/ArtifactChangeRequest.tsx');
const {LanguageSelector} = require('../web/src/components/LanguageSelector.tsx');
const props = {activeModeName:'Chat',sessionTokens:null,sessionCost:null,onToggleSidebar:()=>{},onGenerateExecutiveDeck:()=>{}};
const server = {name:'My MCP α',target:'https://example.test/mcp',transport:'http',disabled:false};
for (const language of ['en','el','hi','mt']) {
  setLanguage(language);
  if (language === 'el') {
    assert.equal(formatTokens(1200), '1,2 χιλ. μονάδες κειμένου');
    assert.equal(formatBobcoins(1.25), '1,250 Bobcoins');
    assert.equal(t('Agent mode'), 'Λειτουργία βοηθού');
  }
  if (language === 'hi') {
    assert.equal(formatTokens(1200), '1.2 हज़ार टोकन');
    assert.equal(formatTokens(120000), '1.2 लाख टोकन');
    assert.equal(formatTokens(12000000), '1.2 करोड़ टोकन');
    assert.equal(formatBobcoins(123456.25), '1,23,456.250 Bobcoins');
  }
  const topbar = renderToStaticMarkup(React.createElement(Topbar,props));
  const card = renderToStaticMarkup(React.createElement(MCPConnectionCard,{server,isAdmin:true,onConfigure:()=>{}}));
  const employeeCard = renderToStaticMarkup(React.createElement(MCPConnectionCard,{server,isAdmin:false,onConfigure:()=>{}}));
  const artifact = renderToStaticMarkup(React.createElement(ArtifactChangeRequest,{path:'report.html'}));
  const selector = renderToStaticMarkup(React.createElement(LanguageSelector));
  assert.ok(selector.includes('value="mt"'));
  assert.ok(selector.includes('Malti'));
  assert.ok(selector.includes(t('Language')));
  assert.ok(topbar.includes(t('Tokens not reported')));
  assert.ok(card.includes(t('Configure')));
  assert.ok(!employeeCard.includes(t('Configure')));
  assert.ok(card.includes('My MCP α'));
  assert.ok(card.includes('https://example.test/mcp'));
  assert.ok(card.includes('class="mcp-connection-card '));
  assert.ok(topbar.includes('class="topbar-actions"'));
  assert.ok(selector.includes('value="hi"'));
  assert.ok(selector.includes('हिन्दी'));
  assert.ok(artifact.includes(t('Request changes')));
}
console.log('English/Greek/Hindi/Maltese controls render with stable CSS classes and preserved server content.');
