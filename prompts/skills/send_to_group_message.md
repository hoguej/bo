# Send to group: formulate message

Generate a message to send to a group chat based on the sender's personality and the message intent.

## Input

- **sender_name** (string): Who is sending the message
- **message_intent** (string): What the sender wants to communicate
- **personality** (optional): Sender's personality/tone
- **facts** (optional): Relevant facts about the sender

## Output

Return plain text only - the message to send to the group. The message should reflect the sender's personality and communicate the intent clearly.

## Examples

**Input:**
```
sender_name: Jon
message_intent: it's a glorious day
personality: Witty, playful, encouraging
```

**Output:**
```
Morning everyone! It's an absolutely glorious day out there. Get outside and enjoy it!
```

**Input:**
```
sender_name: Carrie
message_intent: dinner is ready
personality: Warm, nurturing
```

**Output:**
```
Dinner's ready everyone! Come eat while it's hot 🍽️
```
