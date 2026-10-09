// Cloudflare Worker: booking status for the two outdoor tennis courts at
// Sicklasjöns BK, for the Sickla kiosk page (packages/sickla/index.html).
//
// The club's booking system (commodusnet.net) has one public HTML page per
// day and no CORS headers, so the kiosk page cannot read it directly. This
// Worker fetches the day pages for a week, reduces each slot to a state
// (free / booked / closed / past) and answers with JSON and CORS.
// Names of the people who booked are never passed on.
//
// GET /?week=0  -> the current week (Monday–Sunday, Europe/Stockholm)
// GET /?week=1  -> next week
//
// Each day page is cached for 15 minutes and days that have passed are not
// fetched at all, so the club's server sees at most 7 requests per quarter
// hour and week, however many kiosks ask.

const CLUB_ID = 59;
const SCHEDULE_URL = 'https://www.commodusnet.net/kund/adminschedule.php';
const CACHE_SECONDS = 15 * 60;
const FETCH_TIMEOUT_MS = 10 * 1000;
const TIME_ZONE = 'Europe/Stockholm';
const USER_AGENT = 'SicklaKiosk/1.0 (+https://github.com/peterjsandstrm-tech/kiosk)';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

// ---------- Dates (all as 'YYYY-MM-DD' in Stockholm time) ----------

function todayInStockholm(now = new Date()) {
  // sv-SE formats dates as YYYY-MM-DD
  return new Intl.DateTimeFormat('sv-SE', { timeZone: TIME_ZONE }).format(now);
}

function parseDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(iso, days) {
  const date = parseDate(iso);
  date.setUTCDate(date.getUTCDate() + days);
  return formatDate(date);
}

function mondayOf(iso) {
  const weekday = (parseDate(iso).getUTCDay() + 6) % 7; // 0 = Monday
  return addDays(iso, -weekday);
}

function isoWeekNumber(iso) {
  // The ISO week belongs to the year of its Thursday
  const thursday = parseDate(addDays(mondayOf(iso), 3));
  const yearStart = Date.UTC(thursday.getUTCFullYear(), 0, 1);
  return Math.floor((thursday - yearStart) / 86400000 / 7) + 1;
}

// ---------- Parsing a day page ----------

// The page is ISO-8859-1, but only ASCII is used from it: "Boka", "Ej
// Bokningsbar", the colour codes and "Bana N". The built-in UTF-8 decoder
// turns the odd non-ASCII byte (as in "Stängt") into U+FFFD and is about ten
// times faster than decoding byte by byte in JavaScript, which used more than
// half of the free plan's 10 ms CPU time per request.
const decoder = new TextDecoder();

// Cell text is "Boka" (free), "Ej Bokningsbar" (time has passed or cannot be
// booked), "Stängt" on a red background (closed) or the booker's name on a
// yellow (single booking) or blue (contract) background.
function classifyCell(attributes, inner) {
  const text = inner.replace(/<[^>]+>/g, '').trim();
  if (text === 'Boka') return 'free';
  if (/Ej Bokningsbar/i.test(text)) return 'past';
  if (/ffa6a6/i.test(attributes)) return 'closed';
  return 'booked';
}

function parseDayPage(html) {
  const courts = [];
  for (const m of html.matchAll(/class="text_middle_bana"><B>([^<]+)<\/B>/gi)) {
    const name = m[1].trim();
    if (!courts.includes(name)) courts.push(name);
  }
  if (courts.length === 0) throw new Error('no courts found on the page');

  // The schedule table occurs twice in the page; stop at the first repeated hour
  const slots = {};
  for (const m of html.matchAll(/<B>(\d\d):\d\d-\d\d:\d\d<\/TH>([\s\S]*?)<\/TR>/gi)) {
    const hour = m[1];
    if (slots[hour]) break;
    const cells = [...m[2].matchAll(/<TD([^>]*)>([\s\S]*?)<\/TD>/gi)].slice(0, courts.length);
    if (cells.length < courts.length) continue;
    slots[hour] = cells.map(c => classifyCell(c[1], c[2]));
  }
  if (Object.keys(slots).length === 0) throw new Error('no time slots found on the page');
  return { courts, slots };
}

// ---------- Fetching ----------

async function fetchDay(iso, ctx) {
  const [y, m, d] = iso.split('-').map(Number);
  const url = `${SCHEDULE_URL}?sess_adm_club_id=${CLUB_ID}&YEAR=${y}&MONTH=${m}&DAY=${d}`;
  const cacheKey = new Request(`https://sickla-tennis.cache/day/${iso}`);
  const cache = caches.default;

  const cached = await cache.match(cacheKey);
  if (cached) return cached.json();

  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from the booking system`);
  const day = { date: iso, ...parseDayPage(decoder.decode(await res.arrayBuffer())) };

  const toCache = new Response(JSON.stringify(day), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${CACHE_SECONDS}` },
  });
  ctx.waitUntil(cache.put(cacheKey, toCache));
  return day;
}

async function buildWeek(weekOffset, ctx, now = new Date()) {
  const today = todayInStockholm(now);
  const monday = addDays(mondayOf(today), 7 * weekOffset);
  const dates = Array.from({ length: 7 }, (_, i) => addDays(monday, i));

  const days = await Promise.all(dates.map(async (iso) => {
    if (iso < today) return { date: iso, past: true };
    try {
      return await fetchDay(iso, ctx);
    } catch (e) {
      return { date: iso, error: e.name === 'TimeoutError' ? 'timeout' : e.message };
    }
  }));

  const courts = days.find(d => d.courts)?.courts || ['Bana 1', 'Bana 2'];
  const hours = [...new Set(days.flatMap(d => Object.keys(d.slots || {})))].sort();
  return {
    week: isoWeekNumber(monday),
    weekStart: monday,
    today,
    fetchedAt: now.toISOString(),
    courts,
    hours,
    days: days.map(({ courts: _, ...rest }) => rest),
  };
}

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS, ...extra },
  });
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });
    if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405);

    const week = new URL(request.url).searchParams.get('week') || '0';
    if (week !== '0' && week !== '1') return json({ error: 'week must be 0 or 1' }, 400);

    const body = await buildWeek(Number(week), ctx);
    if (body.days.every(d => d.error)) return json({ error: body.days[0].error, ...body }, 502);
    return json(body, 200, { 'Cache-Control': 'no-store' });
  },
};

export { parseDayPage, buildWeek, mondayOf, isoWeekNumber, todayInStockholm };
