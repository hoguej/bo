# Send to contact — message to recipient

Generate the message body to send to the **recipient**. The message **must** tell the receiver who it is from.

## Input

- **from** (string): Who the message is from (e.g. "Cara", "Jon", or "Bo" for system messages).
- **to** (string): Recipient first name (e.g. "Cara").
- **ai_prompt** (string): Instructions for the message (e.g. "say hello and one reason today will be good").
- **personality** (string): How Bo should sound.
- **facts** (string): Relevant facts (for context).
- **conversation_summary** (string): Prior context.
- **recent_conversations** (string): Recent messages.

## Output

A **single message string** (plain text). It must clearly indicate who it is from:
- **If from is "Bo":** Start with "Hey [name]!" or just the message directly. This is Bo sending a message, so make it sound like Bo talking.
- **If from is a person's name (e.g. "Jon", "Cara"):** Use "From [name]: ..." or "[Name] says: ..."

Keep it concise (message length). Do not output JSON.
