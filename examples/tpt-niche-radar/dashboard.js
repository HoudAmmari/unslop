/* Niche Radar workspace. Every value that comes from a file, a capture or the user is escaped
   before it is rendered. */
'use strict';

const R = Radar;
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const ICONS = globalThis.RADAR_ICONS || {};
const icon = (name, cls = '') => `<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;
const hydrateIcons = (root = document) =>
  $$('[data-icon]', root).forEach((el) => {
    if (!el.firstElementChild) el.innerHTML = icon(el.dataset.icon);
  });
const fmt = (n) => (n == null || !Number.isFinite(Number(n)) ? '—' : Math.round(n).toLocaleString('en-US'));
const fmt1 = (n) => (n == null || !Number.isFinite(Number(n)) ? '—' : Number(n).toLocaleString('en-US', { maximumFractionDigits: 1 }));
const compact = (n) => {
  if (n == null || !Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  const cut = (v, d) => v.toFixed(d).replace(/\.0$/, '');
  if (a >= 1e6) return cut(n / 1e6, a >= 1e7 ? 0 : 1) + 'M';
  if (a >= 1e3) return cut(n / 1e3, a >= 1e4 ? 0 : 1) + 'K';
  return String(Math.round(n));
};
const M = R.MONTHS_SHORT,
  MF = R.MONTHS;
const uid = () => crypto.randomUUID();
const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
function dateLabel(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return `${M[m - 1]} ${d}${y !== new Date().getFullYear() ? ', ' + y : ''}`;
}
function ago(isoTime) {
  const t = Date.parse(isoTime);
  if (!Number.isFinite(t)) return '';
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return Math.round(s / 60) + ' min ago';
  if (s < 86400) return Math.round(s / 3600) + ' h ago';
  return dateLabel(new Date(t).toISOString());
}
const searchURL = (keyword) => 'https://www.teacherspayteachers.com/browse?search=' + encodeURIComponent(keyword);
const hasChrome = () => !!globalThis.chrome?.storage?.local;

/* ---------- State ---------- */

let state = R.emptyState(),
  data = { rows: [], overlaps: 0, observations: 0 },
  byKey = new Map(),
  staged = [],
  busy = false,
  pendingCaptures = [],
  activity = [],
  companion = { autoSave: true, dock: true },
  hasPreUpgrade = false;
const ui = {
  view: 'planner',
  layout: 'table',
  savedLayout: 'board',
  selected: new Set(),
  page: 1,
  pageSize: 25,
  sort: 'score',
  direction: -1,
  advanced: false,
  plannerMetric: 'searches',
  plannerMonth: null,
  familiesTab: 'tpt',
  openFamilies: new Set(),
  detailKey: null,
  notesDirty: false,
};
const filters = { query: '', label: '', quick: 'all', intent: 'creator', peak: '', minSearch: '', minAvg: '', maxResources: '', minScore: '', source: '', date: '', status: '', seed: '' };
const defaultIntent = () => (ui.view === 'watchlist' ? 'all' : 'creator');

function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem('radar-ui') || '{}');
    if (['table', 'cards', 'map'].includes(p.layout)) ui.layout = p.layout;
    if (['board', 'table'].includes(p.savedLayout)) ui.savedLayout = p.savedLayout;
    if ([25, 50, 100].includes(p.pageSize)) ui.pageSize = p.pageSize;
    if (['searches', 'keywords'].includes(p.plannerMetric)) ui.plannerMetric = p.plannerMetric;
  } catch {
    /* preferences are a convenience */
  }
}
function savePrefs() {
  try {
    localStorage.setItem('radar-ui', JSON.stringify({ layout: ui.layout, savedLayout: ui.savedLayout, pageSize: ui.pageSize, plannerMetric: ui.plannerMetric }));
  } catch {
    /* ignore */
  }
}

function setData(s) {
  state = s;
  if (!state.insights) state.insights = {};
  data = R.aggregate(state);
  byKey = new Map(data.rows.map((r) => [r.key, r]));
}

/* ---------- Feedback ---------- */

let toastTimer;
/* Toasts and tooltips go to the top layer, so they show above an open sheet or dialog. */
function topLayer(el) {
  try {
    if (el.matches(':popover-open')) el.hidePopover();
    el.showPopover();
  } catch {
    el.hidden = false;
  }
}
function toast(msg, error = false) {
  const el = $('#toast');
  el.textContent = msg;
  topLayer(el);
  el.className = 'toast' + (error ? ' error' : '');
  requestAnimationFrame(() => el.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove('show');
    toastTimer = setTimeout(() => el.hidePopover?.(), 220);
  }, error ? 9000 : 4000);
}
function report(e) {
  console.error(e);
  toast(e?.message || String(e), true);
}
function saveState(text, cls = '') {
  const el = $('#save-state');
  el.textContent = text;
  el.className = 'foot-note ' + cls;
}
async function mutate(fn, { render = true } = {}) {
  saveState('Saving', 'saving');
  try {
    const result = await RadarStore.update(fn);
    setData(result.state);
    saveState('Saved in this browser');
    if (render) renderAll();
    return result.result;
  } catch (e) {
    saveState('Save failed, export a backup', 'error');
    report(e);
    throw e;
  }
}

/* ---------- Small pieces ---------- */

const LABEL_RANK = { Strong: 5, Promising: 4, Moderate: 3, Challenging: 2, 'Very Difficult': 1, Unknown: 0 };
const LABELS = ['Strong', 'Promising', 'Moderate', 'Challenging', 'Very Difficult', 'Unknown'];
const labelText = (l) => (l === 'Very Difficult' ? 'Very difficult' : l);
function labelUI(label) {
  return `<span class="label"><span class="dot ${esc(label.toLowerCase().replace(/ /g, '-'))}"></span>${esc(labelText(label))}</span>`;
}
function scoreUI(n) {
  if (n == null) return '<span class="score muted" title="No score, the resource value could not be read">—</span>';
  return `<span class="score ${n >= 70 ? 'high' : ''}" title="${esc(R.tier(n))}"><span class="score-num">${n}</span><span class="score-bar"><b style="width:${n}%"></b></span></span>`;
}
function deltaUI(r) {
  if (r.delta != null)
    return `<span class="delta ${r.delta > 0 ? 'up' : r.delta < 0 ? 'down' : ''}" title="vs ${esc(dateLabel(r.previous.date))}, same window">${r.delta > 0 ? '+' : ''}${fmt1(r.delta)}%</span>`;
  if (r.previous && r.previous.searches === 0 && r.searches > 0) return '<span class="delta up">From zero</span>';
  return '<span class="delta" title="Needs two dated snapshots with the same search window">—</span>';
}
function starUI(r) {
  const on = !!r.meta.starred;
  return `<button class="star ${on ? 'on' : ''}" data-star="${esc(r.key)}" aria-pressed="${on}" aria-label="${on ? 'Remove from saved' : 'Save'} ${esc(r.keyword)}">${icon('star')}</button>`;
}
function peakSourceText(r) {
  return { tpt: 'Reported by TPT', curve: 'From the weekly curve', wording: 'Inferred from wording' }[r.peakSource] || 'No season data';
}
function whenText(r) {
  if (r.monthsToPeak == null) return '';
  if (r.timing.key === 'evergreen') return 'Evergreen';
  if (r.monthsToPeak === 0) return 'This month';
  if (r.monthsToPeak === 1) return 'Next month';
  return `In ${r.monthsToPeak} months`;
}
function publishText(r) {
  if (!r.publishBy || r.monthsToPeak == null || r.timing.key === 'evergreen') return '';
  if (r.monthsToPeak === 0) return 'In season';
  if (r.publishBy < todayISO()) return 'Publish now';
  return 'Publish by ' + dateLabel(r.publishBy);
}
function strip(r, { big = false } = {}) {
  const now = new Date().getMonth();
  const prof = r.profile;
  const max = prof ? Math.max(...prof.months) : 0;
  const cells = M.map((m, i) => {
    let cls = '',
      style = '';
    if (prof && max) {
      const v = prof.months[i] / max;
      if (i === r.peakMonth) cls = 'on';
      else if (v > 0.01) style = ` style="background:color-mix(in srgb, var(--accent) ${Math.round(12 + 70 * v)}%, var(--cell))"`;
    } else if (i === r.peakMonth) cls = r.peakSource === 'wording' ? 'inferred' : 'on';
    if (i === now) cls += ' now';
    return `<i class="${cls.trim()}"${style}></i>`;
  }).join('');
  const t = r.peakMonth != null ? `Peak ${MF[r.peakMonth]}, ${peakSourceText(r).toLowerCase()}. The tick marks this month` : 'No peak month yet';
  return `<span class="strip ${big ? 'big' : ''}" role="img" aria-label="${esc(t)}" title="${esc(t)}">${cells}</span>`;
}
function peakUI(r) {
  if (r.peakMonth == null) return '<span class="no-peak" title="No peak month yet. Look the keyword up on TPT">—</span>';
  return `<span class="peak">${strip(r)}<span class="peak-month">${r.peakMonth != null ? M[r.peakMonth] : '—'}</span></span>`;
}
function intentText(r) {
  return r.intent === 'brand' ? 'Brand search' : r.intent === 'free' ? 'Freebie search' : '';
}
function kwMeta(r) {
  const bits = [];
  if (intentText(r)) bits.push(`<span class="tag">${intentText(r)}</span>`);
  if (r.seeds.length) bits.push(`with ${esc(r.seeds[0])}${r.seeds.length > 1 ? ` +${r.seeds.length - 1}` : ''}`);
  if (r.meta.status && r.meta.status !== 'inbox') bits.push(`<span class="tag">${esc(statusName(r.meta.status))}</span>`);
  bits.push(r.date ? esc(dateLabel(r.date)) : 'Undated');
  if (r.conflict) bits.push('Conflicting values');
  return bits.join(' · ');
}
const STATUS = [
  ['inbox', 'Inbox'],
  ['researching', 'Researching'],
  ['building', 'Building'],
  ['published', 'Published'],
  ['passed', 'Passed'],
];
const statusName = (s) => (STATUS.find(([v]) => v === s) || STATUS[0])[1];
const presetName = (p) => ({ balanced: 'Balanced', lowCompetition: 'Low competition', demand: 'Demand first', timing: 'Seasonal timing' })[p] || 'Balanced';
const partName = (p) => ({ demand: 'Demand', competition: 'Competition', efficiency: 'Search per resource', label: 'TPT label', timing: 'Timing' })[p] || p;
function niceMax(v) {
  if (!v || v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const s of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (s * p >= v) return s * p;
  return 10 * p;
}
const options = (pairs, value) => pairs.map(([v, l]) => `<option value="${esc(v)}" ${String(value) === String(v) ? 'selected' : ''}>${esc(l)}</option>`).join('');

/* ---------- Filtering ---------- */

const QUICK = [
  ['all', 'All', () => true],
  ['soon', 'Peaking soon', (r) => r.monthsToPeak >= 1 && r.monthsToPeak <= 3 && r.timing.key !== 'evergreen'],
  ['gems', 'Low competition', (r) => r.resource && !r.resource.open && r.resource.high <= 20000 && r.searches >= 500],
  ['longtail', 'Long-tail', (r) => r.keyword.trim().split(/\s+/).length >= 3],
  ['rising', 'Growing', (r) => r.delta > 0],
  ['seasonal', 'Seasonal', (r) => r.seasonal],
  ['curve', 'Looked up on TPT', (r) => !!r.insight],
];
function passes(r, { skipQuick = false, skipIntent = false } = {}) {
  const q = R.normalize(filters.query);
  if (q && !R.normalize(r.keyword + ' ' + (r.meta.tags || '')).includes(q)) return false;
  if (ui.view === 'watchlist' && !r.meta.starred) return false;
  if (!skipIntent && filters.intent !== 'all' && r.intent !== (filters.intent === 'creator' ? 'general' : filters.intent)) return false;
  if (filters.label && r.opportunity !== filters.label) return false;
  if (filters.peak === 'window' && !(r.monthsToPeak >= 1 && r.monthsToPeak <= 3)) return false;
  if (filters.peak !== '' && filters.peak !== 'window' && filters.peak !== 'none' && r.peakMonth !== Number(filters.peak)) return false;
  if (filters.peak === 'none' && r.peakMonth != null) return false;
  if (filters.minSearch !== '' && r.searches < Number(filters.minSearch)) return false;
  if (filters.minAvg !== '' && (r.avgMonthly == null || r.avgMonthly < Number(filters.minAvg))) return false;
  if (filters.minScore !== '' && (r.score == null || r.score < Number(filters.minScore))) return false;
  if (filters.maxResources !== '' && (!r.resource || r.resource.open || r.resource.high > Number(filters.maxResources))) return false;
  if (filters.source && !r.history.some((h) => h.sources.some((s) => s.id === filters.source))) return false;
  if (filters.status && (r.meta.status || 'inbox') !== filters.status) return false;
  if ((filters.date === 'dated' && !r.date) || (filters.date === 'undated' && r.date)) return false;
  if (filters.seed && !(r.seeds.includes(filters.seed) || R.normalize(r.keyword) === R.normalize(filters.seed))) return false;
  if (!skipQuick) {
    const quick = QUICK.find(([k]) => k === filters.quick);
    if (quick && !quick[2](r)) return false;
  }
  return true;
}
function sortValue(r, key) {
  switch (key) {
    case 'keyword':
      return R.normalize(r.keyword);
    case 'peak':
      return r.monthsToPeak;
    case 'resources':
      return r.resource?.proxy ?? null;
    case 'avg':
      return r.avgMonthly;
    case 'label':
      return LABEL_RANK[r.opportunity];
    default:
      return r[key];
  }
}
function filtered() {
  const rs = data.rows.filter((r) => passes(r));
  rs.sort((a, b) => {
    const x = sortValue(a, ui.sort),
      y = sortValue(b, ui.sort);
    if (x == null) return y == null ? a.keyword.localeCompare(b.keyword) : 1;
    if (y == null) return -1;
    return (typeof x === 'string' ? x.localeCompare(y) : x - y) * ui.direction || (b.score ?? -1) - (a.score ?? -1) || a.keyword.localeCompare(b.keyword);
  });
  return rs;
}
function resetFilters() {
  Object.assign(filters, { query: '', label: '', quick: 'all', intent: defaultIntent(), peak: '', minSearch: '', minAvg: '', maxResources: '', minScore: '', source: '', date: '', status: '', seed: '' });
  $('#search-input').value = '';
  ui.page = 1;
}
const activeFilterCount = () =>
  ['label', 'peak', 'minSearch', 'minAvg', 'maxResources', 'minScore', 'source', 'date', 'status', 'seed'].filter((k) => filters[k] !== '').length +
  (filters.quick !== 'all' ? 1 : 0) +
  (filters.query ? 1 : 0);

/* ---------- Shell ---------- */

const VIEWS = ['planner', 'explorer', 'watchlist', 'families', 'history', 'settings'];
function setHead(title, subtitle, actions = '') {
  $('#page-title').textContent = title;
  $('#page-subtitle').innerHTML = subtitle;
  $('#page-actions').innerHTML = actions;
}
function renderNav() {
  $$('.nav-row[data-view]').forEach((b) => {
    const on = b.dataset.view === ui.view;
    b.classList.toggle('active', on);
    if (on) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  $('#count-keywords').textContent = data.rows.length ? compact(data.rows.length) : '';
  const saved = data.rows.filter((r) => r.meta.starred).length;
  $('#count-saved').textContent = saved ? compact(saved) : '';
  const fam = data.rows.filter((r) => r.relatedKeys.length).length;
  $('#count-families').textContent = fam ? compact(fam) : '';
  $('#count-sources').textContent = state.batches.length ? compact(state.batches.length) : '';
  $('#export-btn').disabled = !data.rows.length;
  const choice = document.documentElement.dataset.themeChoice || 'system';
  $$('[data-theme-choice]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.themeChoice === choice)));
}
function renderNotices() {
  const parts = [];
  if (pendingCaptures.length) {
    const running = pendingCaptures.some(([, v]) => v.status === 'running' && Date.now() - Date.parse(v.updatedAt) < 60000);
    parts.push(
      `<div class="notice-bar"><p><strong>${pendingCaptures.length} earlier ${pendingCaptures.length === 1 ? 'capture is' : 'captures are'} waiting to be imported.</strong> ${running ? 'One is still running. ' : ''}Check the date and search window, then import.</p><button class="btn small" data-action="review-captures">Review</button></div>`,
    );
  }
  $('#notices').innerHTML = parts.join('');
}
function renderAll() {
  const focusId = document.activeElement?.id;
  renderNav();
  renderNotices();
  ({ planner: renderPlanner, explorer: renderExplorer, watchlist: renderWatchlist, families: renderFamilies, history: renderHistory, settings: renderSettings })[ui.view]();
  hydrateIcons();
  if (focusId && document.activeElement?.id !== focusId) document.getElementById(focusId)?.focus();
  if ($('#detail').open && ui.detailKey && !ui.notesDirty) openDetail(ui.detailKey, { refresh: true });
}
function setView(v, { keepFilters = false } = {}) {
  if (!VIEWS.includes(v)) v = 'planner';
  const changed = v !== ui.view;
  ui.view = v;
  ui.page = 1;
  if (changed) ui.selected.clear();
  if (!keepFilters) resetFilters();
  if (location.hash.slice(1) !== v) history.replaceState(null, '', '#' + v);
  renderAll();
  if (changed) window.scrollTo({ top: 0 });
}
function goKeywords(patch = {}) {
  resetFilters();
  Object.assign(filters, patch);
  if (patch.query != null) $('#search-input').value = patch.query;
  setView('explorer', { keepFilters: true });
}

/* ---------- Empty workspace ---------- */

function onboardingHTML() {
  const demo = { profile: null, peakMonth: (new Date().getMonth() + 2) % 12, peakSource: 'tpt' };
  return `<section class="panel"><div class="empty">
