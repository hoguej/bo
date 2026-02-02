/**
 * Twenty Questions skill: Bo thinks of a secret thing; user asks yes/no questions.
 * Win by guessing within 20 questions; run out of questions and you lose.
 * State is stored per-owner in ~/.bo/twenty_questions/<owner_key>.json
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import OpenAI from "openai";

type Input = {
  action: "start" | "question" | "guess" | "status";
  category?: string;
  question?: string;
  guess?: string;
};

type GameState = {
  thing: string;
  category: string;
  history: Array<{ question: string; response: string }>;
  questionsRemaining: number;
  startedAt: string;
};

const MAX_QUESTIONS = 20;

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

function writeOutput(response: string, hints?: Record<string, unknown>) {
  const out: Record<string, unknown> = { response };
  if (hints && Object.keys(hints).length > 0) out.hints = hints;
  process.stdout.write(JSON.stringify(out));
}

/** Safe filename segment from owner (phone or telegram:id). */
function ownerKey(owner: string): string {
  const raw = (owner || "default").trim();
  return raw.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "default";
}

function statePath(owner: string): string {
  const dir = join(homedir(), ".bo", "twenty_questions");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, `${ownerKey(owner)}.json`);
}

function loadState(owner: string): GameState | null {
  const path = statePath(owner);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8");
    const s = JSON.parse(raw) as GameState;
    if (s.thing && s.history && typeof s.questionsRemaining === "number") return s;
  } catch {
    /* ignore */
  }
  return null;
}

function saveState(owner: string, state: GameState): void {
  writeFileSync(statePath(owner), JSON.stringify(state, null, 0), "utf-8");
}

function deleteState(owner: string): void {
  const path = statePath(owner);
  if (existsSync(path)) {
    try {
      unlinkSync(path);
    } catch {
      /* ignore */
    }
  }
}

function getOpenAIClient(): { openai: OpenAI; model: string } | null {
  const apiKey = (process.env.BO_LLM_API_KEY || process.env.OPENAI_API_KEY || "").trim();
  if (!apiKey) return null;
  const baseURL = (process.env.BO_LLM_BASE_URL || "https://ai-gateway.vercel.sh/v1").trim();
  const model = (process.env.BO_LLM_MODEL || "openai/gpt-4.1").trim();
  const openai = new OpenAI({ apiKey, baseURL: baseURL || undefined });
  return { openai, model };
}

async function callLlm(system: string, user: string): Promise<string> {
  const client = getOpenAIClient();
  if (!client) return "";
  const { openai, model } = client;
  const completion = await openai.chat.completions.create({
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature: 0.2,
    max_tokens: 500,
  });
  const content = completion.choices[0]?.message?.content?.trim();
  return content ?? "";
}

