---
description: "Save a fact for Bo to remember (name/location/email/etc.)"
---

Use the `bo remember` command to save a fact locally so it can be passed to the LLM later when relevant.

Examples:
- `/remember name Justin`
- `/remember location Columbus, OH`
- `/remember email me@example.com`

Run:

```bash
bun run src/cli.ts remember {{args}}
```

