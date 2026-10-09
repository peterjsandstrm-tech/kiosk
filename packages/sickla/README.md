# Sickla

Kiosk info board for Sickla — wall-mounted tablet display showing VMA public alerts (Stockholm County), date/time, weather, precipitation radar for the next 2 hours, weather warnings, bathing-water quality at Sickla strandbad (swipe the card sideways to see this and next week's booking status for the two tennis courts of Sicklasjöns BK), and next departures from the Sickla stop (filterable by mode, line or destination with a tap).

Live: https://peterjsandstrm-tech.github.io/kiosk/packages/sickla/

## Versioning

The page carries a version number (`MAJOR.MINOR.PATCH`), shown in the footer. See [CHANGELOG.md](CHANGELOG.md).

To release a new version:

1. Bump `APP_VERSION` in `index.html` and `version` in `version.json` to the same value.
2. Add a section to `CHANGELOG.md`.
3. Run the tests from the repository root: `node --test tests/*.test.mjs` (see [tests/README.md](../../tests/README.md)); all must pass.
4. Commit, tag `sickla-v<version>`, and push the commit and the tag.

The tennis booking status comes from the Cloudflare Worker in [`workers/sickla-tennis`](../../workers/sickla-tennis/) (`https://tennis.petersandstrom.com/`), since the club's booking system has no CORS headers.

Open pages check `version.json` every 10 minutes and reload themselves when the version changes, so the tablet picks up a new release without manual reload.
