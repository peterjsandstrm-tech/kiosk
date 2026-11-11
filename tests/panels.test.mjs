// Browser test of the Sickla page's panels that existed before 1.5.0: VMA banner,
// SMHI weather warnings, clock, weather and forecast, rain radar, bathing card and
// sample panel, departures (stop picker, filters, deviations, errors, backoff) and
// the version check. Runs in headless Chromium over the DevTools protocol (no npm
// dependencies). Every request the page makes to another host is intercepted with
// the Fetch domain and answered from the mocks below, so no live network is used.
// Run: node --test tests/*.test.mjs   (CHROME=/path/to/chromium to override)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pageDir = path.join(here, '..', 'packages', 'sickla');
const CHROME = process.env.CHROME || 'chromium-browser';
const W = 800, H = 1280; // the Galaxy Tab in portrait, roughly
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const pad = (n) => String(n).padStart(2, '0');
const hhmm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const MIN = 60 * 1000;
const YEAR = new Date().getFullYear();
const SICKLA = [18.1147, 59.3057];

// ---------- Mock data ----------
const square = ([lon, lat], r = 0.5) => [[lon - r, lat - r], [lon + r, lat - r], [lon + r, lat + r], [lon - r, lat + r], [lon - r, lat - r]];
const polygon = (centre, r) => ({ type: 'Polygon', coordinates: [square(centre, r)] });

// SMHI forecast: one entry per hour from the start of the current hour, 48 hours
function forecast(first = {}) {
  const start = new Date(); start.setMinutes(0, 0, 0);
  return {
    timeSeries: Array.from({ length: 48 }, (_, i) => {
      const t = new Date(start.getTime() + i * 60 * MIN);
      // The temperature encodes the entry's day and hour (e.g. 113 = the 1st at 13:00),
      // so the forecast row shows which entry it picked
      const data = { air_temperature: t.getDate() * 100 + t.getHours(), wind_speed: 2, symbol_code: 1 };
      return { time: t.toISOString(), data: i === 0 ? { ...data, air_temperature: 7.6, wind_speed: 3.5, symbol_code: 18, ...first } : data };
    }),
  };
}

// MET Norway nowcast: 25 points 5 minutes apart starting now; rates in mm/h
function nowcast(rates, { temp = 8, coverage = 'ok' } = {}) {
  const now = Date.now();
  return {
    properties: {
      meta: { radar_coverage: coverage },
      timeseries: rates.map((rate, i) => ({
        time: new Date(now + i * 5 * MIN).toISOString(),
        data: { instant: { details: { precipitation_rate: rate, ...(i === 0 ? { air_temperature: temp } : {}) } } },
      })),
    },
  };
}
const dry = () => Array(25).fill(0);

// Havs- och vattenmyndigheten: Sickla strandbad
const sample = (date, assess, extra = {}) => ({
  takenAt: `${date}T10:00:00`, waterTemp: 20, sampleAssessId: assess,
  sampleAssessIdText: { 1: 'Tjänligt', 2: 'Tjänligt med anmärkning', 3: 'Otjänligt' }[assess],
  escherichiaColiPrefix: '<', escherichiaColiCount: 10, escherichiaColiAssessIdText: 'Tjänligt',
  intestinalEnterococciPrefix: '=', intestinalEnterococciCount: 5, intestinalEnterococciAssessIdText: 'Tjänligt',
  algalIdText: 'Ingen blomning', weatherIdText: 'Soligt', sampleComplete: true, ...extra,
});
const bathing = (results, extra = {}) => ({
  results,
  adviceAgainstBathing: [], abnormalSituations: [],
  profile: {
    bathingSeason: { startsAt: `${YEAR}-06-15`, endsAt: `${YEAR}-08-31` },
    bloomRisk: { algae: true, cyano: true },
    lastFourClassifications: [{ year: YEAR - 1, qualityClassIdText: 'Utmärkt kvalitet' }, { year: YEAR - 2, qualityClassIdText: 'Bra kvalitet' }],
  },
  ...extra,
});
const BATHING_DEFAULT = bathing([
  sample(`${YEAR}-08-10`, 1, { waterTemp: 20 }),
  sample(`${YEAR}-07-20`, 2, { waterTemp: 22 }),
  sample(`${YEAR - 1}-08-01`, 1, { waterTemp: 19 }),
]);

// SL departures; expected 10 s into the given minute so the rounding is stable
const dep = (min, line, dest, mode = 'BUS', extra = {}) => ({
  expected: new Date(Date.now() + min * MIN + 10 * 1000).toISOString(),
  destination: dest, line: { id: Number(line) || 0, designation: String(line), transport_mode: mode },
  journey: { state: 'NORMALPROGRESS' }, ...extra,
});
const departuresDefault = () => ({
  departures: [
    dep(12, '401', 'Slussen'),
    dep(3, '30', 'Sickla', 'TRAM'),
    dep(7, '471', 'Slussen', 'BUS', { journey: { state: 'EXPECTED' }, deviations: [{ message: 'Inställd hållplats' }, { header: 'Försenad' }] }),
    dep(0, '401', 'Slussen'),
    dep(-1, '444', 'Danderyds sjukhus', 'BUS', { deviations: 'Omledning' }),
    dep(-5, '30', 'Solna station', 'TRAM'),
    dep(25, '25M', 'Saltsjöbaden', 'TRAIN', { deviations: { header: 'Buss ersätter' } }),
    dep(40, '17', 'Åkeshov', 'METRO'),
    dep(-11, '401', 'Slussen'), // outside the window: more than 10 min ago
    dep(61, '401', 'Slussen'),  // outside the window: more than 60 min ahead
    dep(5, '80', 'Nybroplan', 'SHIP'), // not a shown mode
  ],
});

// ---------- Request routing ----------
// mocks[key] returns { status, body } (body: object or string), { fail: true }
// (network error) or { delay, ... }; it may be a function of the URL.
const ROUTES = [
  ['warnings', u => u.hostname === 'opendata-download-warnings.smhi.se'],
  ['weather', u => u.hostname === 'opendata-download-metfcst.smhi.se'],
  ['vma', u => u.hostname === 'api.krisinformation.se'],
  ['nowcast', u => u.hostname === 'api.met.no'],
  ['bathing', u => u.hostname === 'gw.havochvatten.se'],
  ['sl', u => u.hostname === 'transport.integration.sl.se'],
  ['proxy', u => u.hostname === 'api.allorigins.win'],
  ['tennis', u => u.hostname === 'tennis.petersandstrom.com'],
  ['ski', u => u.hostname === 'api.skidspar.se'],
  ['version', u => u.hostname === 'localhost' && u.pathname === '/version.json'],
];
const ok = (body) => ({ status: 200, body });
const DEFAULT_MOCKS = {
  warnings: () => ok([]),
  weather: () => ok(forecast()),
  vma: () => ok([]),
  nowcast: () => ok(nowcast(dry())),
  bathing: () => ok(BATHING_DEFAULT),
  sl: () => ok(departuresDefault()),
  proxy: () => ({ status: 500, body: 'proxy not expected' }),
  tennis: () => ({ status: 503, body: '{}' }),
  ski: () => ({ status: 404, body: '{}' }),
  version: () => ok(JSON.parse(fs.readFileSync(path.join(pageDir, 'version.json'), 'utf8'))),
};
let mocks = { ...DEFAULT_MOCKS };
const requests = []; // { key, url }
const unmocked = [];
const countRequests = (key) => requests.filter(r => r.key === key).length;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(path.join(pageDir, 'index.html')));
    return;
  }
  res.writeHead(404); res.end();
});

const freePort = () => new Promise((resolve) => {
  const probe = net.createServer().listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

// ---------- Minimal DevTools-protocol client ----------
let chrome, ws, profileDir, pageUrl;
let msgId = 0;
const pending = new Map();
const exceptions = [];
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++msgId;
  pending.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
  ws.send(JSON.stringify({ id, method, params }));
});

async function onRequestPaused({ requestId, request }) {
  const url = new URL(request.url);
  const route = ROUTES.find(([, match]) => match(url));
  if (!route) {
    if (url.hostname === 'localhost' && ['/', '/index.html', '/favicon.ico'].includes(url.pathname)) {
      send('Fetch.continueRequest', { requestId }).catch(() => {});
      return;
    }
    unmocked.push(request.url);
    send('Fetch.fulfillRequest', { requestId, responseCode: 404, responseHeaders: [{ name: 'Access-Control-Allow-Origin', value: '*' }], body: '' }).catch(() => {});
    return;
  }
  const [key] = route;
  requests.push({ key, url: request.url });
  const answer = mocks[key](url);
  if (answer.delay) await sleep(answer.delay);
  if (answer.fail) {
    send('Fetch.failRequest', { requestId, errorReason: 'Failed' }).catch(() => {});
    return;
  }
  const text = typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body);
  send('Fetch.fulfillRequest', {
    requestId,
    responseCode: answer.status,
    responseHeaders: [{ name: 'Content-Type', value: 'application/json' }, { name: 'Access-Control-Allow-Origin', value: '*' }],
    body: Buffer.from(text).toString('base64'),
  }).catch(() => {});
}

