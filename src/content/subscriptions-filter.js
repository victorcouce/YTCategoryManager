/**
 * subscriptions-filter.js — Navbar de categorías en /feed/subscriptions
 *
 * Estrategia: setInterval simple (300 ms) mientras estamos en /feed/subscriptions.
 *  - Cada tick comprueba:
 *      • ¿Estoy en subs? No → cleanup y para el interval.
 *      • ¿Hay grid? No → espera al siguiente tick.
 *      • ¿El nav ya está bien colocado? Sí → aplica filtro pendiente si lo hay.
 *      • No → inyecta.
 *  - Sin MutationObserver de página, sin debounce, sin versionado.
 *    Imposible livelock porque el interval no se cancela por mutaciones del DOM.
 */
(function () {
  if (!window.YCSM) window.YCSM = {};

  const { isSubscriptionsPage } = YCSM.utils;

  let activeFilter = null;      // null = Todos, string = categoryId
  let filterObserver = null;    // observa el grid para vídeos lazy-loaded
  let navEl = null;
  let _hrefToId = {};
  let _pollInterval = null;     // setInterval de reconciliación
  let _reconciling = false;     // lock para evitar solapamiento de reconcile()
  let _filterDebounce = null;

  const { t } = YCSM.i18n;

  /* ─── Utilidades ──────────────────────────────────────────── */

  function normalizeHref(href) {
    if (!href) return null;
    return href.split('?')[0];
  }

  function getGrid() {
    return document.querySelector('ytd-rich-grid-renderer');
  }

  function resolveChannelId(href) {
    if (!href) return null;
    const norm = normalizeHref(href);
    if (_hrefToId[norm]) return _hrefToId[norm];
    if (norm.startsWith('/channel/')) return norm.replace('/channel/', '');
    return norm;
  }

  function getVideoChannelId(itemEl) {
    const link = itemEl.querySelector(
      '#avatar-link[href], a[href^="/@"], a[href^="/channel/"], a[href^="/c/"]'
    );
    const href = link?.getAttribute('href');
    if (!href) return null;
    if (!href.startsWith('/@') && !href.startsWith('/channel/') && !href.startsWith('/c/')) return null;
    return resolveChannelId(href);
  }

  async function buildHrefMap() {
    const { channels } = await YCSM.storage.getCachedChannels();
    _hrefToId = {};
    (channels || []).forEach((ch) => {
      if (ch.href) _hrefToId[normalizeHref(ch.href)] = ch.id;
      if (ch.id && ch.id.startsWith('UC')) {
        _hrefToId[`/channel/${ch.id}`] = ch.id;
      }
    });
  }

  /* ─── Filtrado ─────────────────────────────────────────────── */

  async function applyFilter({ animate = false } = {}) {
    const { channelAssignments: assignments } = await YCSM.storage.getAll();

    const grid = getGrid();

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

    if (grid) {
      requestAnimationFrame(() => {
        grid.style.transition = 'opacity 0.2s ease';
        grid.style.opacity = '1';
      });
    }

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

    const scrollWrap = document.createElement('div');
    scrollWrap.className = 'ycsm-subs-nav-scroll';

    // Pill "Todos"
    const allPill = makePill(t('all'), null, activeFilter === null);
    allPill.addEventListener('click', () => {
      activeFilter = null;
      refreshPills();
      applyFilter({ animate: true });
    });
    scrollWrap.appendChild(allPill);

    sorted.forEach((cat) => {
      const pill = makePill(cat.name, cat.id, activeFilter === cat.id);
      pill.addEventListener('click', () => {
        activeFilter = cat.id;
        refreshPills();
        applyFilter({ animate: true });
        pill.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
      });
      scrollWrap.appendChild(pill);
    });

    navEl.appendChild(scrollWrap);

    function updateFades() {
      const sl = scrollWrap.scrollLeft;
      const maxSl = scrollWrap.scrollWidth - scrollWrap.clientWidth;
      navEl.classList.toggle('ycsm-subs-can-scroll-left', sl > 1);
      navEl.classList.toggle('ycsm-subs-can-scroll-right', sl < maxSl - 1);
    }
    scrollWrap.addEventListener('scroll', updateFades, { passive: true });
    requestAnimationFrame(() => requestAnimationFrame(updateFades));

    return navEl;
  }

  function makePill(text, catId, isActive) {
    const btn = document.createElement('button');
    btn.className = 'ycsm-subs-pill' + (isActive ? ' ycsm-subs-pill-active' : '');
    btn.textContent = text;
    if (catId) btn.dataset.catId = catId;
    return btn;
  }

  function refreshPills() {
    if (!navEl) return;
    navEl.querySelectorAll('.ycsm-subs-pill').forEach((pill) => {
      const isActive = activeFilter === null
        ? !pill.dataset.catId
        : pill.dataset.catId === activeFilter;
      pill.classList.toggle('ycsm-subs-pill-active', isActive);
    });
  }

  /* ─── Observer para vídeos cargados lazy ───────────────────── */

  function setupFilterObserver() {
    if (filterObserver) filterObserver.disconnect();
    const contents = document.querySelector(
      'ytd-rich-grid-renderer #contents, #contents.ytd-rich-grid-renderer'
    );
    if (!contents) { filterObserver = null; return; }
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
      clearTimeout(_filterDebounce);
      _filterDebounce = setTimeout(() => applyFilter(), 400);
    });
    filterObserver.observe(contents, { childList: true, subtree: true });
  }

  /* ─── Reconciliación (núcleo) ──────────────────────────────── */

  async function reconcile() {
    if (_reconciling) return; // ya hay una reconciliación en curso
    _reconciling = true;
    try {
      if (!isSubscriptionsPage()) {
        cleanup();
        return;
      }

      const grid = getGrid();
      if (!grid) return; // siguiente tick lo reintentará

      // ── Caso 1: el nav ya está donde toca ────────────────────────
      if (navEl && navEl.isConnected && navEl.nextElementSibling === grid) {
        const pending = sessionStorage.getItem('ycsm_pending_filter');
        if (pending) {
          sessionStorage.removeItem('ycsm_pending_filter');
          activeFilter = pending;
          refreshPills();
          applyFilter({ animate: false });
        } else if (!filterObserver) {
          setupFilterObserver();
        }
        return;
      }

      // ── Caso 2: hay que (re)inyectar ─────────────────────────────
      await buildHrefMap();
      if (!isSubscriptionsPage()) return;

      const { categories } = await YCSM.storage.getAll();
      if (Object.keys(categories).length === 0) return;

      const freshGrid = getGrid();
      if (!freshGrid) return;

      // Consume el filtro pendiente que dejó el sidebar antes de navegar
      const pending = sessionStorage.getItem('ycsm_pending_filter');
      if (pending) {
        activeFilter = pending;
        sessionStorage.removeItem('ycsm_pending_filter');
      }

      const nav = await buildNav();
      if (!isSubscriptionsPage() || !freshGrid.isConnected) return;

      freshGrid.parentElement.insertBefore(nav, freshGrid);
      setupFilterObserver();
      applyFilter({ animate: false });
    } finally {
      _reconciling = false;
    }
  }

  /* ─── Polling (reemplaza al MutationObserver) ──────────────── */

  function startPolling() {
    if (_pollInterval) return;
    _pollInterval = setInterval(reconcile, 300);
    // Tick inmediato
    reconcile();
  }

  function stopPolling() {
    if (_pollInterval) {
      clearInterval(_pollInterval);
      _pollInterval = null;
    }
  }

  /* ─── Limpieza ─────────────────────────────────────────────── */

  function cleanup() {
    if (filterObserver) { filterObserver.disconnect(); filterObserver = null; }
    stopPolling();
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

  /* ─── API pública ──────────────────────────────────────────── */

  window.YCSM.subscriptionsFilter = {
    injectSubscriptionsNav: () => startPolling(),
    refreshNav: () => {
      navEl?.remove();
      navEl = null;
      startPolling();
    },
    cleanup,
    activateFilter,
  };
})();
