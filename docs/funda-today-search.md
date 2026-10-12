# Funda search: today

The monitor uses the agreed Funda URL directly:
https://www.funda.nl/zoeken/huur?selected_area=groningen&radius_search=30&price=0-1500&publication_date=1

Funda owns geographic, advertised-rent and publication filtering. The collector
reads that filtered result set and does not repeat distance, rent-limit or 72-hour
checks in detail pages. It still validates search completeness, pagination and
page structure, rejects human-check pages, excludes unavailable/non-housing items,
and extracts title, city and rent for Telegram. Coordinates are no longer required.
Publication dates are optional display metadata, never replaced by discovery time.

Today means the site's publication_date=1 filter, as specified by the user. The
scheduler runs every 15 minutes. After downtime spanning midnight, yesterday's
listings can be missed; no three-day catch-up was requested.

The historical source ID is intentionally retained to preserve its baseline and
outbox deduplication. The profile records the new filters and the v2-today scenario
schedules one immediate check when the application switches to this recipe. Both
browser collection and mobile recovery navigation import the same SEARCH_URL.

This supersedes the geographic/72-hour filtering described in earlier Funda docs.
