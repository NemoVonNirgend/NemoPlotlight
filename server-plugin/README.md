# Nemo Plotlight companion helper

Install this helper for published-image previews, character ratings/roses, and the persona-download fallback. The extension manager installs the browser extension only; the helper needs these separate steps. No npm install or build step is needed.

## Find this folder

This README and `index.mjs` are inside the extension's `server-plugin` folder. In your SillyTavern installation, the usual location is:

- Per-user installation: `SillyTavern/data/default-user/extensions/NemoPlotlight/server-plugin` (replace `default-user` with your ST user handle; a custom data directory may differ).
- Global installation: `SillyTavern/public/scripts/extensions/third-party/NemoPlotlight/server-plugin`.

If you renamed the extension folder, use that name instead of `NemoPlotlight`.

The setup toast and **Helper setup** link open this README in your browser. Browsers cannot open a folder on the ST server in Explorer or Finder. Open your SillyTavern installation with your file manager and follow the path above. If ST runs on another computer, a hosted server, or in a container, these steps must be performed on that installation by someone with access to its files and configuration.

## Install

1. Copy this entire `server-plugin` folder into `SillyTavern/plugins/` and rename the copied folder to `nemo-plotlight`. Create `plugins` if it does not exist.
2. Check that the resulting file is **`SillyTavern/plugins/nemo-plotlight/index.mjs`**. It must not be nested inside an extra `server-plugin` folder.
3. Open `SillyTavern/config.yaml` in a text editor. Find the top-level `enableServerPlugins` setting and change it to:

   ```yaml
   enableServerPlugins: true
   ```

   If the setting is absent, add it at the top level with no indentation. Save the file.
4. Stop and restart the SillyTavern server, then reload the browser page. Refreshing the browser alone does not load server plugins.

Open the Plotlight browser and search for characters to check published-image previews and ratings/roses. If it still reports that the helper is missing, check the exact file path, configuration, and server startup logs.

Without the helper, character, preset, and lorebook imports still work. Personas with working native JSON exports can also import; the helper is needed when those exports return 404.

## Update

After updating the browser extension, recopy this folder to `SillyTavern/plugins/nemo-plotlight` and restart ST. Extension-manager updates do not update the separate helper copy. The setup toast appears only once per ST user; reopen these instructions from **Helper setup** in the Plotlight browser whenever needed.

## What the helper does

The frontend is installed separately from the repository root through ST's extension manager. It calls these same-origin read-only routes:

- `/api/plugins/nemo-plotlight/stats/{uuid}` — public rating and community-star totals.
- `/api/plugins/nemo-plotlight/persona/{uuid}` — public persona definition when a native export returns 404.
- `/api/plugins/nemo-plotlight/image/{uuid}` — only Plotlight's fixed `/api/published-media/{uuid}/thumb` raster endpoint.

Requests omit remote credentials and reject redirects. Metadata successes are cached for five minutes; image responses use private browser caching and no server image cache. All jobs share concurrency/queue limits and upstream rate-limit cooldowns. Images are limited to 5 MB, safe raster types and matching signatures. The helper has no package dependencies.

Code uses the repository's AGPL v3 license.