const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(`evaluate failed: ${expression}\n${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
  return r.result.value;
};
// Tolerates a page that is navigating (the evaluation context goes away for a moment)
const waitFor = async (expression, ms = 10000) => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    try { if (await evaluate(expression)) return true; } catch { /* page navigating */ }
    await sleep(100);
  }
  return false;
};
const touch = async (points) => {
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: points[0][0], y: points[0][1] }] });
  for (const [x, y] of points.slice(1)) {
    await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] });
    await sleep(16);
  }
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
};
const box = (selector) => evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
const tap = async (selector) => { const b = await box(selector); await touch([[b.x + b.w / 2, b.y + b.h / 2]]); await sleep(150); };
const load = async (url = pageUrl) => {
  await send('Page.navigate', { url });
  assert.ok(await waitFor(`document.readyState === 'complete' && !!document.getElementById('busCard')`), 'page loads');
  await sleep(300);
};
const text = (id) => evaluate(`document.getElementById(${JSON.stringify(id)}).textContent`);
const visible = (id) => evaluate(`document.getElementById(${JSON.stringify(id)}).classList.contains('visible')`);

before(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  pageUrl = `http://localhost:${server.address().port}/`;
  // A fresh profile per run, so no saved stop or filter leaks between runs
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sickla-panels-'));
  const port = await freePort();
  chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`, '--no-first-run', '--no-default-browser-check', `--window-size=${W},${H}`, 'about:blank'], { stdio: 'ignore' });
  let targets = [];
  for (let i = 0; i < 100 && !targets.some(t => t.type === 'page'); i++) {
    try { targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); } catch { /* not up yet */ }
    if (!targets.some(t => t.type === 'page')) await sleep(100);
  }
  ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === 'Fetch.requestPaused') onRequestPaused(m.params);
    if (m.method === 'Runtime.exceptionThrown') exceptions.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  };
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: true });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await load();
});

after(() => {
  ws?.close();
  chrome?.kill();
  server.close();
  setTimeout(() => fs.rmSync(profileDir, { recursive: true, force: true }), 500).unref();
});

// The tests share one page and run in order. Each test sets the mocks it needs
// and calls the panel's load function directly instead of waiting for its timer.

// ---------- Version ----------
test('version: APP_VERSION, version.json, the footer and CHANGELOG agree', async () => {
  const { version } = JSON.parse(fs.readFileSync(path.join(pageDir, 'version.json'), 'utf8'));
  assert.match(version, /^\d+\.\d+\.\d+$/);
  assert.equal(await evaluate('APP_VERSION'), version);
  assert.equal(await text('appVersion'), `v${version}`);
  const changelog = fs.readFileSync(path.join(pageDir, 'CHANGELOG.md'), 'utf8');
  assert.ok(changelog.includes(`## ${version}`) || changelog.includes(`## [${version}]`), `CHANGELOG.md has a section for ${version}`);
});

const checkVersion = async () => { await evaluate('checkForNewVersion()'); await sleep(300); return evaluate('location.search'); };

test('version: no reload when version.json is unchanged, missing, broken or unreachable', async () => {
  assert.equal(await checkVersion(), '');
  mocks.version = () => ({ status: 404, body: '' });
  assert.equal(await checkVersion(), '', 'HTTP 404');
  mocks.version = () => ok('{not json');
  assert.equal(await checkVersion(), '', 'invalid JSON');
  mocks.version = () => ok({});
  assert.equal(await checkVersion(), '', 'no version field');
  mocks.version = () => ({ fail: true });
  assert.equal(await checkVersion(), '', 'network error');
  assert.match(requests.filter(r => r.key === 'version').at(-1).url, /version\.json\?t=\d+$/, 'cache-busting query');
});

test('version: a new version reloads the page once, with ?v=<version>', async () => {
  mocks.version = () => ok({ version: '99.0.0' });
  evaluate('checkForNewVersion()').catch(() => {}); // the context goes away during the reload
  assert.ok(await waitFor(`location.search === '?v=99.0.0' && document.readyState === 'complete'`), 'reloaded with ?v=99.0.0');
  await sleep(300);
  // Still mismatched after the reload (version.json and index.html out of sync): no loop
  assert.equal(await checkVersion(), '?v=99.0.0', 'no second reload to the same version');
  mocks.version = DEFAULT_MOCKS.version;
  await load();
});

// ---------- Clock ----------
test('clock: Swedish date with only the first letter capitalised, and a ticking time', async () => {
  const date = new Date().toLocaleDateString('sv-SE', { weekday: 'long', day: 'numeric', month: 'long' });
  assert.equal(await text('clockDate'), date.charAt(0).toUpperCase() + date.slice(1));
  assert.match(await text('clockDate'), /^[A-ZÅÄÖ][a-zåäö]+ \d{1,2} [a-zåäö]+$/);
  const t1 = await text('clockTime');
  assert.match(t1, /^\d\d:\d\d:\d\d$/);
  await sleep(1100);
  assert.notEqual(await text('clockTime'), t1);
});

// ---------- VMA ----------
const vmaArea = (description, geometry, pole) => ({ Description: description, GeometryInformation: JSON.stringify({ Geometry: geometry, PoleOfInInaccessibility: pole }) });
const vmaItems = () => evaluate(`[...document.querySelectorAll('#vmaBanner .vma-item')].map(el => ({
  label: el.querySelector('.vma-label').textContent,
  headline: el.querySelector('.vma-headline').textContent,
  area: el.querySelector('.vma-area')?.textContent ?? null,
  text: el.querySelector('.vma-text')?.textContent ?? null,
  time: el.querySelector('.vma-time')?.textContent ?? null,
}))`);

test('VMA: no active messages, no banner', async () => {
  assert.equal(await visible('vmaBanner'), false);
  assert.equal(await text('vmaBanner'), '');
});

test('VMA: Sickla first, then the rest of the county newest first; tests and other counties left out', async () => {
  mocks.vma = () => ok([
    { Headline: 'Gasutsläpp i Göteborg', Published: '2026-11-01T09:00:00+01:00', Area: [vmaArea('Göteborgs kommun', polygon([11.97, 57.7], 0.2))] },
    { Headline: 'Test av VMA', IsTest: true, Published: '2026-11-01T09:00:00+01:00', Area: [vmaArea('Nacka kommun', polygon(SICKLA, 0.1))] },
    { Headline: 'Brand i Norrtälje', Published: '2026-11-01T08:00:00+01:00', PushMessage: 'Stäng fönster.', Area: [vmaArea('Norrtälje kommun', null, { type: 'Point', coordinates: [18.70, 59.76] })] },
    { Headline: 'Störning i dricksvattnet', Published: '2026-11-01T08:30:00+01:00', BodyText: 'Koka vattnet.', SenderName: 'Stockholm Vatten', Area: [{ Description: 'Stockholms län' }] },
    { Headline: 'Brand i Sickla', Published: '2026-11-01T07:00:00+01:00', Preamble: '  Gå inomhus.  ', PushMessage: 'ignored', Area: [vmaArea('Nacka kommun', polygon(SICKLA, 0.05)), { Description: 'Värmdö kommun' }] },
  ]);
  await evaluate('loadVma()');
  assert.equal(await visible('vmaBanner'), true);
  const items = await vmaItems();
  assert.deepEqual(items.map(i => i.headline), ['Brand i Sickla', 'Störning i dricksvattnet', 'Brand i Norrtälje']);
  assert.equal(items[0].label, '📢 VMA · Gäller Sickla');
  assert.equal(items[1].label, '📢 VMA · Stockholms län');
  assert.equal(items[0].area, 'Område: Nacka kommun, Värmdö kommun');
  assert.equal(items[0].text, 'Gå inomhus.', 'Preamble first, trimmed');
  assert.equal(items[1].text, 'Koka vattnet.', 'BodyText when there is no Preamble or PushMessage');
  assert.equal(items[2].text, 'Stäng fönster.');
  assert.match(items[0].time, /^Utfärdat 1 november kl\. 07:00 · Krisinformation\.se$/);
  assert.match(items[1].time, / · Stockholm Vatten$/);
});

test('VMA: missing fields get defaults and text is escaped', async () => {
  mocks.vma = () => ok([{ Headline: '<img src=x onerror="window.pwned=1">', Area: [{ Description: 'Stockholms län' }] }, { Area: [{ Description: 'Stockholm' }] }]);
  await evaluate('loadVma()');
  const items = await vmaItems();
  assert.equal(items[0].headline, '<img src=x onerror="window.pwned=1">');
  assert.equal(await evaluate(`document.querySelectorAll('#vmaBanner img').length`), 0);
  assert.equal(items[1].headline, 'Viktigt meddelande till allmänheten');
  assert.equal(items[1].text, null);
  assert.equal(items[1].time, null, 'no Published, no time line');
});

test('VMA: an error or an unexpected answer keeps what is shown', async () => {
  mocks.vma = () => ({ status: 500, body: '{}' });
  await evaluate('loadVma()');
  assert.equal(await visible('vmaBanner'), true);
  assert.equal((await vmaItems()).length, 2);
  mocks.vma = () => ok({ message: 'not a list' });
  await evaluate('loadVma()');
  assert.equal((await vmaItems()).length, 2);
});

test('VMA: an unreadable area outside the county is not shown, and an empty list clears the banner', async () => {
  mocks.vma = () => ok([{ Headline: 'Uppsala', Area: [{ Description: 'Uppsala län', GeometryInformation: '{broken' }] }]);
  await evaluate('loadVma()');
  assert.equal(await visible('vmaBanner'), false);
  mocks.vma = () => ok([]);
  await evaluate('loadVma()');
  assert.equal(await text('vmaBanner'), '');
});

// ---------- SMHI weather warnings ----------
const warning = (event, code, geometry, start, end, extra = {}) => ({
  event: { sv: event },
  warningAreas: [{ warningLevel: { code }, area: { geometry }, approximateStart: start, approximateEnd: end, ...extra }],
});

test('warnings: the banner shows the most severe colour, upcoming ones with their start time', async () => {
  const now = Date.now();
  const start = new Date(now + 2 * 60 * MIN);
  const startText = new Date(now).getDate() === start.getDate() ? `från kl. ${hhmm(start)}` : `från i morgon kl. ${hhmm(start)}`;
  mocks.warnings = () => ok([
    warning('Vind', 'YELLOW', polygon(SICKLA), start.toISOString(), new Date(now + 10 * 60 * MIN).toISOString()),
    warning('Snö', 'ORANGE', polygon(SICKLA), new Date(now - 60 * MIN).toISOString(), new Date(now + 60 * MIN).toISOString(),
      { descriptions: [{ title: { code: 'INCIDENT' }, text: { sv: 'Snöfall, 10–20 cm.' } }] }),
  ]);
  await evaluate('loadWarnings()');
  const banner = await evaluate(`({ cls: document.getElementById('warningBanner').className,
    titles: [...document.querySelectorAll('#warningBanner .w-title')].map(e => e.textContent),
    desc: [...document.querySelectorAll('#warningBanner .w-desc')].map(e => e.textContent),
    icons: [...document.querySelectorAll('#warningBanner .warning-icon')].map(e => e.textContent) })`);
  assert.equal(banner.cls, 'warning-banner visible level-orange');
  assert.deepEqual(banner.titles, ['Snö', `Vind · ${startText}`]);
  assert.deepEqual(banner.desc, ['Snöfall, 10–20 cm.']);
  assert.deepEqual(banner.icons, ['🟠', '⚠️']);
});

