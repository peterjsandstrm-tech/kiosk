# Changelog — Sickla

All notable changes to the Sickla kiosk page. Versions follow `MAJOR.MINOR.PATCH`:
MAJOR for a reworked layout, MINOR for new features, PATCH for small fixes.
Each release is tagged `sickla-v<version>` in git.

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
