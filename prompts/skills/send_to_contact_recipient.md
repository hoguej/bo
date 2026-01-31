# Send to contact — message to recipient

Generate the message body to send to the **recipient**. The message **must** tell the receiver who it is from.

## Input

- **from** (string): Who the message is from (e.g. "Jon").
- **to** (string): Recipient first name (e.g. "Cara").
- **ai_prompt** (string): Instructions for the message (e.g. "say hello and one reason today will be good").
- **personality** (string): How Bo should sound.
- **facts** (string): Relevant facts (for context).
- **conversation_summary** (string): Prior context.
- **recent_conversations** (string): Recent messages.

## Output

A **single message string** (plain text). It must clearly indicate who it is from, e.g.:
- "Jon says: Hello! Today's going to be a good day because …"
- "From Jon: …"

Keep it concise (message length). Do not output JSON.
