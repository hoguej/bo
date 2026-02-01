/**
 * Daemon router tests: run the router with LLM mock and DB.
 * Uses DATABASE_URL (your non-prod DB). Needs at least one user with telegram_id.
 *
 * Run: bun test tests/daemon/router.test.ts   (or bun run test:daemon)
 */

import { describe, it, expect, beforeAll } from "bun:test";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { Pool } from "pg";

const PROJECT_ROOT = join(import.meta.dir, "..", "..");
const ROUTER_SCRIPT = join(PROJECT_ROOT, "scripts", "router.ts");
const FIXTURE_MOCK = join(PROJECT_ROOT, "tests", "fixtures", "llm-mock-daemon.json");

const DATABASE_URL = process.env.DATABASE_URL;

const ROUTER_TIMEOUT_MS = 20_000;

async function runRouter(
  message: string,
  env: Record<string, string> = {}
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const proc = spawn("bun", ["run", "--bun", ROUTER_SCRIPT, message], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (d) => (stdout += d.toString()));
    proc.stderr?.on("data", (d) => (stderr += d.toString()));
    const done = (code: number) => {
      clearTimeout(timer);
      resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code });
    };
    proc.on("close", (code) => done(code ?? 1));
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve({ stdout: "", stderr: "Router timed out", code: 1 });
    }, ROUTER_TIMEOUT_MS);
  });
}

/** Ensure test DB has at least one user with telegram_id; return that id for use as owner. */
async function getTestTelegramId(): Promise<string | null> {
  if (!DATABASE_URL) return null;
  const pool = new Pool({ connectionString: DATABASE_URL });
  try {
    const result = await pool.query(
      "SELECT telegram_id FROM users WHERE telegram_id IS NOT NULL AND telegram_id != '' LIMIT 1"
    );
    await pool.end();
    return result.rows[0]?.telegram_id ?? null;
  } catch {
    await pool.end();
    return null;
  }
}

describe("daemon router", () => {
  let testTelegramId: string | null = null;

  beforeAll(async () => {
    if (DATABASE_URL) {
      testTelegramId = await getTestTelegramId();
    }
  });

  it("exits with clear message when AI_GATEWAY_API_KEY is missing", async () => {
    const env: Record<string, string> = {
      AI_GATEWAY_API_KEY: "",
      BO_LLM_MOCK_PATH: "",
      BO_REQUEST_FROM: "telegram:12345",
      BO_REQUEST_TO: "telegram",
    };
    if (DATABASE_URL) env.DATABASE_URL = DATABASE_URL;
    const { stdout, stderr, code } = await runRouter("hello", env);
    expect(code).toBe(0); // router exits 0 after writing excuse
    expect(stderr).toMatch(/Missing AI Gateway auth|AI_GATEWAY_API_KEY/);
    expect(stdout.length).toBeGreaterThan(0); // random excuse written to stdout
  });

  it("exits with message when no message provided", async () => {
    if (!DATABASE_URL) {
      console.warn("Skipping: DATABASE_URL required (router needs DB for config)");
      return;
    }
    const env: Record<string, string> = {
      DATABASE_URL,
      AI_GATEWAY_API_KEY: "dummy",
      BO_LLM_MOCK_PATH: FIXTURE_MOCK,
      BO_REQUEST_FROM: "telegram:12345",
    };
    const { stdout, stderr, code } = await runRouter("", env);
    expect(code).toBe(0);
    expect(stderr).toMatch(/No message|messageLen=0/);
    expect(stdout.length).toBeGreaterThan(0);
  });

  it("returns valid response with LLM mock and test DB (create_a_response)", async () => {
    if (!DATABASE_URL) {
      console.warn("Skipping: DATABASE_URL not set");
      return;
    }
    if (!testTelegramId) {
      console.warn("Skipping: no user with telegram_id in DB (seed or add one)");
      return;
    }

    const env: Record<string, string> = {
      DATABASE_URL,
      AI_GATEWAY_API_KEY: "dummy",
      BO_LLM_MOCK_PATH: FIXTURE_MOCK,
      BO_REQUEST_FROM: `telegram:${testTelegramId}`,
      BO_REQUEST_TO: "telegram",
      BO_REQUEST_IS_SELF_CHAT: "false",
      BO_REQUEST_IS_FROM_ME: "false",
    };

    const { stdout, stderr, code } = await runRouter("hi", env);

    expect(code).toBe(0);
    expect(stdout.length).toBeGreaterThan(0);
    expect(stdout).not.toMatch(/Error:|TypeError|undefined is not an object/);
    expect(stderr).toMatch(/decision: skill=create_a_response/);
    expect(stdout).toMatch(/Hi|help/i);
  }, ROUTER_TIMEOUT_MS + 2000);

  it("returns fallback excuse when what_to_do returns invalid JSON", async () => {
    if (!DATABASE_URL || !testTelegramId) return;

    const { writeFileSync } = await import("node:fs");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const tmpDir = mkdtempSync(join(tmpdir(), "bo-daemon-test-"));
    const mockPath = join(tmpDir, "mock.json");
    writeFileSync(
      mockPath,
      JSON.stringify({
        responses: {
          fact_finding: "[]",
          what_to_do: "not valid json",
          create_response: "Hi",
          summary: "User said hello.",
        },
        default: "[]",
      }),
      "utf8"
    );

    const env: Record<string, string> = {
      DATABASE_URL: DATABASE_URL!,
      AI_GATEWAY_API_KEY: "dummy",
      BO_LLM_MOCK_PATH: mockPath,
      BO_REQUEST_FROM: `telegram:${testTelegramId}`,
      BO_REQUEST_TO: "telegram",
    };

    const { stdout, stderr, code } = await runRouter("hello", env);

    expect(code).toBe(0);
    expect(stdout.length).toBeGreaterThan(0);
    expect(stderr).toMatch(/what_to_do parse failed|parse failed/);
    const { rmSync } = await import("node:fs");
    rmSync(tmpDir, { recursive: true });
  }, ROUTER_TIMEOUT_MS + 2000);

  it("does not leak stack traces or internal errors to stdout", async () => {
    if (!DATABASE_URL || !testTelegramId) return;

    const env: Record<string, string> = {
      DATABASE_URL,
      AI_GATEWAY_API_KEY: "dummy",
      BO_LLM_MOCK_PATH: FIXTURE_MOCK,
      BO_REQUEST_FROM: `telegram:${testTelegramId}`,
      BO_REQUEST_TO: "telegram",
    };

    const { stdout, code } = await runRouter("what's up?", env);

    expect(code).toBe(0);
    expect(stdout).not.toMatch(/at Object\.|at Module\.|at async|\.ts:\d+:\d+/);
    expect(stdout).not.toMatch(/numberToName\.get is not a function|fullSummary\.trim/);
  }, ROUTER_TIMEOUT_MS + 2000);
});
