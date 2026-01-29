import OpenAI from "openai";
import { spawn } from "node:child_process";
import { formatFactsForPrompt, getAllFacts, getMemoryPathForOwner, getRelevantFacts, normalizeOwner, upsertFact } from "../src/memory";
import { getSkillById, loadSkillsRegistry } from "../src/skills";

type FactInput = { key: string; value: string; scope?: "user" | "global"; tags?: string[] };

type RouterDecision = {
  action: "use_skill" | "respond";
  skill_id?: string;
  skill_input?: Record<string, unknown>;
  save_facts?: FactInput[];
  response_text?: string;
};

function getEnv(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : undefined;
}

function isDebug(): boolean {
  const v = getEnv("BO_DEBUG") ?? getEnv("BO_ROUTER_DEBUG");
  if (!v) return false;
  return v === "1" || v.toLowerCase() === "true" || v.toLowerCase() === "yes";
}

function logBlock(title: string, body: string) {
  // IMPORTANT: log to stderr so stdout stays clean for iMessage replies.
  console.error(`\n[bo router] ${title}\n${body}\n`);
}

function buildContext() {
  return {
    channel: "imessage",
    from: getEnv("BO_REQUEST_FROM"),
    to: getEnv("BO_REQUEST_TO"),
    isSelfChat: getEnv("BO_REQUEST_IS_SELF_CHAT"),
    isFromMe: getEnv("BO_REQUEST_IS_FROM_ME"),
  };
}

function extractJsonObject(text: string): string | null {
  // Find first top-level {...} object (best-effort)
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function normalizeDecision(raw: unknown): RouterDecision {
  if (!raw || typeof raw !== "object") throw new Error("Decision is not an object");
  const d = raw as Record<string, unknown>;
  const action = d.action;
  if (action !== "use_skill" && action !== "respond") throw new Error("Decision.action must be use_skill|respond");
  return d as RouterDecision;
}

async function callSkill(entrypoint: string, input: Record<string, unknown>): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const proc = spawn("bun", ["run", entrypoint], {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (d) => (stdout += d.toString()));
    proc.stderr?.on("data", (d) => (stderr += d.toString()));
    proc.on("close", (code) => resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code: code ?? 0 }));
    proc.stdin?.write(JSON.stringify(input));
    proc.stdin?.end();
  });
}

