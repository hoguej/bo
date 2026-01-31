#!/usr/bin/env bun
/**
 * Test for global facts feature
 */

import { Database } from "bun:sqlite";
import { existsSync, unlinkSync } from "fs";

const TEST_DB_PATH = "/tmp/bo-test-global-facts.db";

// Clean up
if (existsSync(TEST_DB_PATH)) {
  unlinkSync(TEST_DB_PATH);
}

// Create test DB
const db = new Database(TEST_DB_PATH);

db.exec(`
  CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone_number TEXT UNIQUE,
    telegram_id TEXT UNIQUE,
    first_name TEXT,
    last_name TEXT,
    timezone_iana TEXT DEFAULT 'America/New_York'
  );

  CREATE TABLE facts (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    scope TEXT NOT NULL DEFAULT 'user',
    tags TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, key, scope)
  );

  INSERT INTO users (id, phone_number, first_name) VALUES (1, 'default', 'Default');
  INSERT INTO users (phone_number, first_name) VALUES ('7404749170', 'Jon');
`);

const defaultUserId = 1;
const jonUserId = 2;

// Add a global fact
db.run(
  "INSERT INTO facts (user_id, key, value, scope, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))",
  [defaultUserId, "bo_gender", "male", "global", "[]"]
);

// Add a user-specific fact for Jon
db.run(
  "INSERT INTO facts (user_id, key, value, scope, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))",
  [jonUserId, "home_city", "Circleville", "user", "[]"]
);

db.close();

console.log("✓ Test database created with global and user facts");

// Now test reading facts
process.env.BO_DB_PATH = TEST_DB_PATH;

const { dbGetFacts } = await import("../src/db");

// Get facts for Jon - should include both global and user facts
const jonFacts = dbGetFacts("7404749170");

console.log("\n--- Jon's facts (should include global facts) ---");
console.log(JSON.stringify(jonFacts, null, 2));

const hasGlobalFact = jonFacts.some(f => f.key === "bo_gender" && f.value === "male" && f.scope === "global");
const hasUserFact = jonFacts.some(f => f.key === "home_city" && f.value === "Circleville" && f.scope === "user");

if (hasGlobalFact && hasUserFact) {
  console.log("\n✓ TEST PASSED: Jon's facts include both global and user-specific facts");
  if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);
  process.exit(0);
} else {
  console.error("\n✗ TEST FAILED:");
  if (!hasGlobalFact) console.error("  - Missing global fact (bo_gender)");
  if (!hasUserFact) console.error("  - Missing user fact (home_city)");
  if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);
  process.exit(1);
}
