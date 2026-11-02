/* v4 regression tests: new season metrics, TPT lookups and compatibility with v3 workspaces.
   Run with: node --test tests/ */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const R = require('../core.js');

const row = (keyword = 'murder mystery', searches = 1000, resourcesText = '1K-3K', opportunity = 'Strong', extra = {}) => ({
  keyword,
  key: R.keyOf(keyword),
  searches,
  resourcesText,
  opportunity,
  date: '',
  period: '',
  ...extra,
});
const batch = (id, rows, date = '', period = '', importedAt = '2026-10-08T10:00:00Z', extra = {}) => ({ id, name: id, rows, date, period, importedAt, ...extra });
const stateWith = (...bs) => {
  const s = R.emptyState();
  R.mergeBatches(s, bs);
  return s;
};
const NOV = new Date('2026-11-02T12:00:00');
const weekly = (peakMonth, total = 52000) => {
  const out = [];
  let t = Date.UTC(2025, 10, 2, 12);
  for (let i = 0; i < 53; i++) {
    const d = new Date(t + i * 7 * 86400000);
    out.push([d.toISOString().slice(0, 10), d.getUTCMonth() === peakMonth ? total / 8 : total / 200]);
  }
  return out;
};

test('v3 rows keep exactly the v3 signature, so old CSVs are still recognized as repeats', () => {
  assert.equal(R.rowSignature(row('a', 100, '1K-3K', 'Strong')), JSON.stringify(['kw:a', 100, [1000, 3000], 'Strong', '', '']));
  const s = stateWith(batch('1', [row('a'), row('b')]));
  assert.deepEqual(R.mergeBatches(s, [batch('2', [row('b'), row('a')])]), { added: 0, skipped: 1 });
});

test('v3 scores are unchanged in every v3 lens', () => {
  const expected = { balanced: [67, 50, 64], lowCompetition: [67, 36, 68], demand: [67, 66, 59] };
  for (const [p, [a, b, c]] of Object.entries(expected)) {
    assert.equal(R.score(row()).score, a);
    assert.equal(R.score(row('x', 43508, '300K-500K', 'Promising'), p).score, b);
    assert.equal(R.score(row('y', 248, '< 1K', 'Promising'), p).score, c);
  }
});

test('a v3 workspace without insights opens and ranks like before', { skip: !fs.existsSync(path.join(__dirname, '../samples')) }, () => {
  const dir = path.join(__dirname, '../samples');
  const bs = fs.readdirSync(dir).filter((f) => f.endsWith('.csv')).sort().map((f, i) => batch('b' + i, R.convertRows(R.parseDelimited(fs.readFileSync(path.join(dir, f), 'utf8'))).rows, '', '', `2026-10-0${i + 1}T00:00:00Z`));
  const s = { schema: 3, batches: [], meta: {}, settings: { preset: 'balanced' }, migrated: true };
  R.mergeBatches(s, bs);
  const d = R.aggregate(s);
  assert.equal(d.rows.length, 145);
  assert.equal(d.rows.reduce((a, r) => a + (r.score || 0), 0), 6663);
});

test('month names, abbreviations and numbers', () => {
  assert.equal(R.monthOf('January'), 0);
  assert.equal(R.monthOf('jan.'), 0);
  assert.equal(R.monthOf('Sept'), 8);
  assert.equal(R.monthOf('Peak month (Dec)'), 11);
  assert.equal(R.monthOf('12'), 11);
  assert.equal(R.monthOf(3), 3);
  for (const bad of ['', 'Spring', '13', null, 12, 'May be']) assert.equal(R.monthOf(bad), bad === 'May be' ? 4 : null);
});

test('search windows in days', () => {
  assert.equal(R.windowDays('Last 365 days'), 365);
  assert.equal(R.windowDays('last 30 days'), 30);
  assert.equal(R.windowDays('Last 12 months'), 365);
  assert.equal(R.windowDays('past year'), 365);
  assert.equal(R.windowDays('September 2026'), 30);
  assert.equal(R.windowDays('2 weeks'), 14);
  assert.equal(R.windowDays(''), null);
  assert.equal(R.windowDays('since launch'), null);
});

