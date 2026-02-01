#!/usr/bin/env bun
/**
 * Reset dev DB and load from data/seed-dev.json.
 * Uses DATABASE_URL. Maps old family/user IDs to new ones so FKs stay valid.
 * Schema-flexible: only inserts columns that exist in the current DB.
 *
 * Usage: DATABASE_URL=... bun run scripts/seed-import.ts
 */

import { Pool } from "pg";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const SEED_PATH = join(import.meta.dir, "..", "data", "seed-dev.json");

const TABLES_IN_ORDER = [
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

// Columns that are JSONB — pass as JSON string so pg doesn't coerce arrays to comma-separated strings
const JSONB_COLUMNS: Record<string, Set<string>> = {
  user_personalities: new Set(["instructions"]),
  facts: new Set(["tags"]),
  summary: new Set(["sentences"]),
  skills_registry: new Set(["input_schema"]),
  llm_log: new Set(["request_doc"]),
  moderation_flags: new Set(["flags"]),
};

// Tables with SERIAL primary key "id" — we omit id on insert and use RETURNING to get new id for FK mapping
const SERIAL_ID_TABLES = new Set([
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
  "skills_access_by_user",
]);

const FK_MAP: Record<string, Array<{ col: string; kind: "family" | "user" }>> = {
  users: [{ col: "last_active_family_id", kind: "family" }],
  family_memberships: [
    { col: "user_id", kind: "user" },
    { col: "family_id", kind: "family" },
  ],
  user_personalities: [
    { col: "user_id", kind: "user" },
    { col: "family_id", kind: "family" },
  ],
  facts: [
    { col: "user_id", kind: "user" },
    { col: "family_id", kind: "family" },
  ],
  conversation: [
    { col: "user_id", kind: "user" },
    { col: "family_id", kind: "family" },
  ],
  summary: [
    { col: "user_id", kind: "user" },
    { col: "family_id", kind: "family" },
  ],
  todos: [
    { col: "user_id", kind: "user" },
    { col: "family_id", kind: "family" },
    { col: "creator_user_id", kind: "user" },
  ],
  reminders: [
    { col: "creator_user_id", kind: "user" },
    { col: "recipient_user_id", kind: "user" },
    { col: "family_id", kind: "family" },
  ],
  schedule_state: [{ col: "user_id", kind: "user" }],
  llm_log: [
    { col: "user_id", kind: "user" },
    { col: "family_id", kind: "family" },
  ],
  skills_access_by_user: [{ col: "user_id", kind: "user" }],
  group_chats: [{ col: "family_id", kind: "family" }],
};

async function getTableColumns(pool: Pool, table: string): Promise<Set<string>> {
  const result = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`,
    [table]
  );
  return new Set(result.rows.map((r: { column_name: string }) => r.column_name));
}

function mapRow(
  row: Record<string, unknown>,
  table: string,
  familyIdMap: Map<number, number>,
  userIdMap: Map<number, number>,
  tableColumns: Set<string>
): Record<string, unknown> {
  const fks = FK_MAP[table];
  const out: Record<string, unknown> = {};
  for (const [col, val] of Object.entries(row)) {
    if (!tableColumns.has(col)) continue;
    if (val === undefined) continue;
    if (fks) {
      const fk = fks.find((f) => f.col === col);
      if (fk && (typeof val === "number" || val === null)) {
        if (val === null) {
          out[col] = null;
        } else if (fk.kind === "family") {
          out[col] = familyIdMap.get(val) ?? val;
        } else if (fk.kind === "user") {
          out[col] = userIdMap.get(val) ?? val;
        } else {
          out[col] = val;
        }
        continue;
      }
    }
    if (col === "id" && SERIAL_ID_TABLES.has(table)) {
      continue; // omit PK so DB generates new id
    }
    // JSONB columns: pass as JSON string so PostgreSQL accepts it
    const jsonbCols = JSONB_COLUMNS[table];
    if (jsonbCols?.has(col) && (typeof val === "object" || Array.isArray(val))) {
      out[col] = JSON.stringify(val);
      continue;
    }
    out[col] = val;
  }
  return out;
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }

  if (!existsSync(SEED_PATH)) {
    console.error("Seed file not found:", SEED_PATH);
    console.error("Run: PROD_DATABASE_URL=... bun run scripts/seed-export.ts");
    process.exit(1);
  }

  const seed = JSON.parse(readFileSync(SEED_PATH, "utf8"));
  if (seed.schemaVersion !== 1) {
    console.error("Unsupported schemaVersion:", seed.schemaVersion);
    process.exit(1);
  }

  const pool = new Pool({ connectionString });
  const familyIdMap = new Map<number, number>();
  const userIdMap = new Map<number, number>();

  console.log("Truncating dev DB...");
  await pool.query("TRUNCATE TABLE families RESTART IDENTITY CASCADE");
  await pool.query(
    "TRUNCATE TABLE skills_registry, skills_access_default, config RESTART IDENTITY CASCADE"
  );
  await pool.query("TRUNCATE TABLE watch_self_replied CASCADE").catch(() => {});

  for (const table of TABLES_IN_ORDER) {
    const rows = (seed.tables && seed.tables[table]) as Record<string, unknown>[] | undefined;
    if (!rows || rows.length === 0) continue;

    const tableColumns = await getTableColumns(pool, table);
    const returnId = SERIAL_ID_TABLES.has(table);

    for (const row of rows) {
      const mapped = mapRow(row, table, familyIdMap, userIdMap, tableColumns);
      const cols = Object.keys(mapped).filter((c) => mapped[c] !== undefined);
      if (cols.length === 0) continue;

      const values = cols.map((c) => mapped[c]);
      const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");
      const sql = `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${placeholders})${returnId ? " RETURNING id" : ""}`;

      try {
        const result = await pool.query(sql, values);
        if (table === "families" && result.rows[0] && row.id != null) {
          familyIdMap.set(Number(row.id), Number(result.rows[0].id));
        }
        if (table === "users" && result.rows[0] && row.id != null) {
          userIdMap.set(Number(row.id), Number(result.rows[0].id));
        }
      } catch (e) {
        console.error(`${table} insert error:`, (e as Error).message);
        console.error("Row keys:", Object.keys(row));
        throw e;
      }
    }
    console.log(`${table}: ${rows.length} rows`);
  }

  await pool.end();
  console.log("Seed import done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
