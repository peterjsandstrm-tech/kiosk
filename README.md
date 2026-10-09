# kiosk

Monorepo for wall-mounted kiosk info-board pages. Each location lives under `packages/<name>/`.

## Packages

- [`packages/sickla`](packages/sickla/) — Sickla stop info board (VMA public alerts, date/time, weather, precipitation radar, weather warnings, bathing-water quality at Sickla strandbad, tennis-court booking status, next departures)

## Tests

`node --test tests/*.test.mjs` from the repository root — see [`tests/`](tests/).

## Workers

- [`workers/sickla-tennis`](workers/sickla-tennis/) — Cloudflare Worker that serves the tennis-court booking status for the Sickla page as JSON
