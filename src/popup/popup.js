/**
 * popup.js — Lógica del popup de gestión de categorías.
 * Depende de storage.js (window.YCSM.storage).
 */
document.addEventListener('DOMContentLoaded', async () => {
  const { t, count, apply } = YCSM.i18n;
  document.title = t('appName');
  apply();
  /* ── Refs DOM ── */
  const catList   = document.getElementById('catList');
  const addForm   = document.getElementById('addForm');
  const btnAdd    = document.getElementById('btnAdd');
  const btnSave   = document.getElementById('btnSave');
  const btnCancel = document.getElementById('btnCancel');
  const btnOrg    = document.getElementById('btnOrganize');
  const nameInput = document.getElementById('newName');


  let editingId = null; // null = crear, string = editar

  /* ── Utilidades ── */
  function esc(v) {
    const d = document.createElement('div');
    d.appendChild(document.createTextNode(String(v ?? '')));
    return d.innerHTML;
  }



  /* ── Render ── */
  async function render() {
    const { categories, channelAssignments } = await YCSM.storage.getAll();
    const sorted = Object.values(categories).sort((a, b) => a.order - b.order);

    catList.innerHTML = '';

    if (sorted.length === 0) {
      catList.innerHTML =
        `<div class="empty">${t('emptyCategoriesPopup')}</div>`;
      return;
    }

    sorted.forEach((cat) => {
      const channelCount = Object.values(channelAssignments).filter((ids) =>
        ids.includes(cat.id)
      ).length;

      const item = document.createElement('div');
      item.className = 'cat-item';
      item.setAttribute('role', 'listitem');
      item.dataset.id = cat.id;

      item.innerHTML = `
        <div class="cat-meta">
          <span class="cat-name">${esc(cat.name)}</span>
          <span class="cat-count">${count('channelCount', channelCount)}</span>
        </div>
        <div class="cat-actions" role="group" aria-label="${esc(t('categoryActions', [cat.name]))}">
          <button class="btn-icon btn-edit" data-id="${esc(cat.id)}" aria-label="${esc(t('editCategoryName', [cat.name]))}"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 000-1.41l-2.34-2.34a1 1 0 00-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg></button>
          <button class="btn-icon btn-del"  data-id="${esc(cat.id)}" aria-label="${esc(t('deleteCategoryName', [cat.name]))}"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg></button>
        </div>
      `;

      item.querySelector('.btn-edit').addEventListener('click', () => startEdit(cat));
      item.querySelector('.btn-del').addEventListener('click', () => deleteCat(cat.id, cat.name));

      catList.appendChild(item);
    });
  }

  /* ── Formulario: mostrar / ocultar ── */
  function showForm(show) {
    addForm.hidden = !show;
    btnAdd.hidden  = show;
    btnAdd.setAttribute('aria-expanded', show ? 'true' : 'false');
    if (show) nameInput.focus();
  }

  function resetForm() {
    editingId = null;
    nameInput.value  = '';
    btnSave.textContent = t('create');
    showForm(false);
  }

  function startEdit(cat) {
    editingId = cat.id;
    nameInput.value  = cat.name;
    btnSave.textContent = t('save');
    showForm(true);
  }

  /* ── CRUD ── */
  async function saveCategory() {
    const name  = nameInput.value.trim();
    if (!name) {
      nameInput.focus();
      return;
    }

    if (editingId) {
      await YCSM.storage.updateCategory(editingId, { name });
    } else {
      await YCSM.storage.addCategory(name);
    }

    resetForm();
    await render();
    notifyTab('refreshSidebar');
  }

  async function deleteCat(id, name) {
    if (confirm(t('deleteCategoryConfirm', [name]))) {
      await YCSM.storage.deleteCategory(id);
      await render();
      notifyTab('refreshSidebar');
    }
  }

  /* ── Comunicación con el content script ── */
  function notifyTab(action) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs?.[0];
      if (tab?.id) {
        chrome.tabs.sendMessage(tab.id, { action }).catch(() => {
          // El content script puede no estar en YouTube — silencioso
        });
      }
    });
  }

  /* ── Eventos ── */
  btnAdd.addEventListener('click', () => showForm(true));

  btnSave.addEventListener('click', saveCategory);

  btnCancel.addEventListener('click', resetForm);

  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter')  saveCategory();
    if (e.key === 'Escape') resetForm();
  });

  btnOrg.addEventListener('click', () => {
    notifyTab('openPanel');
    window.close();
  });

  /* ── Reactividad ── */
  YCSM.storage.onChange(render);

  /* ── Init ── */
  await render();
});
