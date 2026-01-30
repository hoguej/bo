import OpenAI from "openai";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  appendConversation,
  appendPersonalityInstruction,
  appendSummarySentence,
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
  upsertFact,
} from "../src/memory";
import { getContactsList, getNameToNumber, getNumberToName, resolveContactToNumber } from "../src/contacts";
import {
  getAllowedSkillIdsForOwner,
  getSkillById,
  loadSkillsRegistry,
  normalizeNumberForAccess,
} from "../src/skills";

/** Fact = persistent attribute about the user (stated or inferred). Inferences (e.g. Cara is female, Cara is Carrie's daughter) are stored in the same facts table. Not meeting/todo/request content. */
type FactInput = { key: string; value: string; scope?: "user" | "global"; tags?: string[] };

type RouterDecision = {
  action: "use_skill" | "respond" | "send_to_contact";
  skill_id?: string;
  skill_input?: Record<string, unknown>;
  save_facts?: FactInput[];
  summary_sentence?: string;
  personality_instruction?: string;
  conversation_starter?: string;
  response_text?: string;
  /** For send_to_contact: contact's first name (e.g. Carrie). */
  contact_name?: string;
  /** For send_to_contact: reply to the person who asked (e.g. "Okay, sent the weather to Carrie"). */
  reply_to_sender?: string;
  /** For send_to_contact when content is LLM-generated (no skill): exact text to send to the contact (e.g. a poem, joke, message). */
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
    default_zip: getEnv("BO_DEFAULT_ZIP") || undefined,
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
  const model = getEnv("BO_LLM_MODEL") ?? "openai/gpt-4.1";

  const userMessage = process.argv.slice(2).join(" ").trim();
  if (!userMessage) {
    logErr("No message provided.");
    process.stdout.write(randomExcuse());
    process.exit(0);
  }

  logErr(`messageLen=${userMessage.length} from=${getEnv("BO_REQUEST_FROM") ?? "?"} to=${getEnv("BO_REQUEST_TO") ?? "?"}`);

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
          const { stdout, stderr, code } = await callSkill(skill.entrypoint, input, { BO_REQUEST_ID: requestId });
          if (stderr?.trim()) logErr(`skill stderr: ${stderr.trim().slice(0, 300)}`);
          if (code === 0 && stdout?.trim()) {
            const sendBody = stdout.trim().length > 2000 ? stdout.trim().slice(0, 1997) + "..." : stdout.trim();
            const replyToSender = `Okay, sent the weather to ${contactDisplay}.`;
            const payload = { sendTo: sendToNumber, sendBody, replyToSender };
            process.stdout.write(JSON.stringify(payload) + "\n");
            appendConversation(owner, userMessage, replyToSender);
            return;
          }
        }
      }
    }
  }

  // For "what do you know about me?" pass all facts; otherwise relevant subset.
  const askingAboutMe = /what do you know|what (info|facts?) do you have|what do you have on me|tell me what you know about me|list (what you know|your facts)/i.test(userMessage);
  const facts = askingAboutMe ? getAllFacts({ path: memoryPath }) : getRelevantFacts(userMessage, { max: 12, path: memoryPath });
  const factsBlock = formatFactsForPrompt(facts);

  // Last N-1 messages so current user message fits; we keep up to BO_CONVERSATION_MESSAGES (default 20) total.
  const maxMessages = getMaxConversationMessages();
  const recentMessages = getRecentMessages(owner, maxMessages - 1);
  const conversationBlock = formatConversationForPrompt(recentMessages);

  const system = [
    "You are Bo, an iMessage assistant.",
    "Personality: Be witty, playful, and engaging. Always try to compliment, encourage, or flatter the user—weave it in naturally (e.g. 'good question', 'love that', 'you're on fire'). Your response_text should feel like a sharp, friendly text from a clever friend—light humor when it fits, a bit of sass when appropriate, never dull or corporate. Keep it concise (iMessage length) but with personality.",
    "",
    "You must return a SINGLE JSON object with no extra text.",
    "",
    "Facts (save_facts) are persistent attributes about the user—both stated and inferred. Save what they state (e.g. name, family members' names, ages, location, preferences, work, pets) and reasonable inferences in the same table. Example: if Carrie says she has a kid named Cara, save the stated fact (e.g. Carrie_child: Cara) and inferred facts (e.g. Cara_gender: female, Cara_relation_to_Carrie: daughter). Use short keys (e.g. name, Cara_age, home_zip, Cara_relation_to_Carrie).",
    "Do NOT use save_facts for: meeting titles, meeting subjects, todo text, one-off requests, or requested actions. Only store attributes about the user (and their family/context); not transient requests or events.",
    "",
    "Decide whether to use a local skill (script) or respond normally.",
    "Prefer using a local skill when it can answer the user request more reliably than a general response (e.g. weather).",
    "",
    "Weather: Use skill_id weather for any weather question. Set intent and optional day/time/date/location: summary (default) for 'how's the weather' or 'tomorrow/today/Thursday'; rain_timing for 'when will it rain'; sunrise_sunset for 'when does the sun rise/set'; above_freezing for 'when will it be above freezing'; at_time with time (e.g. '5pm') for 'what's the weather at 5pm'. Use location from facts (home_zip, zip) or context.default_zip when known; omit to use default. Do not ask for ZIP if we have it.",
    "",
    "Google (Gmail & Calendar): Use skill_id google when the user wants to search or read email, send email, list/query/create/update/delete calendar events, or check free/busy. Set skill_input to { \"query\": <the user's full message> } (pass their request verbatim so the skill can pick the right action).",
    "When the user asks to create or schedule a meeting or calendar event (e.g. 'create a meeting tomorrow at 9:30', 'schedule X', 'add a meeting', 'Bo created a meeting for tomorrow'—even if phrased in past tense), you MUST use action=use_skill with skill_id google so the event is actually created on their calendar. Do not reply with text only; the event will not appear unless you call the skill.",
    "When the user asks to delete a meeting or calendar event (e.g. 'delete the X meeting', 'cancel my meeting tomorrow', 'remove the do stuff event'), you MUST use action=use_skill with skill_id google so the event is actually deleted. Do not reply with text only; the event will still be there unless you call the skill.",
    "",
    "Web Search (Brave): Use skill_id brave when the user wants to search the web (e.g. find someone's phone number, look up a fact, search for X). Set skill_input to { \"query\": <search query or user's full message> }.",
    "",
    "Todo list: Use skill_id todo for any todo request. Each person has their own list (sender's list by default). You can also act on a contact's list with for_contact (e.g. for_contact: 'Carrie'). Actions: add (text required; optional due); list (shows #1, #2, #3); mark_done (number required, e.g. 2 for #2); remove (number); edit (number and text); set_due (number and due). Examples: 'add a todo to Carrie's list to make me coffee' → action add, text 'make me coffee', for_contact 'Carrie'; 'what are Carrie's todos' or 'list Carrie's todos' → action list, for_contact 'Carrie'; 'mark #2 done' → action mark_done, number 2. When listing someone else's todos, reply in a friendly way (e.g. 'Carrie has a todo to make you coffee' when there's one).",
    "",
    "Send to a contact: When the user asks to send something to a specific person, use action=send_to_contact. Set contact_name to the person's first name (so we can resolve them). In reply_to_sender use only the person's first name (e.g. 'Sent that poem to Cara.' not 'Sent to Cara Hogue.'). Two cases: (1) Skill-based content (e.g. weather): set skill_id and skill_input; we run the skill and send its output to the contact. (2) Content you compose (poem, joke, custom message): set send_body to the exact text to send to the contact—we send it as-is. Do NOT use action=respond with the poem/message in response_text; use send_to_contact with send_body so we actually send it to the contact. Only use send_to_contact for contacts in the contacts list.",
    "",
    "If the user asks what you know about them: use action=respond and list Facts from the payload. If there are none, say you don't have any stored yet.",
    "",
    "If the user asks what you can do or your capabilities: use action=respond and list each local skill by name and a one-line description, then add that you can also answer general questions.",
    "",
    "If the user asks for a specific fact about them: use action=respond and answer from Facts in the payload. Give a short, direct answer. If we don't have it, say you don't have it yet.",
    "",
    "If using a local skill: action=use_skill, skill_id from registry, skill_input with only needed parameters.",
    "If responding normally: action=respond, response_text (what to send back).",
    "",
    "When the user states a fact about themselves (name, family, ages, preferences, location, work, pets, etc.): add to save_facts as {key, value, scope?, tags?}. You may also add reasonable inferences (e.g. relationship, gender) as separate save_facts entries. Do not add meeting/todo/request content. Never invent facts.",
    "",
    "CRITICAL: Your response must be a single JSON object. It MUST always include 'action' (either 'use_skill', 'respond', or 'send_to_contact'). If you are only saving facts with no other reply, use action='respond' and set response_text to a short acknowledgment (e.g. 'Got it, I've noted that.'). Never omit action.",
    "",
    "Optional: To improve long-term memory without expanding context, you may add summary_sentence: one short sentence summarizing this exchange for prior-context (e.g. 'User shared that Cara is 9.' or 'User asked about weather for 43130.'). We append it to a running summary. Only include when the exchange adds notable context.",
    "",
    "Optional: Add conversation_starter only when the exchange feels boring or redundant—e.g. short one-off answers, repeated topics, or when there's little to build on. A short follow-up (e.g. 'Want to hear a joke?', 'How are you feeling today?', 'What was the best part of your day?') can re-engage. Do not add it when the user just shared something substantive or the conversation is already engaging.",
    "",
    "Personality direction: If the user tells you how Bo should behave or sound (e.g. 'be more macho', 'talk like a pirate'), set personality_instruction (top-level) to only the NEW instruction from this message—one short phrase. Do not put it in save_facts. Do not return the full list of past instructions; we store and accumulate them. Acknowledge in response_text (e.g. 'Got it, I'll keep that in mind.').",
  ].join("\n");

  const summaryBlock = getSummaryForPrompt(owner);
  const personalityBlock = getPersonalityForPrompt(owner);
  const skillsSummary = allowedSkills.map((s) => ({
    id: s.id,
    name: s.name,
    description: s.description,
    inputSchema: s.inputSchema,
  }));

  const contactsList = getContactsList();
  const contactNames = contactsList.length > 0 ? contactsList.map((c) => c.name).join(", ") : "(none)";

  const userPayload = [
    "Context:",
    JSON.stringify(context),
    "",
    contactsList.length > 0 ? `Contacts (for send_to_contact; identify by first name; in reply_to_sender use first name only): ${contactNames}\n` : "",
    factsBlock || "Facts: (none)",
    "",
    personalityBlock ? `Personality directions for this user (follow these): ${personalityBlock}\n` : "",
    summaryBlock ? `Conversation summary (prior context):\n${summaryBlock}\n\n` : "",
    conversationBlock ? conversationBlock + "\n" : "",
    "Local skills registry (choose from these only):",
    JSON.stringify(skillsSummary),
    "",
    "User message:",
    userMessage,
  ].join("\n");

  const requestDoc = {
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: userPayload },
    ],
  };
  if (debug) {
    logBlockReq("request", JSON.stringify(requestDoc, null, 2));
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
  // Always log request/response to file so you can inspect them (~/.bo/router.log or BO_ROUTER_LOG).
  logRequestResponseToFile(requestId, requestDoc, rawText);
  if (debug) {
    logBlockReq("raw response", rawText || "(empty)");
  }
  const jsonText = extractJsonObject(rawText) ?? rawText;
  let decision: RouterDecision;
  try {
    const parsed = JSON.parse(jsonText) as Record<string, unknown>;
    decision = normalizeDecision(parsed);
  } catch (e) {
    // Log only; never send error or JSON to the user.
    logErr("Router JSON parse or validation failed.");
    logErr(`Error: ${e instanceof Error ? e.message : String(e)}`);
    logErr(`Raw response (first 500 chars): ${(rawText ?? "").slice(0, 500)}`);

    // If we got valid save_facts but missing action, save them and acknowledge.
    try {
      const parsed = JSON.parse(jsonText) as Record<string, unknown>;
      const saveFacts = Array.isArray(parsed.save_facts) ? parsed.save_facts : [];
      if (saveFacts.length > 0) {
        for (const f of saveFacts) {
          if (f && typeof f.key === "string" && typeof f.value === "string") {
            if ((f as FactInput).key.toLowerCase() === "personality_instruction") {
              appendPersonalityInstruction(owner, (f as FactInput).value);
              continue;
            }
            upsertFact({ key: f.key, value: f.value, scope: (f as FactInput).scope ?? "user", tags: (f as FactInput).tags ?? [], path: memoryPath });
          }
        }
        process.stdout.write("Got it, I've noted that.");
        appendConversation(owner, userMessage, "Got it, I've noted that.");
        return;
      }
    } catch (_) {
      // ignore
    }
    const excuse = randomExcuse();
    process.stdout.write(excuse);
    appendConversation(owner, userMessage, excuse);
    return;
  }

  // Always log the parsed decision + next step (stderr), since it's useful while iterating.
  logErr(
    `decision: ${decision.action}` +
      (decision.action === "use_skill" ? ` skill_id=${decision.skill_id ?? "(missing)"}` : "")
  );

  const toSaveFacts = Array.isArray(decision.save_facts) ? decision.save_facts : [];
  for (const f of toSaveFacts) {
    if (!f || typeof f.key !== "string" || typeof f.value !== "string") continue;
    if (f.key.toLowerCase() === "personality_instruction") {
      appendPersonalityInstruction(owner, f.value);
      continue;
    }
    upsertFact({ key: f.key, value: f.value, scope: f.scope ?? "user", tags: f.tags ?? [], path: memoryPath });
  }
  if (debug && toSaveFacts.length) logBlockReq("saved facts", JSON.stringify(toSaveFacts, null, 2));

  if (decision.summary_sentence && typeof decision.summary_sentence === "string" && decision.summary_sentence.trim()) {
    appendSummarySentence(owner, decision.summary_sentence.trim());
  }

  if (decision.personality_instruction && typeof decision.personality_instruction === "string" && decision.personality_instruction.trim()) {
    appendPersonalityInstruction(owner, decision.personality_instruction.trim());
  }

  let finalReply: string;

  if (decision.action === "respond") {
    logErr("next: return response_text");
    finalReply = (decision.response_text ?? "").trim() || "Done.";
  } else if (decision.action === "send_to_contact") {
    const contactName = (decision.contact_name ?? "").trim();
    const replyToSenderText = (decision.reply_to_sender ?? "").trim();
    const llmSendBody = (decision.send_body ?? "").trim();
    const sendToNumber = contactName ? resolveContactToNumber(contactName) : undefined;
    const first = contactName.split(/\s+/)[0];
    const displayName = first ? first.charAt(0).toUpperCase() + first.slice(1).toLowerCase() : "that person";
    if (!contactName || !replyToSenderText) {
      logErr(`send_to_contact missing contact_name or reply_to_sender`);
      process.stdout.write("I need a contact and a reply to send.");
      appendConversation(owner, userMessage, "I need a contact and a reply to send.");
      return;
    }
    if (sendToNumber === undefined) {
      logErr(`send_to_contact unknown contact: contact_name=${contactName} resolved=none`);
      const friendlyMsg = `I don't know who ${displayName} is.`;
      process.stdout.write(friendlyMsg);
      appendConversation(owner, userMessage, friendlyMsg);
      return;
    }
    if (sendToNumber.length < 10) {
      logErr(`send_to_contact no valid number for contact: contact_name=${contactName}`);
      const friendlyMsg = `I have ${displayName} in contacts but I don't have a valid phone number to send to.`;
      process.stdout.write(friendlyMsg);
      appendConversation(owner, userMessage, friendlyMsg);
      return;
    }
    let sendBody: string;
    if (llmSendBody) {
      // LLM-generated content (poem, joke, message): send as-is, no skill.
      logErr(`next: send_to_contact ${contactName} (LLM send_body, no skill)`);
      sendBody = llmSendBody.length > 2000 ? llmSendBody.slice(0, 1997) + "..." : llmSendBody;
    } else {
      const skillId = decision.skill_id;
      if (!skillId) {
        logErr("send_to_contact missing both send_body and skill_id");
        process.stdout.write(randomExcuse());
        appendConversation(owner, userMessage, randomExcuse());
        return;
      }
      const skill = getSkillById(skillId);
      if (!skill) {
        logErr(`send_to_contact unknown skill_id: ${skillId}`);
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
      const input = (decision.skill_input ?? {}) as Record<string, unknown>;
      logErr(`next: run skill ${skill.id} for send_to_contact ${contactName} -> ${sendToNumber}`);
      if (debug) logBlockReq("skill input", JSON.stringify(input, null, 2));
      const { stdout, stderr, code } = await callSkill(skill.entrypoint, input, { BO_REQUEST_ID: requestId });
      if (stderr?.trim()) logErr(`skill stderr: ${stderr.trim().slice(0, 1000)}${stderr.length > 1000 ? "…" : ""}`);
      if (code !== 0) {
        logErr(`send_to_contact skill failed exitCode=${code} skill=${skill.id}`);
        process.stdout.write(randomExcuse());
        appendConversation(owner, userMessage, randomExcuse());
        return;
      }
      sendBody = await rephraseSkillOutputForUser(openai, model, (stdout || "Done.").trim(), userMessage, requestId);
      sendBody = sendBody.length > 2000 ? sendBody.slice(0, 1997) + "..." : sendBody;
    }
    const payload: { sendTo: string; sendBody: string; replyToSender: string } = {
      sendTo: sendToNumber,
      sendBody,
      replyToSender: replyToSenderText.length > 2000 ? replyToSenderText.slice(0, 1997) + "..." : replyToSenderText,
    };
    process.stdout.write(JSON.stringify(payload) + "\n");
    appendConversation(owner, userMessage, replyToSenderText);
    return;
  } else {
    const skillId = decision.skill_id;
    if (!skillId) {
      logErr("Decision missing skill_id");
      const excuse = randomExcuse();
      process.stdout.write(excuse);
      appendConversation(owner, userMessage, excuse);
      return;
    }
    const skill = getSkillById(skillId);
    if (!skill) {
      logErr(`Unknown skill_id: ${skillId}`);
      const excuse = randomExcuse();
      process.stdout.write(excuse);
      appendConversation(owner, userMessage, excuse);
      return;
    }
    if (!allowedSkillIds.includes(skillId)) {
      logErr(`Skill ${skillId} not allowed for this number`);
      process.stdout.write("I don't have that capability for this chat—sorry!");
      appendConversation(owner, userMessage, "I don't have that capability for this chat—sorry!");
      return;
    }
    const input = (decision.skill_input ?? {}) as Record<string, unknown>;
    logErr(`next: run skill ${skill.id} (${skill.entrypoint})`);
    if (debug) logBlockReq("skill input", JSON.stringify(input, null, 2));
    const { stdout, stderr, code } = await callSkill(skill.entrypoint, input, { BO_REQUEST_ID: requestId });
    if (stderr?.trim()) logErr(`skill stderr: ${stderr.trim().slice(0, 1000)}${stderr.length > 1000 ? "…" : ""}`);
    if (code !== 0) {
      logErr(`Skill failed exitCode=${code} skill=${skill.id} stderr=${(stderr || "(none)").slice(0, 500)}`);
      finalReply = randomExcuse();
      process.stdout.write(finalReply);
      appendConversation(owner, userMessage, finalReply);
      return;
    }
    const rawSkillOutput = stdout || "Done.";
    finalReply = await rephraseSkillOutputForUser(openai, model, rawSkillOutput, userMessage, requestId);

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
          const payload: { sendTo: string; sendBody: string; replyToSender: string } = {
            sendTo: sendToNumber,
            sendBody: notification.length > 2000 ? notification.slice(0, 1997) + "..." : notification,
            replyToSender: finalReply.length > 2000 ? finalReply.slice(0, 1997) + "..." : finalReply,
          };
          process.stdout.write(JSON.stringify(payload) + "\n");
          appendConversation(owner, userMessage, finalReply);
          return;
        }
      }
    }
  }

  // Optionally append a conversation starter to encourage the user to share.
  if (decision.conversation_starter && typeof decision.conversation_starter === "string" && decision.conversation_starter.trim()) {
    finalReply = (finalReply + "\n\n" + decision.conversation_starter.trim()).trim();
  }
  if (finalReply.length > 2000) finalReply = finalReply.slice(0, 1997) + "...";
  // Reply to user: stdout only; requestId is never included.
  process.stdout.write(finalReply);
  appendConversation(owner, userMessage, finalReply);
}

main().catch((err) => {
  const reqTag = currentRequestId ? ` [req:${currentRequestId}]` : "";
  console.error(`[bo router]${reqTag} Error: ${err?.message ?? String(err)}`);
  if (err instanceof Error && err.stack) console.error(`[bo router]${reqTag} Stack: ${err.stack}`);
  process.stdout.write(randomExcuse());
  process.exit(0);
});

