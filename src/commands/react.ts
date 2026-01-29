import type { IMessageSDK } from "@photon-ai/imessage-kit";

const REACTION_TYPES = ["love", "like", "dislike", "laugh", "emphasize", "question"] as const;

function parseArgs(args: string[]): {
  list: boolean;
  limit: number;
  send: { messageGuid: string; type: string } | null;
} {
  let list = false;
  let limit = 50;
  let send: { messageGuid: string; type: string } | null = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--list") list = true;
    else if (arg === "--limit" && args[i + 1] != null) limit = parseInt(args[++i], 10) || 50;
    else if (arg === "send" && args[i + 1] != null && args[i + 2] != null) {
      send = { messageGuid: args[i + 1], type: args[i + 2] };
      i += 2;
    }
  }

  return { list, limit, send };
}

export async function runReact(sdk: IMessageSDK, args: string[]): Promise<void> {
  const { list, limit, send } = parseArgs(args);

  if (send) {
    console.error(
      "Sending tapbacks is not supported by the base iMessage Kit (AppleScript has no API for it). " +
        "To send reactions you need Photon's advanced-imessage-kit or a helper like BlueBubbles. " +
        "For now you can only list reactions with: bo react --list"
    );
    process.exit(1);
  }

  if (list) {
    const result = await sdk.getMessages({ limit });
    const withReactions = result.messages.filter(
      (m) => m.isReaction || (m.reactionType != null && m.reactionType !== "")
    );
    const out = withReactions.map((m) => ({
      id: m.guid ?? m.id,
      text: m.text,
      reactionType: m.reactionType ?? null,
      isReactionRemoval: m.isReactionRemoval ?? false,
      associatedMessageGuid: m.associatedMessageGuid ?? null,
      sender: m.sender,
      date: m.date?.toISOString?.() ?? m.date,
    }));
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  // Default: show help for react
  console.log(`
bo react — list or (future) send tapback reactions

Usage:
  bo react --list [--limit N]   List messages that have reactions (default limit 50)
  bo react send <guid> <type>   Not yet supported (needs advanced-imessage-kit)

Reaction types: ${REACTION_TYPES.join(", ")}
`);
}