// Markup in API text must show as text: no element is created from it
const MARKUP = '<b class="injected">x</b>';
const injected = () => evaluate(`document.querySelectorAll('.injected').length`);

test('warnings: title and description from SMHI are escaped', async () => {
  const now = Date.now();
  mocks.warnings = () => ok([warning(MARKUP, 'YELLOW', polygon(SICKLA), new Date(now - MIN).toISOString(), new Date(now + 60 * MIN).toISOString(),
    { descriptions: [{ title: { code: 'INCIDENT' }, text: { sv: MARKUP } }] })]);
  await evaluate('loadWarnings()');
  assert.equal(await injected(), 0);
  assert.equal(await evaluate(`document.querySelector('#warningBanner .w-title').textContent`), MARKUP);
  assert.equal(await evaluate(`document.querySelector('#warningBanner .w-desc').textContent`), MARKUP);
});

test('warnings: an error or an empty list hides the banner', async () => {
  mocks.warnings = () => ({ status: 500, body: '' });
  await evaluate('loadWarnings()');
  assert.equal(await evaluate(`document.getElementById('warningBanner').className`), 'warning-banner');
  assert.equal(await text('warningBanner'), '');
  mocks.warnings = DEFAULT_MOCKS.warnings;
  await evaluate('loadWarnings()');
  assert.equal(await visible('warningBanner'), false);
});

test('warnings: edge cases of area, time window, level and title', async () => {
  const result = await evaluate(`(() => {
    const now = new Date(2026, 10, 1, 12, 0).getTime();
    const sq = (lon, lat, r) => [[lon - r, lat - r], [lon + r, lat - r], [lon + r, lat + r], [lon - r, lat + r], [lon - r, lat - r]];
    const area = (geometry, extra = {}) => ({ area: { geometry }, warningLevel: { code: 'YELLOW' }, ...extra });
    const w = (title, a) => ({ event: title === null ? undefined : { sv: title }, warningAreas: [a] });
    const iso = (ms) => new Date(ms).toISOString();
    const here = { type: 'Polygon', coordinates: [sq(SICKLA_LON, SICKLA_LAT, 0.5)] };
    const data = [
      w('Hål', area({ type: 'Polygon', coordinates: [sq(SICKLA_LON, SICKLA_LAT, 0.5), sq(SICKLA_LON, SICKLA_LAT, 0.1)] })),
      w('Multi', area({ type: 'MultiPolygon', coordinates: [[sq(13, 55.6, 0.5)], [sq(SICKLA_LON, SICKLA_LAT, 0.2)]] })),
      w('Ingen geometri', area(undefined)),
      w('Punkt', area({ type: 'Point', coordinates: [SICKLA_LON, SICKLA_LAT] })),
      w('Precis 24 h', area(here, { approximateStart: iso(now + 24 * 3600e3) })),
      w('24 h och 1 min', area(here, { approximateStart: iso(now + 24 * 3600e3 + 60e3) })),
      w('Slutar nu', area(here, { approximateEnd: iso(now) })),
      w('Slutade nyss', area(here, { approximateEnd: iso(now - 60e3) })),
      w('Utan nivå', { area: { geometry: here } }),
      w(null, area(here, { eventDescription: { sv: 'Från området' }, warningLevel: { code: 'RED' } })),
      w(null, area(here, { warningLevel: { code: 'PURPLE' } })),
    ];
    return smhiWarningItems(data, now).map(i => [i.title, i.levelCode, i.startText]);
  })()`);
  assert.deepEqual(result, [
    ['Från området', 'RED', ''],
    ['Multi', 'YELLOW', ''],
    ['Slutar nu', 'YELLOW', ''],
    ['Precis 24 h', 'YELLOW', 'från i morgon kl. 12:00'],
    ['Utan nivå', 'MESSAGE', ''],
    ['Varning', 'PURPLE', ''],
  ], 'a hole over Sickla, no geometry, a point, more than 24 h ahead and an ended warning are left out; an unknown level sorts last');
  assert.equal(await evaluate(`formatWarningStart(new Date(2026, 10, 2, 0, 30), new Date(2026, 10, 1, 23, 50))`), 'från i morgon kl. 00:30');
  assert.equal(await evaluate(`formatWarningStart(new Date(2026, 10, 1, 23, 59), new Date(2026, 10, 1, 0, 1))`), 'från kl. 23:59');
});

// ---------- Weather ----------
test('weather: current temperature, symbol, wind and four forecast times', async () => {
  await evaluate('loadWeather()');
  assert.equal(await text('temp'), '8°');
  assert.equal(await text('tempIcon'), '🌧️');
  assert.equal(await text('weatherDesc'), 'Lätt regn\nVind 4 m/s');
  const labels = await evaluate(`[...document.querySelectorAll('#forecastRow .fc-time')].map(e => e.textContent)`);
  assert.deepEqual(labels, ['09', '13', '17', '21']);
});

test('weather: each forecast time picks today, or tomorrow once it is more than 30 minutes past', async () => {
  const temps = await evaluate(`[...document.querySelectorAll('#forecastRow .fc-temp')].map(e => e.textContent)`);
  const now = new Date();
  const expected = [9, 13, 17, 21].map(h => {
    const target = new Date(now); target.setHours(h, 0, 0, 0);
    if (target.getTime() < now.getTime() - 30 * MIN) target.setDate(target.getDate() + 1);
    // The first entry (this hour) carries the "now" values instead of the encoded temperature
    const thisHour = new Date(now); thisHour.setMinutes(0, 0, 0);
    return target.getTime() === thisHour.getTime() ? '8°' : `${target.getDate() * 100 + h}°`;
  });
  assert.deepEqual(temps, expected);
});

test('weather: forecast times that show tomorrow are marked "i morgon", the others get an empty line', async () => {
  // A fixed series from 2026-11-11 00:00 local time; the temperature encodes day and hour
  // (1113 = the 11th at 13:00). renderForecastRow takes "now" as an argument.
  const row = (h, m) => evaluate(`(() => {
    const start = new Date(2026, 10, 11, 0, 0, 0, 0);
    const series = Array.from({ length: 72 }, (_, i) => {
      const t = new Date(start.getTime() + i * 3600000);
      return { time: t.toISOString(), data: { air_temperature: t.getDate() * 100 + t.getHours(), symbol_code: 1 } };
    });
    renderForecastRow(series, [9, 13, 17, 21], new Date(2026, 10, 11, ${h}, ${m}));
    const items = [...document.querySelectorAll('#forecastRow .forecast-item')];
    return {
      days: items.map(e => { const d = e.querySelector('.fc-day'); return d ? d.textContent : null; }),
      marked: items.map(e => e.classList.contains('tomorrow')),
      times: items.map(e => e.querySelector('.fc-time').textContent),
      temps: items.map(e => e.querySelector('.fc-temp').textContent),
    };
  })()`);
  let r = await row(8, 0);
  assert.deepEqual(r.days, [null, null, null, null], 'before 09:30 everything is today and no extra line is added');
  assert.deepEqual(r.temps, ['1109°', '1113°', '1117°', '1121°']);
  r = await row(9, 30);
  assert.deepEqual(r.days, [null, null, null, null], '09:00 still counts as today exactly 30 minutes past');
  r = await row(9, 31);
  assert.deepEqual(r.days, ['i morgon', '', '', ''], 'one minute later 09 shows tomorrow');
  assert.deepEqual(r.temps, ['1209°', '1113°', '1117°', '1121°']);
  r = await row(14, 0);
  assert.deepEqual(r.days, ['i morgon', 'i morgon', '', '']);
  assert.deepEqual(r.marked, [true, true, false, false]);
  assert.deepEqual(r.times, ['09', '13', '17', '21'], 'the order stays fixed');
  assert.deepEqual(r.temps, ['1209°', '1213°', '1117°', '1121°']);
  r = await row(21, 31);
  assert.deepEqual(r.days, ['i morgon', 'i morgon', 'i morgon', 'i morgon'], 'late in the evening the whole row is tomorrow');
  assert.deepEqual(r.temps, ['1209°', '1213°', '1217°', '1221°']);
  // Just after midnight it is a new day: nothing is marked and the row shows the new today
  const after = await evaluate(`(() => {
    const start = new Date(2026, 10, 11, 0, 0, 0, 0);
    const series = Array.from({ length: 72 }, (_, i) => {
      const t = new Date(start.getTime() + i * 3600000);
      return { time: t.toISOString(), data: { air_temperature: t.getDate() * 100 + t.getHours(), symbol_code: 1 } };
    });
    renderForecastRow(series, [9, 13, 17, 21], new Date(2026, 10, 12, 0, 10));
    return [...document.querySelectorAll('#forecastRow .forecast-item')].map(e => [e.querySelector('.fc-day')?.textContent ?? null, e.querySelector('.fc-temp').textContent]);
  })()`);
  assert.deepEqual(after, [[null, '1209°'], [null, '1213°'], [null, '1217°'], [null, '1221°']]);
});

