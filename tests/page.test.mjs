// Browser test of the Sickla page (packages/sickla/index.html) in headless
// Chromium, driven over the DevTools protocol (no npm dependencies).
// Covers the tennis side of the bathing card: swipe, week buttons, colours,
// errors. The tennis API is served locally from the saved booking pages in
// tests/fixtures; the page's other sources (SMHI, SL, …) are still live.
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
const { parseDayPage } = await import('../workers/sickla-tennis/src/index.js');
const CHROME = process.env.CHROME || 'chromium-browser';
const W = 800, H = 1280; // the Galaxy Tab in portrait, roughly
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const pad = (n) => String(n).padStart(2, '0');
const isoDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// ---------- Mock tennis API built from the fixtures, relative to today ----------
const fixtureDay = (name) => parseDayPage(fs.readFileSync(path.join(here, 'fixtures', `commodus-${name}.html`)).toString('latin1'));
const FIXTURES = { today: fixtureDay('2026-10-09'), plain: fixtureDay('2026-10-10'), busy: fixtureDay('2026-10-15') };

function mockWeek(offset) {
  const now = new Date();
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7) + 7 * offset);
  const today = isoDate(now);
  const days = Array.from({ length: 7 }, (_, i) => {
    const date = isoDate(new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i));
    if (date < today) return { date, past: true };
    const src = date === today ? FIXTURES.today : i === 3 ? FIXTURES.busy : FIXTURES.plain;
    return { date, slots: src.slots };
  });
  return { week: 41 + offset, weekStart: days[0].date, today, fetchedAt: now.toISOString(), courts: FIXTURES.plain.courts, hours: Object.keys(FIXTURES.plain.slots).sort(), days };
}

let tennisMode = 'ok';
let tennisRequests = 0;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/tennis/') {
    tennisRequests += 1;
    const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    if (tennisMode === 'fail') { res.writeHead(502, headers); res.end('{"error":"HTTP 503 from the booking system"}'); return; }
    res.writeHead(200, headers);
    res.end(JSON.stringify(mockWeek(Number(url.searchParams.get('week') || 0))));
    return;
  }
  if (url.pathname === '/' || url.pathname === '/index.html') {
    const port = server.address().port;
    const html = fs.readFileSync(path.join(pageDir, 'index.html'), 'utf8')
      .replace("'https://tennis.petersandstrom.com/'", `'http://localhost:${port}/tennis/'`);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }
  if (url.pathname === '/version.json') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(fs.readFileSync(path.join(pageDir, 'version.json')));
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
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(`evaluate failed: ${expression}`);
  return r.result.value;
};
const waitFor = async (expression, ms = 10000) => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await evaluate(expression)) return true;
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
const swipe = async (dxFraction) => {
  const b = await box('#clockCard');
  const x0 = b.x + b.w * (dxFraction < 0 ? 0.8 : 0.2);
  const y = b.y + b.h / 2;
  await touch(Array.from({ length: 9 }, (_, i) => [x0 + b.w * dxFraction * i / 8, y + i]));
  await sleep(450); // the flip animation swaps sides after 150 ms
};
const load = async () => {
  await send('Page.navigate', { url: pageUrl });
  assert.ok(await waitFor(`document.readyState === 'complete' && !!document.getElementById('clockCard')`), 'page loads');
  await sleep(300);
};
const face = () => evaluate(`document.getElementById('faceBathing').hidden ? 'tennis' : 'bathing'`);
const overlayOpen = () => evaluate(`document.getElementById('bathingOverlay').classList.contains('visible')`);

before(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  pageUrl = `http://localhost:${server.address().port}/`;
  // A fresh profile per run, so no saved card side leaks between runs. The
  // DevTools port is chosen here: a snap-packaged Chromium has its own /tmp,
  // so its DevToolsActivePort file cannot be read from outside.
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sickla-test-'));
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
    if (m.method === 'Runtime.exceptionThrown') exceptions.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  };
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: true });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await load();
});

after(() => {
  ws?.close();
  chrome?.kill();
  server.close();
  // Chromium may still be writing to its profile for a moment
  setTimeout(() => fs.rmSync(profileDir, { recursive: true, force: true }), 500).unref();
});

// The tests share one page and run in order.

test('page starts on the bathing side with the first dot active', async () => {
  assert.equal(await face(), 'bathing');
  assert.equal(await evaluate(`document.querySelector('.card-dots span.active').dataset.face`), 'bathing');
});

