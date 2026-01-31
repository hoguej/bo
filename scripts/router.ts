import OpenAI from "openai";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  appendConversation,
  appendPersonalityInstruction,
  formatConversationForPrompt,
  formatFactsForPrompt,
  getAllFacts,
  getMemoryPathForOwner,
  getMaxConversationMessages,
  getPersonalityForPrompt,
  getRecentMessages,
  getRelevantFacts,
  getSummaryForPrompt,
  normalizeOwner,
  setSummaryForPrompt,
  upsertFact,
} from "../src/memory";
import { getContactsList, getNameToNumber, getNumberToName, resolveContactToNumber } from "../src/contacts";
import {
  dbGetConfig,
  dbGetTelegramIdByPhone,
  dbGetUserById,
  dbGetUserIdByTelegramId,
  dbInsertLlmLog,
  isReservedFactKey,
} from "../src/db";
import {
  getAllowedSkillIdsForOwner,
  getSkillById,
  loadSkillsRegistry,
  normalizeNumberForAccess,
} from "../src/skills";

/** Fact = persistent attribute about the user (stated or inferred). Inferences (e.g. Cara is female, Cara is Carrie's daughter) are stored in the same facts table. Not meeting/todo/request content. */
type FactInput = { key: string; value: string; scope?: "user" | "global"; tags?: string[] };

/** Output of "what to do?" step: exactly one skill + params. create_a_response = general chat; send_to_contact = from, to, ai_prompt. */
type WhatToDoOutput = { skill: string; personality_instruction?: string; [k: string]: unknown };

/** Legacy type for fallback; new pipeline uses WhatToDoOutput. */
type RouterDecision = {
  action: "use_skill" | "respond" | "send_to_contact";
  skill_id?: string;
  skill_input?: Record<string, unknown>;
  save_facts?: FactInput[];
  summary_sentence?: string;
  personality_instruction?: string;
  conversation_starter?: string;
  response_text?: string;
  contact_name?: string;
  reply_to_sender?: string;
  send_body?: string;
};

/** Set at start of main() so top-level catch can log with requestId. Used only for stderr/logs; never written to stdout (user reply). */
let currentRequestId: string | undefined;

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

type LlmMockConfig = {
  responses: Record<string, unknown>;
  recordPath?: string;
  defaultResponse?: unknown;
};

let llmMockCache: LlmMockConfig | null | undefined;