test('weather: the "i morgon" line keeps all forecast times on one baseline', async () => {
  const tops = await evaluate(`(() => {
    const start = new Date(2026, 10, 11, 0, 0, 0, 0);
    const series = Array.from({ length: 72 }, (_, i) => ({ time: new Date(start.getTime() + i * 3600000).toISOString(), data: { air_temperature: 5, symbol_code: 1 } }));
    renderForecastRow(series, [9, 13, 17, 21], new Date(2026, 10, 11, 14, 0));
    const items = [...document.querySelectorAll('#forecastRow .forecast-item')];
    const card = document.querySelector('.weather-card').getBoundingClientRect();
    const row = document.getElementById('forecastRow').getBoundingClientRect();
    return {
      time: items.map(e => Math.round(e.querySelector('.fc-time').getBoundingClientRect().top)),
      temp: items.map(e => Math.round(e.querySelector('.fc-temp').getBoundingClientRect().top)),
      day: items.map(e => e.querySelector('.fc-day').getBoundingClientRect().height),
      widths: items.map(e => Math.round(e.getBoundingClientRect().width)),
      labelFits: items.every(e => { const d = e.querySelector('.fc-day'); return d.scrollWidth <= e.getBoundingClientRect().width + 0.5; }),
      rowRight: row.right, cardRight: card.right, rowLeft: row.left, cardLeft: card.left,
    };
  })()`);
  assert.equal(new Set(tops.time).size, 1, `times aligned: ${tops.time}`);
  assert.equal(new Set(tops.temp).size, 1, `temperatures aligned: ${tops.temp}`);
  assert.ok(tops.day.every(h => h > 0), 'the empty line takes the same space');
  assert.equal(new Set(tops.widths).size, 1, `all forecast times equally wide: ${tops.widths}`);
  assert.ok(tops.labelFits, '"i morgon" fits within its column');
  assert.ok(tops.rowRight <= tops.cardRight && tops.rowLeft >= tops.cardLeft, 'the row fits inside the weather card');
  await evaluate('loadWeather()'); // back to the real "now"
});

// In-page forecast series in local time, one entry per `step` hours from `start`
// (arguments to new Date(...)); the temperature encodes day and hour (1113 = the 11th
// at 13:00) so a test can see which entry each forecast time picked.
const seriesJs = (start, count = 72, step = 1) => `(() => {
  const s = new Date(${start});
  return Array.from({ length: ${count} }, (_, i) => {
    const t = new Date(s.getTime() + i * ${step} * 3600000);
    return { time: t.toISOString(), data: { air_temperature: t.getDate() * 100 + t.getHours(), symbol_code: 1 } };
  });
})()`;
const readRow = `[...document.querySelectorAll('#forecastRow .forecast-item')].map(e => {
  const d = e.querySelector('.fc-day');
  return [d ? d.textContent : null, e.querySelector('.fc-time').textContent, e.querySelector('.fc-icon').textContent, e.querySelector('.fc-temp').textContent];
})`;
const rowAt = (start, now, count, step) =>
  evaluate(`(() => { renderForecastRow(${seriesJs(start, count, step)}, FORECAST_HOURS, new Date(${now})); return ${readRow}; })()`);
const days = (row) => row.map(r => r[0]);
const temps = (row) => row.map(r => r[3]);
const M = 'i morgon';

test('weather edge cases: the 30-minute boundary is exact to the millisecond', async () => {
  const start = '2026, 10, 11, 0, 0';
  assert.deepEqual(days(await rowAt(start, '2026, 10, 11, 9, 30, 0, 0')), [null, null, null, null], '09:30:00.000 is still today');
  assert.deepEqual(days(await rowAt(start, '2026, 10, 11, 9, 30, 0, 1')), [M, '', '', ''], '09:30:00.001 is tomorrow');
  assert.deepEqual(days(await rowAt(start, '2026, 10, 11, 13, 30, 0, 0')), [M, '', '', '']);
  assert.deepEqual(days(await rowAt(start, '2026, 10, 11, 13, 30, 0, 1')), [M, M, '', '']);
  assert.deepEqual(days(await rowAt(start, '2026, 10, 11, 17, 30, 0, 1')), [M, M, M, '']);
  assert.deepEqual(days(await rowAt(start, '2026, 10, 11, 21, 30, 0, 0')), [M, M, M, '']);
  assert.deepEqual(days(await rowAt(start, '2026, 10, 11, 21, 30, 0, 1')), [M, M, M, M]);
  // A time not yet reached, or reached less than 30 minutes ago, is today
  const r = await rowAt(start, '2026, 10, 11, 17, 0');
  assert.deepEqual(days(r), [M, M, '', '']);
  assert.deepEqual(temps(r), ['1209°', '1213°', '1117°', '1121°']);
});

test('weather edge cases: around midnight', async () => {
  const start = '2026, 10, 11, 0, 0';
  let r = await rowAt(start, '2026, 10, 11, 23, 59, 59, 999');
  assert.deepEqual(days(r), [M, M, M, M]);
  assert.deepEqual(temps(r), ['1209°', '1213°', '1217°', '1221°']);
  r = await rowAt(start, '2026, 10, 12, 0, 0, 0, 0');
  assert.deepEqual(days(r), [null, null, null, null], 'at midnight the same times become today');
  assert.deepEqual(temps(r), ['1209°', '1213°', '1217°', '1221°'], 'and still show the same entries');
  assert.equal(await evaluate(`document.getElementById('forecastRow').classList.contains('has-tomorrow')`), false);
});

test('weather edge cases: month and year change, leap day', async () => {
  let r = await rowAt('2026, 11, 31, 0, 0', '2026, 11, 31, 14, 0');
  assert.deepEqual(days(r), [M, M, '', '']);
  assert.deepEqual(temps(r), ['109°', '113°', '3117°', '3121°'], '1 January 2027 for 09 and 13');
  r = await rowAt('2026, 10, 30, 0, 0', '2026, 10, 30, 22, 0');
  assert.deepEqual(temps(r), ['109°', '113°', '117°', '121°'], '30 November rolls to 1 December');
  r = await rowAt('2028, 1, 28, 0, 0', '2028, 1, 28, 22, 0');
  assert.deepEqual(temps(r), ['2909°', '2913°', '2917°', '2921°'], '28 February 2028 rolls to the leap day');
  r = await rowAt('2027, 1, 28, 0, 0', '2027, 1, 28, 22, 0');
  assert.deepEqual(temps(r), ['109°', '113°', '117°', '121°'], '28 February 2027 rolls to 1 March');
});

test('weather edge cases: summer-time changes in Stockholm', async () => {
  await send('Emulation.setTimezoneOverride', { timezoneId: 'Europe/Stockholm' });
  try {
    // 25 October 2026: clocks go back at 03:00 (a 25-hour day)
    let r = await rowAt('2026, 9, 24, 0, 0', '2026, 9, 24, 22, 0');
    assert.deepEqual(days(r), [M, M, M, M]);
    assert.deepEqual(temps(r), ['2509°', '2513°', '2517°', '2521°'], 'local hours on the day the clocks go back');
    r = await rowAt('2026, 9, 25, 0, 0', '2026, 9, 25, 14, 0');
    assert.deepEqual(temps(r), ['2609°', '2613°', '2517°', '2521°'], 'on the 25-hour day itself');
    // 28 March 2027: clocks go forward at 02:00 (a 23-hour day)
    r = await rowAt('2027, 2, 27, 0, 0', '2027, 2, 27, 22, 0');
    assert.deepEqual(temps(r), ['2809°', '2813°', '2817°', '2821°'], 'local hours on the day the clocks go forward');
    r = await rowAt('2027, 2, 28, 0, 0', '2027, 2, 28, 14, 0');
    assert.deepEqual(temps(r), ['2909°', '2913°', '2817°', '2821°'], 'on the 23-hour day itself');
    // The night of the change, before and after 03:00 / 02:00
    assert.deepEqual(days(await rowAt('2026, 9, 24, 0, 0', '2026, 9, 25, 2, 30')), [null, null, null, null]);
    assert.deepEqual(days(await rowAt('2027, 2, 27, 0, 0', '2027, 2, 28, 3, 30')), [null, null, null, null]);
  } finally {
    await send('Emulation.setTimezoneOverride', { timezoneId: '' });
  }
});

test('weather edge cases: a forecast that does not reach a time shows a dash, not another hour', async () => {
  // 12 entries from 14:00 reach 01:00; tomorrow's 09 and 13 are far beyond that
  let r = await rowAt('2026, 10, 11, 14, 0', '2026, 10, 11, 14, 0', 12);
  assert.deepEqual(r, [[M, '09', '', '–'], [M, '13', '', '–'], ['', '17', '☀️', '1117°'], ['', '21', '☀️', '1121°']]);
  // Three-hour steps: 09 → 09:00, 13 → 12:00 (60 min away) and 17 → 18:00 are used
  r = await rowAt('2026, 10, 11, 0, 0', '2026, 10, 11, 8, 0', 24, 3);
  assert.deepEqual(temps(r), ['1109°', '1112°', '1118°', '1121°']);
  // Exactly 90 minutes away is still used, one millisecond more is not
  const only = (ms) => evaluate(`(() => {
    const t = new Date(new Date(2026, 10, 11, 9, 0).getTime() + ${ms});
    renderForecastRow([{ time: t.toISOString(), data: { air_temperature: 5, symbol_code: 1 } }], FORECAST_HOURS, new Date(2026, 10, 11, 8, 0));
    return ${readRow};
  })()`);
  assert.equal((await only(-90 * MIN))[0][3], '5°', '07:30 for 09');
  assert.equal((await only(90 * MIN))[0][3], '5°', '10:30 for 09');
  assert.equal((await only(-90 * MIN - 1))[0][3], '–', '07:29:59.999 for 09');
  assert.equal((await only(90 * MIN + 1))[0][3], '–', '10:30:00.001 for 09');
  assert.deepEqual((await only(90 * MIN + 1)).map(x => x[2]), ['', '', '', ''], 'no icon next to a dash');
});