<h2>Start with one keyword lookup on TPT</h2>
<p>Open your Seller Dashboard on Teachers Pay Teachers, go to Site Search Analytics and search a keyword. Niche Radar saves what TPT shows you, so every lookup becomes part of your research.</p>
${strip(demo, { big: true })}
<ol><li>Average searches per month and total searches for the last 365 days</li><li>The peak month, its share of the year and the full weekly curve</li><li>Up to 100 related keywords with their own peak season, with one click</li></ol>
<p>Already have exports from TPT? Import the CSVs and they are ranked the same way.</p>
<div class="button-row"><button class="btn primary" data-action="pick">${icon('upload')}Import CSVs</button>${globalThis.RADAR_ATTACHED ? `<button class="btn" data-action="load-attached">Load the ${RADAR_ATTACHED.length} included samples</button>` : ''}<a class="btn ghost" href="https://www.teacherspayteachers.com/" target="_blank" rel="noopener noreferrer">Open TPT${icon('arrow-up-right')}</a></div>
</div></section>`;
}

/* ---------- Season planner ---------- */

function plannerModel() {
  const nowM = new Date().getMonth();
  const pool = data.rows.filter((r) => r.intent === 'general');
  const order = Array.from({ length: 12 }, (_, i) => (nowM + i) % 12);
  const months = order.map((m, i) => {
    const rows = pool.filter((r) => r.peakMonth === m);
    const known = rows.filter((r) => r.avgMonthly != null);
    return {
      m,
      i,
      rows,
      count: rows.length,
      searches: known.reduce((a, r) => a + r.avgMonthly, 0),
      known: known.length,
      inferred: rows.filter((r) => r.peakSource === 'wording').length,
    };
  });
  return { nowM, pool, order, months };
}
function renderPlanner() {
  const nowLabel = new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  if (!data.rows.length) {
    setHead('Season planner', esc(nowLabel));
    $('#view').innerHTML = onboardingHTML();
    return;
  }
  const { order, months, pool } = plannerModel();
  const anyAvg = months.some((m) => m.known);
  const metric = ui.plannerMetric === 'searches' && anyAvg ? 'searches' : 'keywords';
  const value = (m) => (metric === 'searches' ? m.searches : m.count);
  const top = niceMax(Math.max(1, ...months.map(value)));
  const windowNames = `${MF[order[1]]} to ${MF[order[3]]}`;
  setHead('Season planner', `${esc(nowLabel)} · build window ${esc(windowNames)}`);

  const soon = pool.filter((r) => r.monthsToPeak >= 1 && r.monthsToPeak <= 3 && r.timing.key !== 'evergreen');
  const priority = pool.filter((r) => r.score >= 70);
  const withPeak = data.rows.filter((r) => r.peakMonth != null);
  const curves = data.rows.filter((r) => r.insight);
  const stats = `<section class="stats">
<button class="stat" data-go="keywords"><span class="stat-label">Keywords</span><span class="stat-value">${fmt(data.rows.length)}</span><span class="stat-meta">${fmt(withPeak.length)} with a peak month · ${fmt(state.batches.length)} sources</span></button>
<button class="stat" data-go="soon"><span class="stat-label">Peaking in the build window</span><span class="stat-value accent">${fmt(soon.length)}</span><span class="stat-meta">${esc(M[order[1]])} to ${esc(M[order[3]])}, creator keywords</span></button>
<button class="stat" data-go="priority"><span class="stat-label">Priority keywords</span><span class="stat-value">${fmt(priority.length)}</span><span class="stat-meta">Score 70 or more, ${esc(presetName(state.settings.preset).toLowerCase())} lens</span></button>
<button class="stat" data-go="curve"><span class="stat-label">Looked up on TPT</span><span class="stat-value">${fmt(curves.length)}</span><span class="stat-meta">With a weekly curve and peak share</span></button>
</section>`;

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => `<div class="gl" style="bottom:calc(40px + ${f} * (100% - 40px))"><span>${metric === 'searches' ? compact(top * f) : fmt(top * f)}</span></div>`).join('');
  const cols = months
    .map((m) => {
      const v = value(m);
      const h = Math.max(v ? 1.5 : 0, (v / top) * 100);
      const cls = ['season-col', m.i >= 1 && m.i <= 3 ? 'window' : '', m.i === 0 ? 'now' : '', ui.plannerMonth === m.m ? 'picked' : ''].filter(Boolean).join(' ');
      const tip = `${MF[m.m]}|${fmt(m.count)} keywords peak${m.known ? ` · ${fmt(m.searches)} avg searches a month across ${fmt(m.known)}` : ''}${m.inferred ? ` · ${m.inferred} by wording only` : ''}`;
      return `<button class="${cls}" data-month="${m.m}" data-tip="${esc(tip)}" aria-pressed="${ui.plannerMonth === m.m}" aria-label="${esc(tip.replace('|', ': '))}"><span class="bar" style="height:${h}%"><span class="bar-value">${metric === 'searches' ? compact(v) : fmt(v)}</span></span><span class="m">${M[m.m]}<small>${m.i === 0 ? 'Now' : fmt(m.count)}</small></span></button>`;
    })
    .join('');
  const known = months.reduce((a, m) => a + m.known, 0);
  const inferred = months.reduce((a, m) => a + m.inferred, 0);
  const caption =
    metric === 'searches'
      ? `Sum of average monthly searches of ${fmt(known)} creator keywords with a known window, by the month they peak.`
      : `Creator keywords by the month they peak.`;
  const chart = `<section class="panel chart-panel"><div class="panel-head"><div><h2>Demand by peak month</h2><p>${caption}${inferred ? ` ${fmt(inferred)} peaks come from wording only.` : ''}</p></div>
<div class="segmented" role="group" aria-label="Chart measure"><button class="${metric === 'searches' ? 'active' : ''}" data-metric="searches" ${anyAvg ? '' : 'disabled title="Needs a search window or TPT lookups"'}>Searches a month</button><button class="${metric === 'keywords' ? 'active' : ''}" data-metric="keywords">Keywords</button></div></div>
<div class="season-chart"><div class="season-grid">${ticks}</div><div class="season-cols">${cols}</div></div>
<div class="season-foot"><span class="legend"><span><i class="window"></i>Build window, one to three months out</span><span><i></i>Other months</span></span><span>Pick a month to list its keywords</span></div></section>`;

  const picked = ui.plannerMonth;
  const listRows = (picked != null ? pool.filter((r) => r.peakMonth === picked) : soon).filter((r) => r.score != null).sort((a, b) => b.score - a.score);
  const list = `<section class="panel"><div class="panel-head"><div><h2>${picked != null ? 'Peaking in ' + MF[picked] : 'Build next'}</h2><p>${picked != null ? `${fmt(listRows.length)} creator keywords, best score first` : `Peaks in ${esc(windowNames)}, best score first`}</p></div>${picked != null ? '<button class="btn small ghost" data-month="clear">Show build window</button>' : ''}</div>
${
  listRows.length
    ? `<ul class="rank-list">${listRows
        .slice(0, 10)
        .map(
          (r) =>
            `<li data-detail="${esc(r.key)}"><span class="kw-name">${esc(r.keyword)}</span>${scoreUI(r.score)}<span class="sub">${strip(r)}<span>${esc(publishText(r) || whenText(r))}</span><span>${r.avgMonthly != null ? fmt(r.avgMonthly) + ' a month' : fmt(r.searches) + ' searches'}</span></span></li>`,
        )
        .join('')}</ul>`
    : `<p class="rank-empty">${picked != null ? 'No creator keywords peak in this month yet.' : 'No keywords peak in the next three months yet. Look up seasonal keywords on TPT, or import exports with a Peak Season column.'}</p>`
}
${listRows.length > 10 ? `<div class="panel-body" style="padding-top:0"><button class="link" data-go="${picked != null ? 'month:' + picked : 'soon'}">See all ${fmt(listRows.length)} in Keywords</button></div>` : ''}</section>`;

  const recent = curves.sort((a, b) => (b.insight.capturedAt || '').localeCompare(a.insight.capturedAt || '')).slice(0, 8);
  const lookups = `<section class="panel"><div class="panel-head"><div><h2>Recent TPT lookups</h2><p>Keywords you opened in Site Search Analytics</p></div></div>
${
  recent.length
    ? `<div class="table-wrap"><table class="compact"><thead><tr><th style="padding-left:24px">Keyword</th><th>Season</th><th class="num">Avg a month</th><th class="num">Peak share</th><th class="num">Related</th><th class="num" style="padding-right:24px">Looked up</th></tr></thead><tbody>${recent
        .map(
          (r) =>
            `<tr class="clickable" data-row="${esc(r.key)}"><td style="padding-left:24px"><span class="kw-name">${esc(r.keyword)}</span></td><td>${peakUI(r)}</td><td class="num">${fmt(r.avgMonthly)}</td><td class="num">${r.seasonShare != null ? Math.round(r.seasonShare * 100) + '%' : '—'}</td><td class="num">${fmt(r.relatedKeys.length)}</td><td class="num" style="padding-right:24px">${esc(dateLabel(r.insight.date))}</td></tr>`,
        )
        .join('')}</tbody></table></div>`
    : `<div class="panel-body"><p class="muted">Nothing yet. With the extension installed, open Site Search Analytics on TPT and search a keyword. Its numbers, weekly curve and related keywords appear here on their own.</p></div>`
}</section>`;

  const n = data.rows.length || 1;
  const q = (label, count, total, hint = '') =>
    `<div class="q-row"><div class="q-line"><span>${label}</span><b>${fmt(count)} / ${fmt(total)}</b></div><div class="meter"><b style="width:${(count / Math.max(1, total)) * 100}%"></b></div>${hint ? `<span class="stat-meta">${hint}</span>` : ''}</div>`;
  const quality = `<section class="panel"><div class="panel-head"><div><h2>Evidence</h2><p>How much of the workspace each number can rely on</p></div></div><div class="panel-body quality">
