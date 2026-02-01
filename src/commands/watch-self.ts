import type { IMessageSDK } from "@photon-ai/imessage-kit";
import { Bot } from "grammy";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { getNumberToName } from "../contacts";
import {
  dbGetConfig,
  dbGetUserIdByTelegramId,
  dbGetPhoneNumbersThatCanTriggerAgent,
  dbGetPrimaryUserPhone,
  dbHasRepliedToMessage,
  dbMarkMessageReplied,
  dbResolveOwnerToUserId,
  dbUpdateLastConvoEndUtc,
  dbGetScheduleState,
  dbUpsertScheduleState,
  dbGetUserTimezone,
  dbGetDueReminders,
  dbMarkReminderSentOneOff,
  dbAdvanceRecurringReminder,
  dbGetOwnerByUserId,
  dbGetTodos,
  dbGetAllUsers,
  dbGetUserById,
  dbUpsertGroupChat,
  dbGetGroupChatByName,
} from "../db";
import { canonicalPhone, toE164 } from "../phone";

/** Message-like object from watcher or getMessages (minimal shape we use). */
type MessageLike = {
  text?: string | null;
  sender?: string | null;
  chatId?: string | null;
  isFromMe?: boolean;
  isReaction?: boolean;
  guid?: string | null;
  id?: string | null;
  date?: Date;
};

function newRequestId(): string {
  return randomBytes(4).toString("hex");
}

async function getSelfHandle(): Promise<string | undefined> {
  const p = await dbGetPrimaryUserPhone();
  if (p) return toE164(p);
  return process.env.BO_MY_PHONE ?? process.env.BO_MY_EMAIL ?? undefined;
}

/** Script or command that receives the message as first arg and prints the response to stdout. */
async function getAgentScript(): Promise<string | undefined> {
  const config = await dbGetConfig("agent_script");
  return config?.trim() ?? process.env.BO_AGENT_SCRIPT?.trim() ?? undefined;
}

/** Message guids we sent (our replies). Never react to these. */
const sentMessageGuids = new Set<string>();

/** Incoming message guids we already processed (avoid double reply when watcher fires twice). */
const processedMessageGuids = new Set<string>();
const processedMessageOrder: string[] = [];
const MAX_PROCESSED = 100;

/** Recently processed (replyTo, messageToAgent) to avoid double reply when same message delivered with different guids. */
const processedMessageKeys = new Set<string>();
const processedMessageKeyOrder: string[] = [];
const MAX_PROCESSED_KEYS = 100;

/** Recently processed message body (normalized) so same text from different chats/senders only runs once. */
const recentlyProcessedBodies = new Set<string>();
const recentlyProcessedBodiesOrder: string[] = [];
const MAX_RECENT_BODIES = 50;

/** Exact reply texts we just sent (belt-and-suspenders: skip if watcher reports our message without isFromMe). */
const recentSentReplyTexts = new Set<string>();
const recentSentReplyOrder: string[] = [];
const MAX_RECENT_SENT = 50;

/** Only send one reply every REPLY_RATE_LIMIT_MS; ignore messages that come in faster. */
const REPLY_RATE_LIMIT_MS = 3000;
let lastReplyAt = 0;

/** DOS: unknown Telegram senders — max requests per minute per sender; above threshold drop silently (no log). */
const TELEGRAM_UNKNOWN_RATE_MAX = 20;
const TELEGRAM_UNKNOWN_RATE_WINDOW_MS = 60_000;
const telegramUnknownBySender = new Map<string, number[]>();

function telegramUnknownRateLimit(telegramId: string): boolean {
  const now = Date.now();
  const cutoff = now - TELEGRAM_UNKNOWN_RATE_WINDOW_MS;
  let list = telegramUnknownBySender.get(telegramId) ?? [];
  list = list.filter((t) => t >= cutoff);
  if (list.length >= TELEGRAM_UNKNOWN_RATE_MAX) return true;
  list.push(now);
  telegramUnknownBySender.set(telegramId, list);
  return false;
}

function senderDisplay(sender: string, numberToName: Map<string, string>): string {
  const canonical = canonicalPhone(sender);
  const name = numberToName.get(canonical);
  return name ? `${name} (${canonical})` : sender;
}

/** Optional: when any of these numbers send a message, we pass it to the agent and reply (any chat). From users.can_trigger_agent or env. */
async function getAgentNumbers(): Promise<Set<string>> {
  const fromDb = await dbGetPhoneNumbersThatCanTriggerAgent();
  if (fromDb.length > 0) return new Set(fromDb);
  const raw = process.env.BO_AGENT_NUMBERS ?? process.env.BO_AGENT_NUMBER ?? "";
  const set = new Set<string>();
  for (const s of raw.split(",")) {
    const n = canonicalPhone(s.trim());
    if (n) set.add(n);
  }
  return set;
}
function isFromAgentNumber(sender: string, agentNumbers: Set<string>): boolean {
  if (agentNumbers.size === 0) return false;
  return agentNumbers.has(canonicalPhone(sender));
}

