import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  dbAppendConversation,
  dbAppendPersonalityInstruction,
  dbAppendSummarySentence,
  dbDeleteFact,
  dbGetConversation,
  dbGetFacts,
  dbGetPersonality,
  dbGetSummary,
  dbUpsertFact,
} from "./db";
import { canonicalPhone } from "./phone";

export type FactScope = "global" | "user";

export type Fact = {
  key: string;
  value: string;
  scope: FactScope;
  tags: string[];
  createdAt: string; // ISO
  updatedAt: string; // ISO
};

type MemoryFile = {
  version: 1;
  facts: Fact[];
};

const DEFAULT_MEMORY_DIR = join(homedir(), ".bo");
const DEFAULT_MEMORY_PATH = join(DEFAULT_MEMORY_DIR, "memory.json");

/** Owner "default" = self / primary user. Other owners = canonical 10-digit or "telegram:<id>". Pass through telegram:<id>; do not map to default. */
export function normalizeOwner(sender: string | undefined): string {
  const trimmed = (sender ?? "").trim();
  if (trimmed.startsWith("telegram:")) return trimmed;
  const c = canonicalPhone(trimmed || "default");
  return c === "default" || c.length < 10 ? "default" : c;
}

/** Path for a given owner. default = primary (memory.json). Others = memory_<owner>.json. */
export function getMemoryPathForOwner(owner: string | undefined): string {
  const baseDir = process.env.BO_MEMORY_PATH?.trim()
    ? dirname(process.env.BO_MEMORY_PATH!)
    : DEFAULT_MEMORY_DIR;
  if (!owner || owner === "default") {
    return process.env.BO_MEMORY_PATH?.trim() ?? DEFAULT_MEMORY_PATH;
  }
  return join(baseDir, `memory_${owner}.json`);
}

/** Path for conversation history per owner. default = conversation.json; others = conversation_<owner>.json. */
export function getConversationPathForOwner(owner: string | undefined): string {
  const baseDir = process.env.BO_MEMORY_PATH?.trim()
    ? dirname(process.env.BO_MEMORY_PATH!)
    : DEFAULT_MEMORY_DIR;
  if (!owner || owner === "default") return join(baseDir, "conversation.json");
  return join(baseDir, `conversation_${owner}.json`);
}

/** Path for high-level conversation summary per owner. summary_<owner>.json. */
export function getSummaryPathForOwner(owner: string | undefined): string {
  const baseDir = process.env.BO_MEMORY_PATH?.trim()
    ? dirname(process.env.BO_MEMORY_PATH!)
    : DEFAULT_MEMORY_DIR;
  if (!owner || owner === "default") return join(baseDir, "summary.json");
  return join(baseDir, `summary_${owner}.json`);
}

/** Resolve memory path to owner id (for DB lookups). */
function pathToOwner(path: string): string {
  const base = path.split(/[/\\]/).pop() ?? "";
  if (base === "memory.json") return "default";
  const m = base.match(/^memory_(.+)\.json$/);
  return m ? m[1]! : "default";
}

/** Append one high-level summary sentence (from LLM). Keeps last MAX_SUMMARY_SENTENCES. */
export function appendSummarySentence(owner: string | undefined, sentence: string): void {
  dbAppendSummarySentence(normalizeOwner(owner), sentence.trim());
}

/** Get the running summary for prompt context (oldest first). */
export function getSummaryForPrompt(owner: string | undefined): string {
  return dbGetSummary(normalizeOwner(owner));
}

/** Path for per-user personality instructions. personality_<owner>.json. */
export function getPersonalityPathForOwner(owner: string | undefined): string {
  const baseDir = process.env.BO_MEMORY_PATH?.trim()
    ? dirname(process.env.BO_MEMORY_PATH!)
    : DEFAULT_MEMORY_DIR;
  if (!owner || owner === "default") return join(baseDir, "personality.json");
  return join(baseDir, `personality_${owner}.json`);
}

/** Append one or more personality instructions. If the string contains ". " we split and append each part (LLM sometimes returns combined list). Per-user; accumulates up to MAX_PERSONALITY_INSTRUCTIONS. */
export function appendPersonalityInstruction(owner: string | undefined, instruction: string): void {
  dbAppendPersonalityInstruction(normalizeOwner(owner), instruction);
}

/** Get personality instructions for this user for prompt context. */
export function getPersonalityForPrompt(owner: string | undefined): string {
  return dbGetPersonality(normalizeOwner(owner));
}

export type ConversationMessage = { role: "user" | "assistant"; content: string };