async function main() {
  const debug = isDebug();

  const apiKey = getEnv("AI_GATEWAY_API_KEY") ?? getEnv("VERCEL_OIDC_TOKEN");
  if (!apiKey) {
    console.error("Missing AI Gateway auth. Set AI_GATEWAY_API_KEY (recommended) or VERCEL_OIDC_TOKEN.");
    process.exit(1);
  }
  const model = getEnv("BO_LLM_MODEL") ?? "openai/gpt-4.1";

  const userMessage = process.argv.slice(2).join(" ").trim();
  if (!userMessage) {
    console.error("Usage: bun run scripts/router.ts \"message...\"");
    process.exit(1);
  }

  const registry = loadSkillsRegistry();
  const context = buildContext();

  // Separate fact store per sender: self-chat = default; 7404749170 / 6143480678 = their own store.
  const isSelfChat = getEnv("BO_REQUEST_IS_SELF_CHAT") === "true";
  const isFromMe = getEnv("BO_REQUEST_IS_FROM_ME") === "true";
  const fromRaw = getEnv("BO_REQUEST_FROM");
  const owner = isSelfChat && isFromMe ? "default" : normalizeOwner(fromRaw);
  const memoryPath = getMemoryPathForOwner(owner);

  // For "what do you know about me?" pass all facts; otherwise relevant subset.
  const askingAboutMe = /what do you know|what (info|facts?) do you have|what do you have on me|tell me what you know about me|list (what you know|your facts)/i.test(userMessage);
  const facts = askingAboutMe ? getAllFacts({ path: memoryPath }) : getRelevantFacts(userMessage, { max: 12, path: memoryPath });
  const factsBlock = formatFactsForPrompt(facts);

  const system = [
    "You are Bo, an iMessage assistant.",
    "You must return a SINGLE JSON object with no extra text.",
    "",
    "Decide whether to use a local skill (script) or respond normally.",
    "Prefer using a local skill when it can answer the user request more reliably than a general response (e.g. weather).",
    "",
    "If the user asks what you know about them (e.g. 'what do you know about me?'): use action=respond and in response_text list each known user fact from the payload above (key: value). If there are none, say you don't have any stored facts yet.",
    "",
    "If the user asks what you can do or your capabilities (e.g. 'what can you do?'): use action=respond and in response_text list each local skill by name and a one-line description from the registry, then add that you can also answer general questions.",
    "",
    "If the user asks for a specific fact about them (e.g. 'what's my name?', 'where do I live?', 'what's my email?'): use action=respond and answer only from the Known user facts in the payload. Give a short, direct answer. If we don't have that fact stored, say you don't have it yet.",
    "",
    "If using a local skill:",
    '- action="use_skill"',
    "- Choose skill_id from the provided registry",
    "- Provide skill_input with only the parameters needed by that skill",
    "",
    "If responding normally (other questions):",
    '- action="respond"',
    "- Provide response_text (what to send back to the user)",
    "",
    "Also: if the user states durable personal info (name/email/location/etc.), include it in save_facts as {key,value,scope?,tags?}.",
    "Never invent facts.",
  ].join("\n");

  const skillsSummary = registry.skills.map((s) => ({
    id: s.id,
    name: s.name,
    description: s.description,
    inputSchema: s.inputSchema,
  }));

  const userPayload = [
    "Context:",
    JSON.stringify(context),
    "",
    factsBlock ? factsBlock : "Known user facts: (none)",
    "",
    "Local skills registry (choose from these only):",
    JSON.stringify(skillsSummary),
    "",
    "User message:",
    userMessage,
  ].join("\n");

  if (debug) {
    const requestDoc = {
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: userPayload },
      ],
    };
    logBlock("request", JSON.stringify(requestDoc, null, 2));
  }

  const openai = new OpenAI({ apiKey, baseURL: "https://ai-gateway.vercel.sh/v1" });
  const completion = await openai.chat.completions.create({
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: userPayload },
    ],
    temperature: 0.1,
    stream: false,
  });

  const rawText = completion.choices[0]?.message?.content?.trim() ?? "";
  if (debug) {
    logBlock("raw response", rawText || "(empty)");
  }
  const jsonText = extractJsonObject(rawText) ?? rawText;
  let decision: RouterDecision;
  try {
    decision = normalizeDecision(JSON.parse(jsonText));
  } catch (e) {
    console.error("Router JSON parse failed.");
    console.error(rawText);
    throw e;
  }

  // Always log the parsed decision + next step (stderr), since it's useful while iterating.
  console.error(
    `[bo router] decision: ${decision.action}` +
      (decision.action === "use_skill" ? ` skill_id=${decision.skill_id ?? "(missing)"}` : "")
  );

  const toSave = Array.isArray(decision.save_facts) ? decision.save_facts : [];
  for (const f of toSave) {
    if (!f || typeof f.key !== "string" || typeof f.value !== "string") continue;
    upsertFact({ key: f.key, value: f.value, scope: f.scope ?? "user", tags: f.tags ?? [], path: memoryPath });
  }
  if (debug && toSave.length) {
    logBlock("saved facts", JSON.stringify(toSave, null, 2));
  }

  if (decision.action === "respond") {
    console.error("[bo router] next: return response_text");
    const text = (decision.response_text ?? "").trim();
    process.stdout.write(text || "Done.");
    return;
  }

  const skillId = decision.skill_id;
  if (!skillId) {
    console.error("Decision missing skill_id");
    process.exit(1);
  }
  const skill = getSkillById(skillId);
  if (!skill) {
    console.error(`Unknown skill_id: ${skillId}`);
    process.exit(1);
  }

  const input = (decision.skill_input ?? {}) as Record<string, unknown>;
  console.error(`[bo router] next: run skill ${skill.id} (${skill.entrypoint})`);
  if (debug) logBlock("skill input", JSON.stringify(input, null, 2));
  const { stdout, stderr, code } = await callSkill(skill.entrypoint, input);
  if (code !== 0) {
    process.stdout.write(stderr || `Skill failed (exit ${code}).`);
    return;
  }
  process.stdout.write(stdout || "Done.");
}

main().catch((err) => {
  console.error(err?.message ?? String(err));
  process.exit(1);
});

