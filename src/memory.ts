import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type FactScope = "global" | "user";

export type Fact = {
  key: string;
  value: string;
  scope: FactScope;
  tags: string[];
  createdAt: string; // ISO
  updatedAt: string; // ISO
};

/** Inferences derived from facts (e.g. "number of children: 2" from "children's names are Cara and Robert"). */
export type Inference = {
  key: string;
  value: string;
  basedOnKeys?: string[]; // fact keys this was inferred from
  createdAt: string;
  updatedAt: string;
};

type MemoryFile = {
  version: 1;
  facts: Fact[];
  inferences?: Inference[];
};

const DEFAULT_MEMORY_DIR = join(homedir(), ".bo");
const DEFAULT_MEMORY_PATH = join(DEFAULT_MEMORY_DIR, "memory.json");

/** Owner "default" = self / primary user. Other owners = sender id (e.g. 7404749170, 6143480678). US 11-digit → 10-digit so +16143480678 matches 6143480678. */
export function normalizeOwner(sender: string | undefined): string {
  if (!sender || !sender.trim()) return "default";
  const s = sender.trim();
  const digits = s.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  if (digits.length >= 10) return digits;
  return "default";
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

const MAX_SUMMARY_SENTENCES = 50;
type SummaryFile = { sentences: string[] };

function loadSummaryFile(path: string): SummaryFile {
  if (!existsSync(path)) return { sentences: [] };
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as SummaryFile;
    if (!parsed || !Array.isArray(parsed.sentences)) return { sentences: [] };
    return parsed;
  } catch {
    return { sentences: [] };
  }
}

/** Append one high-level summary sentence (from LLM). Keeps last MAX_SUMMARY_SENTENCES. */
export function appendSummarySentence(owner: string | undefined, sentence: string): void {
  const s = sentence.trim();
  if (!s) return;
  const path = getSummaryPathForOwner(owner);
  ensureParentDir(path);
  const { sentences } = loadSummaryFile(path);
  sentences.push(s);
  const trimmed =
    sentences.length > MAX_SUMMARY_SENTENCES ? sentences.slice(-MAX_SUMMARY_SENTENCES) : sentences;
  writeFileSync(path, JSON.stringify({ sentences: trimmed }, null, 2) + "\n", "utf-8");
}

/** Get the running summary for prompt context (oldest first). */
export function getSummaryForPrompt(owner: string | undefined): string {
  const path = getSummaryPathForOwner(owner);
  const { sentences } = loadSummaryFile(path);
  if (sentences.length === 0) return "";
  return sentences.join("\n");
}

/** Path for per-user personality instructions. personality_<owner>.json. */
export function getPersonalityPathForOwner(owner: string | undefined): string {
  const baseDir = process.env.BO_MEMORY_PATH?.trim()
    ? dirname(process.env.BO_MEMORY_PATH!)
    : DEFAULT_MEMORY_DIR;
  if (!owner || owner === "default") return join(baseDir, "personality.json");
  return join(baseDir, `personality_${owner}.json`);
}

const MAX_PERSONALITY_INSTRUCTIONS = 20;
type PersonalityFile = { instructions: string[] };

function loadPersonalityFile(path: string): PersonalityFile {
  if (!existsSync(path)) return { instructions: [] };
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as PersonalityFile;
    if (!parsed || !Array.isArray(parsed.instructions)) return { instructions: [] };
    return parsed;
  } catch {
    return { instructions: [] };
  }
}

/** Append one or more personality instructions. If the string contains ". " we split and append each part (LLM sometimes returns combined list). Per-user; accumulates up to MAX_PERSONALITY_INSTRUCTIONS. */
export function appendPersonalityInstruction(owner: string | undefined, instruction: string): void {
  const raw = instruction.trim();
  if (!raw) return;
  const path = getPersonalityPathForOwner(owner);
  ensureParentDir(path);
  const loaded = loadPersonalityFile(path);
  const instructions = [...loaded.instructions];
  const toAdd = raw.includes(". ")
    ? raw.split(/.\.\s+/).map((s) => s.trim()).filter(Boolean)
    : [raw];
  for (const s of toAdd) {
    if (s && !instructions.includes(s)) instructions.push(s);
  }
  if (instructions.length === loaded.instructions.length) return;
  const trimmed =
    instructions.length > MAX_PERSONALITY_INSTRUCTIONS
      ? instructions.slice(-MAX_PERSONALITY_INSTRUCTIONS)
      : instructions;
  writeFileSync(path, JSON.stringify({ instructions: trimmed }, null, 2) + "\n", "utf-8");
}

