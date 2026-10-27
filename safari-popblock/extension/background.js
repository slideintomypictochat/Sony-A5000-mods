/*
 * PopBlock background script.
 *
 * Catches what a page script can do without window.open:
 *   - New tabs the user did not ask for  -> closed.
 *   - The current tab jumping to another site right after a tap on something
 *     that is not a link or button (tap-jacking)  -> sent back.
 *   - Navigation to a blocklisted ad/redirect network  -> sent back / closed.
 * Network-level blocking itself is done by the declarativeNetRequest rules.
 */
const api = globalThis.browser ?? globalThis.chrome;

const GESTURE_MS = 1500;
const EXPECT_MS = 10000;

const MULTI_PART_TLD = /\.(co|com|net|org|gov|edu|ac|or|ne|go|gv)\.[a-z]{2}$/;
function siteOf(url) {
  let host;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    host = u.hostname.toLowerCase().replace(/^www\./, '');
  } catch (_) {
    return '';
  }
  if (/^[\d.]+$/.test(host) || host.includes(':')) return host;
  const parts = host.split('.');
  const n = MULTI_PART_TLD.test('.' + parts.slice(-3).join('.')) ? 3 : 2;
  return parts.slice(-n).join('.');
}

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch (_) {
    return '';
  }
}

// ---- Blocklist (shared with the declarativeNetRequest rules) ---------------
let blockedDomains = null;
async function loadBlocklist() {
  if (blockedDomains) return blockedDomains;
  try {
    const rules = await (await fetch(api.runtime.getURL('rules/ad_networks.json'))).json();
    blockedDomains = new Set(
      rules.map((r) => (r.condition.urlFilter || '').replace(/^\|\|/, '').replace(/\^$/, '')).filter(Boolean)
    );
  } catch (_) {
    blockedDomains = new Set();
  }
  return blockedDomains;
}
function isBlocklisted(url) {
  let host = hostOf(url);
  if (!blockedDomains || !host) return false;
  for (;;) {
    if (blockedDomains.has(host)) return true;
    const dot = host.indexOf('.');
    if (dot < 0) return false;
    host = host.slice(dot + 1);
  }
}
loadBlocklist();

// ---- Settings ---------------------------------------------------------------
async function settings() {
  return api.storage.local.get({ allowlist: [], strict: true, totalBlocked: 0 });
}
function isAllowlisted(cfg, url) {
  const host = hostOf(url);
  return !!host && cfg.allowlist.some((h) => host === h || host.endsWith('.' + h));
}

// ---- Per-tab state -----------------------------------------------------------
// Kept in memory; the worker may be restarted, which only resets counters.
const tabs = new Map();
function tabState(tabId) {
  let s = tabs.get(tabId);
  if (!s) {
    s = { url: '', prevUrl: '', gesture: null, expected: [], blocked: 0 };
    tabs.set(tabId, s);
  }
  return s;
}

async function countBlock(tabId, kind, url) {
  if (tabId != null && tabId >= 0) tabState(tabId).blocked++;
  const cfg = await settings();
  await api.storage.local.set({ totalBlocked: cfg.totalBlocked + 1 });
  console.debug('[PopBlock]', kind, url);
}

function expects(s, url) {
  const site = siteOf(url);
  const t = Date.now();
  s.expected = s.expected.filter((e) => t - e.t < EXPECT_MS);
  return s.expected.some((e) => e.site === site);
}

// ---- Messages from content scripts and the popup ---------------------------
api.runtime.onMessage.addListener((msg, sender) => {
  const tabId = sender.tab ? sender.tab.id : msg.tabId;
  switch (msg.type) {
    case 'gesture': {
      const s = tabState(tabId);
      s.gesture = { t: Date.now(), href: msg.href, interactive: msg.interactive };
      if (msg.top && msg.frameUrl) s.url = s.url || msg.frameUrl;
      if (msg.href) s.expected.push({ site: siteOf(msg.href), t: Date.now() });
      return;
    }
    case 'expect':
      if (msg.url) tabState(tabId).expected.push({ site: siteOf(msg.url), t: Date.now() });
      return;
    case 'blocked':
      countBlock(tabId, msg.kind, msg.url);
      return;
    case 'stats':
      return settings().then((cfg) => ({
        blocked: tabs.has(msg.tabId) ? tabs.get(msg.tabId).blocked : 0,
        total: cfg.totalBlocked,
      }));
  }
});

// ---- Unwanted new tabs -------------------------------------------------------
const pendingTabs = new Map(); // new tabId -> { opener, created }

api.tabs.onCreated.addListener((tab) => {
  if (tab.openerTabId == null) return; // opened by the user, not by a page
  pendingTabs.set(tab.id, { opener: tab.openerTabId, created: Date.now() });
  if (tab.url || tab.pendingUrl) judgeNewTab(tab.id, tab.pendingUrl || tab.url);
});

api.tabs.onUpdated.addListener((tabId, info) => {
  if (info.url && pendingTabs.has(tabId)) judgeNewTab(tabId, info.url);
});

async function judgeNewTab(tabId, url) {
  const pending = pendingTabs.get(tabId);
  if (!pending || !url || url === 'about:blank') return;
  if (Date.now() - pending.created > 5000) {
    pendingTabs.delete(tabId);
    return;
  }
  pendingTabs.delete(tabId);
  await loadBlocklist();
  const cfg = await settings();
  const opener = tabState(pending.opener);
  if (opener.url && isAllowlisted(cfg, opener.url)) return;

  let unwanted = isBlocklisted(url);
  if (!unwanted && siteOf(url) && siteOf(url) !== siteOf(opener.url)) {
    unwanted = !expects(opener, url);
  }
  if (!unwanted) return;
  try {
    await api.tabs.remove(tabId);
    if (pending.opener != null) await api.tabs.update(pending.opener, { active: true });
  } catch (_) {}
  countBlock(pending.opener, 'new-tab', url);
}

api.tabs.onRemoved.addListener((tabId) => {
  tabs.delete(tabId);
  pendingTabs.delete(tabId);
});

// ---- Same-tab hijacks --------------------------------------------------------
api.webNavigation.onCommitted.addListener((d) => {
  if (d.frameId !== 0) return;
  const s = tabState(d.tabId);
  if (s.url !== d.url) {
    s.prevUrl = s.url;
    s.url = d.url;
  }
});

api.webNavigation.onBeforeNavigate.addListener(async (d) => {
  if (d.frameId !== 0) return;
  const s = tabState(d.tabId);
  const from = s.url;
  if (!from || siteOf(d.url) === siteOf(from) || !siteOf(d.url)) return;
  await loadBlocklist();
  const cfg = await settings();
  if (isAllowlisted(cfg, from)) return;

  let hijack = isBlocklisted(d.url);
  if (!hijack && cfg.strict && s.gesture && Date.now() - s.gesture.t < GESTURE_MS) {
    // A tap on plain page content (not a link, button or form field) should
    // never take the user to another website.
    hijack = !s.gesture.href && !s.gesture.interactive && !expects(s, d.url);
  }
  if (!hijack) return;

  s.gesture = null;
  if (pendingTabs.has(d.tabId)) return judgeNewTab(d.tabId, d.url);
  try {
    await api.tabs.update(d.tabId, { url: from });
  } catch (_) {}
  countBlock(d.tabId, 'redirect', d.url);
});
