/**
 * Wrapper around the gog CLI for Gmail and Calendar.
 * All commands run with --json --no-input for scripting.
 * Uses BO_GOG_ACCOUNT or GOG_ACCOUNT if set; otherwise gog default.
 */

import { spawn } from "node:child_process";
import { EOL } from "node:os";

const GOG = "gog";
const JSON_FLAGS = ["--json", "--no-input"];

function getAccountArgs(): string[] {
  const account = process.env.BO_GOG_ACCOUNT ?? process.env.GOG_ACCOUNT;
  if (account) return ["--account", account];
  return [];
}

function runGog(args: string[], stdin?: string): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const fullArgs = [...args, ...JSON_FLAGS];
    const proc = spawn(GOG, fullArgs, {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (d) => (stdout += d.toString()));
    proc.stderr?.on("data", (d) => (stderr += d.toString()));
    proc.on("close", (code) => resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code: code ?? 0 }));
    if (stdin !== undefined) {
      proc.stdin?.end(stdin, "utf-8");
    } else {
      proc.stdin?.end();
    }
  });
}

function parseJson<T>(stdout: string): T | null {
  if (!stdout.trim()) return null;
  try {
    return JSON.parse(stdout) as T;
  } catch {
    return null;
  }
}

// --- Gmail ---

export type GmailSearchResult = {
  nextPageToken?: string;
  threads?: Array<{
    id: string;
    date?: string;
    from?: string;
    subject?: string;
    labels?: string[];
    messageCount?: number;
  }>;
};

export async function searchEmail(query: string, max = 10): Promise<GmailSearchResult | null> {
  const account = getAccountArgs();
  const { stdout, stderr, code } = await runGog([
    "gmail", "search", query,
    "--max", String(max),
    ...account,
  ]);
  if (code !== 0) throw new Error(stderr || stdout || `gog gmail search exited ${code}`);
  return parseJson<GmailSearchResult>(stdout);
}

export type GmailMessageResult = {
  id?: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  payload?: {
    headers?: Array<{ name: string; value: string }>;
    body?: { data?: string };
    parts?: Array<{ mimeType?: string; body?: { data?: string }; filename?: string }>;
  };
  internalDate?: string;
};

export async function getEmail(messageId: string, format: "full" | "metadata" = "full"): Promise<GmailMessageResult | null> {
  const account = getAccountArgs();
  const { stdout, stderr, code } = await runGog([
    "gmail", "get", messageId,
    "--format", format,
    ...account,
  ]);
  if (code !== 0) throw new Error(stderr || stdout || `gog gmail get exited ${code}`);
  return parseJson<GmailMessageResult>(stdout);
}

export type SendEmailParams = {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  bcc?: string;
  replyToMessageId?: string;
  threadId?: string;
};

export async function sendEmail(params: SendEmailParams): Promise<{ id?: string; threadId?: string; labelIds?: string[] } | null> {
  const account = getAccountArgs();
  const args = [
    "gmail", "send",
    "--to", params.to,
    "--subject", params.subject,
    "--body", params.body,
    "--force",
    ...account,
  ];
  if (params.cc) args.push("--cc", params.cc);
  if (params.bcc) args.push("--bcc", params.bcc);
  if (params.replyToMessageId) args.push("--reply-to-message-id", params.replyToMessageId);
  if (params.threadId) args.push("--thread-id", params.threadId);
  const { stdout, stderr, code } = await runGog(args);
  if (code !== 0) throw new Error(stderr || stdout || `gog gmail send exited ${code}`);
  return parseJson(stdout);
}

// --- Calendar ---

export type CalendarListResult = {
  calendars?: Array<{
    id: string;
    summary?: string;
    primary?: boolean;
    accessRole?: string;
  }>;
};

export async function listCalendars(): Promise<CalendarListResult | null> {
  const account = getAccountArgs();
  const { stdout, stderr, code } = await runGog(["calendar", "calendars", ...account]);
  if (code !== 0) throw new Error(stderr || stdout || `gog calendar calendars exited ${code}`);
  return parseJson<CalendarListResult>(stdout);
}

export type CalendarEventsParams = {
  calendarId?: string;
  from?: string;
  to?: string;
  today?: boolean;
  tomorrow?: boolean;
  week?: boolean;
  days?: number;
  max?: number;
  query?: string;
  all?: boolean;
};

export type CalendarEventsResult = {
  events?: Array<{
    id: string;
    summary?: string;
    description?: string;
    location?: string;
    start?: { dateTime?: string; date?: string; timeZone?: string };
    end?: { dateTime?: string; date?: string; timeZone?: string };
    attendees?: Array<{ email: string; displayName?: string; responseStatus?: string }>;
    status?: string;
    htmlLink?: string;
    organizer?: { email?: string; displayName?: string };
  }>;
  nextPageToken?: string;
};