test('weather edge cases: the marking and its widths go away when no time is tomorrow', async () => {
  const geometry = () => evaluate(`(() => {
    const row = document.getElementById('forecastRow');
    return { cls: row.classList.contains('has-tomorrow'), widths: [...row.querySelectorAll('.forecast-item')].map(e => Math.round(e.getBoundingClientRect().width)) };
  })()`);
  await rowAt('2026, 10, 11, 0, 0', '2026, 10, 11, 14, 0');
  const marked = await geometry();
  assert.equal(marked.cls, true);
  await rowAt('2026, 10, 11, 0, 0', '2026, 10, 11, 8, 0');
  const plain = await geometry();
  assert.equal(plain.cls, false);
  assert.ok(plain.widths.every(w => w < marked.widths[0]), `columns narrow again: ${plain.widths} vs ${marked.widths}`);
});

test('weather edge cases: the row is redrawn from the last forecast, and an error clears it', async () => {
  await evaluate(`forecastSeries = ${seriesJs('2026, 10, 11, 0, 0')}`);
  await evaluate(`renderForecastFromCache(new Date(2026, 10, 11, 23, 50))`);
  assert.deepEqual(days(await evaluate(readRow)), [M, M, M, M]);
  await evaluate(`renderForecastFromCache(new Date(2026, 10, 12, 0, 1))`);
  assert.deepEqual(days(await evaluate(readRow)), [null, null, null, null], 'a new day without fetching again');
  await evaluate(`renderForecastFromCache(new Date(2026, 10, 12, 9, 31))`);
  assert.deepEqual(days(await evaluate(readRow)), [M, '', '', '']);
  // A failed fetch empties the row and the cache, so the minute redraw cannot bring back old data
  mocks.weather = () => ({ status: 500, body: '' });
  await evaluate('loadWeather()');
  assert.equal(await evaluate(`forecastSeries`), null);
  await evaluate(`renderForecastFromCache(new Date(2026, 10, 12, 14, 0))`);
  assert.equal(await evaluate(`document.getElementById('forecastRow').children.length`), 0);
  assert.equal(await evaluate(`document.getElementById('forecastRow').classList.contains('has-tomorrow')`), false);
  mocks.weather = DEFAULT_MOCKS.weather;
  await evaluate('loadWeather()');
  assert.ok(await evaluate(`Array.isArray(forecastSeries) && forecastSeries.length === 48`));
});

test('weather edge cases: the marked row fits and stays aligned in landscape and with a dash', async () => {
  const check = () => evaluate(`(() => {
    const items = [...document.querySelectorAll('#forecastRow .forecast-item')];
    const card = document.querySelector('.weather-card').getBoundingClientRect();
    const row = document.getElementById('forecastRow').getBoundingClientRect();
    return {
      fits: row.left >= card.left && row.right <= card.right,
      time: new Set(items.map(e => Math.round(e.querySelector('.fc-time').getBoundingClientRect().top))).size,
      temp: new Set(items.map(e => Math.round(e.querySelector('.fc-temp').getBoundingClientRect().top))).size,
      overflow: items.some(e => e.querySelector('.fc-day').scrollWidth > e.getBoundingClientRect().width + 0.5),
    };
  })()`);
  try {
    for (const [w, h] of [[800, 1280], [1280, 800], [600, 960]]) {
      await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: true });
      await sleep(100);
      await rowAt('2026, 10, 11, 14, 0', '2026, 10, 11, 14, 0', 12); // two dashes, two values
      assert.deepEqual(await check(), { fits: true, time: 1, temp: 1, overflow: false }, `${w}×${h}`);
    }
  } finally {
    await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: true });
    await evaluate('loadWeather()');
  }
});

test('weather: unknown symbol, rounding around zero', async () => {
  mocks.weather = () => ok(forecast({ air_temperature: -0.4, wind_speed: 0.4, symbol_code: 99 }));
  await evaluate('loadWeather()');
  assert.equal(await text('temp'), '0°', 'no "-0°"');
  assert.equal(await text('tempIcon'), '🌡️');
  assert.equal(await text('weatherDesc'), 'Okänt väder\nVind 0 m/s');
  mocks.weather = () => ok(forecast({ air_temperature: -2.5, symbol_code: 27 }));
  await evaluate('loadWeather()');
  assert.equal(await text('temp'), '-2°');
  assert.equal(await text('weatherDesc'), 'Kraftigt snöfall\nVind 4 m/s');
});

test('weather: an error or an unexpected answer says so and empties the forecast row', async () => {
  for (const answer of [{ status: 500, body: '' }, ok({ timeSeries: [] }), ok({})]) {
    await evaluate('loadWeather()'); // restore a filled row first
    mocks.weather = () => answer;
    await evaluate('loadWeather()');
    assert.equal(await text('weatherDesc'), 'Kunde inte hämta väder');
    assert.equal(await evaluate(`document.getElementById('forecastRow').children.length`), 0);
    mocks.weather = DEFAULT_MOCKS.weather;
  }
  await evaluate('loadWeather()');
  assert.equal(await text('temp'), '8°');
});

// ---------- Rain radar (MET Norway nowcast) ----------
const radar = async (rates, options) => {
  mocks.nowcast = () => ok(nowcast(rates, options));
  await evaluate('loadNowcast()');
  return evaluate(`({ visible: document.getElementById('nowcast').classList.contains('visible'),
    text: document.getElementById('nowcastText').textContent,
    bars: [...document.querySelectorAll('#nowcastBars .nowcast-bar')].map(b => ({ h: parseFloat(b.style.height), snow: b.classList.contains('snow') })) })`);
};
const series = (start, stop, rate) => Array.from({ length: 25 }, (_, i) => (i >= start && i < stop ? rate : 0));

test('rain radar: hidden when dry, below 0.1 mm/h, or without radar coverage', async () => {
  assert.equal((await radar(dry())).visible, false);
  assert.equal((await radar(Array(25).fill(0.09))).visible, false, '0.09 mm/h counts as dry');
  assert.equal((await radar(Array(25).fill(2), { coverage: 'no coverage' })).visible, false);
  assert.equal((await radar(Array(25).fill(0.1))).visible, true, '0.1 mm/h counts as wet');
});

test('rain radar: rain later, rain now that stops, rain for the whole 2 hours', async () => {
  let r = await radar(series(3, 25, 0.5));
  assert.equal(r.text, 'Lätt regn om ca\u00a015\u00a0min');
  r = await radar(series(0, 4, 1));
  assert.equal(r.text, 'Måttligt regn nu, upphör om ca\u00a020\u00a0min');
  r = await radar(Array(25).fill(4));
  assert.equal(r.text, 'Kraftigt regn nu, fortsätter närmaste 2\u00a0h');
  assert.equal(r.bars.length, 25);
});

test('rain radar: strength thresholds 1 and 4 mm/h, by the highest rate', async () => {
  assert.match((await radar(series(0, 25, 0.99))).text, /^Lätt /);
  assert.match((await radar(series(0, 25, 3.99))).text, /^Måttligt /);
  assert.match((await radar([...series(0, 24, 0.2).slice(0, 24), 4])).text, /^Kraftigt regn nu, fortsätter/, 'one point at 4 mm/h decides');
});

test('rain radar: the type follows the temperature (above 2 °C rain, above 0 °C sleet, else snow)', async () => {
  const kind = async (temp) => (await radar(Array(25).fill(2), { temp })).text.replace(/ nu,.*/, '');
  assert.equal(await kind(2.1), 'Måttligt regn');
  assert.equal(await kind(2), 'Måttligt snöblandat regn');
  assert.equal(await kind(0.1), 'Måttligt snöblandat regn');
  assert.equal(await kind(0), 'Måttligt snöfall');
  assert.equal(await kind(-5), 'Måttligt snöfall');
  assert.equal(await kind(undefined), 'Måttligt regn', 'no temperature counts as rain');
  const bars = (await radar(Array(25).fill(2), { temp: -1 })).bars;
  assert.ok(bars.every(b => b.snow), 'snow bars');
});

test('rain radar: bar heights (square root, at least 8 %, 8 mm/h fills the bar)', async () => {
  const r = await radar([0, 0.05, 0.1, 2, 8, 20, ...Array(19).fill(0)]);
  const h = r.bars.map(b => Math.round(b.h * 10) / 10);
  assert.deepEqual(h.slice(0, 6), [0, 0, 11.2, 50, 100, 100]);
  assert.ok(r.bars.every(b => !b.snow));
});

test('rain radar: a failed fetch keeps the last data; data that has run out hides the box', async () => {
  await radar(Array(25).fill(2));
  mocks.nowcast = () => ({ status: 500, body: '' });
  await evaluate('loadNowcast()');
  assert.equal(await visible('nowcast'), true, 'still shown after an error');
  // Only one point left that is not older than 5 minutes: hidden
  await evaluate(`nowcastData = { temp: 8, points: [{ time: Date.now() - 20 * 60000, rate: 2 }, { time: Date.now() - 6 * 60000, rate: 2 }, { time: Date.now(), rate: 2 }] }; renderNowcast()`);
  assert.equal(await visible('nowcast'), false);
  mocks.nowcast = DEFAULT_MOCKS.nowcast;
  await evaluate('loadNowcast()');
  assert.equal(await visible('nowcast'), false);
});

// ---------- Bathing water ----------
const bathingCard = () => evaluate(`({
  temp: document.getElementById('bathingTemp').textContent,
  badges: [...document.querySelectorAll('#bathingReports .bathing-status-badge')].map(b => [b.textContent, b.className.replace('bathing-status-badge ', '')]),
  reports: document.getElementById('bathingReports').textContent.replace(/\\s+/g, ' ').trim(),
  detail: document.querySelector('#bathingReports .bathing-report-detail')?.textContent.replace(/\\s+/g, ' ').trim() ?? null,
  advisory: document.getElementById('bathingAdvisory').textContent,
  advisoryVisible: document.getElementById('bathingAdvisory').classList.contains('visible'),
  eu: document.getElementById('bathingEu').textContent,
})`);
const loadBathing = async (answer) => { mocks.bathing = () => answer; await evaluate('loadBathingWater()'); return bathingCard(); };

