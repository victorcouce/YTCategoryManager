/**
 * panel.js — Bulk Assignment Panel
 * Panel flotante para asignar canales a categorías de forma masiva.
 * Compatible como content script inyectado en YouTube.
 */
(function () {
  if (!window.YCSM) window.YCSM = {};

  let panelEl = null;
  let allChannels = [];
  let filterText = '';
  let filterCat = null;   // ID de categoría activa para filtrar, o null
  let sortBy = 'activity'; // 'activity' | 'name'
  let selectedIds = new Set(); // IDs de canales seleccionados en modo multi
  let selectionMode = false;  // true = modo multi-selección activo
  const _dateCache = new Map(); // channelId → ISO date string | null
  let _dateObserver = null;
  let _lastSeen = {};             // channelId → ISO string (cuándo visitó el canal por última vez)

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

  function sanitizeColor(color) {
    return /^#[0-9A-Fa-f]{3,8}$/.test(color) ? color : '#4285F4';
  }

  function buildPanel() {
    const overlay = document.createElement('div');
    overlay.id = 'ycsm-panel';
    overlay.className = 'ycsm-panel-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Organizar suscripciones de YouTube');

    overlay.innerHTML = `
      <div class="ycsm-panel-backdrop" aria-hidden="true"></div>
      <div class="ycsm-panel-box">
        <div class="ycsm-panel-head">
          <h2>📂 Organizar Suscripciones</h2>
          <button class="ycsm-btn-select" id="ycsm-btn-select" aria-pressed="false" title="Activar selección múltiple">☐ Seleccionar</button>
          <button class="ycsm-btn-icon ycsm-panel-x" aria-label="Cerrar panel">✕</button>
        </div>
        <div class="ycsm-panel-body">
          <div class="ycsm-panel-toolbar">
            <input
              class="ycsm-panel-search"
              type="search"
              placeholder="🔍 Buscar canal…"
              aria-label="Buscar canal por nombre"
              autocomplete="off"
            >
            <select class="ycsm-panel-sort" aria-label="Ordenar canales">
              <option value="activity">🕐 Recientes</option>
              <option value="name">A → Z</option>
            </select>
          </div>
          <div class="ycsm-panel-legend" aria-label="Categorías disponibles">
          </div>
          <div class="ycsm-legend-form" id="ycsm-legend-form" hidden>
            <input class="ycsm-legend-form-name" id="ycsm-legend-form-name" type="text" placeholder="Nombre de la etiqueta…" maxlength="30" autocomplete="off">
            <input class="ycsm-legend-form-emoji" id="ycsm-legend-form-emoji" type="text" placeholder="🏷️" maxlength="4" autocomplete="off">
            <input class="ycsm-legend-form-color" id="ycsm-legend-form-color" type="color" value="#4285F4">
            <button class="ycsm-legend-form-save" id="ycsm-legend-form-save">✓</button>
            <button class="ycsm-legend-form-cancel" id="ycsm-legend-form-cancel">✕</button>
          </div>
          <div class="ycsm-panel-channels" role="list" aria-label="Lista de canales suscritos"></div>
        </div>
        <div class="ycsm-panel-bulk" id="ycsm-panel-bulk" hidden>
          <span class="ycsm-bulk-count" id="ycsm-bulk-count">0 seleccionados</span>
          <div class="ycsm-bulk-actions">
            <div class="ycsm-bulk-cat-wrap">
              <button class="ycsm-bulk-cat-btn" id="ycsm-bulk-cat-btn">🏷️ Asignar categoría</button>
              <div class="ycsm-bulk-cat-menu" id="ycsm-bulk-cat-menu" hidden></div>
            </div>

          </div>
        </div>
        <div class="ycsm-panel-foot">
          <span class="ycsm-panel-count" aria-live="polite"></span>
          <button class="ycsm-panel-close-btn">Cerrar</button>
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
    const bar = panelEl.querySelector('#ycsm-panel-bulk');
    const countEl = panelEl.querySelector('#ycsm-bulk-count');
    const n = selectedIds.size;
    bar.hidden = !selectionMode;
    countEl.textContent = `${n} canal${n !== 1 ? 'es' : ''} seleccionado${n !== 1 ? 's' : ''}`;
    panelEl.querySelector('#ycsm-bulk-cat-btn').disabled = n === 0;
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

  function enterSelectionMode() {
    selectionMode = true;
    selectedIds.clear();
    const btn = panelEl.querySelector('#ycsm-btn-select');
    btn.textContent = '☒ Cancelar';
    btn.setAttribute('aria-pressed', 'true');
    panelEl.querySelector('.ycsm-panel-box').classList.add('ycsm-selection-active');
    // Añadir clase a todas las tarjetas para mostrar checkbox
    panelEl.querySelectorAll('.ycsm-panel-card').forEach((c) =>
      c.classList.add('ycsm-card-selectable')
    );
    updateBulkBar();
  }

  function exitSelectionMode() {
    selectionMode = false;
    selectedIds.clear();
    if (!panelEl) return;
    const btn = panelEl.querySelector('#ycsm-btn-select');
    if (btn) {
      btn.textContent = '☐ Seleccionar';
      btn.setAttribute('aria-pressed', 'false');
    }
    panelEl.querySelector('.ycsm-panel-box')?.classList.remove('ycsm-selection-active');
    panelEl.querySelectorAll('.ycsm-panel-card').forEach((c) => {
      c.classList.remove('ycsm-card-selectable', 'ycsm-card-selected');
    });
    updateBulkBar();
  }

  async function bulkAssignCategory(categoryId) {
    if (selectedIds.size === 0) return;
    const ids = [...selectedIds];
    for (const chId of ids) {
      await YCSM.storage.assignChannel(chId, categoryId);
    }
    if (document.getElementById('ycsm-sidebar')) YCSM.sidebar.scheduleRender();
    exitSelectionMode();
    await renderPanelContent();
  }

  /* ═══════════════════════════════════════════════════════════════
     FECHAS DEL ÚLTIMO VÍDEO (carga perezosa vía RSS de YouTube)
  ═══════════════════════════════════════════════════════════════ */

  function formatRelativeDate(isoStr) {
    if (!isoStr) return '';
    const date = new Date(isoStr);
    if (isNaN(date.getTime())) return '';
    const diffDays = Math.floor((Date.now() - date.getTime()) / 86400000);
    if (diffDays === 0) return 'hoy';
    if (diffDays === 1) return 'ayer';
    if (diffDays < 7) return `hace ${diffDays} días`;
    const w = Math.floor(diffDays / 7);
    if (w < 5) return `hace ${w} semana${w > 1 ? 's' : ''}`;
    const m = Math.floor(diffDays / 30);
    if (m < 12) return `hace ${m} mes${m > 1 ? 'es' : ''}`;
    const y = Math.floor(diffDays / 365);
    return `hace ${y} año${y > 1 ? 's' : ''}`;
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
      chrome.storage.local.get('channelLastSeen', (r) => resolve(r.channelLastSeen || {}));
    });
  }

  function markChannelSeen(channelId) {
    _lastSeen[channelId] = new Date().toISOString();
    chrome.storage.local.set({ channelLastSeen: _lastSeen });
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
     RENDER DEL CONTENIDO
  ═══════════════════════════════════════════════════════════════ */

  async function renderPanelContent() {
    if (!panelEl) return;

    const { categories, channelAssignments } = await YCSM.storage.getAll();
    const sortedCats = Object.values(categories).sort((a, b) => a.order - b.order);

    /* ── Leyenda ── */
    const legend = panelEl.querySelector('.ycsm-panel-legend');
    legend.innerHTML = '';
    if (sortedCats.length === 0) {
      legend.innerHTML =
        '<p style="font-size:13px;color:#606060;margin:0">Sin categorías. Créalas desde el sidebar o el popup.</p>';
    } else {
      // Pill "Todos"
      const allPill = document.createElement('button');
      allPill.className = 'ycsm-legend-pill ycsm-legend-all' + (filterCat === null ? ' ycsm-legend-pill-active' : '');
      allPill.textContent = 'Todos';
      allPill.addEventListener('click', () => { filterCat = null; renderPanelContent(); });
      legend.appendChild(allPill);

      sortedCats.forEach((cat) => {
        const pill = document.createElement('span');
        pill.className = 'ycsm-legend-pill' + (filterCat === cat.id ? ' ycsm-legend-pill-active' : '');
        if (filterCat === cat.id) pill.style.setProperty('--ycsm-pill-active-color', sanitizeColor(cat.color));

        const label = document.createElement('button');
        label.className = 'ycsm-legend-pill-label';
        label.textContent = (cat.emoji ? cat.emoji + ' ' : '') + cat.name;
        label.addEventListener('click', () => {
          filterCat = filterCat === cat.id ? null : cat.id;
          renderPanelContent();
        });

        const delBtn = document.createElement('button');
        delBtn.className = 'ycsm-legend-pill-del';
        delBtn.textContent = '×';
        delBtn.title = `Eliminar "${cat.name}"`;
        delBtn.setAttribute('aria-label', `Eliminar categoría ${cat.name}`);
        delBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          if (!window.confirm(`¿Eliminar la etiqueta "${cat.name}"?\nSe quitará de todos los canales asignados.`)) return;
          if (filterCat === cat.id) filterCat = null;
          await YCSM.storage.deleteCategory(cat.id);
          if (document.getElementById('ycsm-sidebar')) YCSM.sidebar.scheduleRender();
          await renderPanelContent();
        });

        pill.appendChild(label);
        pill.appendChild(delBtn);
        legend.appendChild(pill);
      });

      // Botón añadir etiqueta
      const addCatBtn = document.createElement('button');
      addCatBtn.className = 'ycsm-legend-add-btn';
      addCatBtn.textContent = '+ Nueva etiqueta';
      addCatBtn.addEventListener('click', () => {
        const form = panelEl.querySelector('#ycsm-legend-form');
        form.hidden = !form.hidden;
        if (!form.hidden) panelEl.querySelector('#ycsm-legend-form-name').focus();
      });
      legend.appendChild(addCatBtn);
    }

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
        list.innerHTML = '<div class="ycsm-panel-empty" style="grid-column:1/-1">⏳ Cargando fechas para ordenar…</div>';
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

    /* ── Filtrado ── */
    const visible = sorted.filter((ch) => {
      const matchText = !filterText || ch.name.toLowerCase().includes(filterText.toLowerCase());
      const matchCat  = !filterCat  || (channelAssignments[ch.id] || []).includes(filterCat);
      return matchText && matchCat;
    });

    const countEl = panelEl.querySelector('.ycsm-panel-count');
    countEl.textContent = `${visible.length} canal${visible.length !== 1 ? 'es' : ''}`;

    /* ── Menú de categorías para asignación masiva ── */
    const catMenu = panelEl.querySelector('#ycsm-bulk-cat-menu');
    catMenu.innerHTML = '';
    sortedCats.forEach((cat) => {
      const color = sanitizeColor(cat.color);
      const item = document.createElement('button');
      item.className = 'ycsm-bulk-cat-item';
      item.style.setProperty('--ycsm-pill-color', color);
      item.textContent = (cat.emoji ? cat.emoji + ' ' : '') + cat.name;
      item.addEventListener('click', () => {
        catMenu.hidden = true;
        bulkAssignCategory(cat.id);
      });
      catMenu.appendChild(item);
    });

    /* ── Lista de canales ── */
    const list = panelEl.querySelector('.ycsm-panel-channels');
    list.innerHTML = '';

    if (visible.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'ycsm-panel-empty';
      empty.textContent = filterText || filterCat
        ? 'No se encontraron canales con ese filtro.'
        : 'No se detectaron suscripciones. Despliega el menú de suscripciones en YouTube y vuelve a abrir este panel.';
      list.appendChild(empty);
      return;
    }

    visible.forEach((channel) => {
      const assigned = channelAssignments[channel.id] || [];
      const card = document.createElement('div');
      card.className = 'ycsm-panel-card' +
        (selectionMode ? ' ycsm-card-selectable' : '') +
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
          <div class="ycsm-card-check" aria-hidden="true">✓</div>
          ${avatarHtml}
          ${isNew ? '<span class="ycsm-card-new-dot" aria-label="Nuevos vídeos sin ver"></span>' : ''}
        </div>
        <span class="ycsm-card-name" title="${escapeHtml(channel.name)}">${escapeHtml(channel.name)}</span>
        <span class="ycsm-card-date" data-cid="${escapeHtml(channel.id)}" title="Último vídeo publicado">${_dateCache.get(channel.id) ? '🎥 ' + escapeHtml(formatRelativeDate(_dateCache.get(channel.id))) : ''}</span>
        <div class="ycsm-card-cats" role="group" aria-label="Categorías de ${escapeHtml(channel.name)}"></div>
      `;

      // Click en modo selección → seleccionar tarjeta; fuera → abrir canal
      card.addEventListener('click', (e) => {
        if (e.target.closest('.ycsm-assign-pill, .ycsm-card-check')) return;
        if (selectionMode) {
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

      // Solo mostrar las categorías ya asignadas al canal
      const assignedCats = sortedCats.filter((cat) => assigned.includes(cat.id));

      if (assignedCats.length === 0) {
        catsContainer.innerHTML = '';
      } else {
        assignedCats.forEach((cat) => {
          const color = sanitizeColor(cat.color);
          const pill = document.createElement('button');
          pill.className = 'ycsm-assign-pill ycsm-pill-on';
          pill.style.setProperty('--ycsm-pill-color', color);
          pill.title = `Quitar de "${cat.name}"`;
          pill.setAttribute('aria-pressed', 'true');
          pill.textContent = (cat.emoji ? cat.emoji + ' ' : '') + cat.name;

          pill.addEventListener('click', async (e) => {
            if (selectionMode) { e.stopPropagation(); return; }
            await YCSM.storage.toggleChannelCategory(channel.id, cat.id);
            if (document.getElementById('ycsm-sidebar')) YCSM.sidebar.scheduleRender();
            await renderPanelContent();
          });

          catsContainer.appendChild(pill);
        });
      }

      // Botón "+" para asignar a más categorías
      if (sortedCats.length > 0) {
        const addBtn = document.createElement('button');
        addBtn.className = 'ycsm-card-add-cat';
        addBtn.title = 'Asignar categoría';
        addBtn.setAttribute('aria-label', `Asignar categoría a ${channel.name}`);
        addBtn.textContent = '+';

        const addMenu = document.createElement('div');
        addMenu.className = 'ycsm-card-add-menu';
        addMenu.hidden = true;

        sortedCats.filter((cat) => !assigned.includes(cat.id)).forEach((cat) => {
          const color = sanitizeColor(cat.color);
          const item = document.createElement('button');
          item.className = 'ycsm-bulk-cat-item';
          item.style.setProperty('--ycsm-pill-color', color);
          item.textContent = (cat.emoji ? cat.emoji + ' ' : '') + cat.name;
          item.addEventListener('click', async (e) => {
            e.stopPropagation();
            addMenu.hidden = true;
            await YCSM.storage.assignChannel(channel.id, cat.id);
            if (document.getElementById('ycsm-sidebar')) YCSM.sidebar.scheduleRender();
            await renderPanelContent();
          });
          addMenu.appendChild(item);
        });

        addBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (selectionMode) return;
          // Cerrar otros menús abiertos
          panelEl.querySelectorAll('.ycsm-card-add-menu:not([hidden])').forEach((m) => { if (m !== addMenu) m.hidden = true; });
          addMenu.hidden = !addMenu.hidden;
        });

        catsContainer.appendChild(addBtn);
        catsContainer.appendChild(addMenu);
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
            span.textContent = iso ? '\uD83C\uDFA5 ' + formatRelativeDate(iso) : '';
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
     CICLO DE VIDA
  ═══════════════════════════════════════════════════════════════ */

  async function open() {
    // Si ya está abierto, solo traerlo al frente
    if (document.getElementById('ycsm-panel')) return;

    filterText = '';
    filterCat = null;
    _dateCache.clear(); // Limpiar caché de fechas para obtener datos frescos
    panelEl = buildPanel();
    document.body.appendChild(panelEl);

    /* ── Eventos ── */
    panelEl.querySelector('.ycsm-panel-backdrop').addEventListener('click', close);
    panelEl.querySelector('.ycsm-panel-x').addEventListener('click', close);
    panelEl.querySelector('.ycsm-panel-close-btn').addEventListener('click', close);

    // Formulario de nueva etiqueta
    panelEl.querySelector('#ycsm-legend-form-save').addEventListener('click', async () => {
      const nameEl = panelEl.querySelector('#ycsm-legend-form-name');
      const name = nameEl.value.trim();
      if (!name) { nameEl.focus(); return; }
      const color = panelEl.querySelector('#ycsm-legend-form-color').value;
      const emoji = panelEl.querySelector('#ycsm-legend-form-emoji').value.trim();
      await YCSM.storage.addCategory(name, color, emoji);
      panelEl.querySelector('#ycsm-legend-form').hidden = true;
      nameEl.value = '';
      panelEl.querySelector('#ycsm-legend-form-emoji').value = '';
      panelEl.querySelector('#ycsm-legend-form-color').value = '#4285F4';
      if (document.getElementById('ycsm-sidebar')) YCSM.sidebar.scheduleRender();
      await renderPanelContent();
    });
    panelEl.querySelector('#ycsm-legend-form-cancel').addEventListener('click', () => {
      panelEl.querySelector('#ycsm-legend-form').hidden = true;
    });
    panelEl.querySelector('#ycsm-legend-form-name').addEventListener('keydown', async (e) => {
      if (e.key === 'Enter') panelEl.querySelector('#ycsm-legend-form-save').click();
      if (e.key === 'Escape') panelEl.querySelector('#ycsm-legend-form-cancel').click();
    });

    panelEl.querySelector('.ycsm-panel-search').addEventListener('input', (e) => {
      filterText = e.target.value;
      renderPanelContent();
    });

    const sortSelect = panelEl.querySelector('.ycsm-panel-sort');
    sortSelect.value = sortBy;
    sortSelect.addEventListener('change', (e) => {
      sortBy = e.target.value;
      renderPanelContent();
    });

    // Botón de modo selección
    panelEl.querySelector('#ycsm-btn-select').addEventListener('click', () => {
      if (selectionMode) exitSelectionMode();
      else enterSelectionMode();
    });

    // Asignación masiva: toggle menú de categorías
    panelEl.querySelector('#ycsm-bulk-cat-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      const menu = panelEl.querySelector('#ycsm-bulk-cat-menu');
      menu.hidden = !menu.hidden;
    });
    // Cerrar menú si se hace click fuera
    document.addEventListener('click', () => {
      const menu = panelEl?.querySelector('#ycsm-bulk-cat-menu');
      if (menu) menu.hidden = true;
    }, { capture: true });

    document.addEventListener('keydown', handleEscape);

    // Trampa de foco accesible: primer elemento enfocable
    panelEl.querySelector('button, input')?.focus();

    // Mostrar estado de carga mientras obtenemos canales
    const list = panelEl.querySelector('.ycsm-panel-channels');
    list.innerHTML = '<div class="ycsm-panel-empty" style="grid-column:1/-1">⏳ Cargando canales…</div>';

    // Estrategia 1: fetch de /feed/channels → obtiene TODOS los canales sin depender del DOM
    allChannels = await fetchAllSubscriptions();

    // Estrategia 2: DOM scraping del sidebar (fallback)
    if (allChannels.length === 0) {
      await expandYouTubeSubscriptions();
      allChannels = scrapeChannelsFromDOM();
    }

    // Estrategia 3: caché local de sesiones anteriores
    if (allChannels.length === 0) {
      const { channels } = await YCSM.storage.getCachedChannels();
      allChannels = channels || [];
    }

    if (allChannels.length > 0) {
      // Migrar asignaciones antiguas (IDs basados en handle/href) al channelId canónico (UCxxxxx)
      await migrateAssignmentIds(allChannels);
      YCSM.storage.cacheChannels(allChannels);
    }

    _lastSeen = await loadLastSeen();
    await renderPanelContent();
  }

  function close() {
    if (panelEl) {
      panelEl.remove();
      panelEl = null;
    }
    filterText = '';
    filterCat = null;
    sortBy = 'activity';
    selectionMode = false;
    selectedIds.clear();
    if (_dateObserver) { _dateObserver.disconnect(); _dateObserver = null; }
    document.removeEventListener('keydown', handleEscape);
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
