# Tests

Run before every commit, from the repository root:

```sh
node --test tests/*.test.mjs
```

Needs Node 22 or later and a Chromium (`chromium-browser` on the PATH, or set `CHROME=/path/to/chromium`). No npm packages.

- `worker.test.mjs` — the tennis Worker (`workers/sickla-tennis`): parsing of the booking pages, week dates, caching, error handling, and that no names are passed on. Uses the saved pages in `fixtures/`; no network.
- `page.test.mjs` — the Sickla page in headless Chromium (touch emulation, 800×1280): turning the bathing card through its three sides by swiping and with the dots; the tennis side (week buttons, colours, day separators, errors); the ski-track side (default facility, list order, grooming headline, track lines, notice, errors, remembered choice); the rain radar's position and line breaks; reload; no JavaScript exceptions. The tennis and Skidspår.se APIs are served locally from the fixtures; the page's other sources (SMHI, SL, Havs- och vattenmyndigheten, Krisinformation, MET Norway) are still fetched live and are not yet covered by tests.

`fixtures/commodus-*.html` are copies of the club's day pages from 2026-10-09, -10 and -15, anonymised: booked names replaced with "Anonym Bokning", booker ids removed. One contract booking (blue, "Kontrakt Anonym", 2026-10-15 08:00 Bana 1) was added by hand because none existed in the captured data.

`fixtures/skidspar-facility-*.json` are answers from `https://api.skidspar.se/facility/<id>` captured 2026-10-09 (off-season, all statuses "unknown") for Saltsjöbadens Skidarena (1655), Ågesta (18) and Hellasgården (48), with map geometry and images removed. `skidspar-facility-1655-groomed.json` is the Saltsjöbaden answer edited by hand into an in-season state (classic groomed today, 5.2 h ago, rated 4 = "Riktigt bra"; skate yesterday, 30 h, 3.5 = "Bra").
