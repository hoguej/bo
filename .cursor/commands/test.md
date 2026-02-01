# /test

Run all tests with `.env.local` loaded so `DATABASE_URL` and other vars are set. No need to remember to source the env yourself.

**Usage:** `/test`

Run from the project root:

```bash
cd /Users/hoguej/dev/bo && set -a && source .env.local && set +a && bun test
```

This runs the full test suite (daemon, family-isolation, reminders, etc.) against the DB and env from `.env.local`.
