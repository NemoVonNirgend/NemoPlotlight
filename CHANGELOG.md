# Changelog

## 0.1.4

- Show a one-time helper installation toast after SillyTavern is ready, with copy/config/restart steps and a link to the bundled README.
- Remember the notice per ST user and keep a Helper setup link in the Plotlight browser for later reference.
- Expand the helper README with source folder locations, installation steps, hosted-server guidance, and update instructions.

## 0.1.3

- Remove development-only tests, browser harnesses, lint configuration, package scripts, and test CI from extension installations.
- Keep the README focused on installation and use. Extension features, bundled fonts, and the companion server helper are unchanged.

## 0.1.2

- Replace the fork-only preset readback endpoint with upstream ST's `/api/settings/get`. Check UI/disk name collisions using Unicode normalization and verify saved prompts/order without modifying the active connection.
- Bundle the companion server helper and document its separate installation and updates on vanilla ST.
- Route fixed Plotlight published thumbnails through the helper, fixing their browser CORS failure without sending remote credentials.
- Support that image route for persona portraits and provide actionable messages when the helper is missing.
- Add upstream-shaped preset tests, bounded image-helper tests, portable UI harnesses, package checks, lint configuration, and CI.

## 0.1.1

- Local character, Chat Completion preset, lorebook, and persona catalogs with native imports, filters, duplicate history, responsive ST-themed UI, and optional metadata helper.
