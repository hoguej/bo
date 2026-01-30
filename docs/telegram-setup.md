# Telegram Bot Integration — Project Plan

Add Telegram as an alternative transport to iMessage: same agent (router), different channel. Use **grammY** and extend the **existing daemon** (no new command). Allowlist = `users.telegram_id` only; no separate DB or config.

---

## Requirements (by ID)

Each requirement is a discrete, testable prompt. IDs are stable for traceability.

### Setup & configuration

**Getting a bot token**

1. In Telegram, open a chat with [@BotFather](https://t.me/BotFather).
2. Send `/newbot` and follow the prompts (bot name, then username; username must end in `bot`).
3. BotFather replies with a token like `123456789:ABCdefGHI...`. **Keep it secret**; do not commit it. Put it in `.env.local` as `BO_TELEGRAM_BOT_TOKEN=<your token>`.

| ID | Requirement / Prompt |
|----|----------------------|
| **TG-001** | Bot token is the only Telegram config in env. Document in `.env.local.example`: `BO_TELEGRAM_BOT_TOKEN=<token from BotFather>`. No other Telegram-related env vars for allowlist or config. |
| **TG-002** | If `BO_TELEGRAM_BOT_TOKEN` is unset or empty, the daemon does not start any Telegram bot; iMessage behavior is unchanged. If set, the daemon starts the grammY bot (long polling) in the same process as the iMessage watcher. |

### Database

| ID | Requirement / Prompt |
|----|----------------------|
| **TG-003** | Add nullable `telegram_id TEXT UNIQUE` to `users`. Migration in `db.ts`; support existing DBs. A user may have both `phone_number` and `telegram_id` (same person); or Telegram-only with a placeholder `phone_number` (e.g. `'telegram'`). |
| **TG-004** | Allowlist for Telegram is **only** `users.telegram_id`. No separate table or config. If a Telegram user ID appears in `users.telegram_id`, that user is allowed; otherwise not. |
| **TG-005** | Extend owner resolution to support Telegram: owner string `"telegram:<id>"` (e.g. `telegram:12345`) must resolve to `user_id` by lookup on `users.telegram_id`. Do not create a user for an unknown Telegram ID. |

### User identity & no default user

| ID | Requirement / Prompt |
|----|----------------------|
| **TG-006** | There is no “default” user for unidentified senders. If the sender cannot be resolved to a valid user (by phone or by `users.telegram_id`), do not assign any user and do not reply. |
| **TG-007** | Extend `normalizeOwner()` and `normalizeNumberForAccess()` so that owner `"telegram:12345"` is passed through (no mapping to “default”). Unidentified senders must not be treated as a default user. |

### Daemon & Telegram flow

| ID | Requirement / Prompt |
|----|----------------------|
| **TG-008** | Extend the existing watch daemon (e.g. `watch-self`) so that when `BO_TELEGRAM_BOT_TOKEN` is set, the grammY bot runs in the **same process** (same loop/process as iMessage). No new CLI command and no separate Telegram process. |
| **TG-009** | On each Telegram text message: (1) Map `from.id` to owner string `"telegram:<id>"`. (2) Resolve to user via `users.telegram_id`. If no user row → treat as unknown (see TG-010). If user found → run the same agent script as for iMessage, set env `BO_REQUEST_FROM=telegram:<id>`, etc., and reply with grammY `ctx.reply(text)` using the agent stdout. |
| **TG-010** | Unknown Telegram users (no row in `users` with that `telegram_id`): **do not** create a user. **Do** save or log message data (telegram_id, message text, timestamp) so an admin can see who messaged and later set `users.telegram_id` on an existing user. **Do not** call the agent and **do not** send any reply. |

### Rate limiting & DOS protection

| ID | Requirement / Prompt |
|----|----------------------|
| **TG-011** | Reuse the same 3-second reply rate limit as watch-self for **identified** Telegram users: at most one reply every 3 seconds; if a message arrives within 3s of the last reply, ignore it (no agent call, no reply). |
| **TG-012** | DOS protection for high request rate: define a threshold (e.g. max N requests per minute per sender or globally for unknowns). If the rate is above threshold, **do not log** the request—drop it silently. This prevents log spam and resource abuse. |

### Admin & operations

| ID | Requirement / Prompt |
|----|----------------------|
| **TG-013** | Admin UI: allow setting and clearing `users.telegram_id` on user rows (existing table view / CRUD). No separate allowlist table or UI. |
| **TG-014** | Optional: document in the plan how to link Telegram to an existing user (e.g. see logged “this is Cara” from telegram_id 12345, then set Cara’s `users.telegram_id` to 12345 in admin UI). |

---

## Unit Testing Strategy

We are at a level where automated tests are warranted. Focus on logic that can be tested without live Telegram or iMessage.

### Scope of unit tests

1. **DB and owner resolution**
   - **TG-003, TG-004, TG-005:** Migration adds `telegram_id`; lookup by `users.telegram_id` returns the correct `user_id`; owner `"telegram:12345"` resolves when a row exists and does not resolve when none exists. Use an in-memory or temp-file SQLite DB per test (e.g. `:memory:` or `join(os.tmpdir(), 'bo-test-*.db')`). No creation of user for unknown Telegram ID.
   - **TG-006, TG-007:** `normalizeOwner("telegram:12345")` returns `"telegram:12345"`; unidentified owner does not become `"default"` in the code paths that resolve to user_id.

2. **Telegram message handling (mocked)**
   - **TG-009, TG-010:** Given a mock Telegram context (message from id 12345), if `users` has a row with `telegram_id = '12345'`, the handler invokes the agent and replies; if no such row, the handler does not call the agent, does not reply, and does log or persist message data (telegram_id, text, timestamp). Mock grammY `ctx` and the agent script; assert calls and stdout/response.
   - **TG-011:** With a mock clock or env, assert that a second message within 3s does not trigger an agent call or reply.

3. **DOS / rate threshold**
   - **TG-012:** Given a stream of mock requests above the configured threshold, assert that no log write and no agent call occur for the dropped requests. Can use a small in-memory “request log” or counter to simulate rate.

### Out of scope for unit tests (for now)

- Live Telegram API or real Bot token.
- Full daemon process or iMessage SDK (integration/e2e later if needed).
- Admin UI (manual or separate E2E).

### Tooling and layout

- **Runner:** Use **Bun’s built-in test runner** (`bun test`) for speed and consistency with the stack. Alternatively Vitest if the team prefers.
- **Location:** Unit tests next to source (e.g. `src/db.test.ts`, `src/commands/watch-self.test.ts`) or in a top-level `test/` / `tests/` directory with mirror structure (e.g. `test/db.test.ts`, `test/commands/watch-telegram.test.ts`). Prefer one test file per module or feature area.
- **Fixtures:** Seed SQLite with minimal schema and rows (e.g. `users` with one row with `telegram_id` set, one without). No shared global DB state; each test gets a fresh DB or cleans up in `afterEach`.
- **Mocks:** Mock grammY `Context` and the agent spawn/script so Telegram handler tests don’t call the real agent or Telegram API.

### Example test cases (to implement)

- `db: resolveOwnerToUserId("telegram:12345") returns user_id when users.telegram_id = '12345'`.
- `db: resolveOwnerToUserId("telegram:99999") does not create a user when no row exists`.
- `normalizeOwner("telegram:12345") returns "telegram:12345"`.
- `Telegram handler: identified user (telegram_id in users) calls agent and ctx.reply with stdout`.
- `Telegram handler: unknown telegram_id does not call agent, does not reply, does log or save message data`.
- `Telegram handler: second message within 3s (same or different user) does not trigger agent or reply`.
- `DOS: requests above rate threshold are dropped without logging`.

---

## Implementation checklist (traceable to IDs)

| Done | ID(s) | Task |
|------|-------|------|
| | TG-003 | Add `telegram_id TEXT UNIQUE` to `users` (migration in `db.ts`). |
| | TG-004, TG-005 | Implement owner resolution for `telegram:<id>` via `users.telegram_id`; no user creation for unknown IDs. |
| | TG-006, TG-007 | Ensure no default user; extend `normalizeOwner` / `normalizeNumberForAccess` for `telegram:<id>`. |
| | TG-001, TG-002 | Add dependency grammY; if `BO_TELEGRAM_BOT_TOKEN` set, start grammY bot in same daemon process. |
| | TG-008, TG-009, TG-010 | Implement Telegram message handler: resolve user, call agent for identified users, log-only for unknowns. |
| | TG-011 | Apply 3s reply rate limit for identified Telegram users. |
| | TG-012 | Implement DOS rate threshold; drop and do not log when over threshold. |
| | TG-013 | Confirm admin UI can set/clear `users.telegram_id` (no new table). |
| | TG-014 | Document linking Telegram to existing user (e.g. in README or this doc). |
| | — | Add unit tests per strategy above; run with `bun test` (or chosen runner). |

---

## Optional: Linking Telegram to Existing User

Unknown Telegram messages are logged (telegram_id, text, timestamp). Example: “this is Cara” from telegram_id 12345. To link that ID to Cara: in the admin UI, open `users`, find Cara’s row, set `telegram_id` to `12345`. That Telegram ID is then allowed and gets Cara’s facts/conversation when they message the bot.
