# /start-bo-daemon

Start the Bo watch-self daemon in the background (Terminal process). Run from a Terminal that has Full Disk Access so the daemon can read iMessage. The process keeps running until you stop it or close the machine.

**Usage:** `/start-bo-daemon`

Run from the project root:

```bash
cd /Users/hoguej/dev/bo
nohup npm run watch-self >> logs/watch-self.out.log 2>> logs/watch-self.err.log &
```

Confirm it’s running: `pgrep -f "watch-self"` (should show a PID). Logs: `logs/watch-self.out.log` and `logs/watch-self.err.log`.