test('average searches a month: reported first, then derived from a known window, never guessed', () => {
  assert.deepEqual(R.monthlyAverage({ searches: 95516, avg: 7960, period: '' }), { value: 7960, source: 'reported' });
  assert.equal(R.monthlyAverage({ searches: 95516, period: 'Last 365 days' }).value, 95516 / 12);
  assert.ok(Math.abs(R.monthlyAverage({ searches: 300, period: 'Last 30 days' }).value - 304.375) < 0.01);
  assert.deepEqual(R.monthlyAverage({ searches: 300, period: '' }), { value: null, source: null });
});

test('seasonal wording hints', () => {
  assert.equal(R.inferPeak('halloween math'), 9);
  assert.equal(R.inferPeak('Christmas activities'), 11);
  assert.equal(R.inferPeak('back to school night'), 7);
  assert.equal(R.inferPeak('lunar new year'), 0);
  assert.equal(R.inferPeak("st. patrick's day"), 2);
  assert.equal(R.inferPeak('morphology'), null);
});

test('timing and publish date from the peak month', () => {
  assert.equal(R.monthsUntil(0, NOV), 2);
  assert.equal(R.monthsUntil(10, NOV), 0);
  assert.equal(R.monthsUntil(9, NOV), 11);
  assert.equal(R.timingOf(2).key, 'build');
  assert.equal(R.timingOf(0).key, 'now');
  assert.equal(R.timingOf(4).key, 'plan');
  assert.equal(R.timingOf(8).key, 'later');
  assert.equal(R.timingOf(2, 0.1).key, 'evergreen');
  assert.equal(R.timingOf(null).key, 'unknown');
  assert.equal(R.publishBy(0, NOV, 6), '2026-11-20');
  assert.equal(R.publishBy(7, NOV, 6), '2027-06-20');
});

test('CSV with Peak Season and average columns', () => {
  const p = R.parseDelimited('Keywords,Searches,Resources,Peak Season,Avg. Searches/Month,Opportunity\nnew year,"95,516",150K-300K,January,"7,960",Challenging\nwriting,"24,460",> 500K,Not a month,,Promising');
  const r = R.convertRows(p);
  assert.equal(r.errors.length, 0);
  assert.equal(r.rows[0].peak, 0);
  assert.equal(r.rows[0].avg, 7960);
  assert.equal(r.rows[0].opportunity, 'Challenging');
  assert.equal(r.rows[1].peak, undefined);
  assert.equal(r.rows[1].avg, undefined);
});

test('opportunity pill text from the TPT view', () => assert.equal(R.labelOf('Challenging Opportunity'), 'Challenging'));

test('insights are cleaned, one per keyword and date, newest first', () => {
  const s = R.emptyState();
  assert.equal(R.addInsight(s, { keyword: 'x' }), null);
  assert.equal(R.addInsight(s, { keyword: 'new year', date: '2026-02-30' }), null);
  R.addInsight(s, { keyword: 'new year', date: '2026-10-01', avg: 7000, weekly: [['2025-10-05', 5], ['bad', 1], ['2025-10-12', -3]] });
  R.addInsight(s, { keyword: 'New  Year', date: '2026-11-02', avg: 7960, peak: 'January', peakShare: 0.7, weekly: weekly(0) });
  R.addInsight(s, { keyword: 'new year', date: '2026-11-02', avg: 7961, peak: 'Jan' });
  const list = s.insights[R.keyOf('new year')];
  assert.equal(list.length, 2);
  assert.equal(list[0].date, '2026-11-02');
  assert.equal(list[0].avg, 7961);
  assert.equal(list[1].weekly.length, 1);
  assert.equal(list[0].peak, 0);
});

test('monthly profile from a weekly curve finds the peak and its share', () => {
  const prof = R.monthlyProfile(weekly(0));
  assert.equal(prof.peak, 0);
  assert.ok(prof.share > 0.5 && prof.share < 0.9);
  assert.equal(R.monthlyProfile([]), null);
});

