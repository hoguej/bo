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

type MemoryFile = {
  version: 1;
  facts: Fact[];
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

export function getMemoryPath(): string {
  return getMemoryPathForOwner("default");
}

function ensureParentDir(path: string) {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function loadMemory(path: string = getMemoryPath()): MemoryFile {
  if (!existsSync(path)) return { version: 1, facts: [] };
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as MemoryFile;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.facts)) return { version: 1, facts: [] };
    return parsed;
  } catch {
    return { version: 1, facts: [] };
  }
}

export function saveMemory(mem: MemoryFile, path: string = getMemoryPath()): void {
  ensureParentDir(path);
  writeFileSync(path, JSON.stringify(mem, null, 2) + "\n", "utf-8");
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
  return [
    "Known user facts (use only if relevant; do not mention unless it helps answer):",
    ...lines,
  ].join("\n");
}