/** Default 20 (~10 turns). Override with BO_CONVERSATION_MESSAGES (2–100). */
export function getMaxConversationMessages(): number {
  const n = process.env.BO_CONVERSATION_MESSAGES?.trim();
  if (!n) return 20;
  const parsed = parseInt(n, 10);
  return Number.isFinite(parsed) && parsed >= 2 && parsed <= 100 ? parsed : 20;
}
const MAX_CONVERSATION_MESSAGES = getMaxConversationMessages();

/** Last N messages (oldest first) for context. */
export function getRecentMessages(owner: string | undefined, max: number = MAX_CONVERSATION_MESSAGES): ConversationMessage[] {
  const rows = dbGetConversation(normalizeOwner(owner), max);
  return rows.map((r) => ({ role: r.role as "user" | "assistant", content: r.content }));
}

/** Append one user and one assistant message, then trim to MAX_CONVERSATION_MESSAGES. Keeps last N messages (both user and Bo's responses) for context. */
export function appendConversation(
  owner: string | undefined,
  userContent: string,
  assistantContent: string
): void {
  dbAppendConversation(normalizeOwner(owner), userContent, assistantContent, getMaxConversationMessages());
}

export function getMemoryPath(): string {
  return getMemoryPathForOwner("default");
}

/** Load facts from DB for the owner implied by path. Used by getRelevantFacts/getAllFacts etc. */
export function loadMemory(path: string = getMemoryPath()): MemoryFile {
  const owner = pathToOwner(path);
  const factRows = dbGetFacts(owner);
  const facts: Fact[] = factRows.map((r) => ({
    key: r.key,
    value: r.value,
    scope: r.scope as FactScope,
    tags: (() => {
      try {
        const t = JSON.parse(r.tags) as unknown;
        return Array.isArray(t) ? t.filter((x): x is string => typeof x === "string") : [];
      } catch {
        return [];
      }
    })(),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
  return { version: 1, facts };
}

/** No-op: persistence is via db in upsertFact. Kept for API compatibility. */
export function saveMemory(_mem: MemoryFile, _path: string = getMemoryPath()): void {}

function normalizeTag(s: string): string {
  return s.trim().toLowerCase();
}

export function upsertFact(opts: {
  key: string;
  value: string;
  scope?: FactScope;
  tags?: string[];
  path?: string;
}): Fact {
  const owner = pathToOwner(opts.path ?? getMemoryPath());
  const key = opts.key.trim();
  const value = opts.value.trim();
  const scope: FactScope = opts.scope ?? "user";
  const tags = (opts.tags ?? []).map(normalizeTag).filter(Boolean);
  dbUpsertFact(owner, key, value, scope, tags);
  const now = new Date().toISOString();
  return { key, value, scope, tags, createdAt: now, updatedAt: now };
}

export function deleteFact(opts: { key: string; scope?: FactScope; path?: string }): boolean {
  const owner = pathToOwner(opts.path ?? getMemoryPath());
  return dbDeleteFact(owner, opts.key.trim(), (opts.scope ?? "user") as FactScope);
}

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .map((t) => t.trim())
    .filter((t) => t.length >= 3);
}

/** Returns all stored facts (for "what do you know about me?" etc.). */
export function getAllFacts(opts?: { path?: string }): Fact[] {
  const path = opts?.path ?? getMemoryPath();
  return loadMemory(path).facts;
}

export function getRelevantFacts(prompt: string, opts?: { max?: number; path?: string }): Fact[] {
  const max = opts?.max ?? 10;
  const path = opts?.path ?? getMemoryPath();
  const { facts } = loadMemory(path);
  if (facts.length === 0) return [];

  const tokens = new Set(tokenize(prompt));
  if (tokens.size === 0) return facts.slice(-max);

  const boostedKeys = new Set(["name", "email", "location", "city", "state", "zip", "home_zip", "timezone"]);

  const scored = facts
    .map((f) => {
      const hay = `${f.key} ${f.value} ${f.tags.join(" ")}`.toLowerCase();
      let score = 0;
      for (const t of tokens) if (hay.includes(t)) score += 1;
      if (boostedKeys.has(f.key.toLowerCase())) score += 2;
      return { f, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || b.f.updatedAt.localeCompare(a.f.updatedAt));

  return scored.slice(0, max).map((x) => x.f);
}

export function formatFactsForPrompt(facts: Fact[]): string {
  if (facts.length === 0) return "";
  const lines = facts.map((f) => `- ${f.key}: ${f.value}`);
  return ["Facts (stated by user; use when relevant):", ...lines].join("\n");
}

export function formatConversationForPrompt(messages: ConversationMessage[]): string {
  if (messages.length === 0) return "";
  const lines = messages.map((m) => (m.role === "user" ? `User: ${m.content}` : `Assistant: ${m.content}`));
  return ["Recent conversation:", ...lines].join("\n");
}

