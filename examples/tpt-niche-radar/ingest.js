/* Turns what the TPT companion read into workspace rows. Shared by the background worker and the
   dashboard, so a capture is saved even when one of them is not running yet.

   The companion first writes every capture to chrome.storage.local under "radarQueue:<id>", then
   asks for a drain. Ingesting the same capture twice changes nothing: rows are replaced by keyword
   inside one batch per day and keyword, and insights are kept one per keyword and date. */
(function (root) {
  'use strict';
  const R = root.Radar;
  const localDate = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  async function logActivity(entry) {
    const { radarActivity = [] } = await chrome.storage.local.get('radarActivity');
    const list = [entry, ...radarActivity.filter((a) => a.id !== entry.id)].slice(0, 30);
    await chrome.storage.local.set({ radarActivity: list });
  }

  async function ingest(p = {}) {
    const date = R.isoDate(p.date) || localDate();
    const seed = String(p.seed || '')
      .trim()
      .replace(/\s+/g, ' ')
      .slice(0, 300);
    const period = String(p.period || '').slice(0, 120);
    const parsed = {
      headers: ['Keywords', 'Searches', 'Resources', 'Opportunity', 'Peak Season'],
      data: (Array.isArray(p.rows) ? p.rows : [])
        .slice(0, 5000)
        .map((r) => [String(r.keyword ?? ''), String(r.searchesText ?? r.searches ?? ''), String(r.resourcesText ?? ''), String(r.opportunityText ?? ''), String(r.peakText ?? '')]),
    };
    const converted = R.convertRows(parsed);
    const rows = converted.rows.map((r) => ({ ...r, date, period }));
    const insight = p.insight ? R.cleanInsight({ ...p.insight, date }) : null;
    if (insight && insight.total != null && R.resources(insight.resourcesText)) {
      const own = {
        keyword: insight.keyword,
        key: R.keyOf(insight.keyword),
        searches: insight.total,
        resourcesText: insight.resourcesText,
        opportunity: insight.opportunity,
        date,
        period: insight.windowDays ? `Last ${insight.windowDays} days` : period,
      };
      if (insight.peak != null) own.peak = insight.peak;
      if (insight.avg != null) own.avg = insight.avg;
      rows.unshift(own);
    }
    const now = new Date().toISOString();
    const { result } = await root.RadarStore.update((state) => {
      const before = new Set();
      for (const b of state.batches) for (const r of b.rows) before.add(r.key || R.keyOf(r.keyword));
      if (insight) R.addInsight(state, insight);
      if (!rows.length) return { newKeywords: 0, rows: 0, batchRows: 0 };
      const id = 'tpt:' + date + ':' + (seed ? R.keyOf(seed) : 'table');
      let batch = state.batches.find((b) => b.id === id);
      if (!batch) {
        batch = {
          id,
          name: seed ? `TPT search · ${seed}` : 'TPT analytics table',
          date,
          period: seed ? 'Last 365 days' : period,
          importedAt: now,
          rows: [],
          duplicateRows: 0,
          invalidRows: 0,
          kind: seed ? 'search' : 'capture',
        };
        if (seed) batch.seed = seed;
        state.batches.push(batch);
      }
      const index = new Map(batch.rows.map((r, i) => [r.key, i]));
      for (const r of rows) {
        if (index.has(r.key)) batch.rows[index.get(r.key)] = r;
        else {
          index.set(r.key, batch.rows.length);
          batch.rows.push(r);
        }
      }
      batch.importedAt = now;
      batch.invalidRows = Math.max(batch.invalidRows || 0, converted.errors.length);
      return { newKeywords: rows.filter((r) => !before.has(r.key)).length, rows: rows.length, batchRows: batch.rows.length, batchId: id };
    });
    await logActivity({
      id: (seed || 'table') + ':' + date,
      at: now,
      date,
      seed,
      insight: !!insight,
      avg: insight?.avg ?? null,
      peak: insight?.peak ?? null,
      rows: result.batchRows || 0,
      newKeywords: result.newKeywords,
    });
    return { ok: true, ...result };
  }

  /* Saves every queued capture, oldest first, and removes each one once it is stored. */
  let draining = null;
  function drain() {
    if (draining) return draining.then(() => drain());
    draining = (async () => {
      const all = await chrome.storage.local.get(null);
      const queued = Object.entries(all)
        .filter(([k, v]) => k.startsWith('radarQueue:') && v && typeof v === 'object')
        .sort((a, b) => String(a[1].queuedAt || '').localeCompare(String(b[1].queuedAt || '')));
      const results = {};
      for (const [k, payload] of queued) {
        results[k.slice(11)] = await ingest(payload);
        await chrome.storage.local.remove(k);
      }
      return results;
    })().finally(() => {
      draining = null;
    });
    return draining;
  }

  root.RadarIngest = { ingest, drain };
})(globalThis);
