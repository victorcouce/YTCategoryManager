/**
 * panel.js — Content script bridge for the Organize Subscriptions panel.
 *
 * Responsibilities (kept here in the YouTube page context):
 *   1. Discover the user's subscriptions (fetch /feed/channels → DOM fallback).
 *   2. Migrate legacy assignment IDs to the canonical channelId.
 *   3. Cache channels via YCSM.storage so the iframe UI can read them.
 *   4. Mount/dismount an iframe that loads src/panel/panel.html — the real
 *      UI lives in panel-ui.js (loaded inside that iframe).
 *
 * The iframe-based architecture isolates the panel UI from YouTube's
 * stylesheets and SPA churn, while we still have access here to the page
 * DOM (needed for the DOM-scrape fallback and post-close sidebar re-inject).
 */
(function () {
  'use strict';
  if (!window.YCSM) window.YCSM = {};

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
      if (esc)                 { esc = false; continue; }
      if (c === '\\' && inStr) { esc = true;  continue; }
      if (c === '"')           { inStr = !inStr; continue; }
      if (inStr)               { continue; }
      if (c === '{')           { depth++; }
      else if (c === '}' && --depth === 0) {
        try { return JSON.parse(scriptText.slice(start, i + 1)); } catch { return null; }
      }
    }
    return null;
  }

  /**
   * Recorre el árbol JSON de ytInitialData buscando todos los channelRenderer
   * (suscripciones del usuario). Iterativo para evitar pilas profundas.
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
          let avatar = thumbs[thumbs.length - 1]?.url || '';
          if (avatar.startsWith('//')) avatar = 'https:' + avatar;
          channels.push({ id, name, avatar, href: handle || `/channel/${id}` });
        }
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
      const resp = await fetch('https://www.youtube.com/feed/channels', { credentials: 'include' });
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

      return collectChannelRenderers(ytData);
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
    const collapsibles = document.querySelectorAll('ytd-guide-collapsible-section-entry-renderer');
    if (collapsibles.length === 0) return;

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

    const links = document.querySelectorAll(
      'ytd-guide-entry-renderer a, ' +
      'ytd-guide-collapsible-section-entry-renderer a, ' +
      'ytd-subscription-item-renderer a, ' +
      'ytd-channel-renderer a'
    );

    links.forEach((link) => {
      const href = link.getAttribute('href') || '';
      if (!href.startsWith('/channel/') && !href.startsWith('/@') && !href.startsWith('/c/')) return;

      const channelId = href.startsWith('/channel/')
        ? href.replace('/channel/', '').split('?')[0]
        : href.split('?')[0];

      if (!channelId || seen.has(channelId)) return;
      seen.add(channelId);

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
     MIGRACIÓN DE IDs LEGACY
     El scraper antiguo usaba el href como ID (p.ej. "/@handle"). El
     fetch nuevo usa el channelId canónico (UCxxxxx). Migramos asignaciones.
  ═══════════════════════════════════════════════════════════════ */

  async function migrateAssignmentIds(channels) {
    const assignments = await YCSM.storage.getChannelAssignments();

    const hrefToId = {};
    for (const ch of channels) {
      if (!ch.href) continue;
      const hrefKey = ch.href.split('?')[0];
      if (hrefKey !== ch.id) hrefToId[hrefKey] = ch.id;
    }

    let dirty = false;
    for (const [oldKey, canonicalId] of Object.entries(hrefToId)) {
      if (assignments[oldKey] && !assignments[canonicalId]) {
        assignments[canonicalId] = assignments[oldKey];
        delete assignments[oldKey];
        dirty = true;
      } else if (assignments[oldKey] && assignments[canonicalId]) {
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
     IFRAME LIFECYCLE
  ═══════════════════════════════════════════════════════════════ */

  let overlayEl = null;
  let _messageListener = null;

  function buildOverlay() {
    const overlay = document.createElement('div');
    overlay.id = 'ycsm-panel-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.style.cssText = [
      'position:fixed',
      'inset:0',
      'z-index:2147483640',
      'pointer-events:auto',
    ].join(';');

    // The iframe itself: panel.css inside paints a full-bleed background
    // and centres the modal — no extra scrim wrapper needed here.
    const iframe = document.createElement('iframe');
    iframe.src = chrome.runtime.getURL('src/panel/panel.html');
    iframe.title = window.YCSM?.i18n?.t?.('organizeYoutubeSubscriptions') || 'Organize Subscriptions';
    iframe.style.cssText = [
      'position:absolute',
      'inset:0',
      'width:100%',
      'height:100%',
      'border:0',
      'background:transparent',
      'color-scheme:dark light',
    ].join(';');
    iframe.setAttribute('allowtransparency', 'true');
    overlay.appendChild(iframe);

    return overlay;
  }

  function handleEscape(e) {
    if (e.key === 'Escape') close();
  }

  function handleMessage(e) {
    if (e.origin !== 'https://www.youtube.com') return;
    if (!e?.data) return;
    if (e.data.type === 'YCSM_PANEL_CLOSE') close();
    if (e.data.type === 'YCSM_NAVIGATE') {
      if (e.data.href) window.open(e.data.href, '_blank');
    }
  }

  async function open() {
    if (overlayEl) return;

    // 1) Fetch subscriptions — robust path first
    let channels = await fetchAllSubscriptions();

    // 2) Fallback to cached list
    if (channels.length === 0) {
      const cached = await YCSM.storage.getCachedChannels();
      channels = cached.channels || [];
    }

    // 3) Last resort: DOM scrape (may force YT to expand its sidebar)
    if (channels.length === 0) {
      await expandYouTubeSubscriptions();
      channels = scrapeChannelsFromDOM();
    }

    if (channels.length > 0) {
      await migrateAssignmentIds(channels);
      await YCSM.storage.cacheChannels(channels);
    }

    overlayEl = buildOverlay();
    document.body.appendChild(overlayEl);

    _messageListener = handleMessage;
    window.addEventListener('message', _messageListener);
    document.addEventListener('keydown', handleEscape);
  }

  function close() {
    if (overlayEl) {
      overlayEl.remove();
      overlayEl = null;
    }
    if (_messageListener) {
      window.removeEventListener('message', _messageListener);
      _messageListener = null;
    }
    document.removeEventListener('keydown', handleEscape);

    // Re-inject the YouTube sidebar if it was removed during panel use.
    setTimeout(() => {
      if (window.YCSM?.sidebar && !document.getElementById('ycsm-sidebar')) {
        YCSM.sidebar.injectIntoYouTube();
      }
    }, 200);
  }

  /* ── Export ── */
  window.YCSM.panel = {
    open,
    close,
    scrapeChannelsFromDOM,
  };
})();