test('aggregate: TPT peak beats wording, curve fills in, families from lookups', () => {
  const s = stateWith(
    batch('csv', [row('christmas math', 900, '1K-3K', 'Strong'), row('halloween', 500, '1K-3K')]),
    batch('tpt:2026-11-02:kw:new year', [row('new year', 95516, '150K-300K', 'Challenging', { peak: 0, avg: 7960 }), row('christmas math', 900, '1K-3K', 'Strong', { peak: 10 })], '2026-11-02', 'Last 365 days', '2026-11-02T10:00:00Z', { kind: 'search', seed: 'new year' }),
  );
  R.addInsight(s, { keyword: 'new year', date: '2026-11-02', avg: 7960, total: 95516, peak: 'January', peakShare: 0.7, weekly: weekly(0) });
  const d = R.aggregate(s, { now: NOV });
  const by = Object.fromEntries(d.rows.map((r) => [r.keyword, r]));
  assert.equal(by['christmas math'].peakMonth, 10);
  assert.equal(by['christmas math'].peakSource, 'tpt');
  assert.equal(by.halloween.peakMonth, 9);
  assert.equal(by.halloween.peakSource, 'wording');
  assert.equal(by['new year'].avgMonthly, 7960);
  assert.equal(by['new year'].seasonShare, 0.7);
  assert.equal(by['new year'].timing.key, 'build');
  assert.equal(by['new year'].publishBy, '2026-11-20');
  assert.deepEqual(by['christmas math'].seeds, ['new year']);
  assert.deepEqual(by['new year'].relatedKeys, [R.keyOf('christmas math')]);
  assert.equal(R.families(d.rows).length, 1);
  assert.equal(R.families(d.rows)[0].members.length, 1);
});

test('related rows from a 365 day lookup get a monthly average of a twelfth', () => {
  const s = stateWith(batch('t', [row('winter', 123669, '> 500K', 'Challenging', { peak: 11 })], '2026-11-02', 'Last 365 days'));
  const r = R.aggregate(s, { now: NOV }).rows[0];
  assert.equal(r.avgMonthly, 123669 / 12);
  assert.equal(r.avgSource, 'window');
});

test('the timing lens rewards a peak one to three months out and stays in 0 to 100', () => {
  const soon = R.score(row('a', 1000, '1K-3K'), 'timing', { now: NOV, peak: 0 }).score;
  const far = R.score(row('a', 1000, '1K-3K'), 'timing', { now: NOV, peak: 6 }).score;
  const unknown = R.score(row('a', 1000, '1K-3K'), 'timing', { now: NOV, peak: null }).score;
  assert.ok(soon > unknown && unknown > far);
  for (const s of [0, 1e12]) for (const res of ['0', '>500K']) for (let m = 0; m < 12; m++) {
    const n = R.score(row('a', s, res), 'timing', { now: NOV, peak: m }).score;
    assert.ok(n >= 0 && n <= 100);
  }
  assert.equal(R.score(row(), 'balanced', { now: NOV, peak: 0 }).score, R.score(row(), 'balanced', { now: NOV, peak: 6 }).score);
});

test('backups keep v4 fields and still validate v3 backups', () => {
  const s = stateWith(batch('a', [row('new year', 95516, '150K-300K', 'Challenging', { peak: 0, avg: 7960 })], '2026-11-02', 'Last 365 days', '2026-11-02T10:00:00Z', { kind: 'search', seed: 'new year' }));
  s.settings.leadWeeks = 8;
  R.addInsight(s, { keyword: 'new year', date: '2026-11-02', avg: 7960, weekly: weekly(0) });
  const back = R.validateBackup(JSON.parse(JSON.stringify(s)));
  assert.equal(back.batches[0].rows[0].peak, 0);
  assert.equal(back.batches[0].rows[0].avg, 7960);
  assert.equal(back.batches[0].seed, 'new year');
  assert.equal(back.batches[0].kind, 'search');
  assert.equal(back.settings.leadWeeks, 8);
  assert.equal(back.insights[R.keyOf('new year')][0].weekly.length, 53);
  const v3 = { schema: 3, batches: [batch('a', [row()])], meta: {}, settings: { preset: 'demand' }, migrated: true };
  const restored = R.validateBackup(JSON.parse(JSON.stringify(v3)));
  assert.deepEqual(restored.insights, {});
  assert.equal(restored.settings.preset, 'demand');
  const bad = JSON.parse(JSON.stringify(s));
  bad.insights[R.keyOf('new year')] = [{ keyword: 'new year', date: 'nope' }];
  assert.deepEqual(R.validateBackup(bad).insights, {});
});
