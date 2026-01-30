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

function getSelfHandle(): string | undefined {
  const p = dbGetPrimaryUserPhone();
  if (p) return toE164(p);
  return process.env.BO_MY_PHONE ?? process.env.BO_MY_EMAIL ?? undefined;
}

/** Script or command that receives the message as first arg and prints the response to stdout. */
function getAgentScript(): string | undefined {
  return dbGetConfig("agent_script")?.trim() ?? process.env.BO_AGENT_SCRIPT?.trim() ?? undefined;
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

const NUMBER_TO_NAME = getNumberToName();

function senderDisplay(sender: string): string {
  const canonical = canonicalPhone(sender);
  const name = NUMBER_TO_NAME.get(canonical);
  return name ? `${name} (${canonical})` : sender;
}

/** Optional: when any of these numbers send a message, we pass it to the agent and reply (any chat). From users.can_trigger_agent or env. */
function getAgentNumbers(): Set<string> {
  const fromDb = dbGetPhoneNumbersThatCanTriggerAgent();
  if (fromDb.length > 0) return new Set(fromDb);
  const raw = process.env.BO_AGENT_NUMBERS ?? process.env.BO_AGENT_NUMBER ?? "";
  const set = new Set<string>();
  for (const s of raw.split(",")) {
    const n = canonicalPhone(s.trim());
    if (n) set.add(n);
  }
  return set;
}
const AGENT_NUMBERS = getAgentNumbers();

function isFromAgentNumber(sender: string): boolean {
  if (AGENT_NUMBERS.size === 0) return false;
  return AGENT_NUMBERS.has(canonicalPhone(sender));
}

function isSelfChat(chatId: string): boolean {
  const self = getSelfHandle();
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

/** Create and configure Telegram bot; call bot.start() to run long polling (same process as iMessage watcher). Pass sdk so Telegram handler can send to contacts via iMessage when they have no telegram_id. */
function createTelegramBot(sdk: IMessageSDK): Bot | null {
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
    const text = (ctx.message?.text ?? "").trim();
    const from = ctx.from;
    if (!from?.id) return;
    const telegramId = String(from.id);
    const owner = "telegram:" + telegramId;

    if (/^\/(start|myid|id)(\s|$)/i.test(text)) return; // Handled by command handlers; skip agent

    const userId = dbGetUserIdByTelegramId(telegramId);
    if (userId == null) {
      if (telegramUnknownRateLimit(telegramId)) return; // DOS: drop silently
      console.error(`[bo telegram] unknown telegram_id=${telegramId} text="${text.slice(0, 200)}${text.length > 200 ? "…" : ""}"`);
      return;
    }

    if (Date.now() - lastReplyAt < REPLY_RATE_LIMIT_MS) return;

    const script = getAgentScript();
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
    console.error(`[bo telegram] [req:${requestId}] invoking agent (${text.length} chars) from telegram_id=${telegramId}`);
    const { stdout, stderr, code } = await runAgent(text, ctxEnv);
    if (code !== 0 && stderr?.trim()) {
      console.error(`[bo telegram] [req:${requestId}] agent stderr: ${stderr.trim().slice(0, 300)}`);
    }
    const stdoutStr = (stdout ?? "").trim();
    let reply = code !== 0 ? (stderr || `Exit ${code}`) : stdoutStr;
    if (stdoutStr && code === 0) {
      const firstLine = stdoutStr.split("\n")[0] ?? "";
      try {
        const parsed = JSON.parse(firstLine) as Record<string, unknown>;
        const sendTo = typeof parsed.sendTo === "string" ? parsed.sendTo.trim() : "";
        const sendBody = typeof parsed.sendBody === "string" ? parsed.sendBody.trim() : "";
        const replyToSender = typeof parsed.replyToSender === "string" ? parsed.replyToSender.trim() : "";
        const sendToTelegramId = typeof parsed.sendToTelegramId === "string" ? parsed.sendToTelegramId.trim() : "";
        if (sendTo && sendBody && replyToSender) {
          const bodyToSend = sanitizeReply(sendBody.length > 4000 ? sendBody.slice(0, 3997) + "..." : sendBody);
          const replyText = sanitizeReply(replyToSender.length > 4000 ? replyToSender.slice(0, 3997) + "..." : replyToSender);
          if (sendToTelegramId) {
            await bot.api.sendMessage(sendToTelegramId, bodyToSend);
          } else {
            await sdk.send(toE164(sendTo), bodyToSend);
          }
          await ctx.reply(replyText);
          lastReplyAt = Date.now();
          return;
        }
        if (typeof parsed.response_text === "string") reply = parsed.response_text.trim();
        else if (typeof parsed.replyToSender === "string") reply = parsed.replyToSender.trim();
      } catch {
        /* use full stdout */
      }
    }
    if (reply.length > 4000) reply = reply.slice(0, 3997) + "...";
    await ctx.reply(reply);
    lastReplyAt = Date.now();
  });

  return bot;
}