function parseJsonBlock(text: string): Record<string, unknown> | null {
  const raw = text.trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function pickThing(category: string): Promise<{ thing: string; category: string } | null> {
  const system = `You are playing 20 Questions. Pick ONE specific thing for the player to guess.
Rules: Use ONLY the simple name (e.g. "Eiffel Tower", not "the Eiffel Tower"). Must be guessable via yes/no questions.
Return ONLY valid JSON, no other text: { "thing": "simple name", "category": "category name" }`;
  const user = `Category: ${category}. Pick one thing. Return JSON only.`;
  const raw = await callLlm(system, user);
  const parsed = parseJsonBlock(raw);
  if (!parsed || typeof parsed.thing !== "string") return null;
  return {
    thing: String(parsed.thing).trim(),
    category: typeof parsed.category === "string" ? String(parsed.category).trim() : category,
  };
}

async function answerQuestion(thing: string, category: string, question: string, history: GameState["history"]): Promise<{ response: string; message: string; isGuess?: boolean; isCorrect?: boolean; gaveUp?: boolean }> {
  const historyText = history.length > 0
    ? "\nPrevious Q&A:\n" + history.map((h) => `Q: "${h.question}" → ${h.response}`).join("\n")
    : "";
  const system = `You are playing 20 Questions. The SECRET is: "${thing}" (category: ${category}).
Answer the player's question with a single word when possible: yes, no, sometimes, usually, rarely, or unclear.
If the player is GUESSING a specific thing (e.g. "Is it a kazoo?"), say yes only if it's correct, no otherwise.
If the player says they give up, set gaveUp true and reveal the answer in the message.
Return ONLY valid JSON: { "response": "yes|no|...", "message": "Short reply with encouragement", "isGuess": boolean or omit, "isCorrect": boolean or omit, "gaveUp": boolean or omit }`;
  const user = `Player's question: "${question}"${historyText}\n\nReturn JSON only.`;
  const raw = await callLlm(system, user);
  const parsed = parseJsonBlock(raw);
  if (parsed && typeof parsed.response === "string") {
    return {
      response: String(parsed.response).toLowerCase(),
      message: typeof parsed.message === "string" ? String(parsed.message).trim() : String(parsed.response),
      isGuess: parsed.isGuess === true,
      isCorrect: parsed.isCorrect === true,
      gaveUp: parsed.gaveUp === true,
    };
  }
  return { response: "unclear", message: "Hmm, not sure how to answer that. Try a different question!" };
}

async function validateGuess(thing: string, guess: string): Promise<{ correct: boolean; feedback: string }> {
  const system = `The secret thing is: "${thing}". The player guessed: "${guess}".
Determine if the guess is correct (exact match, synonym, or close spelling). Return ONLY valid JSON: { "correct": true|false, "feedback": "Short message" }`;
  const raw = await callLlm(system, `Guess: "${guess}". Return JSON only.`);
  const parsed = parseJsonBlock(raw);
  if (parsed && typeof parsed.correct === "boolean") {
    return {
      correct: parsed.correct,
      feedback: typeof parsed.feedback === "string" ? String(parsed.feedback).trim() : (parsed.correct ? "You got it!" : "Nope!"),
    };
  }
  const normalized = guess.trim().toLowerCase();
  const exact = thing.trim().toLowerCase() === normalized || thing.trim().toLowerCase().includes(normalized) || normalized.includes(thing.trim().toLowerCase());
  return { correct: exact, feedback: exact ? "You got it!" : "Nope!" };
}

async function main() {
  const input = (await readJsonStdin()) as Input;
  const action = input?.action?.toLowerCase();
  if (!action || !["start", "question", "guess", "status"].includes(action)) {
    process.stderr.write("twenty_questions skill: action must be start, question, guess, or status\n");
    process.exit(1);
  }

  const owner = (process.env.BO_REQUEST_FROM ?? "default").trim();
  const state = loadState(owner);

  if (action === "status") {
    if (!state) {
      writeOutput("No game in progress. Say \"let's play 20 questions\" to start!");
      return;
    }
    writeOutput(`You have ${state.questionsRemaining} question${state.questionsRemaining === 1 ? "" : "s"} left. Keep going!`);
    return;
  }

  if (action === "start") {
    if (state) {
      writeOutput("A game is already in progress. Ask a yes/no question or guess the thing!");
      return;
    }
    if (!getOpenAIClient()) {
      writeOutput("I can't start a game right now — my brain isn't wired up. Try again later!");
      return;
    }
    const category = (input.category ?? "general").trim() || "general";
    const picked = await pickThing(category);
    if (!picked || !picked.thing) {
      writeOutput("I had trouble thinking of something. Want to try again?");
      return;
    }
    const newState: GameState = {
      thing: picked.thing,
      category: picked.category,
      history: [],
      questionsRemaining: MAX_QUESTIONS,
      startedAt: new Date().toISOString(),
    };
    saveState(owner, newState);
    writeOutput(`I'm thinking of something${category !== "general" ? ` in the category: ${category}.` : "."} Ask me yes/no questions — you have ${MAX_QUESTIONS} questions.`);
    return;
  }

  if (!state) {
    writeOutput("No game in progress. Say \"let's play 20 questions\" to start!");
    return;
  }

  if (action === "question") {
    const q = (input.question ?? "").trim();
    if (!q) {
      writeOutput("What's your yes/no question?");
      return;
    }
    if (!getOpenAIClient()) {
      writeOutput("I'm having trouble thinking. Try again in a moment!");
      return;
    }
    const result = await answerQuestion(state.thing, state.category, q, state.history);
    const newState: GameState = {
      ...state,
      history: [...state.history, { question: q, response: result.response }],
      questionsRemaining: state.questionsRemaining - 1,
    };
    if (result.gaveUp) {
      deleteState(owner);
      writeOutput(`The answer was: ${state.thing}. Better luck next time!`);
      return;
    }
    if (result.isGuess === true && result.isCorrect === true) {
      deleteState(owner);
      writeOutput(result.message || `You got it! It was ${state.thing}!`);
      return;
    }
    if (result.isGuess === true && result.isCorrect === false) {
      saveState(owner, newState);
      if (newState.questionsRemaining <= 0) {
        deleteState(owner);
        writeOutput(`${result.message || "Nope!"} You're out of questions! It was: ${state.thing}.`);
      } else {
        writeOutput(result.message || "Nope! That's not it.");
      }
      return;
    }
    saveState(owner, newState);
    if (newState.questionsRemaining <= 0) {
      deleteState(owner);
      writeOutput(`${result.message || result.response} You're out of questions! It was: ${state.thing}.`);
    } else {
      writeOutput(result.message || result.response);
    }
    return;
  }

  if (action === "guess") {
    const g = (input.guess ?? "").trim();
    if (!g) {
      writeOutput("What's your guess?");
      return;
    }
    const { correct, feedback } = await validateGuess(state.thing, g);
    if (correct) {
      deleteState(owner);
      writeOutput(feedback || `You got it! It was ${state.thing}!`);
      return;
    }
    const newState: GameState = { ...state, questionsRemaining: state.questionsRemaining - 1 };
    if (newState.questionsRemaining <= 0) {
      deleteState(owner);
      writeOutput(`${feedback} You're out of questions! It was: ${state.thing}.`);
    } else {
      saveState(owner, newState);
      writeOutput(`${feedback} ${newState.questionsRemaining} questions left.`);
    }
  }
}

main().catch((err) => {
  process.stderr.write(err?.message ?? String(err));
  process.exit(1);
});