/** Get personality instructions for this user for prompt context. */
export function getPersonalityForPrompt(owner: string | undefined): string {
  const path = getPersonalityPathForOwner(owner);
  const { instructions } = loadPersonalityFile(path);
  if (instructions.length === 0) return "";
  return instructions.join(". ");
}

export type ConversationMessage = { role: "user" | "assistant"; content: string };

type ConversationFile = { messages: ConversationMessage[] };

/** Default 20 (~10 turns). Override with BO_CONVERSATION_MESSAGES (2–100). */
export function getMaxConversationMessages(): number {
  const n = process.env.BO_CONVERSATION_MESSAGES?.trim();
  if (!n) return 20;
  const parsed = parseInt(n, 10);
  return Number.isFinite(parsed) && parsed >= 2 && parsed <= 100 ? parsed : 20;
}
const MAX_CONVERSATION_MESSAGES = getMaxConversationMessages();

function loadConversationFile(path: string): ConversationFile {
  if (!existsSync(path)) return { messages: [] };
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as ConversationFile;
    if (!parsed || !Array.isArray(parsed.messages)) return { messages: [] };
    return parsed;
  } catch {
    return { messages: [] };
  }
}

/** Last N messages (oldest first) for context. */
export function getRecentMessages(owner: string | undefined, max: number = MAX_CONVERSATION_MESSAGES): ConversationMessage[] {
  const path = getConversationPathForOwner(owner);
  const { messages } = loadConversationFile(path);
  if (messages.length <= max) return messages;
  return messages.slice(-max);
}

/** Append one user and one assistant message, then trim to MAX_CONVERSATION_MESSAGES. Keeps last N messages (both user and Bo's responses) for context. */
export function appendConversation(
  owner: string | undefined,
  userContent: string,
  assistantContent: string
): void {
  const path = getConversationPathForOwner(owner);
  ensureParentDir(path);
  const { messages } = loadConversationFile(path);
  messages.push({ role: "user", content: userContent.trim() });
  messages.push({ role: "assistant", content: assistantContent.trim() });
  const trimmed =
    messages.length > MAX_CONVERSATION_MESSAGES
      ? messages.slice(-MAX_CONVERSATION_MESSAGES)
      : messages;
  writeFileSync(path, JSON.stringify({ messages: trimmed }, null, 2) + "\n", "utf-8");
}

export function getMemoryPath(): string {
  return getMemoryPathForOwner("default");
}

function ensureParentDir(path: string) {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function loadMemory(path: string = getMemoryPath()): MemoryFile {
  if (!existsSync(path)) return { version: 1, facts: [], inferences: [] };
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as MemoryFile;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.facts)) return { version: 1, facts: [], inferences: [] };
    if (!Array.isArray(parsed.inferences)) parsed.inferences = [];
    return parsed;
  } catch {
    return { version: 1, facts: [], inferences: [] };
  }
}