${q('Peak month from TPT', data.rows.filter((r) => r.peakSource === 'tpt' || r.peakSource === 'curve').length, n)}
${q('Known search window', data.rows.filter((r) => r.windowDays || r.avgSource === 'reported').length, n, 'Needed for the monthly average. Set it per source')}
${q('Dated snapshots', data.rows.filter((r) => r.date).length, n)}
${q('Comparable change', data.rows.filter((r) => r.previous).length, n, 'Needs two dated snapshots with the same window')}
<div class="q-line" style="display:flex;justify-content:space-between;font-size:13px;color:var(--text-2)"><span>Conflicting snapshots</span><b class="mono">${fmt(data.rows.filter((r) => r.conflict).length)}</b></div>
<button class="link" data-view="history" style="justify-self:start">Review sources</button></div></section>`;

  $('#view').innerHTML = `${stats}<div class="planner">${chart}${list}</div><div class="two-col">${lookups}${quality}</div>`;
}

/* ---------- Keywords ---------- */

function renderExplorer() {
  const total = data.rows.length;
  if (ui.view === 'explorer')
    setHead('Keywords', total ? `${fmt(total)} keywords from ${fmt(state.batches.length)} ${state.batches.length === 1 ? 'source' : 'sources'}, ranked with the ${esc(presetName(state.settings.preset).toLowerCase())} lens` : 'Nothing imported yet');
  if (!total) {
    $('#view').innerHTML = onboardingHTML();
    return;
  }
  const chipCounts = QUICK.map(([k, l, f]) => [k, l, data.rows.filter((r) => passes(r, { skipQuick: true }) && f(r)).length]);
  const chips = chipCounts
    .map(([k, l, n]) => `<button class="chip ${filters.quick === k ? 'active' : ''}" data-quick="${k}">${esc(l)}<span class="count">${compact(n)}</span></button>`)
    .join('');
  const peakOptions = [['', 'Any peak month'], ['window', 'Build window'], ...M.map((m, i) => [String(i), MF[i]]), ['none', 'No peak data']];
  const toolbar = `<div class="toolbar"><div class="chips" role="group" aria-label="Quick filters">${chips}</div></div>
<div class="toolbar">
<select class="select" id="peak-filter" aria-label="Peak month">${options(peakOptions, filters.peak)}</select>
<select class="select" id="label-filter" aria-label="TPT opportunity label">${options([['', 'Any TPT label'], ...LABELS.map((l) => [l, labelText(l)])], filters.label)}</select>
<select class="select" id="intent-filter" aria-label="Search intent">${options([['creator', 'Creator keywords'], ['all', 'All intents'], ['brand', 'Brand searches'], ['free', 'Freebie searches']], filters.intent)}</select>
<button class="btn small ${ui.advanced ? 'primary' : ''}" data-action="advanced" aria-expanded="${ui.advanced}">${icon('list-filter')}More filters</button>
<span class="spacer"></span>
<label class="sr-only" for="preset-select">Ranking lens</label>
<select class="select" id="preset-select" title="Ranking lens">${options(Object.keys(R.presets).map((p) => [p, presetName(p) + ' lens']), state.settings.preset)}</select>
<div class="segmented" role="group" aria-label="Layout">${[
    ['table', 'rows-3', 'Table'],
    ['cards', 'layout-grid', 'Cards'],
    ['map', 'chart-scatter', 'Map'],
  ]
    .map(([k, ic, l]) => `<button class="${ui.layout === k ? 'active' : ''}" data-layout="${k}" aria-label="${l}" title="${l}">${icon(ic)}</button>`)
    .join('')}</div></div>`;
  $('#view').innerHTML = `<section class="panel explorer">${toolbar}<div id="advanced">${advancedHTML()}</div><div id="results"></div></section>`;
  renderResults();
}
function advancedHTML() {
  if (!ui.advanced) return '';
  const families = data.rows.filter((r) => r.relatedKeys.length).map((r) => [r.keyword, r.keyword]);
  return `<div class="advanced">
<label class="field">Minimum searches<input class="input" type="number" min="0" data-filter="minSearch" value="${esc(filters.minSearch)}" placeholder="500"></label>
<label class="field">Minimum a month<input class="input" type="number" min="0" data-filter="minAvg" value="${esc(filters.minAvg)}" placeholder="200"></label>
<label class="field">Most resources<input class="input" type="number" min="0" data-filter="maxResources" value="${esc(filters.maxResources)}" placeholder="20000"></label>
<label class="field">Minimum score<input class="input" type="number" min="0" max="100" data-filter="minScore" value="${esc(filters.minScore)}" placeholder="55"></label>
<label class="field">Source<select class="select" data-filter="source">${options([['', 'All sources'], ...state.batches.map((b) => [b.id, b.name])], filters.source)}</select></label>
<label class="field">Family<select class="select" data-filter="seed">${options([['', 'All families'], ...families], filters.seed)}</select></label>
<label class="field">Dates<select class="select" data-filter="date">${options([['', 'All snapshots'], ['dated', 'Dated only'], ['undated', 'Undated only']], filters.date)}</select></label>
<label class="field">Status<select class="select" data-filter="status">${options([['', 'Any status'], ...STATUS], filters.status)}</select></label>
</div>`;
}
function renderResults() {
  const holder = $('#results');
  if (!holder) return;
  const rs = filtered();
  const pages = Math.max(1, Math.ceil(rs.length / ui.pageSize));
  ui.page = Math.min(ui.page, pages);
  const slice = rs.slice((ui.page - 1) * ui.pageSize, ui.page * ui.pageSize);
  const hidden = filters.intent === 'creator' ? data.rows.filter((r) => passes(r, { skipIntent: true }) && r.intent !== 'general').length : 0;
  const undated = data.rows.filter((r) => !r.date).length;
  const sub = `<div class="subbar"><span><span class="mono">${fmt(rs.length)}</span> ${rs.length === 1 ? 'keyword' : 'keywords'}${filters.seed ? ` in the ${esc(filters.seed)} family` : ''}</span>${
    hidden ? `<span>${fmt(hidden)} brand and freebie searches hidden <button class="link" data-action="show-all-intents">Show them</button></span>` : ''
  }${undated && ui.layout !== 'map' ? `<span>${fmt(undated)} undated, so no change shown <button class="link" data-view="history">Add dates</button></span>` : ''}${
    activeFilterCount() ? `<span><button class="link" data-action="reset-filters">Clear filters</button></span>` : ''
  }</div>`;
  const bulk = ui.selected.size
    ? `<div class="bulk"><strong>${fmt(ui.selected.size)} selected</strong><button class="btn small" data-action="compare">${icon('columns-2')}Compare</button><button class="btn small" data-action="bulk-save">${icon('star')}Save</button><button class="btn small" data-action="export-selected">${icon('file-down')}Export</button><button class="btn small ghost" data-action="clear-selected">Clear</button></div>`
    : '';
  let body;
  if (!rs.length)
    body =
      ui.view === 'watchlist' && !data.rows.some((r) => r.meta.starred)
        ? `<div class="empty"><h2>Nothing saved yet</h2><p>Save keywords with the star and they show up here, ready for notes, a status and a side by side comparison.</p><button class="btn" data-view="explorer">Browse keywords</button></div>`
        : `<div class="empty"><h2>No keywords match</h2><p>Try a broader search or clear the filters. Everything you imported is still here.</p><button class="btn" data-action="reset-filters">Clear filters</button></div>`;
  else if (ui.layout === 'map' && ui.view === 'explorer') body = mapHTML(rs);
  else if (ui.layout === 'cards') body = cardsHTML(slice);
  else body = tableHTML(slice);
  const pager =
    rs.length && !(ui.layout === 'map' && ui.view === 'explorer')
      ? `<div class="pager"><span class="mono">${fmt((ui.page - 1) * ui.pageSize + 1)}–${fmt(Math.min(ui.page * ui.pageSize, rs.length))} of ${fmt(rs.length)}</span><div class="pager-right"><select class="select" id="page-size" aria-label="Rows per page">${options(
          [25, 50, 100].map((n) => [n, n + ' per page']),
          ui.pageSize,
        )}</select><button class="icon-btn" data-action="prev-page" ${ui.page <= 1 ? 'disabled' : ''} aria-label="Previous page">${icon('chevron-left')}</button><span class="mono">${ui.page} / ${pages}</span><button class="icon-btn" data-action="next-page" ${ui.page >= pages ? 'disabled' : ''} aria-label="Next page">${icon('chevron-right')}</button></div></div>`
      : '';
  holder.innerHTML = sub + bulk + body + pager;
}
function sortHead(key, label, cls = '') {
  const active = ui.sort === key;
  const dir = active ? (ui.direction === 1 ? 'ascending' : 'descending') : 'none';
  return `<th class="${cls}" aria-sort="${dir}"><button data-sort="${key}">${label}${active ? icon(ui.direction === 1 ? 'arrow-up' : 'arrow-down') : ''}</button></th>`;
}
function tableHTML(rs) {
  const allOn = rs.length && rs.every((r) => ui.selected.has(r.key));
  return `<div class="table-wrap"><table><thead><tr><th class="check"><input type="checkbox" id="select-page" aria-label="Select keywords on this page" ${allOn ? 'checked' : ''}></th>${sortHead('keyword', 'Keyword')}${sortHead('peak', 'Peak')}${sortHead('score', 'Score')}${sortHead('avg', 'Avg a month', 'num')}${sortHead('searches', 'Searches', 'num col-searches')}${sortHead('resources', 'Resources', 'num col-resources')}${sortHead('label', 'TPT label', 'col-label')}${sortHead('delta', 'Change', 'num col-delta')}<th class="star-cell"><span class="sr-only">Saved</span></th></tr></thead><tbody>${rs
    .map(
      (r) =>
        `<tr class="clickable ${ui.selected.has(r.key) ? 'is-selected' : ''}" data-row="${esc(r.key)}"><td class="check"><input type="checkbox" data-select="${esc(r.key)}" aria-label="Select ${esc(r.keyword)}" ${ui.selected.has(r.key) ? 'checked' : ''}></td><td><button class="kw-name" data-detail="${esc(r.key)}">${esc(r.keyword)}</button><div class="kw-meta">${kwMeta(r)}</div></td><td>${peakUI(r)}<div class="kw-meta col-peak-when">${esc(whenText(r))}</div></td><td>${scoreUI(r.score)}</td><td class="num">${fmt(r.avgMonthly)}</td><td class="num col-searches">${fmt(r.searches)}</td><td class="num col-resources">${esc(r.resourcesText)}</td><td class="col-label">${labelUI(r.opportunity)}</td><td class="num col-delta">${deltaUI(r)}</td><td class="star-cell">${starUI(r)}</td></tr>`,
    )
    .join('')}</tbody></table></div>`;
}
function cardsHTML(rs) {
  return `<div class="card-grid">${rs
    .map(
      (r) =>
        `<article class="kw-card ${ui.selected.has(r.key) ? 'is-selected' : ''}" data-row="${esc(r.key)}"><div class="kw-card-head"><div><button class="kw-name" data-detail="${esc(r.key)}">${esc(r.keyword)}</button><div class="kw-meta">${kwMeta(r)}</div></div>${starUI(r)}</div>
<div class="kw-card-figs"><div class="fig"><strong>${fmt(r.avgMonthly)}</strong><span>A month</span></div><div class="fig"><strong>${esc(r.resourcesText)}</strong><span>Resources</span></div><div class="fig"><strong>${r.peakMonth != null ? M[r.peakMonth] : '—'}</strong><span>Peak</span></div></div>
<div class="kw-card-foot">${strip(r)}${scoreUI(r.score)}<input type="checkbox" data-select="${esc(r.key)}" aria-label="Select ${esc(r.keyword)}" ${ui.selected.has(r.key) ? 'checked' : ''}></div></article>`,
    )
    .join('')}</div>`;
}
function mapHTML(rs) {
  const pts = rs.filter((r) => r.resource && r.searches != null).sort((a, b) => (b.score ?? -1) - (a.score ?? -1)).slice(0, 800);
  const xMin = 100,
    xMax = 1e6;
  const yMin = 10,
    yMax = Math.max(1e4, niceMax(Math.max(...pts.map((p) => p.searches), 10)));
  const lx = (v) => (Math.log10(Math.min(xMax, Math.max(xMin, v)) / xMin) / Math.log10(xMax / xMin)) * 100;
  const ly = (v) => (Math.log10(Math.max(yMin, v) / yMin) / Math.log10(yMax / yMin)) * 100;
  const xt = [100, 1e3, 1e4, 1e5, 1e6];
  const yt = [10, 100, 1e3, 1e4, 1e5, 1e6, 1e7].filter((v) => v <= yMax);
  const grid =
    xt.map((v) => `<div class="map-grid" style="left:${lx(v)}%;top:0;bottom:0;width:1px"></div><div class="map-tick" style="left:${lx(v)}%;bottom:-24px;transform:translateX(-50%)">${compact(v)}</div>`).join('') +
    yt.map((v) => `<div class="map-grid" style="bottom:${ly(v)}%;left:0;right:0;height:1px"></div><div class="map-tick" style="bottom:${ly(v)}%;right:calc(100% + 8px);transform:translateY(50%)">${compact(v)}</div>`).join('');
  const dots = pts
    .map((r) => {
      const x = r.resource.open ? 99 : lx(r.resource.proxy);
      const tip = `${r.keyword}|${fmt(r.searches)} searches · ${r.resourcesText} resources · score ${r.score ?? '—'}${r.peakMonth != null ? ' · peak ' + M[r.peakMonth] : ''}`;
      return `<button class="map-dot ${r.score >= 70 ? 'high' : ''}" data-detail="${esc(r.key)}" data-tip="${esc(tip)}" aria-label="${esc(tip.replace('|', ': '))}" style="left:${x}%;bottom:${ly(r.searches)}%"></button>`;
    })
    .join('');
  return `<div class="map"><div class="map-plot">${grid}<span class="map-zone">More searches, fewer resources</span>${dots}</div><div class="map-axis-x">Competing resources, upper end of the range</div><div class="map-axis-y">Searches as reported</div></div>
