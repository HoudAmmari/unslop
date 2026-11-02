/* Background worker. Saves what the TPT companion reads into the workspace, so an open dashboard
   updates live, and answers lookups for the on-page panel. */
importScripts('core.js', 'storage.js', 'ingest.js');
const R = globalThis.Radar;

async function lookup(keywords = []) {
  const data = R.aggregate(await RadarStore.read());
  const byKey = new Map(data.rows.map((r) => [r.key, r]));
  return {
    ok: true,
    total: data.rows.length,
    items: keywords.slice(0, 200).map((k) => {
      const r = byKey.get(R.keyOf(k));
      return r
        ? { keyword: k, known: true, score: r.score, tier: R.tier(r.score), starred: !!r.meta.starred, status: r.meta.status || 'inbox', peak: r.peakMonth, timing: r.timing.label }
        : { keyword: k, known: false };
    }),
  };
}

const answer = (promise, respond) =>
  promise.then(respond).catch((e) => respond({ ok: false, error: e.message }));

chrome.runtime.onMessage.addListener((request, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return;
  if (request.action === 'openDashboard') {
    const hash = request.keyword ? '#keyword=' + encodeURIComponent(request.keyword) : '';
    answer((hash ? chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html' + hash) }) : chrome.runtime.openOptionsPage()).then(() => ({ ok: true })), respond);
    return true;
  }
  if (request.action === 'radarDrain') {
    answer(RadarIngest.drain().then((results) => ({ ok: true, results })), respond);
    return true;
  }
  if (request.action === 'radarIngest') {
    answer(RadarIngest.ingest(request.payload), respond);
    return true;
  }
  if (request.action === 'radarLookup') {
    answer(lookup(request.keywords), respond);
    return true;
  }
});

// Anything queued while the worker was asleep or being updated is saved as soon as it starts.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && Object.keys(changes).some((k) => k.startsWith('radarQueue:') && changes[k].newValue)) RadarIngest.drain().catch(() => {});
});
RadarIngest.drain().catch(() => {});
