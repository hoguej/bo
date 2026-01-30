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

export function loadSkillsRegistry(): SkillsRegistry {
  const rows = dbGetSkillsRegistry();
  return {
    version: 1,
    skills: rows.map(skillRowToDef),
  };
}

/** Load skills access from DB (migrated from skills/access.json). Returns null if no default row (all skills allowed). */
export function loadSkillAccessConfig(): SkillAccessConfig | null {
  const defaultAllowed = dbGetSkillsAccessDefault();
  const byNumber = dbGetSkillsAccessByNumber();
  // If default is empty and no byNumber, treat as "all allowed" (return null for backward compat)
  if (defaultAllowed.length === 0 && Object.keys(byNumber).length === 0) return null;
  return {
    version: 1,
    default: defaultAllowed,
    byNumber,
  };
}

/** Normalize sender to 10-digit for access lookup (matches memory normalizeOwner). Uses central phone normalization. */
export function normalizeNumberForAccess(sender: string | undefined): string {
  const c = canonicalPhone((sender ?? "").trim() || "default");
  return c === "default" || c.length < 10 ? "default" : c;
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
  const rows = dbGetSkillsRegistry();
  const row = rows.find((s) => s.id === id);
  return row ? skillRowToDef(row) : undefined;
}

