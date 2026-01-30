/**
 * Google (Gmail + Calendar) skill.
 * Flow: user query → AI picks function + params → run gog wrapper → AI formats reply.
 */

import OpenAI from "openai";
import {
  searchEmail,
  getEmail,
  sendEmail,
  listCalendars,
  listEvents,
  searchCalendarEvents,
  getCalendarEvent,
  createEvent,
  updateEvent,
  deleteEvent,
  freeBusy,
} from "../gog-wrapper";

type Input = { query: string };

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

/** Return RFC3339 offset (e.g. -05:00) for the given timezone at the given date, for createEvent prompts. */
function getTzOffsetForPrompt(date: Date, tz: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" }).formatToParts(date);
    const tzPart = parts.find((p) => p.type === "timeZoneName");
    const val = String(tzPart?.value ?? "").replace(/\u2212/g, "-");
    const m = val.match(/(?:UTC|GMT)([+-])(\d{1,2})(?::(\d{2})?)?/);
    if (m) {
      const sign = m[1];
      const h = (m[2] ?? "0").padStart(2, "0");
      const min = (m[3] ?? "0").padStart(2, "0");
      return `${sign}${h}:${min}`;
    }
  } catch (_) {
    /* ignore */
  }
  if (tz.includes("New_York") || tz === "America/New_York") return "-05:00";
  if (tz.includes("Los_Angeles") || tz === "America/Los_Angeles") return "-08:00";
  return "+00:00";
}

