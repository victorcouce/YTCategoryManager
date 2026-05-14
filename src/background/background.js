/**
 * background.js — Service Worker (Manifest V3)
 * Coordina comunicación entre popup, content scripts y storage.
 */

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') {
    console.log('[YCSM] Extensión instalada correctamente.');
  }
  if (reason === 'update') {
    console.log('[YCSM] Extensión actualizada.');
  }
});

/**
 * Reenvía mensajes del popup al content script de la pestaña activa.
 */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message.action) {
    case 'openPanel':
    case 'refreshSidebar':
      forwardToActiveTab(message, sendResponse);
      return true; // mantiene el canal abierto para respuesta async

    case 'getCategories':
      chrome.storage.sync.get('categories', (data) => {
        sendResponse({ categories: data.categories || {} });
      });
      return true;

    default:
      break;
  }
});

function forwardToActiveTab(message, sendResponse) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (!tab?.id) {
      sendResponse({ success: false, error: 'No active tab' });
      return;
    }
    chrome.tabs.sendMessage(tab.id, message, (response) => {
      if (chrome.runtime.lastError) {
        // El content script puede no estar listo aún — no es un error crítico
        sendResponse({ success: false, error: chrome.runtime.lastError.message });
      } else {
        sendResponse(response);
      }
    });
  });
}
