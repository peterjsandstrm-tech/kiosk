# Sickla

Kiosk info board for Sickla — wall-mounted tablet display showing VMA public alerts (Stockholm County), date/time, weather, weather warnings, bathing-water quality at Sickla strandbad, and next departures from the Sickla stop.

Live: https://peterjsandstrm-tech.github.io/kiosk/packages/sickla/

## Versioning

The page carries a version number (`MAJOR.MINOR.PATCH`), shown in the footer. See [CHANGELOG.md](CHANGELOG.md).

To release a new version:

1. Bump `APP_VERSION` in `index.html` and `version` in `version.json` to the same value.
2. Add a section to `CHANGELOG.md`.
3. Commit, tag `sickla-v<version>`, and push the commit and the tag.

Open pages check `version.json` every 10 minutes and reload themselves when the version changes, so the tablet picks up a new release without manual reload.