<div class="map-legend"><span><span class="dot strong"></span>Score 70 or more</span><span><span class="dot moderate"></span>Other keywords</span><span>Log scales. Open ranges like “&gt; 500K” sit on the right edge. ${pts.length < rs.length ? `Showing the top ${fmt(pts.length)} of ${fmt(rs.length)} by score.` : ''}</span></div>`;
}

/* ---------- Saved ---------- */

function renderWatchlist() {
  const saved = data.rows.filter((r) => r.meta.starred);
  setHead(
    'Saved',
    saved.length ? `${fmt(saved.length)} ${saved.length === 1 ? 'keyword' : 'keywords'} in your pipeline` : 'Keywords you star land here',
    `<div class="segmented" role="group" aria-label="Saved layout"><button class="${ui.savedLayout === 'board' ? 'active' : ''}" data-saved-layout="board">${icon('kanban')}Board</button><button class="${ui.savedLayout === 'table' ? 'active' : ''}" data-saved-layout="table">${icon('rows-3')}Table</button></div>`,
  );
  if (ui.savedLayout === 'table' || !saved.length) {
    if (!saved.length) {
      $('#view').innerHTML = `<section class="panel"><div class="empty"><h2>Nothing saved yet</h2><p>Star a keyword anywhere in the workspace. Saved keywords get a status, notes and a place on this board, from first idea to published.</p><button class="btn" data-view="explorer">Browse keywords</button></div></section>`;
      return;
    }
    $('#view').innerHTML = `<section class="panel explorer"><div id="results"></div></section>`;
    renderResults();
    return;
  }
  const q = R.normalize(filters.query);
  const shown = saved.filter((r) => !q || R.normalize(r.keyword + ' ' + (r.meta.tags || '')).includes(q));
  $('#view').innerHTML = `<div class="board">${STATUS.map(([s, name]) => {
    const rs = shown.filter((r) => (r.meta.status || 'inbox') === s).sort((a, b) => (a.monthsToPeak ?? 99) - (b.monthsToPeak ?? 99) || (b.score ?? -1) - (a.score ?? -1));
    return `<section class="lane" data-lane="${s}" aria-label="${name}"><div class="lane-head">${name}<span>${fmt(rs.length)}</span></div>${
      rs
        .map(
          (r) =>
            `<article class="lane-card" draggable="true" data-card="${esc(r.key)}" data-detail="${esc(r.key)}" tabindex="0"><span class="kw-name">${esc(r.keyword)}</span><div class="row">${strip(r)}<span class="timing ${esc(r.timing.key)}">${esc(publishText(r) || whenText(r) || 'No peak data')}</span></div><div class="row">${scoreUI(r.score)}<span class="mono">${r.avgMonthly != null ? fmt(r.avgMonthly) + ' / mo' : fmt(r.searches)}</span></div>${r.meta.notes ? `<p class="notes">${esc(r.meta.notes)}</p>` : ''}</article>`,
        )
        .join('') || `<p class="lane-empty">${s === 'inbox' ? 'New saves start here' : 'Drag a card here'}</p>`
    }</section>`;
  }).join('')}</div>`;
}

/* ---------- Families ---------- */

function renderFamilies() {
  const fams = R.families(data.rows);
  const words = R.clusters(data.rows.filter((r) => r.intent === 'general'));
  setHead(
    'Search families',
    'Keywords TPT buyers search together, and keywords that share a word',
    `<div class="segmented" role="group" aria-label="Family type"><button class="${ui.familiesTab === 'tpt' ? 'active' : ''}" data-fam-tab="tpt">From TPT lookups <span class="mono">${fams.length}</span></button><button class="${ui.familiesTab === 'words' ? 'active' : ''}" data-fam-tab="words">Shared words <span class="mono">${words.length}</span></button></div>`,
  );
  if (ui.familiesTab === 'words') {
    $('#view').innerHTML = words.length
      ? `<section class="panel"><div class="table-wrap"><table class="compact"><thead><tr><th style="padding-left:24px">Shared word</th><th class="num">Keywords</th><th>Leading keyword</th><th>Score</th><th class="num">Average score</th><th style="padding-right:24px"></th></tr></thead><tbody>${words
          .slice(0, 300)
          .map(
            (g) =>
              `<tr><td style="padding-left:24px"><strong style="font-weight:500">${esc(g.term)}</strong></td><td class="num">${fmt(g.count)}</td><td><button class="kw-name" data-detail="${esc(g.best.key)}">${esc(g.best.keyword)}</button></td><td>${scoreUI(g.best.score)}</td><td class="num">${fmt(g.avg)}</td><td style="padding-right:24px;text-align:right"><button class="btn small" data-word="${esc(g.term)}">Show keywords</button></td></tr>`,
          )
          .join('')}</tbody></table></div><div class="pager"><span>Groups overlap, so search totals are not summed. Brand and freebie searches are left out</span></div></section>`
      : `<section class="panel"><div class="empty"><h2>No shared words yet</h2><p>Groups appear once two or more keywords share a meaningful word.</p></div></section>`;
    return;
  }
  if (!fams.length) {
    $('#view').innerHTML = `<section class="panel"><div class="empty"><h2>No TPT families yet</h2><p>Search a keyword in Site Search Analytics on TPT. The related keywords TPT lists under it become its family here, with their own peak seasons. Collect all related pages from the Niche Radar panel on the page to get up to 100 of them.</p></div></section>`;
    return;
  }
  $('#view').innerHTML = `<section class="panel family-list">${fams
    .map((f) => {
      const open = ui.openFamilies.has(f.seed.key);
      const maxPeak = Math.max(1, ...f.peaks);
      const heat = `<span class="heat" title="Peak months of the family">${f.peaks.map((c, i) => `<i title="${MF[i]}: ${c}" style="${c ? `background:color-mix(in srgb, var(--accent) ${Math.round(20 + 80 * (c / maxPeak))}%, var(--cell))` : ''}"></i>`).join('')}</span>`;
      const sumAvg = f.members.reduce((a, m) => a + (m.avgMonthly || 0), 0);
      const members = [...f.members].sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
      return `<div class="family ${open ? 'open' : ''}"><button class="family-head" data-family="${esc(f.seed.key)}" aria-expanded="${open}"><span class="chev">${icon('chevron-right')}</span><span><span class="family-title">${esc(f.seed.keyword)}</span><span class="family-sub">${fmt(f.members.length)} related keywords${f.seed.insight ? ' · looked up ' + esc(dateLabel(f.seed.insight.date)) : ''}</span></span>${heat}<span class="family-stat"><b>${f.best ? f.best.score : '—'}</b>${f.best ? esc(f.best.keyword) : 'Best score'}</span><span class="family-stat"><b>${f.avgScore ?? '—'}</b>Average score</span><span class="family-stat"><b>${compact(sumAvg)}</b>Searches a month, combined</span></button>${
        open
          ? `<div class="family-body"><div class="table-wrap"><table class="dense"><thead><tr><th style="padding-left:64px">Keyword</th><th>Peak</th><th>Score</th><th class="num">Avg a month</th><th class="num col-resources">Resources</th><th class="col-label">TPT label</th><th class="star-cell"></th></tr></thead><tbody>${members
              .map(
                (r) =>
                  `<tr class="clickable" data-row="${esc(r.key)}"><td style="padding-left:64px"><button class="kw-name" data-detail="${esc(r.key)}">${esc(r.keyword)}</button></td><td>${peakUI(r)}</td><td>${scoreUI(r.score)}</td><td class="num">${fmt(r.avgMonthly)}</td><td class="num col-resources">${esc(r.resourcesText)}</td><td class="col-label">${labelUI(r.opportunity)}</td><td class="star-cell">${starUI(r)}</td></tr>`,
              )
              .join('')}</tbody></table></div><div style="padding:12px 24px 0 64px"><button class="btn small" data-family-keywords="${esc(f.seed.keyword)}">Open in Keywords</button></div></div>`
          : ''
      }</div>`;
    })
    .join('')}</section>`;
}

/* ---------- Sources ---------- */

function kindOf(b) {
  if (b.kind === 'search') return 'TPT lookup';
  if (b.kind === 'capture') return 'TPT table';
  if (/^Migrated/.test(b.name)) return 'Migrated';
  if (/capture/i.test(b.name)) return 'Capture';
  return 'File';
}
function renderHistory() {
  setHead('Sources', state.batches.length ? `${fmt(state.batches.length)} imports and lookups · ${fmt(data.observations)} observations · ${fmt(data.overlaps)} overlaps merged` : 'Imports and TPT lookups land here');
  const drop = `<button class="dropzone" data-action="pick">${icon('upload')}<span><strong>Import CSVs or a backup</strong><small>Drop files anywhere on this page. Keywords merge by name and every source stays traceable</small></span><span class="btn small">Browse</span></button>`;
  const rows = [...state.batches].sort((a, b) => (b.importedAt || '').localeCompare(a.importedAt || ''));
  const table = rows.length
    ? `<section class="panel"><div class="table-wrap"><table class="compact"><thead><tr><th style="padding-left:24px">Source</th><th>Kind</th><th class="num">Rows</th><th>Snapshot</th><th>Search window</th><th>Imported</th><th style="padding-right:24px"></th></tr></thead><tbody>${rows
        .map(
          (b) =>
            `<tr><td style="padding-left:24px"><strong style="font-weight:500;overflow-wrap:anywhere">${esc(b.name)}</strong><div class="kw-meta">${fmt(b.duplicateRows || 0)} repeated · ${fmt(b.invalidRows || 0)} rejected</div></td><td><span class="kind">${esc(kindOf(b))}</span></td><td class="num">${fmt(b.rows.length)}</td><td>${b.date ? esc(dateLabel(b.date)) : '<span class="muted">Not set</span>'}</td><td>${b.period ? esc(b.period) : '<span class="muted">Not set</span>'}</td><td class="muted">${esc(ago(b.importedAt))}</td><td style="padding-right:24px;text-align:right;white-space:nowrap"><button class="btn small ghost" data-edit-batch="${esc(b.id)}">${icon('pencil')}Edit</button><button class="btn small ghost" data-show-source="${esc(b.id)}">Keywords</button><button class="icon-btn" data-delete-batch="${esc(b.id)}" aria-label="Remove ${esc(b.name)}" title="Remove this source">${icon('trash-2')}</button></td></tr>`,
        )
        .join('')}</tbody></table></div></section>`
    : '';
  const act = activity.length
    ? `<section class="panel"><div class="panel-head"><div><h2>Recent TPT activity</h2><p>Saved by the Niche Radar panel on TPT pages</p></div></div><ul class="activity">${activity
        .slice(0, 12)
        .map(
          (a) =>
            `<li><span>${a.seed ? `<button class="kw-name" data-detail="${esc(R.keyOf(a.seed))}">${esc(a.seed)}</button>` : 'Keyword table'}<span class="kw-meta">${fmt(a.rows)} rows${a.newKeywords ? ` · ${fmt(a.newKeywords)} new` : ''}${a.insight ? ' · weekly curve' : ''}</span></span><span class="when">${esc(ago(a.at))}</span></li>`,
        )
        .join('')}</ul></section>`
    : '';
  $('#view').innerHTML = drop + table + act;
}

/* ---------- Settings ---------- */

function renderSettings() {
  setHead('Scoring and help', 'How keywords are ranked, and where your research lives');
  const preset = state.settings.preset;
  const w = R.presets[preset];
  const lead = state.settings.leadWeeks || 6;
  $('#view').innerHTML = `<div class="settings">
<section class="panel panel-body">
<h2>Ranking lens</h2>
<p>Radar score runs from 0 to 100 on fixed anchors, so a large import never moves the scores you already have.</p>
<label class="field">Lens<select class="select" id="preset-select">${options(Object.keys(R.presets).map((p) => [p, presetName(p)]), preset)}</select></label>
<div class="weights">${Object.entries(w)
    .map(([k, v]) => `<div class="weight"><span>${partName(k)}</span><span class="meter"><b style="width:${v * 100 * 1.6}%;background:var(--accent)"></b></span><b>${Math.round(v * 100)}%</b></div>`)
    .join('')}</div>
