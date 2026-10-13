# Nemo Plotlight companion helper

Copy this folder to `SillyTavern/plugins/nemo-plotlight`, enable `enableServerPlugins: true` in ST's `config.yaml`, and restart ST.

The frontend is installed separately from the repository root through ST's extension manager. It calls these same-origin read-only routes:

- `/api/plugins/nemo-plotlight/stats/{uuid}` — public rating and community-star totals.
- `/api/plugins/nemo-plotlight/persona/{uuid}` — public persona definition when a native export returns 404.
- `/api/plugins/nemo-plotlight/image/{uuid}` — only Plotlight's fixed `/api/published-media/{uuid}/thumb` raster endpoint.

Requests omit remote credentials and reject redirects. Metadata successes are cached for five minutes; image responses use private browser caching and no server image cache. All jobs share concurrency/queue limits and upstream rate-limit cooldowns. Images are limited to 5 MB, safe raster types and matching signatures. The helper has no package dependencies.

Update this separate installed folder whenever the browser extension is updated. Code uses the repository's AGPL v3 license.
