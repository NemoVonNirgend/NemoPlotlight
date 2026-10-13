# Nemo Plotlight

Browse public [Plotlight](https://plotlightstudios.com) characters, Chat Completion presets, lorebooks, and personas from SillyTavern and import them into the native libraries.

**Version 0.1.3 works with vanilla SillyTavern.** It uses native ST importers and standard settings endpoints. Tested against upstream release **1.19.0**, commit `06bde939fb1e9c4c8d8641d810f0a916b5bce127`, and NemoTavern API contracts. No minimum older ST version is claimed. There is no API key, Plotlight login, build step, or runtime package dependency.

## Install

In SillyTavern, open **Extensions → Install extension** and enter:

```text
https://github.com/NemoVonNirgend/NemoPlotlight
```

Reload ST. The theater-masks button in **Character Management** opens the browser. **PL** buttons also appear beside Chat Completion preset export, World Info export, and Persona Management backup. The browser has four library tabs.

For manual installation, put this repository's files inside your user's `extensions/NemoPlotlight` directory, normally `SillyTavern/data/default-user/extensions/NemoPlotlight`. `manifest.json` must be directly inside that folder. A global installation can use `SillyTavern/public/scripts/extensions/third-party/NemoPlotlight`.

### Companion server helper

**Install the bundled helper for published-image previews, character ratings/roses, and the persona-download fallback.** The browser extension manager does not install server plugins.

1. Copy this repository's **`server-plugin`** folder to **`SillyTavern/plugins/nemo-plotlight`**. The resulting path must be `SillyTavern/plugins/nemo-plotlight/index.mjs`.
2. In ST's `config.yaml`, set:

   ```yaml
   enableServerPlugins: true
   ```

3. Restart SillyTavern. Reload the browser after installing or updating either component.

The helper uses ST's standard server-plugin interface. It contacts only fixed public Plotlight endpoints, makes anonymous requests, validates UUIDs, rejects redirects, and limits shared work to two active jobs. Published thumbnails have a 5 MB streaming limit and raster MIME/signature checks. No arbitrary image URL can be proxied.

Without it, character, preset, and lorebook imports still work. Ratings/roses and published-thumbnail previews are unavailable. Personas whose native JSON export works can still import; personas whose export returns 404 need the helper fallback. ST's [server-plugin documentation](https://docs.sillytavern.app/for-contributors/server-plugins/) explains server-plugin configuration.

When updating this extension, also recopy `server-plugin` to the ST plugins directory and restart ST. Extension-manager updates alone do not update that separate copy.

## Features

- Four searchable catalogs with native search modes, sorting, include/exclude tags, and content-specific filters.
- Character rating slider, visual-novel filter, fractional rating stars, and community rose totals.
- Debounced search, cancellation, paging through empty result pages, timeouts, shared export cooldowns respecting `Retry-After`, serialized imports, and a 30 MB download limit.
- Character PNG V2/V3 and JSON V2/V3 imports through ST's native importer. PNG cards retain the portrait; JSON imports use ST's normal default image behavior.
- Chat Completion preset import preserves prompts, prompt order, portable sampler settings, and extension fields. Connection/provider/model fields are removed after native import hooks, preserving the active connection. Fresh disk snapshots prevent name collisions and verify saves.
- Lorebook import preserves native entries/options, avoids existing filenames, refreshes World Info, and verifies disk contents. Assign imported books through World Info as usual.
- Persona import saves full definitions and portraits in Persona Management while preserving the active persona. Choose the imported persona when ready.
- Import history prevents repeated imports while the imported object still exists. Deletion allows reimporting. It does not recognize manually imported items or overwrite/update existing imports.
- ST theme colors, bundled OFL fonts, responsive layouts, keyboard controls, and reduced-motion support.

## Public content and privacy

This uses Plotlight's [read-only public API](https://plotlightstudios.com/docs/api/public-content). Guest visibility and export permissions apply. It does not connect a private library or change content on Plotlight.

Remote text is rendered through text nodes. Public downloads use `credentials: 'omit'`; direct remote images use anonymous CORS mode and no referrer. Fixed published-media thumbnails are fetched anonymously by the helper and served through the local ST origin because their upstream route lacks browser CORS headers. Browsing contacts Plotlight and any referenced image hosts. There is no extension telemetry.

Some published persona exports currently return HTTP404. Only that status invokes the helper's anonymous public-definition fallback. It copies full content or labeled appearance/body/personality/quirks/history sections, never a catalog teaser as the definition. This public projection can omit linked lorebooks and other fields; it is not a complete replacement for a repaired export. Permission errors and rate limits do not invoke the fallback.

RoleCall runtime trackers, props, loadouts, private dependencies, and account settings are outside this extension. Card exports are not complete sprite/artwork archives. Stop generation before importing characters. Imports follow ST's normal tag settings and may select the imported character/preset; imported personas remain unselected.

## License

Code: [GNU AGPL v3](LICENSE). Bundled Cinzel and Crimson Pro fonts: SIL Open Font License, with their license files in `fonts/`. Imported content remains the respective creators' work; preserve attribution and honor withdrawals. This is a third-party extension, not an official Plotlight or SillyTavern product.
