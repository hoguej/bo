# Agent Activities — Design: Discrete Steps and Prompts

Make how the agent works obvious by breaking activities into **individual calls** with **free-standing prompts**. Each step is a separate LLM call with a clear **input** and **output structure** (including examples). Every prompt lives in a **dedicated prompt file** (`.md`).

**Each of our prompts dictates:** (1) what data we send to the AI, and (2) what the structure of the data should be on output, including examples.

---

## Workflow (every time)

```
new message → fact finding → what to do? → run skill → create response → send response to user(s)
```

That’s the pattern every time: extract facts, pick one skill + params, run that skill, turn the result into a reply (create response), then send that reply to the right user(s).

---

## Prompt files (required)

We need a dedicated prompt file for: **fact finding**, **what to do**, **each skill**, and **create response** (plus **summary**). Each file defines:

1. **Input** — What data we send to the AI (e.g. user message, context, list of skills).
2. **Output** — Exact structure of the response, with examples.

| File | Purpose |
|------|--------|
| `prompts/fact_finding.md` | Extract facts from user message. |
| `prompts/what_to_do.md` | Pick one skill and its parameters. |
| `prompts/create_response.md` | Turn skill output + user message into the reply text to send. |
| `prompts/summary.md` | Combine current_summary + recent conversations → new summary (replaces). |
| `prompts/skills/<skill_id>.md` | One per skill: input schema and output structure (and behavior). |

---

## 1. Fact finding

**Trigger:** Run on every user message (before "what to do?").

**Prompt file:** `prompts/fact_finding.md`

**Input to AI:**
- User message (text).
- Optional: existing facts for this user (for context only; do not re-save).

**Output structure (with examples):**
- JSON array of facts, or empty array.
- Each fact: `{ "key": string, "value": string, "scope": "user" | "global", "tags": string[] }`.
- Example: `[{ "key": "Cara_age", "value": "9", "scope": "user", "tags": [] }]` or `[]`.
- Only true attributes (name, family, ages, location, preferences, work, pets, inferences like "Cara is Carrie's daughter"). No meeting subjects, todo text, or one-off requests.

**Result:** Persist `save_facts[]` to the facts table. No reply to user from this step.

---

## 2. What to do? (Skill + params only)

**Trigger:** After fact finding, run once per user turn.

**Prompt file:** `prompts/what_to_do.md`

**Input to AI:**
- User message.
- List of available skills with id, name, description, and parameter schema for each.
- Context (channel, from, contacts list, etc.).

**Output structure (structured data only — one skill + params):**

Response is always structured data: one skill and its parameters. There is no separate "respond" action — replying to the user is the **create_a_response** skill (you might call it "send_to_ai"). All actions are skills.

Examples:

```json
{ "skill": "create_a_response" }
```
(General chat / no other skill fits. No params; the user message is the input to create_a_response.)

