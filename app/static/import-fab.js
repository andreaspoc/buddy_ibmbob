/**
 * import-fab.js
 * Handles the floating Import FAB button and full-window drag-and-drop for ZIPs.
 * Depends on: projects.js (projectRequest, loadProjects, openProject, currentProjectId)
 *             app.js     (startNewChat, busy)
 */
(function () {
  'use strict';

  const fab         = document.getElementById('import-fab');
  const overlay     = document.getElementById('drop-overlay');
  const importDialog = document.getElementById('project-import-dialog');
  const importForm  = document.getElementById('project-import-form');
  const sourceSelect = document.getElementById('project-source');

  // ── FAB click → open the existing import dialog ──────────────────────────
  fab.addEventListener('click', () => {
    if (typeof busy !== 'undefined' && busy) return;
    importForm.reset();
    sourceSelect.dispatchEvent(new Event('change'));
    document.getElementById('project-import-error').textContent = '';
    importDialog.showModal();
  });

  // ── Drag-and-drop ─────────────────────────────────────────────────────────
  let dragDepth = 0;

  function hasZip(dt) {
    if (!dt) return false;
    // Check types first (fast path)
    for (const type of dt.types) {
      if (type === 'Files') return true;
    }
    return false;
  }

  document.addEventListener('dragenter', (e) => {
    if (!hasZip(e.dataTransfer)) return;
    e.preventDefault();
    dragDepth++;
    overlay.classList.add('active');
  }, false);

  document.addEventListener('dragover', (e) => {
    if (!hasZip(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }, false);

  document.addEventListener('dragleave', (e) => {
    dragDepth--;
    if (dragDepth <= 0) {
      dragDepth = 0;
      overlay.classList.remove('active');
    }
  }, false);

  document.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragDepth = 0;
    overlay.classList.remove('active');

    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;

    const zipFile = Array.from(files).find(
      (f) => f.name.toLowerCase().endsWith('.zip') || f.type === 'application/zip'
    );
    if (!zipFile) {
      alert('Please drop a .zip file.');
      return;
    }

    if (zipFile.size > 50 * 1024 * 1024) {
      alert('ZIP file is too large (max 50 MB).');
      return;
    }

    // Derive a default project name from the filename (strip extension)
    const defaultName = zipFile.name.replace(/\.zip$/i, '').replace(/[-_]/g, ' ').trim() || 'Imported project';
    const name = window.prompt('Project name for this ZIP:', defaultName);
    if (!name || !name.trim()) return;

    await uploadAndOpenProject(zipFile, name.trim());
  }, false);

  // ── Shared upload helper ──────────────────────────────────────────────────
  async function uploadAndOpenProject(file, name) {
    // Show a transient status on the FAB
    const originalText = fab.textContent;
    fab.textContent = '…';
    fab.disabled = true;

    try {
      const project = await projectRequest(
        `/projects/upload?name=${encodeURIComponent(name)}`,
        { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: file }
      );

      // Mirror what the dialog submit handler does
      // currentProjectId is a global defined in app.js / projects.js
      window.currentProjectId = project.id;
      await loadProjects();
      await startNewChat();
      await openProject();
    } catch (err) {
      alert('Import failed: ' + err.message);
    } finally {
      fab.textContent = originalText;
      fab.disabled = false;
    }
  }
})();
