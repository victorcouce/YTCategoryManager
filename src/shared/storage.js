/**
 * storage.js — Capa de abstracción sobre chrome.storage
 * Compatible con content scripts y páginas de extensión (popup, panel).
 */
(function () {
  if (!window.YCSM) window.YCSM = {};

  const DEFAULT_SETTINGS = {
    showUncategorized: true,
    collapseByDefault: false,
  };

  function generateId() {
    return 'cat_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  /* ─── Helpers internos ─────────────────────────────────────────── */

  /**
   * Comprueba si el contexto de la extensión sigue activo.
   * En MV3 el service worker puede morir; el content script queda vivo
   * pero chrome.storage lanza "Extension context invalidated".
   */
  function isContextValid() {
    try {
      return !!chrome.runtime?.id;
    } catch (_) {
      return false;
    }
  }

  /**
   * Helpers que usan la API Promise de chrome.storage (MV3).
   * Con callbacks, chrome.storage TAMBIÉN devuelve una Promise interna que
   * puede rechazarse con "Extension context invalidated" sin ser capturada.
   * Usando solo Promises y encadenando .catch() evitamos ese rechazo no manejado.
   */
  function syncGet(keys) {
    if (!isContextValid()) return Promise.resolve({});
    return chrome.storage.sync.get(keys).catch((e) => {
      console.warn('[YCSM] storage.sync.get error:', e.message);
      return {};
    });
  }

  function syncSet(items) {
    if (!isContextValid()) return Promise.resolve(false);
    return chrome.storage.sync.set(items).then(() => true).catch((e) => {
      console.warn('[YCSM] storage.sync.set error:', e.message);
      return false;
    });
  }

  function localGet(keys) {
    if (!isContextValid()) return Promise.resolve({});
    return chrome.storage.local.get(keys).catch((e) => {
      console.warn('[YCSM] storage.local.get error:', e.message);
      return {};
    });
  }

  function localSet(items) {
    if (!isContextValid()) return Promise.resolve(false);
    return chrome.storage.local.set(items).then(() => true).catch((e) => {
      console.warn('[YCSM] storage.local.set error:', e.message);
      return false;
    });
  }

  /* ─── Caché en memoria ─────────────────────────────────────────── */
  // Evita round-trips a chrome.storage en cada render del sidebar.
  // Se invalida cada vez que se escribe en sync storage.
  let _memCache = null;

  function invalidateCache() {
    _memCache = null;
  }

  /* ─── Lectura ──────────────────────────────────────────────────── */

  async function getAll() {
    if (_memCache) return _memCache;
    const data = await syncGet(['categories', 'channelAssignments', 'settings']);
    _memCache = {
      categories: data.categories || {},
      channelAssignments: data.channelAssignments || {},
      settings: data.settings || { ...DEFAULT_SETTINGS },
    };
    return _memCache;
  }

  async function getCategories() {
    const all = await getAll();
    return all.categories;
  }

  async function getChannelAssignments() {
    const all = await getAll();
    return all.channelAssignments;
  }

  async function getSettings() {
    const all = await getAll();
    return all.settings;
  }

  /* ─── Escritura ─────────────────────────────────────────────────── */

  function saveCategories(categories) {
    if (_memCache) _memCache.categories = categories;
    return syncSet({ categories });
  }

  function saveChannelAssignments(channelAssignments) {
    if (_memCache) _memCache.channelAssignments = channelAssignments;
    return syncSet({ channelAssignments });
  }

  function saveSettings(settings) {
    if (_memCache) _memCache.settings = settings;
    return syncSet({ settings });
  }

  /* ─── Canales en caché (storage local — 5 MB) ──────────────────── */

  function cacheChannels(channels) {
    return localSet({ cachedChannels: channels, channelsCachedAt: Date.now() });
  }

  async function getCachedChannels() {
    const data = await localGet(['cachedChannels', 'channelsCachedAt']);
    return { channels: data.cachedChannels || [], cachedAt: data.channelsCachedAt || 0 };
  }

  /* ─── CRUD Categorías ──────────────────────────────────────────── */

  async function addCategory(name, color = '#4285F4', emoji = '') {
    const categories = await getCategories();
    const id = generateId();
    const order = Object.keys(categories).length;
    categories[id] = { id, name, order, color, emoji, collapsed: false };
    await saveCategories(categories);
    return categories[id];
  }

  async function updateCategory(id, updates) {
    const categories = await getCategories();
    if (!categories[id]) return null;
    categories[id] = { ...categories[id], ...updates };
    await saveCategories(categories);
    return categories[id];
  }

  async function deleteCategory(id) {
    const [categories, channelAssignments] = await Promise.all([
      getCategories(),
      getChannelAssignments(),
    ]);

    delete categories[id];

    // Reasignar orden
    Object.values(categories)
      .sort((a, b) => a.order - b.order)
      .forEach((cat, i) => (cat.order = i));

    // Eliminar de todas las asignaciones
    for (const channelId of Object.keys(channelAssignments)) {
      channelAssignments[channelId] = channelAssignments[channelId].filter(
        (catId) => catId !== id
      );
      if (channelAssignments[channelId].length === 0) {
        delete channelAssignments[channelId];
      }
    }

    await Promise.all([saveCategories(categories), saveChannelAssignments(channelAssignments)]);
  }

  async function reorderCategories(orderedIds) {
    const categories = await getCategories();
    orderedIds.forEach((id, index) => {
      if (categories[id]) categories[id].order = index;
    });
    await saveCategories(categories);
  }

  /* ─── Asignaciones canal ↔ categoría ──────────────────────────── */

  async function assignChannel(channelId, categoryId) {
    const channelAssignments = await getChannelAssignments();
    if (!channelAssignments[channelId]) channelAssignments[channelId] = [];
    if (!channelAssignments[channelId].includes(categoryId)) {
      channelAssignments[channelId].push(categoryId);
    }
    await saveChannelAssignments(channelAssignments);
  }

  async function unassignChannel(channelId, categoryId) {
    const channelAssignments = await getChannelAssignments();
    if (!channelAssignments[channelId]) return;
    channelAssignments[channelId] = channelAssignments[channelId].filter(
      (id) => id !== categoryId
    );
    if (channelAssignments[channelId].length === 0) {
      delete channelAssignments[channelId];
    }
    await saveChannelAssignments(channelAssignments);
  }

  async function toggleChannelCategory(channelId, categoryId) {
    const channelAssignments = await getChannelAssignments();
    const current = channelAssignments[channelId] || [];
    if (current.includes(categoryId)) {
      await unassignChannel(channelId, categoryId);
      return false;
    } else {
      await assignChannel(channelId, categoryId);
      return true;
    }
  }

  /* ─── Reactividad ───────────────────────────────────────────────── */

  function onChange(callback) {
    try {
      chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName === 'sync') {
          // Invalidar caché cuando cambia el storage remoto (otro dispositivo / popup)
          invalidateCache();
          try { callback(changes); } catch (e) {
            console.warn('[YCSM] onChange callback error:', e.message);
          }
        }
      });
    } catch (e) {
      console.warn('[YCSM] onChange registration error:', e.message);
    }
  }

  /* ─── Export ────────────────────────────────────────────────────── */

  window.YCSM.storage = {
    getAll,
    getCategories,
    getChannelAssignments,
    getSettings,
    saveCategories,
    saveChannelAssignments,
    saveSettings,
    cacheChannels,
    getCachedChannels,
    addCategory,
    updateCategory,
    deleteCategory,
    reorderCategories,
    assignChannel,
    unassignChannel,
    toggleChannelCategory,
    onChange,
    invalidateCache,
  };
})();
