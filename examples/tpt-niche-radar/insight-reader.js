/* Reads the single keyword view of TPT's Site Search Analytics: average searches per month,
   total searches and window, resources, opportunity, peak month, seasonal share and the weekly
   curve. The weekly values are recovered from the chart geometry, calibrated against the
   chart's own axis labels, so they match the numbers TPT shows in its tooltips.
   It reads text and SVG only and never clicks anything, so it never spends a search. */
(function (root) {
  'use strict';
  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const text = (el) =>
    (el?.innerText ?? el?.textContent ?? '')
      .replace(/ /g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  const num = (s) => {
    const m = String(s ?? '')
      .replace(/[,\s]/g, '')
      .match(/^(\d+(?:\.\d+)?)([kmb])?$/i);
    return m ? Number(m[1]) * ({ k: 1e3, m: 1e6, b: 1e9 }[m[2]?.toLowerCase()] || 1) : null;
  };
  const monthIndex = (s) => MONTHS.indexOf(String(s || '').slice(0, 3).toLowerCase());
  const attr = (el, name) => Number.parseFloat(el?.getAttribute?.(name));
  const iso = (t) => new Date(t).toISOString().slice(0, 10);
  const localToday = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  function findRegion(doc) {
    return (
      doc.querySelector('[data-testid="site-search-keyword-insights-graph"]') ||
      [...doc.querySelectorAll('[role="region"][aria-label]')].find((el) => /keyword insights/i.test(el.getAttribute('aria-label'))) ||
      doc.querySelector('[class*="KeywordInsightsGraph"]')
    );
  }

  function scopeOf(region) {
    return (
      region.closest('[class*="SingleKeywordSiteAnalyticsView"]:not([class*="__"])') ||
      region.closest('[role="tabpanel"]') ||
      region.ownerDocument.body
    );
  }

  function keywordOf(region, scope) {
    const label = region.getAttribute('aria-label') || '';
    let m = label.match(/keyword insights(?: graph)? for\s+(.+)$/i);
    if (m && m[1].trim()) return m[1].trim();
    const title = scope.querySelector('[class*="graphTitleKeyword"]');
    if (title) {
      const t = text(title).replace(/^['"‘“\s]+|['"’”\s]+$/g, '');
      if (t) return t;
    }
    m = text(scope).match(/keyword insights for\s*['"‘“]?\s*([^'"’”]+?)\s*['"’”]/i);
    if (m) return m[1].trim();
    const input = scope.querySelector('input[aria-label*="search" i], input[type="text"]');
    return input?.value?.trim() || '';
  }

  /* Maps a y coordinate in the chart to a value, using the vertical axis labels.
     Chartist draws each vertical label in a box that ends on its grid line. */
  function yScale(svg) {
    const ticks = [...svg.querySelectorAll('.ct-label.ct-vertical')]
      .map((label) => {
        const box = label.closest('foreignObject');
        const value = num(text(label));
        const y = attr(box, 'y') + attr(box, 'height');
        return value != null && Number.isFinite(y) ? { value, y } : null;
      })
      .filter(Boolean);
    let pairs = ticks;
    if (pairs.length < 2) {
      const values = [...svg.querySelectorAll('.ct-label.ct-vertical')].map((l) => num(text(l))).filter((v) => v != null).sort((a, b) => a - b);
      const ys = [...svg.querySelectorAll('line.ct-grid.ct-vertical')].map((l) => attr(l, 'y1')).filter(Number.isFinite).sort((a, b) => b - a);
      if (values.length >= 2 && ys.length >= values.length) pairs = values.map((value, i) => ({ value, y: ys[i] }));
    }
    if (pairs.length < 2) return null;
    pairs.sort((a, b) => a.value - b.value);
    const lo = pairs[0],
      hi = pairs[pairs.length - 1];
    if (hi.value === lo.value || hi.y === lo.y) return null;
    const slope = (hi.value - lo.value) / (hi.y - lo.y);
    // Every tick has to sit on the same line, otherwise the axis is not linear and we refuse to guess.
    const fits = pairs.every((p) => Math.abs(lo.value + (p.y - lo.y) * slope - p.value) <= Math.max(1, (hi.value - lo.value) * 0.01));
    return fits ? (y) => lo.value + (y - lo.y) * slope : null;
  }

  function points(svg) {
    const series = svg.querySelector('.ct-series') || svg;
    let pts = [...series.querySelectorAll('circle')]
      .map((c) => [attr(c, 'cx'), attr(c, 'cy')])
      .concat([...series.querySelectorAll('line.ct-point')].map((l) => [attr(l, 'x1'), attr(l, 'y1')]))
      .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
    if (pts.length < 4) {
      // Fallback: the end point of every segment of the line path.
      const d = series.querySelector('path.ct-line')?.getAttribute('d') || '';
      pts = [];
      for (const seg of d.match(/[MLC][^MLC]*/g) || []) {
        const nums = seg.slice(1).split(/[\s,]+/).filter(Boolean).map(Number);
        if (nums.length >= 2) pts.push([nums[nums.length - 2], nums[nums.length - 1]]);
      }
    }
    return pts.sort((a, b) => a[0] - b[0]);
  }

  /* Dates for each point. Labels like "Nov 2" or "Jan 4" sit on every few points one week apart.
     The year comes from the range label, like "Nov 2025-2026", or from today. */
  function dates(svg, pts, range, today) {
    if (!pts.length) return null;
    const step = pts.length > 1 ? (pts[pts.length - 1][0] - pts[0][0]) / (pts.length - 1) : 1;
    const labels = [...svg.querySelectorAll('.ct-label.ct-horizontal')]
      .map((label) => {
        const box = label.closest('foreignObject');
        const m = text(label).match(/^([A-Za-z]{3,})\.?\s+(\d{1,2})$/);
        const x = attr(box, 'x');
        if (!m || !Number.isFinite(x) || monthIndex(m[1]) < 0) return null;
        const index = pts.findIndex((p) => Math.abs(p[0] - x) <= step / 2);
        return index >= 0 ? { month: monthIndex(m[1]), day: Number(m[2]), index } : null;
      })
      .filter(Boolean);
    if (!labels.length) return null;
    const first = labels[0];
    const todayT = Date.parse(today + 'T12:00:00Z');
    const fromRange = range.match(/([A-Za-z]{3,})\s+(\d{4})/);
    const candidates = [];
    if (fromRange && monthIndex(fromRange[1]) >= 0) candidates.push(Number(fromRange[2]) + (first.month < monthIndex(fromRange[1]) ? 1 : 0));
    const y = new Date(todayT).getUTCFullYear();
    candidates.push(y, y - 1, y - 2);
    for (const year of candidates) {
      const start = Date.UTC(year, first.month, first.day, 12) - first.index * 7 * 86400000;
      const at = (i) => start + i * 7 * 86400000;
      const consistent = labels.every((l) => {
        const d = new Date(at(l.index));
        return d.getUTCMonth() === l.month && d.getUTCDate() === l.day;
      });
      const last = at(pts.length - 1);
      if (consistent && last <= todayT + 8 * 86400000 && last >= todayT - 120 * 86400000) return pts.map((_, i) => iso(at(i)));
    }
    return null;
  }

  function weekly(region, range, today) {
    const svg = region.querySelector('svg.ct-chart-line') || region.querySelector('svg');
    if (!svg) return { weekly: [], reason: 'No chart' };
    const scale = yScale(svg);
    if (!scale) return { weekly: [], reason: 'Chart axis could not be read' };
    const pts = points(svg);
    const ds = dates(svg, pts, range, today);
    if (!ds) return { weekly: [], reason: 'Chart dates could not be read' };
    return { weekly: pts.map(([, y], i) => [ds[i], Math.max(0, Math.round(scale(y)))]) };
  }

  function read(doc = document, opts = {}) {
    const region = findRegion(doc);
    if (!region) return null;
    const scope = scopeOf(region);
    const keyword = keywordOf(region, scope);
    const all = text(scope);
    const head = text(region);
    const avgEl = region.querySelector('[class*="averagePerMonth"]');
    let avg = avgEl ? num(text(avgEl)) : null;
    if (avg == null) avg = num((head.match(/([\d,.]+\s*[KMB]?)\s*avg\.?\s*searches\s*\/\s*month/i) || [])[1]);
    const totalMatch = head.match(/([\d,]+)\s*total searches\s*\/\s*last\s+(\d+)\s*days\s*(?:\(([^)]+)\))?/i);
    const resEl = region.querySelector('[class*="resourcesValue"]');
    const resourcesText = resEl
      ? text(resEl)
      : ((head.match(/((?:[<>≤≥]\s*)?[\d.,]+\s*[KMB]?(?:\s*[-–]\s*[\d.,]+\s*[KMB]?)?\+?)\s*Resources/i) || [])[1] || '').trim();
    const opportunity = (head.match(/\b(Strong|Promising|Moderate|Challenging|Very Difficult)\s+Opportunity/i) || [])[1] || '';
    const legendPeak = (head.match(/peak month\s*\(\s*([A-Za-z]+)\s*\)/i) || [])[1] || '';
    const banner = all.match(/(\d+(?:\.\d+)?)\s*%\s*of annual search volume occurs in\s*([A-Za-z]+)\s*\(\s*([\d,]+)\s*searches?\s*\)/i);
    const range = totalMatch?.[3]?.trim() || '';
    const today = opts.today || localToday();
    const curve = weekly(region, range, today);
    const insight = {
      keyword,
      date: today,
      avg,
      total: totalMatch ? num(totalMatch[1]) : null,
      windowDays: totalMatch ? Number(totalMatch[2]) : null,
      range,
      resourcesText,
      opportunity,
      peak: banner?.[2] || legendPeak,
      peakShare: banner ? Number(banner[1]) / 100 : null,
      peakSearches: banner ? num(banner[3]) : null,
      weekly: curve.weekly,
      curveNote: curve.reason || '',
      searchesLeft: num((all.match(/(\d+)\s+searches? left/i) || [])[1]),
      capturedAt: new Date().toISOString(),
    };
    insight.ready = !!(keyword && (insight.avg != null || insight.total != null));
    return insight;
  }

  function signature(insight) {
    if (!insight) return '';
    return JSON.stringify([insight.keyword.toLowerCase(), insight.avg, insight.total, insight.resourcesText, insight.peak, insight.weekly.length, insight.weekly.reduce((a, w) => a + w[1], 0)]);
  }

  const api = { read, signature };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RadarInsightReader = api;
})(globalThis);