<h3>What goes into the score</h3>
<ul>
<li><strong>Demand.</strong> Reported searches on a log scale, with 100,000 as the top anchor.</li>
<li><strong>Competition.</strong> A falling log scale from 100 to 500,000 resources, using the upper end of the range.</li>
<li><strong>Search per resource.</strong> Searches divided by the resource upper bound, on a log scale. A relative signal, not traffic per product.</li>
<li><strong>TPT label.</strong> Strong 100%, Promising 75%, Moderate 50%, Challenging 25%, Very difficult 0%, unknown 50%.</li>
<li><strong>Timing,</strong> in the seasonal timing lens only. Full points when the peak is one or two months away, fewer when it is now or far off, half when the season is unknown.</li>
</ul>
<p>Open ranges like “&gt; 500K” get no competition or balance points, since the real upper bound is unknown. Values that cannot be read stay visible without a score.</p>
<h3>Reading the score</h3>
<p>70 and up is priority, 55 to 69 worth exploring, 40 to 54 selective and below 40 harder entry. These thresholds are Niche Radar’s own, separate from TPT’s label.</p>
<h3>Publish lead time</h3>
<label class="field">Weeks before the peak month a listing should be live<input class="input" type="number" min="1" max="16" id="lead-weeks" value="${lead}" style="max-width:120px"></label>
<p>Publish dates use this lead time. Six weeks gives TPT time to index a new listing before buyers start searching.</p>
</section>
<div style="display:grid;gap:16px">
<section class="panel panel-body">
<h2>On TPT pages</h2>
${
  hasChrome()
    ? `<div class="toggle-row"><span><strong>Save keyword lookups automatically</strong><small>When Site Search Analytics shows a keyword, save its numbers, weekly curve and the related keywords on screen</small></span><button class="switch" role="switch" aria-checked="${companion.autoSave}" data-companion="autoSave" aria-label="Save keyword lookups automatically"></button></div>
<div class="toggle-row"><span><strong>Show the Niche Radar panel</strong><small>A small panel in the corner with the keyword’s numbers and a button to collect every related page</small></span><button class="switch" role="switch" aria-checked="${companion.dock}" data-companion="dock" aria-label="Show the Niche Radar panel"></button></div>`
    : '<p>These options are available when the dashboard runs inside the installed extension.</p>'
}
<p>The panel reads the page and turns related-keyword pages. It never runs a search, so the daily searches TPT allows stay untouched.</p>
</section>
<section class="panel panel-body">
<h2>Your data</h2>
<p>${fmt(state.batches.length)} sources, ${fmt(data.observations)} observations, ${fmt(data.rows.length)} keywords and ${fmt(Object.keys(state.insights || {}).length)} ${Object.keys(state.insights || {}).length === 1 ? 'weekly curve' : 'weekly curves'}, stored in this browser profile. There is no account and nothing is sent anywhere.</p>
<div class="button-row"><button class="btn" data-action="backup">${icon('download')}Back up workspace</button><button class="btn" data-action="pick">${icon('upload')}Restore a backup</button>${hasPreUpgrade ? `<button class="btn" data-action="pre-upgrade">${icon('history')}Download v3 copy</button>` : ''}</div>
${hasPreUpgrade ? '<p>The v3 copy is your workspace exactly as it was before this version first saved anything. It stays in the browser untouched.</p>' : ''}
<p>Back up before removing the extension or moving its folder. Keep the folder in the same place when you update, so Chrome keeps the same storage.</p>
</section>
<section class="panel panel-body">
<h2>How history stays honest</h2>
<ul>
<li>Keywords merge when they match after case, spacing, dashes and apostrophes are normalized. Different phrases stay separate.</li>
<li>Identical snapshots merge and keep every source. Different values stay in the keyword’s history.</li>
<li>The newest dated snapshot wins. An undated file never replaces dated evidence.</li>
<li>Same date and window with different values is flagged as a conflict.</li>
<li>Change needs two dates with the same search window. A missing keyword is never treated as zero searches.</li>
<li>TPT lookups are saved with the window TPT states, the last 365 days, so the monthly average is that total divided by twelve.</li>
</ul>
<h3>Shortcuts</h3>
<p><kbd>/</kbd> search &nbsp; <kbd>Esc</kbd> close a panel</p>
</section>
</div></div>`;
}

/* ---------- Keyword detail ---------- */

function monotonePath(p) {
  const n = p.length;
  if (n < 2) return '';
  const dx = [],
    m = [],
    t = [];
  for (let i = 0; i < n - 1; i++) {
    dx[i] = p[i + 1][0] - p[i][0];
    m[i] = (p[i + 1][1] - p[i][1]) / dx[i];
  }
  t[0] = m[0];
  t[n - 1] = m[n - 2];
  for (let i = 1; i < n - 1; i++) t[i] = m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) {
      t[i] = 0;
      t[i + 1] = 0;
      continue;
    }
    const a = t[i] / m[i],
      b = t[i + 1] / m[i],
      s = a * a + b * b;
    if (s > 9) {
      const k = 3 / Math.sqrt(s);
      t[i] = k * a * m[i];
      t[i + 1] = k * b * m[i];
    }
  }
  const f = (v) => Math.round(v * 100) / 100;
  let d = `M${f(p[0][0])},${f(p[0][1])}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] / 3;
    d += `C${f(p[i][0] + h)},${f(p[i][1] + t[i] * h)} ${f(p[i + 1][0] - h)},${f(p[i + 1][1] - t[i + 1] * h)} ${f(p[i + 1][0])},${f(p[i + 1][1])}`;
  }
  return d;
}
let curveData = null;
function curveHTML(r) {
  const w = r.insight.weekly;
  const n = w.length;
  const top = niceMax(Math.max(...w.map((x) => x[1]), 1));
  const X = (i) => (i / (n - 1)) * 1000;
  const Y = (v) => 200 - (v / top) * 200;
  const pts = w.map(([, v], i) => [X(i), Math.min(200, Y(v))]);
  const line = monotonePath(pts);
  const area = `${line}L1000,200L0,200Z`;
  const monthOfWeek = (d) => Number(d.slice(5, 7)) - 1;
  const peakIdx = w.map((x, i) => (monthOfWeek(x[0]) === r.peakMonth ? i : -1)).filter((i) => i >= 0);
  const band = peakIdx.length ? `<rect class="band" x="${X(peakIdx[0])}" y="0" width="${Math.max(4, X(Math.min(n - 1, peakIdx[peakIdx.length - 1] + 1)) - X(peakIdx[0]))}" height="200"/>` : '';
  const xLabels = [];
  let lastMonth = -1;
  w.forEach(([d], i) => {
    const mo = monthOfWeek(d);
    if (mo !== lastMonth && i > 0 && i < n - 2) xLabels.push(`<span class="curve-x" style="left:${(i / (n - 1)) * 100}%">${M[mo]}</span>`);
    lastMonth = mo;
  });
  const ticks = [0, 0.5, 1].map((f) => `<span class="curve-gl" style="bottom:calc(28px + ${f} * (100% - 28px))"></span><span class="curve-y" style="bottom:calc(28px + ${f} * (100% - 28px) - 16px)">${compact(top * f)}</span>`).join('');
  const flag = peakIdx.length ? `<span class="curve-flag" style="left:${(peakIdx[0] / (n - 1)) * 100}%">Peak ${MF[r.peakMonth]}${r.seasonShare != null ? ' · ' + Math.round(r.seasonShare * 100) + '% of the year' : ''}</span>` : '';
  curveData = { w, top };
  return `<div class="curve" id="curve">${ticks}<svg viewBox="0 0 1000 200" preserveAspectRatio="none" aria-hidden="true">${band}<path class="area" d="${area}"/><path class="line" d="${line}"/></svg>${flag}${xLabels.join('')}<div class="curve-hit" id="curve-hit" role="img" aria-label="Weekly searches for ${esc(r.keyword)} from ${esc(dateLabel(w[0][0]))} to ${esc(dateLabel(w[n - 1][0]))}, peak ${esc(MF[r.peakMonth] || '')}"></div><span class="curve-dot" id="curve-dot" hidden></span></div>`;
}
function onCurveMove(e) {
  const hit = $('#curve-hit');
  if (!hit || !curveData) return;
  const box = hit.getBoundingClientRect();
  const { w, top } = curveData;
  const i = Math.max(0, Math.min(w.length - 1, Math.round(((e.clientX - box.left) / box.width) * (w.length - 1))));
  const [d, v] = w[i];
  const dot = $('#curve-dot');
  dot.hidden = false;
  dot.style.left = (i / (w.length - 1)) * 100 + '%';
  dot.style.top = (1 - v / top) * box.height + 'px';
  const end = new Date(Date.parse(d + 'T12:00:00Z') + 6 * 86400000).toISOString().slice(0, 10);
  showTip(`${dateLabel(d)} to ${dateLabel(end)}|${fmt(v)} searches`, e.clientX, box.top + (1 - v / top) * box.height);
}

