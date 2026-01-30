import type { IMessageSDK } from "@photon-ai/imessage-kit";
import { spawn } from "node:child_process";

const SELF_HANDLE = process.env.BO_MY_PHONE ?? process.env.BO_MY_EMAIL;

/** Script or command that receives the message as first arg and prints the response to stdout. */
const AGENT_SCRIPT = process.env.BO_AGENT_SCRIPT?.trim();

/** Message guids we sent (our replies). Never react to these. */
const sentMessageGuids = new Set<string>();

/** Exact reply texts we just sent (belt-and-suspenders: skip if watcher reports our message without isFromMe). */
const recentSentReplyTexts = new Set<string>();
const recentSentReplyOrder: string[] = [];
const MAX_RECENT_SENT = 50;

function normalizePhone(s: string): string {
  return s.replace(/\D/g, "");
}

/** US numbers: 11 digits starting with 1 → use last 10 so +16143480678 matches 6143480678. */
function canonicalPhone(s: string): string {
  const digits = normalizePhone(s);
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits;
}

/** Optional: when any of these numbers send a message, we pass it to the agent and reply (any chat). Comma-separated. */
function getAgentNumbers(): Set<string> {
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
  if (!SELF_HANDLE) return false;
  return chatId === SELF_HANDLE || chatId.endsWith(SELF_HANDLE) || chatId.includes(SELF_HANDLE);
}

/** Ensure we never send a message that starts with "Bo" (so we don't trigger ourselves). */
function sanitizeReply(reply: string): string {
  const r = reply.trim();
  if (r.toLowerCase().startsWith("bo")) {
    return "→ " + r;
  }
  return r;
}

function runAgent(message: string, ctxEnv: Record<string, string>): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    if (!AGENT_SCRIPT) {
      resolve({
        stdout: "",
        stderr: "Set BO_AGENT_SCRIPT to a script that accepts the message as first arg and prints the response.",
        code: 1,
      });
      return;
    }
    // Don't use shell: true—apostrophes etc. in the message would break the command. Pass args directly.
    const proc = spawn("/bin/bash", [AGENT_SCRIPT, message], {
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

export async function runWatchSelf(sdk: IMessageSDK, _args: string[]): Promise<void> {
  if (!SELF_HANDLE) {
    console.error("Set BO_MY_PHONE or BO_MY_EMAIL so we know the self-chat. Example: BO_MY_PHONE=+1234567890");
    process.exit(1);
  }

  if (!AGENT_SCRIPT) {
    console.error("Set BO_AGENT_SCRIPT to a script that accepts the message as first arg and prints the response.");
    process.exit(1);
  }

  console.error("[bo watch-self] Only messages starting with 'Bo' (plus text) are passed to the agent; replies never start with 'Bo'.");
  if (AGENT_NUMBERS.size > 0) {
    console.error(`[bo watch-self] Self-chat or from ${[...AGENT_NUMBERS].join(", ")}: same rule — must start with 'Bo'.\n`);
  } else {
    console.error("");
  }

  await sdk.startWatching({
    onMessage: async (msg) => {
      const text = (msg.text ?? "").trim();
      const isSelf = isSelfChat(msg.chatId) && msg.isFromMe;
      const isFromAllowed = AGENT_NUMBERS.size > 0 ? isFromAgentNumber(msg.sender) : false;

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
          `From: ${msg.sender}`,
          `Message: ${text || "(empty)"}`,
          `Pass to agent: ${passToAgent ? "Yes" : "No"}`,
          `Why: ${why}`,
        ].join("\n")
      );

      if (msg.isReaction) return;

      const guid = msg.guid ?? msg.id;
      if (!guid) return;

      if (sentMessageGuids.has(guid)) return;
      if (text && recentSentReplyTexts.has(text)) return;

      let messageToAgent: string;
      let replyTo: string;

      if (isSelf) {
        if (!text.toLowerCase().startsWith("bo")) return;
        messageToAgent = text.slice(2).trim();
        replyTo = SELF_HANDLE;
      } else if (isFromAllowed) {
        if (!text.toLowerCase().startsWith("bo") || !text.slice(2).trim()) return;
        messageToAgent = text.slice(2).trim();
        replyTo = msg.sender;
      } else {
        return;
      }

      if (!messageToAgent) return;

      // Provide request context to the agent/router via env.
      // Enable router debug so prompts/responses are printed to stderr when running the loop.
      const ctxEnv: Record<string, string> = {
        BO_REQUEST_FROM: msg.sender ?? "",
        BO_REQUEST_TO: msg.chatId ?? "",
        BO_REQUEST_IS_SELF_CHAT: isSelf ? "true" : "false",
        BO_REQUEST_IS_FROM_ME: msg.isFromMe ? "true" : "false",
        BO_ROUTER_DEBUG: "1",
      };

      const { stdout, stderr, code } = await runAgent(messageToAgent, ctxEnv);
      let reply = code === 0 ? (stdout || "Done.") : (stderr || `Exit ${code}`);
      if (reply.length > 2000) reply = reply.slice(0, 1997) + "...";
      reply = sanitizeReply(reply);

      // Record reply text BEFORE sending so the watcher never processes our own message (race-safe).
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
    },
    onError: (err) => {
      console.error("[bo watch-self] error:", err);
    },
  });

  // Keep process alive; startWatching() returns after registering the watcher
  await new Promise<never>(() => {});
}
