# /list-chats

List iMessage chats via the bo CLI.

**Usage:** `/list-chats [N]` or `/list-chats unread`

- If the user provides a number, run: `npm run start -- list-chats --limit N`
- If the user says `unread`, run: `npm run start -- list-chats --unread`
- Otherwise: `npm run start -- list-chats --limit 20`

Run from the project root. Output is JSON; show the user the result or a short summary.
