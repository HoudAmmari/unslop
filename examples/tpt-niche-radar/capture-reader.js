/* Reads semantic analytics tables only and refuses positional guesses.
   Columns are found by their header text: Keywords, Searches, Resources, and optionally
   Peak Season and Opportunity. */
(function (root) {
  'use strict';
  const text = (el) =>
    (el?.innerText ?? el?.textContent ?? '')
      .replace(/ /g, ' ')
      .trim()
      .replace(/\s+/g, ' ');
  const norm = (s) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, '')
      .trim();

  function mapHeaders(cells) {
    const names = cells.map((c) => norm(text(c)));
    return {
      keyword: names.findIndex((s) => /^(keyword|keywords|search term|search terms)(\s|$)/.test(s)),
      searches: names.findIndex((s) => /^(searches|search volume|search count|total searches)(\s|$)/.test(s)),
      resources: names.findIndex((s) => /^(resources|resource count|resources available|results)(\s|$)/.test(s)),
      opportunity: names.findIndex((s) => /^(opportunity|tpt opportunity)(\s|$)/.test(s)),
      peak: names.findIndex((s) => /^(peak season|peak month|peak|season)(\s|$)/.test(s)),
    };
  }

  /* A table that sits under a single keyword view lists the keywords searched together with it. */
  function seedOf(container) {
    const doc = container.ownerDocument || container;
    const view = container.closest?.('[class*="SingleKeywordSiteAnalyticsView"]:not([class*="__"])');
    const region = (view || doc).querySelector?.('[data-testid="site-search-keyword-insights-graph"], [role="region"][aria-label*="keyword insights" i]');
    if (!region) return '';
    const m = (region.getAttribute('aria-label') || '').match(/keyword insights(?: graph)? for\s+(.+)$/i);
    if (m) return m[1].trim();
    const title = (view || doc).querySelector('[class*="graphTitleKeyword"]');
    return title ? text(title).replace(/^['"‘“\s]+|['"’”\s]+$/g, '') : '';
  }

  function read(doc = document) {
    let candidates = [...doc.querySelectorAll('table,[role="table"],[role="grid"]')],
      best = null;
    if (!candidates.length && doc.querySelector('[role="row"]')) candidates = [doc];
    for (const container of candidates) {
      if (container !== doc && !container.getClientRects().length) continue;
      const rows = [...container.querySelectorAll('tr,[role="row"]')].filter((el) => !el.closest('[hidden],[aria-hidden="true"]'));
      let header = null,
        mapping = null;
      for (const row of rows.slice(0, 8)) {
        const cells = [...row.querySelectorAll('th,td,[role="columnheader"],[role="cell"]')];
        const m = mapHeaders(cells);
        if (m.keyword >= 0 && m.searches >= 0 && m.resources >= 0) {
          header = row;
          mapping = m;
          break;
        }
      }
      if (!header) continue;
      const records = [];
      let invalid = 0;
      for (const row of rows) {
        if (row === header) continue;
        const cells = [...row.querySelectorAll('td,th[scope="row"],[role="cell"],[role="rowheader"],[role="gridcell"]')];
        if (cells.length <= Math.max(mapping.keyword, mapping.searches, mapping.resources)) continue;
        const keyword = text(cells[mapping.keyword]),
          searchesText = text(cells[mapping.searches]),
          resourcesText = text(cells[mapping.resources]),
          opportunityText = mapping.opportunity >= 0 ? text(cells[mapping.opportunity]) : 'Unknown',
          peakText = mapping.peak >= 0 ? text(cells[mapping.peak]) || cells[mapping.peak].querySelector('img[alt]')?.alt || '' : '';
        if (!keyword || !/^[\d,\s.]+[kmb]?$/i.test(searchesText) || !resourcesText) {
          invalid++;
          continue;
        }
        records.push({ keyword, searchesText, resourcesText, opportunityText, peakText });
      }
      if (!best || records.length > best.rows.length) best = { rows: records, container, invalid, hasPeak: mapping.peak >= 0 };
    }
    if (!best)
      throw new Error('No recognizable analytics table. Open a TPT table with Keyword, Searches, and Resources headers, or export a CSV and import it.');
    if (!best.rows.length) throw new Error('The analytics headers were found, but there are no readable data rows. Wait for loading to finish and try again.');
    best.seed = seedOf(best.container);
    const pageText = text(best.container.closest('[role="tabpanel"]') || doc.body || best.container);
    best.period = /last 365 days/i.test(pageText) || best.seed ? 'Last 365 days' : '';
    const showing = pageText.match(/showing\s+([\d,]+)\s*[-–]\s*([\d,]+)\s+of\s+([\d,]+)\s+results/i);
    if (showing) best.position = { from: Number(showing[1].replace(/,/g, '')), to: Number(showing[2].replace(/,/g, '')), total: Number(showing[3].replace(/,/g, '')) };
    return best;
  }

  function signature(rows) {
    return JSON.stringify(rows.map((r) => [r.keyword.toLowerCase(), r.searchesText, r.resourcesText, r.opportunityText, r.peakText || '']));
  }

  function next(doc = document) {
    const scopes = [...doc.querySelectorAll('[aria-label*="pagination" i],nav,[data-testid*="pagination" i]')];
    const nodes = [
      ...new Set([
        ...scopes.flatMap((s) => [...s.querySelectorAll('button,a,[role="button"]')]),
        ...doc.querySelectorAll('button[aria-label*="next" i],a[aria-label*="next" i],button[title*="next page" i]'),
      ]),
    ];
    return (
      nodes.find((el) => {
        const label = (el.getAttribute('aria-label') || el.getAttribute('title') || text(el)).trim();
        return (
          /^(go to )?next( page)?$|^next page\b|^›$|^»$|^>$/i.test(label) &&
          !el.disabled &&
          el.getAttribute('aria-disabled') !== 'true' &&
          !/disabled/i.test(typeof el.className === 'string' ? el.className : el.getAttribute('class') || '') &&
          !el.closest('[hidden],[aria-hidden="true"]') &&
          el.getClientRects().length > 0
        );
      }) || null
    );
  }

  /* The link back to page 1, used to leave the table where the user had it. */
  function first(doc = document) {
    return (
      [...doc.querySelectorAll('[aria-label*="pagination" i] a,[aria-label*="pagination" i] button')].find((el) =>
        /^(go to )?page 1$/i.test((el.getAttribute('aria-label') || '').trim()),
      ) || null
    );
  }

  const api = { read, signature, next, first };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RadarCaptureReader = api;
})(globalThis);
