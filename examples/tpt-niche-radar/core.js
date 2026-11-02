/* Niche Radar data engine. Pure functions shared by the dashboard, the capture
   scripts, the background worker and the regression tests.

   Storage compatibility: the workspace keeps schema 3. Every field added in v4
   (peak month, monthly average, insights, batch kind and seed) is optional, so a
   v3 workspace opens unchanged and old signatures still match, which keeps
   repeat imports of old CSVs from being added twice. */
(function (root) {
  'use strict';

  const clamp = (n, a = 0, b = 1) => Math.max(a, Math.min(b, n));
  const DAY = 86400000;

  const normalize = (s) =>
    String(s ?? '')
      .normalize('NFKC')
      .replace(/[‘’]/g, "'")
      .replace(/[–—−]/g, '-')
      .trim()
      .replace(/\s+/g, ' ')
      .toLocaleLowerCase('en-US');
  const keyOf = (s) => 'kw:' + normalize(s);
  const labelOf = (s) => {
    const v = normalize(s).replace(/\s*opportunity$/, '');
    return (
      {
        strong: 'Strong',
        high: 'Strong',
        promising: 'Promising',
        moderate: 'Moderate',
        challenging: 'Challenging',
        low: 'Challenging',
        'very difficult': 'Very Difficult',
      }[v] || 'Unknown'
    );
  };

  function number(s) {
    const v = String(s ?? '')
      .trim()
      .replace(/[,\s ]/g, '');
    const m = v.match(/^(\d+(?:\.\d+)?)\s*([kmb])?$/i);
    if (!m) return null;
    const n = Number(m[1]) * ({ k: 1e3, m: 1e6, b: 1e9 }[m[2]?.toLowerCase()] || 1);
    return Number.isFinite(n) && n <= 1e12 ? n : null;
  }

  function resources(s) {
    const text = String(s ?? '').trim(),
      v = text
        .replace(/[–—−]/g, '-')
        .replace(/,/g, '')
        .replace(/resources?|results?/gi, '')
        .trim();
    let m = v.match(/^(<|<=|≤|>|>=|≥)\s*(.+)$/),
      low,
      high,
      open = false;
    if (m) {
      const n = number(m[2]);
      if (n === null) return null;
      if (['<', '<=', '≤'].includes(m[1])) {
        low = 0;
        high = n;
      } else {
        low = n;
        high = null;
        open = true;
      }
    } else if (v.endsWith('+')) {
      low = number(v.slice(0, -1));
      high = null;
      open = true;
    } else if (v.includes('-')) {
      const parts = v.split('-');
      if (parts.length !== 2) return null;
      low = number(parts[0]);
      high = number(parts[1]);
    } else {
      low = number(v);
      high = low;
    }
    if (low === null || (!open && high === null) || (!open && high < low)) return null;
    return { low, high, open, proxy: open ? Math.max(low, 1) : Math.max(high, 1), text };
  }

  function isoDate(s) {
    if (!s) return '';
    const v = String(s).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return '';
    const d = new Date(v + 'T12:00:00Z');
    return Number.isFinite(d.valueOf()) && d.toISOString().slice(0, 10) === v ? v : '';
  }

  /* ---------- Months, windows and seasons ---------- */

  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const MONTHS_SHORT = MONTHS.map((m) => m.slice(0, 3));

  /** Month index 0 to 11 from "January", "Jan", "jan.", "Sept", "Peak month (Jan)" or 1 to 12. Null when unknown. */
  function monthOf(s) {
    if (typeof s === 'number') return Number.isInteger(s) && s >= 0 && s <= 11 ? s : null;
    const v = normalize(s).replace(/[^a-z0-9 ]/g, ' ');
    if (!v) return null;
    if (/^\d{1,2}$/.test(v.trim())) {
      const n = Number(v) - 1;
      return n >= 0 && n <= 11 ? n : null;
    }
    const words = v.split(/\s+/);
    for (const w of words) {
      if (w.length < 3) continue;
      const i = MONTHS.findIndex((m) => m.toLowerCase() === w || m.toLowerCase().slice(0, 3) === w || (w === 'sept' && m === 'September'));
      if (i >= 0) return i;
    }
    return null;
  }

  /** Days covered by a search window label, like "Last 365 days" or "September 2026". Null when unknown. */
  function windowDays(period) {
    const v = normalize(period);
    if (!v) return null;
    let m = v.match(/(\d+(?:\.\d+)?)\s*(day|week|month|year|yr)s?\b/);
    if (m) {
      const n = Number(m[1]);
      const days = { day: 1, week: 7, month: 30.4375, year: 365, yr: 365 }[m[2]] * n;
      return days > 0 && days <= 3660 ? Math.round(days) : null;
    }
    if (/\b(past|last|previous|trailing) (year|12 months)\b|\bannual\b|\byearly\b/.test(v)) return 365;
    if (/\b(past|last|previous) (month)\b/.test(v)) return 30;
    if (/\b(past|last|previous) (week)\b/.test(v)) return 7;
    if (/\bq[1-4]\b|\bquarter\b/.test(v)) return 91;
    if (monthOf(v) !== null && /\b(19|20)\d{2}\b/.test(v) && !/-|to|through/.test(v)) return 30;
    return null;
  }

  /** Average searches per month: reported when the source gave it, otherwise derived from a known window. */
  function monthlyAverage(row) {
    if (row && typeof row.avg === 'number' && Number.isFinite(row.avg) && row.avg >= 0) return { value: row.avg, source: 'reported' };
    const days = windowDays(row?.period);
    if (!days || row?.searches == null) return { value: null, source: null };
    const months = days >= 360 && days <= 366 ? 12 : days / 30.4375;
    return { value: row.searches / months, source: 'window' };
  }

  /* Seasonal wording hints. Each pattern maps to the month TPT buyers usually search in.
     These are hints for keywords that have no TPT peak data, and they are always shown as inferred. */
  const SEASON_HINTS = [
    [/\b(lunar|chinese) new year\b/, 0],
    [/\bnew years?\b|\bnew year'?s\b/, 0],
    [/\bmlk\b|\bmartin luther king\b/, 0],
    [/\bgroundhog\b/, 1],
    [/\bvalentine/, 1],
    [/\bblack history\b/, 1],
    [/\bpresidents'? ?day\b/, 1],
    [/\bdr\.? seuss\b|\bread across america\b/, 1],
    [/\bst\.? patrick|\bleprechaun|\bshamrock/, 2],
    [/\bwomen'?s history\b/, 2],
    [/\bpi day\b/, 2],
    [/\beaster\b/, 2],
    [/\bspring\b/, 2],
    [/\bearth day\b/, 3],
    [/\bpoetry month\b/, 3],
    [/\btest prep\b|\bstate test|\bstaar\b/, 3],
    [/\bmother'?s day\b|\bcinco de mayo\b|\bteacher appreciation\b|\bmemorial day\b/, 4],
    [/\bend of (the )?(school )?year\b|\blast day of school\b|\bgraduation\b/, 4],
    [/\bfather'?s day\b|\bjuneteenth\b/, 5],
    [/\bfourth of july\b|\b4th of july\b|\bindependence day\b/, 5],
    [/\bsummer\b/, 5],
    [/\bback to school\b|\bfirst (day|week) of school\b|\ball about me\b|\bmeet the teacher\b|\bopen house\b|\bclassroom rules\b/, 7],
    [/\bhispanic heritage\b|\bconstitution day\b|\bpatriot day\b|\bseptember 11\b|\b9\/11\b|\bgrandparents'? day\b|\blabor day\b/, 8],
    [/\bfall\b|\bautumn\b/, 8],
    [/\bhalloween\b|\bday of the dead\b|\bdia de los muertos\b|\bpumpkin|\bcolumbus day\b|\bindigenous peoples'? day\b|\bfire (safety|prevention)\b|\bred ribbon\b/, 9],
    [/\bthanksgiving\b|\bveterans'? day\b|\bnative american heritage\b|\belection\b/, 10],
    [/\bchristmas\b|\bxmas\b|\bgingerbread\b|\bsanta\b|\bhanukkah\b|\bkwanzaa\b|\bholidays? around the world\b|\bgrinch\b|\bholiday\b|\bwinter\b|\bsnowm[ae]n\b/, 11],
  ];
  function inferPeak(keyword) {
    const k = normalize(keyword);
    for (const [re, month] of SEASON_HINTS) if (re.test(k)) return month;
    return null;
  }
  const SEASONAL_WORDS = /halloween|christmas|thanksgiving|valentine|easter|heritage month|back to school|end of year|fall\b|autumn|winter|spring|summer|st patrick|new year/i;

  /** Months from `now` until the next occurrence of `peak`. 0 means the peak is this month. */
  function monthsUntil(peak, now = new Date()) {
    if (peak == null) return null;
    return (peak - new Date(now).getMonth() + 12) % 12;
  }
  function timingOf(monthsToPeak, share) {
    if (monthsToPeak == null) return { key: 'unknown', label: 'No peak data' };
    if (share != null && share < 0.15) return { key: 'evergreen', label: 'Evergreen' };
    if (monthsToPeak === 0) return { key: 'now', label: 'In season' };
    if (monthsToPeak <= 2) return { key: 'build', label: 'Build now' };
    if (monthsToPeak <= 4) return { key: 'plan', label: 'Plan next' };
    return { key: 'later', label: 'Later' };
  }
  /** Date a listing should be live: the first day of the next peak month minus `leadWeeks`. */
  function publishBy(peak, now = new Date(), leadWeeks = 6) {
    if (peak == null) return '';
    const n = new Date(now);
    let year = n.getFullYear();
    if (peak < n.getMonth()) year++;
    const d = new Date(Date.UTC(year, peak, 1, 12) - leadWeeks * 7 * DAY);
    return d.toISOString().slice(0, 10);
  }

  /* ---------- Delimited text ---------- */

  function parseDelimited(text, delimiter) {
    text = String(text).replace(/^﻿/, '');
    if (!delimiter) {
      const first = text.split(/\r?\n/)[0];
      delimiter = [',', ';', '\t'].sort((a, b) => first.split(b).length - first.split(a).length)[0];
    }
    const rows = [];
    let row = [],
      field = '',
      quoted = false,
      after = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (c === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i++;
          } else {
            quoted = false;
            after = true;
          }
        } else field += c;
      } else if (c === '"' && !field.trim() && !after) {
        field = '';
        quoted = true;
      } else if (c === delimiter) {
        row.push(field);
        field = '';
        after = false;
      } else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field);
        if (row.some((x) => x.trim())) rows.push(row);
        row = [];
        field = '';
        after = false;
      } else {
        if (after && !/\s/.test(c)) throw new Error('Unexpected text after a closing quote. Check the CSV formatting.');
        field += c;
      }
    }
    if (quoted) throw new Error('A quoted field is not closed. Re-export this CSV and try again.');
    row.push(field);
    if (row.some((x) => x.trim())) rows.push(row);
    return { headers: rows.shift() || [], data: rows, delimiter };
  }

  const aliases = {
    keyword: ['keywords', 'keyword', 'search term', 'search terms', 'term', 'query', 'keyword phrase'],
    searches: ['searches', 'search volume', 'volume', 'search count', 'searches text', 'searchestext', 'total searches'],
    resources: ['resources', 'resource count', 'competition', 'results', 'resources available', 'resourcestext'],
    opportunity: ['opportunity', 'opportunitytext', 'tpt opportunity', 'source opportunity'],
    date: ['date', 'snapshot date', 'captured at', 'observed date'],
    period: ['period', 'search window', 'window', 'reporting period'],
    peak: ['peak season', 'peak month', 'peak', 'season', 'peak seasons'],
    avg: ['avg. searches/month', 'avg searches/month', 'avg searches per month', 'average searches per month', 'avg monthly searches', 'monthly searches', 'avg/month', 'avg searches / month', 'avg. searches / month', 'average monthly searches'],
  };
  const OPTIONAL_FIELDS = ['opportunity', 'date', 'period', 'peak', 'avg'];
  function guessMapping(headers) {
    return Object.fromEntries(Object.entries(aliases).map(([k, names]) => [k, headers.findIndex((h) => names.includes(normalize(h)))]));
  }
  const mapped = (mapping, k) => mapping[k] != null && mapping[k] >= 0;

  function convertRows(parsed, mapping = guessMapping(parsed.headers)) {
    const rows = [],
      errors = [],
      seen = new Set();
    let duplicateRows = 0;
    if (
      ['keyword', 'searches', 'resources'].some((k) => !mapped(mapping, k)) ||
      new Set(['keyword', 'searches', 'resources'].map((k) => mapping[k])).size !== 3
    )
      return { rows, errors: [{ line: 1, message: 'Map Keyword, Searches and Resources before importing.' }], duplicateRows, mapping, incomplete: true };
    parsed.data.forEach((r, index) => {
      if (r.length !== parsed.headers.length) {
        errors.push({ line: index + 2, message: 'Column count does not match the header.' });
        return;
      }
      const keyword = String(r[mapping.keyword] ?? '')
          .trim()
          .replace(/\s+/g, ' '),
        searches = number(r[mapping.searches]),
        resourceText = String(r[mapping.resources] ?? '').trim();
      const rawDate = mapped(mapping, 'date') ? r[mapping.date] : '';
      if (!keyword || keyword.length > 300 || searches === null || !resourceText || resourceText.length > 100 || (rawDate && !isoDate(rawDate))) {
        errors.push({
          line: index + 2,
          message: !keyword
            ? 'Empty keyword.'
            : searches === null
              ? 'Searches must be a non-negative number (not a range).'
              : rawDate && !isoDate(rawDate)
                ? 'Use YYYY-MM-DD for dates.'
                : 'Missing or invalid keyword/resources.',
        });
        return;
      }
      const item = {
        keyword,
        key: keyOf(keyword),
        searches,
        resourcesText: resourceText,
        opportunity: labelOf(mapped(mapping, 'opportunity') ? r[mapping.opportunity] : ''),
        date: isoDate(rawDate),
        period: mapped(mapping, 'period') ? String(r[mapping.period] ?? '').trim().slice(0, 120) : '',
      };
      const peak = mapped(mapping, 'peak') ? monthOf(r[mapping.peak]) : null;
      if (peak !== null) item.peak = peak;
      const avg = mapped(mapping, 'avg') ? number(r[mapping.avg]) : null;
      if (avg !== null) item.avg = avg;
      const sig = rowSignature(item);
      if (seen.has(sig)) {
        duplicateRows++;
        return;
      }
      seen.add(sig);
      rows.push(item);
    });
    return { rows, errors, duplicateRows, mapping, incomplete: false };
  }

  /* The first six entries are the v3 signature. Peak and average are appended only when present,
     so every v3 row keeps exactly the signature it had before. */
  function rowSignature(r, date = '', period = '') {
    const res = resources(r.resourcesText);
    const sig = [
      r.key || keyOf(r.keyword),
      r.searches,
      res ? [res.low, res.high] : normalize(r.resourcesText),
      labelOf(r.opportunity),
      r.date || date,
      normalize(r.period || period),
    ];
    if (r.peak != null) sig.push('peak:' + r.peak);
    if (r.avg != null) sig.push('avg:' + r.avg);
    return JSON.stringify(sig);
  }
  function batchSignature(b) {
    return JSON.stringify(b.rows.map((r) => rowSignature(r, b.date, b.period)).sort());
  }
  function emptyState() {
    return { schema: 3, batches: [], meta: {}, settings: { preset: 'balanced' }, migrated: false, insights: {} };
  }
  function mergeBatches(state, incoming) {
    let added = 0,
      skipped = 0;
    const signatures = new Set(state.batches.map(batchSignature));
    for (const b of incoming) {
      const sig = batchSignature(b);
      if (!b.rows.length || signatures.has(sig)) {
        skipped++;
        continue;
      }
      signatures.add(sig);
      state.batches.push(b);
      added++;
    }
    return { added, skipped };
  }

  /* ---------- Keyword insights (the single keyword view on TPT) ---------- */

  /** Validates and trims an insight object read from TPT or from a backup. Returns null when unusable. */
  function cleanInsight(raw) {
    if (!raw || typeof raw !== 'object' || typeof raw.keyword !== 'string' || !raw.keyword.trim() || raw.keyword.length > 300) return null;
    const date = isoDate(raw.date);
    if (!date) return null;
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1e12 ? v : null);
    const weekly = Array.isArray(raw.weekly)
      ? raw.weekly
          .filter((w) => Array.isArray(w) && isoDate(w[0]) && num(w[1]) !== null)
          .slice(0, 60)
          .map((w) => [w[0], Math.round(w[1] * 10) / 10])
      : [];
    const share = num(raw.peakShare);
    return {
      keyword: raw.keyword.trim().replace(/\s+/g, ' '),
      date,
      avg: num(raw.avg),
      total: num(raw.total),
      windowDays: num(raw.windowDays) && raw.windowDays <= 3660 ? Math.round(raw.windowDays) : null,
      range: String(raw.range || '').slice(0, 60),
      resourcesText: String(raw.resourcesText || '').slice(0, 100),
      opportunity: labelOf(raw.opportunity),
      peak: monthOf(raw.peak),
      peakShare: share !== null && share <= 1 ? share : null,
      peakSearches: num(raw.peakSearches),
      weekly,
      capturedAt: typeof raw.capturedAt === 'string' && Number.isFinite(Date.parse(raw.capturedAt)) ? raw.capturedAt : new Date().toISOString(),
    };
  }

  /** Adds an insight to state.insights, one per keyword and date, newest first. */
  function addInsight(state, raw) {
    const insight = cleanInsight(raw);
    if (!insight) return null;
    if (!state.insights || typeof state.insights !== 'object') state.insights = {};
    const key = keyOf(insight.keyword);
    const list = (Object.hasOwn(state.insights, key) ? state.insights[key] : []).filter((x) => x.date !== insight.date);
    list.push(insight);
    list.sort((a, b) => b.date.localeCompare(a.date));
    state.insights[key] = list.slice(0, 36);
    return insight;
  }

  /** Twelve calendar months of searches from a weekly series, splitting weeks that cross a month by day. */
  function monthlyProfile(weekly) {
    if (!Array.isArray(weekly) || weekly.length < 4) return null;
    const months = new Array(12).fill(0);
    for (const [start, value] of weekly) {
      const t = Date.parse(start + 'T12:00:00Z');
      if (!Number.isFinite(t)) continue;
      for (let d = 0; d < 7; d++) months[new Date(t + d * DAY).getUTCMonth()] += value / 7;
    }
    const total = months.reduce((a, b) => a + b, 0);
    if (!total) return null;
    const peak = months.indexOf(Math.max(...months));
    return { months, total, peak, share: months[peak] / total };
  }

  /* ---------- Scoring ---------- */

  const presets = {
    balanced: { demand: 0.35, competition: 0.35, efficiency: 0.2, label: 0.1 },
    lowCompetition: { demand: 0.2, competition: 0.5, efficiency: 0.2, label: 0.1 },
    demand: { demand: 0.55, competition: 0.2, efficiency: 0.15, label: 0.1 },
    timing: { demand: 0.3, competition: 0.3, efficiency: 0.15, label: 0.1, timing: 0.15 },
  };
  /* Timing favors keywords whose peak is one to three months away, the window to build and get indexed. */
  const TIMING_VALUE = [0.6, 1, 1, 0.8, 0.6, 0.45, 0.3, 0.3, 0.3, 0.3, 0.3, 0.45];
  function score(row, preset = 'balanced', opts = {}) {
    const r = resources(row.resourcesText);
    if (!r || row.searches == null) return { score: null, parts: [], resource: r, ratio: null };
    const w = presets[preset] || presets.balanced;
    const peak = opts.peak !== undefined ? opts.peak : row.peak ?? null;
    const until = monthsUntil(peak, opts.now || new Date());
    const values = {
      demand: clamp(Math.log10(1 + row.searches) / 5),
      competition: r.open ? 0 : 1 - clamp(Math.log10(Math.max(100, r.proxy) / 100) / Math.log10(500000 / 100)),
      efficiency: r.open ? 0 : clamp(Math.log10(1 + (row.searches / r.proxy) * 100) / Math.log10(101)),
      label: { Strong: 1, Promising: 0.75, Moderate: 0.5, Challenging: 0.25, 'Very Difficult': 0, Unknown: 0.5 }[labelOf(row.opportunity)],
      timing: until == null ? 0.5 : TIMING_VALUE[until],
    };
    const parts = Object.entries(w).map(([name, weight]) => ({ name, weight, value: values[name], points: values[name] * weight * 100 }));
    return { score: Math.round(parts.reduce((s, p) => s + p.points, 0)), parts, resource: r, ratio: (row.searches / r.proxy) * 1000 };
  }

  const brandHints = [
    'my nerdy teacher',
    'teacher resource cabin',
    'morpheme magic',
    'teaching with a mountain view',
    'jennifer findley',
    'literacy loft',
    'what i have learned',
    'ufli',
    'mystery science',
    'miss redacted',
    'missredacted',
  ];
  function intentOf(keyword, override) {
    if (['general', 'brand', 'free'].includes(override)) return override;
    const k = normalize(keyword);
    if (/\bfree(?:bie|bies)?\b/.test(k)) return 'free';
    return brandHints.some((name) => k === name || k.includes(name + ' ') || k.endsWith(' ' + name)) ? 'brand' : 'general';
  }

  /* ---------- Aggregation ---------- */

  function aggregate(state, opts = {}) {
    const now = opts.now || new Date();
    const leadWeeks = state.settings?.leadWeeks || 6;
    const insights = state.insights && typeof state.insights === 'object' ? state.insights : {};
    const map = new Map();
    const seedsOf = new Map();
    const relatedOf = new Map();
    let overlaps = 0;
    for (const b of state.batches) {
      const seedKey = b.seed ? keyOf(b.seed) : '';
      for (const row of b.rows) {
        const key = keyOf(row.keyword);
        if (seedKey && key !== seedKey) {
          if (!seedsOf.has(key)) seedsOf.set(key, new Set());
          seedsOf.get(key).add(b.seed);
          if (!relatedOf.has(seedKey)) relatedOf.set(seedKey, new Set());
          relatedOf.get(seedKey).add(key);
        }
        let g = map.get(key);
        if (!g) {
          g = { key, keyword: row.keyword, history: [], _seen: new Map() };
          map.set(key, g);
        }
        const sig = rowSignature(row, b.date, b.period),
          existing = g._seen.get(sig);
        if (existing) {
          existing.sources.push({ id: b.id, name: b.name });
          if ((b.importedAt || '') > (existing.importedAt || '')) {
            existing.importedAt = b.importedAt;
            existing.batchId = b.id;
          }
          overlaps++;
          continue;
        }
        const ob = {
          ...row,
          key,
          date: row.date || b.date || '',
          period: row.period || b.period || '',
          importedAt: b.importedAt,
          batchId: b.id,
          sources: [{ id: b.id, name: b.name }],
        };
        g.history.push(ob);
        g._seen.set(sig, ob);
      }
    }
    const result = [...map.values()].map((g) => {
      g.history.sort(
        (a, b) => (b.date || '').localeCompare(a.date || '') || (b.importedAt || '').localeCompare(a.importedAt || '') || b.batchId.localeCompare(a.batchId),
      );
      const current = g.history[0];
      const sameDate = g.history.filter((h) => h.date === current.date && normalize(h.period) === normalize(current.period));
      const conflict = new Set(sameDate.map((h) => JSON.stringify([h.searches, normalize(h.resourcesText), h.opportunity]))).size > 1;
      const prev =
        current.date && current.period
          ? g.history.find((h) => h.date && h.date < current.date && normalize(h.period) === normalize(current.period))
          : null;
      const delta = prev && prev.searches > 0 ? ((current.searches - prev.searches) / prev.searches) * 100 : null;
      const meta = Object.hasOwn(state.meta, g.key) ? state.meta[g.key] : {};

      // Season: TPT's reported peak first, then the weekly curve, then wording.
      const insightList = Object.hasOwn(insights, g.key) && Array.isArray(insights[g.key]) ? insights[g.key] : [];
      const insight = insightList[0] || null;
      const profile = insight ? monthlyProfile(insight.weekly) : null;
      const withPeak = g.history.find((h) => h.peak != null);
      let peakMonth = null,
        peakSource = null;
      if (withPeak) {
        peakMonth = withPeak.peak;
        peakSource = 'tpt';
      } else if (insight?.peak != null) {
        peakMonth = insight.peak;
        peakSource = 'tpt';
      } else if (profile) {
        peakMonth = profile.peak;
        peakSource = 'curve';
      } else {
        const inferred = inferPeak(current.keyword);
        if (inferred != null) {
          peakMonth = inferred;
          peakSource = 'wording';
        }
      }
      const seasonShare = insight?.peakShare ?? (profile && profile.peak === peakMonth ? profile.share : null);
      const until = monthsUntil(peakMonth, now);
      const timing = timingOf(until, seasonShare);
      const average = monthlyAverage(current.avg == null && insight?.avg != null && insight.date === current.date ? { ...current, avg: insight.avg } : current);
      const scored = score(current, state.settings?.preset, { now, peak: peakMonth });

      return {
        ...g,
        ...current,
        ...scored,
        meta,
        intent: intentOf(current.keyword, meta.intent),
        previous: prev,
        delta,
        conflict,
        undatedCount: g.history.filter((h) => !h.date).length,
        seasonal: SEASONAL_WORDS.test(current.keyword) || peakSource === 'wording' || (seasonShare != null && seasonShare >= 0.3),
        peakMonth,
        peakSource,
        seasonShare,
        monthsToPeak: until,
        timing,
        publishBy: timing.key === 'evergreen' ? '' : publishBy(peakMonth, now, leadWeeks),
        avgMonthly: average.value,
        avgSource: average.source,
        windowDays: windowDays(current.period),
        insight,
        insightCount: insightList.length,
        profile,
        seeds: [...(seedsOf.get(g.key) || [])],
        relatedKeys: [...(relatedOf.get(g.key) || [])],
        _seen: undefined,
      };
    });
    return { rows: result, overlaps, observations: result.reduce((n, r) => n + r.history.length, 0) };
  }

  function tier(n) {
    return n === null || n === undefined ? 'Unscored' : n >= 70 ? 'Priority' : n >= 55 ? 'Worth exploring' : n >= 40 ? 'Selective' : 'Harder entry';
  }

  const stop = new Set(
    'a an the and or of for in to with on by is at grade grades activity activities worksheet worksheets printable printables resource resources'.split(' '),
  );
  function clusters(rows) {
    const groups = new Map();
    for (const r of rows) {
      const words = [
        ...new Set(
          normalize(r.keyword)
            .split(/[^a-z0-9'-]+/)
            .filter((x) => x.length > 2 && !stop.has(x)),
        ),
      ];
      for (const word of words) {
        if (!groups.has(word)) groups.set(word, []);
        groups.get(word).push(r);
      }
    }
    return [...groups]
      .filter(([, rs]) => rs.length >= 2)
      .map(([term, rs]) => ({
        term,
        count: rs.length,
        best: [...rs].sort((a, b) => (b.score ?? -1) - (a.score ?? -1))[0],
        rows: rs,
        avg: Math.round(rs.reduce((a, r) => a + (r.score || 0), 0) / rs.length),
      }))
      .sort((a, b) => b.best.score - a.best.score || b.count - a.count);
  }

  /** Families of keywords TPT reports as searched together with a seed keyword. */
  function families(rows) {
    const byKey = new Map(rows.map((r) => [r.key, r]));
    return rows
      .filter((r) => r.relatedKeys.length)
      .map((seed) => {
        const members = seed.relatedKeys.map((k) => byKey.get(k)).filter(Boolean);
        const scored = members.filter((m) => m.score != null);
        return {
          seed,
          members,
          best: [...scored].sort((a, b) => b.score - a.score)[0] || null,
          avgScore: scored.length ? Math.round(scored.reduce((a, m) => a + m.score, 0) / scored.length) : null,
          peaks: members.reduce((acc, m) => {
            if (m.peakMonth != null) acc[m.peakMonth]++;
            return acc;
          }, new Array(12).fill(0)),
        };
      })
      .sort((a, b) => (b.best?.score ?? -1) - (a.best?.score ?? -1));
  }

  /* ---------- Export and backup ---------- */

  function safeCell(value) {
    let s = String(value ?? '');
    if (/^[\s]*[=+\-@]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  }
  function csv(headers, rows) {
    return '﻿' + [headers, ...rows].map((r) => r.map(safeCell).join(',')).join('\r\n');
  }

  const STATUSES = ['inbox', 'researching', 'building', 'published', 'passed'];
  function validateBackup(obj) {
    if (!obj || obj.schema !== 3 || !Array.isArray(obj.batches) || obj.batches.length > 5000) throw new Error('This is not a supported Niche Radar backup.');
    let count = 0;
    const ids = new Set();
    const batches = obj.batches.map((b) => {
      if (!b || typeof b.id !== 'string' || ids.has(b.id) || !Array.isArray(b.rows) || !b.rows.length || b.rows.length > 100000 || (b.date && !isoDate(b.date)))
        throw new Error('Invalid batch in backup.');
      ids.add(b.id);
      const rows = b.rows.map((r) => {
        if (
          !r ||
          typeof r.keyword !== 'string' ||
          !r.keyword.trim() ||
          r.keyword.length > 300 ||
          typeof r.searches !== 'number' ||
          number(r.searches) === null ||
          typeof r.resourcesText !== 'string' ||
          r.resourcesText.length > 100 ||
          !r.resourcesText.trim() ||
          (r.date && !isoDate(r.date))
        )
          throw new Error('Invalid observation in backup.');
        const row = {
          keyword: r.keyword,
          key: keyOf(r.keyword),
          searches: r.searches,
          resourcesText: r.resourcesText,
          opportunity: labelOf(r.opportunity),
          date: isoDate(r.date),
          period: String(r.period || '').slice(0, 120),
        };
        if (monthOf(r.peak) !== null && typeof r.peak === 'number') row.peak = r.peak;
        if (typeof r.avg === 'number' && number(r.avg) !== null) row.avg = r.avg;
        return row;
      });
      count += rows.length;
      if (count > 500000) throw new Error('Backup exceeds 500,000 rows. Split the archive first.');
      const batch = {
        id: b.id.slice(0, 160),
        name: String(b.name || 'Restored import').slice(0, 250),
        date: isoDate(b.date),
        period: String(b.period || '').slice(0, 120),
        importedAt: typeof b.importedAt === 'string' && Number.isFinite(Date.parse(b.importedAt)) ? b.importedAt : new Date().toISOString(),
        rows,
        duplicateRows: Number(b.duplicateRows) || 0,
        invalidRows: Number(b.invalidRows) || 0,
      };
      if (['csv', 'capture', 'search'].includes(b.kind)) batch.kind = b.kind;
      if (typeof b.seed === 'string' && b.seed.trim()) batch.seed = b.seed.trim().slice(0, 300);
      return batch;
    });
    const meta = {};
    for (const [k, m] of Object.entries(obj.meta || {})) {
      if (!k.startsWith('kw:') || !m || typeof m !== 'object') continue;
      meta[k] = {
        intent: ['auto', 'general', 'brand', 'free'].includes(m.intent) ? m.intent : 'auto',
        starred: !!m.starred,
        status: STATUSES.includes(m.status) ? m.status : 'inbox',
        notes: String(m.notes || '').slice(0, 20000),
        tags: String(m.tags || '').slice(0, 500),
        updatedAt: String(m.updatedAt || ''),
      };
    }
    const insights = {};
    for (const [k, list] of Object.entries(obj.insights || {})) {
      if (!k.startsWith('kw:') || !Array.isArray(list)) continue;
      const tmp = { insights: {} };
      for (const raw of list.slice(0, 36)) addInsight(tmp, raw);
      if (Object.hasOwn(tmp.insights, k)) insights[k] = tmp.insights[k];
    }
    const lead = Number(obj.settings?.leadWeeks);
    const settings = { preset: Object.hasOwn(presets, obj.settings?.preset) ? obj.settings.preset : 'balanced' };
    if (Number.isInteger(lead) && lead >= 1 && lead <= 16) settings.leadWeeks = lead;
    return { schema: 3, batches, meta, settings, migrated: !!obj.migrated, insights };
  }

  const api = {
    normalize,
    keyOf,
    labelOf,
    number,
    resources,
    isoDate,
    parseDelimited,
    guessMapping,
    convertRows,
    rowSignature,
    batchSignature,
    emptyState,
    mergeBatches,
    score,
    aggregate,
    tier,
    clusters,
    families,
    csv,
    validateBackup,
    presets,
    intentOf,
    brandHints,
    MONTHS,
    MONTHS_SHORT,
    monthOf,
    windowDays,
    monthlyAverage,
    inferPeak,
    monthsUntil,
    timingOf,
    publishBy,
    cleanInsight,
    addInsight,
    monthlyProfile,
    STATUSES,
    OPTIONAL_FIELDS,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Radar = api;
})(globalThis);
