/* Niche Radar companion for TPT pages. When the Site Search Analytics tab shows a keyword, it saves
   the keyword insight and the related keywords on screen into the workspace, and offers to collect
   every related page. It only reads the page and clicks pagination, never a keyword or the search
   button, so it never spends one of the searches TPT allows per day. */
(function () {
  'use strict';
  if (globalThis.__radarCompanion) return;
  globalThis.__radarCompanion = true;

  const settings = { autoSave: true, dock: true, dockCollapsed: false };
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  const localDate = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const fmt = (n) => (n == null ? '—' : Math.round(n).toLocaleString('en-US'));
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const monthIdx = (s) => MONTHS.findIndex((m) => m.toLowerCase() === String(s || '').slice(0, 3).toLowerCase());

  let current = { insight: null, table: null };
  let savedSig = '',
    pendingSig = '',
    timer = null,
    collecting = false,
    stopRequested = false,
    disconnected = false;
  const status = { text: '', tone: '', lookup: null, savedRows: 0, savedAt: '' };

  const onAnalyticsTab = () =>
    !!document.querySelector(
      '[data-testid="site-search-keyword-insights-graph"], .SellerDashboardSiteSearchAnalyticsTab, [id*="Site-Search-Analytics"], [aria-labelledby*="Site-Search-Analytics"]',
    );

  function readPage() {
    let insight = null,
      table = null;
    try {
      insight = globalThis.RadarInsightReader?.read(document) || null;
      if (insight && !insight.ready) insight = null;
    } catch {
      insight = null;
    }
    try {
      table = globalThis.RadarCaptureReader?.read(document) || null;
    } catch {
      table = null;
    }
    // A related table belongs to the keyword on screen. During a switch the two can disagree for a moment.
    if (insight && table?.seed && table.seed.toLowerCase() !== insight.keyword.toLowerCase()) table = null;
    return { insight, table };
  }

  const sigOf = ({ insight, table }) =>
    (insight ? RadarInsightReader.signature(insight) : '') + '#' + (table ? RadarCaptureReader.signature(table.rows) + '|' + (table.seed || '') : '');

  async function send(message) {
    try {
      const res = await chrome.runtime.sendMessage(message);
      if (!res?.ok) throw new Error(res?.error || 'Niche Radar did not answer.');
      return res;
    } catch (e) {
      if (/context invalidated|receiving end/i.test(e.message)) {
        disconnected = true;
        throw new Error('Niche Radar was updated. Reload this tab to reconnect.');
      }
      throw e;
    }
  }

  async function save(page = current, { manual = false } = {}) {
    const { insight, table } = page;
    if (!insight && !table) throw new Error('Nothing to save on this page yet.');
    const seed = table?.seed || insight?.keyword || '';
    const payload = {
      date: localDate(),
      seed,
      period: table?.period || (insight ? 'Last 365 days' : ''),
      insight,
      rows: table ? table.rows : [],
    };
    status.text = 'Saving';
    status.tone = '';
    render();
    // The capture is written to local extension storage first, so it is kept even if the
    // background worker is asleep or mid-update. The worker or the dashboard saves it from there.
    const id = crypto.randomUUID();
    try {
      await chrome.storage.local.set({ ['radarQueue:' + id]: { ...payload, queuedAt: new Date().toISOString() } });
    } catch (e) {
      if (/context invalidated/i.test(e.message)) {
        disconnected = true;
        throw new Error('Niche Radar was updated. Reload this tab to reconnect.');
      }
      throw e;
    }
    let res;
    try {
      const drained = await send({ action: 'radarDrain' });
      res = drained.results?.[id] || { batchRows: table ? table.rows.length : 0, newKeywords: 0 };
    } catch (e) {
      if (disconnected) throw e;
      savedSig = sigOf(page);
      status.text = 'Kept, saves when the workspace opens';
      status.tone = 'ok';
      render();
      return { ok: true, queued: true, batchRows: table ? table.rows.length : 0, newKeywords: 0 };
    }
    savedSig = sigOf(page);
    status.savedRows = res.batchRows || 0;
    status.savedAt = new Date().toISOString();
    status.text = manual || res.newKeywords ? `Saved · ${res.newKeywords} new` : 'Saved';
    status.tone = 'ok';
    lookup(insight?.keyword || seed);
    return res;
  }

  async function lookup(keyword) {
    if (!keyword) return;
    try {
      const res = await send({ action: 'radarLookup', keywords: [keyword] });
      status.lookup = res.items[0];
      render();
    } catch {
      /* the panel works without it */
    }
  }

  function scan() {
    timer = null;
    if (collecting || disconnected) return;
    const relevant = onAnalyticsTab();
    if (!relevant && !host) return;
    current = relevant ? readPage() : { insight: null, table: null };
    render();
    if (!relevant || !settings.autoSave || (!current.insight && !current.table?.seed)) return;
    const sig = sigOf(current);
    if (sig === savedSig) return;
    // Save once the page has been the same for two reads in a row, so a half rendered chart is never stored.
    if (sig === pendingSig) {
      pendingSig = '';
      save().catch(fail);
    } else {
      pendingSig = sig;
      schedule(900);
    }
  }
  function schedule(ms = 700) {
    clearTimeout(timer);
    timer = setTimeout(scan, ms);
  }
  function fail(e) {
    status.text = e.message;
    status.tone = 'error';
    render();
  }

  async function collectAll() {
    if (collecting) return;
    collecting = true;
    stopRequested = false;
    let pages = 0,
      saved = 0,
      finish = '';
    const seen = new Set();
    try {
      while (!stopRequested && pages < 50) {
        const page = readPage();
        if (!page.table) throw new Error('No keyword table found on this page.');
        const sig = RadarCaptureReader.signature(page.table.rows);
        if (seen.has(sig)) {
          finish = 'Stopped, this page was already collected';
          break;
        }
        seen.add(sig);
        const res = await save(page, { manual: true });
        pages++;
        saved = res.batchRows || saved;
        const pos = page.table.position;
        const totalPages = pos ? Math.ceil(pos.total / Math.max(1, pos.to - pos.from + 1)) : null;
        status.text = `Page ${pages}${totalPages ? ' of ' + totalPages : ''} · ${fmt(saved)} rows saved`;
        status.tone = '';
        render();
        const next = RadarCaptureReader.next(document);
        if (!next) {
          finish = `Collected ${pages} ${pages === 1 ? 'page' : 'pages'} · ${fmt(saved)} rows`;
          break;
        }
        next.click();
        let changed = false,
          last = '',
          stable = 0;
        const start = Date.now();
        while (!stopRequested && Date.now() - start < 15000) {
          await pause(350);
          try {
            const s = RadarCaptureReader.signature(RadarCaptureReader.read(document).rows);
            if (s !== sig) {
              stable = s === last ? stable + 1 : 0;
              last = s;
              if (stable >= 2) {
                changed = true;
                break;
              }
            }
          } catch {
            /* still loading */
          }
        }
        if (!changed && !stopRequested) {
          finish = 'The next page did not load in 15 seconds. Saved rows are safe';
          break;
        }
      }
      if (stopRequested) finish = `Stopped · ${fmt(saved)} rows saved`;
      status.text = finish;
      status.tone = 'ok';
      if (pages > 1) RadarCaptureReader.first(document)?.click();
    } catch (e) {
      fail(e);
    } finally {
      collecting = false;
      await pause(600);
      current = readPage();
      savedSig = sigOf(current);
      render();
    }
  }

  /* ---------- Panel ---------- */

  let host = null,
    ui = null;
  const CSS = `
:host{all:initial}
*{box-sizing:border-box}
.root{animation:enter .32s cubic-bezier(.22,1,.36,1)}
@keyframes enter{from{opacity:0;transform:translateY(8px)}}
@media (prefers-reduced-motion:reduce){.root{animation:none}}
.panel{font:13px/20px system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#171717;background:#fff;width:296px;border:1px solid rgba(23,23,23,.1);border-radius:14px;box-shadow:0 8px 24px rgba(0,0,0,.08),0 1px 2px rgba(0,0,0,.05);overflow:hidden}
.head{display:flex;align-items:center;gap:8px;height:44px;padding:0 8px 0 16px;border-bottom:1px solid rgba(23,23,23,.08)}
.mark{width:16px;height:16px;flex:none}
.name{font-weight:500;white-space:nowrap;flex:none}
.state{margin-left:auto;color:#737373;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:150px}
.state.ok{color:#1a7964}.state.error{color:#b42318}
.icon{width:28px;height:28px;border:0;background:transparent;border-radius:6px;color:#737373;display:grid;place-items:center;cursor:pointer;flex:none}
.icon:hover{background:#f4f4f5;color:#171717}
.body{padding:12px 16px 16px}
.kw{font-size:15px;line-height:22px;font-weight:500;margin:0 0 4px;overflow-wrap:anywhere}
.facts{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:12px 0}
.fact b{display:block;font:500 14px/20px ui-monospace,"SF Mono",Menlo,Consolas,monospace;font-variant-numeric:tabular-nums}
.fact span{color:#737373;font-size:12px;line-height:16px}
.strip{display:grid;grid-template-columns:repeat(12,1fr);gap:2px;margin:12px 0 4px}
.strip i{height:8px;border-radius:2px;background:#ececee}
.strip i.on{background:#1a7964}
.strip i.now{position:relative}.strip i.now::after{content:"";position:absolute;left:0;right:0;top:-4px;height:2px;border-radius:1px;background:#171717}
.months{display:flex;justify-content:space-between;color:#737373;font:11px/16px ui-monospace,"SF Mono",Menlo,Consolas,monospace}
.meta{color:#525252;font-size:12px;line-height:16px;margin-top:12px}
.meta strong{font-weight:500;color:#171717}
.row{display:flex;gap:8px;margin-top:16px}
button.btn{all:unset;box-sizing:border-box;flex:1;height:36px;padding:0 12px;border-radius:8px;font:500 13px/36px system-ui,-apple-system,"Segoe UI",sans-serif;text-align:center;cursor:pointer;transition:background-color .15s cubic-bezier(.22,1,.36,1),transform .12s cubic-bezier(.22,1,.36,1)}
button.btn:active{transform:scale(.98)}
.btn.primary{background:#171717;color:#fff}.btn.primary:hover{background:#2b2b2b}
.btn.secondary{background:#f4f4f5;color:#171717;box-shadow:inset 0 0 0 1px rgba(23,23,23,.12)}.btn.secondary:hover{background:#ececee}
button:focus-visible{outline:2px solid #1a7964;outline-offset:2px}
.pill{all:unset;display:flex;align-items:center;gap:8px;height:36px;padding:0 14px 0 10px;background:#fff;border:1px solid rgba(23,23,23,.1);border-radius:18px;box-shadow:0 8px 24px rgba(0,0,0,.08);font:500 13px system-ui,-apple-system,"Segoe UI",sans-serif;color:#171717;cursor:pointer}
.pill small{color:#737373;font-weight:400;font-size:12px}
.hint{color:#737373;font-size:12px;line-height:16px;margin-top:12px}
`;
  const MARK =
    '<svg class="mark" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.25" fill="none" stroke="#1a7964" stroke-width="1.5"/><circle cx="8" cy="8" r="2.25" fill="#1a7964"/></svg>';
  const ICON = {
    minus: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M5 12h14"/></svg>',
    close: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
  };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  function mount() {
    if (host) return;
    host = document.createElement('div');
    host.id = 'niche-radar-companion';
    host.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:2147483646';
    const shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `<style>${CSS}</style><div class="root"></div>`;
    ui = shadow.querySelector('.root');
    shadow.addEventListener('click', onClick);
    document.documentElement.append(host);
  }
  function unmount() {
    host?.remove();
    host = null;
    ui = null;
  }

  function render() {
    const { insight, table } = current;
    const show = settings.dock && !disconnected ? insight || table || collecting || status.tone === 'error' : disconnected;
    if (!show) {
      if (host && !collecting) unmount();
      return;
    }
    mount();
    if (settings.dockCollapsed && !collecting) {
      ui.innerHTML = `<button class="pill" data-act="expand" aria-label="Open Niche Radar panel">${MARK}Niche Radar <small>${esc(status.text || 'Ready')}</small></button>`;
      return;
    }
    const keyword = insight?.keyword || table?.seed || '';
    const peak = insight ? monthIdx(insight.peak) : -1;
    const now = new Date().getMonth();
    const pos = table?.position;
    const totalPages = pos ? Math.ceil(pos.total / Math.max(1, pos.to - pos.from + 1)) : null;
    const known = status.lookup && status.lookup.keyword?.toLowerCase() === keyword.toLowerCase() ? status.lookup : null;
    let body = '';
    if (disconnected) body = `<p class="hint">Niche Radar was updated. Reload this tab to reconnect.</p>`;
    else if (insight) {
      body = `<p class="kw">${esc(keyword)}</p>
<div class="facts"><div class="fact"><b>${fmt(insight.avg)}</b><span>A month</span></div><div class="fact"><b>${esc(insight.resourcesText || '—')}</b><span>Resources</span></div><div class="fact"><b>${peak >= 0 ? MONTHS[peak] : '—'}${insight.peakShare != null ? ' ' + Math.round(insight.peakShare * 100) + '%' : ''}</b><span>Peak</span></div></div>
<div class="strip" aria-label="Peak month ${peak >= 0 ? MONTHS[peak] : 'unknown'}">${MONTHS.map((m, i) => `<i class="${i === peak ? 'on' : ''} ${i === now ? 'now' : ''}" title="${m}"></i>`).join('')}</div>
<div class="months"><span>Jan</span><span>Jun</span><span>Dec</span></div>
<div class="meta">${known ? `In your workspace · score <strong>${known.score ?? '—'}</strong> · ${esc(known.timing)}${known.starred ? ' · saved' : ''}` : `${fmt(insight.total)} searches in the last ${insight.windowDays || 365} days`}${insight.weekly.length ? ' · weekly curve saved' : ''}</div>`;
    } else if (table) {
      body = `<p class="kw">${table.seed ? 'Related to ' + esc(table.seed) : 'Keyword table'}</p><div class="meta"><strong>${fmt(table.rows.length)}</strong> rows on this page${table.hasPeak ? ' with peak season' : ''}${pos ? ` · ${pos.from} to ${pos.to} of ${fmt(pos.total)}` : ''}</div>`;
    }
    const actions = disconnected
      ? ''
      : collecting
        ? `<div class="row"><button class="btn secondary" data-act="stop">Stop and keep rows</button></div>`
        : `<div class="row">${table && totalPages !== 1 ? `<button class="btn primary" data-act="collect">Collect ${pos ? 'all ' + fmt(pos.total) : 'all pages'}</button>` : ''}${!settings.autoSave || !table?.seed ? `<button class="btn ${table && totalPages !== 1 ? 'secondary' : 'primary'}" data-act="save">Save page</button>` : ''}<button class="btn secondary" data-act="open">Workspace</button></div>`;
    ui.innerHTML = `<section class="panel" role="dialog" aria-label="Niche Radar"><div class="head">${MARK}<span class="name">Niche Radar</span><span class="state ${status.tone}" role="status">${esc(status.text || (settings.autoSave ? 'Auto-save on' : 'Auto-save off'))}</span><button class="icon" data-act="collapse" aria-label="Minimize">${ICON.minus}</button></div><div class="body">${body}${actions}${!collecting && table?.seed ? '<p class="hint">Reads the page and turns pages only. It never runs a search, so your daily searches stay untouched.</p>' : ''}</div></section>`;
  }

  async function onClick(e) {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    try {
      if (act === 'collapse' || act === 'expand') {
        settings.dockCollapsed = act === 'collapse';
        chrome.storage.local.set({ radarSettings: { ...settings } });
        render();
      } else if (act === 'save') await save(readPage(), { manual: true });
      else if (act === 'collect') await collectAll();
      else if (act === 'stop') stopRequested = true;
      else if (act === 'open') await send({ action: 'openDashboard', keyword: current.insight?.keyword || '' });
    } catch (err) {
      fail(err);
    }
  }

  /* ---------- Wiring ---------- */

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id) return;
    if (message.action === 'radarCompanionStatus') {
      const page = readPage();
      respond({
        ok: true,
        view: page.insight ? 'insight' : page.table ? 'table' : 'none',
        keyword: page.insight?.keyword || page.table?.seed || '',
        insight: page.insight ? { avg: page.insight.avg, total: page.insight.total, peak: page.insight.peak, peakShare: page.insight.peakShare, weeks: page.insight.weekly.length, searchesLeft: page.insight.searchesLeft } : null,
        rows: page.table?.rows.length || 0,
        position: page.table?.position || null,
        collecting,
        status: status.text,
        autoSave: settings.autoSave,
      });
      return;
    }
    if (message.action === 'radarCompanionSave') {
      save(readPage(), { manual: true })
        .then((r) => respond(r))
        .catch((e) => {
          fail(e);
          respond({ ok: false, error: e.message });
        });
      return true;
    }
    if (message.action === 'radarCompanionCollect') {
      collectAll();
      respond({ ok: true });
      return;
    }
    if (message.action === 'radarStop') {
      stopRequested = true;
      respond({ ok: true });
    }
  });

  chrome.storage.local.get('radarSettings').then(({ radarSettings }) => {
    Object.assign(settings, radarSettings || {});
    schedule(300);
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.radarSettings) {
      Object.assign(settings, changes.radarSettings.newValue || {});
      render();
      schedule(300);
    }
  });
  new MutationObserver((mutations) => {
    if (timer || collecting) return;
    if (host && mutations.every((m) => host.contains(m.target) || m.target === document.documentElement)) return;
    schedule(800);
  }).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
})();
