/**
 * Reminder skill: one-off and recurring reminders for self or others.
 * Create, list, update, delete. Creator and recipient can both modify.
 */

import {
  dbAddReminder,
  dbGetReminderById,
  dbGetRemindersForUser,
  dbUpdateReminder,
  dbDeleteReminder,
  dbCanUserModifyReminder,
  dbGetUserById,
  dbGetUserTimezone,
  dbResolveOwnerToUserId,
} from "../../src/db";
import { getNumberToName } from "../../src/contacts";
import { resolveContactToNumber } from "../../src/contacts";
import { normalizeOwner } from "../../src/memory";

/** Get display name for a user: contact name > full name > fallback. Avoids ?? || mixing that Bun dislikes. */
function getUserDisplayName(
  user: { phone_number: string; first_name: string | null; last_name: string | null } | null,
  numberToName: Map<string, string>,
  fallback = "—"
): string {
  if (!user) return fallback;
  const contactName = numberToName.get(user.phone_number);
  if (contactName) return contactName;
  const fullName = [user.first_name, user.last_name].filter(Boolean).join(" ");
  return fullName || fallback;
}

type Input = {
  action?: string;
  text?: string;
  fire_at_iso?: string;
  time?: string;
  at?: string;
  recurrence?: string;
  for_contact?: string;
  reminder_id?: number;
  new_text?: string;
  new_fire_at_iso?: string;
  new_recurrence?: string;
  filter?: "for_me" | "by_me";
};

/** Parse "7:30", "7:30 AM", "7:30am" to { hour, minute }. Returns null if not parseable. */
function parseTimeString(s: string): { hour: number; minute: number } | null {
  const t = (s ?? "").trim();
  const m = t.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!m) return null;
  let hour = parseInt(m[1]!, 10);
  const minute = m[2] ? parseInt(m[2], 10) : 0;
  const ampm = (m[3] ?? "").toLowerCase();
  if (ampm === "pm" && hour < 12) hour += 12;
  if (ampm === "am" && hour === 12) hour = 0;
  if (!ampm && hour < 12) hour += 12;
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

/** Next occurrence of hour:minute in tz (today or tomorrow). Returns UTC ISO. */
function nextOccurrenceUTC(hour: number, minute: number, tz: string): string {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
  const parts = formatter.formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "0";
  const y = parseInt(get("year"), 10);
  const mo = parseInt(get("month"), 10) - 1;
  const d = parseInt(get("day"), 10);
  const h = parseInt(get("hour"), 10);
  const min = parseInt(get("minute"), 10);
  let dayOffset = 0;
  if (h > hour || (h === hour && min >= minute)) dayOffset = 1;
  const localEpoch = Date.UTC(y, mo, d + dayOffset, hour, minute, 0, 0);
  const d0 = new Date(localEpoch);
  const localStr = d0.toLocaleString("en-CA", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false });
  const [lh, lm] = localStr.split(":").map(Number);
  const offsetMs = (lh * 60 + lm - (d0.getUTCHours() * 60 + d0.getUTCMinutes())) * 60 * 1000;
  const T = localEpoch - offsetMs;
  return new Date(T).toISOString();
}

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

function writeOutput(response: string): void {
  process.stdout.write(JSON.stringify({ response }));
}

function resolveRecipientUserId(forContact: string | undefined, requestorOwner: string): number {
  if (!forContact?.trim()) {
    const uid = dbResolveOwnerToUserId(requestorOwner);
    return uid ?? dbResolveOwnerToUserId("default")!;
  }
  const num = resolveContactToNumber(forContact.trim());
  if (!num) return dbResolveOwnerToUserId(requestorOwner)!;
  const uid = dbResolveOwnerToUserId(num);
  return uid ?? dbResolveOwnerToUserId(requestorOwner)!;
}

