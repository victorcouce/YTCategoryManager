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
    root.querySelectorAll('[data-i18n]').forEach((el) => {
      el.textContent = t(el.dataset.i18n);
    });
    root.querySelectorAll('[data-i18n-html]').forEach((el) => {
      el.innerHTML = t(el.dataset.i18nHtml);
    });
    root.querySelectorAll('[data-i18n-title]').forEach((el) => {
      el.setAttribute('title', t(el.dataset.i18nTitle));
    });
    root.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
      el.setAttribute('placeholder', t(el.dataset.i18nPlaceholder));
    });
    root.querySelectorAll('[data-i18n-aria-label]').forEach((el) => {
      el.setAttribute('aria-label', t(el.dataset.i18nAriaLabel));
    });
  }

  window.YCSM.i18n = { t, count, apply };
})();
