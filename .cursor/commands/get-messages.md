# /get-messages

Run the bo get-messages CLI and show the result.

**Usage:** `/get-messages [N]` or `/get-messages unread`

- If the user provides a number (e.g. `20`), run: `npm run start -- get-messages --limit 20`
- If the user says `unread`, run: `npm run start -- get-messages --unread`
- Otherwise default: `npm run start -- get-messages --limit 20`

Run from the project root (where `package.json` and `src/cli.ts` live). Output is JSON to stdout; show the user the result or a short summary.