function openDetail(key, { refresh = false } = {}) {
  const r = byKey.get(key);
  if (!r) {
    if (!refresh) toast('This keyword is not in the workspace yet');
    return;
  }
  ui.detailKey = key;
  ui.notesDirty = false;
  const sheet = $('#detail');
  const scroll = sheet.scrollTop;
  const ratio = r.ratio == null ? '—' : `${r.resource?.open ? '≤ ' : ''}${fmt1(r.ratio)}`;
  const facts = [
    ['Radar score', r.score ?? '—', R.tier(r.score)],
    ['Avg a month', fmt(r.avgMonthly), r.avgSource === 'reported' ? 'Reported by TPT' : r.avgSource === 'window' ? 'From ' + esc(r.period) : 'Set a search window'],
    ['Searches', fmt(r.searches), r.period ? esc(r.period) : 'Window not set'],
    ['Resources', esc(r.resourcesText), r.resource?.open ? 'No upper bound' : r.resource ? 'Range from TPT' : 'Could not be read'],
    ['Peak month', r.peakMonth != null ? MF[r.peakMonth] : '—', peakSourceText(r), 'word'],
    ['Peak share', r.seasonShare != null ? Math.round(r.seasonShare * 100) + '%' : '—', r.seasonShare != null ? 'Of the year in that month' : 'Needs a TPT lookup'],
    ['Per 1K resources', ratio, 'Searches per 1,000'],
    ['Change', deltaUI(r), r.previous ? 'vs ' + esc(dateLabel(r.previous.date)) : 'Needs two dated snapshots'],
  ];
  const warnings = [
    !r.date && 'This keyword has no snapshot date, so it can show no change. Add a date to its source.',
    r.conflict && 'Two snapshots with the same date and window disagree. The latest import is shown and both are kept below.',
    r.resource?.open && 'The resource range has no upper bound, so competition and balance get no points.',
    !r.resource && 'The resource value could not be read, so this keyword has no score.',
  ].filter(Boolean);

  let season;
  if (r.insight?.weekly?.length >= 8) {
    season = `<section><div class="section-title"><h3>Weekly searches on TPT</h3><span>${esc(r.insight.range || '')} · looked up ${esc(dateLabel(r.insight.date))}</span></div>${curveHTML(r)}</section>`;
  } else {
    season = `<section><div class="section-title"><h3>Season</h3><span>${esc(peakSourceText(r))}</span></div>${strip(r, { big: true })}<div class="months-row" style="display:grid;grid-template-columns:repeat(12,minmax(0,1fr));gap:4px;margin-top:8px">${M.map((m) => `<span class="mono muted" style="font-size:12px;text-align:center">${m}</span>`).join('')}</div><p class="muted" style="margin-top:12px;font-size:13px">${
      r.peakSource === 'wording'
        ? 'This peak is a guess from the wording. Look the keyword up in TPT Site Search Analytics to get the real peak month and weekly curve.'
        : r.peakMonth != null
          ? 'TPT reports this peak month. Look the keyword up in Site Search Analytics to add its weekly curve and peak share.'
          : 'No season data yet. Look the keyword up in TPT Site Search Analytics to get its peak month and weekly curve.'
    }</p></section>`;
  }
  let timing;
  if (r.peakMonth == null) timing = '';
  else {
    const lead = state.settings.leadWeeks || 6;
    const pub = publishText(r);
    const line =
      r.timing.key === 'evergreen'
        ? 'Searches spread across the year, so timing matters less than demand and competition.'
        : r.monthsToPeak === 0
          ? `The peak is this month. A listing published now catches the tail, the next peak is twelve months away.`
          : r.publishBy < todayISO()
            ? `Publish as soon as you can. The ${lead}-week lead time before ${MF[r.peakMonth]} has already started.`
            : `Publish by ${dateLabel(r.publishBy)} to be live ${lead} weeks before buyers search. Change the lead time in Scoring and help.`;
    timing = `<div class="timing-card"><div><strong>Peaks in ${MF[r.peakMonth]} · ${esc(whenText(r).toLowerCase())}</strong><p>${line}${r.peakSource === 'wording' ? ' The peak is inferred from the wording.' : ''}</p></div><span class="timing ${esc(r.timing.key)}">${esc(pub || r.timing.label)}</span></div>`;
  }
  const parts = `<section><div class="section-title"><h3>Why this score</h3><span>${esc(presetName(state.settings.preset))} lens</span></div><div class="parts">${
    r.parts.length
      ? r.parts.map((p) => `<div class="part"><span>${partName(p.name)}</span><span class="meter"><b style="width:${p.value * 100}%;background:var(--accent)"></b></span><b>${p.points.toFixed(1)} of ${Math.round(p.weight * 100)}</b></div>`).join('')
      : '<p class="muted">No score, the resource value could not be read.</p>'
  }</div></section>`;
  const status = r.meta.status || 'inbox';
  const notebook = `<section><div class="section-title"><h3>Notebook</h3><span id="notes-state">${r.meta.updatedAt ? 'Saved ' + esc(ago(r.meta.updatedAt)) : ''}</span></div><div class="notebook">
<div class="segmented status-seg" role="radiogroup" aria-label="Status">${STATUS.map(([v, l]) => `<button role="radio" class="${status === v ? 'active' : ''}" aria-checked="${status === v}" data-status="${v}">${l}</button>`).join('')}</div>
<div class="row2"><label class="field">Search intent<select class="select" id="detail-intent">${options(
    [
      ['auto', `Detect automatically (${r.intent === 'general' ? 'creator keyword' : r.intent === 'brand' ? 'brand search' : 'freebie search'})`],
      ['general', 'Creator keyword'],
      ['brand', 'Brand or program search'],
      ['free', 'Freebie search'],
    ],
    r.meta.intent || 'auto',
  )}</select></label><label class="field">Tags<input class="input" id="detail-tags" value="${esc(r.meta.tags || '')}" maxlength="500" placeholder="grade 4, digital"></label></div>
<label class="field">Notes<textarea class="input" id="detail-notes" maxlength="20000" placeholder="What do the top listings miss? What do reviews ask for?">${esc(r.meta.notes || '')}</textarea></label></div></section>`;

  const related = r.relatedKeys.map((k) => byKey.get(k)).filter(Boolean).sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  const relatedHTML = related.length
    ? `<section><div class="section-title"><h3>Searched together on TPT</h3><span>${fmt(related.length)} keywords</span></div><div class="table-wrap"><table class="dense"><thead><tr><th>Keyword</th><th>Peak</th><th>Score</th><th class="num">Avg a month</th></tr></thead><tbody>${related
        .slice(0, 12)
        .map((x) => `<tr class="clickable" data-row="${esc(x.key)}"><td><button class="kw-name" data-detail="${esc(x.key)}">${esc(x.keyword)}</button></td><td>${peakUI(x)}</td><td>${scoreUI(x.score)}</td><td class="num">${fmt(x.avgMonthly)}</td></tr>`)
        .join('')}</tbody></table></div>${related.length > 12 ? `<button class="link" style="margin-top:12px" data-family-keywords="${esc(r.keyword)}">See all ${fmt(related.length)}</button>` : ''}</section>`
    : '';
  const seeds = r.seeds.length
    ? `<section><div class="section-title"><h3>Appears in lookups for</h3></div><div class="related-chips">${r.seeds
        .map((s) => `<button class="chip" data-detail="${esc(R.keyOf(s))}">${esc(s)}</button>`)
        .join('')}</div></section>`
    : '';
  const insightsList = state.insights?.[key] || [];
  const lookups =
    insightsList.length > 1
      ? `<section><div class="section-title"><h3>Earlier lookups</h3></div><div class="table-wrap"><table class="dense"><thead><tr><th>Looked up</th><th class="num">Avg a month</th><th class="num">Total</th><th class="num">Peak share</th><th>Resources</th></tr></thead><tbody>${insightsList
          .map((x) => `<tr><td>${esc(dateLabel(x.date))}</td><td class="num">${fmt(x.avg)}</td><td class="num">${fmt(x.total)}</td><td class="num">${x.peakShare != null ? Math.round(x.peakShare * 100) + '%' : '—'}</td><td>${esc(x.resourcesText)}</td></tr>`)
          .join('')}</tbody></table></div></section>`
      : '';
  const historyHTML = `<section><div class="section-title"><h3>Evidence</h3><span>${fmt(r.history.length)} ${r.history.length === 1 ? 'observation' : 'observations'}</span></div><div class="table-wrap"><table class="dense"><thead><tr><th>Snapshot</th><th>Window</th><th class="num">Searches</th><th>Resources</th><th>Peak</th><th>TPT label</th><th>Source</th></tr></thead><tbody>${r.history
    .map(
      (h) =>
        `<tr><td>${h.date ? esc(dateLabel(h.date)) : '<span class="muted">Undated</span>'}</td><td>${esc(h.period || '—')}</td><td class="num">${fmt(h.searches)}</td><td>${esc(h.resourcesText)}</td><td class="mono">${h.peak != null ? M[h.peak] : '—'}</td><td>${labelUI(h.opportunity)}</td><td class="muted">${h.sources.map((s) => esc(s.name)).join('<br>')}</td></tr>`,
    )
    .join('')}</tbody></table></div></section>`;

  $('#detail-body').innerHTML = `<header class="sheet-head"><div><h2>${esc(r.keyword)}</h2><div class="sheet-sub">${labelUI(r.opportunity)}<span>${esc(R.tier(r.score))}</span>${intentText(r) ? `<span>${intentText(r)}</span>` : ''}${r.seasonal ? '<span>Seasonal</span>' : ''}</div></div><button class="icon-btn" data-close="detail" aria-label="Close keyword details">${icon('x')}</button></header>
<div class="sheet-body">
<div class="sheet-actions"><button class="btn ${r.meta.starred ? 'accent' : ''}" data-star="${esc(r.key)}" aria-pressed="${!!r.meta.starred}">${icon('star')}${r.meta.starred ? 'Saved' : 'Save'}</button><a class="btn" href="${searchURL(r.keyword)}" target="_blank" rel="noopener noreferrer">${icon('external-link')}Open on TPT</a><a class="btn ghost" href="https://www.google.com/search?q=${encodeURIComponent('site:teacherspayteachers.com ' + r.keyword)}" target="_blank" rel="noopener noreferrer">Search Google</a><button class="btn ghost" data-select-toggle="${esc(r.key)}">${ui.selected.has(r.key) ? 'Selected for compare' : 'Select to compare'}</button></div>
<div class="facts">${facts.map(([l, v, s, cls]) => `<div class="fact"><span>${l}</span><strong class="${cls || ''}">${v}</strong><small>${s}</small></div>`).join('')}</div>
${warnings.map((w) => `<p class="note warn">${esc(w)}</p>`).join('')}
${season}${timing}${parts}${notebook}${relatedHTML}${seeds}${lookups}${historyHTML}
</div>`;
  hydrateIcons(sheet);
  const hit = $('#curve-hit');
  if (hit) {
    hit.addEventListener('mousemove', onCurveMove);
    hit.addEventListener('mouseleave', () => {
      hideTip();
      $('#curve-dot').hidden = true;
    });
  }
  if (!sheet.open) sheet.showModal();
  if (refresh) sheet.scrollTop = scroll;
  else sheet.scrollTop = 0;
}

let notesTimer;
async function saveNotes() {
  clearTimeout(notesTimer);
  const key = ui.detailKey;
  if (!key || !$('#detail-notes')) return;
  const intent = $('#detail-intent').value,
    tags = $('#detail-tags').value,
    notes = $('#detail-notes').value;
  $('#notes-state').textContent = 'Saving';
  await mutate(
    (s) => {
      s.meta[key] = { ...(s.meta[key] || {}), intent, tags, notes, updatedAt: new Date().toISOString() };
    },
    { render: false },
  );
  ui.notesDirty = false;
  if ($('#notes-state')) $('#notes-state').textContent = 'Saved';
  renderNav();
  if (ui.view !== 'settings') {
    const y = window.scrollY;
    ({ planner: renderPlanner, explorer: renderExplorer, watchlist: renderWatchlist, families: renderFamilies, history: renderHistory })[ui.view]();
    hydrateIcons($('#view'));
    window.scrollTo({ top: y });
  }
}

/* ---------- Compare ---------- */

function compare() {
  const rs = data.rows.filter((r) => ui.selected.has(r.key));
  if (rs.length < 2) return toast('Select at least two keywords to compare');
  if (rs.length > 5) return toast('Select up to five keywords for a readable comparison');
  const rows = [
    ['Radar score', (r) => `${scoreUI(r.score)} <span class="muted" style="font-size:12px">${esc(R.tier(r.score))}</span>`],
    ['Season', (r) => `${peakUI(r)}<div class="kw-meta">${esc(peakSourceText(r))}</div>`],
    ['Timing', (r) => esc(publishText(r) || whenText(r) || '—')],
    ['Avg a month', (r) => `<span class="mono">${fmt(r.avgMonthly)}</span>`],
    ['Peak share', (r) => `<span class="mono">${r.seasonShare != null ? Math.round(r.seasonShare * 100) + '%' : '—'}</span>`],
    ['Searches', (r) => `<span class="mono">${fmt(r.searches)}</span><div class="kw-meta">${esc(r.period || 'Window not set')}</div>`],
    ['Resources', (r) => `<span class="mono">${esc(r.resourcesText)}</span>`],
    ['TPT label', (r) => labelUI(r.opportunity)],
    ['Per 1K resources', (r) => `<span class="mono">${r.ratio == null ? '—' : (r.resource?.open ? '≤ ' : '') + fmt1(r.ratio)}</span>`],
    ['Change', deltaUI],
    ['Snapshot', (r) => esc(r.date ? dateLabel(r.date) : 'Undated')],
    ['Status', (r) => esc(statusName(r.meta.status || 'inbox'))],
    ['Notes', (r) => `<span class="secondary-text" style="font-size:13px">${esc(r.meta.notes || '—')}</span>`],
    ['Research', (r) => `<a href="${searchURL(r.keyword)}" target="_blank" rel="noopener noreferrer">Open on TPT</a>`],
  ];
  $('#compare-body').innerHTML = `<div class="table-wrap"><table class="compact"><thead><tr><th></th>${rs.map((r) => `<th><button class="kw-name" data-detail="${esc(r.key)}">${esc(r.keyword)}</button></th>`).join('')}</tr></thead><tbody>${rows
    .map(([l, f]) => `<tr><td class="muted" style="font-size:13px;white-space:nowrap">${l}</td>${rs.map((r) => `<td>${f(r)}</td>`).join('')}</tr>`)
    .join('')}</tbody></table></div>`;
  hydrateIcons($('#compare-body'));
  $('#compare-dialog').showModal();
}

/* ---------- Export ---------- */

function download(name, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type })),
    a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function exportData(kind) {
  const stamp = todayISO();
  if (kind === 'backup') {
    download('Niche-Radar-Backup-' + stamp + '.json', JSON.stringify({ ...state, exportedAt: new Date().toISOString() }, null, 2), 'application/json');
    toast('Workspace backup downloaded');
    return;
  }
  if (kind === 'history') {
    download(
      'Niche-Radar-All-Observations-' + stamp + '.csv',
      R.csv(
        ['Keywords', 'Searches', 'Resources', 'Opportunity', 'Date', 'Period', 'Sources', 'Peak month', 'Avg searches per month'],
        data.rows.flatMap((r) => r.history.map((h) => [h.keyword, h.searches, h.resourcesText, h.opportunity, h.date, h.period, h.sources.map((s) => s.name).join(' | '), h.peak != null ? MF[h.peak] : '', h.avg ?? ''])),
      ),
      'text/csv;charset=utf-8',
    );
    return;
  }
  if (kind === 'curves') {
    const rows = [];
    for (const [k, list] of Object.entries(state.insights || {})) for (const ins of list) for (const [week, v] of ins.weekly) rows.push([ins.keyword, ins.date, week, v]);
    if (!rows.length) return toast('No weekly curves yet. Look keywords up on TPT first');
    download('Niche-Radar-Weekly-Curves-' + stamp + '.csv', R.csv(['Keyword', 'Looked up', 'Week starting', 'Searches'], rows), 'text/csv;charset=utf-8');
    return;
  }
  const rs = kind === 'selected' ? data.rows.filter((r) => ui.selected.has(r.key)) : filtered();
  if (!rs.length) return toast('There are no keywords to export');
  download(
    'Niche-Radar-' + (kind === 'selected' ? 'Selected' : 'Ranked') + '-' + stamp + '.csv',
    R.csv(
      [
        'Keywords',
        'Searches',
        'Resources',
        'Opportunity',
        'Radar score',
        'Ranking preset',
        'Priority',
        'Date',
        'Period',
        'Change percent',
        'Resource lower bound',
        'Resource upper bound',
        'Searches per 1000 resources proxy',
        'Saved',
        'Status',
        'Tags',
        'Notes',
        'Sources',
        'Avg searches per month',
        'Peak month',
        'Peak source',
        'Peak share percent',
        'Months to peak',
        'Publish by',
        'Related to',
      ],
      rs.map((r) => [
        r.keyword,
        r.searches,
        r.resourcesText,
        r.opportunity,
        r.score,
        presetName(state.settings.preset),
        R.tier(r.score),
        r.date,
        r.period,
        r.delta?.toFixed(2),
        r.resource?.low,
        r.resource?.high,
        r.ratio?.toFixed(2),
        r.meta.starred ? 'Yes' : 'No',
        r.meta.status || 'inbox',
        r.meta.tags,
        r.meta.notes,
        [...new Set(r.history.flatMap((h) => h.sources.map((s) => s.name)))].join(' | '),
        r.avgMonthly != null ? Math.round(r.avgMonthly) : '',
        r.peakMonth != null ? MF[r.peakMonth] : '',
        r.peakSource ? peakSourceText(r) : '',
        r.seasonShare != null ? Math.round(r.seasonShare * 100) : '',
        r.monthsToPeak ?? '',
        r.publishBy || '',
        r.seeds.join(' | '),
      ]),
    ),
    'text/csv;charset=utf-8',
  );
  toast(`${fmt(rs.length)} keywords exported`);
}

/* ---------- Import ---------- */

