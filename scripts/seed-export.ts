#!/usr/bin/env bun
/**
 * Export production DB to a JSON seed file for dev.
 * Uses PROD_DATABASE_URL. Anonymizes data except for users whose first_name
 * is in PRESERVE_TELEGRAM_FOR_FIRST_NAMES (default: Jon, Carrie).
 * Output: data/seed-dev.json
 *
 * Usage: PROD_DATABASE_URL=... bun run scripts/seed-export.ts
 */

import { Pool } from "pg";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";

const PRESERVE_FIRST_NAMES = ["Jon", "Carrie"];
const SEED_PATH = join(import.meta.dir, "..", "data", "seed-dev.json");

// Tables to export in dependency order (no FK first)
const TABLES = [
  "families",
  "users",
  "family_memberships",
  "user_personalities",
  "facts",
  "conversation",
  "summary",
  "todos",
  "reminders",
  "schedule_state",
  "llm_log",
  "skills_registry",
  "skills_access_default",
  "skills_access_by_user",
  "config",
  "group_chats",
];

function fakePhone(index: number): string {
  return `+1555000${String(index).padStart(4, "0")}`;
}

function fakeFirstName(index: number): string {
  const names = ["Alice", "Bob", "Carol", "Dave", "Eve", "Frank", "Grace", "Henry"];
  return names[index % names.length];
}

function fakeLastName(index: number): string {
  const names = ["Test", "Demo", "User", "Dev", "Seed", "Anon", "Fake", "Sample"];
  return names[Math.floor(index / 8) % names.length];
}

function serializeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (v === null) {
      out[k] = null;
      continue;
    }
    if (typeof v === "object" && v !== null && "toISOString" in (v as object)) {
      out[k] = (v as Date).toISOString();
      continue;
    }
    if (Buffer.isBuffer(v)) {
      out[k] = (v as Buffer).toString("base64");
      continue;
    }
    out[k] = v;
  }
  return out;
}

async function main() {
  const connectionString = process.env.PROD_DATABASE_URL;
  if (!connectionString) {
    console.error("PROD_DATABASE_URL is required");
    process.exit(1);
  }

  const pool = new Pool({ connectionString });
  const payload: Record<string, unknown[]> = {};
  let userIndex = 0;

  for (const table of TABLES) {
    try {
      const result = await pool.query(`SELECT * FROM ${table}`);
      let rows = result.rows.map((r) => serializeRow(r as Record<string, unknown>));

      if (table === "users") {
        rows = rows.map((r) => {
          const firstName = String(r.first_name ?? "").trim();
          const preserve = PRESERVE_FIRST_NAMES.some((n) => firstName === n);
          if (preserve) {
            return r; // keep real telegram_id, name, phone for Jon/Carrie
          }
          userIndex += 1;
          return {
            ...r,
            first_name: fakeFirstName(userIndex - 1),
            last_name: fakeLastName(userIndex - 1),
            phone_number: fakePhone(userIndex - 1),
            telegram_id: null, // anonymize: no real telegram for others
          };
        });
      }

      payload[table] = rows;
      console.log(`${table}: ${rows.length} rows`);
    } catch (e) {
      console.warn(`Skipping ${table}:`, (e as Error).message);
      payload[table] = [];
    }
  }

  await pool.end();

  const seed = {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    preserveTelegramForFirstNames: PRESERVE_FIRST_NAMES,
    tables: payload,
  };

  mkdirSync(join(import.meta.dir, "..", "data"), { recursive: true });
  writeFileSync(SEED_PATH, JSON.stringify(seed, null, 2), "utf8");
  console.log("Wrote", SEED_PATH);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
