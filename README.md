# bo

AI wrapper around iMessage: get messages, send to yourself, list chats, and inspect reactions. Built with [@photon-ai/imessage-kit](https://github.com/photon-hq/imessage-kit) on macOS.

## Requirements

- **macOS** (iMessage and `~/Library/Messages/chat.db` are macOS-only)
- **Bun** (or Node 18+ with `better-sqlite3`; this repo uses Bun)
- **Full Disk Access** for Terminal (or your IDE) so the kit can read the Messages database  
  System Settings → Privacy & Security → Full Disk Access → add Terminal / Cursor / etc.

## Setup

```bash
bun install
```

**Optional:** Copy `.env.local.example` to `.env.local` and fill in (`.env.local` is gitignored). All bo commands load `.env` and `.env.local` from the project root, so you can set:

- `BO_MY_PHONE` or `BO_MY_EMAIL` — for send-self and watch-self self-chat
- `BO_AGENT_SCRIPT` — for watch-self (script that takes message as first arg, prints response)
- `BO_AGENT_NUMBERS` — comma-separated numbers (e.g. `7404749170,6143480678`); when any of these send a message, the agent replies in that chat
- `AI_GATEWAY_API_KEY` — Vercel AI Gateway API key (used by `scripts/agent.sh` to answer via `openai/gpt-4.1` by default)
- `BO_LLM_MODEL` — override the model (default: `openai/gpt-4.1`)

You can still override with env vars when running a command.

(Sending to yourself uses your phone number or email as the “buddy”; the Messages app doesn’t allow sending to the same Apple ID account directly.)

## Slash commands (Cursor agent)

In Cursor chat: `/get-messages 20`, `/get-messages unread`, `/send-self <text>`, `/list-chats [N]`, `/react`, `/watch-self`. Defined in `.cursor/commands/`; they run the bo CLI from the project root.

## Commands (CLI)

| Command | Description |
|--------|-------------|
| `bo get-messages` | Get recent messages (JSON). Options: `--limit N`, `--unread`, `--sender ID`, `--chat ID`, `--search "..."` |
| `bo send-self "text"` | Send a message to yourself (requires `BO_MY_PHONE` or `BO_MY_EMAIL`) |
| `bo list-chats` | List chats. Options: `--limit N`, `--unread` |
| `bo react --list` | List messages that have tapback reactions. Sending reactions is not supported by the base kit (would need [advanced-imessage-kit](https://github.com/photon-hq/advanced-imessage-kit) or similar). |
| `bo watch-self` | Watch self-chat for "Bo …" and (optional) BO_AGENT_NUMBER; pass the rest to BO_AGENT_SCRIPT and reply. Never replies with "Bo" or to its own messages. |

## Self-chat watcher (like Moltbot/Clawdbot)

Run `bo watch-self` with:

- **BO_MY_PHONE** or **BO_MY_EMAIL** — your self-chat handle.
- **BO_AGENT_SCRIPT** — script (or command) that receives the message as its first argument and prints the response to stdout (e.g. a wrapper that calls Cursor agent or another CLI agent).

Optional:

- **BO_AGENT_NUMBERS** — comma-separated numbers, e.g. `7404749170,6143480678`. When any of these send a message in any chat, the message is passed to the agent and the reply is sent back to that chat.

Behavior:

1. **Self-chat:** Only messages that **start with "Bo"** (case-insensitive) are handled. The rest of the message is passed to the agent; the agent’s output is sent back as the reply. Replies are **never** allowed to start with "Bo" (they are prefixed with "→ " if needed) so the watcher doesn’t react to its own messages.
2. **From BO_AGENT_NUMBER:** Any message from that number is passed to the agent; the reply is sent back to that chat.
3. The watcher tracks every message it sends and never processes those again (no loop).

**Giving the agent internet access (weather, search, etc.):** The Cursor CLI agent uses MCP (Model Context Protocol). Add a web-capable MCP server so the agent can browse or fetch pages—e.g. **Playwright MCP** in `~/.cursor/mcp.json`:

```json
"playwright": {
  "command": "npx",
  "args": ["-y", "@playwright/mcp@latest", "--browser", "chromium", "--headless"],
  "env": {}
}
```

Or in Cursor: **Settings → Features → MCP → Add New MCP Server** and add Playwright. The CLI uses the same MCP config as the editor.

**If the agent says "MCP server may not be running or connected":** The Cursor CLI often doesn’t start MCP servers in headless/script mode until you’ve run an **interactive** agent session once from this project:

1. From the bo project root, run: `agent` (no `-p`).
2. In the interactive session, run: `agent mcp list` and ensure **playwright** is enabled, or ask something that uses the browser (e.g. “Use the browser to open wttr.in and tell me the weather”).
3. Exit the session, then try `npm run watch-self` again and send “Bo what’s the weather” from iMessage.

That first interactive run can establish the MCP connection so later headless runs from the script can use Playwright.

## Daemon and watchdog (macOS)

To run `watch-self` in the background and have it restart if it crashes or at login, use the wrapper script and **launchd** (macOS’s built-in daemon manager and watchdog).

1. **Wrapper script** — `scripts/watch-self-daemon.sh` runs from the project root, loads `.env.local`, and runs `npm run watch-self`. Make it executable:

   ```bash
   chmod +x scripts/watch-self-daemon.sh
   ```

2. **launchd plist** — Copy `scripts/com.bo.watch-self.plist` to `~/Library/LaunchAgents/` and **edit the paths** inside (replace `/Users/hoguej/dev/bo` with your project path):

   ```bash
   mkdir -p ~/Library/LaunchAgents
   cp scripts/com.bo.watch-self.plist ~/Library/LaunchAgents/
   # Edit ~/Library/LaunchAgents/com.bo.watch-self.plist: set WorkingDirectory, ProgramArguments, StandardOutPath, StandardErrorPath to your project path
   ```

3. **Load (start) the daemon:**

   ```bash
   launchctl load ~/Library/LaunchAgents/com.bo.watch-self.plist
   ```

4. **Unload (stop):**

   ```bash
   launchctl unload ~/Library/LaunchAgents/com.bo.watch-self.plist
   ```

5. **Logs** — stdout and stderr go to `logs/watch-self.out.log` and `logs/watch-self.err.log` (created on first run).

**Built-in watchdog:** launchd’s **KeepAlive** (set to `true` in the plist) makes macOS restart the job if it exits for any reason. **RunAtLoad** starts it at login. So the watcher runs as a daemon and is restarted automatically on crash or reboot.

**Note:** The process runs under your user; give **Full Disk Access** to the app that runs the script (e.g. Terminal, or the shell used by launchd). If you run the plist from a login shell, your `PATH` and env may differ; the plist sets a minimal `PATH`; for `bun`/`npm` ensure they’re in that path (e.g. `/opt/homebrew/bin`) or set `PATH` in the plist’s `EnvironmentVariables` to include your bun location.

## Examples

```bash
# Recent messages
bun run bo get-messages --limit 10

# Unread only
bun run bo get-messages --unread

# Send a note to yourself
BO_MY_PHONE=+15551234567 bun run bo send-self "Reminder: call back"

# Chats with unread
bun run bo list-chats --unread --limit 5

# Messages that have reactions
bun run bo react --list
```

Or run the CLI directly:

```bash
bun run src/cli.ts get-messages --limit 5
```

## AI wrapper

All commands print JSON to stdout so an AI or script can parse results. Use `get-messages` for context, `send-self` for reminders or notes to yourself, `list-chats` to pick a conversation, and `react --list` to see reactions. Sending tapbacks would require Photon’s advanced-imessage-kit or a helper that uses private APIs.

## License

MIT
