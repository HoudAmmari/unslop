/* Workspace storage. IndexedDB transactions serialize edits across dashboard tabs and the
   background worker. The database name, version and store are unchanged from v3, so an
   upgrade in the same folder opens the existing research as it is.

   On the first write after the upgrade, the untouched v3 workspace is copied to the
   record "pre-v4" in the same store, so it can always be downloaded again from Settings. */
(function (root) {
  'use strict';
  let dbPromise;
  const db = () =>
    dbPromise ||
    (dbPromise = new Promise((resolve, reject) => {
      const r = indexedDB.open('tpt-niche-radar-v3', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('workspace');
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.onblocked = () => reject(new Error('Close other Niche Radar tabs and reload to update storage.'));
    }));
  const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('niche-radar-updates') : null;

  async function get(key) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const r = d.transaction('workspace').objectStore('workspace').get(key);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  async function read() {
    return (await get('state')) || root.Radar.emptyState();
  }

  async function update(fn) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const tx = d.transaction('workspace', 'readwrite'),
        store = tx.objectStore('workspace'),
        getState = store.get('state'),
        getBackup = store.getKey('pre-v4');
      let state,
        result,
        pending = 2;
      const proceed = () => {
        if (--pending) return;
        try {
          const existing = getState.result;
          if (existing && getBackup.result === undefined && existing.batches?.length && !existing.insights)
            store.put({ savedAt: new Date().toISOString(), state: existing }, 'pre-v4');
          state = existing ? structuredClone(existing) : root.Radar.emptyState();
          if (!state.insights) state.insights = {};
          result = fn(state);
          store.put(state, 'state');
        } catch (e) {
          reject(e);
          tx.abort();
        }
      };
      getState.onsuccess = proceed;
      getBackup.onsuccess = proceed;
      tx.oncomplete = () => {
        channel?.postMessage('changed');
        resolve({ state, result });
      };
      tx.onerror = () => reject(tx.error || new Error('Could not save. Export a backup and check available browser storage.'));
      tx.onabort = () => reject(tx.error || new Error('Save was cancelled.'));
    });
  }

  root.RadarStore = {
    read,
    update,
    preUpgrade: () => get('pre-v4'),
    onChange: (fn) => channel?.addEventListener('message', fn),
  };
})(globalThis);
