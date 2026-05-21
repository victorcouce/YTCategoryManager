/**
 * utils.js — Utilidades compartidas entre todos los contextos (content scripts, popup, panel).
 * Debe cargarse ANTES que i18n.js y storage.js.
 *
 * Centraliza helpers que estaban duplicados en sidebar.js, video-label.js,
 * popup.js, content.js, subscriptions-filter.js, panel-ui.js y storage.js.
 */
(function () {
  if (!window.YCSM) window.YCSM = {};

  /* ─── Paleta de colores ───────────────────────────────────────── */

  const HUE_PALETTE = [0, 22, 50, 90, 145, 195, 220, 260, 295, 330];

  /* ─── Escape HTML ─────────────────────────────────────────────── */

  /**
   * Escapa caracteres HTML para insertar texto de usuario en el DOM de forma segura.
   * Nunca uses innerHTML con datos de usuario sin pasar antes por esta función.
   */
  function escapeHtml(value) {
    const div = document.createElement('div');
    div.appendChild(document.createTextNode(String(value ?? '')));
    return div.innerHTML;
  }

  /* ─── Colores de categorías ───────────────────────────────────── */

  /**
   * Calcula un tono (hue 0–360) de forma determinista a partir de un string.
   * Útil para asignar colores a categorías sin hue explícito.
   */
  function hashHue(value) {
    let n = 0;
    const s = String(value || '');
    for (let i = 0; i < s.length; i++) n = (n * 31 + s.charCodeAt(i)) | 0;
    return Math.abs(n) % 360;
  }

  /**
   * Devuelve el color oklch de una categoría.
   * Soporta las propiedades `color` (hue entero, nuevo), `hue` (legacy)
   * y un hash del id/nombre como último recurso.
   */
  function categoryColor(category) {
    const hue =
      typeof category.color === 'number'
        ? category.color
        : typeof category.hue === 'number'
        ? category.hue
        : hashHue(category.id || category.name);
    return `oklch(0.72 0.16 ${hue})`;
  }

  /* ─── Detección de ruta (solo significativa en content scripts) ── */

  function isSubscriptionsPage() {
    return location.pathname === '/feed/subscriptions';
  }

  function isWatchPage() {
    return location.pathname.startsWith('/watch');
  }

  function isChannelPage() {
    return /^\/(@|channel\/|c\/|user\/)/.test(location.pathname);
  }

  /* ─── Export ──────────────────────────────────────────────────── */

  window.YCSM.utils = {
    HUE_PALETTE,
    escapeHtml,
    hashHue,
    categoryColor,
    isSubscriptionsPage,
    isWatchPage,
    isChannelPage,
  };
})();
