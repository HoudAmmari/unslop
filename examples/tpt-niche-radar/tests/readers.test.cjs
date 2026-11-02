/* Runs the TPT readers in Chromium against a saved Site Search Analytics page.
   Skips when Playwright or the private fixture is not available. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const fixture = path.join(__dirname, 'fixtures/site-search-keyword.html');
let chromium = null;
try {
  ({ chromium } = require('playwright'));
} catch {
  /* optional */
}

test('keyword insight and related keywords from the TPT view', { skip: !chromium || !fs.existsSync(fixture) }, async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1300, height: 900 } });
    await page.setContent(fs.readFileSync(fixture, 'utf8'));
    for (const f of ['core.js', 'capture-reader.js', 'insight-reader.js']) await page.addScriptTag({ path: path.join(__dirname, '..', f) });
    const out = await page.evaluate(() => {
      const ins = RadarInsightReader.read(document, { today: '2026-11-02' });
      const table = RadarCaptureReader.read(document);
      return { ins, table: { rows: table.rows, seed: table.seed, period: table.period, position: table.position }, profile: Radar.monthlyProfile(ins.weekly), next: !!RadarCaptureReader.next(document) };
    });
    const { ins, table } = out;
    assert.equal(ins.keyword, 'new year');
    assert.equal(ins.avg, 7960);
    assert.equal(ins.total, 95516);
    assert.equal(ins.windowDays, 365);
    assert.equal(ins.range, 'Nov 2025-2026');
    assert.equal(ins.resourcesText, '150K-300K');
    assert.equal(ins.opportunity, 'Challenging');
    assert.equal(ins.peak, 'January');
    assert.equal(ins.peakShare, 0.7);
    assert.equal(ins.peakSearches, 66765);
    assert.equal(ins.searchesLeft, 2);
    assert.equal(ins.weekly.length, 53);
    assert.equal(ins.weekly[0][0], '2025-11-02');
    assert.equal(ins.weekly.at(-1)[0], '2026-11-01');
    // The weekly values add up to TPT's own total, and match its tooltip for one week.
    assert.equal(ins.weekly.reduce((a, w) => a + w[1], 0), 95516);
    assert.deepEqual(ins.weekly.find((w) => w[0] === '2026-06-21'), ['2026-06-21', 6]);
    assert.equal(out.profile.peak, 0);
    assert.ok(Math.abs(out.profile.share - 0.7) < 0.02);
    assert.equal(table.rows.length, 10);
    assert.equal(table.seed, 'new year');
    assert.equal(table.period, 'Last 365 days');
    assert.deepEqual(table.position, { from: 1, to: 10, total: 100 });
    assert.deepEqual(table.rows[0], { keyword: 'new year activities 2026', searchesText: '168,688', resourcesText: '20K-40K', opportunityText: 'Promising', peakText: 'January' });
    assert.equal(table.rows[8].peakText, 'August');
    assert.ok(out.next);
  } finally {
    await browser.close();
  }
});
