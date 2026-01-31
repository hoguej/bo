/**
 * Integration tests for the reminder skill.
 * Run with: bun test tests/reminder.test.ts
 */

import { describe, it, expect, afterAll } from "bun:test";
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const PROJECT_ROOT = dirname(dirname(import.meta.path));
const TEST_ROOT = mkdtempSync(join(tmpdir(), "bo-reminder-tests-"));
const DB_PATH = join(TEST_ROOT, "bo.db");
process.env.BO_DB_PATH = DB_PATH;
process.env.BO_PROJECT_ROOT = PROJECT_ROOT;

const { dbGetDueReminders, dbAddReminder, dbDeleteReminder, dbResolveOwnerToUserId } = await import("../src/db");

const REMINDER_SCRIPT = join(PROJECT_ROOT, "scripts/skills/reminder.ts");

/** Run the reminder skill with JSON input and env vars, return { stdout, stderr, code }. */
async function runReminderSkill(
  input: Record<string, unknown>,
  env: Record<string, string> = {}
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const proc = spawn("bun", ["run", "--bun", REMINDER_SCRIPT], {
      env: { ...process.env, BO_DB_PATH: DB_PATH, BO_PROJECT_ROOT: PROJECT_ROOT, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    proc.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    proc.on("close", (code) => resolve({ stdout, stderr, code: code ?? 1 }));
    proc.stdin.write(JSON.stringify(input));
    proc.stdin.end();
  });
}

describe("reminder skill", () => {
  // Use a test user identity (default owner)
  const testEnv = { BO_REQUEST_FROM: "default" };

  it("should reject missing action", async () => {
    const { stderr, code } = await runReminderSkill({}, testEnv);
    expect(code).toBe(1);
    expect(stderr).toContain("action must be create, list, update, or delete");
  });

  it("should reject invalid action", async () => {
    const { stderr, code } = await runReminderSkill({ action: "invalid" }, testEnv);
    expect(code).toBe(1);
    expect(stderr).toContain("action must be create, list, update, or delete");
  });

  it("should require text for create", async () => {
    const { stdout, code } = await runReminderSkill({ action: "create" }, testEnv);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.response).toContain("Reminder text is required");
  });

  it("should require time for one-off reminder", async () => {
    const { stdout, code } = await runReminderSkill(
      { action: "create", text: "test reminder" },
      testEnv
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.response).toContain("provide a time");
  });

  it("should create a reminder with fire_at_iso", async () => {
    const futureTime = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour from now
    const { stdout, stderr, code } = await runReminderSkill(
      { action: "create", text: "test the reminder system", fire_at_iso: futureTime },
      testEnv
    );
    // Log for debugging if it fails
    if (code !== 0) {
      console.error("stderr:", stderr);
    }
    expect(code).toBe(0);
    expect(stderr).not.toContain("error:");
    const parsed = JSON.parse(stdout);
    expect(parsed.response).toMatch(/Reminder #\d+ set/);
    expect(parsed.response).toContain("test the reminder system");
  });

  it("should create a reminder with time string (7:30 AM)", async () => {
    const { stdout, stderr, code } = await runReminderSkill(
      { action: "create", text: "do something", time: "7:30 AM" },
      testEnv
    );
    if (code !== 0) {
      console.error("stderr:", stderr);
    }
    expect(code).toBe(0);
    expect(stderr).not.toContain("error:");
    const parsed = JSON.parse(stdout);
    expect(parsed.response).toMatch(/Reminder #\d+ set/);
    expect(parsed.response).toContain("do something");
  });

  it("should create a reminder with at string (7:42 am)", async () => {
    const { stdout, stderr, code } = await runReminderSkill(
      { action: "create", text: "do something else", at: "7:42 am" },
      testEnv
    );
    if (code !== 0) {
      console.error("stderr:", stderr);
    }
    expect(code).toBe(0);
    expect(stderr).not.toContain("error:");
    const parsed = JSON.parse(stdout);
    expect(parsed.response).toMatch(/Reminder #\d+ set/);
    expect(parsed.response).toContain("do something else");
  });

  it("should list reminders", async () => {
    const { stdout, stderr, code } = await runReminderSkill({ action: "list" }, testEnv);
    if (code !== 0) {
      console.error("stderr:", stderr);
    }
    expect(code).toBe(0);
    expect(stderr).not.toContain("error:");
    const parsed = JSON.parse(stdout);
    // Either "You have no reminders" or a list
    expect(parsed.response).toBeDefined();
  });

  it("should normalize 'set' action to 'create'", async () => {
    const futureTime = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    const { stdout, stderr, code } = await runReminderSkill(
      { action: "set", text: "normalized action test", fire_at_iso: futureTime },
      testEnv
    );
    if (code !== 0) {
      console.error("stderr:", stderr);
    }
    expect(code).toBe(0);
    expect(stderr).not.toContain("error:");
    const parsed = JSON.parse(stdout);
    expect(parsed.response).toMatch(/Reminder #\d+ set/);
  });
});

describe("reminder scheduler (db queries)", () => {
  let testReminderId: number | null = null;

  afterAll(() => {
    // Clean up test reminder
    if (testReminderId) {
      try {
        dbDeleteReminder(testReminderId);
      } catch (_) {}
    }
  });

  it("dbGetDueReminders should return one-off reminders with fire_at_utc in the past", () => {
    const userId = dbResolveOwnerToUserId("default");
    expect(userId).not.toBeNull();

    // Create a reminder that's already past due (1 minute ago)
    const pastTime = new Date(Date.now() - 60 * 1000).toISOString();
    testReminderId = dbAddReminder(
      userId!,
      userId!,
      "test due reminder",
      "one_off",
      pastTime,
      null,
      null
    );
    expect(testReminderId).toBeGreaterThan(0);

    // Query for due reminders
    const nowIso = new Date().toISOString();
    const dueReminders = dbGetDueReminders(nowIso);

    // Should include our test reminder
    const found = dueReminders.find((r) => r.id === testReminderId);
    expect(found).toBeDefined();
    expect(found?.text).toBe("test due reminder");
  });

  it("dbGetDueReminders should NOT return future reminders", () => {
    const userId = dbResolveOwnerToUserId("default");
    expect(userId).not.toBeNull();

    // Create a reminder 1 hour in the future
    const futureTime = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const futureId = dbAddReminder(
      userId!,
      userId!,
      "test future reminder",
      "one_off",
      futureTime,
      null,
      null
    );
    expect(futureId).toBeGreaterThan(0);

    // Query for due reminders
    const nowIso = new Date().toISOString();
    const dueReminders = dbGetDueReminders(nowIso);

    // Should NOT include the future reminder
    const found = dueReminders.find((r) => r.id === futureId);
    expect(found).toBeUndefined();

    // Clean up
    dbDeleteReminder(futureId);
  });
});

afterAll(() => {
  try {
    rmSync(TEST_ROOT, { recursive: true, force: true });
  } catch (_) {}
});
