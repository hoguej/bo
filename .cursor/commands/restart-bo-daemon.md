# /restart-bo-daemon

Restart the Bo watch-self daemon: stop the background process, then start it again so the latest code and env are used.

**Usage:** `/restart-bo-daemon`

Run from the project root. Use a login shell or set PATH so `bun` is found (otherwise you get `bun: command not found`):

```bash
pkill -f "watch-self"
cd /Users/hoguej/dev/bo
mkdir -p logs
PATH="$HOME/.bun/bin:$PATH" nohup npm run watch-self >> logs/watch-self.out.log 2>> logs/watch-self.err.log &
```

Confirm it’s running: `pgrep -f "watch-self"` (should show a PID). Logs: `logs/watch-self.out.log` and `logs/watch-self.err.log`.
