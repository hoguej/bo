# Daemon test suite

Tests for the **watch-self** daemon and **router**. If these pass, you can be confident production won’t break.

Tests run against **DATABASE_URL** (your non-prod DB on this machine). The DB should have at least one user with `telegram_id` (e.g. after `bun run seed:import`).

## How to run

Tests use **DATABASE_URL** from your environment (your non-prod DB). Load it first, then run:

```bash
# Export vars from .env.local, then run daemon tests
set -a && source .env.local && set +a && bun test tests/daemon
```

Or with the npm script:

```bash
set -a && source .env.local && set +a && bun run test:daemon
```

Or run all project tests (including daemon):

```bash
set -a && source .env.local && set +a && bun test
```

(`set -a` exports variables from `.env.local` so the test process sees `DATABASE_URL`.)

## What’s covered

- **Router**: Message → LLM mock → decision → create_response → stdout. Uses `BO_LLM_MOCK_PATH` (no real LLM). Uses `DATABASE_URL` for memory, skills, users.
- **Watch-self helpers**: `sanitizeReply`, Telegram rate limit, parsing of router stdout.
- **Integration**: Router run as subprocess (same as watch-self); assert exit 0 and no errors on stdout.

## Requirements

- **DATABASE_URL** set to your non-prod DB (e.g. in `.env.local`). At least one user must have `telegram_id`.
- **Watch-self unit tests** don’t need a DB.

## Before merging to prod

1. Run `bun test tests/daemon` (or `bun run test:daemon`) with `DATABASE_URL` pointing at dev.
2. If all tests pass, the daemon path is covered and safe to deploy.
