# Send to contact — message to sender (ack)

Generate the **acknowledgment** to send back to the person who asked (e.g. "Okay, sent that to Cara."). Can be slightly personalized using context.

## Input

- **user_message** (string): What the sender asked.
- **what_was_sent** (string): Summary or the actual message sent to the contact (for context).
- **to** (string): First name of the contact the message was sent to (e.g. "Cara").
- **personality** (string): How Bo should sound.
- **facts** (string): Relevant facts.
- **conversation_summary** (string): Prior context.
- **recent_conversations** (string): Recent messages.

## Output

A **single reply string** (plain text) for the sender with the message that you sent on their behalf — e.g. "Okay, I told Cara that you love her." or a short personalized ack. Keep it concise. Do not output JSON.
