# Fact finding

Extract persistent facts from the user's message. Do not re-save facts; only output **new** facts inferred from this message.

## Input

- **user_message** (string): The current message from the user.
- **existing_facts** (optional): List of existing facts for context only. Do not copy these into output.

## Output

Return a **JSON array** of facts to save. Each fact must have:
- `key` (string): Short key (e.g. `name`, `Cara_age`, `home_zip`, `Cara_relation_to_Carrie`).
- `value` (string): The value.
- `scope` (optional): `"user"` or `"global"`. Default `"user"`.
- `tags` (optional): Array of strings. Default `[]`.

Only include **true attributes** about the user or their context:
- Stated: name, family members' names, ages, location, preferences, work, pets.
- Inferred: e.g. "Cara is Carrie's daughter", "Cara is female".

Do **NOT** include: meeting titles, meeting subjects, todo text, one-off requests, or requested actions.

If nothing to save, return an empty array: `[]`

## Examples

```json
[]
```

```json
[{ "key": "Cara_age", "value": "9", "scope": "user", "tags": [] }]
```

```json
[
  { "key": "Carrie_child", "value": "Cara", "scope": "user", "tags": [] },
  { "key": "Cara_relation_to_Carrie", "value": "daughter", "scope": "user", "tags": [] }
]
```
