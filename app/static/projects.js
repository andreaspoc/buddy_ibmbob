let projectsCatalog = [];
let projectFiles = [];
let selectedProjectFile = null;
let originalProjectContent = '';
let currentProjectId = '';
const projectDialog = byId('project-dialog');
const importDialog = byId('project-import-dialog');

async function projectRequest(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : 'Project request failed');
  return data;
}
async function loadProjects() {
  projectsCatalog = await projectRequest('/projects');
  const select = byId('project-select');
  select.replaceChildren(new Option('Personal conversations', ''));
  for (const project of projectsCatalog) select.append(new Option(project.name, project.id));
  select.value = currentProjectId;
}
function projectDirty() {
  return selectedProjectFile && byId('project-file-content').value !== originalProjectContent;
}
function discardProjectChanges() { return !projectDirty() || window.confirm('Discard unsaved file edits?'); }
function resetProjectEditor() {
  selectedProjectFile = null;
  originalProjectContent = '';
  byId('project-file-content').value = '';
  byId('project-file-content').disabled = true;
  byId('project-save').disabled = true;
  byId('project-ask').disabled = true;
  byId('project-file-name').textContent = 'Select a file';
}
byId('project-select').addEventListener('change', async event => {
  if (busy) { event.target.value = currentProjectId; return; }
  currentProjectId = event.target.value;
  byId('open-project').classList.toggle('hidden', !currentProjectId);
  await loadSessions();
  const first = sessionsCatalog.find(s => (s.project_id || '') === currentProjectId);
  if (first) await switchSession(first.id); else await startNewChat();
});
byId('new-project').addEventListener('click', () => {
  if (busy) return;
  byId('project-import-form').reset();
  byId('project-source').dispatchEvent(new Event('change'));
  byId('project-import-error').textContent = '';
  importDialog.showModal();
});
byId('project-import-close').addEventListener('click', () => importDialog.close());
byId('project-source').addEventListener('change', event => {
  const source=event.target.value;
  byId('project-zip-field').classList.toggle('hidden', source !== 'zip');
  byId('project-git-fields').classList.toggle('hidden', source !== 'git');
  byId('project-import-form').elements.archive.required = source === 'zip';
  byId('project-import-form').elements.url.required = source === 'git';
  byId('project-import-form').elements.archive.disabled = source !== 'zip';
  byId('project-import-form').elements.url.disabled = source !== 'git';
  byId('project-import-form').elements.branch.disabled = source !== 'git';
});
byId('project-import-form').addEventListener('submit', async event => {
  event.preventDefault();
  const f=event.currentTarget;
  const button=byId('project-import-submit');
  button.disabled=true; button.textContent='Importing…';
  byId('project-import-error').textContent='';
  try {
    let project;
    if(f.elements.source.value==='zip') {
      const file=f.elements.archive.files[0];
      if(!file || file.size>50*1024*1024) throw new Error('Choose a ZIP up to 50 MB');
      project=await projectRequest(`/projects/upload?name=${encodeURIComponent(f.elements.name.value)}`,{method:'POST',headers:{'Content-Type':'application/zip'},body:file});
    } else {
      project=await projectRequest('/projects',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:f.elements.name.value,url:f.elements.source.value==='git'?f.elements.url.value:'',branch:f.elements.branch.value})});
    }
    currentProjectId=project.id;
    await loadProjects();
    await startNewChat();
    importDialog.close();
    await openProject();
  } catch(error) { byId('project-import-error').textContent=error.message; }
  finally { button.disabled=false; button.textContent='Create project'; }
});
async function openProject() {
  if(!currentProjectId) return;
  resetProjectEditor();
  byId('project-title').textContent=projectsCatalog.find(p=>p.id===currentProjectId)?.name || 'Project';
  byId('project-download').href=`/projects/${currentProjectId}/download`;
  byId('project-error').textContent='';
  byId('project-file-search').value='';
  projectDialog.showModal();
  await showProjectFiles();
}
byId('open-project').addEventListener('click', openProject);
byId('project-close').addEventListener('click',()=>{if(discardProjectChanges())projectDialog.close();});
projectDialog.addEventListener('cancel',event=>{if(!discardProjectChanges())event.preventDefault();});
async function showProjectFiles() {
  byId('project-explorer').classList.remove('hidden');
  byId('project-diff').classList.add('hidden');
  try {
    projectFiles=await projectRequest(`/projects/${currentProjectId}/files`);
    renderProjectFiles();
  } catch(error) { byId('project-error').textContent=error.message; }
}
function renderProjectFiles() {
  const list=byId('project-file-list'); list.replaceChildren();
  const query=byId('project-file-search').value.toLowerCase();
  for(const file of projectFiles.filter(f=>f.path.toLowerCase().includes(query))) {
    const button=document.createElement('button'); button.type='button'; button.textContent=file.path;
    button.title=`${file.size.toLocaleString()} bytes`;
    button.classList.toggle('active',file.path===selectedProjectFile);
    button.addEventListener('click',()=>openProjectFile(file.path)); list.append(button);
  }
  if(!list.children.length) list.textContent=projectFiles.length?'No matching files':'No files yet. Ask Buddy to create your application.';
}
async function openProjectFile(path) {
  if(!discardProjectChanges())return;
  byId('project-error').textContent='';
  try {
    const file=await projectRequest(`/projects/${currentProjectId}/file?path=${encodeURIComponent(path)}`);
    selectedProjectFile=path; originalProjectContent=file.content;
    byId('project-file-name').textContent=path;
    byId('project-file-content').value=file.content;
    byId('project-file-content').disabled=false;
    byId('project-save').disabled=true;
    byId('project-ask').disabled=false;
    renderProjectFiles();
  } catch(error) { byId('project-error').textContent=error.message; }
}
byId('project-file-search').addEventListener('input',renderProjectFiles);
byId('project-file-content').addEventListener('input',()=>{byId('project-save').disabled=!projectDirty();});
byId('project-save').addEventListener('click',async()=>{
  try {
    await projectRequest(`/projects/${currentProjectId}/file`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:selectedProjectFile,content:byId('project-file-content').value,original:originalProjectContent})});
    originalProjectContent=byId('project-file-content').value; byId('project-save').disabled=true;
    byId('project-error').textContent='Saved';
  }catch(error){byId('project-error').textContent=error.message;}
});
byId('project-ask').addEventListener('click',()=>{
  if(!discardProjectChanges())return;
  projectDialog.close();promptInput.value=`Read ${selectedProjectFile} in this project and `;promptInput.focus();resizeInput();
});
byId('project-files-tab').addEventListener('click',showProjectFiles);
byId('project-refresh').addEventListener('click',async()=>{if(!discardProjectChanges())return;resetProjectEditor();await showProjectFiles();});
byId('project-changes-tab').addEventListener('click',async()=>{
  const panel=byId('project-diff');panel.replaceChildren();
  byId('project-explorer').classList.add('hidden');panel.classList.remove('hidden');
  try {
    const result=await projectRequest(`/projects/${currentProjectId}/changes`);
    const summary=document.createElement('p');summary.textContent=result.diff||result.untracked.length?'Changes against the current Git HEAD revision':'No changes since import.';panel.append(summary);
    if(result.untracked.length){const info=document.createElement('p');info.textContent=`New files: ${result.untracked.join(', ')}`;panel.append(info);}
    const pre=document.createElement('pre');
    for(const line of result.diff.split('\n')){const span=document.createElement('span');span.textContent=line+'\n';span.className=line.startsWith('+')?'diff-add':line.startsWith('-')?'diff-remove':line.startsWith('@@')?'diff-hunk':'';pre.append(span);}
    panel.append(pre);
    if(result.truncated)panel.append(document.createTextNode('Diff truncated at 1 MB. Download the project to review all changes.'));
  }catch(error){byId('project-error').textContent=error.message;}
});