test('tapping the bathing side opens the sample panel', async () => {
  await tap('#clockCard');
  assert.equal(await overlayOpen(), true);
  await evaluate('closeBathingOverlay()');
});

test('swiping left turns the card to tennis without opening the panel', async () => {
  await swipe(-0.6);
  assert.equal(await face(), 'tennis');
  assert.equal(await overlayOpen(), false);
  assert.equal(await evaluate(`document.querySelector('.card-dots span.active').dataset.face`), 'tennis');
});

test('tennis grid: 7 days, B1/B2 headings, one cell per hour and day', async () => {
  assert.ok(await waitFor(`document.querySelectorAll('#tennisGrid .tennis-cell').length > 0`), 'grid is filled');
  const info = await evaluate(`({
    days: [...document.querySelectorAll('.tennis-day')].map(d => d.textContent),
    courts: [...document.querySelectorAll('.tennis-courts')].map(d => d.textContent),
    cells: document.querySelectorAll('.tennis-cell').length,
    hours: [...document.querySelectorAll('.tennis-hour')].map(h => h.textContent),
    barsPerCell: document.querySelector('.tennis-cell').children.length,
    today: document.querySelectorAll('.tennis-day.today').length,
  })`);
  assert.deepEqual(info.days.map(d => d.slice(0, 3)), ['Mån', 'Tis', 'Ons', 'Tor', 'Fre', 'Lör', 'Sön']);
  assert.deepEqual(info.courts, Array(7).fill('B1B2'));
  assert.deepEqual(info.hours, ['08', '09', '10', '11', '12', '13', '14', '15', '16', '17', '18', '19', '20']);
  assert.equal(info.cells, 13 * 7);
  assert.equal(info.barsPerCell, 2);
  assert.equal(info.today, 1);
});

test('tennis grid: colours follow the slot states, passed days are grey', async () => {
  const weekday = (new Date().getDay() + 6) % 7; // 0 = Monday
  const counts = await evaluate(`(() => {
    const cells = [...document.querySelectorAll('.tennis-cell')];
    const byDay = (d) => cells.filter((_, i) => i % 7 === d);
    return {
      pastDayBars: Array.from({ length: ${weekday} }, (_, d) => byDay(d).flatMap(c => [...c.children]).every(i => i.className === 'past')),
      free: document.querySelectorAll('.tennis-cell i.free').length,
      booked: document.querySelectorAll('.tennis-cell i.booked').length,
    };
  })()`);
  assert.ok(counts.pastDayBars.every(Boolean), 'all days before today are grey');
  assert.ok(counts.free > 0, 'some green');
  if (weekday < 5) assert.ok(counts.booked > 0, 'some red (the Saturday fixture has a booking)');
  const colours = await evaluate(`(() => {
    const c = (sel) => { const el = document.querySelector(sel); return el && getComputedStyle(el).backgroundColor; };
    return { free: c('.tennis-swatch.free'), booked: c('.tennis-swatch.booked') };
  })()`);
  assert.equal(colours.free, 'rgb(52, 199, 89)');
  assert.equal(colours.booked, 'rgb(255, 69, 58)');
});

test('day separators sit only beside the booking cells', async () => {
  const borders = await evaluate(`({
    cell: getComputedStyle(document.querySelector('.tennis-cell')).borderLeftColor,
    day: getComputedStyle(document.querySelector('.tennis-day')).borderLeftColor,
    rowGap: getComputedStyle(document.getElementById('tennisGrid')).rowGap,
  })`);
  assert.equal(borders.cell, 'rgb(42, 49, 64)');
  assert.equal(borders.day, 'rgba(0, 0, 0, 0)');
  assert.equal(borders.rowGap, '0px'); // solid line from top to bottom
});

test('weather card: the rain radar sits at the bottom when the card is taller', async () => {
  // The tennis side makes the top row taller than the weather content
  const geometry = () => evaluate(`(() => {
    const card = document.querySelector('.weather-card').getBoundingClientRect();
    const top = document.querySelector('.weather-card .temp-row').getBoundingClientRect();
    const nowcast = document.getElementById('nowcast').getBoundingClientRect();
    const forecast = document.getElementById('forecastRow').getBoundingClientRect();
    return { cardTop: card.top, cardBottom: card.bottom, topRow: top.top, forecastBottom: forecast.bottom, nowcastBottom: nowcast.bottom };
  })()`);
  await evaluate(`document.getElementById('nowcast').classList.add('visible')`);
  let g = await geometry();
  assert.ok(g.cardBottom - g.nowcastBottom <= 30, `radar at the bottom edge (gap ${g.cardBottom - g.nowcastBottom}px)`);
  await evaluate(`document.getElementById('nowcast').classList.remove('visible')`);
  g = await geometry();
  const above = g.topRow - g.cardTop, below = g.cardBottom - g.forecastBottom;
  assert.ok(Math.abs(above - below) <= 4, `without radar the content is centred (${above}px above, ${below}px below)`);
});

