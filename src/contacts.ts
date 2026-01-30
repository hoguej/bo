import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

function getContactsPath(): string {
  const override = process.env.BO_CONTACTS_PATH?.trim();
  if (override && existsSync(override)) return override;
  // BO_PROJECT_ROOT is set by agent.sh so config is found regardless of process cwd.
  const projectRoot = process.env.BO_PROJECT_ROOT?.trim();
  if (projectRoot) {
    const path = join(projectRoot, "config", "contacts.json");
    if (existsSync(path)) return path;
  }
  // Fallbacks: path relative to this module (src/ -> project root), then cwd.
  const fromModule = resolve(__dirname, "..", "config", "contacts.json");
  if (existsSync(fromModule)) return fromModule;
  const cwdPath = join(process.cwd(), "config", "contacts.json");
  return existsSync(cwdPath) ? cwdPath : fromModule;
}

function canonicalPhone(s: string): string {
  const digits = s.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits;
}

/** Load contacts from config/contacts.json (or BO_CONTACTS_PATH). Returns number → name for display. */
export function getNumberToName(): Map<string, string> {
  const path = getContactsPath();
  if (!existsSync(path)) return new Map();
  try {
    const raw = readFileSync(path, "utf-8");
    const obj = JSON.parse(raw) as Record<string, unknown>;
    if (!obj || typeof obj !== "object") return new Map();
    const map = new Map<string, string>();
    for (const [name, value] of Object.entries(obj)) {
      if (typeof value === "string" && name.trim()) {
        const num = canonicalPhone(value);
        if (num.length >= 10) map.set(num, name.trim());
      }
    }
    return map;
  } catch {
    return new Map();
  }
}

/** Load contacts from config/contacts.json (or BO_CONTACTS_PATH). Returns name (lowercase) → canonical 10-digit number for send_to_contact. */
export function getNameToNumber(): Map<string, string> {
  const path = getContactsPath();
  if (!existsSync(path)) return new Map();
  try {
    const raw = readFileSync(path, "utf-8");
    const obj = JSON.parse(raw) as Record<string, unknown>;
    if (!obj || typeof obj !== "object") return new Map();
    const map = new Map<string, string>();
    for (const [name, value] of Object.entries(obj)) {
      if (typeof value === "string" && name.trim()) {
        const num = canonicalPhone(value);
        if (num.length >= 10) map.set(name.trim().toLowerCase(), num);
      }
    }
    return map;
  } catch {
    return new Map();
  }
}
