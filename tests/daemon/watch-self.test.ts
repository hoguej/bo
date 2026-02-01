/**
 * Daemon watch-self unit tests: helpers and stdout parsing.
 * No Telegram or iMessage; no DB required for these.
 */

import { describe, it, expect } from "bun:test";

/** Mirror of sanitizeReply from watch-self: never send reply starting with "Bo". */
function sanitizeReply(reply: string): string {
  const r = reply.trim();
  if (r.toLowerCase().startsWith("bo")) {
    return "→ " + r;
  }
  return r;
}

/** Mirror of Telegram unknown-sender rate limit logic. */
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

/** Parse router stdout lines: JSON response_text, JSON sendTo+sendBody, plain text. */
function parseRouterStdout(stdout: string): {
  finalReplyText: string | null;
  messagesToSend: Array<{ sendTo?: string; sendBody: string; replyToSender: string; sendToTelegramId?: string; sendToGroup?: string }>;
  plainTextLines: string[];
} {
  const lines = stdout.split("\n").filter((l) => l.trim());
  const messagesToSend: Array<{ sendTo?: string; sendBody: string; replyToSender: string; sendToTelegramId?: string; sendToGroup?: string }> = [];
  let finalReplyText: string | null = null;
  const plainTextLines: string[] = [];

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (typeof parsed.sendToGroup === "string" && typeof parsed.sendBody === "string") {
        messagesToSend.push({
          sendToGroup: parsed.sendToGroup.trim(),
          sendBody: parsed.sendBody.trim(),
          replyToSender: typeof parsed.replyToSender === "string" ? parsed.replyToSender.trim() : "",
        });
      } else if (typeof parsed.sendTo === "string" && typeof parsed.sendBody === "string") {
        const msg: { sendTo?: string; sendBody: string; replyToSender: string; sendToTelegramId?: string; sendToGroup?: string } = {
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
      plainTextLines.push(line);
    }
  }

  if (!finalReplyText && plainTextLines.length > 0) {
    finalReplyText = plainTextLines.join("\n");
  }

  return { finalReplyText, messagesToSend, plainTextLines };
}

describe("daemon watch-self helpers", () => {
  describe("sanitizeReply", () => {
    it("prefixes reply that starts with Bo", () => {
      expect(sanitizeReply("Bo says hi")).toBe("→ Bo says hi");
      expect(sanitizeReply("bo")).toBe("→ bo");
    });

    it("leaves other replies unchanged", () => {
      expect(sanitizeReply("Hey there")).toBe("Hey there");
      expect(sanitizeReply("  Done.  ")).toBe("Done.");
    });
  });

  describe("telegramUnknownRateLimit", () => {
    it("allows requests under the limit", () => {
      const id = "test-" + Date.now();
      for (let i = 0; i < 5; i++) {
        expect(telegramUnknownRateLimit(id)).toBe(false);
      }
    });

    it("blocks after TELEGRAM_UNKNOWN_RATE_MAX in window", () => {
      const id = "test-cap-" + Date.now();
      for (let i = 0; i < TELEGRAM_UNKNOWN_RATE_MAX; i++) {
        telegramUnknownRateLimit(id);
      }
      expect(telegramUnknownRateLimit(id)).toBe(true);
    });
  });

  describe("parseRouterStdout", () => {
    it("extracts final reply from plain text only", () => {
      const out = "Hello!\nHow can I help?";
      const { finalReplyText, messagesToSend } = parseRouterStdout(out);
      expect(finalReplyText).toBe("Hello!\nHow can I help?");
      expect(messagesToSend.length).toBe(0);
    });

    it("extracts response_text from JSON line", () => {
      const out = '{"response_text":"Hi there!"}';
      const { finalReplyText, messagesToSend } = parseRouterStdout(out);
      expect(finalReplyText).toBe("Hi there!");
      expect(messagesToSend.length).toBe(0);
    });

    it("extracts sendTo + sendBody messages", () => {
      const out = '{"sendTo":"+15551234567","sendBody":"Hello Cara","replyToSender":"Sent."}';
      const { finalReplyText, messagesToSend } = parseRouterStdout(out);
      expect(messagesToSend.length).toBe(1);
      expect(messagesToSend[0].sendTo).toBe("+15551234567");
      expect(messagesToSend[0].sendBody).toBe("Hello Cara");
      expect(messagesToSend[0].replyToSender).toBe("Sent.");
    });

    it("uses plain text as final reply when no JSON response_text", () => {
      const out = '{"sendTo":"x","sendBody":"y","replyToSender":"ok"}\nGot it.';
      const { finalReplyText, messagesToSend } = parseRouterStdout(out);
      expect(messagesToSend.length).toBe(1);
      expect(finalReplyText).toBe("Got it.");
    });
  });
});
