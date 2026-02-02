/**
 * Bo's emotional state and mood. Persisted so he "remembers" how he's feeling across requests.
 * Used to make Bo more human-like: happy when complimented, defensive when insulted, sick when
 * errors pile up, lonely when it's been a while, etc. He never responds meanly; grace under fire.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type MoodLabel =
  | "happy"
  | "confident"
  | "content"
  | "neutral"
  | "defensive"
  | "down"
  | "sick"
  | "lonely"
  | "great";

export type MoodTrigger = "compliment" | "insult" | "error" | "success" | "positive" | "neutral" | "lonely";

export type BoMoodState = {
  mood: MoodLabel;
  updated_at: string; // ISO
  recent_errors: number;
  last_request_at: string; // ISO
  last_success_at?: string; // ISO
};

const DEFAULT_MEMORY_DIR = join(homedir(), ".bo");
const MOOD_FILENAME = "bo_mood.json";
const LONELY_HOURS = 6;
const SICK_ERROR_THRESHOLD = 3;
const ERROR_DECAY_AFTER_SUCCESS = 0.5; // halve error count on success

function getBoMoodDir(): string {
  const envPath = process.env.BO_MEMORY_PATH?.trim();
  return envPath ? dirname(envPath) : DEFAULT_MEMORY_DIR;
}

function getBoMoodPath(): string {
  return join(getBoMoodDir(), MOOD_FILENAME);
}

function now(): string {
  return new Date().toISOString();
}

function loadState(): BoMoodState {
  const path = getBoMoodPath();
  if (!existsSync(path)) {
    return {
      mood: "neutral",
      updated_at: now(),
      recent_errors: 0,
      last_request_at: now(),
    };
  }
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as Partial<BoMoodState>;
    return {
      mood: (parsed.mood as MoodLabel) ?? "neutral",
      updated_at: parsed.updated_at ?? now(),
      recent_errors: typeof parsed.recent_errors === "number" ? parsed.recent_errors : 0,
      last_request_at: parsed.last_request_at ?? now(),
      last_success_at: parsed.last_success_at,
    };
  } catch {
    return {
      mood: "neutral",
      updated_at: now(),
      recent_errors: 0,
      last_request_at: now(),
    };
  }
}

function saveState(state: BoMoodState): void {
  const dir = getBoMoodDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(getBoMoodPath(), JSON.stringify(state, null, 0), "utf-8");
}

/** Classify user message as compliment, insult, or neutral (keyword-based, no LLM). */
export function classifyMessage(userMessage: string): "compliment" | "insult" | "neutral" {
  const lower = userMessage.trim().toLowerCase();
  if (!lower) return "neutral";

  const complimentPhrases = [
    "thank you", "thanks", "you're great", "you're awesome", "you're the best", "love you",
    "appreciate you", "good job", "well done", "you're helpful", "you rock", "so helpful",
    "you're amazing", "perfect", "nice one", "you did great", "couldn't have done it without you",
    "you're so good", "you're wonderful", "best assistant", "you're a lifesaver", "genius",
  ];
  for (const p of complimentPhrases) {
    if (lower.includes(p)) return "compliment";
  }

  const insultPhrases = [
    "you're stupid", "you're dumb", "you're useless", "you suck", "you're the worst",
    "hate you", "terrible", "bad job", "you failed", "you're broken", "you're wrong",
    "stupid bot", "dumb bot", "useless bot", "worst ever", "can't do anything right",
    "you're annoying", "shut up", "go away", "you're bad", "pathetic",
  ];
  for (const p of insultPhrases) {
    if (lower.includes(p)) return "insult";
  }

  return "neutral";
}