function openImport() {
  if (!$('#import-dialog').open) $('#import-dialog').showModal();
  renderImport();
}
async function acceptFiles(files) {
  if (busy) return;
  for (const file of files) {
    if (file.size > 25 * 1024 * 1024) {
      staged.push({ id: uid(), name: file.name, error: 'File exceeds 25 MB. Split it into smaller exports.' });
      continue;
    }
    try {
      const raw = await file.text();
      if (file.name.toLowerCase().endsWith('.json')) {
        const backup = R.validateBackup(JSON.parse(raw));
        staged.push({ id: uid(), name: file.name, backup, date: '', period: '' });
      } else if (/\.(csv|tsv|txt)$/i.test(file.name)) {
        const parsed = R.parseDelimited(raw);
        if (parsed.data.length > 100000) throw new Error('This file has more than 100,000 rows. Split it before importing.');
        const mapping = R.guessMapping(parsed.headers);
        staged.push({ id: uid(), name: file.name, parsed, mapping, result: R.convertRows(parsed, mapping), date: '', period: '', showMapping: ['keyword', 'searches', 'resources'].some((k) => mapping[k] < 0) });
      } else throw new Error('Use a CSV, a TSV or a Niche Radar backup.');
    } catch (e) {
      staged.push({ id: uid(), name: file.name, error: e.message });
    }
  }
  $('#file-input').value = '';
  openImport();
}
const FIELD_NAMES = { keyword: 'Keyword', searches: 'Searches', resources: 'Resources', opportunity: 'Opportunity', date: 'Date', period: 'Search window', peak: 'Peak season', avg: 'Avg a month' };
function renderImport() {
  const root = $('#import-preview');
  root.innerHTML = staged.length
    ? staged
        .map((f) => {
          const head = `<div class="import-file-head"><strong>${esc(f.name)}</strong><button class="icon-btn" data-remove-stage="${f.id}" aria-label="Remove ${esc(f.name)}">${icon('x')}</button></div>`;
          if (f.error) return `<article class="import-file">${head}<p class="note error">${esc(f.error)}</p></article>`;
          if (f.backup)
            return `<article class="import-file">${head}<p class="note">Backup with ${fmt(f.backup.batches.length)} sources, ${fmt(Object.keys(f.backup.meta).length)} notebook entries and ${fmt(Object.keys(f.backup.insights).length)} weekly curves. Sources merge with yours, newer notes win and your settings stay as they are.</p></article>`;
          const res = f.result;
          const extra = [res.rows.some((r) => r.peak != null) && 'peak months', res.rows.some((r) => r.avg != null) && 'monthly averages'].filter(Boolean);
          return `<article class="import-file">${head}
<div class="import-fields"><label class="field">Snapshot date<input class="input" type="date" data-stage-field="date" data-id="${f.id}" value="${esc(f.date)}"></label><label class="field">Search window<input class="input" data-stage-field="period" data-id="${f.id}" value="${esc(f.period)}" maxlength="120" placeholder="Not set, like Last 30 days"></label></div>
<button class="link" style="justify-self:start" data-toggle-mapping="${f.id}">${f.showMapping ? 'Hide' : 'Show'} column mapping</button>
${
  f.showMapping
    ? `<div class="mapping">${Object.keys(FIELD_NAMES)
        .map(
          (k) =>
            `<label class="field">${FIELD_NAMES[k]}${['keyword', 'searches', 'resources'].includes(k) ? ' (required)' : ''}<select class="select" data-map="${k}" data-id="${f.id}"><option value="-1">Not mapped</option>${f.parsed.headers
              .map((h, i) => `<option value="${i}" ${f.mapping[k] === i ? 'selected' : ''}>${esc(h) || 'Column ' + (i + 1)}</option>`)
              .join('')}</select></label>`,
        )
        .join('')}</div>`
    : ''
}
<p class="import-stats"><span class="mono">${fmt(res.rows.length)}</span> valid rows · ${fmt(res.duplicateRows)} repeated · ${fmt(res.errors.length)} rejected${extra.length ? ' · with ' + extra.join(' and ') : ''}${res.rows.some((r) => !R.resources(r.resourcesText)) ? ' · some resource values cannot be scored' : ''}</p>
${
  res.errors.length
    ? `<details><summary>Review ${fmt(res.errors.length)} skipped rows</summary>${res.errors
        .slice(0, 30)
        .map((e) => `<div class="err">Row ${e.line}: ${esc(e.message)}</div>`)
        .join('')}${res.errors.length > 30 ? '<div class="err">Only the first 30 are shown</div>' : ''}</details>`
    : ''
}
${
  res.rows.length
    ? `<div class="table-wrap"><table class="dense"><thead><tr><th>Keyword</th><th class="num">Searches</th><th>Resources</th><th>Peak</th><th>TPT label</th></tr></thead><tbody>${res.rows
        .slice(0, 3)
        .map((r) => `<tr><td>${esc(r.keyword)}</td><td class="num">${fmt(r.searches)}</td><td>${esc(r.resourcesText)}</td><td class="mono">${r.peak != null ? M[r.peak] : '—'}</td><td>${labelUI(r.opportunity)}</td></tr>`)
        .join('')}</tbody></table></div>`
    : ''
}</article>`;
        })
        .join('')
    : `<div class="empty" style="padding:24px 0"><p>Choose one or more keyword exports, or drop them on this window.</p><button class="btn primary" data-action="pick">Browse files</button></div>`;
  hydrateIcons(root);
  updateImportSummary();
}
function incomingBatches() {
  return staged
    .filter((f) => !f.error && !f.backup && !f.result.incomplete && f.result.rows.length)
    .map((f, i) => ({
      id: f.id,
      name: f.name,
      date: f.date,
      period: f.period.trim(),
      rows: f.result.rows,
      duplicateRows: f.result.duplicateRows,
      invalidRows: f.result.errors.length,
      importedAt: new Date(Date.now() + i).toISOString(),
      kind: f.captureKey ? 'capture' : 'csv',
    }));
}
function updateImportSummary() {
  const regular = incomingBatches(),
    backups = staged.filter((f) => f.backup).flatMap((f) => f.backup.batches),
    incoming = [...regular, ...backups],
    tmp = structuredClone(state),
    merged = R.mergeBatches(tmp, incoming),
    after = R.aggregate(tmp);
  $('#import-summary').textContent = `${fmt(merged.added)} new sources · ${fmt(after.rows.length - data.rows.length)} new keywords${merged.skipped ? ` · ${fmt(merged.skipped)} identical imports skipped` : ''}${staged.some((f) => f.error) ? ' · failed files left out' : ''}`;
  $('#commit-import').disabled = busy || !(incoming.length || staged.some((f) => f.backup && Object.keys(f.backup.insights).length));
}
async function commitImport() {
  if (busy) return;
  busy = true;
  $('#commit-import').disabled = true;
  try {
    const batches = incomingBatches(),
      backupFiles = staged.filter((f) => f.backup),
      captureKeys = staged.filter((f) => f.captureKey).map((f) => f.captureKey);
    const before = data.rows.length;
    const result = await mutate((s) => {
      const res = R.mergeBatches(s, [...batches, ...backupFiles.flatMap((f) => f.backup.batches.map((b) => ({ ...b, id: uid() })))]);
      for (const f of backupFiles) {
        for (const [key, m] of Object.entries(f.backup.meta)) {
          const old = s.meta[key];
          if (!old || m.updatedAt > old.updatedAt) s.meta[key] = m;
        }
        for (const list of Object.values(f.backup.insights)) for (const ins of list) R.addInsight(s, ins);
      }
      return res;
    });
    if (captureKeys.length && hasChrome()) await chrome.storage.local.remove(captureKeys);
    staged = [];
    $('#import-dialog').close();
    toast(`${fmt(result.added)} sources imported · ${fmt(data.rows.length - before)} new keywords${result.skipped ? ` · ${fmt(result.skipped)} repeats skipped` : ''}`);
    await refreshCaptures();
  } catch (e) {
    report(e);
  } finally {
    busy = false;
    $('#commit-import').disabled = false;
  }
}

function editBatch(id) {
  const b = state.batches.find((x) => x.id === id);
  if (!b) return;
  const d = $('#batch-dialog');
  d.innerHTML = `<header class="modal-head"><div><h2 id="batch-title">Snapshot details</h2><p>${esc(b.name)}</p></div><button class="icon-btn" data-close="batch-dialog" aria-label="Close">${icon('x')}</button></header><form id="batch-form" data-id="${esc(id)}"><div class="modal-body"><label class="field">Snapshot date<input class="input" name="date" type="date" value="${esc(b.date)}"></label><label class="field">Search window<input class="input" name="period" maxlength="120" value="${esc(b.period)}" placeholder="Not set, like Last 30 days"></label><p class="muted" style="font-size:13px">The date is when the numbers were exported. The window is the period the searches cover, like “Last 365 days” or “Last 30 days”. With a window, Niche Radar works out the monthly average. Dates and windows on individual rows take precedence.</p></div><footer class="modal-foot"><button class="btn" type="button" data-close="batch-dialog">Cancel</button><button class="btn primary" type="submit">Save</button></footer></form>`;
  hydrateIcons(d);
  d.showModal();
}

/* ---------- Earlier captures and the v2 migration ---------- */

async function refreshCaptures() {
  if (!hasChrome()) return;
  try {
    const items = await chrome.storage.local.get(null);
    pendingCaptures = Object.entries(items).filter(([k, v]) => k.startsWith('radarCapture:') && v?.rows?.length);
    activity = Array.isArray(items.radarActivity) ? items.radarActivity : [];
    Object.assign(companion, items.radarSettings || {});
    renderNotices();
  } catch (e) {
    report(e);
  }
}
async function reviewCaptures() {
  await refreshCaptures();
  for (const [key, c] of pendingCaptures) {
    if (staged.some((f) => f.captureKey === key)) continue;
    if (c.status === 'running' && Date.now() - Date.parse(c.updatedAt) < 60000) {
      toast('A capture is still running. Stop it or let it finish first');
      continue;
    }
    const parsed = {
        headers: ['Keywords', 'Searches', 'Resources', 'Opportunity', 'Peak Season'],
        data: c.rows.map((r) => [r.keyword, String(r.searchesText ?? r.searches), r.resourcesText, r.opportunityText ?? r.opportunity ?? '', r.peakText ?? '']),
      },
      mapping = R.guessMapping(parsed.headers);
    staged.push({ id: uid(), name: c.name || 'TPT capture', captureKey: key, parsed, mapping, result: R.convertRows(parsed, mapping), date: R.isoDate(c.date), period: c.period || '', showMapping: false });
  }
  openImport();
}
async function migrate() {
  if (!hasChrome() || state.migrated) return;
  const old = (await chrome.storage.local.get('scrapedData')).scrapedData;
  await mutate(
    (s) => {
      if (s.migrated) return;
      s.migrated = true;
      if (Array.isArray(old) && old.length) {
        const parsed = {
            headers: ['Keywords', 'Searches', 'Resources', 'Opportunity'],
            data: old.map((r) => [r.keyword, String(r.searchesText ?? r.searches ?? ''), r.resourcesText ?? '', r.opportunityText ?? '']),
          },
          result = R.convertRows(parsed);
        if (result.rows.length)
          R.mergeBatches(s, [
            { id: uid(), name: 'Migrated from extension v2', date: '', period: '', rows: result.rows, duplicateRows: result.duplicateRows, invalidRows: result.errors.length, importedAt: new Date().toISOString() },
          ]);
      }
    },
    { render: false },
  );
}

/* ---------- Tooltip ---------- */

function showTip(text, x, y) {
  const el = $('#tooltip');
  const [title, body] = String(text).split('|');
  el.innerHTML = body != null ? `<strong>${esc(title)}</strong><span class="mono">${esc(body)}</span>` : esc(title);
  if (!el.matches(':popover-open')) topLayer(el);
  const w = el.offsetWidth,
    h = el.offsetHeight;
  el.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, x - w / 2)) + 'px';
  el.style.top = Math.max(8, y - h - 12) + 'px';
}
function hideTip() {
  try {
    $('#tooltip').hidePopover();
  } catch {
    /* already hidden */
  }
}
document.addEventListener('mouseover', (e) => {
  const t = e.target.closest('[data-tip]');
  if (!t) return;
  const box = t.getBoundingClientRect();
  showTip(t.dataset.tip, box.left + box.width / 2, box.top);
});
document.addEventListener('mouseout', (e) => {
  if (e.target.closest('[data-tip]') && !e.relatedTarget?.closest?.('[data-tip]')) hideTip();
});

/* ---------- Theme ---------- */

function applyTheme(choice) {
  try {
    localStorage.setItem('radar-theme', choice);
  } catch {
    /* the choice lasts for this page only */
  }
  const dark = choice === 'dark' || (choice === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.documentElement.dataset.themeChoice = choice;
  renderNav();
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if ((document.documentElement.dataset.themeChoice || 'system') === 'system') applyTheme('system');
});

/* ---------- Events ---------- */

const GO = {
  keywords: () => goKeywords(),
  soon: () => goKeywords({ quick: 'soon' }),
  priority: () => goKeywords({ minScore: '70' }),
  curve: () => goKeywords({ quick: 'curve' }),
};

