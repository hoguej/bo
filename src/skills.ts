import {
  dbGetSkillsAccessByNumber,
  dbGetSkillsAccessDefault,
  dbGetSkillsRegistry,
  type SkillRow,
} from "./db";
import { canonicalPhone } from "./phone";

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

function skillRowToDef(r: SkillRow): SkillDef {
  let inputSchema: unknown = {};
  try {
    inputSchema = JSON.parse(r.input_schema);
  } catch {
    /* ignore */
  }
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    entrypoint: r.entrypoint,
    inputSchema,
  };
}

export async function loadSkillsRegistry(): Promise<SkillsRegistry> {
  const rows = await dbGetSkillsRegistry();
  return {
    version: 1,
    skills: rows.map(skillRowToDef),
  };
}

/** Load skills access from DB (migrated from skills/access.json). Returns null if no default row (all skills allowed). */
export async function loadSkillAccessConfig(): Promise<SkillAccessConfig | null> {
  const defaultAllowed = await dbGetSkillsAccessDefault();
  const byNumber = await dbGetSkillsAccessByNumber();
  // If default is empty and no byNumber, treat as "all allowed" (return null for backward compat)
  if (defaultAllowed.length === 0 && Object.keys(byNumber).length === 0) return null;
  return {
    version: 1,
    default: defaultAllowed,
    byNumber,
  };
}

/** Normalize sender to 10-digit or "telegram:<id>" for access lookup (matches memory normalizeOwner). Pass through telegram:<id>. */
export function normalizeNumberForAccess(sender: string | undefined): string {
  const trimmed = (sender ?? "").trim();
  if (trimmed.startsWith("telegram:")) return trimmed;
  const c = canonicalPhone(trimmed || "default");
  return c === "default" || c.length < 10 ? "default" : c;
}

/**
 * Returns the list of skill IDs the given owner is allowed to use.
 * If no access config exists, returns all registry skill IDs. Otherwise returns
 * the intersection of allowed (from config) and existing (from registry).
 */
export async function getAllowedSkillIdsForOwner(owner: string, allSkillIds: string[]): Promise<string[]> {
  const access = await loadSkillAccessConfig();
  if (!access) return allSkillIds;
  const allowed = owner === "default" ? access.default : (access.byNumber[owner] ?? access.default);
  if (!Array.isArray(allowed)) return allSkillIds;
  const set = new Set(allowed);
  return allSkillIds.filter((id) => set.has(id));
}

export async function getSkillById(id: string): Promise<SkillDef | undefined> {
  const rows = await dbGetSkillsRegistry();
  const row = rows.find((s) => s.id === id);
  return row ? skillRowToDef(row) : undefined;
}

