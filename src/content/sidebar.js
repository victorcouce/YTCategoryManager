/**
 * sidebar.js — Componente de categorías inyectado en el sidebar de YouTube.
 * Prefijo CSS: ycsm-  (YouTube Category Subscription Manager)
 */
(function () {
  if (!window.YCSM) window.YCSM = {};

  let sidebarRoot = null;

  /* ═══════════════════════════════════════════════════════════════
     UTILIDADES
  ═══════════════════════════════════════════════════════════════ */

  function escapeHtml(value) {
    const div = document.createElement('div');
    div.appendChild(document.createTextNode(String(value ?? '')));
    return div.innerHTML;
  }

  function sanitizeColor(color) {
    // Solo permitir colores hexadecimales válidos
    return /^#[0-9A-Fa-f]{3,8}$/.test(color) ? color : '#4285F4';
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

      channels.push({ id: channelId, name, avatar, href, _unseen, _domIndex: channels.length });
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
    // Ordenar por posición en el sidebar de YouTube (índice más bajo = vídeo más reciente).
    // Los canales sin índice DOM (solo en caché) van al final.
    const sortedByRecent = assigned
      .slice()
      .sort((a, b) => (a._domIndex ?? Infinity) - (b._domIndex ?? Infinity));
    const avatarChannels = sortedByRecent.slice(0, 3);

    const label = (category.emoji ? category.emoji + '\u00a0' : '') + category.name;

    const el = document.createElement('a');
    el.className = 'ycsm-cat-entry';
    el.href = '/feed/subscriptions';
    el.dataset.categoryId = category.id;
    el.setAttribute('role', 'option');
    el.setAttribute('aria-label', label);

    const avatarsHtml = avatarChannels.length > 0
      ? `<span class="ycsm-cat-avatars" aria-hidden="true">${
          avatarChannels.map(ch =>
            ch.avatar
              ? `<img class="ycsm-cat-avatar" src="${escapeHtml(ch.avatar)}" alt="" loading="lazy">`
              : `<span class="ycsm-cat-avatar ycsm-cat-avatar-fallback">${escapeHtml((ch.name || '?').charAt(0).toUpperCase())}</span>`
          ).join('')
        }</span>`
      : '';

    el.innerHTML = `
      ${avatarsHtml}
      <span class="ycsm-cat-entry-label">
        <span class="ycsm-cat-entry-name">${escapeHtml(label)}</span>
      </span>
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
      el.title = `${channel.name}\nCategorías: ${catNames.join(', ')}`;
    } else {
      el.title = channel.name;
    }

    const avatarHtml = channel.avatar
      ? `<img class="ycsm-avatar" src="${escapeHtml(channel.avatar)}" alt="" loading="lazy">`
      : `<div class="ycsm-avatar ycsm-avatar-placeholder">${escapeHtml(channel.name.charAt(0).toUpperCase())}</div>`;

    el.innerHTML = `
      ${avatarHtml}
      <span class="ycsm-channel-name">${escapeHtml(channel.name)}</span>
      ${categoryIds.length > 1 ? '<span class="ycsm-multicat" aria-label="En varias categorías">◈</span>' : ''}
    `;

    // Botón contextual al hacer hover
    el.addEventListener('mouseenter', () => {
      if (el.querySelector('.ycsm-ctx-btn')) return;
      const btn = document.createElement('button');
      btn.className = 'ycsm-btn-icon ycsm-ctx-btn';
      btn.title = 'Gestionar categorías';
      btn.setAttribute('aria-label', 'Gestionar categorías del canal');
      btn.textContent = '🏷️';
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
    input.setAttribute('aria-label', 'Nuevo nombre de categoría');

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
        `¿Eliminar la categoría "${categoryName}"?\nLos canales no se perderán, solo se desasignarán.`
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
      const color = sanitizeColor(cat.color);
      const isAssigned = currentCategoryIds.includes(cat.id);
      const item = document.createElement('label');
      item.className = 'ycsm-ctx-menu-item';
      item.setAttribute('role', 'menuitemcheckbox');
      item.setAttribute('aria-checked', isAssigned ? 'true' : 'false');
      item.innerHTML = `
        <input type="checkbox" ${isAssigned ? 'checked' : ''} aria-hidden="true">
        <span class="ycsm-cat-dot" style="background:${color}"></span>
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
        '<div class="ycsm-empty-cat" style="padding:10px 14px">Sin categorías. Crea la primera.</div>';
      return;
    }

    sorted.forEach((cat) => {
      const el = createCategoryElement(cat, channels, channelAssignments, categories);
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
    root.setAttribute('aria-label', 'Mis categorías de YouTube');
    root.innerHTML = `
      <div class="ycsm-sidebar-header">
        <h3 class="ycsm-sidebar-title">Mis categorías</h3>
        <div class="ycsm-sidebar-header-actions">
          <button class="ycsm-hdr-btn" id="ycsm-btn-organize" title="Organizar suscripciones" aria-label="Organizar suscripciones">
            <svg width="20" height="20" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" focusable="false" aria-hidden="true" style="pointer-events:none"><path fill-rule="evenodd" clip-rule="evenodd" d="M19.0136 4.8356C19.094 4.35341 19.5112 4 20 4H28C28.4888 4 28.906 4.35341 28.9864 4.8356L29.8799 10.1966C31.0005 10.6745 32.0508 11.2847 33.0111 12.0074L38.1037 10.0995C38.5615 9.92801 39.0761 10.1126 39.3205 10.5359L43.3205 17.4642C43.565 17.8875 43.4675 18.4255 43.0901 18.7362L38.8921 22.1921C38.9634 22.7852 39 23.3885 39 24C39 24.6115 38.9633 25.2149 38.892 25.808L43.09 29.2639C43.4675 29.5746 43.5649 30.1126 43.3205 30.5359L39.3205 37.4641C39.0761 37.8875 38.5614 38.0721 38.1037 37.9006L33.011 35.9927C32.0507 36.7153 31.0005 37.3255 29.8799 37.8034L28.9864 43.1644C28.906 43.6466 28.4888 44 28 44H20C19.5112 44 19.094 43.6466 19.0136 43.1644L18.1201 37.8034C16.9994 37.3255 15.9492 36.7153 14.9888 35.9926L9.89629 37.9005C9.43852 38.072 8.92386 37.8874 8.67944 37.4641L4.67944 30.5359C4.43502 30.1125 4.53249 29.5745 4.90989 29.2638L9.10793 25.8079C9.03664 25.2148 8.99999 24.6115 8.99999 24C8.99999 23.3885 9.03664 22.7851 9.10794 22.192L4.90994 18.7361C4.53254 18.4254 4.43507 17.8874 4.67949 17.4641L8.67949 10.5358C8.92391 10.1125 9.43857 9.92791 9.89633 10.0994L14.989 12.0073C15.9493 11.2847 16.9995 10.6745 18.1201 10.1966L19.0136 4.8356ZM20.8471 6L20.0008 11.0782C19.9424 11.4285 19.7025 11.7217 19.3706 11.8482C18.0654 12.3457 16.8605 13.0478 15.7951 13.9158C15.5195 14.1403 15.1455 14.2017 14.8126 14.077L9.98797 12.2695L6.8351 17.7304L10.8113 21.0037C11.0852 21.2292 11.2191 21.583 11.1632 21.9334C11.0559 22.6058 11 23.296 11 24C11 24.7039 11.0558 25.3941 11.1632 26.0665C11.2191 26.4169 11.0852 26.7706 10.8113 26.9961L6.83505 30.2695L9.98793 35.7304L14.8125 33.923C15.1454 33.7983 15.5194 33.8596 15.795 34.0841C16.8604 34.9521 18.0654 35.6543 19.3706 36.1518C19.7025 36.2784 19.9424 36.5715 20.0008 36.9218L20.8471 42H27.1529L27.9992 36.9218C28.0576 36.5715 28.2975 36.2783 28.6294 36.1518C29.9346 35.6543 31.1395 34.9522 32.2049 34.0842C32.4805 33.8597 32.8545 33.7983 33.1873 33.923L38.012 35.7305L41.1649 30.2696L37.1887 26.9963C36.9148 26.7708 36.7809 26.417 36.8368 26.0666C36.9441 25.3941 37 24.7039 37 24C37 23.2961 36.9441 22.6059 36.8368 21.9335C36.7809 21.5831 36.9148 21.2294 37.1887 21.0039L41.1649 17.7305L38.0121 12.2696L33.1874 14.077C32.8546 14.2017 32.4806 14.1404 32.205 13.9159C31.1396 13.0479 29.9346 12.3457 28.6294 11.8482C28.2975 11.7217 28.0576 11.4285 27.9992 11.0782L27.1529 6H20.8471Z" fill="currentColor"/><path fill-rule="evenodd" clip-rule="evenodd" d="M24 19C21.2386 19 19 21.2386 19 24C19 26.7614 21.2386 29 24 29C26.7614 29 29 26.7614 29 24C29 21.2386 26.7614 19 24 19ZM17 24C17 20.134 20.134 17 24 17C27.866 17 31 20.134 31 24C31 27.866 27.866 31 24 31C20.134 31 17 27.866 17 24Z" fill="currentColor"/></svg>
          </button>
        </div>
      </div>
      <div class="ycsm-categories-list" role="listbox" aria-label="Categorías"></div>
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
