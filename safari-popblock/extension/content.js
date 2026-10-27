/*
 * PopBlock content script (extension's isolated world).
 *
 * - Makes sure the page guard (inject.js) is running, and sends it settings.
 * - Tells the background script about real taps, so it can tell a link the
 *   user chose apart from a redirect or new tab the page forced.
 * - Forwards what the page guard blocked, for the counters in the popup.
 */
(() => {
  'use strict';
  const api = globalThis.browser ?? globalThis.chrome;
  if (!api || !api.runtime) return;

  const send = (msg) => {
    try {
      const p = api.runtime.sendMessage(msg);
      if (p && p.catch) p.catch(() => {});
    } catch (_) {}
  };

  // Safari versions without "world": "MAIN" content scripts run inject.js in
  // this isolated world, where it guards nothing. Load it into the page then.
  if (!document.documentElement || !document.documentElement.hasAttribute('data-popblock')) {
    try {
      const s = document.createElement('script');
      s.src = api.runtime.getURL('inject.js');
      s.onload = () => s.remove();
      (document.head || document.documentElement).appendChild(s);
    } catch (_) {}
  }

  const host = location.hostname.replace(/^www\./, '');
  let topHost = host;
  try {
    const anc = location.ancestorOrigins;
    if (anc && anc.length) topHost = new URL(anc[anc.length - 1]).hostname.replace(/^www\./, '');
  } catch (_) {}

  api.storage.local.get({ allowlist: [], strict: true }).then((cfg) => {
    const enabled = !cfg.allowlist.some((h) => topHost === h || topHost.endsWith('.' + h));
    window.dispatchEvent(
      new CustomEvent('popblock:config', { detail: JSON.stringify({ enabled, strict: cfg.strict }) })
    );
  });

  window.addEventListener(
    'popblock:report',
    (e) => {
      let detail;
      try {
        detail = JSON.parse(e.detail);
      } catch (_) {
        return;
      }
      if (detail.kind === 'allow-open') send({ type: 'expect', url: detail.url });
      else send({ type: 'blocked', kind: detail.kind, url: detail.url });
    },
    true
  );

  const INTERACTIVE = 'button,input,select,textarea,label,summary,[role="button"],[role="link"],[role="menuitem"],[role="tab"],[contenteditable]';
  const onTap = (e) => {
    if (!e.isTrusted) return;
    const el = e.target instanceof Element ? e.target : null;
    const link = el && el.closest('a[href],area[href]');
    send({
      type: 'gesture',
      href: link ? link.href : null,
      interactive: !!(el && el.closest(INTERACTIVE)),
      frameUrl: location.href,
      top: window.top === window,
    });
  };
  window.addEventListener('pointerdown', onTap, { capture: true, passive: true });
  window.addEventListener('keydown', onTap, { capture: true, passive: true });
})();