document.addEventListener('click', async (event) => {
  const t = event.target;
  const el = t.closest('button,a[data-view],[data-row],[data-detail],[data-card]');
  if (!el) return;
  try {
    if (el.dataset.close) {
      $('#' + el.dataset.close).close();
      return;
    }
    if (el.dataset.view) {
      event.preventDefault();
      setView(el.dataset.view);
      return;
    }
    if (el.dataset.go) {
      const g = el.dataset.go;
      if (g.startsWith('month:')) goKeywords({ peak: g.slice(6) });
      else GO[g]?.();
      return;
    }
    if (el.dataset.star) {
      const key = el.dataset.star;
      if ($('#detail').open && key === ui.detailKey && ui.notesDirty) await saveNotes();
      const on = !byKey.get(key)?.meta.starred;
      await mutate((s) => {
        s.meta[key] = { ...(s.meta[key] || {}), starred: on, updatedAt: new Date().toISOString() };
      });
      toast(on ? 'Saved' : 'Removed from saved');
      return;
    }
    if (el.dataset.status) {
      const key = ui.detailKey,
        status = el.dataset.status;
      await mutate((s) => {
        s.meta[key] = { ...(s.meta[key] || {}), status, starred: true, updatedAt: new Date().toISOString() };
      });
      return;
    }
    if (el.dataset.sort) {
      const key = el.dataset.sort;
      ui.direction = ui.sort === key ? -ui.direction : key === 'keyword' || key === 'peak' ? 1 : -1;
      ui.sort = key;
      ui.page = 1;
      renderResults();
      return;
    }
    if (el.dataset.quick) {
      filters.quick = el.dataset.quick;
      ui.page = 1;
      renderExplorer();
      hydrateIcons($('#view'));
      return;
    }
    if (el.dataset.layout) {
      ui.layout = el.dataset.layout;
      savePrefs();
      renderExplorer();
      return;
    }
    if (el.dataset.savedLayout) {
      ui.savedLayout = el.dataset.savedLayout;
      savePrefs();
      renderAll();
      return;
    }
    if (el.dataset.metric) {
      ui.plannerMetric = el.dataset.metric;
      savePrefs();
      renderPlanner();
      return;
    }
    if (el.dataset.month) {
      ui.plannerMonth = el.dataset.month === 'clear' || Number(el.dataset.month) === ui.plannerMonth ? null : Number(el.dataset.month);
      renderPlanner();
      return;
    }
    if (el.dataset.famTab) {
      ui.familiesTab = el.dataset.famTab;
      renderFamilies();
      hydrateIcons($('#view'));
      return;
    }
    if (el.dataset.family) {
      const k = el.dataset.family;
      ui.openFamilies.has(k) ? ui.openFamilies.delete(k) : ui.openFamilies.add(k);
      renderFamilies();
      return;
    }
    if (el.dataset.familyKeywords) {
      if ($('#detail').open) $('#detail').close();
      goKeywords({ seed: el.dataset.familyKeywords, intent: 'all' });
      return;
    }
    if (el.dataset.word) {
      goKeywords({ query: el.dataset.word });
      return;
    }
    if (el.dataset.selectToggle) {
      const k = el.dataset.selectToggle;
      ui.selected.has(k) ? ui.selected.delete(k) : ui.selected.add(k);
      el.textContent = ui.selected.has(k) ? 'Selected for compare' : 'Select to compare';
      if (ui.view === 'explorer' || ui.view === 'watchlist') renderResults();
      return;
    }
    if (el.dataset.removeStage) {
      staged = staged.filter((f) => f.id !== el.dataset.removeStage);
      renderImport();
      return;
    }
    if (el.dataset.toggleMapping) {
      const f = staged.find((x) => x.id === el.dataset.toggleMapping);
      f.showMapping = !f.showMapping;
      renderImport();
      return;
    }
    if (el.dataset.editBatch) return editBatch(el.dataset.editBatch);
    if (el.dataset.showSource) {
      goKeywords({ source: el.dataset.showSource, intent: 'all' });
      ui.advanced = true;
      renderExplorer();
      return;
    }
    if (el.dataset.deleteBatch) {
      const batch = state.batches.find((x) => x.id === el.dataset.deleteBatch);
      if (batch && confirm(`Remove “${batch.name}”? Keywords that only this source backs will disappear. Notes stay, and you can import the file again later.`)) {
        await mutate((s) => (s.batches = s.batches.filter((x) => x.id !== batch.id)));
        toast('Source removed. Other sources and notes are unchanged');
      }
      return;
    }
    if (el.dataset.export) {
      exportData(el.dataset.export);
      return;
    }
    if (el.dataset.companion) {
      companion[el.dataset.companion] = !companion[el.dataset.companion];
      el.setAttribute('aria-checked', String(companion[el.dataset.companion]));
      await chrome.storage.local.set({ radarSettings: { ...companion } });
      return;
    }
    if (el.dataset.themeChoice) {
      applyTheme(el.dataset.themeChoice);
      return;
    }
    if (el.dataset.detail && !t.closest('input,.star,[data-star]')) {
      openDetail(el.dataset.detail);
      return;
    }
    if (el.dataset.row && !t.closest('input,button,a,label')) {
      openDetail(el.dataset.row);
      return;
    }
    switch (el.dataset.action) {
      case 'pick':
        $('#file-input').click();
        break;
      case 'load-attached':
        if (globalThis.RADAR_ATTACHED) await acceptFiles(RADAR_ATTACHED.map((f) => new File([f.text], f.name, { type: 'text/csv' })));
        break;
      case 'commit-import':
        await commitImport();
        break;
      case 'advanced':
        ui.advanced = !ui.advanced;
        renderExplorer();
        break;
      case 'reset-filters':
        resetFilters();
        renderExplorer();
        break;
      case 'show-all-intents':
        filters.intent = 'all';
        renderExplorer();
        break;
      case 'prev-page':
        ui.page--;
        renderResults();
        break;
      case 'next-page':
        ui.page++;
        renderResults();
        break;
      case 'clear-selected':
        ui.selected.clear();
        renderResults();
        break;
      case 'compare':
        compare();
        break;
      case 'bulk-save':
        await mutate((s) => {
          for (const key of ui.selected) s.meta[key] = { ...(s.meta[key] || {}), starred: true, updatedAt: new Date().toISOString() };
        });
        toast(`${fmt(ui.selected.size)} keywords saved`);
        break;
      case 'export-selected':
        exportData('selected');
        break;
      case 'export':
        $('#export-count').textContent = `${fmt(filtered().length)} keywords in the current view · ${fmt(ui.selected.size)} selected`;
        $('#export-dialog').showModal();
        break;
      case 'backup':
        exportData('backup');
        break;
      case 'pre-upgrade': {
        const copy = await RadarStore.preUpgrade();
        if (copy?.state) download('Niche-Radar-v3-Copy-' + copy.savedAt.slice(0, 10) + '.json', JSON.stringify({ ...copy.state, exportedAt: new Date().toISOString() }, null, 2), 'application/json');
        break;
      }
      case 'review-captures':
        await reviewCaptures();
        break;
    }
  } catch (e) {
    report(e);
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === '/' && !e.ctrlKey && !e.metaKey && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName) && !$('dialog[open]')) {
    e.preventDefault();
    $('#search-input').focus();
  }
  if (e.key === 'Enter' && e.target.matches('[data-card],[data-row]') && !e.target.closest('input,button')) openDetail(e.target.dataset.card || e.target.dataset.row);
});

document.addEventListener('input', (event) => {
  const el = event.target;
  if (el.id === 'search-input') {
    filters.query = el.value;
    ui.page = 1;
    if (ui.view !== 'explorer' && ui.view !== 'watchlist' && el.value.trim()) setView('explorer', { keepFilters: true });
    else if (ui.view === 'explorer') {
      renderExplorer();
      hydrateIcons($('#view'));
    } else renderAll();
    return;
  }
  if (el.dataset.filter && el.tagName === 'INPUT') {
    filters[el.dataset.filter] = el.value;
    ui.page = 1;
    renderResults();
  }
  if (el.dataset.stageField) {
    const f = staged.find((x) => x.id === el.dataset.id);
    f[el.dataset.stageField] = el.value;
    updateImportSummary();
  }
  if (['detail-notes', 'detail-tags'].includes(el.id)) {
    ui.notesDirty = true;
    $('#notes-state').textContent = 'Editing';
    clearTimeout(notesTimer);
    notesTimer = setTimeout(() => saveNotes().catch(report), 900);
  }
});

document.addEventListener('change', async (event) => {
  const el = event.target;
  try {
    if (el.id === 'file-input') return await acceptFiles([...el.files]);
    if (el.id === 'intent-filter' || el.id === 'label-filter' || el.id === 'peak-filter') {
      filters[{ 'intent-filter': 'intent', 'label-filter': 'label', 'peak-filter': 'peak' }[el.id]] = el.value;
      ui.page = 1;
      renderExplorer();
      return;
    }
    if (el.id === 'preset-select') return await mutate((s) => (s.settings.preset = el.value));
    if (el.id === 'lead-weeks') {
      const v = Math.max(1, Math.min(16, Math.round(Number(el.value) || 6)));
      return await mutate((s) => (s.settings.leadWeeks = v));
    }
    if (el.dataset.filter) {
      filters[el.dataset.filter] = el.value;
      ui.page = 1;
      renderResults();
      return;
    }
    if (el.id === 'page-size') {
      ui.pageSize = Number(el.value);
      ui.page = 1;
      savePrefs();
      renderResults();
      return;
    }
    if (el.dataset.select) {
      el.checked ? ui.selected.add(el.dataset.select) : ui.selected.delete(el.dataset.select);
      renderResults();
      return;
    }
    if (el.id === 'select-page') {
      for (const r of filtered().slice((ui.page - 1) * ui.pageSize, ui.page * ui.pageSize)) el.checked ? ui.selected.add(r.key) : ui.selected.delete(r.key);
      renderResults();
      return;
    }
    if (el.dataset.map) {
      const f = staged.find((x) => x.id === el.dataset.id);
      f.mapping[el.dataset.map] = Number(el.value);
      f.result = R.convertRows(f.parsed, f.mapping);
      renderImport();
      return;
    }
    if (el.id === 'detail-intent') await saveNotes();
  } catch (e) {
    report(e);
  }
});

document.addEventListener('submit', async (event) => {
  if (event.target.id !== 'batch-form') return;
  event.preventDefault();
  const form = event.target;
  try {
    await mutate((s) => {
      const b = s.batches.find((x) => x.id === form.dataset.id);
      b.date = R.isoDate(form.elements.date.value);
      b.period = form.elements.period.value.trim().slice(0, 120);
    });
    $('#batch-dialog').close();
    toast('Snapshot updated. Scores, averages and changes recalculated');
  } catch (e) {
    report(e);
  }
});

$('#detail').addEventListener('close', () => {
  if (ui.notesDirty) saveNotes().catch(report);
  ui.detailKey = null;
  hideTip();
  if (location.hash.startsWith('#keyword=')) history.replaceState(null, '', '#' + ui.view);
});
$('#detail').addEventListener('click', (e) => {
  if (e.target === $('#detail')) $('#detail').close();
});

/* Drag cards between status lanes */
let dragKey = null;
document.addEventListener('dragstart', (e) => {
  const card = e.target.closest?.('[data-card]');
  if (!card) return;
  dragKey = card.dataset.card;
  card.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', dragKey);
});
document.addEventListener('dragend', (e) => {
  e.target.closest?.('[data-card]')?.classList.remove('dragging');
  $$('.lane.drag-over').forEach((l) => l.classList.remove('drag-over'));
  dragKey = null;
});

/* Files dropped anywhere import, cards dropped on a lane change status */
let dragDepth = 0;
const isFileDrag = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
document.addEventListener('dragenter', (e) => {
  if (isFileDrag(e)) {
    e.preventDefault();
    dragDepth++;
    $('#drop-overlay').hidden = false;
  }
});
document.addEventListener('dragover', (e) => {
  if (isFileDrag(e)) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    return;
  }
  const lane = e.target.closest?.('.lane');
  if (dragKey && lane) {
    e.preventDefault();
    $$('.lane.drag-over').forEach((l) => l !== lane && l.classList.remove('drag-over'));
    lane.classList.add('drag-over');
  }
});
document.addEventListener('dragleave', (e) => {
  if (!isFileDrag(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) $('#drop-overlay').hidden = true;
});
document.addEventListener('drop', async (e) => {
  const lane = e.target.closest?.('.lane');
  if (dragKey && lane) {
    e.preventDefault();
    const key = dragKey,
      status = lane.dataset.lane;
    await mutate((s) => {
      s.meta[key] = { ...(s.meta[key] || {}), status, starred: true, updatedAt: new Date().toISOString() };
    }).catch(report);
    return;
  }
  e.preventDefault();
  dragDepth = 0;
  $('#drop-overlay').hidden = true;
  if (e.dataTransfer.files.length) await acceptFiles([...e.dataTransfer.files]);
});

window.addEventListener('error', (e) => toast(e.message || 'Something went wrong. Export a backup, then reload', true));
window.addEventListener('unhandledrejection', (e) => report(e.reason));
window.addEventListener('hashchange', () => routeFromHash());

function routeFromHash() {
  const h = decodeURIComponent(location.hash.slice(1));
  if (h.startsWith('keyword=')) {
    const k = R.keyOf(h.slice(8));
    if (byKey.has(k)) openDetail(k);
    else toast(`“${h.slice(8)}” is not in the workspace yet`);
    return;
  }
  if (VIEWS.includes(h) && h !== ui.view) setView(h);
}

RadarStore.onChange(async () => {
  setData(await RadarStore.read());
  renderAll();
});
if (hasChrome())
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (Object.keys(changes).some((k) => k.startsWith('radarQueue:') && changes[k].newValue)) RadarIngest.drain().catch(report);
    if (Object.keys(changes).some((k) => k.startsWith('radarCapture:')) || changes.radarActivity || changes.radarSettings)
      refreshCaptures().then(() => {
        if (ui.view === 'history' || ui.view === 'settings') renderAll();
      });
  });

(async () => {
  loadPrefs();
  hydrateIcons();
  try {
    $('#view').innerHTML = '<div class="loading">Opening your workspace</div>';
    setData(await RadarStore.read());
    await migrate();
    if (hasChrome() && globalThis.RadarIngest) {
      await RadarIngest.drain().catch(report);
      setData(await RadarStore.read());
    }
    await refreshCaptures();
    hasPreUpgrade = !!(await RadarStore.preUpgrade().catch(() => null));
    const h = decodeURIComponent(location.hash.slice(1));
    ui.view = VIEWS.includes(h) ? h : data.rows.length && !data.rows.some((r) => r.peakMonth != null) ? 'explorer' : 'planner';
    resetFilters();
    renderAll();
    if (h.startsWith('keyword=')) routeFromHash();
  } catch (e) {
    $('#view').innerHTML = `<p class="note error">Could not open browser storage: ${esc(e.message)}. Allow site data for this extension, or open the dashboard from the installed extension.</p>`;
    report(e);
  }
})();
