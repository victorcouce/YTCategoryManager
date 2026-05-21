/**
 * sidebar.js — Componente de categorías inyectado en el sidebar de YouTube.
 * Prefijo CSS: ycsm-  (YouTube Category Subscription Manager)
 */
(function () {
  if (!window.YCSM) window.YCSM = {};

  let sidebarRoot = null;

  const { t } = YCSM.i18n;

  /* ═══════════════════════════════════════════════════════════════
     UTILIDADES
  ═══════════════════════════════════════════════════════════════ */

  function escapeHtml(value) {
    const div = document.createElement('div');
    div.appendChild(document.createTextNode(String(value ?? '')));
    return div.innerHTML;
  }

  function hashHue(value) {
    let n = 0;
    const s = String(value || '');
    for (let i = 0; i < s.length; i++) n = (n * 31 + s.charCodeAt(i)) | 0;
    return Math.abs(n) % 360;
  }

  function categoryColor(category) {
    const hue = typeof category.color === 'number'
      ? category.color
      : (typeof category.hue === 'number' ? category.hue : hashHue(category.id || category.name));
    return `oklch(0.72 0.16 ${hue})`;
  }


  /* ═══════════════════════════════════════════════════════════════
     SCRAPING DEL DOM DE YOUTUBE
  ═══════════════════════════════════════════════════════════════ */

  function getChannelsFromDOM() {
    const channels = [];
    const seen = new Set();

    const entries = document.querySelectorAll('ytd-guide-entry-renderer');
    entries.forEach((entry) => {
      const link = entry.querySelector('a');
      if (!link) return;

      const href = link.getAttribute('href') || '';
      if (
        !href.startsWith('/channel/') &&
        !href.startsWith('/@') &&
        !href.startsWith('/c/')
      )
        return;

      // ID canónico: UCxxxxx para /channel/, o el handle para /@...
      const channelId = href.startsWith('/channel/')
        ? href.replace('/channel/', '').split('?')[0]
        : href.split('?')[0];

      if (!channelId || seen.has(channelId)) return;
      seen.add(channelId);

      const nameEl = entry.querySelector(
        'yt-formatted-string, #endpoint yt-formatted-string, #label'
      );
      const name =
        nameEl?.textContent?.trim() ||
        link.getAttribute('title') ||
        channelId;

      const imgEl = entry.querySelector('img#img, yt-img-shadow img, img');
      const avatar = imgEl?.src || '';

      // Detectar el punto azul de "nuevo vídeo" que YouTube pone en el sidebar
      const badgeEl = entry.querySelector(
        '#badge ytd-badge-supported-renderer:not([hidden]), ' +
        'ytd-badge-supported-renderer.ytd-guide-entry-renderer:not([hidden]), ' +
        '.badge-style-type-unread:not([hidden])'
      );
      const _unseen = !!badgeEl;

      channels.push({ id: channelId, name, avatar, href, _unseen });
    });

    return channels;
  }

  /* ═══════════════════════════════════════════════════════════════
     ELEMENTOS DEL SIDEBAR
  ═══════════════════════════════════════════════════════════════ */

  function createCategoryElement(category, channels, assignments) {
    const assigned = channels.filter((ch) =>
      (assignments[ch.id] || []).includes(category.id)
    );

    const label = category.name;

    const el = document.createElement('a');
    el.className = 'ycsm-cat-entry';
    el.href = '/feed/subscriptions';
    el.dataset.categoryId = category.id;
    el.setAttribute('role', 'option');
    el.setAttribute('aria-label', label);
    el.setAttribute('draggable', 'false');

    el.innerHTML = `
      <span class="ycsm-cat-entry-dot" style="background:${escapeHtml(categoryColor(category))}"></span>
      <span class="ycsm-cat-entry-label">
        <span class="ycsm-cat-entry-name">${escapeHtml(label)}</span>
      </span>
      <span class="ycsm-cat-entry-count">${assigned.length}</span>
    `;

    // Navegar a suscripciones con este filtro activo
    el.addEventListener('click', (e) => {
      if (e.target.closest('.ycsm-cat-entry-actions')) return;
      e.preventDefault();
      // Guardar el filtro deseado para que subscriptions-filter lo lea al inyectarse
      sessionStorage.setItem('ycsm_pending_filter', category.id);
      if (location.pathname === '/feed/subscriptions') {
        YCSM.subscriptionsFilter?.activateFilter(category.id);
      } else {
        location.href = '/feed/subscriptions';
      }
    });

    return el;
  }

  function createChannelItem(channel, categoryIds, allCategories) {
    const el = document.createElement('a');
    el.className = 'ycsm-channel-item';
    el.href = channel.href;

    // Tooltip con categorías múltiples
    const catNames = categoryIds
      .map((id) => allCategories[id]?.name)
      .filter(Boolean);
    if (catNames.length > 1) {
      el.title = `${channel.name}\n${t('categories')}: ${catNames.join(', ')}`;
    } else {
      el.title = channel.name;
    }

    const avatarHtml = channel.avatar
      ? `<img class="ycsm-avatar" src="${escapeHtml(channel.avatar)}" alt="" loading="lazy">`
      : `<div class="ycsm-avatar ycsm-avatar-placeholder">${escapeHtml(channel.name.charAt(0).toUpperCase())}</div>`;

    el.innerHTML = `
      ${avatarHtml}
      <span class="ycsm-channel-name">${escapeHtml(channel.name)}</span>
      ${categoryIds.length > 1 ? `<span class="ycsm-multicat" aria-label="${escapeHtml(t('inMultipleCategories'))}">◈</span>` : ''}
    `;

    // Botón contextual al hacer hover
    el.addEventListener('mouseenter', () => {
      if (el.querySelector('.ycsm-ctx-btn')) return;
      const btn = document.createElement('button');
      btn.className = 'ycsm-btn-icon ycsm-ctx-btn';
      btn.title = t('manageCategories');
      btn.setAttribute('aria-label', t('manageChannelCategories'));
      btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>';
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        showContextMenu(channel, btn, categoryIds);
      });
      el.appendChild(btn);
    });

    el.addEventListener('mouseleave', (e) => {
      if (!e.relatedTarget?.closest('.ycsm-channel-item')) {
        el.querySelector('.ycsm-ctx-btn')?.remove();
      }
    });

    return el;
  }

  /* ═══════════════════════════════════════════════════════════════
     ACCIONES INTERACTIVAS
  ═══════════════════════════════════════════════════════════════ */

  async function toggleCollapse(categoryId, catEl, contentEl, headerEl) {
    const categories = await YCSM.storage.getCategories();
    const cat = categories[categoryId];
    if (!cat) return;

    const collapsed = !cat.collapsed;
    await YCSM.storage.updateCategory(categoryId, { collapsed });

    contentEl.classList.toggle('ycsm-collapsed', collapsed);
    headerEl.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    const chevron = catEl.querySelector('.ycsm-cat-chevron');
    if (chevron) chevron.textContent = collapsed ? '▶' : '▼';
  }

  function startInlineRename(categoryId, nameEl, currentName) {
    const input = document.createElement('input');
    input.className = 'ycsm-rename-input';
    input.value = currentName;
    input.maxLength = 50;
    input.setAttribute('aria-label', t('newCategoryName'));

    const originalText = nameEl.textContent;
    nameEl.textContent = '';
    nameEl.appendChild(input);
    input.focus();
    input.select();

    let saved = false;

    async function commit() {
      if (saved) return;
      saved = true;
      const newName = input.value.trim();
      if (newName && newName !== currentName) {
        await YCSM.storage.updateCategory(categoryId, { name: newName });
        nameEl.textContent = newName;
      } else {
        nameEl.textContent = originalText;
      }
    }

    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        input.blur();
      }
      if (e.key === 'Escape') {
        saved = true;
        nameEl.textContent = originalText;
      }
    });
  }

  async function promptDelete(categoryId, categoryName) {
    if (
      confirm(
        t('deleteCategoryConfirmLong', [categoryName])
      )
    ) {
      await YCSM.storage.deleteCategory(categoryId);
      await renderSidebar();
    }
  }

  async function showContextMenu(channel, anchor, currentCategoryIds) {
    // Cierra cualquier menú abierto
    document.querySelectorAll('.ycsm-ctx-menu').forEach((m) => m.remove());

    const categories = await YCSM.storage.getCategories();
    const sorted = Object.values(categories).sort((a, b) => a.order - b.order);

    if (sorted.length === 0) return;

    const menu = document.createElement('div');
    menu.className = 'ycsm-ctx-menu';
    menu.setAttribute('role', 'menu');

    sorted.forEach((cat) => {
      const isAssigned = currentCategoryIds.includes(cat.id);
      const item = document.createElement('label');
      item.className = 'ycsm-ctx-menu-item';
      item.setAttribute('role', 'menuitemcheckbox');
      item.setAttribute('aria-checked', isAssigned ? 'true' : 'false');
      item.innerHTML = `
        <input type="checkbox" ${isAssigned ? 'checked' : ''} aria-hidden="true">
        <span>${escapeHtml(cat.name)}</span>
      `;

      const checkbox = item.querySelector('input');
      checkbox.addEventListener('change', async () => {
        await YCSM.storage.toggleChannelCategory(channel.id, cat.id);
        await renderSidebar();
        // Actualiza el aria-checked
        item.setAttribute('aria-checked', checkbox.checked ? 'true' : 'false');
      });

      menu.appendChild(item);
    });

    // Posicionamiento
    const rect = anchor.getBoundingClientRect();
    menu.style.cssText = `
      position:fixed;
      top:${rect.bottom + 4}px;
      left:${rect.left}px;
      z-index:99999;
    `;

    document.body.appendChild(menu);

    // Cierra al hacer clic fuera
    const closeMenu = (e) => {
      if (!menu.contains(e.target)) {
        menu.remove();
        document.removeEventListener('click', closeMenu, true);
      }
    };
    setTimeout(() => document.addEventListener('click', closeMenu, true), 0);
  }

  /* ═══════════════════════════════════════════════════════════════
     RENDER PRINCIPAL
  ═══════════════════════════════════════════════════════════════ */

  // Debounce: evita re-renders en ráfaga cuando el panel actualiza varias
  // asignaciones seguidas. 120ms es imperceptible para el usuario.
  let _renderTimer = null;
  function scheduleRender() {
    clearTimeout(_renderTimer);
    _renderTimer = setTimeout(renderSidebar, 120);
  }

  async function renderSidebar() {
    if (!sidebarRoot) return;

    const [{ categories, channelAssignments }, { channels: cachedChannels }] = await Promise.all([
      YCSM.storage.getAll(),
      YCSM.storage.getCachedChannels(),
    ]);

    // Construir mapa de canales: primero los cacheados (panel), luego enriquecer
    // con los del DOM si YouTube ya los tiene renderizados (avatar fresco, etc.)
    const channelMap = {};
    for (const ch of (cachedChannels || [])) {
      channelMap[ch.id] = ch;
    }
    for (const ch of getChannelsFromDOM()) {
      // El DOM tiene el avatar más reciente; actualizar o añadir
      channelMap[ch.id] = { ...channelMap[ch.id], ...ch };
    }

    // Si no hay canales en caché ni en DOM, generar entradas mínimas a partir
    // de las asignaciones guardadas para que las categorías no aparezcan vacías.
    if (Object.keys(channelMap).length === 0) {
      const allAssigned = new Set(Object.keys(channelAssignments));
      allAssigned.forEach((id) => {
        channelMap[id] = { id, name: id, avatar: '', href: `https://www.youtube.com/channel/${id}` };
      });
    }

    const channels = Object.values(channelMap);
    const sorted = Object.values(categories).sort((a, b) => a.order - b.order);

    const list = sidebarRoot.querySelector('.ycsm-categories-list');
    if (!list) return;
    list.innerHTML = '';

    if (sorted.length === 0) {
      list.innerHTML =
        `<div class="ycsm-empty-cat" style="padding:10px 14px">${escapeHtml(t('emptyCategoriesSidebar'))}</div>`;
      return;
    }

    sorted.forEach((cat) => {
      const el = createCategoryElement(cat, channels, channelAssignments);
      list.appendChild(el);
    });
  }
  /* ═══════════════════════════════════════════════════════════════
     CONSTRUCCIÓN DEL SIDEBAR
  ═══════════════════════════════════════════════════════════════ */

  function buildSidebarRoot() {
    const root = document.createElement('div');
    root.id = 'ycsm-sidebar';
    root.setAttribute('role', 'navigation');
    root.setAttribute('aria-label', t('myYoutubeCategories'));
    root.innerHTML = `
      <div class="ycsm-sidebar-header">
        <h3 class="ycsm-sidebar-title">${escapeHtml(t('myCategories'))}</h3>
        <div class="ycsm-sidebar-header-actions">
          <button class="ycsm-hdr-btn" id="ycsm-btn-organize" title="${escapeHtml(t('organizeSubscriptions'))}" aria-label="${escapeHtml(t('organizeSubscriptions'))}">
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" focusable="false" aria-hidden="true" style="pointer-events:none"><path d="M12.844 1h-1.687a2 2 0 00-1.962 1.616 3 3 0 01-3.92 2.263 2 2 0 00-2.38.891l-.842 1.46a2 2 0 00.417 2.507 3 3 0 010 4.525 2 2 0 00-.417 2.507l.843 1.46a2 2 0 002.38.892 3.001 3.001 0 013.918 2.263A2 2 0 0011.157 23h1.686a2 2 0 001.963-1.615 3.002 3.002 0 013.92-2.263 2 2 0 002.38-.892l.842-1.46a2 2 0 00-.418-2.507 3 3 0 010-4.526 2 2 0 00.418-2.508l-.843-1.46a2 2 0 00-2.38-.891 3 3 0 01-3.919-2.263A2 2 0 0012.844 1Zm-1.767 2.347a6 6 0 00.08-.347h1.687a4.98 4.98 0 002.407 3.37 4.98 4.98 0 004.122.4l.843 1.46A4.98 4.98 0 0018.5 12a4.98 4.98 0 001.716 3.77l-.843 1.46a4.98 4.98 0 00-4.123.4A4.979 4.979 0 0012.843 21h-1.686a4.98 4.98 0 00-2.408-3.371 4.999 4.999 0 00-4.12-.399l-.844-1.46A4.979 4.979 0 005.5 12a4.98 4.98 0 00-1.715-3.77l.842-1.459a4.98 4.98 0 004.123-.399 4.981 4.981 0 002.327-3.025ZM16 12a4 4 0 11-7.999 0 4 4 0 018 0Zm-4 2a2 2 0 100-4 2 2 0 000 4Z" fill="currentColor"></path></svg>
          </button>
        </div>
      </div>
      <div class="ycsm-categories-list" role="listbox" aria-label="${escapeHtml(t('categories'))}"></div>
    `;
    return root;
  }

  function attachSidebarEvents(root) {
    root.querySelector('#ycsm-btn-organize').addEventListener('click', () => {
      YCSM.panel.open();
    });
  }

  /* ═══════════════════════════════════════════════════════════════
     INYECCIÓN EN YOUTUBE
  ═══════════════════════════════════════════════════════════════ */

  async function injectIntoYouTube() {
    // Evitar doble inyección
    if (document.getElementById('ycsm-sidebar')) return true;

    const guideContent = document.querySelector(
      '#guide-content, ytd-guide-renderer #sections'
    );
    if (!guideContent) return false;

    const root = buildSidebarRoot();
    sidebarRoot = root;

    // Insertar justo después de la primera sección (Inicio / Shorts)
    // para quedar pegado a Suscripciones. Si las secciones aún no están en el DOM,
    // reintentar hasta que aparezcan.
    const sections = [...guideContent.querySelectorAll('ytd-guide-section-renderer')];

    if (sections.length === 0) {
      // Secciones aún no renderizadas, reintentar
      sidebarRoot = null;
      setTimeout(() => injectIntoYouTube(), 500);
      return false;
    }

    sections[0].insertAdjacentElement('afterend', root);

    attachSidebarEvents(root);
    await renderSidebar();
    return true;
  }

  /* ── Export ── */
  window.YCSM.sidebar = {
    injectIntoYouTube,
    renderSidebar,
    scheduleRender,
    getChannelsFromDOM,
  };
})();
