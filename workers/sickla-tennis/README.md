# sickla-tennis

Cloudflare Worker that serves the booking status of the two outdoor tennis courts of
Sicklasjöns BK as JSON for the Sickla kiosk page (`packages/sickla/index.html`).

The club's booking system (`https://www.commodusnet.net/kund/adminschedule.php?sess_adm_club_id=59&YEAR=…&MONTH=…&DAY=…`)
publishes one HTML page per day and sends no CORS headers, so the kiosk page cannot read it
directly. The Worker fetches the day pages, reduces every slot to a state and answers with CORS.

## API

`GET https://tennis.petersandstrom.com/?week=0` (current week) or `?week=1` (next week):

```json
{
  "week": 41, "weekStart": "2026-10-05", "today": "2026-10-09",
  "fetchedAt": "2026-10-09T13:57:00.000Z",
  "courts": ["Bana 1", "Bana 2"],
  "hours": ["08", "09", "…", "20"],
  "days": [
    { "date": "2026-10-05", "past": true },
    { "date": "2026-10-09", "slots": { "15": ["free", "free"], "18": ["closed", "closed"] } },
    { "date": "2026-10-10", "error": "timeout" }
  ]
}
```

Slot states: `free` ("Boka"), `booked` (a name, single booking or contract), `closed`
("Stängt"), `past` ("Ej Bokningsbar" — the hour has passed). Names are never passed on.

## Load on the booking system

Each day page is cached for 15 minutes (Cache API) and days before today are not fetched,
so the booking system sees at most 7 requests per quarter hour and week, regardless of how
many clients ask. Requests carry the User-Agent `SicklaKiosk/1.0 (+repo URL)`.

## Deploy

Requires the Cloudflare account that holds the `petersandstrom.com` zone.

```sh
cd workers/sickla-tennis
npx wrangler login     # once, opens the browser
npx wrangler deploy    # creates the Worker and the custom domain tennis.petersandstrom.com
curl -s 'https://tennis.petersandstrom.com/?week=0' | head -c 400
```
