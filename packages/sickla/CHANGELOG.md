# Changelog — Sickla

All notable changes to the Sickla kiosk page. Versions follow `MAJOR.MINOR.PATCH`:
MAJOR for a reworked layout, MINOR for new features, PATCH for small fixes.
Each release is tagged `sickla-v<version>` in git.

## 1.5.0 — 2026-10-09

### Added
- The bathing-water card has a second side with the booking status of the two outdoor
  tennis courts of Sicklasjöns BK. Swipe the card left or right (or tap the dots under
  it) to turn it; it stays on the chosen side, also after a reload, until it is turned back.
- The tennis side shows the current week (Monday–Sunday) with one column per day and one
  row per hour; each cell is split into Bana 1 (left) and Bana 2 (right). Green = free,
  red = booked, grey = closed or already passed. The current hour is outlined.
  "Nästa vecka" shows the following week. No names of the people who booked are shown.
- The data is fetched only while the tennis side is shown, every 15 minutes (after an
  error, a new attempt after 2 minutes; the last good data stays on screen). It comes from
  a new Cloudflare Worker, `workers/sickla-tennis` (`https://tennis.petersandstrom.com/`),
  because the club's booking system (commodusnet.net) has no CORS headers and public
  CORS proxies could not reach it reliably.
- Automated tests in `tests/` (run with `node --test tests/*.test.mjs`): unit tests for the
  Worker against anonymised copies of the booking pages, and a headless-Chromium test of
  the tennis side (swipe, week buttons, colours, errors, no names on the page).

## 1.4.4 — 2026-10-06

### Changed
- The line-number badge in the departure list is slightly larger (font 0.95rem → 1.15rem,
  padding 4×10 px → 5×12 px, min width 38 px → 46 px) so the bus number is easier to
  read from a distance.

## 1.4.3 — 2026-09-28

### Changed
- When SL answers departures with a server error (HTTP 5xx), the page now retries
  every 60 seconds instead of backing off to as much as 5 minutes. Seen on the
  tablet: "Avgångarna har inte kunnat uppdateras sedan 15:20 (HTTP 500)" for about
  40 minutes while SL returned "Internal Server Error" for single stops; a longer
  wait does not help against a server error and only delays the list coming back.
  Quota errors (HTTP 429) and other failures back off as before (30 s → 5 min).

## 1.4.2 — 2026-09-27

### Fixed
- 1.4.1 broke the first data fetch of every panel on page load: `FETCH_TIMEOUT_MS`
  was defined after the panels had already started fetching, so the direct request
  failed with "Cannot access 'FETCH_TIMEOUT_MS' before initialization" and only the
  CORS proxy was tried. On the tablet the bathing card showed that error, and would
  have kept it for 12 hours. The constant is now defined at the top of the script.
- The bathing card now retries after 10 minutes when fetching fails, instead of
  waiting for the next 12-hour refresh.

### Changed
- The departures notice "Avgångarna har inte kunnat uppdateras sedan HH:MM" now
  also shows the last error, so the cause of a stall can be read off the screen.

## 1.4.1 — 2026-09-27

### Fixed
- Departures could stop updating for good (seen on the tablet: "Avgångarna har inte
  kunnat uppdateras sedan 22:37" still shown the next morning, fixed only by switching
  stop and back). Every network request now times out after 20 seconds instead of
  waiting forever, and a watchdog restarts departure fetching if the scheduled
  fetch is more than 30 seconds overdue — also covering a page that became visible
  again without a `visibilitychange` event.

## 1.4.0 — 2026-09-26

### Added
- The departures list can be filtered by tapping: the bus or tram icon in the title
  shows only buses or only trains/trams (TRAM, TRAIN, METRO); a line number shows only
  that line; a destination (e.g. "Slussen") shows only departures to it. Tapping the
  same thing again, or the "Visar bara …" chip above the list, removes the filter.
  One filter is active at a time, and it is remembered per stop across reloads.

### Changed
- Line numbers and destinations in the departures list are now HTML-escaped.

## 1.3.0 — 2026-09-26

### Added
- Precipitation radar for the next 2 hours in the weather card, shown only when rain
  or snow is expected in Sickla. Source: MET Norway nowcast 2.0 (radar-based,
  5-minute steps, no key), fetched every 5 minutes. A line of text says what is
  coming and when (e.g. "Lätt regn om ca 25 min", "Måttligt regn nu, upphör om ca
  40 min") and a small bar chart shows the intensity over the two hours. Rain,
  sleet or snow is inferred from the air temperature.

## 1.2.0 — 2026-09-26

### Added
- VMA (Viktigt meddelande till allmänheten) shown in a red banner at the top of the
  page. Source: Krisinformation.se API (`/v3/vmas`, Myndigheten för civilt försvar),
  fetched every 60 seconds, no key. Alerts covering Sickla are labelled
  "Gäller Sickla" and listed first; alerts elsewhere in Stockholm County are shown
  too, labelled "Stockholms län". Test messages are never shown.

## 1.1.2 — 2026-09-26

### Changed
- Minutes until departure are much larger (1.6rem, bold) so they can be read from a
  distance; "ca" and "min" are shown smaller next to the number.

## 1.1.1 — 2026-09-26

### Changed
- The bathing-water detail panel is taller: it now reaches over most of the
  departures card (85 % of its height, at least 240 px) instead of about half.
- Departures title reads "Nästa avgång" instead of "Nästa buss/tåg".
- Hidden pages (e.g. background browser tabs) pause fetching departures and resume
  immediately when shown again, to spare SL's request quota. Visible pages, such as
  the tablet, still fetch every 30 seconds.

## 1.1.0 — 2026-09-26

### Added
- Tapping the Sickla strandbad card opens a detail panel with all of this year's
  bathing-water samples: assessment, date, water temperature, E. coli and intestinal
  enterococci (value and assessment), algal bloom and weather at sampling. The header
  shows bathing season, bloom risk, the last four EU classifications, active
  advisories and the limits for "Otjänligt". Closes on ✕, a tap outside, Escape,
  or automatically after 2 minutes.
- Sample date shown next to the bathing-water temperature, so an old sample is not
  read as today's temperature.
- Version number in the footer (`v1.1.0`).
- Automatic reload: the page checks `version.json` every 10 minutes and reloads when
  a new version has been published.

### Changed
- Quality badges in the bathing card are aligned in a grid.
- Month written in lower case in the date ("Lördag 26 september").
- Stop picker: the arrow sits directly after the selected stop name.
- Departures title uses bus and tram icons instead of emoji.
- Text from the bathing-water API in the detail panel is HTML-escaped.

### Fixed
- Departures no longer disappear on a single failed request (e.g. HTTP 429 or SL's
  "Quota has been exceeded" reply). The last list stays on screen and keeps counting
  down; retries back off from 30 s up to 5 minutes. A notice appears only after
  3 minutes without a successful update.
- HTTP error replies are no longer retried through the CORS proxy.

## 1.0.0 — 2026-09-26

First versioned release, assigned retroactively to commit `b09f431`.

- Date and time.
- SMHI weather warnings filtered to Sickla's coordinate.
- SMHI weather: current conditions and forecast for 09, 13, 17 and 21.
- Sickla strandbad bathing water: advisories, water temperature, latest two samples,
  EU classification.
- Next departures (bus, tram, train, metro) with a stop picker for 14 stops around
  Sickla, realtime indicator and deviations.
- Footer and messages say "buss/tåg" instead of only buses.