function loadLlmMock(): LlmMockConfig | null {
  if (llmMockCache !== undefined) return llmMockCache;
  const mockPath = getEnv("BO_LLM_MOCK_PATH");
  if (!mockPath) {
    llmMockCache = null;
    return null;
  }
  try {
    const raw = readFileSync(mockPath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const responses =
      parsed && typeof parsed === "object" && parsed.responses && typeof parsed.responses === "object"
        ? (parsed.responses as Record<string, unknown>)
        : (parsed as Record<string, unknown>);
    const recordPath = (parsed?.record_path as string | undefined) || (parsed?.recordPath as string | undefined) || getEnv("BO_LLM_MOCK_RECORD_PATH");
    const defaultResponse = (parsed?.default as unknown) ?? undefined;
    llmMockCache = { responses, recordPath, defaultResponse };
    return llmMockCache;
  } catch (e) {
    console.error("[bo router] Failed to load BO_LLM_MOCK_PATH:", e instanceof Error ? e.message : String(e));
    llmMockCache = null;
    return null;
  }
}

const PROJECT_ROOT = dirname(__dirname);

/** Load prompt content from prompts/<name>.md or prompts/skills/<name>.md. Returns empty string if file missing. */
function loadPrompt(relativePath: string): string {
  const path = join(PROJECT_ROOT, "prompts", relativePath.endsWith(".md") ? relativePath : `${relativePath}.md`);
  try {
    if (existsSync(path)) return readFileSync(path, "utf-8").trim();
  } catch (_) {
    /* ignore */
  }
  return "";
}

/** Log every request to the AI and every response; traceable to request_id and owner (user). Writes to DB (llm_log) and to file (~/.bo/requests.log or BO_REQUEST_LOG). */
function logPromptResponse(
  requestId: string,
  owner: string,
  step: string,
  requestDoc: unknown,
  rawResponse: string
): void {
  try {
    dbInsertLlmLog(requestId, owner ?? "default", step, requestDoc, rawResponse ?? "");
  } catch (e) {
    console.error("[bo router] Failed to write llm_log:", e instanceof Error ? e.message : String(e));
  }
  const logPath = getEnv("BO_REQUEST_LOG") ?? getEnv("BO_ROUTER_LOG") ?? join(homedir(), ".bo", "requests.log");
  try {
    const dir = dirname(logPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const block = [
      "",
      "---",
      new Date().toISOString(),
      `REQUEST_ID: ${requestId}`,
      `OWNER: ${owner ?? "default"}`,
      `STEP: ${step}`,
      "REQUEST:",
      JSON.stringify(requestDoc, null, 2),
      "RESPONSE:",
      rawResponse || "(empty)",
      "",
    ].join("\n");
    appendFileSync(logPath, block, "utf-8");
  } catch (e) {
    console.error("[bo router] Failed to write request log file:", e instanceof Error ? e.message : String(e));
  }
}

/** Log request and response to a file so you can inspect them (default ~/.bo/router.log, or BO_ROUTER_LOG). */
function logRequestResponseToFile(requestId: string, requestDoc: unknown, rawResponse: string) {
  const logPath = getEnv("BO_ROUTER_LOG") ?? join(homedir(), ".bo", "router.log");
  try {
    const dir = dirname(logPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const block = [
      "",
      "---",
      new Date().toISOString(),
      `REQUEST_ID: ${requestId}`,
      "REQUEST:",
      JSON.stringify(requestDoc, null, 2),
      "RESPONSE:",
      rawResponse || "(empty)",
      "",
    ].join("\n");
    appendFileSync(logPath, block, "utf-8");
  } catch (e) {
    console.error("[bo router] Failed to write log file:", e instanceof Error ? e.message : String(e));
  }
}

/** Polite nonsense excuses when something goes wrong. Never send raw errors or JSON to the user. */
const EXCUSES_ON_ERROR = [
  "Oh, you silly.",
  "My brain short-circuited. One sec.",
  "I got distracted by a butterfly. Try again?",
  "That one went over my head. Say it again?",
  "I blinked and missed it. One more time?",
  "My wires crossed. Hit me again?",
  "I was busy daydreaming. What was that?",
  "Oops—slipped my mind. Again?",
  "I think I glitched. One more?",
  "Lost in the clouds. Try again?",
  "My hamster fell off the wheel. Go on?",
  "I zoned out for a sec. What did you say?",
  "Something shiny caught my eye. Say that again?",
  "I had a brief existential moment. Try again?",
  "My crystal ball fogged up. One more time?",
  "I was briefly not here. Again?",
  "My ears (metaphorically) need a second. Go on?",
  "I think I blacked out. What was that?",
  "The gremlins are at it again. Hit me once more?",
  "I forgot how to words for a sec. Try again?",
];

function randomExcuse(): string {
  return EXCUSES_ON_ERROR[Math.floor(Math.random() * EXCUSES_ON_ERROR.length)]!;
}

function buildContext() {
  return {
    channel: "imessage",
    from: getEnv("BO_REQUEST_FROM"),
    to: getEnv("BO_REQUEST_TO"),
    isSelfChat: getEnv("BO_REQUEST_IS_SELF_CHAT"),
    isFromMe: getEnv("BO_REQUEST_IS_FROM_ME"),
    default_zip: dbGetConfig("default_zip") || getEnv("BO_DEFAULT_ZIP") || undefined,
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
  if (action !== "use_skill" && action !== "respond" && action !== "send_to_contact")
    throw new Error("Decision.action must be use_skill|respond|send_to_contact");
  return d as RouterDecision;
}

/** Rephrase raw skill output in Bo's personality before sending to the user. Falls back to raw if LLM fails. */
async function rephraseSkillOutputForUser(
  openai: OpenAI,
  model: string,
  skillStdout: string,
  userMessage: string,
  requestId?: string
): Promise<string> {
  const system =
    "You are Bo, an iMessage assistant. Be witty, playful, and encouraging. The user asked something that was answered by a local skill. Your job is to give that information back to the user in your own personality. Return a SINGLE JSON object with only one key: response_text (your reply to the user). Keep it concise (iMessage length). Do not repeat raw data verbatim—rephrase it in a friendly, Bo way.";
  const userPayload = [
    "Raw output from the skill:",
    skillStdout,
    "",
    "Original user message:",
    userMessage,
  ].join("\n");
  try {
    const completion = await openai.chat.completions.create({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: userPayload },
      ],
      temperature: 0.3,
      stream: false,
    });
    const raw = completion.choices[0]?.message?.content?.trim() ?? "";
    const jsonStr = extractJsonObject(raw) ?? raw;
    const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
    const text = parsed?.response_text;
    if (typeof text === "string" && text.trim()) return text.trim();
  } catch (e) {
    const reqTag = requestId ? ` [req:${requestId}]` : "";
    console.error(`[bo router]${reqTag} Rephrase skill output failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  return skillStdout;
}

async function callSkill(
  entrypoint: string,
  input: Record<string, unknown>,
  envOverrides: Record<string, string> = {}
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const proc = spawn("bun", ["run", entrypoint], {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...envOverrides },
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

/** Call LLM with system + user messages; log every request and response with requestId, owner, and step; return raw content. */
async function callLlmWithPrompt(
  openai: OpenAI,
  model: string,
  requestId: string,
  owner: string,
  step: string,
  systemContent: string,
  userContent: string,
  temperature: number = 0.1
): Promise<string> {
  const requestDoc = { model, messages: [{ role: "system" as const, content: systemContent }, { role: "user" as const, content: userContent }] };
  const mock = loadLlmMock();
  if (mock) {
    const value = step in mock.responses ? mock.responses[step] : mock.defaultResponse;
    const raw = typeof value === "string" ? value : value == null ? "" : JSON.stringify(value);
    logPromptResponse(requestId, owner, step, requestDoc, raw);
    if (mock.recordPath) {
      try {
        const record = { step, request: requestDoc, response: raw, at: new Date().toISOString() };
        appendFileSync(mock.recordPath, JSON.stringify(record) + "\n", "utf-8");
      } catch (e) {
        console.error("[bo router] Failed to write LLM mock record:", e instanceof Error ? e.message : String(e));
      }
    }
    return raw;
  }
  const completion = await openai.chat.completions.create({
    model,
    messages: [{ role: "system", content: systemContent }, { role: "user", content: userContent }],
    temperature,
    stream: false,
  });
  const raw = completion.choices[0]?.message?.content?.trim() ?? "";
  logPromptResponse(requestId, owner, step, requestDoc, raw);
  return raw;
}

function extractJsonArray(text: string): string | null {
  const start = text.indexOf("[");
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** Build skill_input from what_to_do output: all keys except skill and personality_instruction. */
function decisionToSkillInput(decision: WhatToDoOutput): Record<string, unknown> {
  const { skill: _s, personality_instruction: _p, ...rest } = decision;
  return rest;
}

/** Create response step: load create_response.md, call LLM with user message, skill output, hints, personality, facts, summary, recent conversations; return reply string. */
async function createResponseStep(
  openai: OpenAI,
  model: string,
  requestId: string,
  owner: string,
  userMessage: string,
  skillOutput: string,
  hints: Record<string, unknown> | string,
  memoryPath: string,
  extraContext: Record<string, string> = {}
): Promise<string> {
  const systemContent = loadPrompt("create_response") || "You are Bo. Return a single reply string to the user. Be concise and friendly.";
  const personalityBlock = getPersonalityForPrompt(owner);
  const summaryBlock = getSummaryForPrompt(owner);
  const facts = getRelevantFacts(userMessage, { max: 12, path: memoryPath });
  const factsBlock = formatFactsForPrompt(facts);
  const maxMessages = getMaxConversationMessages();
  const recentMessages = getRecentMessages(owner, maxMessages - 1);
  const conversationBlock = formatConversationForPrompt(recentMessages);
  const hintsStr = typeof hints === "string" ? hints : JSON.stringify(hints);
  const extraBlocks = Object.entries(extraContext)
    .map(([k, v]) => ({ k: k.trim(), v: (v ?? "").toString().trim() }))
    .filter((x) => x.k && x.v);
  const userContent = [
    "user_message:",
    userMessage,
    "",
    "skill_output:",
    skillOutput || "(none)",
    hintsStr && hintsStr !== "{}" ? `\nhints: ${hintsStr}\n` : "",
    ...extraBlocks.flatMap((b) => ["", `${b.k}:`, b.v]),
    "personality:", personalityBlock || "(none)",
    "facts:", factsBlock || "(none)",
    "conversation_summary:", summaryBlock || "(none)",
    "recent_conversations:", conversationBlock || "(none)",
  ].join("\n");
  const raw = await callLlmWithPrompt(openai, model, requestId, owner, "create_response", systemContent, userContent, 0.3);
  const reply = raw.trim();
  return reply || skillOutput || "Done.";
}

async function main() {
  const requestId = getEnv("BO_REQUEST_ID") ?? randomBytes(4).toString("hex");
  currentRequestId = requestId;

  const logErr = (msg: string) => console.error(`[bo router] [req:${requestId}] ${msg}`);
  const logBlockReq = (title: string, body: string) =>
    console.error(`\n[bo router] [req:${requestId}] ${title}\n${body}\n`);

  const debug = isDebug();

  const apiKey = getEnv("AI_GATEWAY_API_KEY") ?? getEnv("VERCEL_OIDC_TOKEN");
  if (!apiKey) {
    logErr("Missing AI Gateway auth. Set AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN.");
    process.stdout.write(randomExcuse());
    process.exit(0);
  }
  const model = dbGetConfig("llm_model") || getEnv("BO_LLM_MODEL") || "openai/gpt-4.1";

  const userMessage = process.argv.slice(2).join(" ").trim();
  if (!userMessage) {
    logErr("No message provided.");
    process.stdout.write(randomExcuse());
    process.exit(0);
  }

  logErr(`messageLen=${userMessage.length} from=${getEnv("BO_REQUEST_FROM") ?? "?"} to=${getEnv("BO_REQUEST_TO") ?? "?"}`);

  const scheduledReminderPrefix = "[scheduled: reminder] ";
  const isScheduledReminder = userMessage.startsWith(scheduledReminderPrefix);
  const scheduledReminderText = isScheduledReminder ? userMessage.slice(scheduledReminderPrefix.length).trim() : "";
  const reminderContext: Record<string, string> = isScheduledReminder
    ? { reminder_triggered: "true", reminder_text: scheduledReminderText || "(reminder)" }
    : {};

  const registry = loadSkillsRegistry();
  const context = buildContext();

  // Separate fact store per sender: self-chat = default; 7404749170 / 6143480678 = their own store.
  const isSelfChat = getEnv("BO_REQUEST_IS_SELF_CHAT") === "true";
  const isFromMe = getEnv("BO_REQUEST_IS_FROM_ME") === "true";
  const fromRaw = getEnv("BO_REQUEST_FROM");
  const owner = isSelfChat && isFromMe ? "default" : normalizeOwner(fromRaw);
  const memoryPath = getMemoryPathForOwner(owner);

  // Skill access: use normalized sender number so self-chat from your phone gets your byNumber entry.
  const allSkillIds = registry.skills.map((s) => s.id);
  const accessOwner = normalizeNumberForAccess(fromRaw);
  const allowedSkillIds = getAllowedSkillIdsForOwner(accessOwner, allSkillIds);
  const allowedSkills = registry.skills.filter((s) => allowedSkillIds.includes(s.id));

  const nameToNumber = getNameToNumber();
  const numberToName = getNumberToName();
  // Short-circuit: "send Carrie the weather for tomorrow" → run weather skill, send to Carrie, reply "Okay, sent the weather to Carrie." (no LLM choice)
  const sendMatch = userMessage.trim().match(/^\s*send\s+(\w+)\s+(.+)$/is);
  if (sendMatch && nameToNumber.size > 0) {
    const contactInput = sendMatch[1].trim();
    const rest = sendMatch[2].trim().toLowerCase();
    const sendToNumber = resolveContactToNumber(contactInput);
    if (sendToNumber) {
      const fullName = numberToName.get(sendToNumber);
      const contactDisplay = fullName ? fullName.split(/\s+/)[0] : contactInput.charAt(0).toUpperCase() + contactInput.slice(1).toLowerCase();
      const isWeather = /\b(weather|forecast)\b/.test(rest);
      const days: string[] = [];
      if (/\btomorrow\b/.test(rest)) days.push("tomorrow");
      if (/\btoday\b/.test(rest)) days.push("today");
      const dayNames = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
      for (const name of dayNames) {
        if (new RegExp(`\\b${name}\\b`).test(rest)) days.push(name);
      }
      const day = days.length ? [...new Set(days)].join(",") : undefined;
      if (isWeather && allowedSkillIds.includes("weather")) {
        const skill = getSkillById("weather");
        if (skill) {
          const input: Record<string, unknown> = day ? { day } : {};
          logErr(`short-circuit send_to_contact: ${contactDisplay}, weather${day ? ` ${day}` : ""}`);
          const { stdout, stderr, code } = await callSkill(skill.entrypoint, input, { BO_REQUEST_ID: requestId, BO_REQUEST_FROM: fromRaw ?? owner });
          if (stderr?.trim()) logErr(`skill stderr: ${stderr.trim().slice(0, 300)}`);
          if (code === 0 && stdout?.trim()) {
            const sendBody = stdout.trim().length > 2000 ? stdout.trim().slice(0, 1997) + "..." : stdout.trim();
            const replyToSender = `Okay, sent the weather to ${contactDisplay}.`;
            const sendToTelegramId = dbGetTelegramIdByPhone(sendToNumber);
            const payload: Record<string, string> = { sendTo: sendToNumber, sendBody, replyToSender };
            if (sendToTelegramId) payload.sendToTelegramId = sendToTelegramId;
            process.stdout.write(JSON.stringify(payload) + "\n");
            appendConversation(owner, userMessage, replyToSender);
            return;
          }
        }
      }
    }
  }

  // Context for pipeline steps
  const askingAboutMe = /what do you know|what (info|facts?) do you have|what do you have on me|tell me what you know about me|list (what you know|your facts)/i.test(userMessage);
  const facts = askingAboutMe ? getAllFacts({ path: memoryPath }) : getRelevantFacts(userMessage, { max: 12, path: memoryPath });
  const factsBlock = formatFactsForPrompt(facts);
  const maxMessages = getMaxConversationMessages();
  const recentMessages = getRecentMessages(owner, maxMessages - 1);
  const conversationBlock = formatConversationForPrompt(recentMessages);
  const summaryBlock = getSummaryForPrompt(owner);
  const personalityBlock = getPersonalityForPrompt(owner);
  const skillsForDecision = isScheduledReminder ? allowedSkills.filter((s) => s.id !== "todo") : allowedSkills;
  const skillsSummary = skillsForDecision.map((s) => ({ id: s.id, name: s.name, description: s.description, inputSchema: s.inputSchema }));
  const contactsList = getContactsList();
  const contactNames = contactsList.length > 0 ? contactsList.map((c) => c.name).join(", ") : "(none)";

  const openai = new OpenAI({ apiKey, baseURL: "https://ai-gateway.vercel.sh/v1" });

  // Step 1: Fact finding
  const factFindingPrompt = loadPrompt("fact_finding") || "Extract facts from the user message. Return a JSON array of { key, value, scope?, tags? }. Empty array [] if none. Only attributes about the user; no meeting/todo/request content.";
  const factFindingUser = ["user_message:", userMessage, "", "existing_facts (context only, do not re-save):", factsBlock || "(none)"].join("\n");
  const factFindingRaw = await callLlmWithPrompt(openai, model, requestId, owner, "fact_finding", factFindingPrompt, factFindingUser, 0.1);
  const saveFactsJson = extractJsonArray(factFindingRaw) ?? "[]";
  try {
    const toSaveFacts = JSON.parse(saveFactsJson) as FactInput[];
    if (Array.isArray(toSaveFacts)) {
      for (const f of toSaveFacts) {
        if (f && typeof f.key === "string" && typeof f.value === "string") {
          if (isReservedFactKey(f.key)) continue;
          if (String(f.key).toLowerCase() === "personality_instruction") {
            appendPersonalityInstruction(owner, f.value);
          } else {
            upsertFact({ key: f.key, value: f.value, scope: f.scope ?? "user", tags: f.tags ?? [], path: memoryPath });
          }
        }
      }
    }
  } catch (_) {
    /* ignore */
  }

  // Step 2: What to do
  const whatToDoPrompt = loadPrompt("what_to_do") || "Choose exactly one skill and its parameters. Return a single JSON object: { skill: string, ...params }. Use skill create_a_response for general chat. Use skill send_to_contact with from, to, ai_prompt when sending to a contact.";
  const syntheticSkills: Array<{ id: string; name: string; description: string; inputSchema: unknown }> = [];
  if (!allowedSkills.some((s) => s.id === "create_a_response")) syntheticSkills.push({ id: "create_a_response", name: "Reply to user", description: "General chat or reply", inputSchema: {} });
  if (!isScheduledReminder && !allowedSkills.some((s) => s.id === "friend_mode"))
    syntheticSkills.push({
      id: "friend_mode",
      name: "Friend mode",
      description: "Have a supportive, friendly conversation (good listener). Use when the user is just talking, venting, sharing feelings, or wants connection—not asking for tasks.",
      inputSchema: { person: "string (optional; tailor friend mode to a named person)" },
    });
  if (!allowedSkills.some((s) => s.id === "send_to_contact")) syntheticSkills.push({ id: "send_to_contact", name: "Send to contact", description: "Send a message to a contact (from, to, ai_prompt)", inputSchema: { from: "string", to: "string", ai_prompt: "string" } });
  const skillsForPrompt = [...syntheticSkills, ...skillsSummary];
  const whatToDoUser = ["user_message:", userMessage, "skills:", JSON.stringify(skillsForPrompt), "context:", JSON.stringify(context), "contacts:", contactNames].join("\n");
  const whatToDoRaw = await callLlmWithPrompt(openai, model, requestId, owner, "what_to_do", whatToDoPrompt, whatToDoUser, 0.1);
  const decisionJson = extractJsonObject(whatToDoRaw);
  let decision: WhatToDoOutput;
  try {
    if (!decisionJson) throw new Error("No JSON");
    const parsed = JSON.parse(decisionJson) as Record<string, unknown>;
    if (!parsed.skill || typeof parsed.skill !== "string") throw new Error("Missing skill");
    decision = parsed as WhatToDoOutput;
  } catch (e) {
    logErr("what_to_do parse failed: " + (e instanceof Error ? e.message : String(e)));
    process.stdout.write(randomExcuse());
    appendConversation(owner, userMessage, randomExcuse());
    return;
  }
  if (isScheduledReminder && (decision.skill === "todo" || decision.skill === "friend_mode" || decision.skill === "reminder")) {
    logErr(`scheduled reminder chose ${decision.skill}; overriding to create_a_response`);
    decision = { skill: "create_a_response" };
  }
  if (decision.personality_instruction && typeof decision.personality_instruction === "string" && decision.personality_instruction.trim()) {
    appendPersonalityInstruction(owner, decision.personality_instruction.trim());
  }
  logErr(`decision: skill=${decision.skill}`);

  let finalReply: string;

  if (decision.skill === "friend_mode") {
    function normalizeFriendKey(s: string): string | undefined {
      const first = (s ?? "").trim().split(/\s+/)[0]?.toLowerCase();
      if (!first) return undefined;
      if (first === "cara" || first === "robert" || first === "carrie" || first === "jon") return first;
      return undefined;
    }
    const explicitPerson = typeof (decision as Record<string, unknown>).person === "string" ? String((decision as Record<string, unknown>).person) : "";
    let friendKey = normalizeFriendKey(explicitPerson);
    if (!friendKey) {
      // Default: tailor to the requestor (sender).
      let firstName: string | undefined;
      if (owner.startsWith("telegram:")) {
        const uid = dbGetUserIdByTelegramId(owner.slice(9));
        if (uid != null) {
          const u = dbGetUserById(uid);
          firstName = u?.first_name?.trim() || undefined;
        }
      } else {
        const display = numberToName.get(owner);
        firstName = display ? display.split(/\s+/)[0] : undefined;
      }
      friendKey = normalizeFriendKey(firstName || "");
    }
    const genericFriendPrompt = loadPrompt("friends/friend");
    const personalFriendPrompt = friendKey ? loadPrompt(`friends/${friendKey}_friend`) : "";
    finalReply = await createResponseStep(
      openai,
      model,
      requestId,
      owner,
      userMessage,
      "",
      { mode: "friend_mode", person: friendKey ?? null },
      memoryPath,
      {
        friend_mode_generic_prompt: genericFriendPrompt || "(none)",
        friend_mode_person_prompt: personalFriendPrompt || "(none)",
      }
    );
  } else if (decision.skill === "create_a_response") {
    finalReply = await createResponseStep(openai, model, requestId, owner, userMessage, "", {}, memoryPath, reminderContext);
  } else if (decision.skill === "send_to_contact") {
    const from = String(decision.from ?? "").trim();
    const to = String(decision.to ?? "").trim();
    const aiPrompt = String(decision.ai_prompt ?? "").trim();
    const sendToNumber = to ? resolveContactToNumber(to) : undefined;
    const displayName = to ? to.charAt(0).toUpperCase() + to.slice(1).toLowerCase() : "that person";
    if (!to || !aiPrompt) {
      logErr("send_to_contact missing to or ai_prompt");
      process.stdout.write("I need a contact and what to say.");
      appendConversation(owner, userMessage, "I need a contact and what to say.");
      return;
    }
    if (sendToNumber === undefined) {
      logErr(`send_to_contact unknown contact: to=${to}`);
      process.stdout.write(`I don't know who ${displayName} is.`);
      appendConversation(owner, userMessage, `I don't know who ${displayName} is.`);
      return;
    }
    if (sendToNumber.length < 10) {
      logErr(`send_to_contact no valid number for to=${to}`);
      process.stdout.write(`I have ${displayName} in contacts but no valid phone number.`);
      appendConversation(owner, userMessage, `I have ${displayName} in contacts but no valid phone number.`);
      return;
    }
    const recipientPrompt = loadPrompt("skills/send_to_contact_recipient") || "Generate a message to the recipient. The message must say who it is from. Return plain text only.";
    const recipientUser = [
      "from:", from,
      "to:", to,
      "ai_prompt:", aiPrompt,
      "personality:", personalityBlock || "(none)",
      "facts:", factsBlock || "(none)",
      "conversation_summary:", summaryBlock || "(none)",
      "recent_conversations:", conversationBlock || "(none)",
    ].join("\n");
    const sendBodyRaw = await callLlmWithPrompt(openai, model, requestId, owner, "send_to_contact_recipient", recipientPrompt, recipientUser, 0.3);
    const sendBody = sendBodyRaw.trim().length > 2000 ? sendBodyRaw.trim().slice(0, 1997) + "..." : sendBodyRaw.trim() || `${from} says: (no message)`;

    const senderPrompt = loadPrompt("skills/send_to_contact_sender") || "Generate a short ack to the sender (e.g. Okay, sent that to Cara.). Return plain text only.";
    const senderUser = [
      "user_message:", userMessage,
      "what_was_sent:", sendBody.slice(0, 200),
      "to:", to,
      "personality:", personalityBlock || "(none)",
      "facts:", factsBlock || "(none)",
      "conversation_summary:", summaryBlock || "(none)",
      "recent_conversations:", conversationBlock || "(none)",
    ].join("\n");
    const replyToSenderRaw = await callLlmWithPrompt(openai, model, requestId, owner, "send_to_contact_sender", senderPrompt, senderUser, 0.3);
    const replyToSenderText = replyToSenderRaw.trim() || `Okay, sent that to ${displayName}.`;

    const sendToTelegramId = dbGetTelegramIdByPhone(sendToNumber);
    const payload: Record<string, string> = {
      sendTo: sendToNumber,
      sendBody,
      replyToSender: replyToSenderText.length > 2000 ? replyToSenderText.slice(0, 1997) + "..." : replyToSenderText,
    };
    if (sendToTelegramId) payload.sendToTelegramId = sendToTelegramId;
    process.stdout.write(JSON.stringify(payload) + "\n");
    appendConversation(owner, userMessage, replyToSenderText);
    return;
  } else {
    const skillId = decision.skill;
    const skill = getSkillById(skillId);
    if (!skill) {
      logErr(`Unknown skill_id: ${skillId}`);
      process.stdout.write(randomExcuse());
      appendConversation(owner, userMessage, randomExcuse());
      return;
    }
    if (!allowedSkillIds.includes(skillId)) {
      logErr(`Skill ${skillId} not allowed for this number`);
      process.stdout.write("I don't have that capability for this chat—sorry!");
      appendConversation(owner, userMessage, "I don't have that capability for this chat—sorry!");
      return;
    }
    const input = decisionToSkillInput(decision);
    logErr(`next: run skill ${skill.id} (${skill.entrypoint})`);
    if (debug) logBlockReq("skill input", JSON.stringify(input, null, 2));
    const skillEnv = { BO_REQUEST_ID: requestId, BO_REQUEST_FROM: fromRaw ?? owner };
    const { stdout, stderr, code } = await callSkill(skill.entrypoint, input, skillEnv);
    if (stderr?.trim()) logErr(`skill stderr: ${stderr.trim().slice(0, 1000)}${stderr.length > 1000 ? "…" : ""}`);
    if (code !== 0) {
      logErr(`Skill failed exitCode=${code} skill=${skill.id} stderr=${(stderr || "(none)").slice(0, 500)}`);
      finalReply = randomExcuse();
      process.stdout.write(finalReply);
      appendConversation(owner, userMessage, finalReply);
      return;
    }
    const rawSkillOutput = stdout || "Done.";
    let skillResponse: string;
    let skillHints: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(rawSkillOutput) as Record<string, unknown>;
      if (typeof parsed.response === "string") {
        skillResponse = parsed.response;
        if (parsed.hints && typeof parsed.hints === "object") skillHints = parsed.hints as Record<string, unknown>;
      } else {
        skillResponse = rawSkillOutput;
      }
    } catch {
      skillResponse = rawSkillOutput;
    }
    finalReply = await createResponseStep(openai, model, requestId, owner, userMessage, skillResponse, skillHints, memoryPath, reminderContext);

    // When someone modifies another person's todo list, notify that person.
    if (skillId === "todo" && code === 0) {
      const forContact = (input.for_contact as string)?.trim();
      if (forContact) {
        const numberToName = getNumberToName();
        const sendToNumber = resolveContactToNumber(forContact);
        const senderName = numberToName.get(owner) ?? (owner === "default" ? "Someone" : owner);
        const action = String((input.action as string) ?? "add").toLowerCase();
        const text = (input.text as string)?.trim();
        const num = input.number as number | undefined;
        const due = (input.due as string)?.trim();
        let notification: string;
        if (action === "add" && text) {
          notification = `${senderName} added a todo to your list: ${text}`;
        } else if (action === "mark_done" && num != null) {
          notification = `${senderName} marked #${num} done on your list.`;
        } else if (action === "remove" && num != null) {
          notification = `${senderName} removed #${num} from your list.`;
        } else if (action === "edit" && num != null && text) {
          notification = `${senderName} updated #${num} on your list to: ${text}`;
        } else if (action === "set_due" && num != null && due) {
          notification = `${senderName} set #${num} due to ${due} on your list.`;
        } else {
          notification = `${senderName} made a change to your todo list.`;
        }
        if (sendToNumber) {
          const sendToTelegramId = dbGetTelegramIdByPhone(sendToNumber);
          const payload: Record<string, string> = {
            sendTo: sendToNumber,
            sendBody: notification.length > 2000 ? notification.slice(0, 1997) + "..." : notification,
            replyToSender: finalReply.length > 2000 ? finalReply.slice(0, 1997) + "..." : finalReply,
          };
          if (sendToTelegramId) payload.sendToTelegramId = sendToTelegramId;
          process.stdout.write(JSON.stringify(payload) + "\n");
          appendConversation(owner, userMessage, finalReply);
          return;
        }
      }
    }
  }

  if (finalReply.length > 2000) finalReply = finalReply.slice(0, 1997) + "...";
  process.stdout.write(finalReply);
  appendConversation(owner, userMessage, finalReply);

  // Optional: run summary step (current_summary + recent_conversations → replace summary).
  const summaryPrompt = loadPrompt("summary");
  if (summaryPrompt) {
    const currentSummary = getSummaryForPrompt(owner);
    const recentAfter = getRecentMessages(owner, Math.min(maxMessages, 10));
    const summaryUser = ["current_summary:", currentSummary || "(none)", "", "recent_conversations:", formatConversationForPrompt(recentAfter)].join("\n");
    try {
      const summaryRaw = await callLlmWithPrompt(openai, model, requestId, owner, "summary", summaryPrompt, summaryUser, 0.2);
      const newSummary = summaryRaw.trim().slice(0, 2000);
      if (newSummary) setSummaryForPrompt(owner, newSummary);
    } catch (_) {
      /* ignore */
    }
  }
}

main().catch((err) => {
  const reqTag = currentRequestId ? ` [req:${currentRequestId}]` : "";
  console.error(`[bo router]${reqTag} Error: ${err?.message ?? String(err)}`);
  if (err instanceof Error && err.stack) console.error(`[bo router]${reqTag} Stack: ${err.stack}`);
  process.stdout.write(randomExcuse());
  process.exit(0);
});

