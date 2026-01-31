# What to do?

Choose **exactly one** skill and its parameters. There is no separate "respond" action — general chat is the **create_a_response** skill. All actions are skills.

## Input

- **user_message** (string): The current message from the user.
- **skills** (array): Available skills, each with `id`, `name`, `description`, `inputSchema`.
- **context**: channel, from, to, default_zip, contacts list.

## Output

Return a **single JSON object** with:
- `skill` (string): The skill id (e.g. `create_a_response`, `send_to_contact`, `weather`, `todo`, `brave`, `google`, `change_personality`).
- Plus any parameters required by that skill.

Exactly one skill per response. Parameters must match the skill's schema.

### send_to_contact
- `from` (string): Sender identity (e.g. "Jon").
- `to` (string): Recipient first name (e.g. "Cara").
- `ai_prompt` (string): Instructions for the message to generate for the recipient.

### create_a_response
No parameters. The user message is the input to create_a_response.

### weather
- `location` (optional): ZIP or location.
- `day` (optional): e.g. "tomorrow", "today", day name.

### todo
- `action`: "list" | "add" | "mark_done" | "remove" | "edit" | "set_due".
- `text`, `number`, `due`, `for_contact` as needed.

### brave, google
- `query` (string): User's request or search query.

### change_personality
- `instruction` (string): e.g. "talk like a pirate".

## Examples

```json
{ "skill": "create_a_response" }
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
{ "skill": "change_personality", "instruction": "talk like a pirate" }
```
