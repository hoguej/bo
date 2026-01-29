import type { IMessageSDK } from "@photon-ai/imessage-kit";

function parseArgs(args: string[]): {
  limit: number;
  unread: boolean;
  sender: string | undefined;
  chatId: string | undefined;
  search: string | undefined;
} {
  let limit = 20;
  let unread = false;
  let sender: string | undefined;
  let chatId: string | undefined;
  let search: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--limit" && args[i + 1] != null) {
      limit = parseInt(args[++i], 10) || 20;
    } else if (arg === "--unread") {
      unread = true;
    } else if (arg === "--sender" && args[i + 1] != null) {
      sender = args[++i];
    } else if (arg === "--chat" && args[i + 1] != null) {
      chatId = args[++i];
    } else if (arg === "--search" && args[i + 1] != null) {
      search = args[++i];
    }
  }

  return { limit, unread, sender, chatId, search };
}

export async function runGetMessages(sdk: IMessageSDK, args: string[]): Promise<void> {
  const opts = parseArgs(args);

  if (opts.unread) {
    const unread = await sdk.getUnreadMessages();
    console.log(JSON.stringify({ total: unread.total, senderCount: unread.senderCount, bySender: unread.bySender }, null, 2));
    return;
  }

  const result = await sdk.getMessages({
    limit: opts.limit,
    sender: opts.sender,
    chatId: opts.chatId,
    search: opts.search,
  });

  const out = result.messages.map((m) => ({
    id: m.guid ?? m.id,
    text: m.text,
    sender: m.sender,
    senderName: m.senderName,
    isFromMe: m.isFromMe,
    isRead: m.isRead,
    date: m.date?.toISOString?.() ?? m.date,
    isReaction: m.isReaction,
    reactionType: m.reactionType ?? null,
    chatId: m.chatId,
  }));

  console.log(JSON.stringify(out, null, 2));
}
