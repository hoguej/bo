# Dev database seed (prod → dev)

Use a **dev database** (`DATABASE_URL`) and **dev bot** for deliberate testing. Seed the dev DB from production with anonymized data so you can reset anytime.

**Important:** The daemon (watch-self) always uses `DATABASE_URL`. Locally that should be your dev DB. Use `PROD_DATABASE_URL` only for one-off commands like `seed:export` — never point the daemon at prod from local.

## Flow

1. **Export** from prod → `data/seed-dev.json` (persisted file; gitignored).
2. **Import** from `data/seed-dev.json` → dev DB (reset + load).

Schema changes are OK: export is row-based JSON; import only inserts columns that exist in the current DB.

## Anonymization

- **Jon** and **Carrie**: real `telegram_id`, real names and phone (so dev bot can message them).
- Everyone else: fake names (e.g. Alice Test, Bob Demo), fake phone (`+15550000001`, …), `telegram_id` set to `null`.

To change who gets real data, edit `PRESERVE_FIRST_NAMES` in `scripts/seed-export.ts`.

## Commands

Export from prod (requires `PROD_DATABASE_URL`):

```bash
PROD_DATABASE_URL="postgresql://..." bun run seed:export
```

Reset dev DB and load seed (requires `DATABASE_URL` pointing at dev):

```bash
DATABASE_URL="postgresql://..." bun run seed:import
```

With `.env.local`:

```bash
source .env.local
# DATABASE_URL=dev, PROD_DATABASE_URL=prod
bun run seed:export   # from prod → data/seed-dev.json
bun run seed:import  # from data/seed-dev.json → dev DB
```

## File location

- Seed file: `data/seed-dev.json` (created by export; **do not commit** — it’s in `.gitignore`).
- After schema changes, run **export** again from prod to refresh the seed.
