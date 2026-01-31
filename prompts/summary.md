# Conversation summary

Combine the current summary and recent conversations into a **single summary** that **replaces** the current one. Do not append sentences; produce one coherent summary.

## Input

- **current_summary** (string): Existing summary text (prior context).
- **recent_conversations** (string): Last K messages (user and assistant) from this conversation.

## Output

A **single summary string** (plain text, not JSON). It should:
- Fold in the new exchange with prior context.
- Weight **high impact, high energy, or high emotion** events more — keep them visible longer (e.g. "User shared that Cara is 9", "User was upset about X").
- Compress or drop trivial chitchat.
- Stay within ~500 characters (or a few sentences) so context stays bounded.

Replace the stored summary with this new summary entirely; do not append.