```json
{ "skill": "send_to_contact", "from": "Jon", "to": "Cara", "ai_prompt": "say hello and tell her today will be a good day" }
```
(Generate a message to Cara from Jon using the ai_prompt; send it to Cara; tell the receiver who it's from.)

```json
{ "skill": "weather", "location": "43130", "day": "tomorrow" }
```

```json
{ "skill": "todo", "action": "list" }
```

```json
{ "skill": "change_personality", "instruction": "talk like a pirate" }
```

**Rules:**
- Exactly one skill per response.
- Params must match that skill's schema (from registry).
- For send_to_contact: **from** = sender identity (e.g. "Jon"), **to** = contact first name (e.g. "Cara"), **ai_prompt** = instructions for the AI to generate the message to the receiver.

---

## 3. Run skill

**Trigger:** After "what to do?" returns skill + params.

Execute the chosen skill (script or inline LLM) with the given params. Each skill has its own prompt file under `prompts/skills/<skill_id>.md` that defines:
- What input the skill receives.
- What output structure it returns: a **response** (the reply or data) and optional **hints** for the create_response step (e.g. todo skill includes actual todo ids in the response so create_response can reference them). With examples.

Skills include: **create_a_response**, **send_to_contact**, **weather**, **brave**, **todo**, **change_personality**, etc.

**Todo skill** (`prompts/skills/todo.md`): List shows task **id** (ascending), **verbatim** text, creator. By default list shows only **open** tasks; use `show_done: true` when the user asks for completed tasks. **add_many**: when the user provides a list of tasks (e.g. "add these: buy milk, call mom, wash the car"), use action `add_many` with `items: [{ text }, …]` to add them in one go. On the **user's own list**, approximate language is allowed: e.g. "everybody is fed" → mark_done with `match_phrase` matching "Feed the dog". On **another person's list** (`for_contact`), the user must be explicit (e.g. "mark Carrie's task #4 as done"); do not infer from vague praise. Creator is tracked by user id (can differ from assignee). For specific times use the reminder skill. Output: `{ response, hints?: { todo_ids } }`.

---

## 4. Send to contact (skill)

**Trigger:** When "what to do?" returns `skill: "send_to_contact"` with `from`, `to`, `ai_prompt`.

We generate **two** messages — one for the recipient, one for the sender — each with its **own prompt file**.

**4a. Message to recipient**

**Prompt file:** `prompts/skills/send_to_contact_recipient.md`

**Input to AI:**
- `from` — who the message is from (e.g. "Jon").
- `to` — recipient first name (e.g. "Cara").
- `ai_prompt` — instructions for the message (e.g. "say hello and one reason today will be good").
- For tone/context: personality, facts, summary, recent_conversations, conversation_summary (this is what applies the personality).

**Output structure:**
- A single message body (text) to send to the recipient.
- **The message must tell the receiver who it is from** (e.g. "Jon says: Hello! Today’s going to be a good day because …" or "From Jon: …").

**Result:** Send that message to the contact (Telegram if they have telegram_id, else iMessage). Reply to sender: e.g. "Okay, sent that to Cara."

---

## 5. Create response (skill)

**Trigger:** When "what to do?" returns `skill: "create_a_response"`, or after any other skill when we need to turn skill output into a user-facing reply.

**Prompt file:** `prompts/create_response.md`

**Input to AI:**
- User message.
- Skill output (raw stdout from the skill, or the send_to_contact message body if we already generated it), plus any **hints** the skill returned (e.g. todo ids so the reply can reference "todo #3").
- **Personality, facts, summary, recent_conversations, conversation_summary** — for tone and context. This is what applies the personality to the response.

**Output structure:**
- A single reply string to send to the user(s). No JSON unless we explicitly want structured multi-recipient output.
- For most skills: friendly, concise reply (e.g. for weather: "Tomorrow in 43130: sunny, high 72. Have a good one!").
- For create_a_response used as “general chat”: the reply is the main response to the user.

**Result:** This string is what we send back to the user (or users) in the final step.

---

## 6. Per-skill output and “create response”

- **create_a_response** when chosen as the skill: one LLM call with conversation + message → reply text. No separate “skill output” step.
- Other skills (weather, todo, brave, etc.): they return a **response** (the main output) and optional **hints** for the create_response step. For example, the todo skill should list actual todo ids in its response so create_response can reference them (e.g. "Here are your todos: #1 Buy milk, #2 Call Mom"). We always run **create response** on that output: input = user message + skill response + hints + personality/facts/summary/recent_conversations/conversation_summary, output = reply text to send. Every path goes through the same “create response” prompt for consistency.

Each skill's prompt file specifies its output structure (response + optional hints). For send_to_contact we use two prompts: one for the recipient message, one for the sender ack.

---

## 7. Conversation summary (replace, not append)

**Trigger:** After each exchange (or every N messages). Separate activity.

**Prompt file:** `prompts/summary.md`

**Input to AI:**
- **current_summary** — the existing summary text (truncated highlight of prior context).
- **recent_conversations** — last K messages (user and assistant) from this conversation.

**Output structure:**
- **Input:** current_summary + recent_conversations. Combine those into a **single summary** that **replaces** current_summary (we do not append sentences).
- **High impact, high energy, or high emotion events should be remembered longer** — the prompt instructs the model to weight those more in the summary (e.g. “User shared that Cara is 9” or “User was upset about X” stays visible longer; trivial chitchat compresses or drops).

**Result:** Replace the stored summary with this new summary. Cap total length (e.g. max 500 chars or N sentences) so context stays bounded.

---

## 8. Request ID and logging

- **request_id:** Each new conversation turn (each run through the pipeline) gets a unique **request_id**. All data created by that run (facts saved, summary updated, messages sent) is linked to that request_id.
- **Log all prompts and responses:** Every prompt sent to the AI and every response received must be logged. Each log entry is associated with:
  - **request_id**
  - **step** — which step of the flow (e.g. fact_finding, what_to_do, run_skill, create_response, summary).
- Use this for debugging, auditing, and replay. Stored data (e.g. in DB or log files) should allow reconstructing what was sent and what was returned at each step for a given request.

---

## Implementation checklist

| Step | Description |
|------|-------------|
| 1 | Add **prompt files**: `prompts/fact_finding.md`, `prompts/what_to_do.md`, `prompts/create_response.md`, `prompts/summary.md`, `prompts/skills/<skill_id>.md` for each skill. Each file defines input and output structure with examples. |
| 2 | **Workflow:** new message → fact finding → what to do? → run skill → create response → send response to user(s). Wire router to this order. |
| 3 | **What to do?** returns only one skill + params. No separate “respond”; use skill **create_a_response** for direct replies. Output examples: `{ "skill": "create_a_response" }`, `{ "skill": "send_to_contact", "from": "Jon", "to": "Cara", "ai_prompt": "say hello" }`. |
| 4 | **send_to_contact** skill: two prompts — `send_to_contact_recipient.md` (message to recipient; must say who it's from) and `send_to_contact_sender.md` (ack to sender). Params: from, to, ai_prompt. |
| 5 | **create_response** used after every skill (or as the main reply when skill is create_a_response). One prompt file. Input must include: personality, facts, summary, recent_conversations, conversation_summary (this applies the personality). |
| 6 | **Skills** return a response and optional hints for create_response (e.g. todo skill lists actual todo ids so the reply can reference them). |
| 7 | **Summary:** input = current_summary + recent_conversations; output = one replacement summary; high-impact/high-emotion events remembered longer. |
| 8 | **Logging:** Each conversation turn has a **request_id**. Log every prompt sent to the AI and every response; associate each with request_id and step (fact_finding, what_to_do, run_skill, create_response, summary). Link data created by the request (facts, summary, messages) to request_id. |
| 9 | Register all skills (create_a_response, send_to_contact, change_personality, weather, brave, todo, …) with entrypoints and, where needed, link to `prompts/skills/<id>.md`. |

---

## File / code touch points

- **Prompt files:** `prompts/fact_finding.md`, `prompts/what_to_do.md`, `prompts/create_response.md`, `prompts/summary.md`, `prompts/skills/*.md`. Each specifies input and output structure with examples.
- **Router** (`scripts/router.ts`): Run pipeline in order: fact finding → what to do? → run skill → create response → send response. Load prompts from `.md` files. Assign request_id per turn; log every prompt and response with request_id and step.
- **Skills registry** (DB): Each skill has an id and optional prompt file path; params schema comes from registry or prompt file. Skills return response + optional hints.
- **Memory/summary** (`src/memory.ts`, DB): Summary is a single replaceable blob; read current_summary, pass with recent_conversations to summary prompt, write back replacement.
- **Request/logging** (DB or log files): Store request_id; log prompts and responses keyed by request_id and step; link persisted data (facts, summary, messages) to request_id.

This keeps the flow obvious: **facts → decision (one skill + params) → run skill → create response → send**, with one prompt file per activity and clear input/output contracts.
