/**
 * Web search skill using Brave Search API.
 * Reads { query: string } from stdin; fetches results; writes formatted summary to stdout.
 */

type Input = { query: string };

type BraveWebResult = {
  title?: string;
  url?: string;
  description?: string;
  extra_snippets?: string[];
};

type BraveResponse = {
  web?: { results?: BraveWebResult[] };
};

function readJsonStdin(): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => {
      try {
        resolve(data.trim() ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
    process.stdin.on("error", reject);
  });
}

function getEnv(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : undefined;
}

async function braveWebSearch(query: string, apiKey: string): Promise<BraveWebResult[]> {
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  const res = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "X-Subscription-Token": apiKey,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Brave API ${res.status}: ${text || res.statusText}`);
  }
  const json = (await res.json()) as BraveResponse;
  const results = json.web?.results ?? [];
  return results;
}

function formatResults(results: BraveWebResult[], max: number): string {
  const take = results.slice(0, max);
  const lines: string[] = [];
  for (let i = 0; i < take.length; i++) {
    const r = take[i]!;
    const title = r.title ?? "(no title)";
    const url = r.url ?? "";
    const desc = r.description ?? "";
    lines.push(`${i + 1}. ${title}`);
    if (url) lines.push(`   ${url}`);
    if (desc) lines.push(`   ${desc}`);
    if (Array.isArray(r.extra_snippets) && r.extra_snippets.length) {
      lines.push(`   ${r.extra_snippets[0]}`);
    }
    if (i < take.length - 1) lines.push("");
  }
  return lines.join("\n");
}

async function main() {
  const input = (await readJsonStdin()) as Input;
  const query = input?.query?.trim();
  if (!query) {
    console.error("Missing query. Provide { \"query\": \"search for ...\" }.");
    process.exit(1);
  }

  const apiKey = getEnv("BRAVE_API_KEY");
  if (!apiKey) {
    console.error("Missing BRAVE_API_KEY in environment.");
    process.exit(1);
  }

  try {
    const results = await braveWebSearch(query, apiKey);
    if (results.length === 0) {
      process.stdout.write(`No web results for "${query}". Try rephrasing or a different search.`);
      return;
    }
    const formatted = formatResults(results, 5);
    process.stdout.write(formatted);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[brave skill]", msg);
    process.stdout.write(`Search failed: ${msg}`);
    process.exit(1);
  }
}

main();