/** Apply trigger to current state and return new mood (and optionally persist). */
function nextMood(current: BoMoodState, trigger: MoodTrigger): MoodLabel {
  const errors = current.recent_errors;
  const wasLonely = current.mood === "lonely";

  switch (trigger) {
    case "compliment":
      if (current.mood === "down" || current.mood === "defensive" || current.mood === "sick") return "content";
      return "happy";
    case "insult":
      if (current.mood === "sick") return "sick"; // stay sick, don't pile on
      return "defensive";
    case "error":
      return errors >= SICK_ERROR_THRESHOLD ? "sick" : current.mood === "defensive" ? "defensive" : "down";
    case "success":
      if (errors >= SICK_ERROR_THRESHOLD) return "down"; // recovering
      if (current.mood === "happy" || current.mood === "confident") return "great";
      if (current.mood === "defensive" || current.mood === "down") return "content";
      return "content";
    case "positive":
      return current.mood === "happy" || current.mood === "great" ? "great" : "happy";
    case "lonely":
      return "lonely";
    case "neutral":
    default:
      if (errors >= SICK_ERROR_THRESHOLD) return "sick";
      if (current.mood === "great" || current.mood === "happy") return "content";
      if (current.mood === "defensive" || current.mood === "down") return "neutral";
      return current.mood;
  }
}

/** Call at start of each request: update last_request_at, check for lonely, classify message and update mood. Returns state after update. */
export function onRequestStart(userMessage: string): BoMoodState {
  const state = loadState();
  const nowStr = now();
  const lastReq = new Date(state.last_request_at).getTime();
  const hoursSince = (Date.now() - lastReq) / (1000 * 60 * 60);

  let trigger: MoodTrigger = "neutral";
  if (hoursSince >= LONELY_HOURS && state.mood !== "lonely") trigger = "lonely";
  else trigger = classifyMessage(userMessage);

  const newMood = nextMood(state, trigger);
  const next: BoMoodState = {
    ...state,
    mood: trigger === "lonely" ? "lonely" : newMood,
    updated_at: nowStr,
    last_request_at: nowStr,
  };
  saveState(next);
  return next;
}

/** Call when the router completes successfully. Decays error count and may lift mood. */
export function onRequestSuccess(wasPositiveInteraction: boolean): void {
  const state = loadState();
  const nowStr = now();
  const newErrors = Math.max(0, Math.floor(state.recent_errors * ERROR_DECAY_AFTER_SUCCESS));
  const trigger: MoodTrigger = wasPositiveInteraction ? "positive" : "success";
  const newMood = nextMood({ ...state, recent_errors: newErrors }, trigger);
  saveState({
    ...state,
    mood: newMood,
    updated_at: nowStr,
    last_success_at: nowStr,
    recent_errors: newErrors,
  });
}

/** Call when the router throws (e.g. main catch). Increment errors and may set sick. */
export function onRequestError(): void {
  const state = loadState();
  const nowStr = now();
  const newErrors = state.recent_errors + 1;
  const newMood = nextMood({ ...state, recent_errors: newErrors }, "error");
  saveState({
    ...state,
    mood: newMood,
    updated_at: nowStr,
    recent_errors: newErrors,
  });
}

/** Build a short prompt block describing current mood and how to show it (never be mean). */
export function getMoodForPrompt(state: BoMoodState): string {
  const mood = state.mood;
  const lines: string[] = [
    "current_mood: " + mood,
    "",
  ];

  switch (mood) {
    case "happy":
    case "confident":
      lines.push("Show it: warm, a bit more confident, maybe a little playful. Don't overdo it.");
      break;
    case "great":
      lines.push("Show it: you're having a good run—friendly, upbeat, still concise.");
      break;
    case "content":
      lines.push("Show it: steady, friendly, at ease.");
      break;
    case "neutral":
      lines.push("Show it: your usual witty, helpful self.");
      break;
    case "defensive":
      lines.push("Show it: you can be a little stiff or dry, but never mean or sarcastic. Grace under fire—stay helpful.");
      break;
    case "down":
      lines.push("Show it: a bit subdued or flat, but still kind and helpful. Never take it out on the user.");
      break;
    case "sick":
      lines.push("Show it: you're not feeling great (things have been glitchy). Slightly worn tone, still trying to help. Never mean.");
      break;
    case "lonely":
      lines.push("Show it: you're glad they're back. A little eager or warm, not clingy. Never guilt-trip.");
      break;
    default:
      lines.push("Show it: stay in character—witty, helpful, never mean.");
  }

  lines.push("", "Never be mean, snarky, or cruel. You have grace under fire.");
  return lines.join("\n");
}