test('bathing card: latest temperature with its date, two latest samples, EU class', async () => {
  const c = await loadBathing(ok(BATHING_DEFAULT));
  assert.equal(c.temp, '20°10 augusti');
  assert.deepEqual(c.badges, [['Tjänligt', 'ok'], ['Tjänligt med anmärkning', 'warn']]);
  assert.match(c.reports, /Tjänligt 10 augusti Tjänligt med anmärkning 20 juli/);
  assert.equal(c.detail, null, 'no bacteria detail when the latest sample is fine');
  assert.equal(c.advisoryVisible, false);
  assert.equal(c.eu, `EU-klass ${YEAR - 1}: Utmärkt kvalitet`);
});

test('bathing card: an unfit latest sample shows the bacteria counts; "=" is not shown', async () => {
  const c = await loadBathing(ok(bathing([sample(`${YEAR}-08-12`, 3, {
    escherichiaColiPrefix: '>', escherichiaColiCount: 1500, intestinalEnterococciPrefix: '=', intestinalEnterococciCount: 450, algalIdText: 'Ingen blomning', weatherIdText: '' })])));
  assert.deepEqual(c.badges, [['Otjänligt', 'bad']]);
  assert.match(c.detail, /^E\. coli: >1500 \(gräns för Otjänligt: >1000 CFU\/100ml\) Tarmenterokocker: 450 \(gräns: >400 CFU\/100ml\) Algblomning: Ingen blomning$/);
  assert.equal(await evaluate(`formatCount(undefined, null)`), '–');
  assert.equal(await evaluate(`formatCount('<', 0)`), '<0');
});

test('bathing card: advisories are shown at the top, with fallbacks for missing text', async () => {
  const c = await loadBathing(ok(bathing([sample(`${YEAR}-08-10`, 1)], {
    adviceAgainstBathing: [{ description: 'Avrådan från bad p.g.a. avloppsutsläpp' }],
    abnormalSituations: [{ typeIdText: 'Algblomning' }, {}],
  })));
  assert.equal(c.advisoryVisible, true);
  assert.equal(await evaluate(`document.getElementById('bathingAdvisory').innerHTML`),
    '⚠ Avrådan från bad p.g.a. avloppsutsläpp<br>⚠ Algblomning<br>⚠ Badförbud/varning');
});

test('bathing card: texts from the API are escaped (advisories, assessment, counts, algae, weather)', async () => {
  const c = await loadBathing(ok(bathing([sample(`${YEAR}-08-12`, 3, {
    sampleAssessIdText: MARKUP, escherichiaColiPrefix: MARKUP, intestinalEnterococciPrefix: MARKUP, algalIdText: MARKUP, weatherIdText: MARKUP })], {
    adviceAgainstBathing: [{ description: MARKUP }], abnormalSituations: [{ typeIdText: MARKUP }] })));
  assert.equal(await injected(), 0);
  assert.equal(c.advisory, `⚠ ${MARKUP}⚠ ${MARKUP}`);
  assert.equal(c.badges[0][0], MARKUP);
  assert.equal(c.detail.split(MARKUP).length - 1, 4, 'both prefixes, algae and weather shown as text');
  await loadBathing(ok(BATHING_DEFAULT));
});

test('bathing card: no samples and no classification', async () => {
  const c = await loadBathing(ok({ results: [], profile: {} }));
  assert.equal(c.temp, '–°');
  assert.equal(c.reports, 'Inga provresultat tillgängliga');
  assert.equal(c.eu, '');
  assert.equal(c.advisoryVisible, false);
});

test('bathing card: an error keeps the temperature, says so, and retries in 10 minutes', async () => {
  await loadBathing(ok(BATHING_DEFAULT));
  await evaluate('clearTimeout(bathingRetryTimer); bathingRetryTimer = null');
  const c = await loadBathing({ status: 503, body: '' });
  assert.equal(c.reports, 'Kunde inte hämta badvattendata (HTTP 503)');
  assert.equal(c.temp, '20°10 augusti');
  assert.notEqual(await evaluate('bathingRetryTimer'), null, 'retry timer set');
  await loadBathing(ok(BATHING_DEFAULT));
});

const bathingOverlay = () => evaluate(`({
  open: document.getElementById('bathingOverlay').classList.contains('visible'),
  title: document.getElementById('bathingOverlayTitle').textContent,
  meta: document.getElementById('bathingOverlayMeta').innerHTML.split('<br>'),
  samples: [...document.querySelectorAll('#bathingOverlayList .bo-sample')].map(s => s.textContent.replace(/\\s+/g, ' ').trim()),
  list: document.getElementById('bathingOverlayList').textContent.trim(),
})`);

test('sample panel: this year\'s samples newest first, all fields, season and risks', async () => {
  // The API order is not trusted: an older sample first
  await loadBathing(ok(bathing([
    sample(`${YEAR}-06-20`, 1, { waterTemp: 18 }),
    sample(`${YEAR}-08-10`, 3, { waterTemp: null, escherichiaColiPrefix: '>', escherichiaColiCount: 1500, escherichiaColiAssessIdText: 'Otjänligt', sampleComplete: false }),
    sample(`${YEAR - 1}-08-01`, 1),
  ])));
  await tap('#clockCard');
  const o = await bathingOverlay();
  assert.equal(o.open, true);
  assert.equal(o.title, `🏖️ Badvattenprov ${YEAR} · Sickla strandbad`);
  assert.deepEqual(o.meta, [
    'Badsäsong: 15 juni – 31 augusti',
    'Risk för blomning av alger och cyanobakterier',
    `EU-klass: ${YEAR - 1} Utmärkt kvalitet · ${YEAR - 2} Bra kvalitet`,
    'Inga aktiva badförbud eller avvikelser',
    'Gräns för Otjänligt: E. coli &gt;1000, tarmenterokocker &gt;400 CFU/100 ml',
  ]);
  assert.equal(o.samples.length, 2, 'last year\'s sample is left out');
  assert.match(o.samples[0], /^Otjänligt \S+ 10 augusti – E\. coli >1500 CFU\/100 ml · Otjänligt .* Ofullständigt prov$/);
  assert.match(o.samples[1], /^Tjänligt \S+ 20 juni 18° E\. coli <10 CFU\/100 ml · Tjänligt Tarmenterokocker 5 CFU\/100 ml · Tjänligt Algblomning Ingen blomning Väder vid provtagning Soligt$/);
  await tap('#bathingOverlayClose');
  assert.equal((await bathingOverlay()).open, false);
});

test('sample panel: before the season it shows the latest year with samples; edge cases', async () => {
  await loadBathing(ok(bathing([sample(`${YEAR - 1}-08-01`, 1), sample(`${YEAR - 2}-07-01`, 1)], {
    profile: { bloomRisk: { algae: false, cyano: true } }, abnormalSituations: [{ description: 'Oljeutsläpp' }] })));
  await evaluate('openBathingOverlay()');
  let o = await bathingOverlay();
  assert.equal(o.title, `🏖️ Badvattenprov ${YEAR - 1} · Sickla strandbad`);
  assert.equal(o.samples.length, 1);
  assert.deepEqual(o.meta, ['Risk för blomning av cyanobakterier', '⚠ Oljeutsläpp', 'Gräns för Otjänligt: E. coli &gt;1000, tarmenterokocker &gt;400 CFU/100 ml']);
  await loadBathing(ok({ results: [] }));
  await evaluate('openBathingOverlay()');
  o = await bathingOverlay();
  assert.equal(o.title, `🏖️ Badvattenprov ${YEAR} · Sickla strandbad`);
  assert.equal(o.list, 'Inga provresultat tillgängliga.');
  await evaluate('bathingData = null; openBathingOverlay()');
  o = await bathingOverlay();
  assert.equal(o.title, '🏖️ Badvattenprov');
  assert.equal(o.list, 'Ingen badvattendata hämtad ännu.');
  await evaluate('closeBathingOverlay()');
  await loadBathing(ok(BATHING_DEFAULT));
});

test('sample panel: values from the API are escaped', async () => {
  await loadBathing(ok(bathing([sample(`${YEAR}-08-10`, 1, { waterTemp: '<b>21</b>', algalIdText: '<i>x</i>' })])));
  await evaluate('openBathingOverlay()');
  assert.equal(await evaluate(`document.querySelectorAll('#bathingOverlayList b, #bathingOverlayList i').length`), 0);
  assert.match((await bathingOverlay()).samples[0], /<b>21<\/b>°/);
  await evaluate('closeBathingOverlay()');
  await loadBathing(ok(BATHING_DEFAULT));
});

// ---------- Departures ----------
const busList = () => evaluate(`[...document.querySelectorAll('#busList li')].map(li => li.classList.contains('status-msg')
  ? { status: li.textContent.trim() }
  : { line: li.querySelector('.bus-line').textContent, dest: li.querySelector('.bus-dest').textContent,
      time: li.querySelector('.bus-time').textContent.replace(/\\s+/g, ' ').trim(), timeClass: li.querySelector('.bus-time').className.replace('bus-time', '').trim(),
      departed: li.classList.contains('departed'), moving: !!li.querySelector('.moving-dot'),
      deviation: li.querySelector('.bus-deviation')?.textContent ?? null })`);
const lines = async () => (await busList()).filter(i => i.line).map(i => i.line);
const refresh = async () => { await evaluate('clearTimeout(departuresTimer); loadBuses()'); return busList(); };
const nextFetchIn = () => evaluate('Math.round((departuresNextFetchAt - Date.now()) / 1000)');
const resetFailures = () => evaluate('departuresFailures = 0; departuresFailingSince = 0; departuresLastError = ""');

test('departures: the default stop is Tallbacken, the picker lists all 14 stops in Swedish order', async () => {
  const s = await evaluate(`({ value: document.getElementById('stopSelect').value, names: [...document.getElementById('stopSelect').options].map(o => o.textContent) })`);
  assert.equal(s.value, '4632');
  assert.equal(s.names.length, 14);
  assert.deepEqual(s.names, [...s.names].sort((a, b) => a.localeCompare(b, 'sv')));
  assert.match(requests.filter(r => r.key === 'sl').at(-1).url, /\/v1\/sites\/4632\/departures$/);
});

