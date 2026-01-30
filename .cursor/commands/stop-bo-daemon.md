# /stop-bo-daemon

Stop the Bo watch-self daemon (background Terminal process).

**Usage:** `/stop-bo-daemon`

Run from anywhere:

```bash
pkill -f "watch-self"
```

Confirm it’s stopped: `pgrep -f "watch-self"` should show nothing.
