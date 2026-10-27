// ==UserScript==
// @name         PopBlock
// @namespace    popblock
// @version      1.0.0
// @description  Stops pop-ups, pop-unders, tap-jacking redirects, link swapping and notification spam.
// @match        *://*/*
// @run-at       document-start
// @inject-into  page
// @grant        none
// ==/UserScript==
// Generated from extension/inject.js by tools/build.py - edit that file instead.

/*
 * PopBlock page guard.
 *
 * Runs in the page's own JavaScript world at document_start, before any site or
 * ad script, so it can wrap the APIs that pop-up and redirect scripts abuse:
 *   - window.open            (pop-ups, pop-unders, tab-unders)
 *   - synthetic link clicks  (a.click(), dispatchEvent(click), form.submit())
 *   - link swapping          (href changed between finger-down and click)
 *   - invisible tap layers   (transparent full-screen overlays that eat taps)
 *   - notification prompts, dialog spam, back-button trapping
 *
 * The same file is used by the Safari extension and (with a header) as a
 * userscript, so it must not depend on any extension API.
 */
(() => {
  'use strict';
  if (window.__popblockGuard) return;

  const state = { enabled: true, strict: true };
  try {
    Object.defineProperty(window, '__popblockGuard', { value: true });
  } catch (_) {
    return;
  }
  try {
    document.documentElement.setAttribute('data-popblock', '1');
  } catch (_) {}

  const GESTURE_MS = 1000;
  const now = () => Date.now();

  // ---- Settings handshake with the extension's content script --------------
  // Only the first config message is accepted, so a page script cannot turn
  // the guard off later by sending its own.
  const onConfig = (e) => {
    window.removeEventListener('popblock:config', onConfig, true);
    try {
      Object.assign(state, JSON.parse(e.detail));
    } catch (_) {}
  };
  window.addEventListener('popblock:config', onConfig, true);

  const report = (kind, url) => {
    try {
      window.dispatchEvent(
        new CustomEvent('popblock:report', { detail: JSON.stringify({ kind, url: url || '' }) })
      );
    } catch (_) {}
  };

  // ---- Site helpers --------------------------------------------------------
  const MULTI_PART_TLD = /\.(co|com|net|org|gov|edu|ac|or|ne|go|gv)\.[a-z]{2}$/;
  const siteOf = (host) => {
    host = String(host || '').toLowerCase().replace(/^www\./, '');
    if (!host || /^[\d.]+$/.test(host) || host.includes(':')) return host;
    const parts = host.split('.');
    const n = MULTI_PART_TLD.test('.' + parts.slice(-3).join('.')) ? 3 : 2;
    return parts.slice(-n).join('.');
  };

  // The site the user is actually visiting. Inside an ad iframe this is the
  // top page, not the ad network, so ads cannot "open their own domain".
  const homeSite = (() => {
    try {
      const anc = location.ancestorOrigins;
      if (anc && anc.length) return siteOf(new URL(anc[anc.length - 1]).hostname);
    } catch (_) {}
    try {
      if (window.top === window) return siteOf(location.hostname);
      return siteOf(window.top.location.hostname);
    } catch (_) {
      return siteOf(location.hostname);
    }
  })();

  // Returns the site a URL leads to, or '' when it stays in the page
  // (empty, #hash, javascript:, same-origin blob:).
  const targetSite = (url) => {
    if (url == null || url === '') return '';
    let u;
    try {
      u = new URL(String(url), location.href);
    } catch (_) {
      return '';
    }
    if (u.protocol === 'javascript:') return '';
    if (u.protocol === 'blob:') {
      try {
        return siteOf(new URL(u.pathname).hostname);
      } catch (_) {
        return '';
      }
    }
    if (u.protocol === 'about:') return 'about:blank';
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return u.protocol;
    return siteOf(u.hostname);
  };

  const isSameSite = (url) => {
    const s = targetSite(url);
    return s === '' || s === homeSite;
  };

  // Sign-in, payment and share windows that legitimately open from a button.
  const TRUSTED_POPUP_SITES = new Set([
    'google.com', 'apple.com', 'icloud.com', 'microsoftonline.com', 'live.com',
    'microsoft.com', 'facebook.com', 'paypal.com', 'stripe.com', 'github.com',
    'twitter.com', 'x.com', 'linkedin.com', 'discord.com', 'amazon.com',
    'shopify.com', 'klarna.com', 'pinterest.com', 'reddit.com', 'whatsapp.com',
    'youtube.com', 'spotify.com', 'twitch.tv', 'okta.com', 'auth0.com',
  ]);

  // ---- Gesture tracking ----------------------------------------------------
  // Registered on window in the capture phase before any page script, so these
  // see every real tap first.
  let gesture = { t: 0, target: null, link: null, href: null, interactive: false };

  const INTERACTIVE = 'button,input,select,textarea,label,summary,[role="button"],[role="link"],[role="menuitem"],[role="tab"],[contenteditable]';

  const closestLink = (el) => (el && el.closest ? el.closest('a[href],area[href]') : null);

  const onPointer = (e) => {
    if (!e.isTrusted) return;
    const el = e.target instanceof Element ? e.target : null;
    const link = closestLink(el);
    if (e.type !== 'click' || !gesture.link || gesture.link !== link) {
      gesture = {
        t: now(),
        target: el,
        link,
        href: link ? link.href : null,
        interactive: !!(el && el.closest && el.closest(INTERACTIVE)),
      };
    } else {
      gesture.t = now();
    }
    // Only a click follows a link, so that is where a tap layer is stopped.
    if (e.type === 'click' && state.enabled && el && neutralizeTapLayer(el, link)) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  };

  const hasGesture = () => now() - gesture.t < GESTURE_MS;

  ['pointerdown', 'touchstart', 'mousedown', 'keydown'].forEach((type) =>
    window.addEventListener(type, onPointer, { capture: true, passive: true })
  );
  window.addEventListener('click', onPointer, { capture: true });

  // ---- Invisible tap layers ------------------------------------------------
  const isTransparent = (cs) =>
    parseFloat(cs.opacity) < 0.05 ||
    ((cs.backgroundColor === 'transparent' || cs.backgroundColor === 'rgba(0, 0, 0, 0)') &&
      cs.backgroundImage === 'none');

  const hasVisibleContent = (el) =>
    !!(el.textContent && el.textContent.trim()) ||
    !!el.querySelector('img,video,canvas,svg,picture,input,button,select,textarea');

  const coversViewport = (el, cs) => {
    if (cs.position !== 'fixed' && cs.position !== 'absolute') return false;
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    const w = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
    const h = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
    return w * h >= vw * vh * 0.4;
  };

  // A large positioned layer that is invisible, or that is a bare link to
  // another site, is a click-jacking layer. Walk up a few levels because the
  // tapped node is often a child of the layer.
  const findTapLayer = (el, requireLink) => {
    for (let i = 0; el && i < 4; i++, el = el.parentElement) {
      if (el === document.documentElement || el === document.body) return null;
      const cs = getComputedStyle(el);
      if (!coversViewport(el, cs)) continue;
      const link = closestLink(el);
      const crossLink = !!link && !isSameSite(link.href);
      if (requireLink && !crossLink) continue;
      if (isTransparent(cs) && !hasVisibleContent(el)) return el;
      if (crossLink && !hasVisibleContent(el)) return el;
    }
    return null;
  };

  const hide = (el) => {
    el.style.setProperty('display', 'none', 'important');
    el.style.setProperty('pointer-events', 'none', 'important');
  };

  // Called on every real tap: only removes layers that would navigate away.
  const neutralizeTapLayer = (el, link) => {
    if (!link || isSameSite(link.href)) return false;
    const layer = findTapLayer(el, true);
    if (!layer) return false;
    hide(layer);
    report('tap-layer', link.href);
    return true;
  };

  // Called after a pop-up was blocked: the tapped layer was only there to
  // trigger it, so remove it and the user's next tap reaches the page.
  const removeLayerAfterBlock = () => {
    if (!gesture.target || !hasGesture()) return;
    const layer = findTapLayer(gesture.target, false);
    if (layer) hide(layer);
  };

  // ---- Fake window returned for blocked pop-ups ----------------------------
  // Pop-under scripts check whether window.open returned a window and, if not,
  // redirect the current tab instead. Returning a convincing fake stops that.
  const fakeWindow = () => {
    const noop = function () {};
    const loc = { href: 'about:blank', assign: noop, replace: noop, reload: noop, toString: () => 'about:blank' };
    const doc = { write: noop, writeln: noop, open: noop, close: noop, location: loc, body: null };
    return new Proxy(Object.create(null), {
      get(_, key) {
        if (key === 'closed') return false;
        if (key === 'location') return loc;
        if (key === 'document') return doc;
        if (key === 'opener' || key === 'parent' || key === 'top') return null;
        if (key === 'length') return 0;
        if (typeof key === 'symbol') return undefined;
        return noop;
      },
      set: () => true,
      has: () => true,
    });
  };

  // ---- window.open ---------------------------------------------------------
  const realOpen = window.open;

  const shouldAllowOpen = (url) => {
    if (!state.enabled) return true;
    if (!hasGesture()) return false; // no tap at all: always spam
    if (gesture.href) {
      const want = targetSite(gesture.href);
      const got = targetSite(url);
      if (got === want || got === '' || got === 'about:blank') return true;
    }
    const site = targetSite(url);
    if (site === homeSite) return true;
    if (!gesture.interactive) return false; // tap on plain text, image, background
    if (!state.strict) return true;
    return TRUSTED_POPUP_SITES.has(site) && site !== 'about:blank';
  };

  const guardedOpen = function open(url, name, features) {
    if (shouldAllowOpen(url)) {
      report('allow-open', url == null ? '' : new URL(String(url), location.href).href);
      return realOpen.apply(this === undefined ? window : this, arguments);
    }
    report('popup', url == null ? '' : String(url));
    removeLayerAfterBlock();
    return fakeWindow();
  };
  try {
    Object.defineProperty(window, 'open', { value: guardedOpen, writable: false, configurable: false });
  } catch (_) {
    window.open = guardedOpen;
  }

  // ---- Synthetic link clicks and form submits ------------------------------
  // a.click() / dispatchEvent(new MouseEvent('click')) on a link, or
  // form.submit(), triggered by script without a real tap on that link.
  const allowScriptedNav = (url) => {
    if (!state.enabled || isSameSite(url)) return true;
    if (!hasGesture()) return false;
    return !!gesture.href && targetSite(gesture.href) === targetSite(url);
  };

  const anchorProto = HTMLAnchorElement.prototype;
  const realAnchorClick = anchorProto.click;
  anchorProto.click = function click() {
    if (!allowScriptedNav(this.href)) {
      report('scripted-link', this.href);
      return;
    }
    return realAnchorClick.apply(this, arguments);
  };

  const realDispatch = EventTarget.prototype.dispatchEvent;
  EventTarget.prototype.dispatchEvent = function dispatchEvent(event) {
    if (event && event.type === 'click' && this instanceof Element) {
      const link = closestLink(this);
      if (link && !allowScriptedNav(link.href)) {
        report('scripted-link', link.href);
        return false;
      }
    }
    return realDispatch.apply(this, arguments);
  };

  const formProto = HTMLFormElement.prototype;
  const realSubmit = formProto.submit;
  formProto.submit = function submit() {
    if (!allowScriptedNav(this.action)) {
      report('scripted-form', this.action);
      return;
    }
    return realSubmit.apply(this, arguments);
  };

  // ---- Link swapping -------------------------------------------------------
  // Some scripts rewrite a link's href on finger-down so the tap lands on an ad.
  // Put the original back just before the browser follows the link.
  const restoreSwappedLink = (e) => {
    if (!state.enabled || !e.isTrusted || e.defaultPrevented) return;
    const link = closestLink(e.target);
    if (!link || link !== gesture.link || !gesture.href) return;
    if (link.href !== gesture.href && !isSameSite(link.href) && targetSite(link.href) !== targetSite(gesture.href)) {
      report('link-swap', link.href);
      link.setAttribute('href', gesture.href);
    }
  };
  window.addEventListener('click', restoreSwappedLink, true);
  window.addEventListener('click', restoreSwappedLink, false);

  // ---- Notification spam ---------------------------------------------------
  if (window.Notification && Notification.requestPermission) {
    const realRequest = Notification.requestPermission.bind(Notification);
    Notification.requestPermission = function requestPermission(cb) {
      if (state.enabled && state.strict && Notification.permission === 'default') {
        report('notification', location.href);
        if (typeof cb === 'function') cb('denied');
        return Promise.resolve('denied');
      }
      return realRequest(cb);
    };
  }

  // ---- Dialog spam ("You won an iPhone!" loops) ----------------------------
  const dialogTimes = [];
  ['alert', 'confirm', 'prompt'].forEach((name) => {
    const real = window[name];
    if (typeof real !== 'function') return;
    window[name] = function () {
      if (state.enabled) {
        const t = now();
        while (dialogTimes.length && t - dialogTimes[0] > 10000) dialogTimes.shift();
        if (dialogTimes.length >= 2 && !hasGesture()) {
          report('dialog', location.href);
          return name === 'confirm' ? false : name === 'prompt' ? null : undefined;
        }
        dialogTimes.push(t);
      }
      return real.apply(window, arguments);
    };
  });

  // ---- Back-button trapping ------------------------------------------------
  // Scam pages push dozens of history entries so Back never leaves the site.
  const pushTimes = [];
  const realPush = history.pushState;
  history.pushState = function pushState() {
    if (state.enabled && !hasGesture()) {
      const t = now();
      while (pushTimes.length && t - pushTimes[0] > 10000) pushTimes.shift();
      if (pushTimes.length >= 3) {
        report('history-trap', location.href);
        return history.replaceState.apply(history, arguments);
      }
      pushTimes.push(t);
    }
    return realPush.apply(history, arguments);
  };
})();
