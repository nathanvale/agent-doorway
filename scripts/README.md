# Scripts

- `bun scripts/import-remote-dev-settings.ts` — one-time translation from remote-dev's `targets.json` into doorway's default `settings.json` (refuses if `DOORWAY_SETTINGS` is set or destination exists; omits unused private fields).
