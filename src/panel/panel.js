/**
 * panel.js — Bulk Assignment Panel
 * Panel flotante para asignar canales a categorías de forma masiva.
 * Compatible como content script inyectado en YouTube.
 */
(function () {
  if (!window.YCSM) window.YCSM = {};

  /* ── Utilidades ── */
  function debounce(fn, ms) {
    let t;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  }
  function normalizeSearch(str) {
    return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  }

  let panelEl = null;
  let allChannels = [];
  let filterText = '';
  let filterCat = null;   // ID de categoría activa para filtrar, o null (compat)
  let viewMode = 'all';   // 'all' | 'recent' | 'uncategorized' | <catId>
  let layoutMode = 'grid'; // 'list' | 'grid'
  let isManaging = false;  // sidebar manage/edit mode
  let sortBy = 'activity'; // 'activity' | 'name'
  let selectedIds = new Set(); // IDs de canales seleccionados
  const _dateCache = new Map(); // channelId → ISO date string | null
  let _dateObserver = null;
  let _pillsOverflowObserver = null;
  let _tooltipEl = null;
  let _lastSeen = {};             // channelId → ISO string (cuándo visitó el canal por última vez)
  let _panelClickHandler = null;  // referencia al listener de click global para poder eliminarlo al cerrar

  const { t, count } = YCSM.i18n;

  async function refreshLegendOrder() {
    if (!panelEl || panelEl.querySelector('.ycsm-manage-view')) return;

    const scrollContainer = panelEl.querySelector('.ycsm-legend-scroll');
    if (!scrollContainer) return;

    const { categories } = await YCSM.storage.getAll();
    const sortedCats = Object.values(categories).sort((a, b) => a.order - b.order);
    const createWrap = scrollContainer.querySelector('.ycsm-legend-create-wrap');

    sortedCats.forEach((cat) => {
      const wrap = scrollContainer.querySelector(`.ycsm-pill-wrap[data-cat-id="${CSS.escape(cat.id)}"]`);
      if (!wrap) return;
      if (createWrap?.parentElement === scrollContainer) {
        scrollContainer.insertBefore(wrap, createWrap);
      } else {
        scrollContainer.appendChild(wrap);
      }
    });
  }

  /* ── Tooltip flotante (escapa contenedores con overflow) ── */
  function showTooltip(text, anchorEl) {
    if (!_tooltipEl) {
      _tooltipEl = document.createElement('div');
      _tooltipEl.style.cssText = [
        'position:fixed',
        'padding:6px 10px',
        'border-radius:8px',
        'font-size:12px',
        'font-weight:400',
        'white-space:nowrap',
        'background:#616161',
        'color:#fff',
        'pointer-events:none',
        'z-index:2147483647',
        'font-family:Roboto,Arial,sans-serif',
        'opacity:0',
        'transition:opacity 0.2s',
      ].join(';');
      document.body.appendChild(_tooltipEl);
    }
    _tooltipEl.textContent = text;
    _tooltipEl.style.display = 'block';
    const rect = anchorEl.getBoundingClientRect();
    const w = _tooltipEl.offsetWidth;
    _tooltipEl.style.left = Math.max(4, rect.left + rect.width / 2 - w / 2) + 'px';
    _tooltipEl.style.top = (rect.top - _tooltipEl.offsetHeight - 8) + 'px';
    _tooltipEl.style.opacity = '1';
  }

  function hideTooltip() {
    if (_tooltipEl) { _tooltipEl.style.opacity = '0'; _tooltipEl.style.display = 'none'; }
  }

  /* ═══════════════════════════════════════════════════════════════
     ESTRATEGIA 1: Fetch de /feed/channels (más fiable que DOM)
  ═══════════════════════════════════════════════════════════════ */

  /**
   * Extrae el primer objeto JSON que contiene 'ytInitialData' de un script.
   * Usa conteo de llaves con manejo correcto de strings para no confundirse
   * con '{' / '}' dentro de valores de cadena.
   */
  function extractYtInitialData(scriptText) {
    const idx = scriptText.indexOf('ytInitialData');
    if (idx === -1) return null;
    const start = scriptText.indexOf('{', idx);
    if (start === -1) return null;

    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < scriptText.length; i++) {
      const c = scriptText[i];
      if (esc)          { esc = false; continue; }
      if (c === '\\' && inStr) { esc = true;  continue; }
      if (c === '"')   { inStr = !inStr; continue; }
      if (inStr)       { continue; }
      if (c === '{')   { depth++; }
      else if (c === '}' && --depth === 0) {
        try { return JSON.parse(scriptText.slice(start, i + 1)); } catch { return null; }
      }
    }
    return null;
  }

  /**
   * Recorre el árbol JSON de ytInitialData de forma iterativa buscando
   * todos los objetos channelRenderer (suscripciones del usuario).
   */
  function collectChannelRenderers(root) {
    const channels = [];
    const seen = new Set();
    const stack = [root];

    while (stack.length) {
      const obj = stack.pop();
      if (!obj || typeof obj !== 'object') continue;

      if (Array.isArray(obj)) {
        for (const item of obj) stack.push(item);
        continue;
      }

      if (obj.channelRenderer) {
        const r = obj.channelRenderer;
        const id = r.channelId;
        if (id && !seen.has(id)) {
          seen.add(id);
          const handle = r.navigationEndpoint?.browseEndpoint?.canonicalBaseUrl || '';
          const name = r.title?.simpleText || r.title?.runs?.[0]?.text || id;
          const thumbs = r.thumbnail?.thumbnails || [];
          const avatar = thumbs[thumbs.length - 1]?.url || '';
          channels.push({ id, name, avatar, href: handle || `/channel/${id}` });
        }
        // No seguir recursión dentro del channelRenderer
        continue;
      }

      for (const v of Object.values(obj)) stack.push(v);
    }

    return channels;
  }

  /**
   * Obtiene TODAS las suscripciones fetching la página /feed/channels.
   * YouTube embebe ytInitialData con todos los channelRenderers en el HTML.
   * No depende del DOM del sidebar ni de expansiones frágiles.
   */
  async function fetchAllSubscriptions() {
    try {
      const resp = await fetch('https://www.youtube.com/feed/channels', {
        credentials: 'include',
      });
      if (!resp.ok) return [];
      const html = await resp.text();

      const parser = new DOMParser();
      const doc = parser.parseFromString(html, 'text/html');

      let ytData = null;
      for (const script of doc.querySelectorAll('script')) {
        if (!script.textContent.includes('ytInitialData')) continue;
        ytData = extractYtInitialData(script.textContent);
        if (ytData) break;
      }

      if (!ytData) return [];

      const channels = collectChannelRenderers(ytData);
      // Se preserva el orden de YouTube (actividad reciente) para la opción de ordenación
      return channels;
    } catch (e) {
      console.warn('[YCSM] fetchAllSubscriptions error:', e.message);
      return [];
    }
  }

  /* ═══════════════════════════════════════════════════════════════
     ESTRATEGIA 2 (fallback): Scraping del DOM del sidebar
  ═══════════════════════════════════════════════════════════════ */

  function countCollapsibleEntries() {
    return document.querySelectorAll(
      'ytd-guide-collapsible-section-entry-renderer ytd-guide-entry-renderer'
    ).length;
  }

  async function expandYouTubeSubscriptions() {
    const collapsibles = document.querySelectorAll(
      'ytd-guide-collapsible-section-entry-renderer'
    );
    if (collapsibles.length === 0) return;

    // Snapshot del número de entradas ANTES de expandir
    const countBefore = countCollapsibleEntries();

    let clicked = false;
    for (const section of collapsibles) {
      const trigger = section.querySelector(
        '#expander-item, #expander, [role="button"][aria-expanded="false"]'
      );
      if (!trigger) continue;

      const isCollapsed =
        trigger.getAttribute('aria-expanded') === 'false' ||
        section.hasAttribute('collapsed') ||
        !section.hasAttribute('expanded');

      if (isCollapsed) {
        trigger.click();
        clicked = true;
      }
    }

    if (!clicked) return;

    // Esperar a que el número de entradas supere el snapshot inicial.
    // Luego esperar 300 ms adicionales por si YouTube sigue cargando más.
    // Safety timeout: 3 s.
    await new Promise((resolve) => {
      let stabilizeTimer = null;

      const done = () => {
        mo.disconnect();
        clearTimeout(safetyTimer);
        clearTimeout(stabilizeTimer);
        resolve();
      };

      const safetyTimer = setTimeout(done, 3000);

      const mo = new MutationObserver(() => {
        if (countCollapsibleEntries() > countBefore) {
          // Nuevas entradas detectadas; esperar 300 ms por si llegan más
          clearTimeout(stabilizeTimer);
          stabilizeTimer = setTimeout(done, 300);
        }
      });

      mo.observe(document.body, { childList: true, subtree: true });
    });
  }

  function scrapeChannelsFromDOM() {
    const channels = [];
    const seen = new Set();

    // Recoger todos los enlaces que apunten a canales en cualquier parte del DOM
    const links = document.querySelectorAll(
      'ytd-guide-entry-renderer a, ' +
      'ytd-guide-collapsible-section-entry-renderer a, ' +
      'ytd-subscription-item-renderer a, ' +
      'ytd-channel-renderer a'
    );

    links.forEach((link) => {
      const href = link.getAttribute('href') || '';
      if (
        !href.startsWith('/channel/') &&
        !href.startsWith('/@') &&
        !href.startsWith('/c/')
      )
        return;

      const channelId = href.startsWith('/channel/')
        ? href.replace('/channel/', '').split('?')[0]
        : href.split('?')[0];

      if (!channelId || seen.has(channelId)) return;
      seen.add(channelId);

      // Contexto: elemento padre del enlace
      const entry =
        link.closest('ytd-guide-entry-renderer') ||
        link.closest('ytd-subscription-item-renderer') ||
        link.closest('ytd-channel-renderer') ||
        link.parentElement;

      const nameEl = entry?.querySelector(
        'yt-formatted-string, #channel-title, #display-name, #label, .title'
      );
      const name =
        nameEl?.textContent?.trim() ||
        link.getAttribute('title') ||
        link.getAttribute('aria-label') ||
        channelId;

      const imgEl = entry?.querySelector('img#img, yt-img-shadow img, img');
      const avatar = imgEl?.src || '';

      channels.push({ id: channelId, name: name.trim(), avatar, href });
    });

    return channels.sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    );
  }

  /* ═══════════════════════════════════════════════════════════════
     CONSTRUCCIÓN DEL PANEL
  ═══════════════════════════════════════════════════════════════ */

  function escapeHtml(value) {
    const div = document.createElement('div');
    div.appendChild(document.createTextNode(String(value ?? '')));
    return div.innerHTML;
  }



  function buildPanel() {
    const overlay = document.createElement('div');
    overlay.id = 'ycsm-panel';
    overlay.className = 'ycsm-panel-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', t('organizeYoutubeSubscriptions'));

    overlay.innerHTML = `
      <div class="ycsm-panel-backdrop" aria-hidden="true"></div>
      <div class="ycsm-panel-box">

        <!-- Header -->
        <div class="ycsm-modal-head">
          <div class="ycsm-modal-head-info">
            <h2 class="ycsm-modal-title">${escapeHtml(t('organizeSubscriptionsTitle'))}</h2>
            <p class="ycsm-modal-sub">Agrupa tus canales en categorías para filtrar tu feed.</p>
          </div>
          <button class="ycsm-icon-btn ycsm-panel-x" aria-label="${escapeHtml(t('closePanel'))}">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>

        <!-- Body: sidebar + main pane -->
        <div class="ycsm-modal-body">

          <!-- Sidebar -->
          <aside class="ycsm-new-sidebar" id="ycsm-panel-sidebar">
            <nav class="ycsm-side-nav" id="ycsm-side-system-nav">
              <button class="ycsm-side-item ycsm-side-item-system is-active" data-view="all">
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><line x1="3" y1="12" x2="21" y2="12"/><path d="M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>
                <span class="ycsm-side-name">Todas</span>
                <span class="ycsm-side-count" data-count="all">0</span>
              </button>
              <button class="ycsm-side-item ycsm-side-item-system" data-view="recent">
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>
                <span class="ycsm-side-name">Recientes</span>
                <span class="ycsm-side-count" data-count="recent">0</span>
              </button>
              <button class="ycsm-side-item ycsm-side-item-system" data-view="uncategorized">
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>
                <span class="ycsm-side-name">Sin categorizar</span>
                <span class="ycsm-side-count" data-count="uncategorized">0</span>
              </button>
            </nav>

            <div class="ycsm-side-section">
              <div class="ycsm-side-section-head">
                <span>Mis categorías</span>
                <button class="ycsm-side-edit-toggle" id="ycsm-side-edit-toggle">Editar</button>
              </div>
              <nav class="ycsm-side-nav" id="ycsm-side-cats-nav"></nav>
              <button class="ycsm-side-item ycsm-side-add" id="ycsm-side-add-cat">
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                <span class="ycsm-side-name">Nueva categoría</span>
              </button>
            </div>
          </aside>

          <!-- Main pane -->
          <main class="ycsm-main-pane">
            <div class="ycsm-new-toolbar">
              <div class="ycsm-toolbar-title">
                <h2 class="ycsm-toolbar-view-name" id="ycsm-toolbar-view-name">Todas las suscripciones</h2>
                <span class="ycsm-toolbar-count" id="ycsm-toolbar-count"></span>
              </div>
              <div class="ycsm-toolbar-controls">
                <div class="ycsm-new-search" id="ycsm-new-search">
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><line x1="20" y1="20" x2="16.65" y2="16.65"/></svg>
                  <input class="ycsm-new-search-input" type="text" placeholder="Buscar canal…" autocomplete="off" aria-label="${escapeHtml(t('searchChannelByName'))}">
                  <button class="ycsm-new-search-clear" aria-label="${escapeHtml(t('clearSearch'))}" hidden>
                    <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                  </button>
                </div>
                <div class="ycsm-new-sort-wrap">
                  <select class="ycsm-new-sort-select" id="ycsm-new-sort-select">
                    <option value="activity">${escapeHtml(t('recent'))}</option>
                    <option value="name">A → Z</option>
                  </select>
                </div>
                <div class="ycsm-view-toggle" role="tablist">
                  <button class="ycsm-view-btn ${layoutMode === 'list' ? 'is-active' : ''}" data-layout="list" title="Vista lista" aria-label="Vista lista">
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
                  </button>
                  <button class="ycsm-view-btn ${layoutMode === 'grid' ? 'is-active' : ''}" data-layout="grid" title="Vista cuadrícula" aria-label="Vista cuadrícula">
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
                  </button>
                </div>
              </div>
            </div>

            <div class="ycsm-channel-area" id="ycsm-channel-area" role="list" aria-label="${escapeHtml(t('subscribedChannelsList'))}">
              <div class="ycsm-panel-channels" role="list" aria-label="${escapeHtml(t('subscribedChannelsList'))}"></div>
            </div>
          </main>
        </div>

        <!-- Floating selection bar -->
        <div class="ycsm-new-select-bar" id="ycsm-new-select-bar">
          <button class="ycsm-select-bar-clear" id="ycsm-select-bar-clear" aria-label="Limpiar selección">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
          <span class="ycsm-select-bar-count" id="ycsm-select-bar-count"></span>
          <button class="ycsm-select-bar-assign-btn" id="ycsm-bulk-cat-btn">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>
            Asignar categoría
          </button>
        </div>

      </div>
    `;

    return overlay;
  }

  /* ═══════════════════════════════════════════════════════════════
     RENDER DEL CONTENIDO
  ═══════════════════════════════════════════════════════════════ */

  /* ═══════════════════════════════════════════════════════════════
     MODO MULTI-SELECCIÓN
  ═══════════════════════════════════════════════════════════════ */

  function updateBulkBar() {
    if (!panelEl) return;
    const bar = panelEl.querySelector('#ycsm-new-select-bar');
    if (!bar) return;
    const n = selectedIds.size;
    panelEl.querySelector('.ycsm-panel-box')?.classList.toggle('ycsm-selecting', n > 0);
    bar.classList.toggle('is-visible', n > 0);
    if (n === 0) return;
    const countEl = panelEl.querySelector('#ycsm-select-bar-count');
    if (countEl) {
      countEl.innerHTML = `<strong>${n}</strong> ${n === 1 ? 'canal seleccionado' : 'canales seleccionados'}`;
    }
  }

  function clearSelection() {
    selectedIds.clear();
    panelEl?.querySelectorAll('.ycsm-panel-card, .ycsm-channel-row').forEach((c) => c.classList.remove('ycsm-card-selected'));
    updateBulkBar();
  }

  function connectSortBtn(container) {
    const btn = container.querySelector('#ycsm-sort-btn');
    const menu = container.querySelector('#ycsm-sort-menu');
    if (!btn || !menu) return;
    const sortLabels = { activity: t('recent'), name: 'A → Z' };
    function syncSortUI() {
      const labelEl = btn.querySelector('.ycsm-sort-label');
      if (labelEl) labelEl.textContent = sortLabels[sortBy] || sortLabels.activity;
      menu.querySelectorAll('.ycsm-sort-item').forEach((item) => {
        item.setAttribute('aria-selected', String(item.dataset.value === sortBy));
      });
    }
    syncSortUI();
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const opening = menu.hidden;
      menu.hidden = !opening;
      btn.setAttribute('aria-expanded', String(opening));
    });
    menu.querySelectorAll('.ycsm-sort-item').forEach((item) => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        sortBy = item.dataset.value;
        menu.hidden = true;
        btn.setAttribute('aria-expanded', 'false');
        syncSortUI();
        renderPanelContent();
      });
    });
  }

  function toggleCardSelection(card, channelId) {
    if (selectedIds.has(channelId)) {
      selectedIds.delete(channelId);
      card.classList.remove('ycsm-card-selected');
    } else {
      selectedIds.add(channelId);
      card.classList.add('ycsm-card-selected');
    }
    updateBulkBar();
  }

  async function bulkAssignCategory(categoryId) {
    if (selectedIds.size === 0) return;
    const ids = [...selectedIds];
    for (const chId of ids) {
      await YCSM.storage.assignChannel(chId, categoryId);
    }
    if (document.getElementById('ycsm-sidebar')) YCSM.sidebar.scheduleRender();
    selectedIds.clear();
    await renderPanelContent();
    updateBulkBar();
  }

  /* ═══════════════════════════════════════════════════════════════
     FECHAS DEL ÚLTIMO VÍDEO (carga perezosa vía RSS de YouTube)
  ═══════════════════════════════════════════════════════════════ */

  function formatRelativeDate(isoStr) {
    if (!isoStr) return '';
    const date = new Date(isoStr);
    if (isNaN(date.getTime())) return '';
    const diffDays = Math.floor((Date.now() - date.getTime()) / 86400000);
    if (diffDays === 0) return t('today');
    if (diffDays === 1) return t('yesterday');
    if (diffDays < 7) return count('daysAgo', diffDays);
    const w = Math.floor(diffDays / 7);
    if (w < 5) return count('weeksAgo', w);
    const m = Math.floor(diffDays / 30);
    if (m < 12) return count('monthsAgo', m);
    const y = Math.floor(diffDays / 365);
    return count('yearsAgo', y);
  }

  function fetchLastVideoDate(channelId) {
    if (_dateCache.has(channelId)) {
      return Promise.resolve(_dateCache.get(channelId));
    }
    return fetch(
      `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`,
      { credentials: 'include' }
    )
      .then((r) => (r.ok ? r.text() : null))
      .then((xml) => {
        if (!xml) { _dateCache.set(channelId, null); return null; }
        // La primera <published> del feed Atom es la fecha de creación del canal.
        // Las fechas de vídeos están dentro de <entry>. Se extrae el <published>
        // del primer <entry>, que corresponde al vídeo más reciente.
        const m = xml.match(/<entry>[\s\S]*?<published>([^<]+)<\/published>/);
        const date = m ? m[1] : null;
        _dateCache.set(channelId, date);
        return date;
      })
      .catch(() => { _dateCache.set(channelId, null); return null; });
  }

  /**
   * Carga las fechas del último vídeo de todos los canales con concurrencia
   * limitada (15 peticiones en paralelo) para no saturar el navegador.
   */
  async function fetchAllDates(channels) {
    const CONCURRENCY = 15;
    const queue = channels.filter((ch) => !_dateCache.has(ch.id));
    async function worker() {
      while (queue.length) {
        const ch = queue.shift();
        await fetchLastVideoDate(ch.id);
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length || 1) }, worker));
  }

  function loadLastSeen() {
    return new Promise((resolve) => {
      try {
        if (!chrome.runtime?.id) return resolve({});
        chrome.storage.local.get('channelLastSeen', (r) => {
          if (chrome.runtime.lastError) return resolve({});
          resolve(r.channelLastSeen || {});
        });
      } catch (_) {
        resolve({});
      }
    });
  }

  function markChannelSeen(channelId) {
    _lastSeen[channelId] = new Date().toISOString();
    try {
      if (chrome.runtime?.id) {
        chrome.storage.local.set({ channelLastSeen: _lastSeen });
      }
    } catch (_) {}
  }

  /**
   * Devuelve true si el canal tiene un vídeo más nuevo que la última vez que el
   * usuario lo visitó. Si nunca lo visitó, usa 7 días atrás como referencia.
   */
  function hasNewVideo(channelId) {
    const lastVideo = _dateCache.get(channelId);
    if (!lastVideo) return false;
    const ref = _lastSeen[channelId] || new Date(Date.now() - 7 * 86400000).toISOString();
    return lastVideo > ref;
  }

  /* ═══════════════════════════════════════════════════════════════
     PANTALLA DE GESTIÓN DE CATEGORÍAS (vista interna del panel)
  ═══════════════════════════════════════════════════════════════ */

  async function openManageLabels(autoCreate = false) {
    if (!panelEl) return;

    const head    = panelEl.querySelector('.ycsm-panel-head');
    const body    = panelEl.querySelector('.ycsm-panel-body');
    const foot    = panelEl.querySelector('.ycsm-panel-foot');
    const bulk    = panelEl.querySelector('.ycsm-panel-bulk');

    // Legacy function — new panel HTML doesn't have these elements
    if (!head || !body) return;

    const PENCIL_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;
    const TRASH_SVG  = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/></svg>`;

    // Guardar estado original para restaurarlo al volver
    const originalHead      = head.innerHTML;
    const originalBodyHTML  = body.innerHTML;
    const originalBodyClass = body.className;
    const box = panelEl.querySelector('.ycsm-panel-box');
    const originalWidth = box ? box.style.width : '';

    // Reducir ancho del modal en la vista de gestión
    if (box) box.style.width = '450px';

    function goBack() {
      // Restaurar ancho original del modal
      if (box) box.style.width = originalWidth;
      head.classList.remove('ycsm-panel-head--manage');
      head.innerHTML = originalHead;
      // Re-conectar listeners de la cabecera (se pierden al restaurar innerHTML)
      head.querySelector('.ycsm-panel-x').addEventListener('click', () => panelEl.remove());
      if (foot) foot.hidden = false;
      updateBulkBar();
      body.innerHTML = originalBodyHTML;
      body.className = originalBodyClass;
      // Re-conectar eventos del toolbar (se pierden al restaurar innerHTML)
      const searchInput = body.querySelector('.ycsm-yt-search-input');
      if (searchInput) {
        const clearBtn = body.querySelector('.ycsm-yt-search-clear');
        const searchBox = body.querySelector('.ycsm-yt-search-box');
        searchInput.addEventListener('input', debounce((e) => { filterText = e.target.value; if (clearBtn) clearBtn.hidden = !e.target.value; renderPanelContent(); }, 150));
        searchInput.addEventListener('focus', () => { if (searchBox) searchBox.classList.add('ycsm-yt-search-focused'); });
        searchInput.addEventListener('blur', () => { if (searchBox) searchBox.classList.remove('ycsm-yt-search-focused'); });
        if (clearBtn) clearBtn.addEventListener('click', () => { searchInput.value = ''; clearBtn.hidden = true; filterText = ''; searchInput.focus(); renderPanelContent(); });
      }
      connectSortBtn(body);
      renderPanelContent();
    }

    // Cambiar cabecera
    head.classList.add('ycsm-panel-head--manage');
    head.innerHTML = '';
    const backBtn = document.createElement('button');
    backBtn.className = 'ycsm-manage-back-btn';
    backBtn.setAttribute('aria-label', t('back'));
    backBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"/></svg> ${escapeHtml(t('back'))}`;
    backBtn.addEventListener('click', goBack);

    const headTitle = document.createElement('h2');
    headTitle.textContent = t('manageCategories');

    const closeBtn = document.createElement('button');
    closeBtn.className = 'ycsm-btn-icon ycsm-panel-x';
    closeBtn.setAttribute('aria-label', t('closePanel'));
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', () => panelEl.remove());

    head.appendChild(backBtn);
    head.appendChild(headTitle);
    head.appendChild(closeBtn);

    if (foot) foot.hidden = true;
    if (bulk) bulk.hidden = true;

    // Limpiar cuerpo y cambiar a vista de gestión
    body.innerHTML = '';
    body.className = 'ycsm-panel-body ycsm-manage-view';

    async function renderManageContent() {
      body.innerHTML = '';

      const { categories, channelAssignments } = await YCSM.storage.getAll();
      const sorted = Object.values(categories).sort((a, b) => a.order - b.order);

      const countByCat = {};
      Object.values(channelAssignments).forEach((cats) => {
        (cats || []).forEach((cid) => { countByCat[cid] = (countByCat[cid] || 0) + 1; });
      });

      if (sorted.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'ycsm-manage-empty';
        empty.textContent = 'Todavía no hay categorías.';
        body.appendChild(empty);
      } else {
        const sectionTitle = document.createElement('p');
        sectionTitle.className = 'ycsm-manage-section-title';
        sectionTitle.textContent = 'Categorías existentes';
        body.appendChild(sectionTitle);

        const list = document.createElement('div');
        list.className = 'ycsm-manage-list';

        let manageDragState = null;

        sorted.forEach((cat) => {
          const row = document.createElement('div');
          row.className = 'ycsm-manage-row';
          row.dataset.catId = cat.id;
          row.setAttribute('draggable', 'false');

          const GRIP_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="5" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="19" r="1"/></svg>';
          const grip = document.createElement('span');
          grip.className = 'ycsm-manage-grip';
          grip.innerHTML = GRIP_SVG;

          // Activar draggable solo al hacer mousedown en el grip
          grip.addEventListener('mousedown', () => { row.setAttribute('draggable', 'true'); });

          row.addEventListener('dragstart', (e) => {
            manageDragState = cat.id;
            row.classList.add('ycsm-manage-dragging');
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', cat.id);
          });
          row.addEventListener('dragend', () => {
            row.setAttribute('draggable', 'false');
            row.classList.remove('ycsm-manage-dragging');
            list.querySelectorAll('.ycsm-manage-drag-over').forEach((el) => el.classList.remove('ycsm-manage-drag-over'));
            manageDragState = null;
          });
          row.addEventListener('dragover', (e) => {
            e.preventDefault();
            if (manageDragState && manageDragState !== cat.id) {
              row.classList.add('ycsm-manage-drag-over');
              e.dataTransfer.dropEffect = 'move';
            }
          });
          row.addEventListener('dragleave', (e) => {
            if (!row.contains(e.relatedTarget)) row.classList.remove('ycsm-manage-drag-over');
          });
          row.addEventListener('drop', async (e) => {
            e.preventDefault();
            row.classList.remove('ycsm-manage-drag-over');
            if (!manageDragState || manageDragState === cat.id) return;
            const rows = [...list.querySelectorAll(':scope > .ycsm-manage-row')];
            const ids = rows.map((r) => r.dataset.catId);
            const fromIdx = ids.indexOf(manageDragState);
            const toIdx = ids.indexOf(cat.id);
            if (fromIdx === -1 || toIdx === -1) return;
            ids.splice(fromIdx, 1);
            ids.splice(toIdx, 0, manageDragState);
            await YCSM.storage.reorderCategories(ids);
            await renderManageContent();
          });

          const name = document.createElement('span');
          name.className = 'ycsm-manage-name';
          name.textContent = cat.name;

          const count = document.createElement('span');
          count.className = 'ycsm-manage-count';
          const n = countByCat[cat.id] || 0;
          count.textContent = `${n} canal${n !== 1 ? 'es' : ''}`;

          const actions = document.createElement('div');
          actions.className = 'ycsm-manage-actions';

          const editBtn = document.createElement('button');
          editBtn.className = 'ycsm-manage-action-btn';
          editBtn.setAttribute('aria-label', `Editar ${cat.name}`);
          editBtn.innerHTML = PENCIL_SVG;
          editBtn.addEventListener('click', () => openEditLabel(cat));

          const delBtn = document.createElement('button');
          delBtn.className = 'ycsm-manage-action-btn ycsm-manage-del-btn';
          delBtn.setAttribute('aria-label', `Eliminar ${cat.name}`);
          delBtn.innerHTML = TRASH_SVG;
          delBtn.addEventListener('click', async () => {
            if (!confirm(`¿Eliminar la categoría "${cat.name}"?\nLos canales no se perderán, solo se desasignarán.`)) return;
            await YCSM.storage.deleteCategory(cat.id);
            await renderManageContent();
          });

          actions.appendChild(editBtn);
          actions.appendChild(delBtn);
          row.appendChild(grip);
          row.appendChild(name);
          row.appendChild(count);
          row.appendChild(actions);
          list.appendChild(row);
        });

        body.appendChild(list);
      }

      const addBtn = document.createElement('button');
      addBtn.className = 'ycsm-manage-add-btn';
      addBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg> Nueva categoría`;
      addBtn.addEventListener('click', () => {
        // Si ya hay una fila de nueva categoría, enfocar su input
        const existingNew = body.querySelector('.ycsm-manage-row-new');
        if (existingNew) { existingNew.querySelector('.ycsm-manage-new-name-input')?.focus(); return; }

        // Obtener o crear la lista
        let targetList = body.querySelector('.ycsm-manage-list');
        if (!targetList) {
          body.querySelector('.ycsm-manage-empty')?.remove();
          const secTitle = document.createElement('p');
          secTitle.className = 'ycsm-manage-section-title';
          secTitle.textContent = 'Categorías existentes';
          body.insertBefore(secTitle, addBtn);
          targetList = document.createElement('div');
          targetList.className = 'ycsm-manage-list';
          body.insertBefore(targetList, addBtn);
        }

        const { row, input } = buildInlineNewRow(async (name) => {
          await YCSM.storage.addCategory(name);
          await renderManageContent();
        });
        targetList.appendChild(row);
        input.focus();
      });
      body.appendChild(addBtn);
    }

    function openEditLabel(cat) {
      const existing = body.querySelector('.ycsm-manage-edit-form');
      if (existing) existing.remove();

      const form = document.createElement('div');
      form.className = 'ycsm-manage-edit-form';

      const formTitle = document.createElement('p');
      formTitle.className = 'ycsm-manage-edit-title';
      formTitle.textContent = cat ? 'Editar categoría' : 'Nueva categoría';

      const nameInput = document.createElement('input');
      nameInput.className = 'ycsm-manage-edit-input';
      nameInput.type = 'text';
      nameInput.placeholder = 'Nombre…';
      nameInput.maxLength = 30;
      nameInput.value = cat ? cat.name : '';

      const btnRow = document.createElement('div');
      btnRow.className = 'ycsm-manage-edit-btns';

      const saveBtn = document.createElement('button');
      saveBtn.className = 'ycsm-manage-edit-save';
      saveBtn.textContent = 'Guardar';
      saveBtn.addEventListener('click', async () => {
        const name = nameInput.value.trim();
        if (!name) { nameInput.focus(); return; }
        if (cat) {
          await YCSM.storage.updateCategory(cat.id, { name });
        } else {
          await YCSM.storage.addCategory(name);
        }
        await renderManageContent();
      });

      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'ycsm-manage-edit-cancel';
      cancelBtn.textContent = 'Cancelar';
      cancelBtn.addEventListener('click', () => form.remove());

      const fieldRow = document.createElement('div');
      fieldRow.className = 'ycsm-manage-edit-row';
      fieldRow.appendChild(nameInput);

      btnRow.appendChild(saveBtn);
      btnRow.appendChild(cancelBtn);
      form.appendChild(formTitle);
      form.appendChild(fieldRow);
      form.appendChild(btnRow);
      body.appendChild(form);
      nameInput.focus();
    }

    await renderManageContent();
    if (autoCreate) openEditLabel(null);
  }

  /* ═══════════════════════════════════════════════════════════════
     DROPDOWN INLINE DE GESTIÓN DE CATEGORÍAS
  ═══════════════════════════════════════════════════════════════ */

  function openManageDropdown(wrapEl) {
    // Toggle: si ya está abierto, cerrar
    const existing = document.getElementById('ycsm-manage-dropdown-portal');
    if (existing) { existing.remove(); return; }

    const PENCIL_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>`;
    const CLOSE_SVG  = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2C6.47 2 2 6.47 2 12s4.47 10 10 10 10-4.47 10-10S17.53 2 12 2zm5 13.59L15.59 17 12 13.41 8.41 17 7 15.59 10.59 12 7 8.41 8.41 7 12 10.59 15.59 7 17 8.41 13.41 12 17 15.59z"/></svg>`;
    const GRIP_SVG   = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="5" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="19" r="1"/></svg>`;

    const dropdown = document.createElement('div');
    dropdown.className = 'ycsm-manage-dropdown';
    dropdown.id = 'ycsm-manage-dropdown-portal';

    // ─── Cabecera (título) ───
    const header = document.createElement('div');
    header.className = 'ycsm-manage-dropdown-header';
    const titleEl = document.createElement('span');
    titleEl.className = 'ycsm-manage-dropdown-title';
    titleEl.textContent = t('manageCategories');
    header.appendChild(titleEl);
    dropdown.appendChild(header);

    // ─── Sección búsqueda + botón crear ───
    const searchSection = document.createElement('div');
    searchSection.className = 'ycsm-dd-header';

    const searchRow = document.createElement('div');
    searchRow.className = 'ycsm-dd-search-row';

    const searchBox = document.createElement('div');
    searchBox.className = 'ycsm-dd-search-box';

    const searchIconEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    searchIconEl.setAttribute('viewBox', '0 0 24 24');
    searchIconEl.setAttribute('fill', 'none');
    searchIconEl.setAttribute('aria-hidden', 'true');
    searchIconEl.classList.add('ycsm-dd-search-icon');
    const _sc = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    _sc.setAttribute('cx', '10.5'); _sc.setAttribute('cy', '10.5'); _sc.setAttribute('r', '6.5');
    _sc.setAttribute('stroke', 'currentColor'); _sc.setAttribute('stroke-width', '2');
    searchIconEl.appendChild(_sc);
    const _sp = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    _sp.setAttribute('d', 'M15.5 15.5L20 20'); _sp.setAttribute('stroke', 'currentColor');
    _sp.setAttribute('stroke-width', '2'); _sp.setAttribute('stroke-linecap', 'round');
    searchIconEl.appendChild(_sp);
    searchBox.appendChild(searchIconEl);

    const searchInput = document.createElement('input');
    searchInput.className = 'ycsm-dd-search-input';
    searchInput.type = 'text';
    searchInput.placeholder = t('searchCategoryPlaceholder');
    searchInput.autocomplete = 'off';
    searchBox.appendChild(searchInput);

    const searchClearBtn = document.createElement('button');
    searchClearBtn.className = 'ycsm-dd-search-clear';
    searchClearBtn.setAttribute('aria-label', t('clearSearch'));
    searchClearBtn.hidden = true;
    searchClearBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2C6.47 2 2 6.47 2 12s4.47 10 10 10 10-4.47 10-10S17.53 2 12 2zm5 13.59L15.59 17 12 13.41 8.41 17 7 15.59 10.59 12 7 8.41 8.41 7 12 10.59 15.59 7 17 8.41 13.41 12 17 15.59z"/></svg>`;
    searchClearBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      searchInput.value = '';
      searchClearBtn.hidden = true;
      renderDropdownContent('');
      searchInput.focus();
    });
    searchBox.appendChild(searchClearBtn);
    searchRow.appendChild(searchBox);

    const createBtn = document.createElement('button');
    createBtn.className = 'ycsm-dd-create-btn';
    createBtn.setAttribute('aria-label', t('addCategory'));
    createBtn.textContent = '+';
    createBtn.addEventListener('mouseenter', () => showTooltip(t('addCategory'), createBtn));
    createBtn.addEventListener('mouseleave', hideTooltip);
    searchRow.appendChild(createBtn);
    searchSection.appendChild(searchRow);

    const createArea = document.createElement('div');
    createArea.className = 'ycsm-dd-create-area';
    searchSection.appendChild(createArea);

    dropdown.appendChild(searchSection);

    searchInput.addEventListener('input', () => {
      const val = searchInput.value;
      searchClearBtn.hidden = !val;
      renderDropdownContent(val);
    });

    // ─── Botón crear → pill inline ───
    createBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      hideTooltip();
      if (createArea.querySelector('.ycsm-legend-new-pill')) {
        createArea.querySelector('.ycsm-new-pill-input')?.focus();
        return;
      }
      createArea.innerHTML = '';
      const pillEl = document.createElement('div');
      pillEl.className = 'ycsm-legend-new-pill ycsm-dd-new-pill';
      const nameInput = document.createElement('input');
      nameInput.className = 'ycsm-new-pill-input';
      nameInput.type = 'text';
      nameInput.placeholder = t('newCategory') + '…';
      nameInput.maxLength = 50;
      nameInput.autocomplete = 'off';
      const cancelInlineBtn = document.createElement('button');
      cancelInlineBtn.type = 'button';
      cancelInlineBtn.className = 'ycsm-new-pill-cancel';
      cancelInlineBtn.setAttribute('aria-label', t('cancel'));
      cancelInlineBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
      pillEl.appendChild(nameInput);
      pillEl.appendChild(cancelInlineBtn);
      createArea.appendChild(pillEl);
      nameInput.focus();
      let saving = false;
      async function handleCreate() {
        if (saving) return;
        const name = nameInput.value.trim();
        if (!name) { cancelCreate(); return; }
        saving = true;
        pillEl.remove();
        const newCat = await YCSM.storage.addCategory(name);
        if (document.getElementById('ycsm-sidebar')) YCSM.sidebar.scheduleRender();
        {
          const sc = panelEl?.querySelector('.ycsm-legend-scroll');
          if (sc?.querySelector('.ycsm-pill-wrap') && newCat) {
            const cw = sc.querySelector('.ycsm-legend-create-wrap');
            const wrapEl = document.createElement('div');
            wrapEl.className = 'ycsm-pill-wrap';
            wrapEl.dataset.catId = newCat.id;
            const pill = document.createElement('button');
            pill.className = 'ycsm-legend-pill';
            pill.textContent = newCat.name;
            pill.title = 'Doble clic para renombrar';
            pill.addEventListener('click', () => { filterCat = filterCat === newCat.id ? null : newCat.id; renderPanelContent(); });
            pill.addEventListener('dblclick', (ev) => { ev.stopPropagation(); startPillRename(newCat, pill); });
            wrapEl.appendChild(pill);
            sc.insertBefore(wrapEl, cw?.parentElement === sc ? cw : null);
          } else {
            renderPanelContent();
          }
        }
        renderDropdownContent(searchInput.value);
      }
      const cancelCreate = () => { saving = true; createArea.innerHTML = ''; };
      cancelInlineBtn.addEventListener('mousedown', (ev) => { ev.preventDefault(); cancelCreate(); });
      nameInput.addEventListener('blur', () => handleCreate());
      nameInput.addEventListener('keydown', (ev) => {
        ev.stopPropagation();
        if (ev.key === 'Enter') { ev.preventDefault(); handleCreate(); }
        if (ev.key === 'Escape') cancelCreate();
      });
    });

    // ─── Cuerpo scrollable ───
    const dropBody = document.createElement('div');
    dropBody.className = 'ycsm-manage-dropdown-body';
    dropdown.appendChild(dropBody);

    let closeOnOutside;
    let onKeydown;

    async function closeAndRefresh() {
      dropdown.remove();
      window.removeEventListener('resize', reposition);
      document.removeEventListener('click', closeOnOutside);
      document.removeEventListener('keydown', onKeydown);
      await renderPanelContent();
    }

    closeOnOutside = (e) => {
      if (!dropdown.contains(e.target) && !wrapEl.contains(e.target)) closeAndRefresh();
    };

    onKeydown = (e) => {
      if (e.key === 'Escape') closeAndRefresh();
    };

    async function renderDropdownContent(filter = '') {
      dropBody.innerHTML = '';

      const { categories, channelAssignments } = await YCSM.storage.getAll();
      const allSorted = Object.values(categories).sort((a, b) => a.order - b.order);

      const countByCat = {};
      Object.values(channelAssignments).forEach((cats) => {
        (cats || []).forEach((cid) => { countByCat[cid] = (countByCat[cid] || 0) + 1; });
      });

      const sorted = filter
        ? allSorted.filter((c) => normalizeSearch(c.name).includes(normalizeSearch(filter)))
        : allSorted;

      if (sorted.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'ycsm-manage-empty';
        empty.textContent = filter ? t('noResults') : t('noCategoriesCreated');
        dropBody.appendChild(empty);
        return;
      }

      const list = document.createElement('div');
      list.className = 'ycsm-manage-list';

      let manageDragState = null;

      sorted.forEach((cat) => {
        const row = document.createElement('div');
        row.className = 'ycsm-manage-row';
        row.dataset.catId = cat.id;
        row.setAttribute('draggable', 'false');

        const grip = document.createElement('span');
        grip.className = 'ycsm-manage-grip';
        grip.innerHTML = GRIP_SVG;
        grip.addEventListener('mousedown', () => { row.setAttribute('draggable', 'true'); });

        row.addEventListener('dragstart', (e) => {
          manageDragState = cat.id;
          row.classList.add('ycsm-manage-dragging');
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', cat.id);
        });
        row.addEventListener('dragend', () => {
          row.setAttribute('draggable', 'false');
          row.classList.remove('ycsm-manage-dragging');
          list.querySelectorAll('.ycsm-manage-drag-over').forEach((el) => el.classList.remove('ycsm-manage-drag-over'));
          manageDragState = null;
        });
        row.addEventListener('dragover', (e) => {
          e.preventDefault();
          if (manageDragState && manageDragState !== cat.id) {
            row.classList.add('ycsm-manage-drag-over');
            e.dataTransfer.dropEffect = 'move';
          }
        });
        row.addEventListener('dragleave', (e) => {
          if (!row.contains(e.relatedTarget)) row.classList.remove('ycsm-manage-drag-over');
        });
        row.addEventListener('drop', async (e) => {
          e.preventDefault();
          row.classList.remove('ycsm-manage-drag-over');
          if (!manageDragState || manageDragState === cat.id) return;
          const rows = [...list.querySelectorAll(':scope > .ycsm-manage-row')];
          const ids = rows.map((r) => r.dataset.catId);
          const fromIdx = ids.indexOf(manageDragState);
          const toIdx = ids.indexOf(cat.id);
          if (fromIdx === -1 || toIdx === -1) return;
          ids.splice(fromIdx, 1);
          ids.splice(toIdx, 0, manageDragState);
          await YCSM.storage.reorderCategories(ids);
          await renderDropdownContent(searchInput.value);
          await refreshLegendOrder();
        });

        // Info: nombre + count apilados
        const info = document.createElement('div');
        info.className = 'ycsm-manage-info';
        const nameEl = document.createElement('span');
        nameEl.className = 'ycsm-manage-name';
        nameEl.textContent = cat.name;
        nameEl.title = cat.name;
        const countEl = document.createElement('span');
        countEl.className = 'ycsm-manage-count';
        const n = countByCat[cat.id] || 0;
        const countKey = n === 1 ? 'channelCountOne' : 'channelCountMany';
        countEl.textContent = t(countKey, String(n));
        info.appendChild(nameEl);
        info.appendChild(countEl);

        const actions = document.createElement('div');
        actions.className = 'ycsm-manage-actions';

        const editBtn = document.createElement('button');
        editBtn.className = 'ycsm-manage-action-btn';
        editBtn.setAttribute('aria-label', t('editCategoryName', cat.name));
        editBtn.innerHTML = PENCIL_SVG;
        editBtn.addEventListener('mouseenter', () => showTooltip(t('editAction'), editBtn));
        editBtn.addEventListener('mouseleave', hideTooltip);
        editBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          hideTooltip();
          if (list.querySelector('.ycsm-manage-edit-pill')) {
            list.querySelector('.ycsm-new-pill-input')?.focus();
            return;
          }
          const pillEl = document.createElement('div');
          pillEl.className = 'ycsm-legend-new-pill ycsm-manage-edit-pill';
          const nameInput = document.createElement('input');
          nameInput.className = 'ycsm-new-pill-input';
          nameInput.type = 'text';
          nameInput.value = cat.name;
          nameInput.maxLength = 50;
          nameInput.autocomplete = 'off';
          const cancelEditBtn = document.createElement('button');
          cancelEditBtn.type = 'button';
          cancelEditBtn.className = 'ycsm-new-pill-cancel';
          cancelEditBtn.setAttribute('aria-label', t('cancel'));
          cancelEditBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
          pillEl.appendChild(nameInput);
          pillEl.appendChild(cancelEditBtn);
          row.replaceWith(pillEl);
          nameInput.focus();
          nameInput.select();
          let saving = false;
          async function handleEdit() {
            if (saving) return;
            const name = nameInput.value.trim();
            saving = true;
            if (!name || name === cat.name) { pillEl.replaceWith(row); return; }
            pillEl.remove();
            await YCSM.storage.updateCategory(cat.id, { name });
            if (document.getElementById('ycsm-sidebar')) YCSM.sidebar.scheduleRender();
            const legendPill = panelEl?.querySelector(`.ycsm-pill-wrap[data-cat-id="${CSS.escape(cat.id)}"] .ycsm-legend-pill`);
            if (legendPill) legendPill.textContent = name;
            renderDropdownContent(searchInput.value);
          }
          const cancelEdit = () => { saving = true; pillEl.replaceWith(row); };
          cancelEditBtn.addEventListener('mousedown', (ev) => { ev.preventDefault(); cancelEdit(); });
          nameInput.addEventListener('blur', () => handleEdit());
          nameInput.addEventListener('keydown', (ev) => {
            ev.stopPropagation();
            if (ev.key === 'Enter') { ev.preventDefault(); handleEdit(); }
            if (ev.key === 'Escape') cancelEdit();
          });
        });

        const delBtn = document.createElement('button');
        delBtn.className = 'ycsm-manage-action-btn ycsm-manage-del-btn';
        delBtn.setAttribute('aria-label', t('deleteCategoryName', cat.name));
        delBtn.innerHTML = CLOSE_SVG;
        delBtn.addEventListener('mouseenter', () => showTooltip(t('deleteAction'), delBtn));
        delBtn.addEventListener('mouseleave', hideTooltip);
        delBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          hideTooltip();
          if (filterCat === cat.id) filterCat = null;
          await YCSM.storage.deleteCategory(cat.id);
          if (document.getElementById('ycsm-sidebar')) YCSM.sidebar.scheduleRender();
          panelEl?.querySelector(`.ycsm-pill-wrap[data-cat-id="${CSS.escape(cat.id)}"]`)?.remove();
          if (panelEl && !panelEl.querySelector('.ycsm-pill-wrap')) renderPanelContent();
          renderDropdownContent(searchInput.value);
        });

        actions.appendChild(editBtn);
        actions.appendChild(delBtn);
        row.appendChild(grip);
        row.appendChild(info);
        row.appendChild(actions);
        list.appendChild(row);
      });

      dropBody.appendChild(list);
    }

    // Posicionar como portal fixed — medir ANTES de añadir al DOM para evitar reflows
    document.body.appendChild(dropdown);

    const positionDropdown = () => {
      const r = wrapEl.getBoundingClientRect();
      const W = 300;
      const GAP = 6;
      let left = r.left;
      if (left + W > window.innerWidth - 8) left = window.innerWidth - W - 8;
      if (left < 8) left = 8;
      const spaceBelow = window.innerHeight - r.bottom - GAP;
      const spaceAbove = r.top - GAP;
      dropdown.style.position = 'fixed';
      dropdown.style.left = left + 'px';
      dropdown.style.right = '';
      dropdown.style.zIndex = '99999';
      if (spaceBelow >= Math.min(380, 200) || spaceBelow >= spaceAbove) {
        dropdown.style.top = (r.bottom + GAP) + 'px';
        dropdown.style.bottom = '';
      } else {
        dropdown.style.top = '';
        dropdown.style.bottom = (window.innerHeight - r.top + GAP) + 'px';
      }
    };
    positionDropdown();

    const reposition = () => positionDropdown();
    window.addEventListener('resize', reposition);

    setTimeout(() => {
      document.addEventListener('click', closeOnOutside);
      document.addEventListener('keydown', onKeydown);
    }, 0);

    renderDropdownContent();
  }

  /* ═══════════════════════════════════════════════════════════════
     HELPERS DE EDICIÓN DE PILLS
  ═══════════════════════════════════════════════════════════════ */

  function startPillRename(cat, pillBtn) {
    if (pillBtn.querySelector('.ycsm-pill-rename-input')) return;
    const currentName = cat.name;
    const input = document.createElement('input');
    input.className = 'ycsm-pill-rename-input';
    input.value = currentName;
    input.maxLength = 30;
    input.size = Math.max(currentName.length, 6);

    pillBtn.classList.add('ycsm-pill-editing');
    pillBtn.textContent = '';
    pillBtn.appendChild(input);
    input.focus();
    input.select();

    let saved = false;

    const commit = async () => {
      if (saved) return;
      saved = true;
      const newName = input.value.trim();
      pillBtn.classList.remove('ycsm-pill-editing');
      if (newName && newName !== currentName) {
        await YCSM.storage.updateCategory(cat.id, { name: newName });
        if (document.getElementById('ycsm-sidebar')) YCSM.sidebar.scheduleRender();
      }
      await renderPanelContent();
    };

    input.addEventListener('blur', commit);
    input.addEventListener('input', () => { input.size = Math.max(input.value.length, 6); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      if (e.key === 'Escape') {
        saved = true;
        pillBtn.classList.remove('ycsm-pill-editing');
        pillBtn.textContent = currentName;
      }
    });
  }

  /**
   * Crea una fila inline de "nueva categoría" para insertar en una lista de gestión.
   * El botón check ocupa el lugar del grip; se confirma con Enter, click en check o
   * clic fuera (blur). Se cancela con Escape o blur con campo vacío.
   * @param {function(string): Promise<void>} onSave - callback con el nombre confirmado
   * @returns {{ row: HTMLElement, input: HTMLInputElement }}
   */
  function buildInlineNewRow(onSave) {
    const CHECK_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>';

    const row = document.createElement('div');
    row.className = 'ycsm-manage-row ycsm-manage-row-new';

    const checkBtn = document.createElement('button');
    checkBtn.type = 'button';
    checkBtn.className = 'ycsm-manage-check-btn';
    checkBtn.setAttribute('aria-label', 'Confirmar');
    checkBtn.innerHTML = CHECK_SVG;

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'ycsm-manage-new-name-input';
    input.placeholder = 'Nombre de categoría…';
    input.maxLength = 30;
    input.autocomplete = 'off';

    let saving = false;

    const save = async () => {
      if (saving) return;
      const name = input.value.trim();
      if (!name) { if (row.isConnected) row.remove(); return; }
      saving = true;
      if (row.isConnected) row.remove();
      await onSave(name);
    };

    // mousedown en check para que no dispare blur antes
    checkBtn.addEventListener('mousedown', (e) => { e.preventDefault(); save(); });
    input.addEventListener('blur', () => { if (!saving) save(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); save(); }
      if (e.key === 'Escape') { saving = true; row.remove(); }
    });

    row.appendChild(checkBtn);
    row.appendChild(input);

    return { row, input };
  }

  function insertInlineNewPill(legend, createWrap) {
    const existing = legend.querySelector('.ycsm-legend-new-pill');
    if (existing) { existing.querySelector('.ycsm-new-pill-input')?.focus(); return; }

    const pillEl = document.createElement('div');
    pillEl.className = 'ycsm-legend-new-pill';

    const input = document.createElement('input');
    input.className = 'ycsm-new-pill-input';
    input.type = 'text';
    input.placeholder = 'Nueva categoría…';
    input.maxLength = 30;
    input.autocomplete = 'off';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'ycsm-new-pill-cancel';
    cancelBtn.setAttribute('aria-label', 'Cancelar');
    cancelBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

    pillEl.appendChild(input);
    pillEl.appendChild(cancelBtn);
    legend.insertBefore(pillEl, createWrap?.parentElement === legend ? createWrap : null);
    legend.scrollLeft = legend.scrollWidth;   // scroll al final para ver el input
    input.focus();

    let saving = false;

    const save = async () => {
      if (saving) return;
      const name = input.value.trim();
      if (!name) { cancel(); return; }
      saving = true;
      pillEl.remove();
      await YCSM.storage.addCategory(name);
      if (document.getElementById('ycsm-sidebar')) YCSM.sidebar.scheduleRender();
      await renderPanelContent();
    };

    const cancel = () => { saving = true; pillEl.remove(); };

    cancelBtn.addEventListener('mousedown', (e) => { e.preventDefault(); cancel(); });
    input.addEventListener('blur', () => save());
    input.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter') { e.preventDefault(); await save(); }
      if (e.key === 'Escape') cancel();
    });
  }

  /* ═══════════════════════════════════════════════════════════════
     SIDEBAR
  ═══════════════════════════════════════════════════════════════ */

  function catColorFromHue(hue) {
    return `oklch(0.72 0.16 ${hue})`;
  }
  function catBgFromHue(hue, alpha = 0.16) {
    return `oklch(0.72 0.16 ${hue} / ${alpha})`;
  }

  async function renderSidebar() {
    if (!panelEl) return;
    const sideNav = panelEl.querySelector('#ycsm-side-cats-nav');
    if (!sideNav) return;

    const { categories, channelAssignments } = await YCSM.storage.getAll();
    const sortedCats = Object.values(categories).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

    // Update system filter counts
    const totalCount = allChannels.length;
    const recentCount = allChannels.filter((ch) => {
      const d = _dateCache.get(ch.id);
      if (!d) return false;
      return (Date.now() - new Date(d).getTime()) < 2 * 24 * 60 * 60 * 1000;
    }).length;
    const uncatCount = allChannels.filter((ch) => {
      const cats = channelAssignments[ch.id] || [];
      return cats.length === 0;
    }).length;

    const countAll = panelEl.querySelector('[data-count="all"]');
    const countRecent = panelEl.querySelector('[data-count="recent"]');
    const countUncat = panelEl.querySelector('[data-count="uncategorized"]');
    if (countAll) countAll.textContent = totalCount;
    if (countRecent) countRecent.textContent = recentCount;
    if (countUncat) countUncat.textContent = uncatCount;

    // Update active state for system items
    panelEl.querySelectorAll('#ycsm-side-system-nav .ycsm-side-item').forEach((btn) => {
      btn.classList.toggle('is-active', btn.dataset.view === viewMode);
    });

    // Render category items
    sideNav.innerHTML = '';
    sortedCats.forEach((cat) => {
      const count = allChannels.filter((ch) => (channelAssignments[ch.id] || []).includes(cat.id)).length;
      const color = catColorFromHue(cat.hue ?? 220);

      const item = document.createElement('div');
      item.className = `ycsm-side-item${viewMode === cat.id ? ' is-active' : ''}${isManaging ? ' is-managing' : ''}`;
      item.dataset.catId = cat.id;

      if (isManaging) {
        item.innerHTML = `
          <span class="ycsm-side-dot" style="background:${escapeHtml(color)}"></span>
          <span class="ycsm-side-name">${escapeHtml(cat.name)}</span>
          <span class="ycsm-side-actions">
            <button class="ycsm-side-action-btn" data-action="rename" data-cat-id="${escapeHtml(cat.id)}" title="Renombrar">
              <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4z"/></svg>
            </button>
            <button class="ycsm-side-action-btn" data-action="delete" data-cat-id="${escapeHtml(cat.id)}" title="Eliminar">
              <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>
            </button>
          </span>
        `;

        item.querySelector('[data-action="rename"]').addEventListener('click', (e) => {
          e.stopPropagation();
          startSidebarRename(cat, item);
        });
        item.querySelector('[data-action="delete"]').addEventListener('click', async (e) => {
          e.stopPropagation();
          await YCSM.storage.deleteCategory(cat.id);
          if (viewMode === cat.id) viewMode = 'all';
          if (document.getElementById('ycsm-sidebar')) YCSM.sidebar.scheduleRender();
          await renderSidebar();
          await renderPanelContent();
        });
      } else {
        item.innerHTML = `
          <span class="ycsm-side-dot" style="background:${escapeHtml(color)}"></span>
          <span class="ycsm-side-name">${escapeHtml(cat.name)}</span>
          <span class="ycsm-side-count">${count}</span>
        `;
        item.addEventListener('click', () => {
          viewMode = cat.id;
          filterCat = cat.id;
          renderSidebar();
          renderPanelContent();
        });
      }

      sideNav.appendChild(item);
    });

    if (sortedCats.length === 0 && !isManaging) {
      const empty = document.createElement('p');
      empty.className = 'ycsm-side-empty';
      empty.textContent = 'Sin categorías aún.';
      sideNav.appendChild(empty);
    }
  }

  function startSidebarRename(cat, itemEl) {
    const nameSpan = itemEl.querySelector('.ycsm-side-name');
    if (!nameSpan) return;
    const input = document.createElement('input');
    input.className = 'ycsm-side-rename-input';
    input.value = cat.name;
    input.maxLength = 30;
    nameSpan.replaceWith(input);
    input.focus();
    input.select();

    const commit = async () => {
      const n = input.value.trim();
      if (n && n !== cat.name) {
        await YCSM.storage.updateCategory(cat.id, { name: n });
        if (document.getElementById('ycsm-sidebar')) YCSM.sidebar.scheduleRender();
      }
      await renderSidebar();
    };
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter') { e.preventDefault(); await commit(); }
      if (e.key === 'Escape') { input.value = cat.name; await commit(); }
    });
  }

  /* ═══════════════════════════════════════════════════════════════
     LIST VIEW — renders channels as rows with inline chips
  ═══════════════════════════════════════════════════════════════ */

  function buildCatChip(cat, channelId, onRemove) {
    const color = catColorFromHue(cat.hue ?? 220);
    const bg = catBgFromHue(cat.hue ?? 220, 0.16);
    const borderBg = catBgFromHue(cat.hue ?? 220, 0.35);

    const chip = document.createElement('span');
    chip.className = 'ycsm-cat-chip';
    chip.style.cssText = `display:inline-flex;align-items:center;gap:6px;padding:3px 4px 3px 9px;border-radius:999px;background:${bg};color:${color};font-size:12px;font-weight:500;line-height:1.2;border:1px solid ${borderBg}`;

    const dot = document.createElement('span');
    dot.style.cssText = `width:6px;height:6px;border-radius:50%;background:${color};flex-shrink:0`;
    chip.appendChild(dot);

    const label = document.createElement('span');
    label.textContent = cat.name;
    chip.appendChild(label);

    const removeBtn = document.createElement('button');
    removeBtn.className = 'ycsm-chip-remove';
    removeBtn.setAttribute('aria-label', `Quitar ${cat.name}`);
    removeBtn.style.cssText = 'background:transparent;border:none;color:inherit;opacity:0.6;display:flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:50%;cursor:pointer;padding:0;flex-shrink:0';
    removeBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
    removeBtn.addEventListener('click', (e) => { e.stopPropagation(); onRemove(); });
    chip.appendChild(removeBtn);

    return chip;
  }

  function buildChannelRow(ch, categories, channelAssignments, catColorFn) {
    const assignedCatIds = channelAssignments[ch.id] || [];
    const assignedCats = assignedCatIds.map((id) => categories[id]).filter(Boolean);

    const row = document.createElement('div');
    row.className = `ycsm-channel-row${selectedIds.has(ch.id) ? ' ycsm-card-selected' : ''}`;
    row.dataset.channelId = ch.id;

    // Checkbox
    const checkCell = document.createElement('label');
    checkCell.className = 'ycsm-row-check';
    checkCell.addEventListener('click', (e) => e.stopPropagation());
    const checkInput = document.createElement('input');
    checkInput.type = 'checkbox';
    checkInput.checked = selectedIds.has(ch.id);
    checkInput.addEventListener('change', () => {
      if (checkInput.checked) { selectedIds.add(ch.id); row.classList.add('ycsm-card-selected'); }
      else { selectedIds.delete(ch.id); row.classList.remove('ycsm-card-selected'); }
      updateBulkBar();
    });
    const checkBox = document.createElement('span');
    checkBox.className = 'ycsm-check-box';
    checkCell.appendChild(checkInput);
    checkCell.appendChild(checkBox);
    row.appendChild(checkCell);

    // Avatar
    const avatarWrap = document.createElement('div');
    avatarWrap.className = 'ycsm-row-avatar';
    const avatar = document.createElement('div');
    avatar.className = 'ycsm-avatar-circle';
    const initial = ch.name ? ch.name[0].toUpperCase() : '?';
    if (ch.avatar) {
      const img = document.createElement('img');
      img.src = ch.avatar;
      img.alt = '';
      img.loading = 'lazy';
      avatar.appendChild(img);
    } else {
      avatar.textContent = initial;
      avatar.style.background = `hsl(${(ch.name.charCodeAt(0) * 47) % 360} 40% 40%)`;
    }
    avatarWrap.appendChild(avatar);
    row.appendChild(avatarWrap);

    // Meta (name + last seen)
    const meta = document.createElement('div');
    meta.className = 'ycsm-row-meta';
    const nameEl = document.createElement('div');
    nameEl.className = 'ycsm-row-name';
    nameEl.textContent = ch.name;
    meta.appendChild(nameEl);
    row.appendChild(meta);

    // Category chips + add button
    const catsCell = document.createElement('div');
    catsCell.className = 'ycsm-row-cats';

    assignedCats.slice(0, 3).forEach((cat) => {
      const chip = buildCatChip(cat, ch.id, async () => {
        await YCSM.storage.unassignChannel(ch.id, cat.id);
        if (document.getElementById('ycsm-sidebar')) YCSM.sidebar.scheduleRender();
        await renderSidebar();
        await renderPanelContent();
      });
      catsCell.appendChild(chip);
    });
    if (assignedCats.length > 3) {
      const more = document.createElement('span');
      more.className = 'ycsm-chip-more';
      more.textContent = `+${assignedCats.length - 3}`;
      catsCell.appendChild(more);
    }

    // + Categorizar button (same picker as before)
    const addWrap = document.createElement('div');
    addWrap.className = 'ycsm-add-cat-wrap';
    const addBtn = document.createElement('button');
    addBtn.className = `ycsm-add-cat-btn${assignedCats.length === 0 ? ' ycsm-add-cat-btn-labeled' : ''}`;
    addBtn.setAttribute('aria-label', 'Asignar categoría');
    addBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>${assignedCats.length === 0 ? '<span>Categorizar</span>' : ''}`;

    addBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openCategoryPicker(addBtn, {
        categories,
        getAssigned: () => channelAssignments[ch.id] || [],
        onToggle: async (catId) => {
          const currentAssigned = channelAssignments[ch.id] || [];
          if (currentAssigned.includes(catId)) {
            await YCSM.storage.unassignChannel(ch.id, catId);
            channelAssignments[ch.id] = currentAssigned.filter((id) => id !== catId);
          } else {
            await YCSM.storage.assignChannel(ch.id, catId);
            if (!channelAssignments[ch.id]) channelAssignments[ch.id] = [];
            if (!channelAssignments[ch.id].includes(catId)) channelAssignments[ch.id].push(catId);
          }
          if (document.getElementById('ycsm-sidebar')) YCSM.sidebar.scheduleRender();
          await renderSidebar();
        },
        onCreate: async (name) => {
          const newCat = await YCSM.storage.addCategory(name);
          if (newCat) {
            categories[newCat.id] = newCat;
            await YCSM.storage.assignChannel(ch.id, newCat.id);
            if (!channelAssignments[ch.id]) channelAssignments[ch.id] = [];
            if (!channelAssignments[ch.id].includes(newCat.id)) channelAssignments[ch.id].push(newCat.id);
          }
          if (document.getElementById('ycsm-sidebar')) YCSM.sidebar.scheduleRender();
          await renderSidebar();
        },
        onClose: () => renderPanelContent(),
        isBulk: false,
      });
    });

    addWrap.appendChild(addBtn);
    catsCell.appendChild(addWrap);
    row.appendChild(catsCell);

    // Click row → open channel
    row.addEventListener('click', (e) => {
      if (e.target.closest('.ycsm-row-check, .ycsm-add-cat-wrap, .ycsm-cat-chip')) return;
      const url = ch.href ? `https://www.youtube.com${ch.href}` : `https://www.youtube.com/channel/${ch.id}`;
      window.open(url, '_blank', 'noopener');
    });

    return row;
  }


  /* ═══════════════════════════════════════════════════════════════
     RENDER DEL CONTENIDO
  ═══════════════════════════════════════════════════════════════ */

  async function renderPanelContent() {
    if (!panelEl) return;
    // Si estamos en la vista de gestión de categorías, no renderizar el contenido principal
    if (panelEl.querySelector('.ycsm-manage-view')) return;

    const { categories, channelAssignments } = await YCSM.storage.getAll();
    const sortedCats = Object.values(categories).sort((a, b) => a.order - b.order);

    /* ── Sidebar ── */
    await renderSidebar();

    /* ── Ordenación ── */
    let sorted;
    if (sortBy === 'name') {
      sorted = [...allChannels].sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
      );
    } else {
      // 'activity': ordenar por fecha del último vídeo (más reciente primero)
      // Si faltan fechas en caché, cargarlas todas antes de ordenar
      const needsFetch = allChannels.some((ch) => !_dateCache.has(ch.id));
      if (needsFetch) {
        const list = panelEl.querySelector('.ycsm-panel-channels');
        list.innerHTML = `<div class="ycsm-panel-empty" style="grid-column:1/-1">${escapeHtml(t('loadingDates'))}</div>`;
        await fetchAllDates(allChannels);
        if (!panelEl) return; // panel cerrado mientras cargaba
      }
      sorted = [...allChannels].sort((a, b) => {
        // Las fechas ISO 8601 se comparan lexicográficamente de forma correcta
        const da = _dateCache.get(a.id) || '';
        const db = _dateCache.get(b.id) || '';
        return db < da ? -1 : db > da ? 1 : 0;
      });
    }

    /* ── Filtrado por viewMode + texto ── */
    const visible = sorted.filter((ch) => {
      const matchText = !filterText || normalizeSearch(ch.name).includes(normalizeSearch(filterText));
      let matchView = true;
      if (viewMode === 'recent') {
        matchView = hasNewVideo(ch.id);
      } else if (viewMode === 'uncategorized') {
        matchView = (channelAssignments[ch.id] || []).length === 0;
      } else if (viewMode !== 'all') {
        matchView = (channelAssignments[ch.id] || []).includes(viewMode);
      }
      return matchText && matchView;
    });

    // Toolbar title + count
    const viewLabels = { all: 'Todas las suscripciones', recent: 'Recientes', uncategorized: 'Sin categorizar' };
    const currentCatName = sortedCats.find((c) => c.id === viewMode)?.name;
    const viewLabel = viewLabels[viewMode] || currentCatName || 'Todas las suscripciones';
    const viewNameEl = panelEl.querySelector('#ycsm-toolbar-view-name');
    const toolbarCountEl = panelEl.querySelector('#ycsm-toolbar-count');
    if (viewNameEl) viewNameEl.textContent = viewLabel;
    if (toolbarCountEl) toolbarCountEl.textContent = `${visible.length} ${visible.length === 1 ? 'canal' : 'canales'}`;

    /* ── Lista de canales ── */
    const list = panelEl.querySelector('.ycsm-panel-channels');
    list.innerHTML = '';

    if (visible.length === 0) {
      const emptyMsg = filterText ? `Sin resultados para "${filterText}"`
        : viewMode === 'uncategorized' ? '¡Todo categorizado!'
        : viewMode === 'recent' ? 'No hay canales con actividad reciente.'
        : viewMode !== 'all' ? `Esta categoría está vacía.`
        : 'No se detectaron suscripciones. Despliega el menú de suscripciones en YouTube y vuelve a abrir este panel.';
      const empty = document.createElement('div');
      empty.className = 'ycsm-new-empty';
      empty.innerHTML = `<div class="ycsm-new-empty-title">${escapeHtml(emptyMsg)}</div>`;
      list.appendChild(empty);
      return;
    }

    if (layoutMode === 'list') {
      list.classList.remove('ycsm-panel-channels--grid');
      list.classList.add('ycsm-panel-channels--list');

      // List header
      const listHead = document.createElement('div');
      listHead.className = 'ycsm-list-head';
      listHead.innerHTML = `
        <span class="ycsm-list-head-check">
          <label style="cursor:pointer;display:flex;align-items:center">
            <input type="checkbox" class="ycsm-list-select-all-check" style="position:absolute;opacity:0;pointer-events:none">
            <span class="ycsm-check-box ycsm-check-box-head" id="ycsm-list-head-check"></span>
          </label>
        </span>
        <span class="ycsm-list-head-channel">Canal</span>
        <span class="ycsm-list-head-cats">Categorías</span>
      `;
      const selectAllCheck = listHead.querySelector('.ycsm-list-select-all-check');
      const headCheckBox = listHead.querySelector('#ycsm-list-head-check');
      const nSelected = visible.filter((c) => selectedIds.has(c.id)).length;
      if (nSelected === visible.length && visible.length > 0) {
        headCheckBox.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
        headCheckBox.classList.add('is-checked');
      } else if (nSelected > 0) {
        headCheckBox.innerHTML = `<span class="ycsm-indet"></span>`;
        headCheckBox.classList.add('is-indeterminate');
      }
      selectAllCheck.addEventListener('change', (e) => {
        if (e.target.checked) {
          visible.forEach((c) => { selectedIds.add(c.id); list.querySelector(`[data-channel-id="${CSS.escape(c.id)}"]`)?.classList.add('ycsm-card-selected'); });
        } else {
          visible.forEach((c) => { selectedIds.delete(c.id); list.querySelector(`[data-channel-id="${CSS.escape(c.id)}"]`)?.classList.remove('ycsm-card-selected'); });
        }
        updateBulkBar();
      });
      list.appendChild(listHead);

      visible.forEach((channel) => {
        const row = buildChannelRow(channel, categories, channelAssignments);
        list.appendChild(row);
      });
      return;
    }

    // Grid view (original card rendering)
    list.classList.remove('ycsm-panel-channels--list');
    list.classList.add('ycsm-panel-channels--grid');

    const TIME_ICON_SVG = '<svg class="ycsm-date-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>';

    visible.forEach((channel) => {
      const assigned = channelAssignments[channel.id] || [];
      const card = document.createElement('div');
      card.className = 'ycsm-panel-card' +
        (selectedIds.has(channel.id) ? ' ycsm-card-selected' : '');
      card.setAttribute('role', 'listitem');
      card.setAttribute('title', `Abrir canal de ${channel.name}`);
      card.style.cursor = 'pointer';
      card.dataset.channelId = channel.id;

      const avatarClass = 'ycsm-card-avatar';
      const avatarHtml = channel.avatar
        ? `<img class="${avatarClass}" src="${escapeHtml(channel.avatar)}" alt="" loading="lazy">`
        : `<div class="${avatarClass} ycsm-card-avatar-ph">${escapeHtml(channel.name.charAt(0).toUpperCase())}</div>`;

      const isNew = hasNewVideo(channel.id);
      card.innerHTML = `
        <div class="ycsm-card-thumb-wrap">
          <div class="ycsm-card-check" aria-hidden="true"></div>
          ${avatarHtml}
          ${isNew ? '<span class="ycsm-card-new-dot" aria-label="Nuevos vídeos sin ver"></span>' : ''}
        </div>
        <span class="ycsm-card-name" title="${escapeHtml(channel.name)}">${escapeHtml(channel.name)}</span>
        <span class="ycsm-card-date" data-cid="${escapeHtml(channel.id)}" title="Último vídeo publicado">${_dateCache.get(channel.id) ? TIME_ICON_SVG + escapeHtml(formatRelativeDate(_dateCache.get(channel.id))) : ''}</span>
        <div class="ycsm-card-cats" role="group" aria-label="Categorías de ${escapeHtml(channel.name)}"></div>
      `;

      card.addEventListener('click', (e) => {
        if (e.target.closest('.ycsm-tag-wrap')) return;
        if (e.target.closest('.ycsm-card-check') || e.ctrlKey || e.metaKey || selectedIds.size > 0) {
          e.preventDefault();
          toggleCardSelection(card, channel.id);
          return;
        }
        const url = channel.href
          ? `https://www.youtube.com${channel.href}`
          : `https://www.youtube.com/channel/${channel.id}`;
        markChannelSeen(channel.id);
        card.querySelector('.ycsm-card-new-dot')?.remove();
        window.open(url, '_blank', 'noopener');
      });

      const catsContainer = card.querySelector('.ycsm-card-cats');

      // Tag button → unified category picker
      {
        const tagWrap = document.createElement('div');
        tagWrap.className = 'ycsm-tag-wrap';

        const tagBtn = document.createElement('button');
        tagBtn.className = 'ycsm-tag-btn';
        tagBtn.title = 'Gestionar categorías';
        tagBtn.setAttribute('aria-label', `Gestionar categorías de ${channel.name}`);

        const TAG_SVG = `<svg class="ycsm-tag-btn-icon" width="13" height="13" viewBox="-1 -1 26 26" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="overflow:visible"><path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z"/><circle cx="7" cy="7" r="0.5" fill="currentColor" stroke="none"/></svg>`;

        const PLUS_SVG = `<svg class="ycsm-tag-btn-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`;

        function renderTagBtnContent() {
          const currentAssigned = sortedCats.filter((cat) =>
            (channelAssignments[channel.id] || []).includes(cat.id)
          );
          if (currentAssigned.length === 0) {
            tagBtn.classList.remove('ycsm-tag-btn--multi');
            tagBtn.classList.add('ycsm-tag-btn-secondary');
            tagBtn.innerHTML = PLUS_SVG + `<span class="ycsm-tag-btn-empty">Categoría</span>`;
          } else if (currentAssigned.length === 1) {
            tagBtn.classList.remove('ycsm-tag-btn--multi');
            tagBtn.classList.remove('ycsm-tag-btn-secondary');
            const cat = currentAssigned[0];
            tagBtn.innerHTML = TAG_SVG + `<span class="ycsm-tag-btn-label">${escapeHtml(cat.name)}</span>`;
          } else {
            tagBtn.classList.remove('ycsm-tag-btn-secondary');
            tagBtn.classList.add('ycsm-tag-btn--multi');
            const shown = currentAssigned.slice(0, 2);
            const extra = currentAssigned.length - 2;
            const chipsHtml = shown.map((cat) => {
              const color = escapeHtml(cat.color || '#999');
              return `<span class="ycsm-tag-cat-chip" style="--cat-color:${color}"><span class="ycsm-tag-cat-dot"></span><span class="ycsm-tag-cat-name">${escapeHtml(cat.name)}</span></span>`;
            }).join('');
            tagBtn.innerHTML = chipsHtml + (extra > 0 ? `<span class="ycsm-tag-extra-count">+${extra}</span>` : '');
          }
        }

        renderTagBtnContent();

        tagBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          openCategoryPicker(tagBtn, {
            categories,
            getAssigned: () => channelAssignments[channel.id] || [],
            onToggle: async (catId) => {
              const currentAssigned = channelAssignments[channel.id] || [];
              const isOn = currentAssigned.includes(catId);
              if (isOn) {
                await YCSM.storage.unassignChannel(channel.id, catId);
                channelAssignments[channel.id] = currentAssigned.filter((id) => id !== catId);
                if (channelAssignments[channel.id].length === 0) delete channelAssignments[channel.id];
              } else {
                await YCSM.storage.assignChannel(channel.id, catId);
                if (!channelAssignments[channel.id]) channelAssignments[channel.id] = [];
                if (!channelAssignments[channel.id].includes(catId)) channelAssignments[channel.id].push(catId);
              }
              renderTagBtnContent();
              if (document.getElementById('ycsm-sidebar')) YCSM.sidebar.scheduleRender();
              await renderSidebar();
            },
            onCreate: async (name) => {
              const newCat = await YCSM.storage.addCategory(name);
              if (newCat) {
                categories[newCat.id] = newCat;
                sortedCats.push(newCat);
                sortedCats.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
                await YCSM.storage.assignChannel(channel.id, newCat.id);
                if (!channelAssignments[channel.id]) channelAssignments[channel.id] = [];
                channelAssignments[channel.id].push(newCat.id);
              }
              renderTagBtnContent();
              if (document.getElementById('ycsm-sidebar')) YCSM.sidebar.scheduleRender();
              await renderSidebar();
            },
            onClose: () => renderPanelContent(),
            isBulk: false,
          });
        });

        tagWrap.appendChild(tagBtn);
        catsContainer.appendChild(tagWrap);
      }

      list.appendChild(card);
    });

    // Observar spans de fecha vacíos para carga perezosa (solo los que no tienen fecha ya)
    if (_dateObserver) _dateObserver.disconnect();
    _dateObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          const span = entry.target;
          _dateObserver.unobserve(span);
          if (span.textContent) return; // ya tiene fecha del caché
          fetchLastVideoDate(span.dataset.cid).then((iso) => {
            if (iso) {
              span.innerHTML = TIME_ICON_SVG + escapeHtml(formatRelativeDate(iso));
            }
            // Actualizar punto azul ahora que tenemos la fecha
            if (hasNewVideo(span.dataset.cid)) {
              const card = span.closest('.ycsm-panel-card');
              if (card && !card.querySelector('.ycsm-card-new-dot')) {
                const dot = document.createElement('span');
                dot.className = 'ycsm-card-new-dot';
                dot.setAttribute('aria-label', 'Nuevos vídeos sin ver');
                card.querySelector('.ycsm-card-thumb-wrap').appendChild(dot);
              }
            }
          });
        });
      },
      { root: panelEl.querySelector('.ycsm-panel-body'), rootMargin: '160px' }
    );
    list.querySelectorAll('.ycsm-card-date:empty').forEach((span) => _dateObserver.observe(span));
  }

  /* ═══════════════════════════════════════════════════════════════
     MIGRACIÓN DE IDs LEGACY
  ═══════════════════════════════════════════════════════════════ */

  /**
   * El scraper DOM antiguo usaba el href como ID (p.ej. "/@handle", "/c/name").
   * El fetch nuevo usa el channelId real (UCxxxxx).
   * Esta función reescribe las asignaciones guardadas para que usen el ID
   * canónico, de modo que los badges y pills aparezcan correctamente.
   */
  async function migrateAssignmentIds(channels) {
    const assignments = await YCSM.storage.getChannelAssignments();

    // Construir mapa: href-key → channelId canónico
    const hrefToId = {};
    for (const ch of channels) {
      if (!ch.href) continue;
      const hrefKey = ch.href.split('?')[0]; // e.g. "/@handle"
      if (hrefKey !== ch.id) {
        hrefToId[hrefKey] = ch.id;
      }
    }

    let dirty = false;
    for (const [oldKey, canonicalId] of Object.entries(hrefToId)) {
      if (assignments[oldKey] && !assignments[canonicalId]) {
        // Mover asignación al ID canónico
        assignments[canonicalId] = assignments[oldKey];
        delete assignments[oldKey];
        dirty = true;
      } else if (assignments[oldKey] && assignments[canonicalId]) {
        // Fusionar (sin duplicados) y eliminar el viejo
        const merged = [...new Set([...assignments[canonicalId], ...assignments[oldKey]])];
        assignments[canonicalId] = merged;
        delete assignments[oldKey];
        dirty = true;
      }
    }

    if (dirty) {
      await YCSM.storage.saveChannelAssignments(assignments);
      console.log('[YCSM] Asignaciones migradas al ID canónico.');
    }
  }

  /* ═══════════════════════════════════════════════════════════════
     UNIFIED CATEGORY PICKER
  ═══════════════════════════════════════════════════════════════ */

  let _activePicker = null;

  function closePicker() {
    if (_activePicker) {
      if (typeof _activePicker._cleanup === 'function') _activePicker._cleanup();
      _activePicker.remove();
      _activePicker = null;
    }
  }

  function buildCategoryPicker(opts) {
    const { categories, getAssigned, onToggle, onCreate, onClose, isBulk } = opts;

    const TICK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>`;

    const picker = document.createElement('div');
    picker.className = 'ycsm-cat-picker';

    const searchBox = document.createElement('div');
    searchBox.className = 'ycsm-picker-search';
    searchBox.innerHTML = `<span class="ycsm-picker-search-icon"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><line x1="20" y1="20" x2="16.65" y2="16.65"/></svg></span>`;
    const searchInput = document.createElement('input');
    searchInput.className = 'ycsm-picker-search-input';
    searchInput.type = 'text';
    searchInput.placeholder = 'Buscar o crear categoría…';
    searchInput.autocomplete = 'off';
    searchBox.appendChild(searchInput);
    picker.appendChild(searchBox);

    const listEl = document.createElement('div');
    listEl.className = 'ycsm-picker-list';
    picker.appendChild(listEl);

    function renderList(query) {
      listEl.innerHTML = '';
      const q = (query || '').trim();
      const qNorm = normalizeSearch(q);
      const catList = Object.values(categories).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      const assigned = getAssigned();
      const filtered = q ? catList.filter((c) => normalizeSearch(c.name).includes(qNorm)) : catList;
      const exactMatch = q && catList.some((c) => normalizeSearch(c.name) === qNorm);

      if (filtered.length === 0 && !q) {
        const empty = document.createElement('div');
        empty.className = 'ycsm-picker-empty';
        empty.textContent = 'Aún no tienes categorías';
        listEl.appendChild(empty);
      }

      filtered.forEach((cat) => {
        const isOn = assigned.includes(cat.id);
        const color = catColorFromHue(cat.hue ?? 220);
        const btn = document.createElement('button');
        btn.className = `ycsm-picker-item${isOn ? ' is-active' : ''}`;
        btn.type = 'button';
        btn.dataset.catid = cat.id;

        const dot = document.createElement('span');
        dot.className = 'ycsm-picker-dot';
        dot.style.background = color;
        btn.appendChild(dot);

        const name = document.createElement('span');
        name.className = 'ycsm-picker-name';
        name.textContent = cat.name;
        btn.appendChild(name);

        const tick = document.createElement('span');
        tick.className = 'ycsm-picker-tick';
        if (isOn) tick.innerHTML = TICK_SVG;
        btn.appendChild(tick);

        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          await onToggle(cat.id, cat.name);
          if (isBulk) {
            closePicker();
            if (onClose) onClose();
          } else {
            renderList(searchInput.value);
          }
        });
        listEl.appendChild(btn);
      });

      if (q && !exactMatch) {
        const createBtn = document.createElement('button');
        createBtn.className = 'ycsm-picker-item ycsm-picker-create';
        createBtn.type = 'button';

        const dot = document.createElement('span');
        dot.className = 'ycsm-picker-dot-create';
        dot.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`;
        createBtn.appendChild(dot);

        const name = document.createElement('span');
        name.className = 'ycsm-picker-name';
        name.textContent = `Crear "${q}"`;
        createBtn.appendChild(name);

        createBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          await onCreate(q);
          if (isBulk) {
            closePicker();
            if (onClose) onClose();
          } else {
            searchInput.value = '';
            renderList('');
          }
        });
        listEl.appendChild(createBtn);
      }
    }

    renderList('');

    searchInput.addEventListener('input', (e) => { e.stopPropagation(); renderList(e.target.value); });
    searchInput.addEventListener('click', (e) => e.stopPropagation());
    searchInput.addEventListener('keydown', async (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') { closePicker(); if (onClose) onClose(); return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); listEl.querySelector('.ycsm-picker-item')?.focus(); return; }
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const q = searchInput.value.trim();
      if (!q) return;
      const catList = Object.values(categories).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      const exact = catList.find((c) => normalizeSearch(c.name) === normalizeSearch(q));
      if (exact) {
        await onToggle(exact.id, exact.name);
        if (isBulk) { closePicker(); if (onClose) onClose(); }
        else { renderList(searchInput.value); }
      } else {
        await onCreate(q);
        if (isBulk) { closePicker(); if (onClose) onClose(); }
        else { searchInput.value = ''; renderList(''); }
      }
    });

    listEl.addEventListener('keydown', (e) => {
      e.stopPropagation();
      const items = [...listEl.querySelectorAll('.ycsm-picker-item')];
      const idx = items.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); (items[idx + 1] || items[0])?.focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); (items[idx - 1] || items[items.length - 1])?.focus(); }
      else if (e.key === 'Escape') { e.preventDefault(); closePicker(); if (onClose) onClose(); }
    });

    picker._renderList = renderList;
    return picker;
  }

  function openCategoryPicker(triggerEl, opts) {
    closePicker();

    const picker = buildCategoryPicker(opts);
    document.body.appendChild(picker);
    _activePicker = picker;

    const PICKER_W = 280;
    const GAP = 6;
    const rect = triggerEl.getBoundingClientRect();
    let left = rect.right - PICKER_W;
    if (left < 8) left = rect.left;
    if (left + PICKER_W > window.innerWidth - 8) left = window.innerWidth - PICKER_W - 8;
    if (left < 8) left = 8;

    const spaceBelow = window.innerHeight - rect.bottom - GAP;
    const spaceAbove = rect.top - GAP;
    const openBelow = spaceBelow >= 200 || spaceBelow >= spaceAbove;

    picker.style.left = left + 'px';
    picker.style.width = PICKER_W + 'px';
    if (openBelow) { picker.style.top = (rect.bottom + GAP) + 'px'; picker.style.bottom = ''; }
    else { picker.style.top = ''; picker.style.bottom = (window.innerHeight - rect.top + GAP) + 'px'; }

    setTimeout(() => picker.querySelector('.ycsm-picker-search-input')?.focus(), 0);

    function onOutsideMousedown(e) {
      if (!picker.contains(e.target) && e.target !== triggerEl && !triggerEl.contains(e.target)) {
        document.removeEventListener('mousedown', onOutsideMousedown, { capture: true });
        closePicker();
        if (opts.onClose) opts.onClose();
      }
    }
    document.addEventListener('mousedown', onOutsideMousedown, { capture: true });
    picker._cleanup = () => document.removeEventListener('mousedown', onOutsideMousedown, { capture: true });
  }

  /* ═══════════════════════════════════════════════════════════════
     CICLO DE VIDA
  ═══════════════════════════════════════════════════════════════ */

  async function createCategoryFromSidebar() {
    const sideNav = panelEl?.querySelector('#ycsm-side-cats-nav');
    if (!sideNav || sideNav.querySelector('.ycsm-side-rename-input')) return;

    const placeholder = document.createElement('div');
    placeholder.className = 'ycsm-side-item';
    const input = document.createElement('input');
    input.className = 'ycsm-side-rename-input';
    input.placeholder = 'Nueva categoría…';
    input.maxLength = 30;
    input.style.cssText = 'flex:1;margin:0 4px';
    placeholder.appendChild(input);
    sideNav.appendChild(placeholder);
    input.focus();

    let done = false;
    const commit = async () => {
      if (done) return;
      done = true;
      const n = input.value.trim();
      placeholder.remove();
      if (!n) return;
      const newCat = await YCSM.storage.addCategory(n);
      if (newCat && document.getElementById('ycsm-sidebar')) YCSM.sidebar.scheduleRender();
      await renderSidebar();
      await renderPanelContent();
    };
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter') { e.preventDefault(); await commit(); }
      if (e.key === 'Escape') { done = true; placeholder.remove(); }
    });
  }

  async function open() {
    // Si ya está abierto, solo traerlo al frente
    if (document.getElementById('ycsm-panel')) return;

    filterText = '';
    filterCat = null;
    viewMode = 'all';
    layoutMode = 'grid';
    isManaging = false;
    _dateCache.clear();
    panelEl = buildPanel();
    document.body.appendChild(panelEl);

    /* ── Close ── */
    panelEl.querySelector('.ycsm-panel-backdrop').addEventListener('click', close);
    panelEl.querySelector('.ycsm-panel-x').addEventListener('click', close);

    /* ── Search ── */
    const searchInput = panelEl.querySelector('.ycsm-new-search-input');
    const searchClear = panelEl.querySelector('.ycsm-new-search-clear');
    const searchBox   = panelEl.querySelector('#ycsm-new-search');
    searchInput.addEventListener('input', debounce((e) => {
      filterText = e.target.value;
      searchClear.hidden = !e.target.value;
      renderPanelContent();
    }, 150));
    searchInput.addEventListener('focus', () => searchBox.classList.add('ycsm-new-search-focused'));
    searchInput.addEventListener('blur',  () => searchBox.classList.remove('ycsm-new-search-focused'));
    searchClear.addEventListener('click', () => {
      searchInput.value = '';
      searchClear.hidden = true;
      filterText = '';
      searchInput.focus();
      renderPanelContent();
    });

    /* ── Sort ── */
    panelEl.querySelector('#ycsm-new-sort-select').addEventListener('change', (e) => {
      sortBy = e.target.value;
      renderPanelContent();
    });

    /* ── Layout toggle ── */
    panelEl.querySelectorAll('.ycsm-view-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        layoutMode = btn.dataset.layout;
        panelEl.querySelectorAll('.ycsm-view-btn').forEach((b) => b.classList.toggle('is-active', b === btn));
        renderPanelContent();
      });
    });

    /* ── Sidebar system nav ── */
    panelEl.querySelectorAll('#ycsm-side-system-nav .ycsm-side-item').forEach((btn) => {
      btn.addEventListener('click', () => {
        viewMode = btn.dataset.view;
        filterCat = null;
        renderSidebar();
        renderPanelContent();
      });
    });

    /* ── Sidebar edit toggle ── */
    panelEl.querySelector('#ycsm-side-edit-toggle').addEventListener('click', () => {
      isManaging = !isManaging;
      panelEl.querySelector('#ycsm-side-edit-toggle').classList.toggle('is-on', isManaging);
      renderSidebar();
    });

    /* ── Sidebar add category ── */
    panelEl.querySelector('#ycsm-side-add-cat').addEventListener('click', createCategoryFromSidebar);

    /* ── Selection bar clear ── */
    panelEl.querySelector('#ycsm-select-bar-clear').addEventListener('click', () => clearSelection());

    /* ── Bulk assign button ── */
    panelEl.querySelector('#ycsm-bulk-cat-btn').addEventListener('click', async (e) => {
      e.stopPropagation();
      const btn = e.currentTarget;
      if (_activePicker) { closePicker(); return; }
      const { categories: cats, channelAssignments: assignments } = await YCSM.storage.getAll();
      openCategoryPicker(btn, {
        categories: cats,
        getAssigned: () => [],
        onToggle: async (catId) => {
          await bulkAssignCategory(catId);
        },
        onCreate: async (name) => {
          const newCat = await YCSM.storage.addCategory(name);
          if (newCat) {
            if (document.getElementById('ycsm-sidebar')) YCSM.sidebar.scheduleRender();
            await bulkAssignCategory(newCat.id);
          }
        },
        onClose: () => {},
        isBulk: true,
      });
    });

    /* ── Global click handler (close picker on Escape) ── */
    _panelClickHandler = () => {};
    document.addEventListener('click', _panelClickHandler, { capture: true });
    document.addEventListener('keydown', handleEscape);

    panelEl.querySelector('button, input')?.focus();

    // Mostrar estado de carga mientras obtenemos canales
    const list = panelEl.querySelector('.ycsm-panel-channels');
    list.innerHTML = `<div class="ycsm-panel-empty" style="grid-column:1/-1">${escapeHtml(t('loadingChannels'))}</div>`;

    // Estrategia 1: fetch de /feed/channels → obtiene TODOS los canales sin depender del DOM
    allChannels = await fetchAllSubscriptions();

    // Estrategia 2: caché local de sesiones anteriores (no modifica el DOM de YouTube)
    if (allChannels.length === 0) {
      const { channels } = await YCSM.storage.getCachedChannels();
      allChannels = channels || [];
    }

    // Estrategia 3: DOM scraping del sidebar (último recurso — puede provocar re-renders en el guide de YouTube)
    if (allChannels.length === 0) {
      await expandYouTubeSubscriptions();
      allChannels = scrapeChannelsFromDOM();
    }

    if (allChannels.length > 0) {
      // Migrar asignaciones antiguas (IDs basados en handle/href) al channelId canónico (UCxxxxx)
      await migrateAssignmentIds(allChannels);
      YCSM.storage.cacheChannels(allChannels);
    }

    _lastSeen = await loadLastSeen();
    await renderPanelContent();

    // Fijar la altura del box tras la primera carga para evitar saltos al cambiar de vista
    const box = panelEl?.querySelector('.ycsm-panel-box');
    if (box) {
      const h = box.getBoundingClientRect().height;
      box.style.height = h + 'px';
    }
  }

  function close() {
    closePicker();
    if (panelEl) {
      panelEl.remove();
      panelEl = null;
    }
    filterText = '';
    filterCat = null;
    sortBy = 'activity';
    viewMode = 'all';
    layoutMode = 'grid';
    isManaging = false;
    selectedIds.clear();
    if (_dateObserver) { _dateObserver.disconnect(); _dateObserver = null; }
    if (_pillsOverflowObserver) { _pillsOverflowObserver.disconnect(); _pillsOverflowObserver = null; }
    if (_tooltipEl) { _tooltipEl.remove(); _tooltipEl = null; }
    document.removeEventListener('keydown', handleEscape);
    if (_panelClickHandler) {
      document.removeEventListener('click', _panelClickHandler, { capture: true });
      _panelClickHandler = null;
    }
    // Re-inyectar el sidebar si fue eliminado durante las operaciones del panel
    setTimeout(() => {
      if (window.YCSM?.sidebar && !document.getElementById('ycsm-sidebar')) {
        YCSM.sidebar.injectIntoYouTube();
      }
    }, 200);
  }

  function handleEscape(e) {
    if (e.key === 'Escape') close();
  }

  /* ── Export ── */
  window.YCSM.panel = {
    open,
    close,
    scrapeChannelsFromDOM,
    renderPanelContent,
  };
})();
