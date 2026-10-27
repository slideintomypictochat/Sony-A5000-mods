const api = globalThis.browser ?? globalThis.chrome;
const $ = (id) => document.getElementById(id);

(async () => {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  let host = '';
  try {
    const u = new URL(tab.url);
    if (u.protocol === 'http:' || u.protocol === 'https:') host = u.hostname.replace(/^www\./, '');
  } catch (_) {}

  const cfg = await api.storage.local.get({ allowlist: [], strict: true });
  $('host').textContent = host || 'No website open';
  $('site-toggle').checked = !!host && !cfg.allowlist.includes(host);
  $('site-toggle').disabled = !host;
  $('strict-toggle').checked = cfg.strict;

  const stats = await api.runtime.sendMessage({ type: 'stats', tabId: tab.id }).catch(() => null);
  if (stats) {
    $('page-count').textContent = stats.blocked;
    $('total-count').textContent = stats.total;
  }

  const changed = () => {
    $('reload-hint').hidden = false;
  };

  $('site-toggle').addEventListener('change', async (e) => {
    const { allowlist } = await api.storage.local.get({ allowlist: [] });
    const next = allowlist.filter((h) => h !== host);
    if (!e.target.checked) next.push(host);
    await api.storage.local.set({ allowlist: next });
    changed();
  });

  $('strict-toggle').addEventListener('change', async (e) => {
    await api.storage.local.set({ strict: e.target.checked });
    changed();
  });
})();
