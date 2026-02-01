/**
 * Daemon integration test: run router as subprocess (same way watch-self does)
 * with LLM mock and DB. Uses DATABASE_URL (your non-prod DB). Needs a user with telegram_id.
 *
 * Run: bun test tests/daemon/integration.test.ts   (or bun run test:daemon)
 */

import { describe, it, expect, beforeAll } from "bun:test";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { Pool } from "pg";

const PROJECT_ROOT = join(import.meta.dir, "..", "..");
const ROUTER_SCRIPT = join(PROJECT_ROOT, "scripts", "router.ts");
const FIXTURE_MOCK = join(PROJECT_ROOT, "tests", "fixtures", "llm-mock-daemon.json");

const DATABASE_URL = process.env.DATABASE_URL;

const ROUTER_TIMEOUT_MS = 25_000;

async function runRouterSubprocess(
  message: string,
  env: Record<string, string>
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
      done(1);
    }, ROUTER_TIMEOUT_MS);
  });
}

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

describe("daemon integration (router subprocess)", () => {
  let testTelegramId: string | null = null;

  beforeAll(async () => {
    if (DATABASE_URL) {
      testTelegramId = await getTestTelegramId();
    }
  });

  it("router run as subprocess returns valid stdout and exit 0", async () => {
    if (!DATABASE_URL || !testTelegramId) {
      console.warn("Skipping: DATABASE_URL and user with telegram_id required");
      return;
    }

    const env: Record<string, string> = {
      DATABASE_URL,
      AI_GATEWAY_API_KEY: "dummy",
      BO_USE_LLM_MOCK: "1",
      BO_LLM_MOCK_PATH: FIXTURE_MOCK,
      BO_REQUEST_ID: "test-req-1",
      BO_REQUEST_FROM: `telegram:${testTelegramId}`,
      BO_REQUEST_TO: "telegram",
      BO_REQUEST_IS_SELF_CHAT: "false",
      BO_REQUEST_IS_FROM_ME: "false",
    };

    const { stdout, stderr, code } = await runRouterSubprocess("hello", env);

    expect(code).toBe(0);
    expect(stdout.length).toBeGreaterThan(0);
    expect(stdout).not.toMatch(/Error:|TypeError|undefined is not an object|numberToName\.get is not a function|fullSummary\.trim/);
    expect(stderr).toMatch(/decision: skill=create_a_response/);
  }, ROUTER_TIMEOUT_MS + 3000);

  it("router handles unknown owner gracefully (no crash)", async () => {
    if (!DATABASE_URL) return;

    const env: Record<string, string> = {
      DATABASE_URL,
      AI_GATEWAY_API_KEY: "dummy",
      BO_USE_LLM_MOCK: "1",
      BO_LLM_MOCK_PATH: FIXTURE_MOCK,
      BO_REQUEST_FROM: "telegram:999999999999",
      BO_REQUEST_TO: "telegram",
    };

    const { stdout, stderr, code } = await runRouterSubprocess("hi", env);

    expect(code).toBe(0);
    expect(stdout.length).toBeGreaterThan(0);
    expect(stderr).not.toMatch(/invalid input syntax for type integer/);
  }, ROUTER_TIMEOUT_MS + 3000);
});
