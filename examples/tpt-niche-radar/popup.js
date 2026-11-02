'use strict';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = (n) => (n == null ? '—' : Math.round(n).toLocaleString('en-US'));
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const TPT = /^https:\/\/([a-z0-9-]+\.)*teacherspayteachers\.com\//i;
let tab = null,
  settings = { autoSave: true, dock: true };

function status(text, error = false) {
  $('status').textContent = text;
  $('status').className = 'note' + (error ? ' error' : '');
}
function ago(t) {
  const s = (Date.now() - Date.parse(t)) / 1000;
  if (!Number.isFinite(s)) return '';
  if (s < 60) return 'now';
  if (s < 3600) return Math.round(s / 60) + 'm';
  if (s < 86400) return Math.round(s / 3600) + 'h';
  return Math.round(s / 86400) + 'd';
}

async function ask(message) {
  try {
    return await chrome.tabs.sendMessage(tab.id, message);
  } catch {
    // The tab was open before Niche Radar was installed or updated, so its scripts are not there yet.
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['capture-reader.js', 'insight-reader.js', 'companion.js'] });
    return chrome.tabs.sendMessage(tab.id, message);
  }
}

async function renderTab() {
  const body = $('tab-body');
  if (!tab?.id || !TPT.test(tab.url || '')) {
    body.innerHTML = '<p class="hint">Open Site Search Analytics in your TPT Seller Dashboard and search a keyword. Niche Radar saves what TPT shows you.</p>';
    return;
  }
  let s;
  try {
    s = await ask({ action: 'radarCompanionStatus' });
  } catch (e) {
    body.innerHTML = `<p class="hint">This page cannot be read. Reload the tab and try again.</p>`;
    return;
  }
  if (!s || s.view === 'none') {
    body.innerHTML = '<p class="hint">No keyword data on this page. In your Seller Dashboard, open Site Search Analytics and search a keyword.</p>';
    return;
  }
  const now = new Date().getMonth();
  const peak = s.insight ? MONTHS.findIndex((m) => m.toLowerCase() === String(s.insight.peak || '').slice(0, 3).toLowerCase()) : -1;
  const pages = s.position ? Math.ceil(s.position.total / Math.max(1, s.position.to - s.position.from + 1)) : null;
  const facts = s.insight
    ? `${fmt(s.insight.avg)} a month${peak >= 0 ? ` · peak ${MONTHS[peak]}${s.insight.peakShare != null ? ' ' + Math.round(s.insight.peakShare * 100) + '%' : ''}` : ''}${s.insight.weeks ? ` · ${s.insight.weeks} weeks` : ''}`
    : `${fmt(s.rows)} rows on this page${s.position ? ` · ${fmt(s.position.total)} in total` : ''}`;
  body.innerHTML = `<p class="kw">${esc(s.keyword || 'Keyword table')}</p><p class="figs">${esc(facts)}</p>${
    s.insight ? `<div class="strip">${MONTHS.map((m, i) => `<i class="${i === peak ? 'on' : ''} ${i === now ? 'now' : ''}" title="${m}"></i>`).join('')}</div>` : ''
  }<p class="state ${s.status && /saved|collected/i.test(s.status) ? 'ok' : ''}">${esc(s.collecting ? s.status || 'Collecting' : s.status || (s.autoSave && s.view === 'insight' ? 'Saves on its own' : 'Not saved yet'))}</p>
<div class="actions">${s.collecting ? '<button class="btn" id="stop">Stop and keep rows</button>' : `${s.rows && pages !== 1 ? `<button class="btn primary" id="collect">Collect ${s.position ? 'all ' + fmt(s.position.total) + ' related' : 'all pages'}</button>` : ''}<button class="btn" id="save">Save this page now</button>`}</div>`;
  $('collect')?.addEventListener('click', async () => {
    await ask({ action: 'radarCompanionCollect' });
    status('Collecting in the page. You can close this popup');
    setTimeout(renderTab, 600);
  });
  $('save')?.addEventListener('click', async () => {
    const r = await ask({ action: 'radarCompanionSave' });
    if (r?.ok) status(`Saved ${fmt(r.rows)} rows · ${fmt(r.newKeywords)} new keywords`);
    else status(r?.error || 'Could not save this page', true);
    renderTab();
  });
  $('stop')?.addEventListener('click', async () => {
    await ask({ action: 'radarStop' });
    status('Stopping. Saved rows are kept');
  });
}

async function renderRecent() {
  const { radarActivity = [] } = await chrome.storage.local.get('radarActivity');
  $('recent-block').hidden = !radarActivity.length;
  $('recent').innerHTML = radarActivity
    .slice(0, 4)
    .map((a) => `<li><span>${esc(a.seed || 'Keyword table')}</span><small>${fmt(a.rows)} rows · ${ago(a.at)}</small></li>`)
    .join('');
}

$('open-dashboard').addEventListener('click', () => chrome.runtime.sendMessage({ action: 'openDashboard' }).catch((e) => status(e.message, true)));
$('auto-save').addEventListener('click', async () => {
  settings.autoSave = !settings.autoSave;
  $('auto-save').setAttribute('aria-checked', String(settings.autoSave));
  await chrome.storage.local.set({ radarSettings: settings });
});

(async () => {
  $('version').textContent = chrome.runtime.getManifest().version;
  const { radarSettings } = await chrome.storage.local.get('radarSettings');
  settings = { ...settings, ...(radarSettings || {}) };
  $('auto-save').setAttribute('aria-checked', String(settings.autoSave));
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await Promise.all([renderTab(), renderRecent()]);
})().catch((e) => status(e.message, true));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.radarActivity) {
    renderRecent();
    renderTab();
  }
});