function runAgent(message: string, ctxEnv: Record<string, string>): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const script = getAgentScript();
    if (!script) {
      resolve({
        stdout: "",
        stderr: "Set config agent_script in admin or BO_AGENT_SCRIPT to a script that accepts the message as first arg and prints the response.",
        code: 1,
      });
      return;
    }
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
  const text = (msg.text ?? "").trim();
  const isSelf = isSelfChat(msg.chatId ?? "") && msg.isFromMe;
  const isFromAllowed = AGENT_NUMBERS.size > 0 ? isFromAgentNumber(msg.sender ?? "") : false;

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
      `From: ${senderDisplay(msg.sender ?? "")}`,
      `Message: ${text || "(empty)"}`,
      `Pass to agent: ${passToAgent ? "Yes" : "No"}`,
      `Why: ${why}`,
    ].join("\n")
  );

  if (msg.isReaction) return;

  const guid = msg.guid ?? msg.id;
  if (!guid) return;

  if (dbHasRepliedToMessage(guid)) return;
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
  const firstLine = stdoutStr.split("\n")[0] ?? "";
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
      lastReplyAt = Date.now();
    } else {
      recentSentReplyTexts.add(bodyToSend);
      recentSentReplyOrder.push(bodyToSend);
      while (recentSentReplyOrder.length > MAX_RECENT_SENT) {
        const old = recentSentReplyOrder.shift()!;
        recentSentReplyTexts.delete(old);
      }
      if (sendToTelegramId && telegramBotInstance) {
        await telegramBotInstance.api.sendMessage(sendToTelegramId, bodyToSend);
      } else {
        const resultToContact = await sdk.send(toE164(sendToContact), bodyToSend);
        if (resultToContact.message?.guid) sentMessageGuids.add(resultToContact.message.guid);
      }
      const resultToSender = await sdk.send(replyTo, reply);
      if (resultToSender.message?.guid) sentMessageGuids.add(resultToSender.message.guid);
      if (!resultToSender.message?.guid) {
        const recent = await sdk.getMessages({ chatId: replyTo, limit: 1 });
        const latest = recent.messages[0];
        if (latest?.isFromMe && latest.guid) sentMessageGuids.add(latest.guid);
      }
      dbMarkMessageReplied(guid);
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
    lastReplyAt = Date.now();
  }
}

export async function runWatchSelf(sdk: IMessageSDK, _args: string[]): Promise<void> {
  if (!getSelfHandle()) {
    console.error("Set config primary_user_id in admin, or BO_MY_PHONE or BO_MY_EMAIL for self-chat. Example: BO_MY_PHONE=+1234567890");
    process.exit(1);
  }

  if (!getAgentScript()) {
    console.error("Set config agent_script in admin or BO_AGENT_SCRIPT to a script that accepts the message as first arg and prints the response.");
    process.exit(1);
  }

  console.error("[bo watch-self] Only messages starting with 'Bo' (plus text) are passed to the agent; replies never start with 'Bo'.");
  if (AGENT_NUMBERS.size > 0) {
    console.error(`[bo watch-self] Self-chat or from ${[...AGENT_NUMBERS].join(", ")}: same rule — must start with 'Bo'.\n`);
  } else {
    console.error("");
  }

  telegramBotInstance = createTelegramBot(sdk);
  if (telegramBotInstance) {
    console.error("[bo watch-self] Telegram bot enabled (BO_TELEGRAM_BOT_TOKEN set). Send /myid to your bot to get your Telegram ID, then set users.telegram_id in admin.");
    void telegramBotInstance.start();
  }

  await sdk.startWatching({
    onMessage: async (msg) => {
      await handleIncomingMessage(msg as MessageLike, sdk);
    },
    onError: (err) => {
      console.error("[bo watch-self] error:", err);
    },
  });

  // Keep process alive; startWatching() returns after registering the watcher
  await new Promise<never>(() => {});
}
