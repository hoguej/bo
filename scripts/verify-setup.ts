#!/usr/bin/env bun
/**
 * Verify Bo Railway migration setup is ready
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

console.log("🔍 Verifying Bo Railway Migration Setup\n");

const checks: Array<{ name: string; pass: boolean; message: string }> = [];

// Check 1: Required files exist
const requiredFiles = [
  "migrations/001_initial_schema.sql",
  "scripts/migrate-sqlite-to-pg.ts",
  "src/db-pg.ts",
  "src/rate-limiter.ts",
  "src/moderation.ts",
  "src/model-router.ts",
  "railway.toml",
  ".env.production.example",
  "next.config.js",
  "app/layout.tsx",
  "app/page.tsx",
  "tests/family-isolation.test.ts",
];

for (const file of requiredFiles) {
  const exists = existsSync(join(process.cwd(), file));
  checks.push({
    name: `File: ${file}`,
    pass: exists,
    message: exists ? "✓ Found" : "✗ Missing",
  });
}

// Check 2: Dependencies installed
const nodeModulesExists = existsSync(join(process.cwd(), "node_modules"));
checks.push({
  name: "Dependencies installed",
  pass: nodeModulesExists,
  message: nodeModulesExists ? "✓ node_modules present" : "✗ Run 'bun install'",
});

// Check 3: Environment variables
const hasRailwayKey = !!process.env.RAILWAY_KEY;
const hasAiGateway = !!process.env.AI_GATEWAY_API_KEY;
const hasBotToken = !!process.env.BO_TELEGRAM_BOT_TOKEN;

checks.push({
  name: "RAILWAY_KEY",
  pass: hasRailwayKey,
  message: hasRailwayKey ? "✓ Set" : "✗ Missing in .env.local",
});

checks.push({
  name: "AI_GATEWAY_API_KEY",
  pass: hasAiGateway,
  message: hasAiGateway ? "✓ Set" : "✗ Missing in .env.local",
});

checks.push({
  name: "BO_TELEGRAM_BOT_TOKEN",
  pass: hasBotToken,
  message: hasBotToken ? "✓ Set" : "✗ Missing in .env.local",
});

// Check 4: SQLite database exists
const sqlitePath = join(process.env.HOME || "", ".bo", "bo.db");
const sqliteExists = existsSync(sqlitePath);
checks.push({
  name: "SQLite database",
  pass: sqliteExists,
  message: sqliteExists ? `✓ Found at ${sqlitePath}` : "✗ Not found",
});

// Check 5: Package.json has new scripts
const packageJson = await Bun.file("package.json").json();
const hasDevScript = "dev" in packageJson.scripts;
const hasMigrateScript = "migrate:sqlite-to-pg" in packageJson.scripts;

checks.push({
  name: "Next.js dev script",
  pass: hasDevScript,
  message: hasDevScript ? "✓ 'bun run dev' available" : "✗ Missing",
});

checks.push({
  name: "Migration script",
  pass: hasMigrateScript,
  message: hasMigrateScript ? "✓ 'bun run migrate:sqlite-to-pg' available" : "✗ Missing",
});

// Print results
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
console.log("VERIFICATION RESULTS");
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

let allPassed = true;

for (const check of checks) {
  console.log(`${check.pass ? "✅" : "❌"} ${check.name}`);
  console.log(`   ${check.message}\n`);
  if (!check.pass) allPassed = false;
}

console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

if (allPassed) {
  console.log("✨ All checks passed! Ready to deploy to Railway.\n");
  console.log("📋 Next steps:");
  console.log("   1. Review DEPLOYMENT.md");
  console.log("   2. Set up Railway services (PostgreSQL, Redis)");
  console.log("   3. Run: bun run scripts/setup-railway.ts");
  console.log("   4. Deploy to Railway");
  console.log("   5. Run migrations on Railway PostgreSQL\n");
} else {
  console.log("⚠️  Some checks failed. Please fix the issues above.\n");
  process.exit(1);
}

// Summary
const passed = checks.filter(c => c.pass).length;
const total = checks.length;
console.log(`Summary: ${passed}/${total} checks passed\n`);