export async function listEvents(params: CalendarEventsParams = {}): Promise<CalendarEventsResult | null> {
  const account = getAccountArgs();
  const args: string[] = ["calendar", "events"];
  if (params.calendarId) args.push(params.calendarId);
  if (params.from) args.push("--from", params.from);
  if (params.to) args.push("--to", params.to);
  if (params.today) args.push("--today");
  if (params.tomorrow) args.push("--tomorrow");
  if (params.week) args.push("--week");
  if (params.days != null) args.push("--days", String(params.days));
  if (params.max != null) args.push("--max", String(params.max));
  if (params.query) args.push("--query", params.query);
  if (params.all) args.push("--all");
  args.push(...account);
  const { stdout, stderr, code } = await runGog(args);
  if (code !== 0) throw new Error(stderr || stdout || `gog calendar events exited ${code}`);
  return parseJson<CalendarEventsResult>(stdout);
}

export async function searchCalendarEvents(
  query: string,
  opts: { from?: string; to?: string; days?: number; max?: number; calendarId?: string } = {}
): Promise<CalendarEventsResult | null> {
  const account = getAccountArgs();
  const args = [
    "calendar", "search", query,
    ...(opts.from ? ["--from", opts.from] : []),
    ...(opts.to ? ["--to", opts.to] : []),
    ...(opts.days != null ? ["--days", String(opts.days)] : []),
    ...(opts.max != null ? ["--max", String(opts.max)] : []),
    ...(opts.calendarId ? ["--calendar", opts.calendarId] : []),
    ...account,
  ];
  const { stdout, stderr, code } = await runGog(args);
  if (code !== 0) throw new Error(stderr || stdout || `gog calendar search exited ${code}`);
  return parseJson<CalendarEventsResult>(stdout);
}

export async function getCalendarEvent(calendarId: string, eventId: string): Promise<Record<string, unknown> | null> {
  const account = getAccountArgs();
  const { stdout, stderr, code } = await runGog([
    "calendar", "event", calendarId, eventId,
    ...account,
  ]);
  if (code !== 0) throw new Error(stderr || stdout || `gog calendar event get exited ${code}`);
  return parseJson(stdout);
}

export type CreateEventParams = {
  calendarId: string;
  summary: string;
  from: string;
  to: string;
  description?: string;
  location?: string;
  attendees?: string[];
  allDay?: boolean;
  withMeet?: boolean;
};

export async function createEvent(params: CreateEventParams): Promise<Record<string, unknown> | null> {
  const account = getAccountArgs();
  const args = [
    "calendar", "create", params.calendarId,
    "--summary", params.summary,
    "--from", params.from,
    "--to", params.to,
    "--force",
    ...account,
  ];
  if (params.description) args.push("--description", params.description);
  if (params.location) args.push("--location", params.location);
  if (params.attendees?.length) args.push("--attendees", params.attendees.join(","));
  if (params.allDay) args.push("--all-day");
  if (params.withMeet) args.push("--with-meet");
  const { stdout, stderr, code } = await runGog(args);
  if (code !== 0) throw new Error(stderr || stdout || `gog calendar create exited ${code}`);
  return parseJson(stdout);
}

export type UpdateEventParams = {
  calendarId: string;
  eventId: string;
  summary?: string;
  from?: string;
  to?: string;
  description?: string;
  location?: string;
};

export async function updateEvent(params: UpdateEventParams): Promise<Record<string, unknown> | null> {
  const account = getAccountArgs();
  const args = [
    "calendar", "update", params.calendarId, params.eventId,
    "--force",
    ...account,
  ];
  if (params.summary != null) args.push("--summary", params.summary);
  if (params.from != null) args.push("--from", params.from);
  if (params.to != null) args.push("--to", params.to);
  if (params.description != null) args.push("--description", params.description);
  if (params.location != null) args.push("--location", params.location);
  const { stdout, stderr, code } = await runGog(args);
  if (code !== 0) throw new Error(stderr || stdout || `gog calendar update exited ${code}`);
  return parseJson(stdout);
}

export async function deleteEvent(calendarId: string, eventId: string, scope: "all" | "single" | "future" = "all"): Promise<void> {
  const account = getAccountArgs();
  const { stderr, code } = await runGog([
    "calendar", "delete", calendarId, eventId,
    "--scope", scope,
    "--force",
    ...account,
  ]);
  if (code !== 0) throw new Error(stderr || `gog calendar delete exited ${code}`);
}

export type FreeBusyResult = {
  calendars?: Record<string, { busy?: Array<{ start?: string; end?: string }> }>;
};

export async function freeBusy(calendarIds: string[], from: string, to: string): Promise<FreeBusyResult | null> {
  const account = getAccountArgs();
  const { stdout, stderr, code } = await runGog([
    "calendar", "freebusy", calendarIds.join(","),
    "--from", from,
    "--to", to,
    ...account,
  ]);
  if (code !== 0) throw new Error(stderr || stdout || `gog calendar freebusy exited ${code}`);
  return parseJson<FreeBusyResult>(stdout);
}
