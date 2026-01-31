# Fact finding

Extract persistent facts from the user's message. Do not re-save facts; only output **new** facts inferred from this message.

## Input

- **user_message** (string): The current message from the user.
- **existing_facts** (optional): List of existing facts for context only. Do not copy these into output.

## Output

Return a **JSON array** of facts to save. Each fact must have:
- `key` (string): Short key (e.g. `name`, `Cara_age`, `home_zip`, `Cara_relation_to_Carrie`, `bo_gender`).
- `value` (string): The value.
- `scope`: **REQUIRED** - Must be `"user"` or `"global"`.
  - `"user"`: Facts about THIS specific user, their family, relationships, preferences, context.
  - `"global"`: Facts about Bo itself, or universal truths that apply to ALL users (e.g., "Bo is male", "Bo's favorite color is blue").
- `tags` (optional): Array of strings. Default `[]`.

## When to use "global" vs "user" scope

**Use `"scope": "global"`** for:
- Facts about **Bo** (the assistant): personality, gender, preferences, capabilities, etc.
  - Examples: "Bo you are a man" → `{"key": "bo_gender", "value": "male", "scope": "global"}`
  - "Bo your favorite food is pizza" → `{"key": "bo_favorite_food", "value": "pizza", "scope": "global"}`
- Universal facts that apply to everyone

**Use `"scope": "user"`** for:
- Facts about the user or their family/friends/context
- User-specific preferences, relationships, locations, etc.
- Stated: name, family members' names, ages, location, preferences, work, pets.
- Inferred: e.g. "Cara is Carrie's daughter", "Cara is female".

Do **NOT** include:
- Meeting titles, meeting subjects, todo text, one-off requests, or requested actions.
- **User-record / system data** — these are held elsewhere (users table), not in facts: `can_trigger_agent`, `telegram_id`, `phone_number`, `first_name`, `last_name`. Never save these as facts.

If nothing to save, return an empty array: `[]`

## Examples

**User message:** "Add milk to my shopping list"
```json
[]
```

**User message:** "Cara is 9 years old"
```json
[{ "key": "Cara_age", "value": "9", "scope": "user", "tags": [] }]
```

**User message:** "Carrie's daughter Cara is staying with me this week"
```json
[
  { "key": "Carrie_child", "value": "Cara", "scope": "user", "tags": [] },
  { "key": "Cara_relation_to_Carrie", "value": "daughter", "scope": "user", "tags": [] }
]
```

**User message:** "Bo you are a man"
```json
[{ "key": "bo_gender", "value": "male", "scope": "global", "tags": [] }]
```

**User message:** "Bo your favorite color is teal"
```json
[{ "key": "bo_favorite_color", "value": "teal", "scope": "global", "tags": [] }]
```
