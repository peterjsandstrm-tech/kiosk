# Tests

Run before every commit, from the repository root:

```sh
node --test tests/*.test.mjs
```

Needs Node 22 or later and a Chromium (`chromium-browser` on the PATH, or set `CHROME=/path/to/chromium`). No npm packages.

- `worker.test.mjs` — the tennis Worker (`workers/sickla-tennis`): parsing of the booking pages, week dates, caching, error handling, and that no names are passed on. Uses the saved pages in `fixtures/`; no network.
- `page.test.mjs` — the Sickla page in headless Chromium (touch emulation, 800×1280): turning the bathing card to the tennis side by swiping, week buttons, colours, day separators, reload, error states, no JavaScript exceptions. The tennis API is served locally from the fixtures; the page's other sources (SMHI, SL, Havs- och vattenmyndigheten, Krisinformation, MET Norway) are still fetched live and are not yet covered by tests.

`fixtures/commodus-*.html` are copies of the club's day pages from 2026-10-09, -10 and -15, anonymised: booked names replaced with "Anonym Bokning", booker ids removed. One contract booking (blue, "Kontrakt Anonym", 2026-10-15 08:00 Bana 1) was added by hand because none existed in the captured data.
