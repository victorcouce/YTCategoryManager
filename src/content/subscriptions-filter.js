/**
 * subscriptions-filter.js — Navbar de categorías en la página de Suscripciones.
 * Inyecta una barra de pills encima del grid de vídeos en /feed/subscriptions
 * y filtra los vídeos según la categoría seleccionada.
 */
(function () {
  if (!window.YCSM) window.YCSM = {};

  let activeFilter = null;   // null = Todos, string = categoryId
  let filterObserver = null;
  let navEl = null;
  let _hrefToId = {};        // href normalizado → channelId canónico

  /* ─── Utilidades ──────────────────────────────────────────── */

  function isSubscriptionsPage() {
    return location.pathname === '/feed/subscriptions';
  }

  function normalizeHref(href) {
    if (!href) return null;
    return href.split('?')[0]; // quitar query params, conservar case original
  }

  /** Extrae el channelId almacenado que corresponde al href del vídeo */
  function resolveChannelId(href) {
    if (!href) return null;
    const norm = normalizeHref(href);
    if (_hrefToId[norm]) return _hrefToId[norm];
    // /channel/UCxxxxx → extraer solo el ID (formato que usa sidebar.js)
    if (norm.startsWith('/channel/')) return norm.replace('/channel/', '');
    // /@handle → devolver tal cual (mismo formato que las claves de assignments)
    return norm;
  }

  /** Obtiene el channelId de un ytd-rich-item-renderer */
  function getVideoChannelId(itemEl) {
    // Buscar cualquier enlace con href de canal (amplio para cubrir cambios de DOM de YouTube)
    const link = itemEl.querySelector(
      '#avatar-link[href], a[href^="/@"], a[href^="/channel/"], a[href^="/c/"]'
    );
    const href = link?.getAttribute('href');
    if (!href) return null;

    // Ignorar enlaces que no son de canal (p.ej. /watch?v=...)
    if (!href.startsWith('/@') && !href.startsWith('/channel/') && !href.startsWith('/c/')) return null;

    return resolveChannelId(href);
  }

  /* ─── Construcción del mapa href → id desde caché ─────────── */

  async function buildHrefMap() {
    const { channels } = await YCSM.storage.getCachedChannels();
    _hrefToId = {};
    (channels || []).forEach((ch) => {
      // Mapear href canónico (sin query params, case original) → id almacenado
      if (ch.href) _hrefToId[normalizeHref(ch.href)] = ch.id;
      // También mapear /channel/UCxxxxx → id (por si el vídeo usa formato diferente)
      if (ch.id && ch.id.startsWith('UC')) {
        _hrefToId[`/channel/${ch.id}`] = ch.id;
      }
    });
  }

  /* ─── Filtrado ─────────────────────────────────────────────── */

  function getGrid() {
    return document.querySelector('ytd-rich-grid-renderer');
  }

  async function applyFilter({ animate = false } = {}) {
    const { channelAssignments: assignments } = await YCSM.storage.getAll();

    const grid = getGrid();

    // Ocultar el grid antes de aplicar para evitar el flash de contenido
    if (animate && grid) {
      grid.style.transition = 'none';
      grid.style.opacity = '0';
    }

    // Pausar el observer mientras aplicamos cambios para evitar bucle infinito
    if (filterObserver) filterObserver.disconnect();

    // ── vídeos normales ──────────────────────────────────────────
    document.querySelectorAll('ytd-rich-item-renderer').forEach((item) => {
      if (!activeFilter) {
        item.style.removeProperty('display');
        return;
      }
      const chId = getVideoChannelId(item);
      if (!chId) {
        item.style.setProperty('display', 'none', 'important');
        return;
      }
      const cats = assignments[chId] || [];
      if (cats.includes(activeFilter)) {
        item.style.removeProperty('display');
      } else {
        item.style.setProperty('display', 'none', 'important');
      }
    });

    // ── secciones ("Más recientes", "Más relevantes") ────────────
    document.querySelectorAll('ytd-rich-section-renderer').forEach((section) => {
      const sectionItems = section.querySelectorAll('ytd-rich-item-renderer');
      if (!sectionItems.length) return;
      const anyVisible = Array.from(sectionItems).some(
        (it) => it.style.getPropertyValue('display') !== 'none'
      );
      if (anyVisible) {
        section.style.removeProperty('display');
      } else {
        section.style.setProperty('display', 'none', 'important');
      }
    });

    // ── bloque de Shorts ─────────────────────────────────────────
    document.querySelectorAll('ytd-rich-shelf-renderer').forEach((shelf) => {
      if (activeFilter) {
        shelf.style.setProperty('display', 'none', 'important');
      } else {
        shelf.style.removeProperty('display');
      }
    });

    // Fade-in suave tras aplicar el filtro
    if (grid) {
      requestAnimationFrame(() => {
        grid.style.transition = 'opacity 0.2s ease';
        grid.style.opacity = '1';
      });
    }

    // Reconectar el observer después de aplicar los cambios
    setupFilterObserver();
  }

  /* ─── Navbar ───────────────────────────────────────────────── */

  async function buildNav() {
    const { categories } = await YCSM.storage.getAll();
    const sorted = Object.values(categories).sort((a, b) => a.order - b.order);

    if (navEl) navEl.remove();
    navEl = document.createElement('div');
    navEl.id = 'ycsm-subs-nav';
    navEl.className = 'ycsm-subs-nav';

    // Pill "Todos"
    const allPill = makePill('Todos', null, activeFilter === null);
    allPill.addEventListener('click', () => {
      activeFilter = null;
      refreshPills();
      applyFilter({ animate: true });
    });
    navEl.appendChild(allPill);

    sorted.forEach((cat) => {
      const label = (cat.emoji ? cat.emoji + ' ' : '') + cat.name;
      const pill = makePill(label, cat.id, activeFilter === cat.id, cat.color);
      pill.addEventListener('click', () => {
        activeFilter = cat.id;
        refreshPills();
        applyFilter({ animate: true });
      });
      navEl.appendChild(pill);
    });

    return navEl;
  }

  function makePill(text, catId, isActive, color) {
    const btn = document.createElement('button');
    btn.className = 'ycsm-subs-pill' + (isActive ? ' ycsm-subs-pill-active' : '');
    btn.textContent = text;
    if (catId) btn.dataset.catId = catId;
    if (isActive && color) btn.style.setProperty('--ycsm-subs-pill-color', color);
    return btn;
  }

  function refreshPills() {
    if (!navEl) return;
    navEl.querySelectorAll('.ycsm-subs-pill').forEach((pill) => {
      const isActive = activeFilter === null
        ? !pill.dataset.catId
        : pill.dataset.catId === activeFilter;
      pill.classList.toggle('ycsm-subs-pill-active', isActive);

      if (isActive && pill.dataset.catId) {
        // mantener color si estaba seteado
      } else {
        pill.style.removeProperty('--ycsm-subs-pill-color');
      }
    });
  }

  /* ─── Observer para vídeos cargados lazy ───────────────────── */

  let _filterDebounce = null;

  function setupFilterObserver() {
    if (filterObserver) filterObserver.disconnect();
    const contents = document.querySelector(
      'ytd-rich-grid-renderer #contents, #contents.ytd-rich-grid-renderer'
    );
    if (!contents) return;
    filterObserver = new MutationObserver((mutations) => {
      // Si hay filtro activo, ocultar nuevos items ANTES de que el browser los pinte
      if (activeFilter) {
        for (const mut of mutations) {
          for (const node of mut.addedNodes) {
            if (node.nodeType !== 1) continue;
            if (node.tagName === 'YTD-RICH-ITEM-RENDERER') {
              node.style.setProperty('display', 'none', 'important');
            }
            node.querySelectorAll?.('ytd-rich-item-renderer').forEach((el) => {
              el.style.setProperty('display', 'none', 'important');
            });
          }
        }
      }
      // Luego el debounce aplica el filtro completo y revela los correctos
      clearTimeout(_filterDebounce);
      _filterDebounce = setTimeout(() => applyFilter(), 400);
    });
    filterObserver.observe(contents, { childList: true, subtree: true });
  }

  /* ─── Inyección principal ──────────────────────────────────── */

  async function injectSubscriptionsNav() {
    if (!isSubscriptionsPage()) {
      cleanup();
      return;
    }

    await buildHrefMap();

    const { categories } = await YCSM.storage.getAll();
    if (Object.keys(categories).length === 0) return;

    // Esperar el grid con reintentos
    let grid = document.querySelector('ytd-rich-grid-renderer');
    if (!grid) return;

    // Si la nav ya está, solo reaplicar filtro
    if (document.getElementById('ycsm-subs-nav')) {
      applyFilter();
      return;
    }

    // Recuperar filtro pendiente (viene de clic en sidebar)
    const pending = sessionStorage.getItem('ycsm_pending_filter');
    if (pending) {
      activeFilter = pending;
      sessionStorage.removeItem('ycsm_pending_filter');
    }

    const nav = await buildNav();
    grid.parentElement.insertBefore(nav, grid);

    setupFilterObserver();
    applyFilter({ animate: false });
  }

  /* ─── Limpieza al salir de la página ──────────────────────── */

  function cleanup() {
    if (filterObserver) { filterObserver.disconnect(); filterObserver = null; }
    clearTimeout(_filterDebounce);
    navEl?.remove();
    navEl = null;
    activeFilter = null;
    _hrefToId = {};
  }

  function activateFilter(categoryId) {
    activeFilter = categoryId;
    if (navEl) refreshPills();
    applyFilter({ animate: true });
  }

  window.YCSM.subscriptionsFilter = { injectSubscriptionsNav, cleanup, activateFilter };
})();
