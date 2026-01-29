import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Load .env and .env.local from cwd into process.env.
 * .env.local overrides .env. Does nothing if files are missing.
 */
export function loadEnv(cwd: string = process.cwd()): void {
  for (const name of [".env", ".env.local"]) {
    const path = join(cwd, name);
    if (!existsSync(path)) continue;
    try {
      const raw = readFileSync(path, "utf-8");
      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eq = trimmed.indexOf("=");
        if (eq <= 0) continue;
        const key = trimmed.slice(0, eq).trim();
        const value = trimmed.slice(eq + 1).trim();
        if (value.startsWith('"') && value.endsWith('"')) {
          process.env[key] = value.slice(1, -1).replace(/\\n/g, "\n");
        } else if (value.startsWith("'") && value.endsWith("'")) {
          process.env[key] = value.slice(1, -1);
        } else {
          process.env[key] = value;
        }
      }
    } catch {
      // ignore read/parse errors
    }
  }
}
