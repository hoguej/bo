import type { IMessageSDK } from "@photon-ai/imessage-kit";

function parseArgs(args: string[]): { limit: number; unread: boolean } {
  let limit = 20;
  let unread = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--limit" && args[i + 1] != null) {
      limit = parseInt(args[++i], 10) || 20;
    } else if (args[i] === "--unread") {
      unread = true;
    }
  }
  return { limit, unread };
}

export async function runListChats(sdk: IMessageSDK, args: string[]): Promise<void> {
  const { limit, unread } = parseArgs(args);

  const chats = await sdk.listChats({
    limit,
    hasUnread: unread ? true : undefined,
    sortBy: "recent",
  });

  const out = chats.map((c) => ({
    chatId: c.chatId,
    displayName: c.displayName,
    isGroup: c.isGroup,
    unreadCount: c.unreadCount,
  }));

  console.log(JSON.stringify(out, null, 2));
}