/** Format a UTC ISO string in the given IANA timezone for display (recipient's local time). */
function formatUtcInTz(utcIso: string | null, tz: string): string {
  if (!utcIso) return "—";
  const d = new Date(utcIso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-US", { timeZone: tz, month: "numeric", day: "numeric", year: "2-digit", hour: "numeric", minute: "2-digit", hour12: true });
}

function formatReminderForDisplay(
  r: { id: number; text: string; kind: string; fire_at_utc: string | null; next_fire_at_utc: string | null; recurrence: string | null; created_at: string; sent_at: string | null },
  creatorName: string,
  recipientName: string,
  recipientTz: string
): string {
  const when =
    r.kind === "one_off"
      ? r.fire_at_utc
        ? formatUtcInTz(r.fire_at_utc, recipientTz)
        : "—"
      : r.recurrence ?? (r.next_fire_at_utc ? `next ${formatUtcInTz(r.next_fire_at_utc, recipientTz)}` : "—");
  const forWho = creatorName !== recipientName ? ` for ${recipientName}` : "";
  return `#${r.id} ${r.text} | ${when}${forWho} (by ${creatorName})`;
}

async function main() {
  const input = (await readJsonStdin()) as Input;
  let action = (input?.action ?? "").toString().toLowerCase().trim();
  if (action === "set") action = "create";
  if (!action || !["create", "list", "update", "delete"].includes(action)) {
    process.stderr.write("reminder skill: action must be create, list, update, or delete\n");
    process.exit(1);
  }

  const fromRaw = process.env.BO_REQUEST_FROM ?? "";
  const requestorOwner = normalizeOwner(fromRaw);
  const creatorUserId = dbResolveOwnerToUserId(requestorOwner);
  if (creatorUserId == null) {
    writeOutput("I couldn't identify who you are.");
    process.exit(0);
  }

  const numberToName = getNumberToName();

  if (action === "list") {
    const filter = input.filter === "for_me" ? "for_me" : input.filter === "by_me" ? "by_me" : undefined;
    const reminders = dbGetRemindersForUser(creatorUserId, filter);
    if (reminders.length === 0) {
      writeOutput(filter === "by_me" ? "You have no reminders set for others." : filter === "for_me" ? "You have no reminders." : "You have no reminders (for you or by you).");
      process.exit(0);
    }
    const lines = reminders.map((r) => {
      const creator = dbGetUserById(r.creator_user_id);
      const recipient = dbGetUserById(r.recipient_user_id);
      const creatorName = getUserDisplayName(creator, numberToName);
      const recipientName = getUserDisplayName(recipient, numberToName);
      const recipientTz = dbGetUserTimezone(r.recipient_user_id);
      return formatReminderForDisplay(r, creatorName, recipientName, recipientTz);
    });
    writeOutput("Reminders:\n" + lines.join("\n"));
    process.exit(0);
  }

  if (action === "create") {
    const text = (input.text ?? "").trim();
    if (!text) {
      writeOutput("Reminder text is required.");
      process.exit(0);
    }
    const recipientUserId = resolveRecipientUserId(input.for_contact, requestorOwner);
    const tz = dbGetUserTimezone(recipientUserId);
    const fireAtIso = (input.fire_at_iso ?? "").trim();
    const timeStr = (input.time ?? input.at ?? "").trim();
    const recurrence = (input.recurrence ?? "").trim() || null;
    const kind = recurrence ? "recurring" : "one_off";
    let fireAtUtc: string | null = null;
    let nextFireAtUtc: string | null = null;
    if (fireAtIso) {
      const d = new Date(fireAtIso);
      if (!Number.isNaN(d.getTime())) {
        fireAtUtc = d.toISOString();
        if (kind === "recurring") nextFireAtUtc = fireAtUtc;
      }
    }
    if (!fireAtUtc && timeStr) {
      const parsed = parseTimeString(timeStr);
      if (parsed) {
        fireAtUtc = nextOccurrenceUTC(parsed.hour, parsed.minute, tz);
        if (kind === "recurring") nextFireAtUtc = fireAtUtc;
      }
    }
    if (kind === "one_off" && !fireAtUtc) {
      writeOutput("For a one-off reminder, provide a time (e.g. 7:30 or 7:30 AM) or fire_at_iso (UTC).");
      process.exit(0);
    }
    if (kind === "recurring" && !nextFireAtUtc) {
      writeOutput("For a recurring reminder, provide fire_at_iso for the first run and recurrence (e.g. daily 08:30).");
      process.exit(0);
    }
    const id = dbAddReminder(creatorUserId, recipientUserId, text, kind, fireAtUtc, recurrence, nextFireAtUtc);
    const recipient = dbGetUserById(recipientUserId);
    const recipientName = getUserDisplayName(recipient, numberToName, "you");
    const when = fireAtUtc ? formatUtcInTz(fireAtUtc, tz) : (recurrence || "—");
    writeOutput(`Reminder #${id} set for ${recipientName} at ${when}: "${text}".`);
    process.exit(0);
  }

  if (action === "update" || action === "delete") {
    const id = input.reminder_id;
    if (id == null || id < 1) {
      writeOutput("Specify reminder_id (e.g. #3) to update or delete.");
      process.exit(0);
    }
    const reminder = dbGetReminderById(id);
    if (!reminder) {
      writeOutput(`No reminder #${id} found.`);
      process.exit(0);
    }
    if (!dbCanUserModifyReminder(creatorUserId, reminder)) {
      writeOutput("You can only update or delete reminders you created or that are for you.");
      process.exit(0);
    }
    if (action === "delete") {
      dbDeleteReminder(id);
      writeOutput(`Reminder #${id} cancelled.`);
      process.exit(0);
    }
    const updates: Partial<{ text: string; fire_at_utc: string; recurrence: string; next_fire_at_utc: string }> = {};
    if (input.new_text?.trim()) updates.text = input.new_text.trim();
    if (input.new_fire_at_iso?.trim()) {
      const d = new Date(input.new_fire_at_iso.trim());
      if (!Number.isNaN(d.getTime())) {
        updates.fire_at_utc = d.toISOString();
        if (reminder.kind === "recurring") updates.next_fire_at_utc = d.toISOString();
      }
    }
    if (input.new_recurrence?.trim()) updates.recurrence = input.new_recurrence.trim();
    const ok = dbUpdateReminder(id, updates);
    writeOutput(ok ? `Reminder #${id} updated.` : "Nothing to update.");
    process.exit(0);
  }

  writeOutput("Unknown action.");
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(err?.message ?? String(err));
  process.exit(1);
});
