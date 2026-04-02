# ST-LoreDiff

Personal SillyTavern extension for **manual** lore/state change detection against existing World Info (`STATE` book first).

## Goals (MVP)

- Manual trigger (slash command) that checks recent chat for *potentially* relevant changes vs. existing `STATE` World Info.
- Human-in-the-middle review output only (no auto-apply, no file writes).
- Pick an **analysis preset** via SillyTavern Connection Manager profile, or reuse the current chat connection.

## Development setup (local)

This repo contains the extension files under:

- `public/scripts/extensions/third-party/lore-diff`

For local testing with your SillyTavern checkout at:

- `/Users/elmar.leirich/Documents/Dev/SillyTavern`

Create a symlink (or copy) into SillyTavern:

```bash
ln -s /Users/elmar.leirich/Documents/Dev/ST-LoreDiff/public/scripts/extensions/third-party/lore-diff \
  /Users/elmar.leirich/Documents/Dev/SillyTavern/public/scripts/extensions/third-party/lore-diff
```

Then start SillyTavern and enable the extension.

## Notes (MVP limitations)

- LoreDiff uses **Connection Manager profiles** to run the analysis request (so you can pick a full preset/model stack).
- If you keep "Same as chat", make sure you actually have a Connection Manager profile selected for your chat.
- Baseline lore is currently read best-effort from the loaded World Info entries for book `STATE`.
