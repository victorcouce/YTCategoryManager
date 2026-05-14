/**
 * popup.js — Lógica del popup de gestión de categorías.
 * Depende de storage.js (window.YCSM.storage).
 */
document.addEventListener('DOMContentLoaded', async () => {
  /* ── Refs DOM ── */
  const catList   = document.getElementById('catList');
  const addForm   = document.getElementById('addForm');
  const btnAdd    = document.getElementById('btnAdd');
  const btnSave   = document.getElementById('btnSave');
  const btnCancel = document.getElementById('btnCancel');
  const btnOrg    = document.getElementById('btnOrganize');
  const nameInput = document.getElementById('newName');
  const colorInput= document.getElementById('newColor');
  const emojiInput= document.getElementById('newEmoji');

  let editingId = null; // null = crear, string = editar

  /* ── Utilidades ── */
  function esc(v) {
    const d = document.createElement('div');
    d.appendChild(document.createTextNode(String(v ?? '')));
    return d.innerHTML;
  }

  function sanitizeColor(c) {
    return /^#[0-9A-Fa-f]{3,8}$/.test(c) ? c : '#4285F4';
  }

  /* ── Render ── */
  async function render() {
    const { categories, channelAssignments } = await YCSM.storage.getAll();
    const sorted = Object.values(categories).sort((a, b) => a.order - b.order);

    catList.innerHTML = '';

    if (sorted.length === 0) {
      catList.innerHTML =
        '<div class="empty">Sin categorías.<br>Crea la primera abajo.</div>';
      return;
    }

    sorted.forEach((cat) => {
      const color = sanitizeColor(cat.color);
      const channelCount = Object.values(channelAssignments).filter((ids) =>
        ids.includes(cat.id)
      ).length;

      const item = document.createElement('div');
      item.className = 'cat-item';
      item.setAttribute('role', 'listitem');
      item.dataset.id = cat.id;

      item.innerHTML = `
        <span class="cat-dot" style="background:${color}" aria-hidden="true"></span>
        <div class="cat-meta">
          <span class="cat-name">${esc((cat.emoji ? cat.emoji + ' ' : '') + cat.name)}</span>
          <span class="cat-count">${channelCount} canal${channelCount !== 1 ? 'es' : ''}</span>
        </div>
        <div class="cat-actions" role="group" aria-label="Acciones de ${esc(cat.name)}">
          <button class="btn-icon btn-edit" data-id="${esc(cat.id)}" aria-label="Editar ${esc(cat.name)}">✏️</button>
          <button class="btn-icon btn-del"  data-id="${esc(cat.id)}" aria-label="Eliminar ${esc(cat.name)}">🗑️</button>
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
    colorInput.value = '#4285F4';
    emojiInput.value = '';
    btnSave.textContent = 'Crear';
    showForm(false);
  }

  function startEdit(cat) {
    editingId = cat.id;
    nameInput.value  = cat.name;
    colorInput.value = sanitizeColor(cat.color);
    emojiInput.value = cat.emoji || '';
    btnSave.textContent = 'Guardar';
    showForm(true);
  }

  /* ── CRUD ── */
  async function saveCategory() {
    const name  = nameInput.value.trim();
    const color = colorInput.value;
    const emoji = emojiInput.value.trim();

    if (!name) {
      nameInput.focus();
      return;
    }

    if (editingId) {
      await YCSM.storage.updateCategory(editingId, { name, color, emoji });
    } else {
      await YCSM.storage.addCategory(name, color, emoji);
    }

    resetForm();
    await render();
    notifyTab('refreshSidebar');
  }

  async function deleteCat(id, name) {
    if (confirm(`¿Eliminar "${name}"?\nLos canales no se perderán, solo se desasignarán.`)) {
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
