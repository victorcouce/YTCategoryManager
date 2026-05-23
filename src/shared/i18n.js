/**
 * i18n.js — Small wrapper around chrome.i18n for extension pages and content scripts.
 */
(function () {
  if (!window.YCSM) window.YCSM = {};

  function t(key, substitutions) {
    try {
      const message = chrome.i18n.getMessage(key, substitutions);
      if (message) return message;
    } catch (_) {
      // chrome.i18n is unavailable in some local test contexts.
    }
    return key;
  }

  function count(keyPrefix, value) {
    return t(value === 1 ? `${keyPrefix}One` : `${keyPrefix}Many`, [String(value)]);
  }

  function apply(root = document) {
    try {
      document.documentElement.lang = chrome.i18n.getUILanguage?.() || 'en';
    } catch (_) {
      document.documentElement.lang = 'en';
    }
    // When a key is missing in messages.json, t() returns the key itself.
    // In that case keep the existing DOM value (markup-level fallback)
    // instead of overwriting it with the raw key.
    root.querySelectorAll('[data-i18n]').forEach((el) => {
      const k = el.dataset.i18n;
      const v = t(k);
      if (v && v !== k) el.textContent = v;
    });
    root.querySelectorAll('[data-i18n-html]').forEach((el) => {
      const k = el.dataset.i18nHtml;
      const v = t(k);
      if (v && v !== k) el.innerHTML = v;
    });
    root.querySelectorAll('[data-i18n-title]').forEach((el) => {
      const k = el.dataset.i18nTitle;
      const v = t(k);
      if (v && v !== k) el.setAttribute('title', v);
    });
    root.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
      const k = el.dataset.i18nPlaceholder;
      const v = t(k);
      if (v && v !== k) el.setAttribute('placeholder', v);
    });
    root.querySelectorAll('[data-i18n-aria-label]').forEach((el) => {
      const k = el.dataset.i18nAriaLabel;
      const v = t(k);
      if (v && v !== k) el.setAttribute('aria-label', v);
    });
  }

  window.YCSM.i18n = { t, count, apply };
})();
