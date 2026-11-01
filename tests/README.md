# Tests

Run before every commit, from the repository root:

```sh
node --test tests/*.test.mjs
```

Needs Node 22 or later and a Chromium (`chromium-browser` on the PATH, or set `CHROME=/path/to/chromium`). No npm packages.

- `worker.test.mjs` — the tennis Worker (`workers/sickla-tennis`): parsing of the booking pages, week dates, caching, error handling, and that no names are passed on. Uses the saved pages in `fixtures/`; no network.
- `page.test.mjs` — the Sickla page in headless Chromium (touch emulation, 800×1280): turning the bathing card through its three sides by swiping and with the dots; the tennis side (week buttons, colours, day separators, errors); the ski-track side (default facility, list order, grooming headline, track lines, notice, errors, remembered choice); the rain radar's position and line breaks; reload; no JavaScript exceptions. The tennis and Skidspår.se APIs are served locally from the fixtures; the page's other sources are fetched live in this file but not checked here (see `panels.test.mjs`).
- `panels.test.mjs` — the panels that existed before 1.5.0, in headless Chromium with no live network: every request to another host is intercepted over the DevTools protocol (`Fetch` domain) and answered from mocks built in the test, and the last tests fail if any request was not mocked. Covers the version check and reload guard (and that `APP_VERSION`, `version.json`, the footer and `CHANGELOG.md` agree); the clock; the VMA banner (Sickla before the rest of the county, test messages and other counties left out, defaults, escaping, errors); SMHI warnings (banner colour, start time, holes, MultiPolygon, the exact 24-hour edge, unknown levels); weather and the four forecast times; the rain radar (thresholds 0.1/1/4 mm/h, rain/sleet/snow by temperature, bar heights, stale data); the bathing card and sample panel (unfit samples, advisories, no data, errors and retry, year selection, escaping); and the departures (window and modes, "Nu"/"Avgick"/"ca", deviations in every format, line/destination/mode filters saved per stop, stop picker, late answers for a previous stop, the 429 backoff 30→300 s, 5xx retry every 60 s, quota errors with HTTP 200, the 3-minute notice, the CORS-proxy fallback, hidden pages and the watchdog).

`fixtures/commodus-*.html` are copies of the club's day pages from 2026-10-09, -10 and -15, anonymised: booked names replaced with "Anonym Bokning", booker ids removed. One contract booking (blue, "Kontrakt Anonym", 2026-10-15 08:00 Bana 1) was added by hand because none existed in the captured data.

`fixtures/skidspar-facility-*.json` are answers from `https://api.skidspar.se/facility/<id>` captured 2026-10-09 (off-season, all statuses "unknown") for Saltsjöbadens Skidarena (1655), Ågesta (18) and Hellasgården (48), with map geometry and images removed. `skidspar-facility-1655-groomed.json` is the Saltsjöbaden answer edited by hand into an in-season state (classic groomed today, 5.2 h ago, rated 4 = "Riktigt bra"; skate yesterday, 30 h, 3.5 = "Bra").