test('rain radar text never breaks between a number and its unit', async () => {
  // Steady moderate rain for the next 2 hours gives the longest text
  const result = await evaluate(`(() => {
    const now = Date.now();
    nowcastData = { temp: 8, points: Array.from({ length: 25 }, (_, i) => ({ time: now + i * 5 * 60000, rate: 2 })) };
    renderNowcast();
    const el = document.getElementById('nowcastText');
    const keep = el.querySelector('.nowcast-keep');
    if (!keep) return { text: el.textContent };
    const lineCount = (node) => {
      const range = document.createRange();
      range.selectNodeContents(node);
      return new Set([...range.getClientRects()].map(r => Math.round(r.top))).size;
    };
    return { text: el.textContent, keep: keep.textContent, keepLines: lineCount(keep), totalLines: lineCount(el) };
  })()`);
  assert.match(result.text, /^\S+ regn nu, fortsätter närmaste 2\u00a0h$/);
  assert.equal(result.keep, 'fortsätter närmaste 2\u00a0h', 'second half kept together');
  assert.equal(result.keepLines, 1, '"fortsätter närmaste 2 h" is on one line');
  assert.ok(result.totalLines <= 2, 'at most two lines, broken after the comma');
  await evaluate(`nowcastData = null; renderNowcast()`);
});

test('no names of people who booked appear on the page', async () => {
  assert.equal(await evaluate(`/Anonym|Kontrakt/.test(document.body.innerHTML)`), false);
});

test('tapping the tennis side does not open the bathing panel', async () => {
  await tap('#tennisGrid');
  assert.equal(await overlayOpen(), false);
  assert.equal(await face(), 'tennis');
});

test('"Nästa vecka" shows the following week', async () => {
  await tap('.tennis-week[data-week="1"]');
  assert.ok(await waitFor(`/Vecka 42/.test(document.getElementById('tennisStatus').textContent)`), 'status shows week 42');
  assert.equal(await evaluate(`document.querySelector('.tennis-week.active').dataset.week`), '1');
  assert.equal(await evaluate(`document.querySelectorAll('.tennis-cell i.past').length`), 0, 'nothing has passed next week');
  await tap('.tennis-week[data-week="0"]');
  assert.ok(await waitFor(`/Vecka 41/.test(document.getElementById('tennisStatus').textContent)`));
});

test('the tennis side survives a reload', async () => {
  await load();
  assert.equal(await face(), 'tennis');
  assert.ok(await waitFor(`document.querySelectorAll('#tennisGrid .tennis-cell').length > 0`));
});

test('a failed refresh keeps the last data and says so', async () => {
  tennisMode = 'fail';
  const before = tennisRequests;
  await evaluate(`tennisState[tennisWeek].attemptAt = 0; tennisTick()`);
  assert.ok(await waitFor(`/kunde inte uppdatera/.test(document.getElementById('tennisStatus').textContent)`), 'warning in status');
  assert.ok(tennisRequests > before, 'a new request was made');
  assert.ok(await evaluate(`document.querySelectorAll('#tennisGrid .tennis-cell').length > 0`), 'grid still shown');
});

test('without any data, an error message is shown', async () => {
  await load();
  assert.ok(await waitFor(`/Kunde inte hämta bokningar/.test(document.getElementById('tennisGrid').textContent)`));
  tennisMode = 'ok';
});

test('swiping right turns back to bathing; a vertical drag does nothing', async () => {
  await swipe(0.6);
  assert.equal(await face(), 'bathing');
  const b = await box('#clockCard');
  await touch([[b.x + b.w / 2, b.y + b.h / 2 - 20], [b.x + b.w / 2 + 10, b.y + b.h / 2 + 40]]);
  await sleep(450);
  assert.equal(await face(), 'bathing');
});

test('tapping the dots turns the card', async () => {
  await tap('.card-dots span[data-face="tennis"]');
  await sleep(300);
  assert.equal(await face(), 'tennis');
  await tap('.card-dots span[data-face="bathing"]');
  await sleep(300);
  assert.equal(await face(), 'bathing');
});

test('no JavaScript exceptions on the page', () => {
  assert.deepEqual(exceptions, []);
});