function normalizeMatchText(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function eventMatchesQuery(event: { summary?: string; description?: string; location?: string }, queryNorm: string): boolean {
  if (!queryNorm) return false;
  const fields = [event.summary, event.description, event.location].filter(Boolean) as string[];
  return fields.some((field) => normalizeMatchText(field).includes(queryNorm));
}

const FUNCTION_DEFS = [
  {
    name: "searchEmail",
    description: "Search Gmail using Gmail query syntax (e.g. from:someone, subject:foo, is:unread, after:2024/1/1).",
    params: { query: "string (required)", max: "number (optional, default 10)" },
  },
  {
    name: "getEmail",
    description: "Get full content or metadata of a single email by its message ID (from search results).",
    params: { messageId: "string (required)", format: "full | metadata (optional, default full)" },
  },
  {
    name: "sendEmail",
    description: "Send a new email. Required: to, subject, body. Optional: cc, bcc. For replies use replyToMessageId or threadId.",
    params: {
      to: "string (required, comma-separated for multiple)",
      subject: "string (required)",
      body: "string (required)",
      cc: "string (optional)",
      bcc: "string (optional)",
      replyToMessageId: "string (optional)",
      threadId: "string (optional)",
    },
  },
  {
    name: "listCalendars",
    description: "List the user's calendars (id, summary, primary).",
    params: {},
  },
  {
    name: "listEvents",
    description:
      "List events from a calendar. Use calendarId or omit for primary. Time range: from, to (RFC3339 or relative like today, tomorrow), or today, tomorrow, week, or days=N.",
    params: {
      calendarId: "string (optional, default primary)",
      from: "string (optional)",
      to: "string (optional)",
      today: "boolean (optional)",
      tomorrow: "boolean (optional)",
      week: "boolean (optional)",
      days: "number (optional, e.g. 7)",
      max: "number (optional, default 10)",
      query: "string (optional, free text filter)",
      all: "boolean (optional, all calendars)",
    },
  },
  {
    name: "searchCalendarEvents",
    description: "Search calendar events by free text query.",
    params: { query: "string (required)", from: "string (optional)", to: "string (optional)", days: "number (optional)", max: "number (optional)", calendarId: "string (optional)" },
  },
  {
    name: "getCalendarEvent",
    description: "Get a single event by calendar ID and event ID.",
    params: { calendarId: "string (required)", eventId: "string (required)" },
  },
  {
    name: "createEvent",
    description:
      "Create a calendar event. from and to MUST be RFC3339 with timezone (e.g. 2025-01-31T09:30:00-05:00). Use primary or email as calendarId. Default 30 min duration if user does not specify end.",
    params: {
      calendarId: "string (required, e.g. primary)",
      summary: "string (required)",
      from: "string (required, RFC3339 e.g. 2025-01-31T09:30:00-05:00)",
      to: "string (required, RFC3339 e.g. 2025-01-31T10:00:00-05:00)",
      description: "string (optional)",
      location: "string (optional)",
      attendees: "string[] (optional, comma-separated in JSON)",
      allDay: "boolean (optional)",
      withMeet: "boolean (optional)",
    },
  },
  {
    name: "updateEvent",
    description: "Update an existing event (summary, from, to, description, location).",
    params: {
      calendarId: "string (required)",
      eventId: "string (required)",
      summary: "string (optional)",
      from: "string (optional)",
      to: "string (optional)",
      description: "string (optional)",
      location: "string (optional)",
    },
  },
  {
    name: "deleteEvent",
    description: "Delete a calendar event by calendarId and eventId (use when you already have the event id).",
    params: { calendarId: "string (required)", eventId: "string (required)", scope: "all | single | future (optional, default all)" },
  },
  {
    name: "deleteEventByQuery",
    description:
      "Find and delete a calendar event by name/summary. Use when the user says 'delete the X meeting' or 'cancel my X event'. Searches for events matching the query, then deletes the first match. Prefer this over deleteEvent when the user does not give an event id. Use a wide search window (at least 30 days) so the event is found.",
    params: {
      query: "string (required, e.g. 'do stuff' or meeting title)",
      calendarId: "string (optional, default primary)",
      days: "number (optional, search next N days; use 30 or more, default 180)",
    },
  },
  {
    name: "freeBusy",
    description: "Get free/busy slots for one or more calendars in a time range.",
    params: { calendarIds: "string[] (required, comma-separated)", from: "string (required, RFC3339)", to: "string (required, RFC3339)" },
  },
];

async function dispatch(
  fn: string,
  params: Record<string, unknown>
): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
  try {
    switch (fn) {
      case "searchEmail": {
        const query = params.query as string;
        if (!query) throw new Error("searchEmail requires query");
        const max = typeof params.max === "number" ? params.max : 10;
        const data = await searchEmail(query, max);
        return { ok: true, data: data ?? {} };
      }
      case "getEmail": {
        const messageId = params.messageId as string;
        if (!messageId) throw new Error("getEmail requires messageId");
        const format = (params.format as "full" | "metadata") || "full";
        const data = await getEmail(messageId, format);
        return { ok: true, data: data ?? {} };
      }
      case "sendEmail": {
        const to = params.to as string;
        const subject = params.subject as string;
        const body = params.body as string;
        if (!to || !subject || !body) throw new Error("sendEmail requires to, subject, body");
        const data = await sendEmail({
          to,
          subject,
          body,
          cc: params.cc as string | undefined,
          bcc: params.bcc as string | undefined,
          replyToMessageId: params.replyToMessageId as string | undefined,
          threadId: params.threadId as string | undefined,
        });
        return { ok: true, data: data ?? {} };
      }
      case "listCalendars": {
        const data = await listCalendars();
        return { ok: true, data: data ?? {} };
      }
      case "listEvents": {
        const data = await listEvents({
          calendarId: params.calendarId as string | undefined,
          from: params.from as string | undefined,
          to: params.to as string | undefined,
          today: params.today as boolean | undefined,
          tomorrow: params.tomorrow as boolean | undefined,
          week: params.week as boolean | undefined,
          days: params.days as number | undefined,
          max: params.max as number | undefined,
          query: params.query as string | undefined,
          all: params.all as boolean | undefined,
        });
        return { ok: true, data: data ?? {} };
      }
      case "searchCalendarEvents": {
        const query = params.query as string;
        if (!query) throw new Error("searchCalendarEvents requires query");
        const data = await searchCalendarEvents(query, {
          from: params.from as string | undefined,
          to: params.to as string | undefined,
          days: params.days as number | undefined,
          max: params.max as number | undefined,
          calendarId: params.calendarId as string | undefined,
        });
        return { ok: true, data: data ?? {} };
      }
      case "getCalendarEvent": {
        const calendarId = params.calendarId as string;
        const eventId = params.eventId as string;
        if (!calendarId || !eventId) throw new Error("getCalendarEvent requires calendarId and eventId");
        const data = await getCalendarEvent(calendarId, eventId);
        return { ok: true, data: data ?? {} };
      }
      case "createEvent": {
        const calendarId = params.calendarId as string;
        const summary = params.summary as string;
        const from = params.from as string;
        const to = params.to as string;
        if (!calendarId || !summary || !from || !to) throw new Error("createEvent requires calendarId, summary, from, to");
        const attendees = params.attendees;
        const attendeesList = Array.isArray(attendees)
          ? attendees.map(String)
          : typeof attendees === "string"
            ? attendees.split(",").map((s) => s.trim())
            : undefined;
        const data = await createEvent({
          calendarId,
          summary,
          from,
          to,
          description: params.description as string | undefined,
          location: params.location as string | undefined,
          attendees: attendeesList,
          allDay: params.allDay as boolean | undefined,
          withMeet: params.withMeet as boolean | undefined,
        });
        return { ok: true, data: data ?? {} };
      }
      case "updateEvent": {
        const calendarId = params.calendarId as string;
        const eventId = params.eventId as string;
        if (!calendarId || !eventId) throw new Error("updateEvent requires calendarId and eventId");
        const data = await updateEvent({
          calendarId,
          eventId,
          summary: params.summary as string | undefined,
          from: params.from as string | undefined,
          to: params.to as string | undefined,
          description: params.description as string | undefined,
          location: params.location as string | undefined,
        });
        return { ok: true, data: data ?? {} };
      }
      case "deleteEvent": {
        const calendarId = params.calendarId as string;
        const eventId = params.eventId as string;
        if (!calendarId || !eventId) throw new Error("deleteEvent requires calendarId and eventId");
        await deleteEvent(calendarId, eventId, (params.scope as "all" | "single" | "future") || "all");
        return { ok: true, data: { deleted: true } };
      }
      case "deleteEventByQuery": {
        const query = params.query as string;
        if (!query?.trim()) throw new Error("deleteEventByQuery requires query (meeting name/summary to search for)");
        const daysParam = typeof params.days === "number" ? params.days : 180;
        const days = Math.max(daysParam, 30);
        const searchQuery = query.trim();
        const queryNorm = normalizeMatchText(searchQuery);
        const calendarsResult = await listCalendars();
        const calendarIds: string[] = (calendarsResult?.calendars ?? []).map((c) => c.id).filter(Boolean);
        if (calendarIds.length === 0) calendarIds.push("primary");
        let found: { calendarId: string; id: string; summary?: string } | null = null;
        for (const cid of calendarIds) {
          const searchItems = (await searchCalendarEvents(searchQuery, { calendarId: cid, days, max: 10 }))?.events ?? [];
          const searchMatch = searchItems.find((e) => eventMatchesQuery(e, queryNorm));
          if (searchMatch?.id) {
            found = { calendarId: cid, id: searchMatch.id, summary: searchMatch.summary };
            break;
          }
          const listItems = (await listEvents({ calendarId: cid, days, max: 50 }))?.events ?? [];
          const listMatch = listItems.find((e) => eventMatchesQuery(e, queryNorm));
          if (listMatch?.id) {
            found = { calendarId: cid, id: listMatch.id, summary: listMatch.summary };
            break;
          }
        }
        if (!found) {
          throw new Error(
            `No calendar event found matching "${searchQuery}" in the next ${days} days ` +
              `(checked ${calendarIds.length} calendar(s); searched summary/description/location)`
          );
        }
        await deleteEvent(found.calendarId, found.id, "all");
        return { ok: true, data: { deleted: true, summary: found.summary ?? query } };
      }
      case "freeBusy": {
        const calendarIds = params.calendarIds;
        const ids = Array.isArray(calendarIds)
          ? calendarIds.map(String)
          : typeof calendarIds === "string"
            ? calendarIds.split(",").map((s) => s.trim())
            : [];
        const from = params.from as string;
        const to = params.to as string;
        if (!ids.length || !from || !to) throw new Error("freeBusy requires calendarIds, from, to");
        const data = await freeBusy(ids, from, to);
        return { ok: true, data: data ?? {} };
      }
      default:
        return { ok: false, error: `Unknown function: ${fn}` };
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg };
  }
}

