/**
 * Single SQLite DB at ~/.bo/bo.db for all non-secret data and config.
 * Schema: users, skills_registry, skills_access_default, skills_access_by_user,
 * facts, conversation, summary, personality, todos.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const DEFAULT_BO_DIR = join(homedir(), ".bo");
const DEFAULT_DB_PATH = join(DEFAULT_BO_DIR, "bo.db");

function getDbPath(): string {
  const override = process.env.BO_DB_PATH?.trim();
  if (override) return override;
  const base = process.env.BO_MEMORY_PATH?.trim() ? dirname(process.env.BO_MEMORY_PATH) : DEFAULT_BO_DIR;
  return join(base, "bo.db");
}

let db: import("bun:sqlite").Database | null = null;

function getDb(): import("bun:sqlite").Database {
  if (db) return db;
  const path = getDbPath();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const { Database } = require("bun:sqlite");
  const database = new Database(path, { create: true });
  db = database;
  initSchema(database);
  return database;
}

function canonicalPhone(s: string): string {
  const digits = s.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits;
}

function initSchema(database: import("bun:sqlite").Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      phone_number TEXT NOT NULL UNIQUE
    );
    INSERT OR IGNORE INTO users (first_name, last_name, phone_number) VALUES ('Default', '', 'default');

    CREATE TABLE IF NOT EXISTS skills_registry (
      id TEXT NOT NULL PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      entrypoint TEXT NOT NULL,
      input_schema TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS skills_access_default (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      allowed TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS skills_access_by_user (
      user_id INTEGER NOT NULL PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      allowed TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS facts (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'user',
      tags TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, key, scope)
    );

    CREATE TABLE IF NOT EXISTS conversation (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      PRIMARY KEY (user_id, seq)
    );

    CREATE TABLE IF NOT EXISTS summary (
      user_id INTEGER NOT NULL PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      sentences TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS personality (
      user_id INTEGER NOT NULL PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      instructions TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS todos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      done INTEGER NOT NULL DEFAULT 0,
      due TEXT,
      created_at TEXT NOT NULL
    );
  `);
  migrateOldTablesToUsers(database);
  migrateOwnerColumnsToUserId(database);
  migrateFromJson(database, false);
  database.run("CREATE INDEX IF NOT EXISTS idx_facts_user_id ON facts(user_id)");
  database.run("CREATE INDEX IF NOT EXISTS idx_conversation_user_seq ON conversation(user_id, seq)");
  database.run("CREATE INDEX IF NOT EXISTS idx_todos_user_id ON todos(user_id)");
}

/** One-time: migrate legacy contacts → users, skills_access_by_number → skills_access_by_user. */
function migrateOldTablesToUsers(database: import("bun:sqlite").Database): void {
  const tables = database.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('contacts', 'skills_access_by_number')").all() as { name: string }[];
  const hasContacts = tables.some((t) => t.name === "contacts");
  const hasByNumber = tables.some((t) => t.name === "skills_access_by_number");

  if (hasContacts) {
    const rows = database.query("SELECT name, number FROM contacts").all() as { name: string; number: string }[];
    for (const r of rows) {
      const num = canonicalPhone(r.number);
      if (num.length < 10) continue;
      const [first = "", ...rest] = (r.name || "").trim().split(/\s+/);
      const last = rest.join(" ").trim();
      database.run("INSERT OR IGNORE INTO users (first_name, last_name, phone_number) VALUES (?, ?, ?)", [first, last, num]);
    }
    database.run("DROP TABLE contacts");
  }

  if (hasByNumber) {
    const rows = database.query("SELECT number, allowed FROM skills_access_by_number").all() as { number: string; allowed: string }[];
    for (const r of rows) {
      const num = canonicalPhone(r.number);
      if (num.length < 10) continue;
      const row = database.query("SELECT id FROM users WHERE phone_number = ?").get(num) as { id: number } | undefined;
      let userId: number;
      if (row) {
        userId = row.id;
      } else {
        database.run("INSERT INTO users (first_name, last_name, phone_number) VALUES (?, ?, ?)", ["", "", num]);
        userId = (database.query("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
      }
      database.run("INSERT OR REPLACE INTO skills_access_by_user (user_id, allowed) VALUES (?, ?)", [userId, r.allowed]);
    }
    database.run("DROP TABLE skills_access_by_number");
  }
}

/** Resolve owner string ("default" or canonical phone) to user_id. Creates user if missing (for phone numbers). */
function resolveOwnerToUserId(database: import("bun:sqlite").Database, owner: string): number {
  const key = !owner || owner === "default" ? "default" : canonicalPhone(owner);
  const row = database.query("SELECT id FROM users WHERE phone_number = ?").get(key) as { id: number } | undefined;
  if (row) return row.id;
  if (key === "default") {
    database.run("INSERT INTO users (first_name, last_name, phone_number) VALUES (?, ?, ?)", ["Default", "", "default"]);
    return (database.query("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
  }
  database.run("INSERT INTO users (first_name, last_name, phone_number) VALUES (?, ?, ?)", ["", "", key]);
  return (database.query("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
}

/** Map user_id back to owner string for API (default -> "default", else phone_number). */
function userIdToOwner(database: import("bun:sqlite").Database, userId: number): string {
  const row = database.query("SELECT phone_number FROM users WHERE id = ?").get(userId) as { phone_number: string } | undefined;
  if (!row) return "default";
  return row.phone_number === "default" ? "default" : row.phone_number;
}

/** One-time: migrate tables that have owner column to user_id. */
function migrateOwnerColumnsToUserId(database: import("bun:sqlite").Database): void {
  const cols = database.query("PRAGMA table_info(facts)").all() as { name: string }[];
  const hasOwner = cols.some((c) => c.name === "owner");
  if (!hasOwner) return;

  const defaultUserId = resolveOwnerToUserId(database, "default");

  database.exec(`
    CREATE TABLE facts_new (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, key TEXT NOT NULL, value TEXT NOT NULL, scope TEXT NOT NULL DEFAULT 'user', tags TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (user_id, key, scope));
    CREATE TABLE conversation_new (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, seq INTEGER NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, PRIMARY KEY (user_id, seq));
    CREATE TABLE summary_new (user_id INTEGER NOT NULL PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, sentences TEXT NOT NULL);
    CREATE TABLE personality_new (user_id INTEGER NOT NULL PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, instructions TEXT NOT NULL);
    CREATE TABLE todos_new (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, text TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0, due TEXT, created_at TEXT NOT NULL);
  `);

  const factRows = database.query("SELECT owner, key, value, scope, tags, created_at, updated_at FROM facts").all() as Array<{ owner: string; key: string; value: string; scope: string; tags: string; created_at: string; updated_at: string }>;
  for (const r of factRows) {
    const uid = r.owner === "default" ? defaultUserId : resolveOwnerToUserId(database, r.owner);
    database.run("INSERT INTO facts_new (user_id, key, value, scope, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)", [uid, r.key, r.value, r.scope, r.tags, r.created_at, r.updated_at]);
  }

  const convRows = database.query("SELECT owner, seq, role, content FROM conversation").all() as Array<{ owner: string; seq: number; role: string; content: string }>;
  for (const r of convRows) {
    const uid = r.owner === "default" ? defaultUserId : resolveOwnerToUserId(database, r.owner);
    database.run("INSERT INTO conversation_new (user_id, seq, role, content) VALUES (?, ?, ?, ?)", [uid, r.seq, r.role, r.content]);
  }

  const sumRows = database.query("SELECT owner, sentences FROM summary").all() as Array<{ owner: string; sentences: string }>;
  for (const r of sumRows) {
    const uid = r.owner === "default" ? defaultUserId : resolveOwnerToUserId(database, r.owner);
    database.run("INSERT INTO summary_new (user_id, sentences) VALUES (?, ?)", [uid, r.sentences]);
  }

  const persRows = database.query("SELECT owner, instructions FROM personality").all() as Array<{ owner: string; instructions: string }>;
  for (const r of persRows) {
    const uid = r.owner === "default" ? defaultUserId : resolveOwnerToUserId(database, r.owner);
    database.run("INSERT INTO personality_new (user_id, instructions) VALUES (?, ?)", [uid, r.instructions]);
  }

  const todoRows = database.query("SELECT owner, text, done, due, created_at FROM todos").all() as Array<{ owner: string; text: string; done: number; due: string | null; created_at: string }>;
  for (const r of todoRows) {
    const uid = r.owner === "default" ? defaultUserId : resolveOwnerToUserId(database, r.owner);
    database.run("INSERT INTO todos_new (user_id, text, done, due, created_at) VALUES (?, ?, ?, ?, ?)", [uid, r.text, r.done, r.due, r.created_at]);
  }

  database.run("DROP TABLE facts");
  database.run("DROP TABLE conversation");
  database.run("DROP TABLE summary");
  database.run("DROP TABLE personality");
  database.run("DROP TABLE todos");
  database.run("ALTER TABLE facts_new RENAME TO facts");
  database.run("ALTER TABLE conversation_new RENAME TO conversation");
  database.run("ALTER TABLE summary_new RENAME TO summary");
  database.run("ALTER TABLE personality_new RENAME TO personality");
  database.run("ALTER TABLE todos_new RENAME TO todos");
  database.run("CREATE INDEX IF NOT EXISTS idx_facts_user_id ON facts(user_id)");
  database.run("CREATE INDEX IF NOT EXISTS idx_conversation_user_seq ON conversation(user_id, seq)");
  database.run("CREATE INDEX IF NOT EXISTS idx_todos_user_id ON todos(user_id)");
}

/** Copy data from JSON files into the DB. When overwrite is true (e.g. `bo migrate`), replace DB contents with JSON. When false (first open), only fill empty tables. */
function migrateFromJson(database: import("bun:sqlite").Database, overwrite: boolean): void {
  const projectRoot = process.env.BO_PROJECT_ROOT?.trim() || process.cwd();
  const boDir = dirname(getDbPath());

  const usersCount = (database.query("SELECT COUNT(*) AS c FROM users").get() as { c: number })?.c ?? 0;
  const doUsers = overwrite || usersCount === 0;
  if (doUsers) {
    if (overwrite) {
      database.run("DELETE FROM skills_access_by_user");
      database.run("DELETE FROM users");
    }
    const contactsPath = process.env.BO_CONTACTS_PATH?.trim() && existsSync(process.env.BO_CONTACTS_PATH!)
      ? process.env.BO_CONTACTS_PATH!
      : join(projectRoot, "config", "contacts.json");
    if (existsSync(contactsPath)) {
      try {
        const raw = readFileSync(contactsPath, "utf-8");
        const obj = JSON.parse(raw) as Record<string, unknown>;
        if (obj && typeof obj === "object") {
          const stmt = database.prepare("INSERT INTO users (first_name, last_name, phone_number) VALUES (?, ?, ?)");
          for (const [name, value] of Object.entries(obj)) {
            if (typeof value !== "string" || !name.trim()) continue;
            const num = canonicalPhone(value.trim());
            if (num.length < 10) continue;
            const [first = "", ...rest] = name.trim().split(/\s+/);
            const last = rest.join(" ").trim();
            stmt.run(first, last, num);
          }
        }
      } catch {
        /* ignore */
      }
    }
  }

  const registryCount = (database.query("SELECT COUNT(*) AS c FROM skills_registry").get() as { c: number })?.c ?? 0;
  const doRegistry = overwrite || registryCount === 0;
  if (doRegistry) {
    if (overwrite) database.run("DELETE FROM skills_registry");
    const registryPath = join(projectRoot, "skills", "registry.json");
    if (existsSync(registryPath)) {
      try {
        const raw = readFileSync(registryPath, "utf-8");
        const parsed = JSON.parse(raw) as { version?: number; skills?: Array<{ id: string; name: string; description: string; entrypoint: string; inputSchema?: unknown }> };
        if (parsed?.version === 1 && Array.isArray(parsed.skills)) {
          const stmt = database.prepare("INSERT INTO skills_registry (id, name, description, entrypoint, input_schema) VALUES (?, ?, ?, ?, ?)");
          for (const s of parsed.skills) {
            if (s?.id) stmt.run(s.id, s.name ?? "", s.description ?? "", s.entrypoint ?? "", JSON.stringify(s.inputSchema ?? {}));
          }
        }
      } catch {
        /* ignore */
      }
    }
  }

  const accessDefaultCount = (database.query("SELECT COUNT(*) AS c FROM skills_access_default").get() as { c: number })?.c ?? 0;
  const doAccess = overwrite || accessDefaultCount === 0;
  if (doAccess) {
    if (overwrite) database.run("DELETE FROM skills_access_default");
    const accessPath = join(projectRoot, "skills", "access.json");
    if (existsSync(accessPath)) {
      try {
        const raw = readFileSync(accessPath, "utf-8");
        const parsed = JSON.parse(raw) as { version?: number; default?: string[]; byNumber?: Record<string, string[]> };
        if (parsed?.version === 1) {
          const defaultAllowed = Array.isArray(parsed.default) ? parsed.default : [];
          database.run("INSERT INTO skills_access_default (id, allowed) VALUES (1, ?)", [JSON.stringify(defaultAllowed)]);
          const byNumber = parsed.byNumber && typeof parsed.byNumber === "object" ? parsed.byNumber : {};
          for (const [num, allowed] of Object.entries(byNumber)) {
            if (!Array.isArray(allowed)) continue;
            const canonical = canonicalPhone(num);
            if (canonical.length < 10) continue;
            const userRow = database.query("SELECT id FROM users WHERE phone_number = ?").get(canonical) as { id: number } | undefined;
            let userId: number;
            if (userRow) {
              userId = userRow.id;
            } else {
              database.run("INSERT INTO users (first_name, last_name, phone_number) VALUES (?, ?, ?)", ["", "", canonical]);
              userId = (database.query("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
            }
            database.run("INSERT OR REPLACE INTO skills_access_by_user (user_id, allowed) VALUES (?, ?)", [userId, JSON.stringify(allowed)]);
          }
        }
      } catch {
        /* ignore */
      }
    }
  }

  // --- Memory (facts), conversation, summary, personality, todos ---
  const owners = new Set<string>(["default"]);
  if (existsSync(boDir)) {
    for (const f of readdirSync(boDir)) {
      const m = f.match(/^memory_(.+)\.json$/) || f.match(/^conversation_(.+)\.json$/) || f.match(/^summary_(.+)\.json$/) || f.match(/^personality_(.+)\.json$/) || f.match(/^todos_(.+)\.json$/);
      if (m) owners.add(m[1]!);
    }
  }

  for (const owner of owners) {
    const userId = resolveOwnerToUserId(database, owner);
    if (overwrite) {
      database.run("DELETE FROM facts WHERE user_id = ?", [userId]);
      database.run("DELETE FROM conversation WHERE user_id = ?", [userId]);
      database.run("DELETE FROM summary WHERE user_id = ?", [userId]);
      database.run("DELETE FROM personality WHERE user_id = ?", [userId]);
      database.run("DELETE FROM todos WHERE user_id = ?", [userId]);
    }

    // Facts from memory.json / memory_<owner>.json
    const memoryFileName = owner === "default" ? "memory.json" : `memory_${owner}.json`;
    const memoryPath = join(boDir, memoryFileName);
    if (existsSync(memoryPath)) {
      try {
        const raw = readFileSync(memoryPath, "utf-8");
        const mem = JSON.parse(raw) as { version?: number; facts?: Array<{ key: string; value: string; scope?: string; tags?: string[]; createdAt?: string; updatedAt?: string }> };
        if (mem?.version === 1 && Array.isArray(mem.facts)) {
          const now = new Date().toISOString();
          const stmt = database.prepare("INSERT OR REPLACE INTO facts (user_id, key, value, scope, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
          for (const f of mem.facts) {
            const scope = f.scope === "global" ? "global" : "user";
            stmt.run(userId, f.key ?? "", f.value ?? "", scope, JSON.stringify(f.tags ?? []), f.createdAt ?? now, f.updatedAt ?? now);
          }
        }
      } catch {
        /* ignore */
      }
    }

    // Conversation
    const convFileName = owner === "default" ? "conversation.json" : `conversation_${owner}.json`;
    const convPath = join(boDir, convFileName);
    if (existsSync(convPath)) {
      try {
        const raw = readFileSync(convPath, "utf-8");
        const conv = JSON.parse(raw) as { messages?: Array<{ role: string; content: string }> };
        if (Array.isArray(conv?.messages) && conv.messages.length) {
          let seq = 1;
          const stmt = database.prepare("INSERT INTO conversation (user_id, seq, role, content) VALUES (?, ?, ?, ?)");
          for (const m of conv.messages) {
            stmt.run(userId, seq++, m.role ?? "user", m.content ?? "");
          }
        }
      } catch {
        /* ignore */
      }
    }

    // Summary
    const sumFileName = owner === "default" ? "summary.json" : `summary_${owner}.json`;
    const sumPath = join(boDir, sumFileName);
    if (existsSync(sumPath)) {
      try {
        const raw = readFileSync(sumPath, "utf-8");
        const sum = JSON.parse(raw) as { sentences?: string[] };
        if (Array.isArray(sum?.sentences) && sum.sentences.length) {
          database.run("INSERT OR REPLACE INTO summary (user_id, sentences) VALUES (?, ?)", [userId, JSON.stringify(sum.sentences)]);
        }
      } catch {
        /* ignore */
      }
    }

    // Personality
    const persFileName = owner === "default" ? "personality.json" : `personality_${owner}.json`;
    const persPath = join(boDir, persFileName);
    if (existsSync(persPath)) {
      try {
        const raw = readFileSync(persPath, "utf-8");
        const pers = JSON.parse(raw) as { instructions?: string[] };
        if (Array.isArray(pers?.instructions) && pers.instructions.length) {
          database.run("INSERT OR REPLACE INTO personality (user_id, instructions) VALUES (?, ?)", [userId, JSON.stringify(pers.instructions)]);
        }
      } catch {
        /* ignore */
      }
    }

    // Todos
    const todosFileName = owner === "default" ? "todos.json" : `todos_${owner}.json`;
    const todosPath = join(boDir, todosFileName);
    if (existsSync(todosPath)) {
      try {
        const raw = readFileSync(todosPath, "utf-8");
        const arr = JSON.parse(raw) as unknown;
        if (Array.isArray(arr) && arr.length) {
          const stmt = database.prepare("INSERT INTO todos (user_id, text, done, due, created_at) VALUES (?, ?, ?, ?, ?)");
          for (const t of arr) {
            const row = t as { text?: string; done?: boolean; due?: string; createdAt?: string };
            if (row && typeof row.text === "string") {
              stmt.run(userId, row.text, row.done ? 1 : 0, row.due ?? null, row.createdAt ?? new Date().toISOString());
            }
          }
        }
      } catch {
        /* ignore */
      }
    }
  }
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

/** Open DB, copy all data from JSON files into the DB (overwriting), then close. Run `bo migrate` to move JSON data into the DB now. */
export function runMigration(): void {
  const database = getDb();
  migrateFromJson(database, true);
  closeDb();
}

// --- Raw DB (admin UI) ---
export function dbGetTables(): string[] {
  const database = getDb();
  const rows = database.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
  return rows.map((r) => r.name);
}

export type DbColumnInfo = { cid: number; name: string; type: string; notnull: number; dflt_value: string | null; pk: number };
export function dbGetTableInfo(tableName: string): DbColumnInfo[] {
  const database = getDb();
  const safe = tableName.replace(/[^a-zA-Z0-9_]/g, "");
  if (safe !== tableName) return [];
  return database.query(`PRAGMA table_info(${safe})`).all() as DbColumnInfo[];
}

export type DbForeignKey = { id: number; seq: number; table: string; from: string; to: string };
export function dbGetForeignKeys(tableName: string): DbForeignKey[] {
  const database = getDb();
  const safe = tableName.replace(/[^a-zA-Z0-9_]/g, "");
  if (safe !== tableName) return [];
  return database.query(`PRAGMA foreign_key_list(${safe})`).all() as DbForeignKey[];
}

/** Run arbitrary SQL. Returns rows for SELECT; for writes returns { changes, lastId }. */
export function dbRunQuery(sql: string, params: unknown[] = []): { columns?: string[]; rows?: Record<string, unknown>[]; changes?: number; lastId?: number; error?: string } {
  const database = getDb();
  try {
    const trimmed = sql.trim();
    const isSelect = /^\s*SELECT\s/i.test(trimmed);
    if (isSelect) {
      const stmt = database.query(trimmed);
      const rows = stmt.all(...params) as Record<string, unknown>[];
      const stmtAny = stmt as { columnNames?: string[] };
      const columns = stmtAny.columnNames ?? (rows[0] ? Object.keys(rows[0]) : []);
      return { columns, rows };
    }
    const result = database.run(trimmed, ...params) as { changes?: number; lastInsertRowid?: number };
    return { changes: result.changes ?? 0, lastId: result.lastInsertRowid ?? undefined };
  } catch (e) {
    return { error: String(e) };
  }
}

/** Get one row from table where column = value (for FK drill-down). */
export function dbGetRowByColumn(tableName: string, column: string, value: unknown): Record<string, unknown> | null {
  const database = getDb();
  const safeTable = tableName.replace(/[^a-zA-Z0-9_]/g, "");
  const safeCol = column.replace(/[^a-zA-Z0-9_]/g, "");
  if (safeTable !== tableName || safeCol !== column) return null;
  const row = database.query(`SELECT * FROM ${safeTable} WHERE ${safeCol} = ?`).get(value) as Record<string, unknown> | undefined;
  return row ?? null;
}

// --- Users (contacts) ---
function userDisplayName(first: string, last: string): string {
  return [first, last].map((s) => s.trim()).filter(Boolean).join(" ") || "";
}

export function dbGetContactsNumberToName(): Map<string, string> {
  const database = getDb();
  const rows = database.query("SELECT first_name, last_name, phone_number FROM users").all() as { first_name: string; last_name: string; phone_number: string }[];
  const map = new Map<string, string>();
  for (const r of rows) {
    const num = canonicalPhone(r.phone_number);
    if (num.length >= 10) map.set(num, userDisplayName(r.first_name, r.last_name));
  }
  return map;
}

export function dbGetContactsNameToNumber(): Map<string, string> {
  const database = getDb();
  const rows = database.query("SELECT first_name, last_name, phone_number FROM users").all() as { first_name: string; last_name: string; phone_number: string }[];
  const map = new Map<string, string>();
  for (const r of rows) {
    const num = canonicalPhone(r.phone_number);
    if (num.length >= 10) map.set(userDisplayName(r.first_name, r.last_name).toLowerCase(), num);
  }
  return map;
}

export function dbGetContactsList(): Array<{ name: string; number: string }> {
  const database = getDb();
  const rows = database.query("SELECT first_name, last_name, phone_number FROM users ORDER BY last_name, first_name").all() as { first_name: string; last_name: string; phone_number: string }[];
  return rows.map((r) => ({ name: userDisplayName(r.first_name, r.last_name), number: r.phone_number }));
}

export function dbSetContacts(entries: Array<{ name: string; number: string }>): void {
  const database = getDb();
  const numbers = new Set<string>();
  for (const e of entries) {
    if (e.number?.trim()) numbers.add(canonicalPhone(e.number.trim()));
  }
  if (numbers.size) {
    const placeholders = Array.from(numbers).map(() => "?").join(",");
    database.run(`DELETE FROM users WHERE phone_number NOT IN (${placeholders})`, Array.from(numbers));
  } else {
    database.run("DELETE FROM users");
  }
  const stmt = database.prepare("INSERT INTO users (first_name, last_name, phone_number) VALUES (?, ?, ?) ON CONFLICT(phone_number) DO UPDATE SET first_name = excluded.first_name, last_name = excluded.last_name");
  for (const e of entries) {
    if (!e.name?.trim() || !e.number?.trim()) continue;
    const num = canonicalPhone(e.number.trim());
    if (num.length < 10) continue;
    const [first = "", ...rest] = e.name.trim().split(/\s+/);
    const last = rest.join(" ").trim();
    stmt.run(first, last, num);
  }
}

/** All distinct owners (for admin UI dropdown). Returns owner strings (e.g. "default", phone numbers). */
export function dbGetAllOwners(): string[] {
  const database = getDb();
  const rows = database.query(`
    SELECT user_id FROM facts
    UNION SELECT user_id FROM conversation
    UNION SELECT user_id FROM summary
    UNION SELECT user_id FROM personality
    UNION SELECT user_id FROM todos
    ORDER BY user_id
  `).all() as { user_id: number }[];
  const set = new Set(rows.map((r) => r.user_id));
  const list = Array.from(set).map((id) => userIdToOwner(database, id));
  if (!list.includes("default")) list.unshift("default");
  return list;
}

// --- Skills registry ---
export type SkillRow = { id: string; name: string; description: string; entrypoint: string; input_schema: string };

export function dbGetSkillsRegistry(): SkillRow[] {
  const database = getDb();
  return database.query("SELECT id, name, description, entrypoint, input_schema FROM skills_registry").all() as SkillRow[];
}

export function dbSetSkillsRegistry(skills: Array<{ id: string; name: string; description: string; entrypoint: string; inputSchema: unknown }>): void {
  const database = getDb();
  database.run("DELETE FROM skills_registry");
  const stmt = database.prepare("INSERT INTO skills_registry (id, name, description, entrypoint, input_schema) VALUES (?, ?, ?, ?, ?)");
  for (const s of skills) {
    stmt.run(s.id, s.name, s.description, s.entrypoint, JSON.stringify(s.inputSchema ?? {}));
  }
}

// --- Skills access ---
export function dbGetSkillsAccessDefault(): string[] {
  const database = getDb();
  const row = database.query("SELECT allowed FROM skills_access_default WHERE id = 1").get() as { allowed: string } | undefined;
  if (!row) return [];
  try {
    const arr = JSON.parse(row.allowed) as unknown;
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function dbGetSkillsAccessByNumber(): Record<string, string[]> {
  const database = getDb();
  const rows = database.query(`
    SELECT u.phone_number, s.allowed FROM skills_access_by_user s
    JOIN users u ON s.user_id = u.id
  `).all() as { phone_number: string; allowed: string }[];
  const out: Record<string, string[]> = {};
  for (const r of rows) {
    const num = canonicalPhone(r.phone_number);
    try {
      const arr = JSON.parse(r.allowed) as unknown;
      out[num] = Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
    } catch {
      out[num] = [];
    }
  }
  return out;
}

export function dbSetSkillsAccess(defaultAllowed: string[], byNumber: Record<string, string[]>): void {
  const database = getDb();
  database.run("DELETE FROM skills_access_default");
  database.run("INSERT INTO skills_access_default (id, allowed) VALUES (1, ?)", [JSON.stringify(defaultAllowed)]);
  database.run("DELETE FROM skills_access_by_user");
  for (const [num, allowed] of Object.entries(byNumber)) {
    if (!Array.isArray(allowed)) continue;
    const canonical = canonicalPhone(num);
    if (canonical.length < 10) continue;
    let userRow = database.query("SELECT id FROM users WHERE phone_number = ?").get(canonical) as { id: number } | undefined;
    if (!userRow) {
      database.run("INSERT INTO users (first_name, last_name, phone_number) VALUES (?, ?, ?)", ["", "", canonical]);
      userRow = database.query("SELECT last_insert_rowid() AS id").get() as { id: number };
    }
    database.run("INSERT INTO skills_access_by_user (user_id, allowed) VALUES (?, ?)", [userRow.id, JSON.stringify(allowed)]);
  }
}

// --- Facts ---
export function dbGetFacts(owner: string): Array<{ key: string; value: string; scope: string; tags: string; createdAt: string; updatedAt: string }> {
  const database = getDb();
  const userId = resolveOwnerToUserId(database, owner);
  return database.query("SELECT key, value, scope, tags, created_at AS createdAt, updated_at AS updatedAt FROM facts WHERE user_id = ?").all(userId) as Array<{ key: string; value: string; scope: string; tags: string; createdAt: string; updatedAt: string }>;
}

export function dbUpsertFact(owner: string, key: string, value: string, scope: string, tags: string[]): void {
  const database = getDb();
  const userId = resolveOwnerToUserId(database, owner);
  const now = new Date().toISOString();
  const tagsJson = JSON.stringify(tags);
  database.run(
    `INSERT INTO facts (user_id, key, value, scope, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, key, scope) DO UPDATE SET value = ?, tags = ?, updated_at = ?`,
    [userId, key, value, scope, tagsJson, now, now, value, tagsJson, now]
  );
}

export function dbDeleteFact(owner: string, key: string, scope: string): boolean {
  const database = getDb();
  const userId = resolveOwnerToUserId(database, owner);
  const result = database.run("DELETE FROM facts WHERE user_id = ? AND key = ? AND scope = ?", [userId, key, scope]);
  return (result as { changes: number }).changes > 0;
}

// --- Conversation ---
export function dbGetConversation(owner: string, max: number): Array<{ role: string; content: string }> {
  const database = getDb();
  const userId = resolveOwnerToUserId(database, owner);
  const rows = database.query("SELECT role, content FROM conversation WHERE user_id = ? ORDER BY seq DESC LIMIT ?").all(userId, max) as Array<{ role: string; content: string }>;
  return rows.reverse();
}

export function dbAppendConversation(owner: string, userContent: string, assistantContent: string, maxMessages: number): void {
  const database = getDb();
  const userId = resolveOwnerToUserId(database, owner);
  const next = database.query("SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM conversation WHERE user_id = ?").get(userId) as { n: number };
  const seq = next?.n ?? 1;
  database.run("INSERT INTO conversation (user_id, seq, role, content) VALUES (?, ?, 'user', ?)", [userId, seq, userContent.trim()]);
  database.run("INSERT INTO conversation (user_id, seq, role, content) VALUES (?, ?, 'assistant', ?)", [userId, seq + 1, assistantContent.trim()]);
  const count = database.query("SELECT COUNT(*) AS c FROM conversation WHERE user_id = ?").get(userId) as { c: number };
  if (count && count.c > maxMessages) {
    const toDelete = count.c - maxMessages;
    database.run(`DELETE FROM conversation WHERE user_id = ? AND seq IN (SELECT seq FROM conversation WHERE user_id = ? ORDER BY seq LIMIT ?)`, [userId, userId, toDelete]);
  }
}

// --- Summary ---
const MAX_SUMMARY_SENTENCES = 50;

export function dbAppendSummarySentence(owner: string, sentence: string): void {
  const database = getDb();
  const userId = resolveOwnerToUserId(database, owner);
  const s = sentence.trim();
  if (!s) return;
  const row = database.query("SELECT sentences FROM summary WHERE user_id = ?").get(userId) as { sentences: string } | undefined;
  const sentences: string[] = row ? (JSON.parse(row.sentences) as string[]) : [];
  sentences.push(s);
  const trimmed = sentences.length > MAX_SUMMARY_SENTENCES ? sentences.slice(-MAX_SUMMARY_SENTENCES) : sentences;
  database.run("INSERT INTO summary (user_id, sentences) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET sentences = ?", [userId, JSON.stringify(trimmed), JSON.stringify(trimmed)]);
}

export function dbGetSummary(owner: string): string {
  const database = getDb();
  const userId = resolveOwnerToUserId(database, owner);
  const row = database.query("SELECT sentences FROM summary WHERE user_id = ?").get(userId) as { sentences: string } | undefined;
  if (!row) return "";
  try {
    const sentences = JSON.parse(row.sentences) as string[];
    return Array.isArray(sentences) ? sentences.join("\n") : "";
  } catch {
    return "";
  }
}

// --- Personality ---
const MAX_PERSONALITY_INSTRUCTIONS = 20;

export function dbAppendPersonalityInstruction(owner: string, instruction: string): void {
  const database = getDb();
  const userId = resolveOwnerToUserId(database, owner);
  const raw = instruction.trim();
  if (!raw) return;
  const toAdd = raw.includes(". ") ? raw.split(/.\.\s+/).map((s) => s.trim()).filter(Boolean) : [raw];
  const row = database.query("SELECT instructions FROM personality WHERE user_id = ?").get(userId) as { instructions: string } | undefined;
  const instructions: string[] = row ? (JSON.parse(row.instructions) as string[]) : [];
  let changed = false;
  for (const s of toAdd) {
    if (s && !instructions.includes(s)) {
      instructions.push(s);
      changed = true;
    }
  }
  if (!changed) return;
  const trimmed = instructions.length > MAX_PERSONALITY_INSTRUCTIONS ? instructions.slice(-MAX_PERSONALITY_INSTRUCTIONS) : instructions;
  database.run("INSERT INTO personality (user_id, instructions) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET instructions = ?", [userId, JSON.stringify(trimmed), JSON.stringify(trimmed)]);
}

export function dbGetPersonality(owner: string): string {
  const database = getDb();
  const userId = resolveOwnerToUserId(database, owner);
  const row = database.query("SELECT instructions FROM personality WHERE user_id = ?").get(userId) as { instructions: string } | undefined;
  if (!row) return "";
  try {
    const arr = JSON.parse(row.instructions) as string[];
    return Array.isArray(arr) ? arr.join(". ") : "";
  } catch {
    return "";
  }
}

// --- Todos ---
export function dbGetTodos(owner: string): Array<{ id: number; text: string; done: number; due: string | null; createdAt: string }> {
  const database = getDb();
  const userId = resolveOwnerToUserId(database, owner);
  return database.query("SELECT id, text, done, due, created_at AS createdAt FROM todos WHERE user_id = ? ORDER BY id").all(userId) as Array<{ id: number; text: string; done: number; due: string | null; createdAt: string }>;
}

export function dbAddTodo(owner: string, text: string, due: string | null): void {
  const database = getDb();
  const userId = resolveOwnerToUserId(database, owner);
  const now = new Date().toISOString();
  database.run("INSERT INTO todos (user_id, text, done, due, created_at) VALUES (?, ?, 0, ?, ?)", [userId, text, due, now]);
}

export function dbUpdateTodoDone(owner: string, id: number): boolean {
  const database = getDb();
  const userId = resolveOwnerToUserId(database, owner);
  const result = database.run("UPDATE todos SET done = 1 WHERE user_id = ? AND id = ?", [userId, id]);
  return (result as { changes: number }).changes > 0;
}

export function dbDeleteTodo(owner: string, id: number): boolean {
  const database = getDb();
  const userId = resolveOwnerToUserId(database, owner);
  const result = database.run("DELETE FROM todos WHERE user_id = ? AND id = ?", [userId, id]);
  return (result as { changes: number }).changes > 0;
}

export function dbUpdateTodoText(owner: string, id: number, text: string): boolean {
  const database = getDb();
  const userId = resolveOwnerToUserId(database, owner);
  const result = database.run("UPDATE todos SET text = ? WHERE user_id = ? AND id = ?", [text, userId, id]);
  return (result as { changes: number }).changes > 0;
}

export function dbUpdateTodoDue(owner: string, id: number, due: string): boolean {
  const database = getDb();
  const userId = resolveOwnerToUserId(database, owner);
  const result = database.run("UPDATE todos SET due = ? WHERE user_id = ? AND id = ?", [due, userId, id]);
  return (result as { changes: number }).changes > 0;
}