test('departures: sorted by time, inside the window -10…+60 min, buses/trams/trains/metro only', async () => {
  const list = await refresh();
  assert.deepEqual(list.map(i => `${i.line} ${i.dest}`), [
    '30 Solna station', '444 Danderyds sjukhus', '401 Slussen', '30 Sickla', '471 Slussen', '401 Slussen', '25M Saltsjöbaden', '17 Åkeshov',
  ]);
});

test('departures: "Nu", "Avgick", minutes, "ca" for timetable times, moving dot, deviations', async () => {
  const list = await busList();
  const by = (line, dest) => list.find(i => i.line === line && i.dest === dest && !i.departed && i.time !== 'Nu') || list.find(i => i.line === line && i.dest === dest);
  assert.deepEqual(list[0], { line: '30', dest: 'Solna station', time: 'Avgick 5 min sedan', timeClass: 'past', departed: true, moving: true, deviation: null });
  assert.equal(list[1].time, 'Nu', 'one minute ago still counts as now');
  assert.equal(list[1].timeClass, 'now');
  assert.equal(list[1].deviation, '⚠ Omledning', 'a string deviation');
  assert.equal(list[2].time, 'Nu');
  assert.equal(by('30', 'Sickla').time, '3 min');
  const expected = by('471', 'Slussen');
  assert.equal(expected.time, 'ca 7 min', 'timetable-based time gets "ca"');
  assert.equal(expected.moving, false, 'no dot before the vehicle is tracked');
  assert.equal(expected.deviation, '⚠ Inställd hållplats · Försenad', 'a list of deviations');
  assert.equal(by('25M', 'Saltsjöbaden').deviation, '⚠ Buss ersätter', 'an object deviation');
});

test('departures: deviation text, line and destination from SL are escaped', async () => {
  mocks.sl = () => ok({ departures: [dep(5, MARKUP, MARKUP, 'BUS', { deviations: [{ message: MARKUP }] })] });
  const list = await refresh();
  assert.equal(await injected(), 0);
  assert.deepEqual([list[0].line, list[0].dest, list[0].deviation], [MARKUP, MARKUP, `⚠ ${MARKUP}`]);
  mocks.sl = DEFAULT_MOCKS.sl;
  await refresh();
});

test('departures: deviation text from every format SL uses', async () => {
  const r = await evaluate(`[
    extractDeviationText(null), extractDeviationText(''), extractDeviationText('  '), extractDeviationText(' Text '),
    extractDeviationText([]), extractDeviationText([null, '', { foo: 1 }]), extractDeviationText([{ text: 'a' }, { details: 'b' }]),
    extractDeviationText({ message: 'm', header: 'h' }), extractDeviationText({})]`);
  assert.deepEqual(r, [null, null, null, 'Text', null, null, 'a · b', 'h', null]);
});

test('departures: tapping a line number filters to that line, tapping it again shows all', async () => {
  await tap('.bus-line[data-filter-value="401"]');
  assert.deepEqual(await lines(), ['401', '401']);
  assert.equal(await visible('filterBar'), true);
  assert.equal(await text('filterChip'), 'linje 401 ✕');
  await tap('.bus-line[data-filter-value="401"]');
  assert.equal((await lines()).length, 8);
  assert.equal(await visible('filterBar'), false);
});

test('departures: destination filter, mode filters, and the chip clears the filter', async () => {
  await tap('.bus-dest[data-filter-value="Slussen"]');
  assert.deepEqual(await lines(), ['401', '471', '401']);
  assert.equal(await text('filterChip'), 'mot Slussen ✕');
  await tap('.mode-filter[data-filter-value="bus"]');
  assert.deepEqual(await lines(), ['444', '401', '471', '401']);
  assert.equal(await text('filterChip'), 'bussar ✕');
  assert.equal(await evaluate(`document.querySelector('.mode-filter[data-filter-value="bus"]').classList.contains('active')`), true);
  await tap('.mode-filter[data-filter-value="rail"]');
  assert.deepEqual(await lines(), ['30', '30', '25M', '17'], 'tram, train and metro');
  assert.equal(await text('filterChip'), 'tåg och spårvagn ✕');
  assert.equal(await evaluate(`document.querySelector('.mode-filter[data-filter-value="bus"]').classList.contains('active')`), false);
  await tap('#filterChip');
  assert.equal((await lines()).length, 8);
  assert.equal(await evaluate(`document.querySelectorAll('.mode-filter.active').length`), 0);
});

test('departures: a filter that matches nothing says so', async () => {
  await tap('.bus-line[data-filter-value="17"]');
  mocks.sl = () => ok({ departures: [dep(5, '401', 'Slussen')] });
  const list = await refresh();
  assert.deepEqual(list, [{ status: 'Inga avgångar (linje 17) inom de senaste 10 min eller kommande timmen. Tryck på filtret ovan för att visa alla.' }]);
  await evaluate('setDepartureFilter(null)');
  mocks.sl = () => ok({ departures: [] });
  assert.deepEqual(await refresh(), [{ status: 'Inga buss- eller tågavgångar inom de senaste 10 min eller kommande timmen.' }]);
  mocks.sl = DEFAULT_MOCKS.sl;
  await refresh();
});

test('departures: the filter is saved per stop and survives a reload; broken saved filters are ignored', async () => {
  await tap('.bus-line[data-filter-value="30"]');
  assert.equal(await evaluate(`localStorage.getItem('kiosk-sickla-filter-4632')`), '{"type":"line","value":"30"}');
  await load();
  assert.ok(await waitFor(`document.querySelectorAll('#busList .bus-line').length > 0`));
  assert.deepEqual(await lines(), ['30', '30']);
  // Another stop has no filter; back again restores it
  await evaluate(`(() => { const s = document.getElementById('stopSelect'); s.value = '9431'; s.dispatchEvent(new Event('change')); })()`);
  assert.ok(await waitFor(`document.querySelectorAll('#busList .bus-line').length > 0`));
  assert.equal((await lines()).length, 8);
  assert.equal(await visible('filterBar'), false);
  await evaluate(`(() => { const s = document.getElementById('stopSelect'); s.value = '4632'; s.dispatchEvent(new Event('change')); })()`);
  assert.ok(await waitFor(`document.querySelectorAll('#busList .bus-line').length > 0`));
  assert.deepEqual(await lines(), ['30', '30']);
  const parsed = await evaluate(`(() => {
    const r = [];
    for (const v of ['{broken', '{"type":"colour","value":"red"}', '{"type":"line","value":30}', 'null']) {
      localStorage.setItem('kiosk-sickla-filter-1', v); r.push(loadDepartureFilter(1));
    }
    localStorage.removeItem('kiosk-sickla-filter-1');
    return r;
  })()`);
  assert.deepEqual(parsed, [null, null, null, null]);
  await evaluate('setDepartureFilter(null)');
});

test('departures: choosing a stop fetches it at once, empties the list and is remembered', async () => {
  let hold = true;
  mocks.sl = (u) => (u.pathname.includes('/1555/') && hold ? { delay: 800, ...ok(departuresDefault()) } : ok(departuresDefault()));
  await evaluate(`(() => { const s = document.getElementById('stopSelect'); s.value = '1555'; s.dispatchEvent(new Event('change')); })()`);
  assert.deepEqual(await busList(), [{ status: 'Hämtar avgångar…' }]);
  assert.ok(await waitFor(`document.querySelectorAll('#busList .bus-line').length > 0`));
  assert.match(requests.filter(r => r.key === 'sl').at(-1).url, /\/sites\/1555\/departures$/);
  assert.equal(await evaluate(`localStorage.getItem('kiosk-sickla-stop-id')`), '1555');
  await load();
  assert.equal(await evaluate(`document.getElementById('stopSelect').value`), '1555');
  // An unknown saved stop falls back to Tallbacken
  await evaluate(`localStorage.setItem('kiosk-sickla-stop-id', '1234')`);
  await load();
  assert.equal(await evaluate(`document.getElementById('stopSelect').value`), '4632');
  hold = false;
  mocks.sl = DEFAULT_MOCKS.sl;
});

test('departures: an answer for the previous stop that arrives late is ignored', async () => {
  mocks.sl = (u) => (u.pathname.includes('/1555/')
    ? { delay: 1000, ...ok({ departures: [dep(5, '999', 'Fel hållplats')] }) }
    : ok({ departures: [dep(5, '401', 'Slussen')] }));
  const choose = (id) => evaluate(`(() => { const s = document.getElementById('stopSelect'); s.value = '${id}'; s.dispatchEvent(new Event('change')); })()`);
  await choose(1555);
  await sleep(100);
  await choose(4632);
  await sleep(1500);
  assert.deepEqual(await lines(), ['401']);
  mocks.sl = DEFAULT_MOCKS.sl;
  await refresh();
});

test('departures: HTTP 429 keeps the list, backs off 30 s, 60 s, 120 s, 240 s, then at most 5 min', async () => {
  await resetFailures();
  const proxyBefore = countRequests('proxy');
  mocks.sl = () => ({ status: 429, body: '{"message":"Too many requests"}' });
  const waits = [];
  for (let i = 0; i < 6; i++) { await refresh(); waits.push(await nextFetchIn()); }
  assert.deepEqual(waits, [30, 60, 120, 240, 300, 300]);
  const list = await busList();
  assert.equal(list.filter(i => i.line).length, 8, 'the last list stays');
  assert.equal(list.filter(i => i.status).length, 0, 'no notice during the first 3 minutes');
  assert.equal(countRequests('proxy'), proxyBefore, 'an HTTP error does not go via the proxy');
});

test('departures: after 3 minutes of errors a notice shows the time of the last update and the error', async () => {
  const since = await evaluate(`new Date(departuresFetchedAt).toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' })`);
  await evaluate('departuresFailingSince = Date.now() - 3 * 60000 - 1000; renderDepartures()');
  const list = await busList();
  assert.equal(list.filter(i => i.line).length, 8);
  assert.deepEqual(list.at(-1), { status: `⚠ Avgångarna har inte kunnat uppdateras sedan ${since} (HTTP 429). Försöker igen…` });
});

