#!/usr/bin/env bun
/**
 * Integration test for listing reminders for a specific contact
 */

import { execSync } from "child_process";
import { existsSync, unlinkSync } from "fs";
import { Database } from "bun:sqlite";

const TEST_DB_PATH = "/tmp/bo-test-reminder-list.db";

// Clean up any existing test DB
if (existsSync(TEST_DB_PATH)) {
  unlinkSync(TEST_DB_PATH);
}

// Create test database
const db = new Database(TEST_DB_PATH);

// Create schema
db.exec(`
  CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone_number TEXT UNIQUE,
    telegram_id TEXT UNIQUE,
    first_name TEXT,
    last_name TEXT,
    timezone_iana TEXT DEFAULT 'America/New_York'
  );

  CREATE TABLE reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    creator_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    recipient_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('one_off', 'recurring')),
    fire_at_utc TEXT,
    recurrence TEXT,
    next_fire_at_utc TEXT,
    created_at TEXT NOT NULL,
    sent_at TEXT,
    last_fired_at TEXT
  );
`);

// Insert test data (use canonical 10-digit phone numbers)
const ownerUserId = db.prepare(`
  INSERT INTO users (phone_number, telegram_id, first_name, timezone_iana)
  VALUES ('5555551234', 'telegram:8574143544', 'Jeff', 'America/New_York')
`).run().lastInsertRowid;

const caraUserId = db.prepare(`
  INSERT INTO users (phone_number, telegram_id, first_name, timezone_iana)
  VALUES ('5555555678', 'telegram:cara123', 'Cara', 'America/New_York')
`).run().lastInsertRowid;

// Add a reminder FOR Cara
const reminderId = db.prepare(`
  INSERT INTO reminders (creator_user_id, recipient_user_id, text, kind, fire_at_utc, next_fire_at_utc, created_at)
  VALUES (?, ?, 'We''re leaving the house for Circleville', 'one_off', '2026-01-31T21:00:00.000Z', '2026-01-31T21:00:00.000Z', datetime('now'))
`).run(ownerUserId, caraUserId).lastInsertRowid;

db.close();

console.log("✓ Test database created");
console.log(`  Owner ID: ${ownerUserId}`);
console.log(`  Cara ID: ${caraUserId}`);
console.log(`  Reminder ID: ${reminderId}`);

// Test the skill
const skillInput = JSON.stringify({
  action: "list",
  for_contact: "Cara"
});

try {
  const output = execSync(
    `echo '${skillInput}' | bun run scripts/skills/reminder.ts`,
    {
      cwd: "/Users/hoguej/dev/bo",
      env: {
        ...process.env,
        BO_DB_PATH: TEST_DB_PATH,
        BO_REQUEST_FROM: "5555551234"
      },
      encoding: "utf8",
      shell: "/bin/bash"
    }
  );

  console.log("\n--- Skill Output ---");
  console.log(output);
  console.log("--- End Output ---\n");

  // Verify the output contains the reminder
  if (output.includes("Cara's reminders:") && output.includes("We're leaving the house for Circleville")) {
    console.log("✓ TEST PASSED: Reminder for Cara is shown correctly");
    process.exit(0);
  } else {
    console.error("✗ TEST FAILED: Expected to see Cara's reminder but got:");
    console.error(output);
    process.exit(1);
  }
} catch (error: any) {
  console.error("✗ TEST FAILED with error:");
  console.error(error.message);
  if (error.stdout) {
    console.error("STDOUT:", error.stdout);
  }
  if (error.stderr) {
    console.error("STDERR:", error.stderr);
  }
  process.exit(1);
} finally {
  // Clean up
  if (existsSync(TEST_DB_PATH)) {
    unlinkSync(TEST_DB_PATH);
  }
}
