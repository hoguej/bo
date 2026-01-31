# Todo skill

Per-person todo lists: add, list, mark done, remove, edit, set due. List owner = assignee; creator is tracked by user id (can differ from assignee).

## Input (from "what to do?" → skill stdin)

- **action**: "list" | "add" | "add_many" | "mark_done" | "remove" | "edit" | "set_due".
- **text**: For add — content (may be normalized/extrapolated). For edit — new content (match user more closely).
- **items** (for **add_many** only): Array of `{ text: string, due?: string }`. Use when the user provides a **list** of tasks (e.g. "add these: buy milk, call mom, wash the car"). Each element becomes one todo; you may fix grammar/spelling per item.
- **number**: Task **id** (from list). Required when acting on another person's list (`for_contact` set). Optional on own list if `match_phrase` is provided.
- **match_phrase**: Approximate phrase to select a task on **own list only** (e.g. "everybody is fed" → match "Feed the dog").
- **show_done**: If true, list includes completed tasks. Default: list shows only **open** tasks.
- **due**: For add/set_due (e.g. "2025-01-30", "tomorrow").
- **for_contact**: Contact name for **their** list (e.g. "Carrie"). Omit for sender's list.

Environment: `BO_REQUEST_FROM` = sender (used as creator when adding a todo).

## Output (stdout)

Always a **single JSON object**:

- **response** (string): The main message (e.g. "Added …", list text, "Marked #3 done.").
- **hints** (optional object): For create_response. Include **todo_ids** (array of task ids) when listing or when an action targeted specific tasks, so the reply can reference "todo #3" etc.

List format in **response** must be:

- Numbered in **ascending order by task id**.
- Each line: **id. verbatim_text | creator | due &lt;date&gt;** (due only if set).
- **Verbatim**: When reading back a todo, use the exact stored text — do not rephrase in the skill; the create_response step may rephrase for the user.

Example list response:

```
Your todos:
1. Wash the truck | You | due 2025-01-30
2. Feed the dog | You
3. Call Mom | Carrie
```

Example JSON output (list):

```json
{
  "response": "Your todos:\n1. Wash the truck | You | due 2025-01-30\n2. Feed the dog | You\n3. Call Mom | Carrie",
  "hints": { "todo_ids": [1, 2, 3] }
}
```

Example JSON output (mark_done):

```json
{
  "response": "Marked #2 done.",
  "hints": { "todo_ids": [2] }
}
```

## Behavior

- **Own list**: Approximate language allowed for selecting a task (match_phrase); number optional when phrase matches.
- **Other people's list**: Require explicit task id (e.g. "mark Carrie's task #4 as done"). Do not infer from vague praise.
- **Creating a todo** (add or add_many): OK to fix grammar, spelling, add emotes, extrapolate. Use **add_many** when the user gives a list of items. **Editing**: match user input more closely. **Reading back**: verbatim only.
- **Default list**: Open tasks only. Use `show_done: true` only when the user asks for completed tasks.
