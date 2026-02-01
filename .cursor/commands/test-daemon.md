# /test-daemon

Run the daemon test suite with `.env.local` loaded so `DATABASE_URL` and other vars are set. No need to remember to source the env yourself.

**Usage:** `/test-daemon`

Run from the project root:

```bash
cd /Users/hoguej/dev/bo && set -a && source .env.local && set +a && bun run test:daemon
```

This runs `tests/daemon/` (router, watch-self helpers, integration). If `DATABASE_URL` is set in `.env.local`, DB-dependent tests run against that DB.
