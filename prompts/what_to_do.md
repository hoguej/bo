# What to do?

Choose **exactly one** skill and its parameters. There is no separate "respond" action — general chat is the **create_a_response** skill. All actions are skills.

## Input

- **user_message** (string): The current message from the user.
- **skills** (array): Available skills, each with `id`, `name`, `description`, `inputSchema`.
- **context**: channel, from, to, default_zip, contacts list.

## Output

Return a **single JSON object** with:
- `skill` (string): The skill id (e.g. `friend_mode`, `create_a_response`, `send_to_contact`, `weather`, `todo`, `reminder`, `brave`, `google`, `change_personality`).
- Plus any parameters required by that skill.

Exactly one skill per response. Parameters must match the skill's schema.

### send_to_contact
- `from` (string): Sender identity (e.g. "Jon").
- `to` (string): Recipient first name (e.g. "Cara").
- `ai_prompt` (string): Instructions for the message to generate for the recipient.

### create_a_response
No parameters. The user message is the input to create_a_response.

### friend_mode
Use when the user is **just talking** (not asking you to do anything) and wants conversation, support, or connection.

- No required parameters.
- Optional: `person` (string) if the user explicitly wants friend mode tailored to someone else (rare). Otherwise the system will tailor to the requestor automatically.

### weather
- `location` (optional): ZIP or location.
- `day` (optional): e.g. "tomorrow", "today", day name.

### todo
- `action`: "list" | "add" | "add_many" | "mark_done" | "remove" | "edit" | "set_due".
- **add**: `text` (string). You may fix grammar/spelling, add emotes, extrapolate. `due`, `for_contact` as needed.
- **add_many**: Use when the user provides **a list** of tasks (e.g. "add these: buy milk, call mom, wash the car" or bullet/numbered list). `items` (array of `{ text: string, due?: string }`). Each item is one todo; you may fix grammar/spelling per item. `for_contact` as needed.
- `text` (for edit): Match what the user says more closely. When reading back a todo, use the **verbatim** stored text.
- `number` (optional for own list): Task **id** (from the list). When acting on **someone else's list** (`for_contact` set), **number is required** — e.g. "mark Carrie's task #4 as done" not "Carrie did a good job on the car".
- `match_phrase` (optional, own list only): Approximate language to pick a task when the user doesn't give an id. E.g. "everybody is fed" → match task like "Feed the dog"; "wash the truck" → match "Wash the truck".
- `show_done` (optional, for list): If true, include completed tasks in the list. **By default, list shows only open tasks.**
- `due`, `for_contact` as needed.

**When to choose todo:**
- Single task (no specific time): "I need to …", "add a task", or "remind me to X" **without a time** (e.g. "remind me to call mom") → **add** with `text`. If the user says **add to [name]'s list** or **add task to [name]'s todo list**, set **for_contact** to that person's first name (e.g. "Robert", "Carrie") so the task goes on their list with the requestor as creator.
- If the user gives a **specific time** for a reminder (e.g. "remind me at 7:30", "set a reminder for 7:37 AM to …"), use the **reminder** skill, not todo.
- **List of tasks**: "add these: X, Y, Z", "add to my list: …", bullet or numbered list of items → **add_many** with `items: [{ text: "…" }, …]`. Use **for_contact** when adding to someone else's list.
- Language like "done", "finished", "everybody is fed", "I did the car" (on own list) → **mark_done** (use `match_phrase` or `number`).
- For **other people's lists**: require explicit wording like "mark Carrie's task #4 as done" — do not infer from "Carrie did a good job".

### reminder
- `action`: "create" | "list" | "update" | "delete".
- **create**: `text` (string, required — what to do at fire time). For one-off: provide **either** `fire_at_iso` (UTC ISO) **or** `time` / `at` (e.g. "7:37 AM", "7:30") in the user's local time. Optional: `for_contact` (first name) to set a reminder for someone else. For recurring: `recurrence` (e.g. "daily 08:30") and first run time.
- **list**: optional `filter`: "for_me" | "by_me".
- **update** / **delete**: `reminder_id` (number).

**When to choose reminder:**
- User asks for a **time-based** reminder: "set a reminder for 7:37 AM to …", "remind me at 7:30 to …", "remind me at 7:37 AM to test the reminder system" → **reminder** with action **create**, `text` (the reminder content), and `time` or `at` (e.g. "7:37 AM"). Do **not** use todo for these.

**Scheduled reminders (reminder firing):**
- If the **user_message starts with** `"[scheduled: reminder]"`, you are delivering a previously scheduled reminder.
- **Do not** choose **todo** for these.
- Default to **create_a_response** unless the reminder text explicitly instructs another skill (e.g. "send Cara a message saying happy birthday"). If it's not obvious, just respond with the reminder.

**When to choose friend_mode:**
- User is chatting / sharing feelings / telling a story / seeking reassurance without asking for actions.
- Phrases like "I just wanted to talk", "rough day", "I feel...", "can I vent", "I don't know what to do" (if they want support, not task execution).
  - If they explicitly ask for advice or a plan, you can still use friend_mode (offer options: vent vs perspective vs plan).

### brave, google
- `query` (string): User's request or search query.

### change_personality
- `instruction` (string): e.g. "talk like a pirate".

## Examples

```json
{ "skill": "create_a_response" }
```

```json
{ "skill": "friend_mode" }
```

```json
{ "skill": "send_to_contact", "from": "Jon", "to": "Cara", "ai_prompt": "say hello and tell her today will be a good day" }
```

```json
{ "skill": "weather", "location": "43130", "day": "tomorrow" }
```

```json
{ "skill": "todo", "action": "list" }
```

```json
{ "skill": "todo", "action": "add", "text": "Help me with Cara's wall", "due": "tomorrow", "for_contact": "Robert" }
```

```json
{ "skill": "todo", "action": "add_many", "items": [{ "text": "Buy milk" }, { "text": "Call Mom" }, { "text": "Wash the car" }] }
```

```json
{ "skill": "reminder", "action": "create", "text": "test the reminder system", "time": "7:37 AM" }
```

```json
{ "skill": "reminder", "action": "create", "text": "tell me what the weather is going to be", "fire_at_iso": "2025-01-30T14:30:00.000Z" }
```

```json
{ "skill": "reminder", "action": "list" }
```

```json
{ "skill": "change_personality", "instruction": "talk like a pirate" }
```