async function main() {
  // RequestId from router env; for stderr/logs only. Never write to stdout (user reply).
  const requestId = getEnv("BO_REQUEST_ID") ?? "";
  const reqTag = requestId ? ` [req:${requestId}]` : "";
  const logErr = (msg: string, ...args: unknown[]) => console.error(`[google skill]${reqTag} ${msg}`, ...args);

  const input = (await readJsonStdin()) as Input;
  const query = input?.query?.trim();
  if (!query) {
    logErr("Missing query. Provide { \"query\": \"search my email for X\" }.");
    process.exit(1);
  }

  logErr(`query: "${query.slice(0, 100)}${query.length > 100 ? "…" : ""}"`);

  const apiKey = getEnv("AI_GATEWAY_API_KEY") ?? getEnv("VERCEL_OIDC_TOKEN");
  if (!apiKey) {
    logErr("Missing AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN for Google skill.");
    process.exit(1);
  }
  const model = getEnv("BO_LLM_MODEL") ?? "openai/gpt-4.1";
  const openai = new OpenAI({ apiKey, baseURL: "https://ai-gateway.vercel.sh/v1" });

  const functionsBlob = FUNCTION_DEFS.map(
    (f) => `${f.name}: ${f.description} Params: ${JSON.stringify(f.params)}`
  ).join("\n");

  const tz = getEnv("BO_DEFAULT_TZ") ?? getEnv("BO_TZ") ?? "America/New_York";
  const now = new Date();
  const todayStr = now.toLocaleDateString("en-CA", { timeZone: tz });
  const tomorrowStr = new Date(now.getTime() + 86400000).toLocaleDateString("en-CA", { timeZone: tz });
  const tzOffset = getTzOffsetForPrompt(now, tz);

  const systemChoose = `You are a strict function dispatcher. The user will ask something about their Gmail or Google Calendar. You must choose exactly ONE of these functions and return a single JSON object with keys "function" (string) and "params" (object). Use only the functions listed. Params must match the described types (e.g. calendarId can be "primary"). For Gmail search use standard query syntax: from:email, to:email, subject:foo, is:unread, after:YYYY/MM/DD, newer_than:Nd. For listEvents/search use relative times like today, tomorrow, week, or days=7.

For createEvent you MUST set "from" and "to" to RFC3339 format with timezone. The user's timezone is ${tz}. In that zone, today is ${todayStr}, tomorrow is ${tomorrowStr}. Use offset ${tzOffset} in RFC3339 (e.g. ${tomorrowStr}T09:30:00${tzOffset}). Default duration 30 minutes if user does not specify end (e.g. "9:30 am" → from 09:30, to 10:00 same day).

When the user asks to delete or cancel a meeting/event by name (e.g. "delete the do stuff meeting", "cancel my X event"), use deleteEventByQuery with query set to the meeting title/name. Use days of 180 (or at least 30) so the search finds the event; do not use a narrow window like 2 days.

When the user asks for the "last", "latest", "most recent", "newest", or "recent" email (or "last response" about a topic), ALWAYS add a recency term to the search query so the first result is the one they want: use newer_than:7d or newer_than:30d, or after:YYYY/MM/DD (e.g. after:2025/1/1). Example: for "find the last commercial insurance email" use query "commercial insurance newer_than:30d" (or "subject:commercial insurance newer_than:30d"). This ensures we get the most recent matching email, not an older one.

Available functions:
${functionsBlob}

Return only valid JSON: { "function": "functionName", "params": { ... } }.`;

  let rawChoice: string;
  try {
    const completion = await openai.chat.completions.create({
      model,
      messages: [
        { role: "system", content: systemChoose },
        { role: "user", content: query },
      ],
      temperature: 0.1,
      stream: false,
    });
    rawChoice = completion.choices[0]?.message?.content?.trim() ?? "";
  } catch (e) {
    logErr("AI choose failed:", e instanceof Error ? e.message : String(e));
    process.stdout.write("I couldn't figure out what to do with that. Try rephrasing?");
    process.exit(0);
  }

  const jsonMatch = rawChoice.match(/\{[\s\S]*\}/);
  const choiceStr = jsonMatch ? jsonMatch[0] : rawChoice;
  let choice: { function: string; params?: Record<string, unknown> };
  try {
    choice = JSON.parse(choiceStr) as { function: string; params?: Record<string, unknown> };
  } catch {
    logErr("Failed to parse AI choice (first 300 chars):", rawChoice.slice(0, 300));
    process.stdout.write("I got confused. Try asking in a different way?");
    process.exit(0);
  }

  const fnName = choice.function;
  const params = choice.params ?? {};
  const result = await dispatch(fnName, params);

  // For email search, sort threads by date descending so "last/most recent" means the first result.
  let dataForReply: unknown = result.ok ? result.data : undefined;
  if (
    result.ok &&
    fnName === "searchEmail" &&
    typeof dataForReply === "object" &&
    dataForReply !== null &&
    Array.isArray((dataForReply as { threads?: unknown[] }).threads)
  ) {
    const threads = (dataForReply as { threads: Array<{ date?: string }> }).threads;
    const sorted = [...threads].sort((a, b) => {
      const da = a.date ? new Date(a.date).getTime() : 0;
      const db = b.date ? new Date(b.date).getTime() : 0;
      return db - da; // newest first
    });
    dataForReply = { ...dataForReply, threads: sorted };
  }

  const resultSummary = result.ok
    ? (typeof dataForReply === "object" && dataForReply !== null
        ? JSON.stringify(dataForReply)
        : String(dataForReply))
    : `Error: ${result.error}`;

  if (!result.ok) {
    logErr(`${fnName} failed: ${result.error}`);
  }

  const systemReply = `You are Bo, an iMessage assistant. The user asked something about Gmail or Calendar. We ran the function "${fnName}" with params ${JSON.stringify(params)}. Result: ${resultSummary}. Write a short, friendly reply (iMessage length). Summarize or highlight what matters. If there was an error, say so in a friendly way AND include the actual error message so the user can fix it (e.g. "The error was: ..." or "Google said: ..."). Return only the reply text, no JSON and no markdown.`;

  try {
    const completion2 = await openai.chat.completions.create({
      model,
      messages: [
        { role: "system", content: systemReply },
        { role: "user", content: query },
      ],
      temperature: 0.3,
      stream: false,
    });
    const reply = completion2.choices[0]?.message?.content?.trim() ?? "Done.";
    process.stdout.write(reply);
  } catch (e) {
    logErr("AI reply failed:", e instanceof Error ? e.message : String(e));
    if (result.ok) {
      process.stdout.write("Done. Check your email or calendar.");
    } else {
      process.stdout.write(`Something went wrong: ${result.error}`);
    }
  }
}

main().catch((err) => {
  const reqTag = process.env.BO_REQUEST_ID ? ` [req:${process.env.BO_REQUEST_ID}]` : "";
  console.error(`[google skill]${reqTag} Uncaught:`, err?.message ?? String(err));
  if (err instanceof Error && err.stack) console.error(`[google skill]${reqTag} Stack:`, err.stack);
  process.exit(1);
});
