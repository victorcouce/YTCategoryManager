/**
 * video-label.js — Botón "Categorizar" en páginas de vídeo y canal de YouTube.
 * Inyecta un botón junto a las acciones nativas
 * que abre un desplegable para asignar el canal a categorías existentes.
 */
(function () {
  if (!window.YCSM) window.YCSM = {};

  let dropdownEl = null;
  let dropdownOpen = false;
  let currentChannelId = null;
  let currentChannelName = null;
  let currentChannelData = null;
  let injectTimeout = null;

  const { t } = YCSM.i18n;

  /* ═══════════════════════════════════════════════════════════════
     UTILIDADES
  ═══════════════════════════════════════════════════════════════ */

  function escapeHtml(value) {
    const div = document.createElement('div');
    div.appendChild(document.createTextNode(String(value ?? '')));
    return div.innerHTML;
  }

  function normalizeHref(href) {
    return (href || '').split('?')[0];
  }

  function isWatchPage() {
    return location.pathname.startsWith('/watch');
  }

  function isChannelPage() {
    return /^\/(@|channel\/|c\/|user\/)/.test(location.pathname);
  }

  /* ═══════════════════════════════════════════════════════════════
     INFO DEL CANAL DEL VÍDEO ACTUAL
  ═══════════════════════════════════════════════════════════════ */

  function getVideoChannelInfo() {
    // Selectores comunes en distintas versiones de YouTube
    const channelLink =
      document.querySelector('ytd-video-owner-renderer #channel-name a') ||
      document.querySelector('ytd-channel-name a') ||
      document.querySelector('#upload-info #channel-name a') ||
      document.querySelector('#owner #channel-name a');

    if (!channelLink) return null;

    const href = channelLink.getAttribute('href') || '';
    const channelId = href.startsWith('/channel/')
      ? href.replace('/channel/', '').split('?')[0]
      : href.split('?')[0];

    const name = channelLink.textContent?.trim() || channelId;
    return { id: channelId, name, href };
  }

  /* ═══════════════════════════════════════════════════════════════
     DROPDOWN
  ═══════════════════════════════════════════════════════════════ */

  async function openDropdown(anchorEl) {
    closeDropdown();

    const channelData = await resolveCanonicalChannelData(getChannelIds());
    if (!channelData) return;

    currentChannelData = channelData;
    currentChannelId = channelData.primaryId;
    currentChannelName = channelData.name;

    const { categories } = await YCSM.storage.getAll();
    const channelAssignments = await migrateChannelAssignments(channelData);
    const catList = Object.values(categories).sort(
      (a, b) => (a.order ?? 0) - (b.order ?? 0)
    );

    // Combinar asignaciones de todos los IDs posibles del canal
    const assignedSet = new Set();
    channelData.ids.forEach((id) => {
      (channelAssignments[id] || []).forEach((catId) => assignedSet.add(catId));
    });
    const assigned = [...assignedSet];

    dropdownEl = document.createElement('div');
    dropdownEl.id = 'ycsm-video-dropdown';
    dropdownEl.className = 'ycsm-video-dropdown';
    dropdownEl.setAttribute('role', 'dialog');
    dropdownEl.setAttribute('aria-label', t('assignCategoryToChannel'));

    dropdownEl.innerHTML = `
      <div class="ycsm-vd-header">
        <span class="ycsm-vd-title">${escapeHtml(t('categorizeChannel'))}</span>
        <span class="ycsm-vd-subtitle">${escapeHtml(currentChannelName)}</span>
      </div>
      <div class="ycsm-vd-search-wrap">
        <svg class="ycsm-vd-search-icon" viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
          <path d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/>
        </svg>
        <input
          id="ycsm-vd-search"
          class="ycsm-vd-search"
          type="search"
          placeholder="${escapeHtml(t('searchCategoryPlaceholder'))}"
          autocomplete="off"
          spellcheck="false"
          aria-label="${escapeHtml(t('searchCategory'))}"
        />
      </div>
      <ul class="ycsm-vd-list" role="listbox" aria-label="${escapeHtml(t('availableCategories'))}">
        ${
          catList.length === 0
            ? `<li class="ycsm-vd-empty">${escapeHtml(t('noCategoriesCreateSidebar'))}</li>`
            : catList
                .map((cat) => {
                  const isChecked = assigned.includes(cat.id);
                  return `
                  <li class="ycsm-vd-item${isChecked ? ' ycsm-vd-item--checked' : ''}"
                      role="option"
                      aria-selected="${isChecked}"
                      data-cat-id="${escapeHtml(cat.id)}">
                    <span class="ycsm-vd-check" aria-hidden="true">
                      ${isChecked ? '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>' : ''}
                    </span>
                    <span class="ycsm-vd-cat-label">${escapeHtml(cat.name)}</span>
                  </li>`;
                })
                .join('')
        }
      </ul>
    `;

    document.body.appendChild(dropdownEl);
    positionDropdown(anchorEl);

    // Buscador
    dropdownEl.querySelector('#ycsm-vd-search')?.addEventListener('input', (e) => {
      filterList(e.target.value);
    });

    // Clicks en ítems
    dropdownEl.querySelector('.ycsm-vd-list')?.addEventListener('click', async (e) => {
      const item = e.target.closest('.ycsm-vd-item');
      if (!item || !item.dataset.catId) return;
      await toggleCategory(item.dataset.catId, item);
    });

    dropdownOpen = true;

    // Reposicionar si cambia el scroll o el tamaño
    window.addEventListener('resize', () => positionDropdown(anchorEl));

    // Cerrar al hacer clic fuera
    setTimeout(() => {
      document.addEventListener('click', onOutsideClick, { capture: true });
    }, 0);
  }

  function positionDropdown(anchorEl) {
    if (!dropdownEl) return;
    const rect = anchorEl.getBoundingClientRect();
    const scrollY = window.scrollY;
    const scrollX = window.scrollX;

    // Asegurar que no se salga por la derecha
    dropdownEl.style.position = 'absolute';
    dropdownEl.style.top = rect.bottom + scrollY + 8 + 'px';

    const dropW = 240;
    const left = Math.min(
      rect.left + scrollX,
      scrollX + document.documentElement.clientWidth - dropW - 8
    );
    dropdownEl.style.left = Math.max(scrollX + 8, left) + 'px';
  }

  function closeDropdown() {
    if (dropdownEl) {
      dropdownEl.remove();
      dropdownEl = null;
    }
    dropdownOpen = false;
    document.removeEventListener('click', onOutsideClick, { capture: true });
    window.removeEventListener('resize', positionDropdown);
  }

  function onOutsideClick(e) {
    if (!dropdownEl) return;
    const btn = document.getElementById('ycsm-label-btn');
    if (
      !dropdownEl.contains(e.target) &&
      btn !== e.target &&
      !btn?.contains(e.target)
    ) {
      closeDropdown();
    }
  }

  function filterList(query) {
    if (!dropdownEl) return;
    const q = query.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
    dropdownEl.querySelectorAll('.ycsm-vd-item').forEach((item) => {
      const text =
        (item.querySelector('.ycsm-vd-cat-label')?.textContent || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
      item.style.display = !q || text.includes(q) ? '' : 'none';
    });
  }

  async function toggleCategory(catId, itemEl) {
    if (!currentChannelId || !catId) return;

    const channelData = await resolveCanonicalChannelData(currentChannelData || getChannelIds());
    if (!channelData) return;

    const channelAssignments = await migrateChannelAssignments(channelData);
    const assigned = channelAssignments[channelData.primaryId] || [];
    const isAssigned = assigned.includes(catId);
    const nowAssigned = !isAssigned;

    if (nowAssigned) {
      channelAssignments[channelData.primaryId] = [...new Set([...assigned, catId])];
    } else {
      const next = assigned.filter((id) => id !== catId);
      if (next.length > 0) {
        channelAssignments[channelData.primaryId] = next;
      } else {
        delete channelAssignments[channelData.primaryId];
      }
    }

    await YCSM.storage.saveChannelAssignments(channelAssignments);

    itemEl.classList.toggle('ycsm-vd-item--checked', nowAssigned);
    itemEl.setAttribute('aria-selected', nowAssigned ? 'true' : 'false');

    const checkEl = itemEl.querySelector('.ycsm-vd-check');
    if (checkEl) {
      checkEl.innerHTML = nowAssigned
        ? '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>'
        : '';
    }

    // Actualizar el botón para reflejar si el canal tiene categorías
    updateButtonState();
  }

  /* ═══════════════════════════════════════════════════════════════
     OBTENER TODOS LOS IDs POSIBLES DEL CANAL
     YouTube almacena canales como UCxxxxx (panel) o /@handle (sidebar).
     Intentamos ambos para no perder asignaciones.
  ═══════════════════════════════════════════════════════════════ */

  /**
   * Extrae el browseId (UCxxxxx) del canal del vídeo actual
   * leyendo el script inline ytInitialData del DOM.
   */
  function getUCChannelIdFromScripts() {
    try {
      for (const script of document.querySelectorAll('script:not([src])')) {
        const text = script.textContent || '';
        if (!text.includes('videoOwnerRenderer') && !text.includes('channelMetadataRenderer')) continue;
        const metadataMatch = text.match(
          /"channelMetadataRenderer"\s*:\s*\{[^}]*?"externalId"\s*:\s*"(UC[^"]{10,})"/
        );
        if (metadataMatch) return metadataMatch[1];

        const ownerMatch = text.match(
          /"videoOwnerRenderer"\s*:\s*\{[^}]*?"browseId"\s*:\s*"(UC[^"]{10,})"/
        );
        if (ownerMatch) return ownerMatch[1];
      }
    } catch (_) { /* ignorar */ }
    return null;
  }

  async function migrateChannelAssignments(channelData) {
    const channelAssignments = await YCSM.storage.getChannelAssignments();
    const primaryId = channelData.primaryId;
    const ids = [...new Set(channelData.ids || [])].filter(Boolean);
    const merged = new Set(channelAssignments[primaryId] || []);
    let dirty = false;

    ids.forEach((id) => {
      const cats = channelAssignments[id] || [];
      cats.forEach((catId) => {
        if (!merged.has(catId)) dirty = true;
        merged.add(catId);
      });
      if (id !== primaryId && channelAssignments[id]) dirty = true;
    });

    const next = [...merged];
    if (next.length > 0) {
      const current = channelAssignments[primaryId] || [];
      const same =
        current.length === next.length &&
        current.every((catId) => merged.has(catId));
      if (!same) dirty = true;
      channelAssignments[primaryId] = next;
    } else if (channelAssignments[primaryId]) {
      delete channelAssignments[primaryId];
      dirty = true;
    }

    ids.forEach((id) => {
      if (id !== primaryId && channelAssignments[id]) {
        delete channelAssignments[id];
        dirty = true;
      }
    });

    if (dirty) await YCSM.storage.saveChannelAssignments(channelAssignments);
    return channelAssignments;
  }

  async function resolveCanonicalChannelData(channelData) {
    if (!channelData) return null;

    const ids = new Set(channelData.ids || []);
    let primaryId = channelData.primaryId;

    try {
      const { channels } = await YCSM.storage.getCachedChannels();
      const match = (channels || []).find((channel) => {
        const channelHref = normalizeHref(channel.href);
        return ids.has(channel.id) || (channelHref && ids.has(channelHref));
      });

      if (match?.id) {
        ids.add(match.id);
        if (match.href) ids.add(normalizeHref(match.href));
        primaryId = match.id;
      }
    } catch (_) { /* caché no disponible; usar IDs detectados en la página */ }

    return {
      ...channelData,
      ids: [...ids].filter(Boolean),
      primaryId,
    };
  }

  function makeChannelData(ids, name, preferredId) {
    if (ids.size === 0) return null;
    const idList = [...ids].filter(Boolean);
    const primaryId =
      preferredId ||
      idList.find((id) => id.startsWith('UC')) ||
      idList[0];
    return { ids: idList, name: name || primaryId, primaryId };
  }

  function getVideoChannelIds() {
    const ids = new Set();

    // El avatar-link es el más fiable: siempre está en ytd-video-owner-renderer
    // y nunca aparece en el sidebar de YouTube
    const avatarLink = document.querySelector(
      'ytd-video-owner-renderer a#avatar-link'
    );

    // Enlace de texto del nombre del canal (fallback)
    const nameLink =
      document.querySelector('ytd-video-owner-renderer #upload-info a') ||
      document.querySelector('#upload-info ytd-channel-name a') ||
      document.querySelector('ytd-video-owner-renderer #channel-name a');

    const channelLink = avatarLink || nameLink;
    if (!channelLink) {
      console.log('[YCSM] getChannelIds: no se encontró enlace del canal');
      return null;
    }

    const href = normalizeHref(channelLink.getAttribute('href') || '');
    // Intentar el nameLink para el texto visible
    const name = nameLink?.textContent?.trim() || href;

    if (!href) return null;

    // ID desde href: /channel/UCxxx → UCxxx, /@handle → /@handle
    const hrefId = href.startsWith('/channel/')
      ? href.replace('/channel/', '').split('?')[0]
      : href.split('?')[0];

    if (hrefId) ids.add(hrefId);

    // Si el avatar y el nameLink tienen hrefs distintos, añadir ambos
    if (nameLink && nameLink !== avatarLink) {
      const nHref = normalizeHref(nameLink.getAttribute('href') || '');
      const nId = nHref.startsWith('/channel/')
        ? nHref.replace('/channel/', '').split('?')[0]
        : nHref;
      if (nId) ids.add(nId);
    }

    // UC id desde scripts inline (cubre asignaciones hechas desde el panel)
    const ucId = getUCChannelIdFromScripts();
    if (ucId) ids.add(ucId);

    if (ids.size === 0) return null;
    return makeChannelData(ids, name, ucId || hrefId);
  }

  function getChannelPageIds() {
    const ids = new Set();
    const canonicalHref =
      document.querySelector('link[rel="canonical"]')?.href ||
      document.querySelector('meta[property="og:url"]')?.content ||
      location.href;

    let href = '';
    try {
      href = normalizeHref(new URL(canonicalHref, location.origin).pathname);
    } catch (_) {
      href = normalizeHref(location.pathname);
    }

    const hrefId = href.startsWith('/channel/')
      ? href.replace('/channel/', '').split('/')[0]
      : href.split('/').slice(0, 2).join('/');
    if (hrefId) ids.add(hrefId);

    const ucId = getUCChannelIdFromScripts();
    if (ucId) ids.add(ucId);

    const name =
      document.querySelector('meta[property="og:title"]')?.content ||
      document.querySelector('yt-dynamic-text-view-model h1 span')?.textContent?.trim() ||
      document.querySelector('ytd-channel-name #text')?.textContent?.trim() ||
      document.title.replace(/\s*-\s*YouTube\s*$/, '').trim() ||
      hrefId;

    return makeChannelData(ids, name, ucId || hrefId);
  }

  function getChannelIds() {
    if (isWatchPage()) return getVideoChannelIds();
    if (isChannelPage()) return getChannelPageIds();
    return null;
  }

  async function updateButtonState() {
    const btn = document.getElementById('ycsm-label-btn');
    if (!btn) return false;

    const channelData = await resolveCanonicalChannelData(getChannelIds());
    if (!channelData) return false;

    currentChannelData = channelData;
    currentChannelId = channelData.primaryId;
    currentChannelName = channelData.name;

    const { categories } = await YCSM.storage.getAll();
    const channelAssignments = await migrateChannelAssignments(channelData);

    // Recoger todos los catIds asignados a cualquiera de los IDs del canal
    const assignedCatIds = new Set();
    channelData.ids.forEach((id) => {
      (channelAssignments[id] || []).forEach((catId) => assignedCatIds.add(catId));
    });

    const assignedCats = [...assignedCatIds]
      .map((id) => categories[id])
      .filter(Boolean);

    const textEl = btn.querySelector('.ycsm-label-btn-text');
    const hasLabels = assignedCats.length > 0;

    btn.classList.toggle('ycsm-video-label-btn--active', hasLabels);

    if (!textEl) return true;

    if (!hasLabels) {
      textEl.textContent = t('categorize');
    } else if (assignedCats.length === 1) {
      const cat = assignedCats[0];
      textEl.textContent = cat.name;
    } else {
      // Mostrar la primera categoría + contador de las demás
      const first = assignedCats[0];
      const rest = assignedCats.length - 1;
      textEl.textContent =
        first.name + ` +${rest}`;
    }

    return true;
  }

  // Reintenta updateButtonState con backoff hasta que el DOM esté listo
  function scheduleButtonStateUpdate() {
    const delays = [300, 700, 1200, 2000, 3000];
    let i = 0;
    function tryNext() {
      if (!document.getElementById('ycsm-label-btn')) return;
      updateButtonState().then((ok) => {
        if (!ok && i < delays.length) {
          setTimeout(tryNext, delays[i++]);
        }
      });
    }
    tryNext();
  }

  /* ═══════════════════════════════════════════════════════════════
     CREACIÓN DEL BOTÓN
  ═══════════════════════════════════════════════════════════════ */

  function createLabelButton() {
    const btn = document.createElement('button');
    btn.id = 'ycsm-label-btn';
    btn.className = 'ycsm-video-label-btn';
    btn.setAttribute('aria-label', t('categorizeChannel'));
    btn.setAttribute('title', t('assignThisChannelToCategory'));

    btn.innerHTML = `
      <svg class="ycsm-label-btn-icon" viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
        <path d="M21.41 11.58l-9-9C12.05 2.22 11.55 2 11 2H4c-1.1 0-2 .9-2 2v7c0 .55.22 1.05.59 1.42l9 9c.36.36.86.58 1.41.58.55 0 1.05-.22 1.41-.59l7-7c.37-.36.59-.86.59-1.41 0-.55-.23-1.06-.59-1.42zM5.5 7C4.67 7 4 6.33 4 5.5S4.67 4 5.5 4 7 4.67 7 5.5 6.33 7 5.5 7z"/>
      </svg>
      <span class="ycsm-label-btn-text">${escapeHtml(t('categorize'))}</span>
    `;

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (dropdownOpen) {
        closeDropdown();
      } else {
        openDropdown(btn);
      }
    });

    return btn;
  }

  function getVideoMenuButtonHost() {
    const menuRenderer =
      document.querySelector('ytd-watch-metadata #menu > ytd-menu-renderer') ||
      document.querySelector('#menu > ytd-menu-renderer');

    if (!menuRenderer) return null;

    return (
      menuRenderer.querySelector('#top-level-buttons-computed') ||
      menuRenderer
    );
  }

  function getChannelButtonPlacement() {
    const root =
      document.querySelector('ytd-browse[page-subtype="channels"]') ||
      document.querySelector('ytd-browse') ||
      document;
    const header =
      root.querySelector('yt-page-header-renderer, page-header-renderer, yt-page-header-view-model, ytd-page-header-renderer') ||
      root.querySelector('ytd-channel-header-renderer, ytd-c4-tabbed-header-renderer') ||
      root;
    const actionHost =
      header.querySelector('yt-flexible-actions-view-model') ||
      header.querySelector('#buttons, #actions, #meta #buttons') ||
      header.querySelector('[class*="actions"]');
    const shape = (actionHost || header).querySelector(
      'yt-touch-feedback-shape, ' +
      'yt-button-shape yt-touch-feedback-shape, ' +
      'button-view-model yt-touch-feedback-shape, ' +
      'yt-button-view-model yt-touch-feedback-shape'
    );

    if (actionHost) {
      return {
        host: actionHost,
        before: null,
        mode: 'channel',
      };
    }
    if (!shape) return null;

    const nativeButton =
      shape.closest('yt-button-view-model, button-view-model, ytd-button-renderer, a.yt-spec-button-shape-next, a') ||
      shape.closest('button') ||
      shape.parentElement;
    const host = nativeButton?.parentElement;
    if (!host) return null;

    return {
      host,
      before: nativeButton.nextSibling,
      mode: 'channel',
    };
  }

  function getLabelButtonPlacement() {
    if (isWatchPage()) {
      const host = getVideoMenuButtonHost();
      return host ? { host, before: host.firstElementChild, mode: 'watch' } : null;
    }
    if (isChannelPage()) return getChannelButtonPlacement();
    return null;
  }

  /* ═══════════════════════════════════════════════════════════════
     INYECCIÓN
  ═══════════════════════════════════════════════════════════════ */

  async function injectLabelButton() {
    if (!isWatchPage() && !isChannelPage()) return false;

    const placement = getLabelButtonPlacement();
    if (!placement) return false;

    const existingBtn = document.getElementById('ycsm-label-btn');
    if (existingBtn) {
      const alreadyPlaced =
        existingBtn.parentElement === placement.host &&
        (placement.before === existingBtn || existingBtn.nextSibling === placement.before);
      if (!alreadyPlaced) {
        placement.host.insertBefore(existingBtn, placement.before);
      }
      existingBtn.classList.toggle('ycsm-video-label-btn--channel', placement.mode === 'channel');
      scheduleButtonStateUpdate();
      return true;
    }

    const btn = createLabelButton();
    btn.classList.toggle('ycsm-video-label-btn--channel', placement.mode === 'channel');
    placement.host.insertBefore(btn, placement.before);

    // Actualizar estado con reintentos (el DOM del canal puede no estar aún)
    scheduleButtonStateUpdate();

    return true;
  }

  function scheduleInject(delayMs = 400) {
    clearTimeout(injectTimeout);
    injectTimeout = setTimeout(async () => {
      const ok = await injectLabelButton();
      if (!ok) scheduleInject(600);
    }, delayMs);
  }

  function cleanup() {
    clearTimeout(injectTimeout);
    closeDropdown();
    document.getElementById('ycsm-label-btn')?.remove();
    currentChannelId = null;
    currentChannelName = null;
    currentChannelData = null;
  }

  /* ═══════════════════════════════════════════════════════════════
     API PÚBLICA
  ═══════════════════════════════════════════════════════════════ */

  YCSM.videoLabel = {
    inject: injectLabelButton,
    scheduleInject,
    scheduleButtonStateUpdate,
    cleanup,
  };
})();
