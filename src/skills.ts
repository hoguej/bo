import { readFileSync } from "node:fs";
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

export function loadSkillsRegistry(): SkillsRegistry {
  const p = join(process.cwd(), "skills", "registry.json");
  const raw = readFileSync(p, "utf-8");
  const parsed = JSON.parse(raw) as SkillsRegistry;
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.skills)) {
    throw new Error("Invalid skills registry format");
  }
  return parsed;
}

export function getSkillById(id: string): SkillDef | undefined {
  const reg = loadSkillsRegistry();
  return reg.skills.find((s) => s.id === id);
}

