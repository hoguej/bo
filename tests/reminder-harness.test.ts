/**
 * Full test harness around scheduled reminders.
 * Run with: bun test tests/reminder-harness.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { Database } from "bun:sqlite";

const PROJECT_ROOT = dirname(dirname(import.meta.path));
const TEST_ROOT = mkdtempSync(join(tmpdir(), "bo-reminder-harness-"));
const DB_PATH = join(TEST_ROOT, "bo.db");

function runRouter(
  message: string,
  mockResponses: Record<string, unknown>,
  envOverrides: Record<string, string> = {}
): Promise<{ stdout: string; stderr: string; code: number }> {
  const mockPath = join(TEST_ROOT, `llm-mock-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  writeFileSync(mockPath, JSON.stringify({ responses: mockResponses }, null, 2));
  return new Promise((resolve) => {
    const proc = spawn("bun", ["run", join(PROJECT_ROOT, "scripts/router.ts"), message], {
      env: {
        ...process.env,
        BO_DB_PATH: DB_PATH,
        BO_PROJECT_ROOT: PROJECT_ROOT,
        BO_USE_LLM_MOCK: "1",
        BO_LLM_MOCK_PATH: mockPath,
        AI_GATEWAY_API_KEY: "test-key",
        BO_REQUEST_FROM: "default",
        BO_REQUEST_TO: "scheduler",
        BO_REQUEST_IS_SELF_CHAT: "true",
        BO_REQUEST_IS_FROM_ME: "false",
        ...envOverrides,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    proc.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    proc.on("close", (code) => resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code: code ?? 1 }));
  });
}

function withDb<T>(fn: (db: Database) => T): T {
  const db = new Database(DB_PATH);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

describe("scheduled reminder harness", () => {
  beforeAll(async () => {
    // Initialize schema and baseline state
    await runRouter("hi", {
      fact_finding: "[]",
      what_to_do: JSON.stringify({ skill: "create_a_response" }),
      create_response: "ok",
      summary: "",
    });
  });
  it("does not create a todo even if what_to_do returns todo", async () => {
    const mockResponses = {
      fact_finding: "[]",
      what_to_do: JSON.stringify({ skill: "todo", action: "add", text: "should-not-create" }),
      create_response: "Reminder: do something.",
      summary: "",
    };

    const { stdout, code, stderr } = await runRouter("[scheduled: reminder] do something", mockResponses);
    if (code !== 0) {
      console.error(stderr);
    }
    expect(code).toBe(0);
    expect(stdout).toBe("Reminder: do something.");

    const todoCount = withDb((db) => {
      const row = db.query("SELECT COUNT(*) AS c FROM todos").get() as { c: number };
      return row?.c ?? 0;
    });
    expect(todoCount).toBe(0);

    const createReq = withDb((db) => {
      const row = db
        .query("SELECT request_doc FROM llm_log WHERE step = 'create_response' ORDER BY id DESC LIMIT 1")
        .get() as { request_doc: string } | undefined;
      return row?.request_doc ?? "";
    });
    const doc = createReq ? JSON.parse(createReq) : null;
    const userContent = doc?.messages?.find((m: { role: string }) => m.role === "user")?.content ?? "";
    expect(userContent).toContain("reminder_triggered:");
    expect(userContent).toContain("reminder_text:");
    expect(userContent).toContain("do something");
  });

  it("does not create a new reminder even if what_to_do returns reminder", async () => {
    const beforeCount = withDb((db) => {
      const row = db.query("SELECT COUNT(*) AS c FROM reminders").get() as { c: number };
      return row?.c ?? 0;
    });

    const mockResponses = {
      fact_finding: "[]",
      what_to_do: JSON.stringify({
        skill: "reminder",
        action: "create",
        text: "should-not-create-reminder",
        fire_at_iso: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      }),
      create_response: "Reminder: do something else.",
      summary: "",
    };

    const { stdout, code, stderr } = await runRouter("[scheduled: reminder] do something else", mockResponses);
    if (code !== 0) {
      console.error(stderr);
    }
    expect(code).toBe(0);
    expect(stdout).toBe("Reminder: do something else.");

    const afterCount = withDb((db) => {
      const row = db.query("SELECT COUNT(*) AS c FROM reminders").get() as { c: number };
      return row?.c ?? 0;
    });
    expect(afterCount).toBe(beforeCount);
  });
});

afterAll(() => {
  try {
    rmSync(TEST_ROOT, { recursive: true, force: true });
  } catch (_) {}
});
