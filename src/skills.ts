import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type SkillDef = {
  id: string;
  name: string;
  description: string;
  entrypoint: string;
  inputSchema: unknown;
};

export type SkillsRegistry = {
  version: 1;
  skills: SkillDef[];
};

/** Per-number skill access. byNumber keys are normalized 10-digit (e.g. 7404749170). default = skills for numbers not listed. */
export type SkillAccessConfig = {
  version: 1;
  default: string[];
  byNumber: Record<string, string[]>;
};

export function loadSkillsRegistry(): SkillsRegistry {
  const p = join(process.cwd(), "skills", "registry.json");
  const raw = readFileSync(p, "utf-8");
  const parsed = JSON.parse(raw) as SkillsRegistry;
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.skills)) {
    throw new Error("Invalid skills registry format");
  }
  return parsed;
}

/** Load skills/access.json if present. Returns null if file does not exist (all skills allowed). */
export function loadSkillAccessConfig(): SkillAccessConfig | null {
  const p = join(process.cwd(), "skills", "access.json");
  if (!existsSync(p)) return null;
  const raw = readFileSync(p, "utf-8");
  const parsed = JSON.parse(raw) as SkillAccessConfig;
  if (!parsed || parsed.version !== 1) return null;
  if (!Array.isArray(parsed.default)) parsed.default = [];
  if (!parsed.byNumber || typeof parsed.byNumber !== "object") parsed.byNumber = {};
  // Normalize byNumber keys to 10-digit so "+17404749170" and "7404749170" both match lookup
  const normalized: Record<string, string[]> = {};
  for (const [key, skills] of Object.entries(parsed.byNumber)) {
    const n = normalizeNumberForAccess(key);
    if (n !== "default" && Array.isArray(skills)) normalized[n] = skills;
  }
  parsed.byNumber = normalized;
  return parsed;
}

/** Normalize sender to 10-digit for access lookup (matches memory normalizeOwner). */
export function normalizeNumberForAccess(sender: string | undefined): string {
  if (!sender || !sender.trim()) return "default";
  const s = sender.trim();
  const digits = s.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  if (digits.length >= 10) return digits;
  return "default";
}

/**
 * Returns the list of skill IDs the given owner is allowed to use.
 * If no access config exists, returns all registry skill IDs. Otherwise returns
 * the intersection of allowed (from config) and existing (from registry).
 */
export function getAllowedSkillIdsForOwner(owner: string, allSkillIds: string[]): string[] {
  const access = loadSkillAccessConfig();
  if (!access) return allSkillIds;
  const allowed = owner === "default" ? access.default : (access.byNumber[owner] ?? access.default);
  if (!Array.isArray(allowed)) return allSkillIds;
  const set = new Set(allowed);
  return allSkillIds.filter((id) => set.has(id));
}

export function getSkillById(id: string): SkillDef | undefined {
  const reg = loadSkillsRegistry();
  return reg.skills.find((s) => s.id === id);
}

