// Unit tests for the tennis Worker (workers/sickla-tennis) against saved,
// anonymised copies of the club's booking pages — no network needed.
// Run: node --test tests/*.test.mjs
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (date) => fs.readFileSync(path.join(here, 'fixtures', `commodus-${date}.html`));
const worker = await import('../workers/sickla-tennis/src/index.js');
const { parseDayPage, buildWeek, mondayOf, isoWeekNumber } = worker;

const latin1 = (buffer) => buffer.toString('latin1');

// ---------- Stand-ins for the Workers runtime ----------
let cacheStore;
let fetchCalls;
let failDates;
globalThis.caches = { default: {
  async match(req) { const r = cacheStore.get(req.url); return r ? r.clone() : undefined; },
  async put(req, res) { cacheStore.set(req.url, res); },
}};
// The booking system: 2026-10-09 is "today" (passed hours), 2026-10-15 has
// bookings and a contract, every other day looks like 2026-10-10.
globalThis.fetch = async (url) => {
  const u = new URL(url);
  const date = `${u.searchParams.get('YEAR')}-${u.searchParams.get('MONTH').padStart(2, '0')}-${u.searchParams.get('DAY').padStart(2, '0')}`;
  fetchCalls.push(date);
  if (failDates.includes(date)) return new Response('Internal Server Error', { status: 500 });
  const name = ['2026-10-09', '2026-10-15'].includes(date) ? date : '2026-10-10';
  return new Response(fixture(name), { headers: { 'Content-Type': 'text/html; charset=iso-8859-1' } });
};
function makeCtx() {
  const pending = [];
  return { waitUntil: (p) => pending.push(p), settle: () => Promise.all(pending) };
}
beforeEach(() => { cacheStore = new Map(); fetchCalls = []; failDates = []; });

// Friday 2026-10-09 14:00 Stockholm time
const NOW = new Date('2026-10-09T12:00:00Z');

test('parses courts and 13 hourly slots from a day page', () => {
  const day = parseDayPage(latin1(fixture('2026-10-10')));
  assert.deepEqual(day.courts, ['Bana 1', 'Bana 2']);
  assert.deepEqual(Object.keys(day.slots).sort(), ['08', '09', '10', '11', '12', '13', '14', '15', '16', '17', '18', '19', '20']);
});

test('classifies free, booked, closed and passed slots', () => {
  const today = parseDayPage(latin1(fixture('2026-10-09')));
  assert.deepEqual(today.slots['08'], ['past', 'past']); // "Ej Bokningsbar"
  assert.deepEqual(today.slots['15'], ['free', 'free']); // "Boka"
  assert.deepEqual(today.slots['18'], ['closed', 'closed']); // "Stängt", red

  const saturday = parseDayPage(latin1(fixture('2026-10-10')));
  assert.deepEqual(saturday.slots['14'], ['booked', 'free']); // single booking, yellow

  const thursday = parseDayPage(latin1(fixture('2026-10-15')));
  assert.deepEqual(thursday.slots['08'], ['booked', 'free']); // contract, blue
  assert.deepEqual(thursday.slots['16'], ['booked', 'booked']);
});

test('rejects a page without a schedule', () => {
  assert.throws(() => parseDayPage('<html><body>Underhåll</body></html>'), /no courts/);
});

test('week dates: Monday start and ISO week numbers', () => {
  assert.equal(mondayOf('2026-10-09'), '2026-10-05');
  assert.equal(mondayOf('2026-10-05'), '2026-10-05');
  assert.equal(mondayOf('2026-10-11'), '2026-10-05');
  assert.equal(isoWeekNumber('2026-10-09'), 41);
  assert.equal(isoWeekNumber('2026-01-01'), 1);
  assert.equal(isoWeekNumber('2027-01-01'), 53); // 2026 has 53 ISO weeks
  assert.equal(isoWeekNumber('2027-01-04'), 1);
});

test('current week: passed days are not fetched, the rest are', async () => {
  const ctx = makeCtx();
  const week = await buildWeek(0, ctx, NOW);
  assert.equal(week.week, 41);
  assert.equal(week.weekStart, '2026-10-05');
  assert.equal(week.today, '2026-10-09');
  assert.deepEqual(week.courts, ['Bana 1', 'Bana 2']);
  assert.equal(week.hours.length, 13);
  assert.deepEqual(week.days.map(d => d.date), ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11']);
  assert.deepEqual(week.days.slice(0, 4).map(d => d.past), [true, true, true, true]);
  assert.deepEqual(fetchCalls.sort(), ['2026-10-09', '2026-10-10', '2026-10-11']);
  assert.ok(week.days.every(d => !('courts' in d)), 'courts only at the top level');
});

test('day pages are cached: a second request does not reach the booking system', async () => {
  const ctx = makeCtx();
  await buildWeek(0, ctx, NOW);
  await ctx.settle();
  fetchCalls = [];
  const again = await buildWeek(0, makeCtx(), NOW);
  assert.deepEqual(fetchCalls, []);
  assert.deepEqual(again.days[5].slots['14'], ['booked', 'free']);
});

test('next week: all seven days fetched; a failing day is reported, not fatal', async () => {
  failDates = ['2026-10-14'];
  const week = await buildWeek(1, makeCtx(), NOW);
  assert.equal(week.week, 42);
  assert.equal(fetchCalls.length, 7);
  const wednesday = week.days.find(d => d.date === '2026-10-14');
  assert.match(wednesday.error, /HTTP 500/);
  assert.equal(week.days.filter(d => d.slots).length, 6);
});

test('the answer never contains the names of the people who booked', async () => {
  const week = await buildWeek(1, makeCtx(), NOW);
  const text = JSON.stringify(week);
  assert.doesNotMatch(text, /Anonym|Kontrakt|BOOKUSER/);
});

test('HTTP handler: CORS, week parameter and errors', async () => {
  const ok = await worker.default.fetch(new Request('https://tennis.test/?week=1'), {}, makeCtx());
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('access-control-allow-origin'), '*');
  assert.equal((await ok.json()).days.length, 7);

  const bad = await worker.default.fetch(new Request('https://tennis.test/?week=5'), {}, makeCtx());
  assert.equal(bad.status, 400);

  const preflight = await worker.default.fetch(new Request('https://tennis.test/', { method: 'OPTIONS' }), {}, makeCtx());
  assert.equal(preflight.headers.get('access-control-allow-origin'), '*');
});
