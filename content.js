/**
 * content.js — Controlador principal del content script.
 * Gestiona inyección, MutationObserver y navegación SPA de YouTube.
 */
(function () {
  let isInjected = false;
  let injectTimeout = null;
  let observer = null;

  /* ═══════════════════════════════════════════════════════════════
     INYECCIÓN CON REINTENTOS
  ═══════════════════════════════════════════════════════════════ */

  async function tryInject() {
    // Si el sidebar ya existe en el DOM, no hacer nada
    if (document.getElementById('ycsm-sidebar')) {
      isInjected = true;
      return;
    }

    const success = await YCSM.sidebar.injectIntoYouTube();
    if (success) {
      isInjected = true;
    }
  }

  function scheduleInject(delayMs = 300) {
    clearTimeout(injectTimeout);
    injectTimeout = setTimeout(tryInject, delayMs);
  }

  /* ═══════════════════════════════════════════════════════════════
     MUTATION OBSERVER — supervisa el sidebar de YouTube
  ═══════════════════════════════════════════════════════════════ */

  function setupObserver() {
    if (observer) observer.disconnect();

    const target = document.querySelector('ytd-app') || document.body;

    observer = new MutationObserver(() => {
      // Si nuestro sidebar fue eliminado por un re-render de YouTube, reinyectar
      if (isInjected && !document.getElementById('ycsm-sidebar')) {
        isInjected = false;
        scheduleInject(400);
        return;
      }
      // Si aún no hemos inyectado y el guide-content ya está disponible
      if (!isInjected) {
        scheduleInject(300);
      }
    });

    observer.observe(target, {
      childList: true,
      subtree: true,
    });
  }

  /* ═══════════════════════════════════════════════════════════════
     MENSAJES DESDE POPUP / BACKGROUND
  ═══════════════════════════════════════════════════════════════ */

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    switch (message.action) {
      case 'openPanel':
        YCSM.panel.open();
        sendResponse({ success: true });
        break;

      case 'refreshSidebar':
        YCSM.sidebar.scheduleRender();
        sendResponse({ success: true });
        break;

      case 'getChannels':
        sendResponse({ channels: YCSM.panel.scrapeChannelsFromDOM() });
        break;

      default:
        sendResponse({ success: false, error: 'Unknown action' });
        break;
    }
    // Devolver true no es necesario aquí porque las respuestas son síncronas
  });

  /* ═══════════════════════════════════════════════════════════════
     REACTIVIDAD AL STORAGE
  ═══════════════════════════════════════════════════════════════ */

  YCSM.storage.onChange(() => {
    if (document.getElementById('ycsm-sidebar')) {
      YCSM.sidebar.scheduleRender();
    }
  });

  /* ═══════════════════════════════════════════════════════════════
     NAVEGACIÓN SPA DE YOUTUBE
  ═══════════════════════════════════════════════════════════════ */

  // YouTube emite este evento tras cada navegación interna
  document.addEventListener('yt-navigate-finish', () => {
    isInjected = false;
    scheduleInject(600);
    // Navbar de suscripciones
    if (location.pathname === '/feed/subscriptions') {
      setTimeout(() => YCSM.subscriptionsFilter?.injectSubscriptionsNav(), 800);
    } else {
      YCSM.subscriptionsFilter?.cleanup();
    }
  });

  // Algunos cambios de ruta también emiten este evento
  document.addEventListener('yt-page-data-updated', () => {
    if (!isInjected) scheduleInject(500);
    if (location.pathname === '/feed/subscriptions') {
      setTimeout(() => YCSM.subscriptionsFilter?.injectSubscriptionsNav(), 600);
    }
  });

  /* ═══════════════════════════════════════════════════════════════
     INICIALIZACIÓN
  ═══════════════════════════════════════════════════════════════ */

  async function init() {
    setupObserver();

    // Primer intento inmediato; si falla, los reintentos vienen del observer
    await tryInject();

    // Navbar de suscripciones en carga directa (YouTube tarda en renderizar el grid)
    setTimeout(() => YCSM.subscriptionsFilter?.injectSubscriptionsNav(), 1500);

    // Si tras 3 s todavía no inyectamos, reintentar (para cargas lentas)
    if (!isInjected) {
      setTimeout(async () => {
        if (!isInjected) await tryInject();
      }, 3000);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
