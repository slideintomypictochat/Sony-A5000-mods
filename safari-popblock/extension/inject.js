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
  // see every real tap first. `down*` is where the finger first touched.
  let gesture = { t: 0, target: null, link: null, href: null, interactive: false, downTarget: null, downT: 0 };

  const INTERACTIVE = 'button,input,select,textarea,label,summary,[role="button"],[role="link"],[role="menuitem"],[role="tab"],[contenteditable]';

  const closestLink = (el) => (el && el.closest ? el.closest('a[href],area[href]') : null);

  const recordGesture = (el, link) => {
    gesture = {
      t: now(),
      target: el,
      link,
      href: link ? link.href : null,
      interactive: !!(el && el.closest && el.closest(INTERACTIVE)),
      downTarget: el,
      downT: now(),
    };
  };

  const onPointer = (e) => {
    if (!e.isTrusted) return;
    const el = e.target instanceof Element ? e.target : null;
    if (e.type === 'mousedown') {
      // Fired after touchstart, by which time a script may have put something
      // else under the finger. Only refresh the time.
      gesture.t = now();
      return;
    }
    const link = closestLink(el);
    if (e.type !== 'click') return recordGesture(el, link);

    gesture.t = now();
    // Only a click follows a link, so that is where a hijack is stopped.
    if (state.enabled && el && blockTapHijack(el, link)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    if (link !== gesture.link) {
      const { downTarget, downT } = gesture;
      recordGesture(el, link);
      Object.assign(gesture, { downTarget, downT });
    }
  };

  const hasGesture = (ms = GESTURE_MS) => now() - gesture.t < ms;

  ['pointerdown', 'touchstart', 'mousedown', 'keydown'].forEach((type) =>
    window.addEventListener(type, onPointer, { capture: true, passive: true })
  );
  window.addEventListener('click', onPointer, { capture: true });

  // ---- Tap hijacks ---------------------------------------------------------
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

  // An empty, see-through link that opens a new tab, laid over something
  // else (usually a video player) so a tap on that thing opens an ad.
  const isGhostLink = (link) => {
    if (hasVisibleContent(link)) return false;
    const target = (link.getAttribute('target') || '').toLowerCase();
    if (target !== '_blank' && target !== '_new') return false;
    const r = link.getBoundingClientRect();
    return r.width * r.height >= 2500 && isTransparent(getComputedStyle(link));
  };

  // Inside a third-party frame (an ad slot), a link without text that leads
  // to a third site is an ad banner.
  const frameSite = siteOf(location.hostname);
  const isAdFrameLink = (link) =>
    window.top !== window &&
    frameSite !== homeSite &&
    targetSite(link.href) !== frameSite &&
    !(link.textContent || '').trim();

  const hide = (el) => {
    el.style.setProperty('display', 'none', 'important');
    el.style.setProperty('pointer-events', 'none', 'important');
  };

  // Called on every real click. Returns true when the click was a hijack.
  const blockTapHijack = (el, link) => {
    if (!link || isSameSite(link.href)) return false;
    let kind = null;
    let culprit = link;
    const layer = findTapLayer(el, true);
    if (layer) {
      kind = 'tap-layer';
      culprit = layer;
    } else if (now() - gesture.downT < GESTURE_MS && gesture.downTarget && !link.contains(gesture.downTarget)) {
      // The finger went down on something else; this link was slipped in.
      kind = 'link-under-finger';
    } else if (isGhostLink(link)) {
      kind = 'ghost-link';
    } else if (state.strict && isAdFrameLink(link)) {
      kind = 'ad-frame-link';
    }
    if (!kind) return false;
    hide(culprit);
    report(kind, link.href);
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

  // ---- Policies ------------------------------------------------------------
  const shouldAllowOpen = (url) => {
    if (!state.enabled) return true;
    if (!hasGesture()) return false; // no tap at all: always spam
    const site = url == null || url === '' ? 'about:blank' : targetSite(url);
    if (site === homeSite) return true;
    // A blank window is how pop-unders start: they point it at the ad later.
    if (site === 'about:blank') return !state.strict && gesture.interactive;
    if (gesture.href && site === targetSite(gesture.href)) return true;
    if (!gesture.interactive) return false; // tap on plain text, image, video, background
    if (!state.strict) return true;
    return TRUSTED_POPUP_SITES.has(site);
  };

  // a.click() / dispatchEvent(new MouseEvent('click')) on a link, or
  // form.submit(), triggered by script without a real tap on that link.
  const allowScriptedNav = (url) => {
    if (!state.enabled || isSameSite(url)) return true;
    if (!hasGesture()) return false;
    return !!gesture.href && targetSite(gesture.href) === targetSite(url);
  };

  // ---- Guarded APIs --------------------------------------------------------
  // Ad scripts grab untouched copies of these from a fresh <iframe>, so every
  // same-origin frame window gets the same guards as the page.
  const guardRealm = (win) => {
    try {
      if (!win || win.__popblockRealm) return;
      Object.defineProperty(win, '__popblockRealm', { value: true });
    } catch (_) {
      return; // cross-origin frame: it runs its own copy of this guard
    }

    const realOpen = win.open;
    const guardedOpen = function open(url) {
      if (shouldAllowOpen(url)) {
        let abs = '';
        try {
          abs = url == null ? '' : new URL(String(url), location.href).href;
        } catch (_) {}
        report('allow-open', abs);
        return realOpen.apply(win, arguments);
      }
      report('popup', url == null ? '' : String(url));
      removeLayerAfterBlock();
      return fakeWindow();
    };
    try {
      Object.defineProperty(win, 'open', { value: guardedOpen, writable: false, configurable: false });
    } catch (_) {
      win.open = guardedOpen;
    }

    // HTMLElement, not HTMLAnchorElement: HTMLElement.prototype.click.call(a)
    // would otherwise skip the check.
    const elProto = win.HTMLElement.prototype;
    const realClick = elProto.click;
    elProto.click = function click() {
      const link = closestLink(this);
      if (link && !allowScriptedNav(link.href)) {
        report('scripted-link', link.href);
        return;
      }
      return realClick.apply(this, arguments);
    };

    const targetProto = win.EventTarget.prototype;
    const realDispatch = targetProto.dispatchEvent;
    targetProto.dispatchEvent = function dispatchEvent(event) {
      if (event && event.type === 'click' && this && this.nodeType === 1) {
        const link = closestLink(this);
        if (link && !allowScriptedNav(link.href)) {
          report('scripted-link', link.href);
          return false;
        }
      }
      return realDispatch.apply(this, arguments);
    };

    const formProto = win.HTMLFormElement.prototype;
    const realSubmit = formProto.submit;
    formProto.submit = function submit() {
      if (!allowScriptedNav(this.action)) {
        report('scripted-form', this.action);
        return;
      }
      return realSubmit.apply(this, arguments);
    };

    const frameProto = win.HTMLIFrameElement.prototype;
    ['contentWindow', 'contentDocument'].forEach((prop) => {
      const desc = Object.getOwnPropertyDescriptor(frameProto, prop);
      if (!desc || !desc.get) return;
      Object.defineProperty(frameProto, prop, {
        configurable: true,
        enumerable: desc.enumerable,
        get() {
          const value = desc.get.call(this);
          guardRealm(prop === 'contentWindow' ? value : value && value.defaultView);
          return value;
        },
      });
    });

    // Also reach frames used through window.frames[i] right after insertion.
    const guardInsertedFrames = (node) => {
      if (!node || node.nodeType !== 1) return;
      if (node.nodeName === 'IFRAME') guardRealm(node.contentWindow);
      else if (node.firstElementChild) Array.prototype.forEach.call(node.getElementsByTagName('iframe'), (f) => guardRealm(f.contentWindow));
    };
    const nodeProto = win.Node.prototype;
    ['appendChild', 'insertBefore', 'replaceChild'].forEach((name) => {
      const real = nodeProto[name];
      nodeProto[name] = function (node) {
        const result = real.apply(this, arguments);
        guardInsertedFrames(node);
        return result;
      };
    });
    const elementProto = win.Element.prototype;
    ['append', 'prepend', 'after', 'before', 'replaceWith'].forEach((name) => {
      const real = elementProto[name];
      if (typeof real !== 'function') return;
      elementProto[name] = function () {
        const result = real.apply(this, arguments);
        Array.prototype.forEach.call(arguments, guardInsertedFrames);
        return result;
      };
    });
  };
  guardRealm(window);

  // ---- Redirects of the current tab ----------------------------------------
  // location.href = ad after a tap (often paired with opening the real page in
  // a new tab, a "tab-under"). Needs the Navigation API (Safari 26+).
  const REDIRECT_GESTURE_MS = 2000;
  if (window.top === window && window.navigation && window.navigation.addEventListener) {
    window.navigation.addEventListener('navigate', (e) => {
      if (!state.enabled || !e.cancelable || e.userInitiated || e.formData) return;
      if (e.navigationType !== 'push' && e.navigationType !== 'replace') return;
      const url = e.destination.url;
      if (isSameSite(url)) return;
      let block = isAdUrl(url);
      if (!block && hasGesture(REDIRECT_GESTURE_MS)) {
        const site = targetSite(url);
        if (gesture.href) block = site !== targetSite(gesture.href);
        else if (!gesture.interactive) block = true;
        else block = state.strict && !TRUSTED_POPUP_SITES.has(site);
      }
      if (block) {
        e.preventDefault();
        report('redirect', url);
      }
    });
  }

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

  // ---- Ad loads and banners ------------------------------------------------
  // BEGIN AD DOMAINS (generated by tools/build.py from tools/domains.txt)
  const AD_DOMAINS = [
    "popads.net",
    "popcash.net",
    "popmyads.com",
    "propellerads.com",
    "propellerclick.com",
    "onclickads.net",
    "onclkds.com",
    "onclickmax.com",
    "onclickperformance.com",
    "adsterra.com",
    "highperformanceformat.com",
    "monetag.com",
    "exoclick.com",
    "exosrv.com",
    "exdynsrv.com",
    "juicyads.com",
    "trafficjunky.net",
    "trafficjunky.com",
    "trafficstars.com",
    "tsyndicate.com",
    "trafficfactory.biz",
    "hilltopads.net",
    "hilltopads.com",
    "clickadu.com",
    "clickadilla.com",
    "clickaine.com",
    "adcash.com",
    "admaven.com",
    "ad-maven.com",
    "galaksion.com",
    "zeropark.com",
    "richads.com",
    "rollerads.com",
    "pushground.com",
    "evadav.com",
    "adnium.com",
    "yllix.com",
    "plugrush.com",
    "realsrv.com",
    "ero-advertising.com",
    "adxpansion.com",
    "bidvertiser.com",
    "revenuehits.com",
    "adskeeper.co.uk",
    "adskeeper.com",
    "mgid.com",
    "revcontent.com",
    "popunder.net",
    "directrev.com",
    "admeking.com",
    "doubleclick.net",
    "googlesyndication.com",
    "googleadservices.com",
    "adservice.google.com",
    "amazon-adsystem.com",
    "adnxs.com",
    "criteo.com",
    "criteo.net",
    "pubmatic.com",
    "rubiconproject.com",
    "openx.net",
    "casalemedia.com",
    "advertising.com",
    "adform.net",
    "smartadserver.com",
    "media.net",
    "zedo.com",
    "serving-sys.com",
    "adsrvr.org",
    "bidswitch.net",
    "33across.com",
    "sharethrough.com",
    "teads.tv",
    "taboola.com",
    "outbrain.com",
    "moatads.com",
    "infolinks.com",
    "yieldmo.com",
    "adroll.com",
    "contextweb.com",
    "indexww.com",
    "lijit.com",
    "sovrn.com",
    "undertone.com",
    "spotxchange.com",
    "spotx.tv",
    "scorecardresearch.com",
    "quantserve.com",
    "magsrv.com",
    "pemsrv.com",
    "orbsrv.com",
    "crakrevenue.com",
    "adspyglass.com",
    "jads.co",
    "a-ads.com",
    "adsco.re",
  ];
  // END AD DOMAINS
  const adDomains = new Set(AD_DOMAINS);
  const isAdUrl = (url) => {
    let host;
    try {
      host = new URL(String(url), location.href).hostname.toLowerCase();
    } catch (_) {
      return false;
    }
    for (;;) {
      if (adDomains.has(host)) return true;
      const dot = host.indexOf('.');
      if (dot < 0) return false;
      host = host.slice(dot + 1);
    }
  };

  // Stop scripts, frames and images from ad networks being added by script.
  const AD_LOADERS = [window.HTMLScriptElement, window.HTMLIFrameElement, window.HTMLImageElement];
  AD_LOADERS.forEach((cls) => {
    const desc = cls && Object.getOwnPropertyDescriptor(cls.prototype, 'src');
    if (!desc || !desc.set) return;
    Object.defineProperty(cls.prototype, 'src', {
      configurable: true,
      enumerable: desc.enumerable,
      get: desc.get,
      set(value) {
        if (state.enabled && isAdUrl(value)) {
          report('ad-request', String(value));
          return;
        }
        desc.set.call(this, value);
      },
    });
  });
  const realSetAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function setAttribute(name, value) {
    if (
      state.enabled &&
      String(name).toLowerCase() === 'src' &&
      AD_LOADERS.some((cls) => cls && this instanceof cls) &&
      isAdUrl(value)
    ) {
      report('ad-request', String(value));
      return;
    }
    return realSetAttribute.apply(this, arguments);
  };

  // Standard ad banner sizes (width x height), matched within 15%.
  const AD_SIZES = [
    [300, 250], [336, 280], [728, 90], [970, 90], [970, 250], [320, 50],
    [320, 100], [300, 100], [468, 60], [160, 600], [120, 600], [300, 600], [900, 250],
  ];
  const isAdSize = (w, h) =>
    AD_SIZES.some(([aw, ah]) => Math.abs(w - aw) <= aw * 0.15 && Math.abs(h - ah) <= ah * 0.15);

  const hideAd = (el, url) => {
    if (el.hasAttribute('data-popblock-hidden')) return;
    el.setAttribute('data-popblock-hidden', '');
    hide(el);
    report('ad', url);
  };

  // Hides links, frames and images that lead to ad networks, and banner-sized
  // images or frames that link off-site.
  const checkForAd = (el) => {
    if (el.hasAttribute('data-popblock-hidden')) return;
    if (el.tagName === 'IFRAME') {
      const src = el.src;
      if (!src) return;
      if (isAdUrl(src)) return hideAd(el, src);
      if (!isSameSite(src) && !el.allowFullscreen && isAdSize(el.offsetWidth, el.offsetHeight)) hideAd(el, src);
    } else if (el.tagName === 'IMG') {
      if (isAdUrl(el.currentSrc || el.src)) hideAd(el, el.src);
    } else {
      const href = el.href;
      if (isAdUrl(href)) return hideAd(el, href);
      if (isSameSite(href) || (el.textContent || '').trim()) return;
      const media = el.querySelector('img,video,picture,canvas');
      if (media && isAdSize(media.offsetWidth, media.offsetHeight)) hideAd(el, href);
    }
  };

  let scanQueued = false;
  const scanForAds = () => {
    scanQueued = false;
    if (!state.enabled || !document.body) return;
    document.body.querySelectorAll('a[href],iframe,img').forEach(checkForAd);
  };
  const queueScan = () => {
    if (scanQueued) return;
    scanQueued = true;
    setTimeout(scanForAds, 250);
  };
  new MutationObserver(queueScan).observe(document.documentElement || document, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src', 'href'],
  });
  // Image and frame sizes are only known once they load.
  document.addEventListener('load', queueScan, true);
  document.addEventListener('DOMContentLoaded', queueScan);
  window.addEventListener('load', queueScan);

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
