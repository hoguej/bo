import { deleteFact, getMemoryPath, getMemoryPathForOwner, loadMemory, normalizeOwner, upsertFact } from "../memory";

function parseArgs(args: string[]): {
  scope: "user" | "global";
  tags: string[];
  forOwner: string | null;
  key: string | null;
  value: string | null;
} {
  let scope: "user" | "global" = "user";
  const tags: string[] = [];
  let forOwner: string | null = null;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--global") scope = "global";
    else if (a === "--user") scope = "user";
    else if (a === "--for" && args[i + 1]) forOwner = normalizeOwner(args[++i]!);
    else if (a === "--tag" && args[i + 1]) tags.push(args[++i]!);
    else positional.push(a);
  }

  const key = positional[0] ?? null;
  const value = positional.length > 1 ? positional.slice(1).join(" ") : null;
  return { scope, tags, forOwner, key, value };
}

export async function runRemember(args: string[]): Promise<void> {
  const { scope, tags, forOwner, key, value } = parseArgs(args);
  if (!key || !value) {
    console.log(`Usage:
  bo remember [--for NUMBER] [--user|--global] [--tag TAG] <key> <value...>

Examples:
  bo remember name "Justin"
  bo remember --for 7404749170 name "Alice"
  bo remember location "Columbus, OH"
  bo remember --for 6143480678 email "bob@example.com"

Storage: --for default = self (memory.json); --for 7404749170 = memory_7404749170.json
`);
    process.exit(1);
  }

  const owner = forOwner ?? "default";
  const path = getMemoryPathForOwner(owner);
  const fact = upsertFact({ key, value, scope, tags, path });
  console.log(`Saved (${fact.scope}, owner=${owner}): ${fact.key} = ${fact.value}`);
}

export async function runForget(args: string[]): Promise<void> {
  const { scope, forOwner, key } = parseArgs(args);
  if (!key) {
    console.log(`Usage:
  bo forget [--for NUMBER] [--user|--global] <key>
`);
    process.exit(1);
  }

  const path = getMemoryPathForOwner(forOwner ?? "default");
  const ok = deleteFact({ key, scope, path });
  console.log(ok ? `Deleted (${scope}): ${key}` : `Not found (${scope}): ${key}`);
}

export async function runFacts(args: string[]): Promise<void> {
  const showPath = args.includes("--path");
  const { forOwner } = parseArgs(args);
  const owner = forOwner ?? "default";
  const path = getMemoryPathForOwner(owner);
  const mem = loadMemory(path);
  if (showPath) console.log(path);
  console.log(`Facts for owner: ${owner}`);

  if (mem.facts.length > 0) {
    const facts = [...mem.facts].sort((a, b) => a.scope.localeCompare(b.scope) || a.key.localeCompare(b.key));
    for (const f of facts) {
      const tags = f.tags.length ? ` [${f.tags.join(", ")}]` : "";
      console.log(`  ${f.scope}.${f.key}=${f.value}${tags}`);
    }
  } else {
    console.log("No saved facts.");
  }
}

