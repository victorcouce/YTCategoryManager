/**
 * content.js — Controlador principal del content script.
 * Gestiona inyección, setInterval y navegación SPA de YouTube.
 */
(function () {
  const { isSubscriptionsPage, isChannelPage } = YCSM.utils;

  let isInjected = false;
  let injectInterval = null;

  /* ═══════════════════════════════════════════════════════════════
     INYECCIÓN CON POLLING
  ═══════════════════════════════════════════════════════════════ */

  async function tryInject() {
    // Si el sidebar ya existe en el DOM, no hacer nada
    if (document.getElementById('ycsm-sidebar')) {
      isInjected = true;
      stopInjectPolling();
      return;
    }

    const success = await YCSM.sidebar.injectIntoYouTube();
    if (success) {
      isInjected = true;
      stopInjectPolling();
    }
  }

  function startInjectPolling() {
    if (injectInterval) return;
    injectInterval = setInterval(() => {
      if (isInjected && document.getElementById('ycsm-sidebar')) {
        // Sidebar presente → nada que hacer
        return;
      }
      if (isInjected && !document.getElementById('ycsm-sidebar')) {
        // YouTube eliminó nuestro sidebar → reinyectar
        isInjected = false;
      }
      tryInject();
    }, 500);
    // Tick inmediato
    tryInject();
  }

  function stopInjectPolling() {
    if (injectInterval) {
      clearInterval(injectInterval);
      injectInterval = null;
    }
  }

  function shouldShowCategoryButton() {
    return location.pathname.startsWith('/watch') || isChannelPage();
  }

  /* ═══════════════════════════════════════════════════════════════
     POLLING — supervisa el sidebar de YouTube y el botón de categorías
  ═══════════════════════════════════════════════════════════════ */

  // El polling del sidebar se inicia con startInjectPolling() y se detiene
  // automáticamente una vez inyectado. Se reinicia en cada navegación SPA.
  // Para el botón de categorías, se usa un interval separado más abajo.

  let labelInterval = null;

  function startLabelPolling(delayMs = 500) {
    stopLabelPolling();
    labelInterval = setInterval(() => {
      if (!shouldShowCategoryButton()) {
        stopLabelPolling();
        return;
      }
      if (document.getElementById('ycsm-label-btn')) {
        stopLabelPolling();
        return;
      }
      YCSM.videoLabel?.scheduleInject(0);
    }, delayMs);
  }

  function stopLabelPolling() {
    if (labelInterval) {
      clearInterval(labelInterval);
      labelInterval = null;
    }
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

  YCSM.storage.onChange((changes) => {
    if (document.getElementById('ycsm-sidebar')) {
      YCSM.sidebar.scheduleRender();
    }
    if (changes.categories && location.pathname === '/feed/subscriptions') {
      YCSM.subscriptionsFilter?.refreshNav();
    }
    // Sincronizar el botón de categorías con cualquier cambio de storage
    if (document.getElementById('ycsm-label-btn')) {
      YCSM.videoLabel?.scheduleButtonStateUpdate();
    }
  });

  /* ═══════════════════════════════════════════════════════════════
     NAVEGACIÓN SPA DE YOUTUBE
  ═══════════════════════════════════════════════════════════════ */

  // YouTube emite este evento tras cada navegación interna
  document.addEventListener('yt-navigate-finish', () => {
    isInjected = false;
    startInjectPolling();
    // Navbar de suscripciones
    if (isSubscriptionsPage()) {
      YCSM.subscriptionsFilter?.injectSubscriptionsNav();
    } else {
      YCSM.subscriptionsFilter?.cleanup();
    }
    // Botón de categorías en página de vídeo o canal
    YCSM.videoLabel?.cleanup();
    if (shouldShowCategoryButton()) {
      startLabelPolling(500);
    }
  });

  // Algunos cambios de ruta también emiten este evento
  document.addEventListener('yt-page-data-updated', () => {
    if (!isInjected) startInjectPolling();
    if (isSubscriptionsPage()) {
      YCSM.subscriptionsFilter?.injectSubscriptionsNav();
    }
    if (shouldShowCategoryButton()) {
      startLabelPolling(500);
    }
  });

  /* ═══════════════════════════════════════════════════════════════
     INICIALIZACIÓN
  ═══════════════════════════════════════════════════════════════ */

  async function init() {
    startInjectPolling();

    // Navbar de suscripciones en carga directa.
    if (isSubscriptionsPage()) YCSM.subscriptionsFilter?.injectSubscriptionsNav();

    // Botón de categorías en carga directa de página de vídeo o canal
    if (shouldShowCategoryButton()) {
      startLabelPolling(500);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
