import { dbGetContactsList, dbGetContactsNameToNumber, dbGetContactsNumberToName } from "./db";

/** Load contacts from DB (migrated from config/contacts.json). Returns number → name for display (proper casing). */
export function getNumberToName(): Map<string, string> {
  return dbGetContactsNumberToName();
}

/** List of contacts with display names in proper casing (e.g. "Cara Hogue") for prompts and UI. */
export function getContactsList(): Array<{ name: string; number: string }> {
  return dbGetContactsList();
}

/** Load contacts from DB (migrated from config/contacts.json). Returns name (lowercase) → canonical 10-digit number for send_to_contact. */
export function getNameToNumber(): Map<string, string> {
  return dbGetContactsNameToNumber();
}

/** Resolve a contact name (e.g. "Cara" or "Cara Hogue") to canonical 10-digit number. Case-insensitive. Tries exact full-name match, then first-name match (contact's first name must equal input first word exactly—so "Cara" matches "Cara Hogue" but not "Carrie"). */
export function resolveContactToNumber(contactName: string): string | undefined {
  const nameToNumber = dbGetContactsNameToNumber();
  const trimmed = contactName.trim();
  if (!trimmed) return undefined;
  const exact = nameToNumber.get(trimmed.toLowerCase());
  if (exact) return exact;
  const firstWord = trimmed.split(/\s+/)[0]?.toLowerCase();
  if (!firstWord) return undefined;
  for (const [name, num] of nameToNumber) {
    const contactFirstName = name.split(/\s+/)[0];
    if (contactFirstName === firstWord) return num;
  }
  return undefined;
}