async function isSelfChat(chatId: string): Promise<boolean> {
  const self = await getSelfHandle();
  if (!self) return false;
  return chatId === self || chatId.endsWith(self) || chatId.includes(self);
}

/** Ensure we never send a message that starts with "Bo" (so we don't trigger ourselves). */
function sanitizeReply(reply: string): string {
  const r = reply.trim();
  if (r.toLowerCase().startsWith("bo")) {
    return "→ " + r;
  }
  return r;
}

/** Stored so handleIncomingMessage can send to contacts via Telegram when sendToTelegramId is set. */
let telegramBotInstance: Bot | null = null;

/** Create and configure Telegram bot; call bot.start() to run long polling. */
function createTelegramBot(): Bot | null {
  const token = process.env.BO_TELEGRAM_BOT_TOKEN?.trim();
  if (!token) return null;
  const bot = new Bot(token);

  const replyWithTelegramId = (ctx: { from?: { id?: number }; reply: (text: string) => Promise<unknown> }) => {
    const id = ctx.from?.id;
    if (id != null) {
      ctx.reply(`Your Telegram ID is ${id}. Add this to your user in the admin (users.telegram_id) to use the agent.`);
    }
  };
  bot.command("start", replyWithTelegramId);
  bot.command("myid", replyWithTelegramId);
  bot.command("id", replyWithTelegramId);

  bot.on("message:text", async (ctx) => {
    let text = (ctx.message?.text ?? "").trim();
    const from = ctx.from;
    if (!from?.id) return;
    const telegramId = String(from.id);
    const owner = "telegram:" + telegramId;
    
    // Check if this is a group chat
    const chatType = ctx.chat?.type;
    const isGroup = chatType === "group" || chatType === "supergroup";
    
    // In groups, store/update group chat info
    if (isGroup && ctx.chat) {
      const chatId = String(ctx.chat.id);
      const chatTitle = ctx.chat.title || `Group ${chatId}`;
      dbUpsertGroupChat(chatId, chatTitle, chatType);
    }
    
    // In groups, only respond if message starts with "Bo " (case-insensitive)
    if (isGroup) {
      const boPrefix = /^bo\s+/i;
      if (!boPrefix.test(text)) return; // Not for us, ignore
      text = text.replace(boPrefix, "").trim(); // Remove "Bo " prefix
      
      // Replace "everyone", "everybody", "all" with actual group member names
      if (/\b(everyone|everybody|all)\b/i.test(text)) {
        try {
          const chatId = ctx.chat.id;
          const memberNames: string[] = [];
          
          // Get all users from database who have telegram_ids
          const allUsers = dbGetAllUsers();
          const seenInGroup = new Set<number>();
          
          // Try to verify which users are actually in this group
          for (const user of allUsers) {
            if (!user.telegram_id) continue;
            const memberId = user.telegram_id.replace(/^telegram:/, "");
            if (memberId === String(bot.botInfo.id)) continue; // Skip the bot itself
            
            // Try to get member status (will fail if not in group)
            try {
              await bot.api.getChatMember(chatId, Number(memberId));
              // If we got here, they're in the group
              seenInGroup.add(user.id);
              if (user.first_name) {
                memberNames.push(user.first_name);
              }
            } catch {
              // Not in group or error, skip
            }
          }
          
          if (memberNames.length > 0) {
            const namesList = memberNames.join(", ");
            text = text.replace(/\b(everyone|everybody|all)\b/gi, namesList);
            console.error(`[bo telegram] Expanded "everyone" to: ${namesList}`);
          }
        } catch (err) {
          console.error(`[bo telegram] Failed to expand "everyone": ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    if (/^\/(start|myid|id)(\s|$)/i.test(text)) return; // Handled by command handlers; skip agent

    const userId = await dbGetUserIdByTelegramId(telegramId);
    if (userId == null) {
      if (telegramUnknownRateLimit(telegramId)) return; // DOS: drop silently
      console.error(`[bo telegram] unknown telegram_id=${telegramId} text="${text.slice(0, 200)}${text.length > 200 ? "…" : ""}"`);
      return;
    }

    if (Date.now() - lastReplyAt < REPLY_RATE_LIMIT_MS) return;

    const script = await getAgentScript();
    if (!script) {
      await ctx.reply("Agent script not configured.");
      return;
    }

    const requestId = newRequestId();
    const ctxEnv: Record<string, string> = {
      BO_REQUEST_ID: requestId,
      BO_REQUEST_FROM: owner,
      BO_REQUEST_TO: "telegram",
      BO_REQUEST_IS_SELF_CHAT: "false",
      BO_REQUEST_IS_FROM_ME: "false",
      BO_ROUTER_DEBUG: "1",
    };
    const chatInfo = isGroup ? ` (group: ${ctx.chat.title || ctx.chat.id})` : "";
    console.error(`[bo telegram] [req:${requestId}] invoking agent (${text.length} chars) from telegram_id=${telegramId}${chatInfo}`);
    const { stdout, stderr, code } = await runAgent(text, ctxEnv);
    if (code !== 0 && stderr?.trim()) {
      console.error(`[bo telegram] [req:${requestId}] agent stderr: ${stderr.trim().slice(0, 300)}`);
    }
    const stdoutStr = (stdout ?? "").trim();
    const lines = stdoutStr.split("\n").filter(l => l.trim());
    
    // Parse all lines for JSON payloads (multi-recipient support + group messages)
    type MessagePayload = { 
      sendTo?: string; 
      sendBody: string; 
      replyToSender: string; 
      sendToTelegramId?: string;
      sendToGroup?: string; // group chat_id
    };
    const messagesToSend: MessagePayload[] = [];
    let finalReplyText: string | null = null;
    const plainTextLines: string[] = [];
    
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        // Group message
        if (
          typeof parsed.sendToGroup === "string" &&
          typeof parsed.sendBody === "string"
        ) {
          const msg: MessagePayload = {
            sendToGroup: parsed.sendToGroup.trim(),
            sendBody: parsed.sendBody.trim(),
            replyToSender: typeof parsed.replyToSender === "string" ? parsed.replyToSender.trim() : "",
          };
          messagesToSend.push(msg);
        }
        // Contact message
        else if (
          typeof parsed.sendTo === "string" &&
          typeof parsed.sendBody === "string"
        ) {
          const msg: MessagePayload = {
            sendTo: parsed.sendTo.trim(),
            sendBody: parsed.sendBody.trim(),
            replyToSender: typeof parsed.replyToSender === "string" ? parsed.replyToSender.trim() : "",
          };
          if (typeof parsed.sendToTelegramId === "string" && parsed.sendToTelegramId.trim()) {
            msg.sendToTelegramId = parsed.sendToTelegramId.trim();
          }
          messagesToSend.push(msg);
        } else if (typeof parsed.response_text === "string") {
          finalReplyText = parsed.response_text.trim();
        }
      } catch {
        // Not JSON, treat as plain text reply
        if (code === 0) plainTextLines.push(line);
      }
    }
    
    // If we collected plain text lines and no finalReplyText from JSON, use them
    if (!finalReplyText && plainTextLines.length > 0) {
      finalReplyText = plainTextLines.join("\n");
    }
    
    // If we have messages to send, send them all and use the last replyToSender or finalReplyText as ack
    if (messagesToSend.length > 0) {
      for (const msg of messagesToSend) {
        const bodyToSend = sanitizeReply(msg.sendBody.length > 4000 ? msg.sendBody.slice(0, 3997) + "..." : msg.sendBody);
        if (!bodyToSend.trim()) continue; // Skip empty messages
        
        // Send to group chat
        if (msg.sendToGroup) {
          await bot.api.sendMessage(msg.sendToGroup, bodyToSend);
        }
        // Send to individual via Telegram
        else if (msg.sendToTelegramId) {
          await bot.api.sendMessage(msg.sendToTelegramId, bodyToSend);
        } else {
          console.error(`[bo telegram] Recipient ${msg.sendTo} has no telegram_id, cannot send (Telegram-only mode)`);
        }
      }
      
      const lastReplyToSender = messagesToSend[messagesToSend.length - 1]?.replyToSender || finalReplyText || "Done.";
      const reply = sanitizeReply(lastReplyToSender.length > 4000 ? lastReplyToSender.slice(0, 3997) + "..." : lastReplyToSender);
      if (reply.trim()) {
        await ctx.reply(reply);
      }
      lastReplyAt = Date.now();
      if (userId != null) dbUpdateLastConvoEndUtc(userId);
      return;
    }
    
    // Fallback: plain text reply
    let reply = code !== 0 ? (stderr || `Exit ${code}`) : (finalReplyText || stdoutStr);
    if (reply.length > 4000) reply = reply.slice(0, 3997) + "...";
    await ctx.reply(reply);
    lastReplyAt = Date.now();
    if (userId != null) dbUpdateLastConvoEndUtc(userId);
  });

  return bot;
}

async function runAgent(message: string, ctxEnv: Record<string, string>): Promise<{ stdout: string; stderr: string; code: number }> {
  const script = await getAgentScript();
  if (!script) {
    return {
      stdout: "",
      stderr: "Set config agent_script in admin or BO_AGENT_SCRIPT to a script that accepts the message as first arg and prints the response.",
      code: 1,
    };
  }

  return new Promise((resolve) => {
    // Don't use shell: true—apostrophes etc. in the message would break the command. Pass args directly.
    const proc = spawn("/bin/bash", [script, message], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...ctxEnv },
    });
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (d) => (stdout += d.toString()));
    // Pipe agent stderr (router prompts/responses) to terminal so user sees them.
    proc.stderr?.on("data", (d) => {
      const s = d.toString();
      stderr += s;
      process.stderr.write(s);
    });
    proc.on("close", (code) => resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code: code ?? 0 }));
  });
}

/** Process one incoming message (shared by real-time watcher and catch-up). */
async function handleIncomingMessage(msg: MessageLike, sdk: IMessageSDK): Promise<void> {
  const [numberToName, agentNumbers, isSelfChatResult] = await Promise.all([
    getNumberToName(),
    getAgentNumbers(),
    isSelfChat(msg.chatId ?? ""),
  ]);
  const text = (msg.text ?? "").trim();
  const isSelf = isSelfChatResult && msg.isFromMe;
  const isFromAllowed = agentNumbers.size > 0 ? isFromAgentNumber(msg.sender ?? "", agentNumbers) : false;

  let passToAgent: boolean;
  let why: string;
  if (msg.isReaction) {
    passToAgent = false;
    why = "ignoring tapback/reaction";
  } else if (msg.isFromMe) {
    passToAgent = false;
    why = "we sent this message; never reply to our own (cardinal rule)";
  } else if (sentMessageGuids.has(msg.guid ?? msg.id ?? "")) {
    passToAgent = false;
    why = "we sent this message; never reply to our own";
  } else if (text && recentSentReplyTexts.has(text)) {
    passToAgent = false;
    why = "message text matches our recent reply; never reply to our own (cardinal rule)";
  } else if (isSelf) {
    if (text.toLowerCase().startsWith("bo") && text.slice(2).trim()) {
      passToAgent = true;
      why = "self-chat message starting with 'Bo' with non-empty rest";
    } else if (!text.toLowerCase().startsWith("bo")) {
      passToAgent = false;
      why = "self-chat message does not start with 'Bo'";
    } else {
      passToAgent = false;
      why = "self-chat 'Bo' with no text after it";
    }
  } else if (isFromAllowed) {
    if (text.toLowerCase().startsWith("bo") && text.slice(2).trim()) {
      passToAgent = true;
      why = `from allowed number ${msg.sender}, message starts with 'Bo'`;
    } else if (!text.toLowerCase().startsWith("bo")) {
      passToAgent = false;
      why = "from allowed number but message does not start with 'Bo'";
    } else {
      passToAgent = false;
      why = "from allowed number but 'Bo' with no text after it";
    }
  } else {
    passToAgent = false;
    why = "not self-chat and sender not in BO_AGENT_NUMBERS";
  }

  console.log(
    [
      "---",
      `To: ${msg.chatId}`,
      `From: ${senderDisplay(msg.sender ?? "", numberToName)}`,
      `Message: ${text || "(empty)"}`,
      `Pass to agent: ${passToAgent ? "Yes" : "No"}`,
      `Why: ${why}`,
    ].join("\n")
  );

  if (msg.isReaction) return;

  const guid = msg.guid ?? msg.id;
  if (!guid) return;

  if (await dbHasRepliedToMessage(guid)) return;
  if (sentMessageGuids.has(guid)) return;
  if (text && recentSentReplyTexts.has(text)) return;
  if (processedMessageGuids.has(guid)) return;

  processedMessageGuids.add(guid);
  processedMessageOrder.push(guid);
  if (processedMessageOrder.length > MAX_PROCESSED) {
    const old = processedMessageOrder.shift()!;
    processedMessageGuids.delete(old);
  }

  let messageToAgent: string;
  let replyTo: string;

  if (isSelf) {
    if (!text.toLowerCase().startsWith("bo")) return;
    messageToAgent = text.slice(2).trim();
    replyTo = getSelfHandle()!;
  } else if (isFromAllowed) {
    if (!text.toLowerCase().startsWith("bo") || !text.slice(2).trim()) return;
    messageToAgent = text.slice(2).trim();
    replyTo = msg.sender ?? "";
  } else {
    return;
  }

  if (!messageToAgent) return;

  const bodyKey = messageToAgent.trim().toLowerCase();
  if (recentlyProcessedBodies.has(bodyKey)) return;
  recentlyProcessedBodies.add(bodyKey);
  recentlyProcessedBodiesOrder.push(bodyKey);
  if (recentlyProcessedBodiesOrder.length > MAX_RECENT_BODIES) {
    const old = recentlyProcessedBodiesOrder.shift()!;
    recentlyProcessedBodies.delete(old);
  }

  const senderKey = isSelf ? canonicalPhone(getSelfHandle() ?? "") || "self" : canonicalPhone(msg.sender ?? "");
  const dedupeKey = `${senderKey}:${messageToAgent}`;
  if (processedMessageKeys.has(dedupeKey)) return;
  processedMessageKeys.add(dedupeKey);
  processedMessageKeyOrder.push(dedupeKey);
  if (processedMessageKeyOrder.length > MAX_PROCESSED_KEYS) {
    const old = processedMessageKeyOrder.shift()!;
    processedMessageKeys.delete(old);
  }

  if (Date.now() - lastReplyAt < REPLY_RATE_LIMIT_MS) {
    console.error(`[bo watch-self] rate limit: ignoring message (replies limited to once per ${REPLY_RATE_LIMIT_MS / 1000}s)`);
    return;
  }

  const recipientUserId = dbResolveOwnerToUserId(replyTo);
  if (recipientUserId != null) dbUpdateLastConvoEndUtc(recipientUserId);

  const requestId = newRequestId();
  const ctxEnv: Record<string, string> = {
    BO_REQUEST_ID: requestId,
    BO_REQUEST_FROM: msg.sender ?? "",
    BO_REQUEST_TO: msg.chatId ?? "",
    BO_REQUEST_IS_SELF_CHAT: isSelf ? "true" : "false",
    BO_REQUEST_IS_FROM_ME: msg.isFromMe ? "true" : "false",
    BO_ROUTER_DEBUG: "1",
  };

  console.error(`[bo watch-self] [req:${requestId}] invoking agent (${messageToAgent.length} chars): "${messageToAgent.slice(0, 80)}${messageToAgent.length > 80 ? "…" : ""}"`);

  const { stdout, stderr, code } = await runAgent(messageToAgent, ctxEnv);

  console.error(`[bo watch-self] [req:${requestId}] agent finished exitCode=${code} stdoutLen=${(stdout ?? "").length} stderrLen=${(stderr ?? "").length}`);
  if (code !== 0 && stderr?.trim()) {
    console.error(`[bo watch-self] [req:${requestId}] agent stderr: ${stderr.trim().slice(0, 500)}${stderr.length > 500 ? "…" : ""}`);
  }

  const stdoutStr = (stdout ?? "").trim();
  const lines = stdoutStr.split("\n").filter(l => l.trim());
  
  // Parse all lines for JSON payloads (multi-recipient support)
  type MessagePayload = { sendTo: string; sendBody: string; replyToSender: string; sendToTelegramId?: string };
  const messagesToSend: MessagePayload[] = [];
  let finalReplyText: string | null = null;
  
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (
        typeof parsed.sendTo === "string" &&
        typeof parsed.sendBody === "string"
      ) {
        const msg: MessagePayload = {
          sendTo: parsed.sendTo.trim(),
          sendBody: parsed.sendBody.trim(),
          replyToSender: typeof parsed.replyToSender === "string" ? parsed.replyToSender.trim() : "",
        };
        if (typeof parsed.sendToTelegramId === "string" && parsed.sendToTelegramId.trim()) {
          msg.sendToTelegramId = parsed.sendToTelegramId.trim();
        }
        messagesToSend.push(msg);
      }
    } catch {
      // Not JSON, treat as plain text reply
      if (code === 0 && !finalReplyText) finalReplyText = line;
    }
  }

  // If we have messages to send, send them all and use the last replyToSender or finalReplyText as ack
  if (messagesToSend.length > 0) {
    const lastReplyToSender = messagesToSend[messagesToSend.length - 1]?.replyToSender || finalReplyText || "Done.";
    const reply = sanitizeReply(lastReplyToSender.length > 2000 ? lastReplyToSender.slice(0, 1997) + "..." : lastReplyToSender);
    
    recentSentReplyTexts.add(reply);
    recentSentReplyOrder.push(reply);
    if (recentSentReplyOrder.length > MAX_RECENT_SENT) {
      const old = recentSentReplyOrder.shift()!;
      recentSentReplyTexts.delete(old);
    }
    
    // Send to all recipients (Telegram only)
    for (const msg of messagesToSend) {
      const bodyToSend = sanitizeReply(msg.sendBody.length > 2000 ? msg.sendBody.slice(0, 1997) + "..." : msg.sendBody);
      if (!bodyToSend.trim()) continue; // Skip empty messages
      
      recentSentReplyTexts.add(bodyToSend);
      recentSentReplyOrder.push(bodyToSend);
      while (recentSentReplyOrder.length > MAX_RECENT_SENT) {
        const old = recentSentReplyOrder.shift()!;
        recentSentReplyTexts.delete(old);
      }
      
      // Telegram only - no iMessage sends to contacts
      if (msg.sendToTelegramId && telegramBotInstance) {
        await telegramBotInstance.api.sendMessage(msg.sendToTelegramId, bodyToSend);
      } else {
        console.error(`[bo watch-self] Recipient ${msg.sendTo} has no telegram_id, cannot send (Telegram-only mode)`);
      }
    }
    
    // Send acknowledgement to original sender
    if (reply.trim()) {
      const resultToSender = await sdk.send(replyTo, reply);
      if (resultToSender.message?.guid) sentMessageGuids.add(resultToSender.message.guid);
      if (!resultToSender.message?.guid) {
        const recent = await sdk.getMessages({ chatId: replyTo, limit: 1 });
        const latest = recent.messages[0];
        if (latest?.isFromMe && latest.guid) sentMessageGuids.add(latest.guid);
      }
    }
    dbMarkMessageReplied(guid);
    if (recipientUserId != null) dbUpdateLastConvoEndUtc(recipientUserId);
    lastReplyAt = Date.now();
    return;
  }

  // Fallback: old single-recipient logic
  const firstLine = lines[0] ?? "";
  let sendToContact: string | null = null;
  let sendBody: string | null = null;
  let replyToSender: string | null = null;
  let sendToTelegramId: string | null = null;
  if (code === 0 && firstLine) {
    try {
      const parsed = JSON.parse(firstLine) as Record<string, unknown>;
      if (
        typeof parsed.sendTo === "string" &&
        typeof parsed.sendBody === "string" &&
        typeof parsed.replyToSender === "string"
      ) {
        sendToContact = parsed.sendTo.trim();
        sendBody = parsed.sendBody.trim();
        replyToSender = parsed.replyToSender.trim();
        if (typeof parsed.sendToTelegramId === "string" && parsed.sendToTelegramId.trim())
          sendToTelegramId = parsed.sendToTelegramId.trim();
      }
    } catch {
      /* not JSON */
    }
  }

  if (sendToContact && sendBody !== null && replyToSender !== null) {
    const bodyToSend = sanitizeReply(sendBody.length > 2000 ? sendBody.slice(0, 1997) + "..." : sendBody);
    const reply = sanitizeReply(replyToSender.length > 2000 ? replyToSender.slice(0, 1997) + "..." : replyToSender);
    recentSentReplyTexts.add(reply);
    recentSentReplyOrder.push(reply);
    if (recentSentReplyOrder.length > MAX_RECENT_SENT) {
      const old = recentSentReplyOrder.shift()!;
      recentSentReplyTexts.delete(old);
    }
    const sendToNorm = canonicalPhone(sendToContact);
    const replyToNorm = canonicalPhone(replyTo);
    const sameRecipient = !sendToTelegramId && sendToNorm && replyToNorm && sendToNorm === replyToNorm;
    if (sameRecipient) {
      recentSentReplyTexts.add(bodyToSend);
      recentSentReplyOrder.push(bodyToSend);
      while (recentSentReplyOrder.length > MAX_RECENT_SENT) {
        const old = recentSentReplyOrder.shift()!;
        recentSentReplyTexts.delete(old);
      }
      const resultToSender = await sdk.send(replyTo, reply);
      if (resultToSender.message?.guid) sentMessageGuids.add(resultToSender.message.guid);
      if (!resultToSender.message?.guid) {
        const recent = await sdk.getMessages({ chatId: replyTo, limit: 1 });
        const latest = recent.messages[0];
        if (latest?.isFromMe && latest.guid) sentMessageGuids.add(latest.guid);
      }
      dbMarkMessageReplied(guid);
      if (recipientUserId != null) dbUpdateLastConvoEndUtc(recipientUserId);
      lastReplyAt = Date.now();
    } else {
      recentSentReplyTexts.add(bodyToSend);
      recentSentReplyOrder.push(bodyToSend);
      while (recentSentReplyOrder.length > MAX_RECENT_SENT) {
        const old = recentSentReplyOrder.shift()!;
        recentSentReplyTexts.delete(old);
      }
      // Telegram only - no iMessage sends to contacts
      if (sendToTelegramId && telegramBotInstance) {
        await telegramBotInstance.api.sendMessage(sendToTelegramId, bodyToSend);
      } else {
        console.error(`[bo watch-self] Recipient ${sendToContact} has no telegram_id, cannot send (Telegram-only mode)`);
      }
      const resultToSender = await sdk.send(replyTo, reply);
      if (resultToSender.message?.guid) sentMessageGuids.add(resultToSender.message.guid);
      if (!resultToSender.message?.guid) {
        const recent = await sdk.getMessages({ chatId: replyTo, limit: 1 });
        const latest = recent.messages[0];
        if (latest?.isFromMe && latest.guid) sentMessageGuids.add(latest.guid);
      }
      dbMarkMessageReplied(guid);
      if (recipientUserId != null) dbUpdateLastConvoEndUtc(recipientUserId);
      lastReplyAt = Date.now();
    }
  } else {
    let reply = code === 0 ? (stdoutStr || "Done.") : (stderr || `Exit ${code}`);
    if (reply.length > 2000) reply = reply.slice(0, 1997) + "...";
    reply = sanitizeReply(reply);
    recentSentReplyTexts.add(reply);
    recentSentReplyOrder.push(reply);
    if (recentSentReplyOrder.length > MAX_RECENT_SENT) {
      const old = recentSentReplyOrder.shift()!;
      recentSentReplyTexts.delete(old);
    }
    const result = await sdk.send(replyTo, reply);
    if (result.message?.guid) {
      sentMessageGuids.add(result.message.guid);
    } else {
      const recent = await sdk.getMessages({ chatId: replyTo, limit: 1 });
      const latest = recent.messages[0];
      if (latest?.isFromMe && latest.guid) {
        sentMessageGuids.add(latest.guid);
      }
    }
    dbMarkMessageReplied(guid);
    if (recipientUserId != null) dbUpdateLastConvoEndUtc(recipientUserId);
    lastReplyAt = Date.now();
  }
}

/** User-local date (YYYY-MM-DD) and time (HH:mm) in IANA timezone. */
function getLocalDateAndTime(tz: string): { date: string; hour: number; minute: number } {
  const now = new Date();
  const datePart = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const [y, m, d] = datePart.split("-").map(Number);
  const date = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const timePart = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(now);
  const [hour, minute] = timePart.split(":").map(Number);
  return { date, hour, minute };
}

/** Next fire for recurring: 24h from now (refinable later to snap to recurrence time in user TZ). */
function getNextFireRecurring(): string {
  return new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
}

const SCHEDULER_INTERVAL_MS = 1 * 60 * 1000; // 1 minute for precise reminder firing
const DAILY_STARTER_HOUR = 9;
const DAILY_STARTER_MINUTE = 30;
const NUDGE_WINDOW_START = { hour: 9, minute: 30 };
const NUDGE_WINDOW_END = { hour: 20, minute: 0 };

async function runSchedulerTick(bot: Bot | null): Promise<void> {
  const primaryUserIdStr = (await dbGetConfig("primary_user_id"))?.trim();
  if (!primaryUserIdStr) return;
  const primaryUserId = parseInt(primaryUserIdStr, 10);
  if (Number.isNaN(primaryUserId)) return;
  const owner = await dbGetOwnerByUserId(primaryUserId);
  const tz = await dbGetUserTimezone(primaryUserId);
  const state = await dbGetScheduleState(primaryUserId);
  const { date: todayLocal, hour, minute } = getLocalDateAndTime(tz);
  const nowIso = new Date().toISOString();

  const script = await getAgentScript();
  if (!script) return;

  const ctxEnv: Record<string, string> = {
    BO_REQUEST_ID: newRequestId(),
    BO_REQUEST_FROM: owner,
    BO_REQUEST_TO: "scheduler",
    BO_REQUEST_IS_SELF_CHAT: "true",
    BO_REQUEST_IS_FROM_ME: "false",
    BO_ROUTER_DEBUG: "1",
  };

  const localMinutes = hour * 60 + minute;
  const windowStartMinutes = NUDGE_WINDOW_START.hour * 60 + NUDGE_WINDOW_START.minute;
  const windowEndMinutes = NUDGE_WINDOW_END.hour * 60 + NUDGE_WINDOW_END.minute;
  const isInWindow = localMinutes >= windowStartMinutes && localMinutes < windowEndMinutes;
  const isAfterDailyStarter = localMinutes >= DAILY_STARTER_HOUR * 60 + DAILY_STARTER_MINUTE;

  if (isInWindow && state?.last_convo_end_utc) {
    const lastConvoMs = new Date(state.last_convo_end_utc).getTime();
    const fourHoursMs = 4 * 60 * 60 * 1000;
    const lastNudgeDate = state.last_4h_nudge_date ?? "";
    if (Date.now() - lastConvoMs >= fourHoursMs && lastNudgeDate < todayLocal) {
      const syntheticMessage = `[scheduled: 4h_nudge] It's been a while since we chatted—send a short, friendly nudge.`;
      console.error(`[bo watch-self] scheduler: firing 4h_nudge for user ${primaryUserId}`);
      const { stdout, stderr, code } = await runAgent(syntheticMessage, ctxEnv);
      if (code === 0 && stdout?.trim()) {
        await sendSchedulerReply(stdout.trim(), owner, primaryUserId, bot);
        dbUpsertScheduleState(primaryUserId, { last_4h_nudge_date: todayLocal });
      } else if (stderr?.trim()) {
        console.error(`[bo watch-self] scheduler 4h_nudge stderr: ${stderr.trim().slice(0, 300)}`);
      }
    }
  }

  const openTodos = await dbGetTodos(owner, { includeDone: false });
  if (
    openTodos.length > 0 &&
    isAfterDailyStarter &&
    (!state?.last_daily_todos_date || state.last_daily_todos_date < todayLocal)
  ) {
    const syntheticMessage = `[scheduled: daily_todos] Remind the user of their open todos and list them all.`;
    console.error(`[bo watch-self] scheduler: firing daily_todos for user ${primaryUserId} (${openTodos.length} open)`);
    const dailyTodosEnv = { ...ctxEnv, BO_SCHEDULED_DAILY_TODOS: "1" };
    const { stdout, stderr, code } = await runAgent(syntheticMessage, dailyTodosEnv);
    if (code === 0 && stdout?.trim()) {
      await sendSchedulerReply(stdout.trim(), owner, primaryUserId, bot);
      dbUpsertScheduleState(primaryUserId, { last_daily_todos_date: todayLocal });
    } else if (stderr?.trim()) {
      console.error(`[bo watch-self] scheduler daily_todos stderr: ${stderr.trim().slice(0, 300)}`);
    }
  }

  const dueReminders = await dbGetDueReminders(nowIso);
  for (const rem of dueReminders) {
    const recipientOwner = dbGetOwnerByUserId(rem.recipient_user_id);
    const remCtxEnv = { ...ctxEnv, BO_REQUEST_FROM: recipientOwner };
    const syntheticMessage = `[scheduled: reminder] ${rem.text}`;
    console.error(`[bo watch-self] scheduler: firing reminder #${rem.id} for recipient ${rem.recipient_user_id}`);
    const { stdout, stderr, code } = await runAgent(syntheticMessage, remCtxEnv);
    if (code === 0 && stdout?.trim()) {
      await sendSchedulerReply(stdout.trim(), recipientOwner, rem.recipient_user_id, bot);
      if (rem.kind === "one_off") {
        dbMarkReminderSentOneOff(rem.id);
      } else {
        dbAdvanceRecurringReminder(rem.id, getNextFireRecurring());
      }
    } else if (stderr?.trim()) {
      console.error(`[bo watch-self] scheduler reminder #${rem.id} stderr: ${stderr.trim().slice(0, 300)}`);
    }
  }
}

async function sendSchedulerReply(
  stdoutStr: string,
  owner: string,
  _userId: number,
  bot: Bot | null
): Promise<void> {
  const firstLine = stdoutStr.split("\n")[0] ?? "";
  let body = stdoutStr;
  try {
    const parsed = JSON.parse(firstLine) as Record<string, unknown>;
    if (parsed.suppress_reply === true) return;
    if (typeof parsed.response_text === "string") body = parsed.response_text.trim();
    else if (typeof parsed.replyToSender === "string") body = parsed.replyToSender.trim();
  } catch {
    /* use full stdout */
  }
  body = sanitizeReply(body.length > 4000 ? body.slice(0, 3997) + "..." : body);
  
  // Telegram only
  if (owner.startsWith("telegram:")) {
    const tid = owner.slice(9);
    if (tid && bot) {
      await bot.api.sendMessage(tid, body);
    }
  } else {
    console.error(`[bo watch-self] Scheduler reply for ${owner} skipped (not a telegram: owner, Telegram-only mode)`);
  }
}

export async function runWatchSelf(_sdk: IMessageSDK, _args: string[]): Promise<void> {
  if (!await getAgentScript()) {
    console.error("Set config agent_script in admin or BO_AGENT_SCRIPT to a script that accepts the message as first arg and prints the response.");
    process.exit(1);
  }

  console.error("[bo watch-self] Telegram-only mode. iMessage monitoring disabled.");

  telegramBotInstance = createTelegramBot();
  if (!telegramBotInstance) {
    console.error("[bo watch-self] ERROR: BO_TELEGRAM_BOT_TOKEN not set. Telegram bot required.");
    process.exit(1);
  }
  
  // Graceful shutdown handler
  let isShuttingDown = false;
  const shutdown = async () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.error("[bo watch-self] Shutting down gracefully...");
    if (telegramBotInstance) {
      await telegramBotInstance.stop();
      console.error("[bo watch-self] Telegram bot stopped");
    }
    process.exit(0);
  };
  
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  
  console.error("[bo watch-self] Telegram bot enabled. Send /myid to your bot to get your Telegram ID, then set users.telegram_id in admin.");
  void telegramBotInstance.start();

  // Run scheduler tick immediately on startup, then every interval
  void runSchedulerTick(telegramBotInstance);
  const schedulerInterval = setInterval(() => {
    void runSchedulerTick(telegramBotInstance);
  }, SCHEDULER_INTERVAL_MS);
  console.error("[bo watch-self] Scheduler started (interval " + SCHEDULER_INTERVAL_MS / 60000 + " min).");

  // Health check endpoint for Railway
  const port = process.env.PORT || 3000;
  const server = Bun.serve({
    port,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/health") {
        return new Response("OK", { status: 200 });
      }
      return new Response("Not Found", { status: 404 });
    },
  });
  console.error(`[bo watch-self] Health check server listening on port ${port}`);

  // Keep process alive
  await new Promise<never>(() => {});
}
