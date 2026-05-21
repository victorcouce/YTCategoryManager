/**
 * panel-ui.js — UI for the "Organize Subscriptions" page.
 *
 * Renders the modal that lives inside the iframe loaded by panel.js
 * (content script). All data goes through YCSM.storage; all strings
 * go through YCSM.i18n with the existing data-i18n attribute pattern
 * (keys listed at the bottom of this file).
 *
 * Category schema extension:
 *   The redesign adds a `color` field to each category (an integer
 *   hue 0–360 used by oklch). Categories created here always include
 *   it; categories created by the older sidebar fall back to a hash
 *   of their id, so legacy data renders fine without migration.
 */
(function () {
  'use strict';
  if (!window.YCSM) window.YCSM = {};
  const i18n = window.YCSM.i18n || { t: (k) => k, count: (k, n) => String(n), apply: () => {} };
  const storage = window.YCSM.storage;
  const { t, count: ct, apply: applyI18n } = i18n;
  const { HUE_PALETTE, hashHue } = window.YCSM.utils;

  /* ─── DOM helper ─────────────────────────────────────────────── */
  const SVG_NS = 'http://www.w3.org/2000/svg';
  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    let pendingValue;
    if (props) for (const k in props) {
      const v = props[k];
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'ref' && typeof v === 'function') v(el);
      else if (k === 'i18n')          el.setAttribute('data-i18n', v);
      else if (k === 'i18nHtml')      el.setAttribute('data-i18n-html', v);
      else if (k === 'i18nTitle')     el.setAttribute('data-i18n-title', v);
      else if (k === 'i18nPlaceholder') el.setAttribute('data-i18n-placeholder', v);
      else if (k === 'i18nAria')      el.setAttribute('data-i18n-aria-label', v);
      else if (k === 'value')         pendingValue = v;
      else if (v === true)            el.setAttribute(k, '');
      else                            el.setAttribute(k, v);
    }
    for (const c of children.flat(Infinity)) {
      if (c == null || c === false) continue;
      el.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
    }
    if (pendingValue !== undefined) el.value = pendingValue;
    return el;
  }

  function icon(paths, opts = {}) {
    const s = document.createElementNS(SVG_NS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('fill', opts.fill || 'none');
    s.setAttribute('stroke', opts.stroke || 'currentColor');
    s.setAttribute('stroke-width', opts.sw || 2);
    s.setAttribute('stroke-linecap', 'round');
    s.setAttribute('stroke-linejoin', 'round');
    const size = opts.size || 20;
    s.setAttribute('width', size);
    s.setAttribute('height', size);
    s.innerHTML = paths;
    return s;
  }

  const ICONS = {
    close:      '<path d="M18 6L6 18M6 6l12 12"/>',
    search:     '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.35-3.35"/>',
    plus:       '<path d="M12 5v14M5 12h14"/>',
    minus:      '<path d="M5 12h14"/>',
    check:      '<polyline points="20 6 9 17 4 12"/>',
    trash:      '<path d="M3 6h18"/><path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/>',
    pencil:     '<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4z"/>',
    drag:       '<circle cx="9" cy="6" r="1.2" fill="currentColor"/><circle cx="9" cy="12" r="1.2" fill="currentColor"/><circle cx="9" cy="18" r="1.2" fill="currentColor"/><circle cx="15" cy="6" r="1.2" fill="currentColor"/><circle cx="15" cy="12" r="1.2" fill="currentColor"/><circle cx="15" cy="18" r="1.2" fill="currentColor"/>',
    list:       '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>',
    grid:       '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>',
    sort:       '<path d="M3 6h18"/><path d="M6 12h12"/><path d="M10 18h4"/>',
    caret:      '<polyline points="6 9 12 15 18 9"/>',
    tag:        '<path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/>',
    folderPlus: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/>',
    globe:      '<circle cx="12" cy="12" r="9"/><line x1="3" y1="12" x2="21" y2="12"/><path d="M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  };

  /* ─── Category color helpers ─────────────────────────────────── */
  function catHue(c) {
    if (!c) return 0;
    if (typeof c.color === 'number') return c.color;
    if (typeof c.hue   === 'number') return c.hue;
    return hashHue(c.id || c.name);
  }
  function catColor(c) { return `oklch(0.72 0.16 ${catHue(c)})`; }
  function catBg(c, a = 0.16) { return `oklch(0.72 0.16 ${catHue(c)} / ${a})`; }

  /* ─── State ──────────────────────────────────────────────────── */
  const state = {
    categories: [],
    channels: [],
    assignments: {},
    view: 'all',           // 'all' | 'uncategorized' | <categoryId>
    search: '',
    sort: 'name',          // 'name' | 'recent'
    selected: new Set(),
    manage: false,
    layout: 'list',        // 'list' | 'grid'
    picker: null,          // { kind: 'row'|'card'|'bulk', chId?, query }
    colorEditId: null,
    editingId: null,
    editingName: '',
    creatingCat: false,
    newCatName: '',
    drag: null,            // { id, originIndex, insertIndex, ghostX, ghostY, ghostW, started }
    loading: true,         // true until first channel data arrives from storage
  };

  const ROW_REFS = new Map();
  let SIDEBAR_NAV = null;

  /* ─── Data ops ───────────────────────────────────────────────── */
  function sortByOrder(map) {
    return Object.values(map || {}).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }
  async function refreshFromStorage() {
    const all = await storage.getAll();
    state.categories = sortByOrder(all.categories);
    state.assignments = all.channelAssignments || {};
    if (all.settings?.subscriptionsLayout === 'list' || all.settings?.subscriptionsLayout === 'grid') {
      state.layout = all.settings.subscriptionsLayout;
    }
    const cached = await storage.getCachedChannels();
    state.channels = cached.channels || [];
    if (state.channels.length > 0) state.loading = false;
  }

  async function setLayout(layout) {
    if (layout !== 'list' && layout !== 'grid') return;
    state.layout = layout;
    render();
    const settings = await storage.getSettings();
    if (settings.subscriptionsLayout !== layout) {
      await storage.saveSettings({ ...settings, subscriptionsLayout: layout });
    }
  }

  async function actAddCategory(name) {
    const cat = await storage.addCategory(name);
    const color = HUE_PALETTE[(cat.order ?? 0) % HUE_PALETTE.length];
    await storage.updateCategory(cat.id, { color });
    await refreshFromStorage();
  }
  async function actRename(id, name) {
    await storage.updateCategory(id, { name });
    await refreshFromStorage();
  }
  async function actDelete(id) {
    await storage.deleteCategory(id);
    if (state.view === id) state.view = 'all';
    await refreshFromStorage();
  }
  async function actSetColor(id, color) {
    await storage.updateCategory(id, { color });
    await refreshFromStorage();
  }
  async function actReorder(orderedIds) {
    await storage.reorderCategories(orderedIds);
    await refreshFromStorage();
  }
  async function actToggle(chId, catId) {
    await storage.toggleChannelCategory(chId, catId);
    await refreshFromStorage();
  }
  async function actBulkAssign(chIds, catId) {
    for (const id of chIds) {
      const has = (state.assignments[id] || []).includes(catId);
      if (!has) await storage.assignChannel(id, catId);
    }
    await refreshFromStorage();
  }
  async function actBulkToggle(chIds, catId) {
    const allHaveCategory = chIds.length > 0 && chIds.every((id) =>
      (state.assignments[id] || []).includes(catId)
    );
    for (const id of chIds) {
      if (allHaveCategory) await storage.unassignChannel(id, catId);
      else {
        const has = (state.assignments[id] || []).includes(catId);
        if (!has) await storage.assignChannel(id, catId);
      }
    }
    await refreshFromStorage();
  }

  function channelCats(ch) {
    const ids = state.assignments[ch.id] || [];
    return ids.map((id) => state.categories.find((c) => c.id === id)).filter(Boolean);
  }

  function filteredChannels() {
    const norm = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    let out = state.channels;
    if (state.view === 'uncategorized')      out = out.filter((c) => !(state.assignments[c.id]?.length));
    else if (state.view !== 'all')           out = out.filter((c) => (state.assignments[c.id] || []).includes(state.view));
    const q = norm(state.search.trim());
    if (q) out = out.filter((c) => norm(c.name).includes(q));
    if (state.sort === 'name')        out = [...out].sort((a, b) => a.name.localeCompare(b.name));
    else /* recent → list order */    out = [...out];
    return out;
  }

  /* ─── Render ─────────────────────────────────────────────────── */
  const root = document.getElementById('modal-root');

  function render() {
    const active = document.activeElement;
    const aId = active?.id;
    const aSel = (active && 'selectionStart' in active) ? active.selectionStart : null;
    const areaScroll = document.querySelector('.channel-area')?.scrollTop ?? 0;

    root.innerHTML = '';
    root.appendChild(buildModal());

    const area = document.querySelector('.channel-area');
    if (area && areaScroll > 0) area.scrollTop = areaScroll;

    if (aId) {
      const re = document.getElementById(aId);
      if (re) {
        re.focus();
        if (aSel != null && typeof re.setSelectionRange === 'function') {
          try { re.setSelectionRange(aSel, aSel); } catch (_) {}
        }
      }
    }
    applyI18n(root);
  }

  function buildModal() {
    const filtered = filteredChannels();
    return h('div', { class: 'modal-wrap' },
      h('div', { class: 'modal' },
        buildHead(),
        h('div', { class: 'modal-body' }, buildSidebar(), buildMain(filtered)),
        buildSelectBar()
      )
    );
  }

  function buildHead() {
    return h('header', { class: 'modal-head' },
      h('div', null,
        h('h1', { class: 'modal-title', i18n: 'organizeSubscriptionsTitle' }, 'Organizar suscripciones'),
        h('p', { class: 'modal-sub', i18n: 'organizeSubscriptionsSubtitle' }, 'Agrupa tus canales en categorías para filtrar tu feed.')
      ),
      h('button', {
        class: 'icon-btn',
        i18nAria: 'close',
        'aria-label': 'Cerrar',
        onclick: () => window.parent.postMessage({ type: 'YCSM_PANEL_CLOSE' }, 'https://www.youtube.com'),
      }, icon(ICONS.close, { size: 20 }))
    );
  }

  /* ─── Sidebar ────────────────────────────────────────────────── */
  function buildSidebar() {
    const total = state.channels.length;
    const uncategorized = state.channels.filter((c) => !(state.assignments[c.id]?.length)).length;
    const aside = h('aside', { class: 'sidebar' });

    aside.appendChild(h('nav', { class: 'side-nav' },
      sideSystemItem('all', 'globe', 'viewAll', 'Todas', total),
      sideSystemItem('uncategorized', 'tag', 'viewUncategorized', 'Sin categorizar', uncategorized)
    ));

    const section = h('div', { class: 'side-section' });
    section.appendChild(h('div', { class: 'side-section-head' },
      h('span', { i18n: 'myCategories' }, 'Mis categorías'),
      h('button', {
        class: 'side-edit-toggle' + (state.manage ? ' is-on' : ''),
        i18n: state.manage ? 'done' : 'edit',
        onclick: () => { state.manage = !state.manage; state.colorEditId = null; state.editingId = null; render(); },
      }, state.manage ? 'Listo' : 'Editar')
    ));

    const nav = h('nav', { class: 'side-nav' });
    SIDEBAR_NAV = nav;
    ROW_REFS.clear();
    state.categories.forEach((cat, idx) => {
      const showLineBefore =
        state.drag?.started &&
        state.drag.insertIndex === idx &&
        state.drag.originIndex !== idx &&
        state.drag.originIndex + 1 !== idx;
      if (showLineBefore) nav.appendChild(h('div', { class: 'drop-line' }));
      nav.appendChild(buildCategoryRow(cat, idx));
    });
    if (state.drag?.started &&
        state.drag.insertIndex === state.categories.length &&
        state.drag.originIndex !== state.categories.length - 1) {
      nav.appendChild(h('div', { class: 'drop-line' }));
    }

    if (state.creatingCat) {
      const input = h('input', {
        id: 'side-new-input',
        class: 'side-rename',
        value: state.newCatName,
        i18nPlaceholder: 'categoryNamePlaceholder',
        placeholder: 'Nombre de la categoría',
        oninput: (e) => { state.newCatName = e.target.value; },
        onblur: commitNewCategory,
        onkeydown: (e) => {
          if (e.key === 'Enter') commitNewCategory();
          else if (e.key === 'Escape') { state.creatingCat = false; state.newCatName = ''; render(); }
        },
      });
      nav.appendChild(h('div', { class: 'side-item' },
        h('span', { class: 'side-dot', style: { background: 'var(--text-dimmer)' } }),
        input
      ));
      setTimeout(() => input.focus(), 0);
    } else {
      nav.appendChild(h('button', {
        class: 'side-item side-add',
        onclick: () => { state.creatingCat = true; state.newCatName = ''; render(); },
      },
        icon(ICONS.plus, { size: 16, sw: 2.5 }),
        h('span', { class: 'side-name', i18n: 'newCategory' }, 'Nueva categoría')
      ));
    }

    section.appendChild(nav);
    aside.appendChild(section);

    if (state.drag?.started) aside.appendChild(buildDragGhost());

    return aside;
  }

  function sideSystemItem(view, iconKey, i18nKey, label, count) {
    return h('button', {
      class: 'side-item side-item-system' + (state.view === view ? ' is-active' : ''),
      onclick: () => { state.view = view; render(); },
    },
      icon(ICONS[iconKey], { size: 18 }),
      h('span', { class: 'side-name', i18n: i18nKey }, label),
      h('span', { class: 'side-count' }, String(count))
    );
  }

  function buildCategoryRow(cat, idx) {
    const count = state.channels.filter((ch) => (state.assignments[ch.id] || []).includes(cat.id)).length;
    const isEditing = state.editingId === cat.id;
    const isDragging = state.drag?.started && state.drag.id === cat.id;

    const row = h('div', {
      class: 'side-item' +
        (state.view === cat.id ? ' is-active' : '') +
        (state.manage ? ' is-managing' : '') +
        (isDragging ? ' is-dragging' : ''),
      ref: (el) => ROW_REFS.set(cat.id, el),
      onclick: () => { if (!state.manage && !isEditing) { state.view = cat.id; render(); } },
    });

    if (state.manage) {
      row.appendChild(h('span', {
        class: 'side-drag',
        i18nTitle: 'dragToReorder',
        title: 'Arrastrar para reordenar',
        onpointerdown: (e) => onDragStart(e, cat),
      }, icon(ICONS.drag, { size: 14, stroke: 'var(--text-dimmer)', sw: 1 })));

      const wrap = h('span', { class: 'side-dot-wrap' },
        h('button', {
          class: 'side-dot side-dot-btn',
          style: { background: catColor(cat) },
          i18nTitle: 'changeColor',
          title: 'Cambiar color',
          'aria-label': 'Cambiar color',
          onclick: (e) => { e.stopPropagation(); state.colorEditId = state.colorEditId === cat.id ? null : cat.id; render(); },
        })
      );
      if (state.colorEditId === cat.id) wrap.appendChild(buildColorPopover(cat));
      row.appendChild(wrap);
    } else {
      row.appendChild(h('span', { class: 'side-dot', style: { background: catColor(cat) } }));
    }

    if (isEditing) {
      const input = h('input', {
        id: 'side-rename-input',
        class: 'side-rename',
        value: state.editingName,
        oninput: (e) => { state.editingName = e.target.value; },
        onblur: () => commitRename(cat.id),
        onkeydown: (e) => {
          if (e.key === 'Enter') commitRename(cat.id);
          else if (e.key === 'Escape') { state.editingId = null; state.editingName = ''; render(); }
        },
      });
      row.appendChild(input);
      setTimeout(() => { input.focus(); input.select(); }, 0);
    } else {
      row.appendChild(h('span', { class: 'side-name' }, cat.name));
    }

    if (state.manage && !isEditing) {
      row.appendChild(h('span', { class: 'side-actions' },
        h('button', {
          i18nTitle: 'rename',
          title: 'Renombrar',
          onclick: (e) => { e.stopPropagation(); state.editingId = cat.id; state.editingName = cat.name; render(); },
        }, icon(ICONS.pencil, { size: 13, sw: 2 })),
        h('button', {
          i18nTitle: 'delete',
          title: 'Eliminar',
          onclick: (e) => { e.stopPropagation(); actDelete(cat.id).then(render); },
        }, icon(ICONS.trash, { size: 13, sw: 2 }))
      ));
    } else if (!isEditing) {
      row.appendChild(h('span', { class: 'side-count' }, String(count)));
    }

    return row;
  }

  function buildDragGhost() {
    const d = state.drag;
    return h('div', {
      class: 'drag-ghost',
      style: { left: d.ghostX + 'px', top: d.ghostY + 'px', width: d.ghostW + 'px' },
    },
      h('span', { class: 'side-drag' }, icon(ICONS.drag, { size: 14, stroke: 'var(--text-dimmer)', sw: 1 })),
      h('span', { class: 'side-dot', style: { background: `oklch(0.72 0.16 ${d.hue})` } }),
      h('span', { class: 'side-name' }, d.label)
    );
  }

  function buildColorPopover(cat) {
    const current = catHue(cat);
    const grid = h('div', { class: 'color-pop', role: 'listbox', 'aria-label': 'Color' });
    HUE_PALETTE.forEach((hue) => {
      const active = hue === current;
      grid.appendChild(h('button', {
        class: 'color-swatch' + (active ? ' is-active' : ''),
        style: { background: `oklch(0.72 0.16 ${hue})` },
        'aria-label': `Hue ${hue}`,
        'aria-selected': active ? 'true' : 'false',
        onclick: (e) => { e.stopPropagation(); state.colorEditId = null; actSetColor(cat.id, hue).then(render); },
      }, active ? icon(ICONS.check, { size: 10, sw: 3, stroke: '#fff' }) : null));
    });
    // outside click close
    setTimeout(() => {
      const off = (e) => {
        if (!grid.contains(e.target)) { state.colorEditId = null; render(); document.removeEventListener('mousedown', off); }
      };
      document.addEventListener('mousedown', off);
    }, 0);
    return grid;
  }

  /* ─── Main pane ──────────────────────────────────────────────── */
  function buildMain(filtered) {
    return h('main', { class: 'main-pane' }, buildToolbar(filtered), buildChannelArea(filtered));
  }

  function viewLabel() {
    if (state.view === 'all')             return { i: 'viewAll',           text: 'Todas las suscripciones' };
    if (state.view === 'uncategorized')   return { i: 'viewUncategorized', text: 'Sin categorizar' };
    const cat = state.categories.find((c) => c.id === state.view);
    return { i: null, text: cat?.name || '' };
  }

  function buildToolbar(filtered) {
    const vl = viewLabel();
    return h('div', { class: 'toolbar' },
      h('div', { class: 'toolbar-title' },
        h('h2', vl.i ? { i18n: vl.i } : null, vl.text),
        h('span', { class: 'toolbar-count' }, ct('channelCount', filtered.length) || `${filtered.length} canales`)
      ),
      h('div', { class: 'toolbar-controls' },
        // Search
        h('div', { class: 'search' },
          icon(ICONS.search, { size: 16, stroke: 'var(--text-dim)' }),
          h('input', {
            id: 'channel-search',
            type: 'text',
            value: state.search,
            i18nPlaceholder: 'searchChannelPlaceholder',
            placeholder: 'Buscar canal…',
            oninput: (e) => { state.search = e.target.value; rerenderChannelArea(); rerenderToolbarCount(); },
          }),
          state.search ? h('button', {
            class: 'search-clear',
            'aria-label': 'Limpiar',
            onclick: () => { state.search = ''; render(); },
          }, icon(ICONS.plus, { size: 12, sw: 2.5, /* rotated x via plus is dirty; reuse close */ })) : null,
          state.search ? null : null
        ),
        // Sort
        h('div', { class: 'sort' },
          icon(ICONS.sort, { size: 14 }),
          h('select', {
            value: state.sort,
            onchange: (e) => { state.sort = e.target.value; render(); },
          },
            h('option', { value: 'recent', i18n: 'sortRecent' }, 'Por defecto'),
            h('option', { value: 'name',   i18n: 'sortAlpha'  }, 'A → Z')
          ),
          icon(ICONS.caret, { size: 12, sw: 2.5 })
        ),
        // View toggle
        h('div', { class: 'view-toggle', role: 'tablist' },
          h('button', {
            class: state.layout === 'list' ? 'is-active' : '',
            i18nTitle: 'viewList', title: 'Lista',
            onclick: () => { setLayout('list'); },
          }, icon(ICONS.list, { size: 16 })),
          h('button', {
            class: state.layout === 'grid' ? 'is-active' : '',
            i18nTitle: 'viewGrid', title: 'Cuadrícula',
            onclick: () => { setLayout('grid'); },
          }, icon(ICONS.grid, { size: 16 }))
        )
      )
    );
  }

  // Hot paths for search-as-you-type — avoid full re-render
  function rerenderChannelArea() {
    const filtered = filteredChannels();
    const area = document.querySelector('.channel-area');
    if (!area) return;
    const next = buildChannelArea(filtered);
    area.replaceWith(next);
    applyI18n(next);
  }
  function rerenderToolbarCount() {
    const filtered = filteredChannels();
    const ttl = document.querySelector('.toolbar-count');
    if (ttl) ttl.textContent = ct('channelCount', filtered.length) || `${filtered.length} canales`;
  }

  function buildChannelArea(filtered) {
    const area = h('div', { class: 'channel-area' });
    if (state.loading && state.channels.length === 0) {
      area.appendChild(h('div', { class: 'loading-state' },
        h('div', { class: 'loading-spinner' }),
        h('div', { class: 'loading-text', i18n: 'loadingChannels' }, 'Cargando canales...')
      ));
    } else if (filtered.length === 0) {
      area.appendChild(buildEmpty());
    } else if (state.layout === 'list') {
      area.appendChild(buildListHead(filtered));
      const list = h('div', { class: 'list' });
      filtered.forEach((ch) => list.appendChild(buildRow(ch)));
      area.appendChild(list);
    } else {
      const grid = h('div', { class: 'grid' + (state.selected.size > 0 ? ' is-selecting' : '') });
      filtered.forEach((ch) => grid.appendChild(buildCard(ch)));
      area.appendChild(grid);
    }
    return area;
  }

  function buildEmpty() {
    if (state.search) {
      return h('div', { class: 'empty' },
        h('div', { class: 'empty-icon' }, icon(ICONS.search, { size: 28, stroke: 'var(--text-dimmer)' })),
        h('div', { class: 'empty-title' }, t('emptySearchTitle', state.search)),
        h('div', { class: 'empty-sub', i18n: 'emptySearchSub' }, 'Prueba con otro nombre o quita los filtros.')
      );
    }
    if (state.view === 'uncategorized') {
      return h('div', { class: 'empty' },
        h('div', { class: 'empty-icon' }, icon(ICONS.check, { size: 28, stroke: 'var(--text-dimmer)' })),
        h('div', { class: 'empty-title', i18n: 'emptyUncategorizedTitle' }, '¡Todo categorizado!'),
        h('div', { class: 'empty-sub', i18n: 'emptyUncategorizedSub' }, 'Cada canal de tu lista tiene al menos una categoría.')
      );
    }
    return h('div', { class: 'empty' },
      h('div', { class: 'empty-icon' }, icon(ICONS.folderPlus, { size: 28, stroke: 'var(--text-dimmer)' })),
      h('div', { class: 'empty-title' }, t('emptyCategoryTitle', viewLabel().text)),
      h('div', { class: 'empty-sub', i18n: 'emptyCategorySub' }, 'Asigna canales a esta categoría desde la lista «Todas».')
    );
  }

  /* ─── List view ──────────────────────────────────────────────── */
  function buildListHead(filtered) {
    const allChecked = state.selected.size > 0 && state.selected.size === filtered.length;
    const indet = state.selected.size > 0 && state.selected.size < filtered.length;
    return h('div', { class: 'list-head' },
      h('label', { class: 'check-cell', onclick: (e) => e.stopPropagation() },
        h('input', {
          type: 'checkbox',
          checked: allChecked,
          onchange: () => {
            if (allChecked) state.selected = new Set();
            else state.selected = new Set(filtered.map((c) => c.id));
            render();
          },
        }),
        h('span', { class: 'check-box check-box-head' + (allChecked ? ' is-checked' : '') + (indet ? ' is-indeterminate' : '') },
          allChecked ? icon(ICONS.check, { size: 12, sw: 3 }) : (indet ? h('span', { class: 'indet' }) : null)
        )
      ),
      h('span', { class: 'head-label head-channel', i18n: 'headChannel' }, 'Canal'),
      h('span', { class: 'head-label head-cats', i18n: 'headCategories' }, 'Categorías')
    );
  }

  function buildRow(ch) {
    const sel = state.selected.has(ch.id);
    const cats = channelCats(ch);
    const row = h('div', { class: 'row' + (sel ? ' is-selected' : '') });

    row.appendChild(h('label', { class: 'row-check', onclick: (e) => e.stopPropagation() },
      h('input', {
        type: 'checkbox', checked: sel,
        onchange: () => { toggleSelect(ch.id); render(); },
      }),
      h('span', { class: 'check-box' }, sel ? icon(ICONS.check, { size: 12, sw: 3 }) : null)
    ));

    const avatarLink = h('a', {
      class: 'row-avatar-link',
      href: ch.href ? 'https://www.youtube.com' + ch.href : '#',
      target: '_blank',
      rel: 'noopener',
      onclick: (e) => e.stopPropagation(),
    }, buildAvatar(ch, 44));
    row.appendChild(avatarLink);

    const nameLink = h('a', {
      class: 'row-name-link',
      href: ch.href ? 'https://www.youtube.com' + ch.href : '#',
      target: '_blank',
      rel: 'noopener',
      onclick: (e) => e.stopPropagation(),
    }, ch.name);
    row.appendChild(h('div', { class: 'row-meta' },
      h('div', { class: 'row-name' }, nameLink),
      ch.last ? h('div', { class: 'row-sub' }, ch.last) : null
    ));

    row.appendChild(buildCatsCell(ch, cats));
    return row;
  }

  function buildAvatar(ch, size) {
    const fontSize = Math.round(size * 0.42);
    const wrap = h('div', { class: 'avatar', style: { width: size + 'px', height: size + 'px' } });
    if (ch.avatar) {
      wrap.appendChild(h('img', { src: ch.avatar, alt: '', loading: 'lazy' }));
    } else {
      const bg = `oklch(0.55 0.10 ${hashHue(ch.id || ch.name)})`;
      wrap.style.background = bg;
      wrap.style.fontSize = fontSize + 'px';
      wrap.appendChild(document.createTextNode((ch.name || '?').charAt(0).toUpperCase()));
    }
    return wrap;
  }

  function buildCatsCell(ch, cats) {
    const wrap = h('div', { class: 'row-cats' });
    cats.forEach((c) => wrap.appendChild(buildChip(c, () => actToggle(ch.id, c.id).then(render))));
    const pickerWrap = h('div', { class: 'add-cat-wrap' },
      h('button', {
        class: 'add-cat-btn',
        i18nAria: 'manageChannelCategories',
        'aria-label': 'Gestionar categorías del canal',
        onclick: (e) => { e.stopPropagation(); openPicker({ kind: 'row', chId: ch.id }); },
      },
        icon(ICONS.tag, { size: 15, sw: 2.1 })
      )
    );
    if (state.picker?.kind === 'row' && state.picker.chId === ch.id) {
      pickerWrap.appendChild(buildPicker(ch.id, ch));
    }
    wrap.appendChild(pickerWrap);
    return wrap;
  }

  function buildChip(cat, onRemove) {
    return h('span', {
      class: 'cat-chip',
      style: {
        background: catBg(cat, 0.16),
        color: catColor(cat),
        border: `1px solid ${catBg(cat, 0.35)}`,
      },
    },
      h('span', { class: 'chip-dot', style: { background: catColor(cat) } }),
      document.createTextNode(cat.name),
      onRemove ? h('button', {
        class: 'chip-x',
        'aria-label': `Quitar ${cat.name}`,
        onclick: (e) => { e.stopPropagation(); onRemove(); },
      }, icon(ICONS.close, { size: 10, sw: 2.5 })) : null
    );
  }

  /* ─── Grid view ──────────────────────────────────────────────── */
  function buildCard(ch) {
    const sel = state.selected.has(ch.id);
    const selecting = state.selected.size > 0;
    const cats = channelCats(ch);

    const card = h('div', {
      class: 'card' + (sel ? ' is-selected' : '') + (selecting ? ' is-selecting' : ''),
      role: 'button',
      onclick: selecting
        ? () => { toggleSelect(ch.id); render(); }
        : () => { window.parent.postMessage({ type: 'YCSM_NAVIGATE', href: ch.href }, 'https://www.youtube.com'); },
    });

    card.appendChild(h('button', {
      class: 'card-check',
      tabindex: selecting ? -1 : 0,
      onclick: (e) => { e.stopPropagation(); toggleSelect(ch.id); render(); },
    }, h('span', { class: 'check-box' }, sel ? icon(ICONS.check, { size: 12, sw: 3 }) : null)));

    card.appendChild(h('div', { class: 'card-avatar' }, buildAvatar(ch, 64)));
    card.appendChild(h('div', { class: 'card-name' }, ch.name));
    if (ch.last) card.appendChild(h('div', { class: 'card-sub' }, ch.last));

    const catsWrap = h('div', { class: 'card-cats' });
    cats.slice(0, 2).forEach((c) =>
      catsWrap.appendChild(buildChip(c, selecting ? null : () => actToggle(ch.id, c.id).then(render)))
    );
    if (cats.length > 2) catsWrap.appendChild(h('span', { class: 'chip-more' }, `+${cats.length - 2}`));

    if (!selecting) {
      const pickerWrap = h('div', { class: 'add-cat-wrap' },
        h('button', {
          class: 'add-cat-btn add-cat-btn-card',
          i18nAria: 'manageChannelCategories',
          'aria-label': 'Gestionar categorías del canal',
          onclick: (e) => { e.stopPropagation(); openPicker({ kind: 'card', chId: ch.id }); },
        }, icon(ICONS.tag, { size: 15, sw: 2.1 }))
      );
      if (state.picker?.kind === 'card' && state.picker.chId === ch.id) {
        pickerWrap.appendChild(buildPicker(ch.id, ch));
      }
      catsWrap.appendChild(pickerWrap);
    }
    card.appendChild(catsWrap);
    return card;
  }

  /* ─── Picker popover (search or create) ───────────────────────── */
  function openPicker(picker) {
    state.picker = { ...picker, query: '' };
    render();
    setTimeout(() => {
      const pickerEl = document.querySelector('.picker');
      if (pickerEl) {
        const rect = pickerEl.getBoundingClientRect();
        if (rect.left < 8) pickerEl.classList.add('is-left');
      }
      document.getElementById('picker-search')?.focus();
    }, 0);
    const off = (e) => {
      const root = document.querySelector('.picker');
      if (root && !root.contains(e.target) && !e.target.closest('.add-cat-btn, .btn-primary')) {
        state.picker = null;
        document.removeEventListener('mousedown', off);
        render();
      }
    };
    setTimeout(() => document.addEventListener('mousedown', off), 0);
  }
  function closePicker() { state.picker = null; render(); }

  function buildPicker(scopeChId, scopeCh) {
    const p = state.picker;
    const norm = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    const q = (p.query || '').trim();
    const qn = norm(q);
    const all = state.categories;
    const filtered = qn ? all.filter((c) => norm(c.name).includes(qn)) : all;
    const exact = filtered.find((c) => norm(c.name) === qn);
    const canCreate = q.length > 0 && !exact;

    const isBulk = p.kind === 'bulk';
    const selectedIds = [...state.selected];
    const currentCatIds = isBulk ? [] : (state.assignments[scopeChId] || []);

    const list = h('div', { class: 'picker-list' });
    filtered.forEach((c) => {
      const active = isBulk
        ? selectedIds.length > 0 && selectedIds.every((id) => (state.assignments[id] || []).includes(c.id))
        : currentCatIds.includes(c.id);
      const partial = isBulk && !active && selectedIds.some((id) => (state.assignments[id] || []).includes(c.id));
      list.appendChild(h('button', {
        class: 'picker-item' + (active ? ' is-active' : '') + (partial ? ' is-partial' : ''),
        'aria-pressed': active ? 'true' : (partial ? 'mixed' : 'false'),
        onclick: (e) => {
          e.stopPropagation();
          if (isBulk) { actBulkToggle(selectedIds, c.id).then(render); }
          else        { actToggle(scopeChId, c.id).then(render); }
        },
      },
        h('span', { class: 'dot', style: { background: catColor(c) } }),
        h('span', { class: 'name' }, c.name),
        active ? icon(ICONS.check, { size: 14 }) : (partial ? icon(ICONS.minus, { size: 14 }) : null)
      ));
    });
    if (canCreate) {
      list.appendChild(h('button', {
        class: 'picker-item picker-create',
        onclick: async (e) => {
          e.stopPropagation();
          await actAddCategory(q);
          const created = state.categories[state.categories.length - 1];
          if (isBulk) {
            await actBulkAssign([...state.selected], created.id);
            state.selected = new Set();
            closePicker();
          } else {
            await actToggle(scopeChId, created.id);
            // keep picker open with fresh state
            state.picker.query = '';
            render();
            setTimeout(() => document.getElementById('picker-search')?.focus(), 0);
          }
        },
      },
        h('span', { class: 'plus' }, icon(ICONS.plus, { size: 8, sw: 3, stroke: 'var(--bar-fg)' })),
        h('span', { class: 'name' }, `Crear “${q}”`)
      ));
    }
    if (filtered.length === 0 && !canCreate) {
      list.appendChild(h('div', { class: 'picker-empty', i18n: 'pickerEmpty' }, 'Sin resultados'));
    }

    return h('div', { class: 'picker', onclick: (e) => e.stopPropagation() },
      h('div', { class: 'picker-search' },
        icon(ICONS.search, { size: 14, stroke: 'var(--text-dim)' }),
        h('input', {
          id: 'picker-search',
          type: 'text',
          value: q,
          i18nPlaceholder: 'searchOrCreateCategory',
          placeholder: 'Buscar o crear categoría…',
          oninput: (e) => { state.picker.query = e.target.value; rebuildPicker(); },
          onkeydown: (e) => {
            if (e.key === 'Escape') { closePicker(); }
            else if (e.key === 'Enter' && canCreate) {
              e.preventDefault();
              list.querySelector('.picker-create')?.click();
            }
          },
        })
      ),
      list
    );
  }

  function rebuildPicker() {
    // Only swap out the list + create option; keep input + caret untouched
    const popover = document.querySelector('.picker');
    if (!popover) return;
    const oldList = popover.querySelector('.picker-list');
    if (!oldList) return;
    const scopeChId = state.picker.kind === 'bulk' ? null : state.picker.chId;
    const scopeCh = scopeChId ? state.channels.find((c) => c.id === scopeChId) : null;
    const newWhole = buildPicker(scopeChId, scopeCh);
    const newList = newWhole.querySelector('.picker-list');
    if (newList && oldList) oldList.replaceWith(newList);
  }

  /* ─── Selection bar ──────────────────────────────────────────── */
  function buildSelectBar() {
    const n = state.selected.size;
    const bar = h('div', { class: 'select-bar' + (n > 0 ? ' is-visible' : '') });
    bar.appendChild(h('button', {
      class: 'select-bar-clear',
      i18nAria: 'clearSelection',
      onclick: () => { state.selected = new Set(); state.picker = null; render(); },
    }, icon(ICONS.close, { size: 14, sw: 2.5 })));
    bar.appendChild(h('span', { class: 'select-bar-count' },
      h('strong', null, String(n)),
      ' ',
      ct('channelsSelected', n) || `${n === 1 ? 'canal seleccionado' : 'canales seleccionados'}`
    ));
    const wrap = h('div', { class: 'add-cat-wrap' },
      h('button', {
        class: 'btn btn-primary assign-cat-icon-btn',
        i18nAria: 'manageCategories',
        'aria-label': 'Gestionar categorías',
        onclick: (e) => { e.stopPropagation(); openPicker({ kind: 'bulk' }); },
      },
        icon(ICONS.tag, { size: 16, sw: 2 })
      )
    );
    if (state.picker?.kind === 'bulk') {
      const pop = buildPicker(null, null);
      pop.classList.add('is-up');
      wrap.appendChild(pop);
    }
    bar.appendChild(h('div', { class: 'select-bar-actions' }, wrap));
    return bar;
  }

  /* ─── Selection helpers ─────────────────────────────────────── */
  function toggleSelect(id) {
    if (state.selected.has(id)) state.selected.delete(id);
    else state.selected.add(id);
  }

  /* ─── Inline edit commits ────────────────────────────────────── */
  function commitNewCategory() {
    const n = state.newCatName.trim();
    state.creatingCat = false;
    state.newCatName = '';
    if (n) actAddCategory(n).then(render);
    else render();
  }
  function commitRename(id) {
    const n = state.editingName.trim();
    const target = id;
    state.editingId = null;
    state.editingName = '';
    if (n) actRename(target, n).then(render);
    else render();
  }

  /* ─── Drag & drop reorder (manage mode) ──────────────────────── */
  function computeInsertIndex(clientY) {
    const order = state.categories.map((c) => c.id);
    for (let i = 0; i < order.length; i++) {
      const el = ROW_REFS.get(order[i]);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      const mid = r.top + r.height / 2;
      if (clientY < mid) return i;
    }
    return order.length;
  }

  function onDragStart(e, cat) {
    if (!state.manage) return;
    e.preventDefault();
    e.stopPropagation();
    const row = ROW_REFS.get(cat.id);
    const rect = row ? row.getBoundingClientRect() : { width: 220, left: 0, top: 0 };
    const sx = e.clientX, sy = e.clientY;
    const originIndex = state.categories.findIndex((c) => c.id === cat.id);
    let started = false;
    state.colorEditId = null;
    state.editingId = null;

    function onMove(ev) {
      if (!started) {
        if (Math.abs(ev.clientY - sy) < 4 && Math.abs(ev.clientX - sx) < 4) return;
        started = true;
        document.body.style.userSelect = 'none';
        document.body.style.cursor = 'grabbing';
      }
      const insertIndex = computeInsertIndex(ev.clientY);
      state.drag = {
        id: cat.id, label: cat.name, hue: catHue(cat),
        ghostX: ev.clientX - (sx - rect.left),
        ghostY: ev.clientY - (sy - rect.top),
        ghostW: rect.width,
        insertIndex, originIndex, started: true,
      };
      render();
      // Auto-scroll
      const sidebar = document.querySelector('.sidebar');
      if (sidebar) {
        const r = sidebar.getBoundingClientRect();
        const edge = 40;
        if (ev.clientY < r.top + edge) sidebar.scrollTop -= 8;
        else if (ev.clientY > r.bottom - edge) sidebar.scrollTop += 8;
      }
    }
    function onUp(ev) {
      cleanup();
      if (!started) { state.drag = null; render(); return; }
      const insertIndex = computeInsertIndex(ev.clientY);
      const from = originIndex;
      let to = insertIndex;
      if (to === from || to === from + 1) { state.drag = null; render(); return; }
      const ids = state.categories.map((c) => c.id);
      const [moved] = ids.splice(from, 1);
      ids.splice(to > from ? to - 1 : to, 0, moved);
      state.drag = null;
      actReorder(ids).then(render);
    }
    function onKey(ev) {
      if (ev.key === 'Escape') { cleanup(); state.drag = null; render(); }
    }
    function cleanup() {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('keydown', onKey);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    }
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('keydown', onKey);
  }

  /* ─── Boot ───────────────────────────────────────────────────── */
  async function init() {
    document.title = t('organizeSubscriptionsPageTitle') || 'Organizar suscripciones';
    if (storage) {
      await refreshFromStorage();
      storage.onChange(() => { refreshFromStorage().then(render); });
    }
    render();
  }

  init().catch((e) => console.error('[YCSM] panel-ui init failed:', e));

  // ─── i18n keys consumed (add to _locales/<lang>/messages.json) ──
  // organizeSubscriptionsPageTitle
  // organizeSubscriptionsTitle
  // organizeSubscriptionsSubtitle
  // viewAll
  // viewUncategorized
  // myCategories
  // edit / done
  // newCategory
  // categoryNamePlaceholder
  // searchOrCreateCategory
  // searchChannelPlaceholder
  // headChannel / headCategories
  // categorize
  // assignCategory
  // sortRecent / sortAlpha
  // viewList / viewGrid
  // close
  // rename / delete / changeColor / dragToReorder
  // pickerEmpty
  // channelCount{One,Many}    (already exists)
  // channelsSelected{One,Many}
  // emptySearchSub
  // emptyUncategorizedTitle / emptyUncategorizedSub
  // emptyCategorySub
})();
