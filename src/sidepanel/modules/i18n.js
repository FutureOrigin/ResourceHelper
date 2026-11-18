/**
 * ResourceHelper Internationalization (i18n) Module
 * Provides unified translation API backed by chrome.i18n with fallback support.
 */

export const i18n = {
  /**
   * Get localized message by key
   * @param {string} key - i18n message key
   * @param {string} fallback - Fallback text if key not found
   * @param {Array<string>} substitutions - Optional substitution strings
   * @returns {string} Localized text
   */
  t(key, fallback = '', substitutions = undefined) {
    try {
      if (typeof chrome !== 'undefined' && chrome.i18n && typeof chrome.i18n.getMessage === 'function') {
        const msg = chrome.i18n.getMessage(key, substitutions);
        if (msg) return msg;
      }
    } catch (e) {
      console.warn('[i18n] getMessage failed for key:', key, e);
    }
    return fallback || key;
  },

  /**
   * Translate all elements with data-i18n attribute in a root DOM container
   * @param {HTMLElement} root
   */
  applyToDOM(root = document) {
    if (!root || !root.querySelectorAll) return;
    root.querySelectorAll('[data-i18n]').forEach(el => {
      const key = el.getAttribute('data-i18n');
      if (key) {
        const text = this.t(key, el.textContent);
        if (text) el.textContent = text;
      }
    });
    root.querySelectorAll('[data-i18n-title]').forEach(el => {
      const key = el.getAttribute('data-i18n-title');
      if (key) {
        const text = this.t(key, el.getAttribute('title'));
        if (text) el.setAttribute('title', text);
      }
    });
    root.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
      const key = el.getAttribute('data-i18n-placeholder');
      if (key) {
        const text = this.t(key, el.getAttribute('placeholder'));
        if (text) el.setAttribute('placeholder', text);
      }
    });
  }
};