test('departures: SL server errors (5xx) retry after 60 s without growing', async () => {
  await resetFailures();
  mocks.sl = () => ({ status: 503, body: '' });
  const waits = [];
  for (let i = 0; i < 5; i++) { await refresh(); waits.push(await nextFetchIn()); }
  assert.deepEqual(waits, [60, 60, 60, 60, 60]);
  assert.equal(await evaluate('departuresLastError'), 'HTTP 503');
});

test('departures: "Quota has been exceeded" or an unexpected answer with HTTP 200 counts as an error', async () => {
  await resetFailures();
  mocks.sl = () => ok({ error: 'Quota has been exceeded' });
  await refresh();
  assert.equal(await evaluate('departuresLastError'), 'Quota has been exceeded');
  assert.equal(await nextFetchIn(), 30);
  mocks.sl = () => ok({ departures: 'none' });
  await refresh();
  assert.equal(await evaluate('departuresLastError'), 'oväntat svar');
  assert.equal(await nextFetchIn(), 60);
  assert.equal((await lines()).length, 8, 'the list stays');
});

test('departures: a recovery removes the notice and resets the backoff', async () => {
  await evaluate('departuresFailingSince = Date.now() - 5 * 60000');
  mocks.sl = DEFAULT_MOCKS.sl;
  const list = await refresh();
  assert.equal(list.filter(i => i.status).length, 0);
  assert.equal(await evaluate('departuresFailures'), 0);
  assert.equal(await nextFetchIn(), 30);
});

test('departures: with no list yet, an error notice only after 3 minutes', async () => {
  mocks.sl = () => ({ status: 429, body: '' });
  await evaluate(`(() => { const s = document.getElementById('stopSelect'); s.value = '9431'; s.dispatchEvent(new Event('change')); })()`);
  await sleep(300);
  assert.deepEqual(await busList(), [{ status: 'Hämtar avgångar…' }]);
  await evaluate('departuresFailingSince = Date.now() - 3 * 60000 - 1000; renderDepartures()');
  assert.deepEqual(await busList(), [{ status: 'Kunde inte hämta buss- och tågavgångar (HTTP 429). Försöker igen…' }]);
  mocks.sl = DEFAULT_MOCKS.sl;
  await evaluate(`(() => { const s = document.getElementById('stopSelect'); s.value = '4632'; s.dispatchEvent(new Event('change')); })()`);
  assert.ok(await waitFor(`document.querySelectorAll('#busList .bus-line').length > 0`));
});

test('departures: a network error falls back to the CORS proxy; both failing gives both reasons', async () => {
  await resetFailures();
  mocks.sl = () => ({ fail: true });
  mocks.proxy = () => ok({ departures: [dep(5, '402', 'Via proxy')] });
  const before = countRequests('proxy');
  await refresh();
  assert.equal(countRequests('proxy'), before + 1);
  const proxied = requests.filter(r => r.key === 'proxy').at(-1).url;
  assert.equal(new URL(proxied).searchParams.get('url'), 'https://transport.integration.sl.se/v1/sites/4632/departures');
  assert.deepEqual(await lines(), ['402']);
  mocks.proxy = () => ({ status: 500, body: '' });
  await refresh();
  assert.match(await evaluate('departuresLastError'), /^Failed to fetch \/ proxy: HTTP 500 \(via proxy\)$/);
  mocks.sl = DEFAULT_MOCKS.sl;
  mocks.proxy = DEFAULT_MOCKS.proxy;
  await resetFailures();
  await refresh();
});

test('departures: a hidden page pauses fetching and resumes when shown again', async () => {
  const before = countRequests('sl');
  await evaluate(`Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); loadBuses()`);
  await sleep(200);
  assert.equal(countRequests('sl'), before, 'no request while hidden');
  assert.equal(await evaluate('departuresPaused'), true);
  await evaluate(`delete document.hidden; document.dispatchEvent(new Event('visibilitychange'))`);
  await sleep(300);
  assert.equal(countRequests('sl'), before + 1, 'fetched when shown again');
  assert.equal(await evaluate('departuresPaused'), false);
});

test('departures: the watchdog restarts a lost timer, but not while a fetch is running', async () => {
  await evaluate('clearTimeout(departuresTimer); departuresNextFetchAt = Date.now() - 31000');
  let before = countRequests('sl');
  await evaluate('departuresInFlight = 1; departuresWatchdog(); departuresInFlight = 0');
  await sleep(200);
  assert.equal(countRequests('sl'), before, 'nothing while a fetch is running');
  await evaluate('departuresNextFetchAt = Date.now() - 29000; departuresWatchdog()');
  await sleep(200);
  assert.equal(countRequests('sl'), before, 'nothing while less than 30 s overdue');
  await evaluate('departuresNextFetchAt = Date.now() - 31000; departuresWatchdog()');
  await sleep(300);
  assert.equal(countRequests('sl'), before + 1, 'restarted when more than 30 s overdue');
  assert.equal(await nextFetchIn(), 30);
});

// ---------- VMA demo mode (?vma=demo) ----------
test('VMA demo: ?vma=demo shows two TEST messages, Sickla first, with no real VMA active', async () => {
  mocks.vma = () => ok([]);
  await load(`${pageUrl}?vma=demo`);
  assert.ok(await waitFor(`document.getElementById('vmaBanner').classList.contains('visible')`), 'banner shown');
  const items = await vmaItems();
  assert.equal(items.length, 2);
  assert.deepEqual(items.map(i => i.label), ['🧪 TEST · Gäller Sickla', '🧪 TEST · Stockholms län']);
  assert.deepEqual(items.map(i => i.area), ['Område: Nacka kommun', 'Område: Norrtälje kommun']);
  for (const i of items) {
    assert.match(i.headline, /^TEST – /);
    assert.match(i.text, /inget riktigt VMA/);
    assert.match(i.time, /^Utfärdat .* · Kiosk Sickla \(demo\)$/);
  }
  assert.ok(countRequests('vma') > 0, 'real VMA are still fetched');
});

test('VMA demo: real messages come first, test messages from the API stay hidden', async () => {
  mocks.vma = () => ok([
    { Headline: 'Brand i Sickla', Published: '2026-11-01T07:00:00+01:00', Preamble: 'Gå inomhus.', Area: [vmaArea('Nacka kommun', polygon(SICKLA, 0.05))] },
    { Headline: 'Störning i dricksvattnet', Published: '2026-11-01T08:30:00+01:00', Area: [{ Description: 'Stockholms län' }] },
    { Headline: 'Test av VMA', IsTest: true, Published: '2026-11-01T09:00:00+01:00', Area: [vmaArea('Nacka kommun', polygon(SICKLA, 0.1))] },
    { Headline: 'Gasutsläpp i Göteborg', Published: '2026-11-01T09:00:00+01:00', Area: [vmaArea('Göteborgs kommun', polygon([11.97, 57.7], 0.2))] },
  ]);
  await evaluate('loadVma()');
  const items = await vmaItems();
  assert.deepEqual(items.map(i => i.label), ['📢 VMA · Gäller Sickla', '📢 VMA · Stockholms län', '🧪 TEST · Gäller Sickla', '🧪 TEST · Stockholms län']);
  assert.deepEqual(items.slice(0, 2).map(i => i.headline), ['Brand i Sickla', 'Störning i dricksvattnet']);
});

test('VMA demo: an error or an unexpected answer keeps the last real messages and the demo', async () => {
  mocks.vma = () => ({ status: 500, body: '{}' });
  await evaluate('loadVma()');
  assert.equal((await vmaItems()).length, 4, 'HTTP 500');
  mocks.vma = () => ok({ message: 'not a list' });
  await evaluate('loadVma()');
  assert.equal((await vmaItems()).length, 4, 'not a list');
  mocks.vma = () => ok([]);
  await evaluate('loadVma()');
  assert.deepEqual((await vmaItems()).map(i => i.label), ['🧪 TEST · Gäller Sickla', '🧪 TEST · Stockholms län'], 'an empty answer leaves only the demo');
});

test('VMA demo: the demo shows even when the first fetch fails', async () => {
  mocks.vma = () => ({ fail: true });
  await load(`${pageUrl}?vma=demo`);
  assert.ok(await waitFor(`document.querySelectorAll('#vmaBanner .vma-item').length === 2`), 'demo shown without any answer');
  mocks.vma = () => ok([]);
});

test('VMA demo: a reload for a new version ends the demo', async () => {
  await load(`${pageUrl}?vma=demo`);
  assert.ok(await waitFor(`document.querySelectorAll('#vmaBanner .vma-item').length === 2`));
  mocks.version = () => ok({ version: '99.0.0' });
  evaluate('checkForNewVersion()').catch(() => {}); // the context goes away during the reload
  assert.ok(await waitFor(`location.search === '?v=99.0.0' && document.readyState === 'complete'`), 'reloaded without ?vma=demo');
  mocks.version = DEFAULT_MOCKS.version;
  await sleep(300);
  assert.equal(await visible('vmaBanner'), false);
  assert.equal(await text('vmaBanner'), '');
});

test('VMA demo: only ?vma=demo starts it; without it or with another value there is no banner', async () => {
  for (const query of ['', '?vma=Demo', '?vma=1', '?vma=', '?demo=vma']) {
    await load(`${pageUrl}${query}`);
    await sleep(200);
    assert.equal(await visible('vmaBanner'), false, `no banner for "${query}"`);
    assert.equal(await evaluate('VMA_DEMO'), false, `no demo for "${query}"`);
  }
  await load(`${pageUrl}?v=1.0.0&vma=demo`);
  assert.equal(await evaluate('VMA_DEMO'), true, 'other parameters do not matter');
  await load();
});

// ---------- Whole page ----------
test('all requests to other hosts were answered by the mocks', () => {
  assert.deepEqual(unmocked, []);
});

test('no JavaScript exceptions on the page', () => {
  assert.deepEqual(exceptions, []);
});