export function saveMemory(mem: MemoryFile, path: string = getMemoryPath()): void {
  ensureParentDir(path);
  // Always persist version, facts, and inferences so we never drop inferences on write.
  const toWrite: MemoryFile = {
    version: 1,
    facts: Array.isArray(mem.facts) ? mem.facts : [],
    inferences: Array.isArray(mem.inferences) ? mem.inferences : [],
  };
  writeFileSync(path, JSON.stringify(toWrite, null, 2) + "\n", "utf-8");
}

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
  const path = opts.path ?? getMemoryPath();
  const mem = loadMemory(path);
  const now = new Date().toISOString();
  const key = opts.key.trim();
  const value = opts.value.trim();
  const scope: FactScope = opts.scope ?? "user";
  const tags = (opts.tags ?? []).map(normalizeTag).filter(Boolean);

  const existing = mem.facts.find((f) => f.key === key && f.scope === scope);
  if (existing) {
    existing.value = value;
    existing.tags = Array.from(new Set([...existing.tags, ...tags]));
    existing.updatedAt = now;
    saveMemory(mem, path);
    return existing;
  }

  const fact: Fact = {
    key,
    value,
    scope,
    tags,
    createdAt: now,
    updatedAt: now,
  };
  mem.facts.push(fact);
  saveMemory(mem, path);
  return fact;
}

export function deleteFact(opts: { key: string; scope?: FactScope; path?: string }): boolean {
  const path = opts.path ?? getMemoryPath();
  const mem = loadMemory(path);
  const key = opts.key.trim();
  const scope: FactScope = opts.scope ?? "user";
  const before = mem.facts.length;
  mem.facts = mem.facts.filter((f) => !(f.key === key && f.scope === scope));
  const changed = mem.facts.length !== before;
  if (changed) saveMemory(mem, path);
  return changed;
}

export function upsertInference(opts: {
  key: string;
  value: string;
  basedOnKeys?: string[];
  path?: string;
}): Inference {
  const path = opts.path ?? getMemoryPath();
  const mem = loadMemory(path);
  if (!mem.inferences) mem.inferences = [];
  const now = new Date().toISOString();
  const key = opts.key.trim();
  const value = opts.value.trim();
  const basedOnKeys = opts.basedOnKeys ?? [];

  const existing = mem.inferences.find((i) => i.key === key);
  if (existing) {
    existing.value = value;
    existing.basedOnKeys = Array.from(new Set([...(existing.basedOnKeys ?? []), ...basedOnKeys]));
    existing.updatedAt = now;
    saveMemory(mem, path);
    return existing;
  }

  const inference: Inference = {
    key,
    value,
    basedOnKeys: basedOnKeys.length ? basedOnKeys : undefined,
    createdAt: now,
    updatedAt: now,
  };
  mem.inferences.push(inference);
  saveMemory(mem, path);
  return inference;
}

export function deleteInference(opts: { key: string; path?: string }): boolean {
  const path = opts.path ?? getMemoryPath();
  const mem = loadMemory(path);
  if (!mem.inferences) return false;
  const key = opts.key.trim();
  const before = mem.inferences.length;
  mem.inferences = mem.inferences.filter((i) => i.key !== key);
  const changed = mem.inferences.length !== before;
  if (changed) saveMemory(mem, path);
  return changed;
}

/** Returns all inferences for an owner. */
export function getAllInferences(opts?: { path?: string }): Inference[] {
  const path = opts?.path ?? getMemoryPath();
  return loadMemory(path).inferences ?? [];
}

export function getRelevantInferences(prompt: string, opts?: { max?: number; path?: string }): Inference[] {
  const max = opts?.max ?? 10;
  const path = opts?.path ?? getMemoryPath();
  const inferences = loadMemory(path).inferences ?? [];
  if (inferences.length === 0) return [];

  const tokens = new Set(tokenize(prompt));
  if (tokens.size === 0) return inferences.slice(-max);

  const scored = inferences
    .map((i) => {
      const hay = `${i.key} ${i.value} ${(i.basedOnKeys ?? []).join(" ")}`.toLowerCase();
      let score = 0;
      for (const t of tokens) if (hay.includes(t)) score += 1;
      return { i, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, max).map((x) => x.i);
}

export function formatInferencesForPrompt(inferences: Inference[]): string {
  if (inferences.length === 0) return "";
  const lines = inferences.map((i) =>
    i.basedOnKeys?.length
      ? `- ${i.key}: ${i.value} (inferred from: ${i.basedOnKeys.join(", ")})`
      : `- ${i.key}: ${i.value}`
  );
  return ["Inferences (derived from facts; use when relevant):", ...lines].join("\n");
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

