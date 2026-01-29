# /watch-self

Start the bo watcher: reacts when you message yourself with "Bo …" or when BO_AGENT_NUMBER sends a message. Passes the rest of the message to a command-line agent and replies with the response. Never sends a reply that starts with "Bo".

**Usage:** `/watch-self`

Run from the project root:

```bash
BO_MY_PHONE=+1234567890 BO_AGENT_SCRIPT=/path/to/agent-script npm run start -- watch-self
```

Optional: `BO_AGENT_NUMBERS=7404749170,6143480678` (comma-separated) — when any of these numbers send a message, pass it to the agent and reply there. Config can live in `.env.local` (gitignored).

- **Self-chat:** Only messages that start with "Bo" (case-insensitive) are handled; the rest of the line is sent to the agent.
- **BO_AGENT_NUMBER:** Every message from that number is sent to the agent; reply goes back to that chat.
- **BO_AGENT_SCRIPT:** Script or command that receives the message as its first argument and prints the response to stdout.
- Replies are never allowed to start with "Bo" (they are prefixed with "→ " if they do).
- Messages that bo sent are tracked so they are never processed again.
